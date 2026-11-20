import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../mirror/db.js";
import { acquireLock } from "../mirror/sync.js";
import { PayPalApiError, type PayPalClient, PayPalRateLimited } from "./client.js";
import { openPayPalDb } from "./db.js";

const DAY = 86400_000;
/** PayPal's maximum range per transactions query. */
const WINDOW_MS = 31 * DAY - 1000;
const PAGE_SIZE = 500;
/** Pending items (e.g. eChecks) can take over a week to clear; the refetch is one 31-day window either way. */
const DEFAULT_OVERLAP_DAYS = 14;
const DEFAULT_MAX_REQUESTS = 1500;
const MAX_PAGES = 200;

class Budget extends Error {}

interface Money {
  currency_code?: string;
  value?: string;
}

export interface PayPalTransactionDetail {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    paypal_reference_id_type?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: Money;
    fee_amount?: Money;
    ending_balance?: Money;
    transaction_status?: string;
    transaction_subject?: string;
    transaction_note?: string;
    invoice_id?: string;
    custom_field?: string;
    bank_reference_id?: string;
    payment_method_type?: string;
    instrument_type?: string;
    [k: string]: unknown;
  };
  payer_info?: {
    account_id?: string;
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
    [k: string]: unknown;
  };
  shipping_info?: { name?: string; [k: string]: unknown };
  cart_info?: {
    item_details?: { item_name?: string; item_description?: string; [k: string]: unknown }[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Number of decimal places for a currency (GBP 2, JPY 0, ...). */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "-12.34" GBP → -1234, parsed exactly (no floating point). */
export function toMinor(money: Money | undefined): number | null {
  if (!money?.value || !money.currency_code) return null;
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(money.value);
  if (!m) return null;
  const exp = currencyExponent(money.currency_code);
  const frac = (m[3] ?? "").padEnd(exp, "0").slice(0, exp);
  const n = Number(`${m[2] || "0"}${frac}`);
  return m[1] === "-" ? -n : n;
}

/** PayPal dates look like 2026-11-01T10:00:00+0000; store them as ISO UTC. */
export function normaliseDate(value: string | undefined): string | null {
  if (!value) return null;
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(fixed);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** PayPal wants seconds and an explicit offset; it rejects fractional-second Z forms in some regions. */
function ppDate(iso: string): string {
  return `${iso.slice(0, 19)}Z`;
}

export function payerName(d: PayPalTransactionDetail): string | null {
  const n = d.payer_info?.payer_name;
  if (!n) return null;
  return n.alternate_full_name || [n.given_name, n.surname].filter(Boolean).join(" ") || null;
}

export function upsertTransactions(
  db: DatabaseSync,
  details: PayPalTransactionDetail[],
  now: string,
): { inserted: number; updated: number } {
  const select = db.prepare("SELECT raw_json FROM transactions WHERE transaction_id = ?");
  const cols = [
    "transaction_id",
    "paypal_reference_id",
    "paypal_reference_id_type",
    "event_code",
    "status",
    "initiation_date",
    "updated_date",
    "currency",
    "gross_minor",
    "fee_minor",
    "net_minor",
    "gross_value",
    "fee_value",
    "ending_balance_value",
    "subject",
    "note",
    "invoice_id",
    "custom_field",
    "payer_account_id",
    "payer_name",
    "payer_email",
    "shipping_name",
    "bank_reference_id",
    "payment_method_type",
    "instrument_type",
    "item_names",
    "item_details_json",
    "raw_json",
    "first_seen",
    "last_updated",
  ];
  const updatable = cols.filter((c) => c !== "transaction_id" && c !== "first_seen");
  const upsert = db.prepare(
    `INSERT INTO transactions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT (transaction_id) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}
     WHERE transactions.raw_json IS NOT excluded.raw_json`,
  );
  let inserted = 0;
  let updated = 0;
  for (const d of details) {
    const t = d.transaction_info;
    if (!t?.transaction_id) continue;
    const raw = JSON.stringify(d);
    const existing = select.get(t.transaction_id) as { raw_json: string } | undefined;
    if (existing && existing.raw_json === raw) continue;
    const gross = toMinor(t.transaction_amount);
    const fee = toMinor(t.fee_amount);
    const items = d.cart_info?.item_details ?? [];
    const s = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
    upsert.run(
      t.transaction_id,
      s(t.paypal_reference_id),
      s(t.paypal_reference_id_type),
      s(t.transaction_event_code),
      s(t.transaction_status),
      normaliseDate(t.transaction_initiation_date),
      normaliseDate(t.transaction_updated_date),
      s(t.transaction_amount?.currency_code),
      gross,
      fee,
      gross === null ? null : gross + (fee ?? 0),
      s(t.transaction_amount?.value),
      s(t.fee_amount?.value),
      s(t.ending_balance?.value),
      s(t.transaction_subject),
      s(t.transaction_note),
      s(t.invoice_id),
      s(t.custom_field),
      s(d.payer_info?.account_id),
      payerName(d),
      s(d.payer_info?.email_address),
      s(d.shipping_info?.name),
      s(t.bank_reference_id),
      s(t.payment_method_type),
      s(t.instrument_type),
      items.length
        ? items
            .map((i) => i.item_name ?? i.item_description)
            .filter(Boolean)
            .join(" | ")
        : null,
      items.length ? JSON.stringify(items) : null,
      raw,
      now,
      now,
    );
    if (existing) updated++;
    else inserted++;
  }
  return { inserted, updated };
}

export interface PayPalSyncOptions {
  profile: string;
  full?: boolean;
  maxRequests?: number;
  overlapDays?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PayPalSyncSummary {
  profile: string;
  outcome: "complete" | "incomplete";
  message?: string;
  newItems: number;
  updatedItems: number;
  totalItems: number;
  earliest?: string;
  latest?: string;
  apiCalls: number;
  backfillComplete: boolean;
  dataRefreshedAt?: string;
}

export async function syncPayPal(client: PayPalClient, dbPath: string, opts: PayPalSyncOptions) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const release = acquireLock(dbPath);
  const db = openPayPalDb(dbPath);
  try {
    return await runPayPalSync(client, db, opts);
  } finally {
    db.close();
    release();
  }
}

export async function runPayPalSync(
  client: PayPalClient,
  db: DatabaseSync,
  opts: PayPalSyncOptions,
): Promise<PayPalSyncSummary> {
  const now = opts.now ?? (() => new Date());
  const runStart = now().toISOString();
  const startCalls = client.requests;
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const used = () => client.requests - startCalls;
  const runId = Number(
    db.prepare("INSERT INTO sync_runs (started_at, outcome) VALUES (?, 'running')").run(runStart).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(opts.profile);
  // PayPal serves the previous three years; stay a day inside that.
  const floorDate = new Date(runStart);
  floorDate.setUTCFullYear(floorDate.getUTCFullYear() - 3);
  const floor = new Date(floorDate.getTime() + DAY).toISOString();

  let newItems = 0;
  let updatedItems = 0;
  let outcome: PayPalSyncSummary["outcome"] = "complete";
  let message: string | undefined;
  let refreshed: string | undefined;

  const call = async <T>(path: string, query: Record<string, string | number>) => {
    if (used() >= maxRequests) throw new Budget(`reached --max-requests ${maxRequests} for this run`);
    return client.get<T>(path, query);
  };

  /** Every page of one ≤31-day window. */
  const fetchWindow = async (from: string, to: string) => {
    const all: PayPalTransactionDetail[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await call<{
        transaction_details?: PayPalTransactionDetail[];
        total_pages?: number;
        last_refreshed_datetime?: string;
      }>("/v1/reporting/transactions", {
        start_date: ppDate(from),
        end_date: ppDate(to),
        fields: "all",
        page_size: PAGE_SIZE,
        page,
      });
      all.push(...(res.transaction_details ?? []));
      const r = normaliseDate(res.last_refreshed_datetime);
      if (r && (!refreshed || r < refreshed)) refreshed = r;
      if (!res.total_pages || page >= res.total_pages) break;
    }
    return all;
  };

  const store = (details: PayPalTransactionDetail[], stateUpdate: () => void) => {
    const r = transaction(db, () => {
      const res = upsertTransactions(db, details, runStart);
      stateUpdate();
      return res;
    });
    newItems += r.inserted;
    updatedItems += r.updated;
  };

  try {
    // Balances: one call, skipped if the app lacks the balances scope.
    try {
      const b = await call<{
        as_of_time?: string;
        balances?: {
          currency?: string;
          primary?: boolean;
          total_balance?: Money;
          available_balance?: Money;
          withheld_balance?: Money;
        }[];
      }>("/v1/reporting/balances", {});
      const asOf = normaliseDate(b.as_of_time) ?? runStart;
      const ins = db.prepare(
        `INSERT OR REPLACE INTO balances (as_of_time, currency, is_primary, total_minor, available_minor, withheld_minor, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      transaction(db, () => {
        for (const x of b.balances ?? []) {
          ins.run(
            asOf,
            x.currency ?? x.total_balance?.currency_code ?? "?",
            x.primary ? 1 : 0,
            toMinor(x.total_balance),
            toMinor(x.available_balance),
            toMinor(x.withheld_balance),
            JSON.stringify(x),
          );
        }
      });
    } catch (err) {
      if (!(err instanceof PayPalApiError && [400, 403, 404].includes(err.status))) throw err;
    }

    let state = db.prepare("SELECT * FROM sync_state WHERE id = 1").get() as
      | { covered_from: string | null; backfill_complete: number; cursor: string | null }
      | undefined;
    if (!state || opts.full) {
      db.prepare(
        `INSERT INTO sync_state (id, backfill_floor, covered_from, backfill_complete, cursor) VALUES (1, ?, NULL, 0, ?)
         ON CONFLICT(id) DO UPDATE SET backfill_floor = excluded.backfill_floor, covered_from = NULL, backfill_complete = 0,
           cursor = COALESCE(sync_state.cursor, excluded.cursor)`,
      ).run(floor, runStart);
      state = db.prepare("SELECT * FROM sync_state WHERE id = 1").get() as typeof state;
    }

    // Incremental: refetch from the last cursor minus an overlap, because statuses change and data lags ~3 hours.
    if (state!.cursor && state!.cursor < runStart) {
      let from = new Date(Date.parse(state!.cursor) - (opts.overlapDays ?? DEFAULT_OVERLAP_DAYS) * DAY).toISOString();
      if (from < floor) from = floor;
      while (from < runStart) {
        const to = new Date(Math.min(Date.parse(runStart), Date.parse(from) + WINDOW_MS)).toISOString();
        const details = await fetchWindow(from, to);
        store(details, () => {});
        opts.log?.(`  incremental ${from.slice(0, 10)}..${to.slice(0, 10)}: ${details.length}`);
        from = to;
      }
      db.prepare("UPDATE sync_state SET cursor = ?, last_refreshed = ?, last_success = ? WHERE id = 1").run(
        refreshed && refreshed < runStart ? refreshed : runStart,
        refreshed ?? null,
        runStart,
      );
    }

    // Backfill, newest window first, down to three years ago.
    if (!state!.backfill_complete) {
      let end = state!.covered_from ?? runStart;
      while (end > floor) {
        const start = new Date(Math.max(Date.parse(floor), Date.parse(end) - WINDOW_MS)).toISOString();
        const details = await fetchWindow(start, end);
        store(details, () =>
          db.prepare("UPDATE sync_state SET covered_from = ?, last_success = ? WHERE id = 1").run(start, runStart),
        );
        opts.log?.(`  backfill ${start.slice(0, 10)}..${end.slice(0, 10)}: ${details.length}`);
        end = start;
      }
      db.prepare(
        "UPDATE sync_state SET backfill_complete = 1, last_refreshed = COALESCE(?, last_refreshed) WHERE id = 1",
      ).run(refreshed ?? null);
    }
  } catch (err) {
    if (err instanceof Budget || err instanceof PayPalRateLimited) {
      outcome = "incomplete";
      message = `Stopped: ${err.message}. Progress is saved; run paypal sync again to resume.`;
    } else {
      db.prepare(
        "UPDATE sync_runs SET finished_at = ?, outcome = 'error', api_calls = ?, message = ? WHERE id = ?",
      ).run(now().toISOString(), used(), err instanceof Error ? err.message : String(err), runId);
      throw err;
    }
  }

  const counts = db
    .prepare("SELECT COUNT(*) AS n, MIN(initiation_date) AS a, MAX(initiation_date) AS b FROM transactions")
    .get() as { n: number; a: string | null; b: string | null };
  const st = db.prepare("SELECT backfill_complete, last_refreshed FROM sync_state WHERE id = 1").get() as
    | { backfill_complete: number; last_refreshed: string | null }
    | undefined;
  db.prepare(
    "UPDATE sync_runs SET finished_at = ?, outcome = ?, new_items = ?, updated_items = ?, api_calls = ?, message = ? WHERE id = ?",
  ).run(now().toISOString(), outcome, newItems, updatedItems, used(), message ?? null, runId);
  return {
    profile: opts.profile,
    outcome,
    message,
    newItems,
    updatedItems,
    totalItems: Number(counts.n),
    earliest: counts.a ?? undefined,
    latest: counts.b ?? undefined,
    apiCalls: used(),
    backfillComplete: st?.backfill_complete === 1,
    dataRefreshedAt: st?.last_refreshed ?? undefined,
  };
}
