import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StarlingApiError, type StarlingClient } from "../client.js";
import type { FeedItem } from "../feed.js";
import { openMirror, transaction } from "./db.js";

const DAY = 86400_000;
/** Starling's single-call feed endpoint accepts at most a year. */
const MAX_WINDOW_ITEMS = 1000;
const DEFAULT_MAX_REQUESTS = 600;
/** Never let the mirror use more than this many calls per UTC day, so the assistant keeps some of the 1,000. */
export const DEFAULT_DAILY_LIMIT = 900;
const DEFAULT_OVERLAP_DAYS = 7;
/** Used when an account has no createdAt: Starling opened to customers in 2014. */
const EARLIEST = "2014-01-01T00:00:00.000Z";

export class BudgetExhausted extends Error {}

export interface SyncOptions {
  profile: string;
  full?: boolean;
  dryRun?: boolean;
  /** Most API calls this run may make (default 600). */
  maxRequests?: number;
  /** Most calls the mirror may make per UTC day, across runs (default 900). */
  dailyLimit?: number;
  overlapDays?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface SyncSummary {
  profile: string;
  outcome: "complete" | "incomplete" | "dry-run";
  message?: string;
  newItems: number;
  updatedItems: number;
  totalItems: number;
  earliest?: string;
  latest?: string;
  categories: number;
  backfillPending: number;
  apiCalls: number;
  callsUsedToday: number;
  plannedCalls?: number;
}

interface Account {
  accountUid: string;
  accountType: string;
  defaultCategory: string;
  currency: string;
  name?: string;
  createdAt?: string;
}

interface Category {
  categoryUid: string;
  accountUid: string;
  kind: "MAIN" | "SAVINGS_GOAL" | "SPENDING_SPACE";
  name?: string;
  floor: string;
}

function yearBefore(ts: string): string {
  const d = new Date(ts);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  // Starling's limit is inclusive of a full year; stay a minute inside it.
  return new Date(d.getTime() + 60_000).toISOString();
}

function iso(d: Date): string {
  return d.toISOString();
}

/** Counts API calls against the per-run and per-day budgets, persisting the daily total. */
class Budget {
  private readonly startCount: number;
  private seen: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly client: StarlingClient,
    private readonly maxRequests: number,
    private readonly dailyLimit: number,
    private readonly today: string,
  ) {
    this.startCount = client.requestsToday;
    this.seen = client.requestsToday;
  }

  get usedThisRun(): number {
    return this.client.requestsToday - this.startCount;
  }

  usedToday(): number {
    const row = this.db.prepare("SELECT requests FROM api_usage WHERE day = ?").get(this.today) as
      | { requests: number }
      | undefined;
    return row?.requests ?? 0;
  }

  /** Throws BudgetExhausted before a call that would go over either budget. */
  check(): void {
    if (this.usedThisRun >= this.maxRequests) {
      throw new BudgetExhausted(`reached --max-requests ${this.maxRequests} for this run`);
    }
    if (this.usedToday() >= this.dailyLimit) {
      throw new BudgetExhausted(`reached the mirror's daily limit of ${this.dailyLimit} calls for ${this.today} (UTC)`);
    }
  }

  /** Records calls made since the last record (including retries the client made). */
  record(): void {
    const now = this.client.requestsToday;
    const delta = now - this.seen;
    this.seen = now;
    if (delta <= 0) return;
    this.db
      .prepare(
        "INSERT INTO api_usage (day, requests) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests",
      )
      .run(this.today, delta);
  }
}

/** Upserts feed items idempotently; only rows whose JSON changed are rewritten. */
export function upsertFeedItems(
  db: DatabaseSync,
  accountUid: string,
  categoryUid: string,
  items: FeedItem[],
  now: string,
): { inserted: number; updated: number } {
  const select = db.prepare("SELECT raw_json FROM feed_items WHERE category_uid = ? AND feed_item_uid = ?");
  const columns = [
    "feed_item_uid",
    "account_uid",
    "category_uid",
    "direction",
    "status",
    "amount_minor",
    "currency",
    "source_amount_minor",
    "source_currency",
    "transaction_time",
    "settlement_time",
    "updated_at",
    "source",
    "source_sub_type",
    "counter_party_type",
    "counter_party_uid",
    "counter_party_name",
    "counter_party_sub_entity_name",
    "reference",
    "country",
    "spending_category",
    "user_note",
    "has_attachment",
    "has_receipt",
    "raw_json",
    "first_seen",
    "last_updated",
  ];
  const updatable = columns.filter((c) => !["feed_item_uid", "category_uid", "first_seen"].includes(c));
  const upsert = db.prepare(
    `INSERT INTO feed_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
     ON CONFLICT (category_uid, feed_item_uid) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}
     WHERE feed_items.raw_json IS NOT excluded.raw_json`,
  );
  let inserted = 0;
  let updated = 0;
  for (const i of items) {
    const raw = JSON.stringify(i);
    const existing = select.get(categoryUid, i.feedItemUid) as { raw_json: string } | undefined;
    if (existing && existing.raw_json === raw) continue;
    const bool = (v: unknown) => (v === undefined || v === null ? null : v ? 1 : 0);
    const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
    upsert.run(
      i.feedItemUid,
      accountUid,
      categoryUid,
      str(i.direction),
      str(i.status),
      i.amount?.minorUnits ?? null,
      str(i.amount?.currency),
      i.sourceAmount?.minorUnits ?? null,
      str(i.sourceAmount?.currency),
      str(i.transactionTime),
      str(i.settlementTime),
      str(i.updatedAt),
      str(i.source),
      str(i.sourceSubType),
      str(i.counterPartyType),
      str(i.counterPartyUid),
      str(i.counterPartyName),
      str(i.counterPartySubEntityName),
      str(i.reference),
      str(i.country),
      str(i.spendingCategory),
      str(i.userNote),
      bool(i.hasAttachment),
      bool(i.hasReceipt),
      raw,
      now,
      now,
    );
    if (existing) updated++;
    else inserted++;
  }
  return { inserted, updated };
}

/** A lock file next to the DB, so a scheduled and a manual sync of one profile never run at once. */
function acquireLock(dbPath: string): () => void {
  const lock = `${dbPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`Another sync (pid ${pid}) is running for this mirror (${lock}).`);
      unlinkSync(lock);
    }
  }
  throw new Error(`Could not lock ${lock}`);
}

export async function sync(client: StarlingClient, dbPath: string, opts: SyncOptions): Promise<SyncSummary> {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const release = acquireLock(dbPath);
  const db = openMirror(dbPath);
  try {
    return await runSync(client, db, opts);
  } finally {
    db.close();
    release();
  }
}

export async function runSync(client: StarlingClient, db: DatabaseSync, opts: SyncOptions): Promise<SyncSummary> {
  const nowFn = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const runStart = iso(nowFn());
  const budget = new Budget(
    db,
    client,
    opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    opts.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    runStart.slice(0, 10),
  );
  const overlapMs = (opts.overlapDays ?? DEFAULT_OVERLAP_DAYS) * DAY;
  const runId = Number(
    db.prepare("INSERT INTO sync_runs (started_at, outcome) VALUES (?, 'running')").run(runStart).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(opts.profile);

  let newItems = 0;
  let updatedItems = 0;
  let outcome: SyncSummary["outcome"] = "complete";
  let message: string | undefined;
  let planned = 0;

  /** One API call: checked against the budget first, recorded after. */
  const get = async <T>(path: string, params?: Record<string, string>, query?: Record<string, string>) => {
    budget.check();
    try {
      return await client.json<T>({ method: "GET", path, params, query });
    } catch (err) {
      if (err instanceof StarlingApiError && err.status === 429) {
        throw new BudgetExhausted("Starling returned 429 (rate or daily limit reached)");
      }
      throw err;
    } finally {
      budget.record();
    }
  };
  /** Like get, but a missing scope (403) or absent resource (404) just means "skip". */
  const optional = async <T>(path: string, params?: Record<string, string>) => {
    try {
      return await get<T>(path, params);
    } catch (err) {
      if (err instanceof StarlingApiError && (err.status === 403 || err.status === 404)) return undefined;
      throw err;
    }
  };

  try {
    // 1. Consent: after it lapses Starling serves only 90 days, which must not be recorded as full history.
    const identity = await get<{ consentExpiresAt?: string; accountHolderUid?: string }>("/api/v2/identity/token");
    const consentLapsed = identity?.consentExpiresAt ? Date.parse(identity.consentExpiresAt) < Date.now() : false;

    // 2. Account holder, accounts, spaces, balances, standing orders, payees, mandates.
    const holder = await optional<{ accountHolderUid?: string; accountHolderType?: string }>("/api/v2/account-holder");
    const holderName = await optional<{ accountHolderName?: string }>("/api/v2/account-holder/name");
    const accounts = (await get<{ accounts?: Account[] }>("/api/v2/accounts"))?.accounts ?? [];

    const categories: Category[] = [];
    const snapshots: { account: Account; balance: Record<string, unknown> | undefined }[] = [];
    const orders: { account: Account; list: Record<string, unknown>[] }[] = [];
    const spaceLists: { account: Account; goals: Record<string, unknown>[]; spaces: Record<string, unknown>[] }[] = [];
    for (const account of accounts) {
      const floor = account.createdAt ? iso(new Date(account.createdAt)) : EARLIEST;
      categories.push({
        categoryUid: account.defaultCategory,
        accountUid: account.accountUid,
        kind: "MAIN",
        name: account.name,
        floor,
      });
      const spaces = await optional<{
        savingsGoals?: Record<string, unknown>[];
        spendingSpaces?: Record<string, unknown>[];
      }>("/api/v2/account/{accountUid}/spaces", { accountUid: account.accountUid });
      const goals = spaces?.savingsGoals ?? [];
      const spending = spaces?.spendingSpaces ?? [];
      spaceLists.push({ account, goals, spaces: spending });
      for (const g of goals) {
        categories.push({
          categoryUid: String(g.savingsGoalUid),
          accountUid: account.accountUid,
          kind: "SAVINGS_GOAL",
          name: g.name as string | undefined,
          floor,
        });
      }
      for (const s of spending) {
        categories.push({
          categoryUid: String(s.spaceUid),
          accountUid: account.accountUid,
          kind: "SPENDING_SPACE",
          name: s.name as string | undefined,
          floor,
        });
      }
      if (!opts.dryRun) {
        snapshots.push({
          account,
          balance: await optional<Record<string, unknown>>("/api/v2/accounts/{accountUid}/balance", {
            accountUid: account.accountUid,
          }),
        });
        const so = await optional<{ standingOrders?: Record<string, unknown>[] }>(
          "/api/v2/payments/local/account/{accountUid}/category/{categoryUid}/standing-orders",
          { accountUid: account.accountUid, categoryUid: account.defaultCategory },
        );
        orders.push({ account, list: so?.standingOrders ?? [] });
      }
    }
    const payees = opts.dryRun ? undefined : await optional<{ payees?: Record<string, unknown>[] }>("/api/v2/payees");
    const mandates = opts.dryRun
      ? undefined
      : await optional<{ mandates?: Record<string, unknown>[] }>("/api/v2/direct-debit/mandates");

    if (!opts.dryRun) {
      transaction(db, () => {
        if (holder?.accountHolderUid) {
          db.prepare(
            `INSERT INTO account_holder (account_holder_uid, account_holder_type, name, raw_json, last_updated) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(account_holder_uid) DO UPDATE SET account_holder_type = excluded.account_holder_type,
               name = excluded.name, raw_json = excluded.raw_json, last_updated = excluded.last_updated`,
          ).run(
            holder.accountHolderUid,
            holder.accountHolderType ?? null,
            holderName?.accountHolderName ?? null,
            JSON.stringify(holder),
            runStart,
          );
        }
        const upAccount = db.prepare(
          `INSERT INTO accounts (account_uid, account_type, default_category, currency, name, created_at, raw_json, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_uid) DO UPDATE SET account_type = excluded.account_type,
             default_category = excluded.default_category, currency = excluded.currency, name = excluded.name,
             created_at = excluded.created_at, raw_json = excluded.raw_json, last_updated = excluded.last_updated`,
        );
        for (const a of accounts) {
          upAccount.run(
            a.accountUid,
            a.accountType,
            a.defaultCategory,
            a.currency,
            a.name ?? null,
            a.createdAt ?? null,
            JSON.stringify(a),
            runStart,
          );
        }
        const upCategory = db.prepare(
          `INSERT INTO categories (category_uid, account_uid, kind, name, state, raw_json, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(category_uid) DO UPDATE SET name = excluded.name, state = excluded.state,
             raw_json = COALESCE(excluded.raw_json, categories.raw_json), last_seen = excluded.last_seen`,
        );
        for (const c of categories) {
          const raw = spaceLists
            .flatMap((s) => [...s.goals, ...s.spaces])
            .find((x) => x.savingsGoalUid === c.categoryUid || x.spaceUid === c.categoryUid);
          upCategory.run(
            c.categoryUid,
            c.accountUid,
            c.kind,
            c.name ?? null,
            (raw?.state as string | undefined) ?? null,
            raw ? JSON.stringify(raw) : null,
            runStart,
          );
        }
        const snap = db.prepare(
          `INSERT OR IGNORE INTO balance_snapshots (account_uid, taken_at, currency, cleared_minor, effective_minor, total_effective_minor, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const { account, balance } of snapshots) {
          if (!balance) continue;
          const m = (k: string) => (balance[k] as { minorUnits?: number } | undefined)?.minorUnits ?? null;
          snap.run(
            account.accountUid,
            runStart,
            account.currency,
            m("clearedBalance"),
            m("effectiveBalance"),
            m("totalEffectiveBalance"),
            JSON.stringify(balance),
          );
        }
        const upOrder = db.prepare(
          `INSERT INTO standing_orders (payment_order_uid, account_uid, category_uid, payee_name, amount_minor, currency, reference, next_date, raw_json, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(payment_order_uid) DO UPDATE SET payee_name = excluded.payee_name,
             amount_minor = excluded.amount_minor, currency = excluded.currency, reference = excluded.reference,
             next_date = excluded.next_date, raw_json = excluded.raw_json, last_updated = excluded.last_updated`,
        );
        for (const { account, list } of orders) {
          for (const o of list) {
            const amount = o.amount as { minorUnits?: number; currency?: string } | undefined;
            upOrder.run(
              String(o.paymentOrderUid),
              account.accountUid,
              account.defaultCategory,
              (o.payeeName as string | undefined) ?? null,
              amount?.minorUnits ?? null,
              amount?.currency ?? null,
              (o.reference as string | undefined) ?? null,
              (o.nextDate as string | undefined) ?? null,
              JSON.stringify(o),
              runStart,
            );
          }
        }
        const upPayee = db.prepare(
          `INSERT INTO payees (payee_uid, payee_name, payee_type, raw_json, last_updated) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(payee_uid) DO UPDATE SET payee_name = excluded.payee_name, payee_type = excluded.payee_type,
             raw_json = excluded.raw_json, last_updated = excluded.last_updated`,
        );
        for (const p of payees?.payees ?? []) {
          upPayee.run(
            String(p.payeeUid),
            (p.payeeName as string | undefined) ?? null,
            (p.payeeType as string | undefined) ?? null,
            JSON.stringify(p),
            runStart,
          );
        }
        const upMandate = db.prepare(
          `INSERT INTO direct_debit_mandates (mandate_uid, originator_name, reference, status, category_uid, raw_json, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mandate_uid) DO UPDATE SET originator_name = excluded.originator_name,
             reference = excluded.reference, status = excluded.status, category_uid = excluded.category_uid,
             raw_json = excluded.raw_json, last_updated = excluded.last_updated`,
        );
        for (const m of mandates?.mandates ?? []) {
          upMandate.run(
            String(m.uid ?? m.mandateUid),
            (m.originatorName as string | undefined) ?? null,
            (m.reference as string | undefined) ?? null,
            (m.status as string | undefined) ?? null,
            (m.categoryUid as string | undefined) ?? null,
            JSON.stringify(m),
            runStart,
          );
        }
      });
    }

    // 3. Feed items, per category.
    const stateOf = db.prepare("SELECT * FROM sync_state WHERE category_uid = ?");
    for (const c of categories) {
      let state = stateOf.get(c.categoryUid) as
        | { covered_from: string | null; backfill_complete: number; changes_cursor: string | null }
        | undefined;
      if (opts.dryRun) {
        planned += plannedCalls(c, state, runStart, opts.full === true);
        continue;
      }
      if (!state || opts.full) {
        db.prepare(
          `INSERT INTO sync_state (category_uid, account_uid, backfill_floor, covered_from, backfill_complete, changes_cursor)
           VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT(category_uid) DO UPDATE SET backfill_floor = excluded.backfill_floor,
             covered_from = NULL, backfill_complete = 0, changes_cursor = COALESCE(sync_state.changes_cursor, excluded.changes_cursor)`,
        ).run(c.categoryUid, c.accountUid, c.floor, runStart);
        // A first run's backfill starts at runStart; incremental syncs take over from there next time.
        state = stateOf.get(c.categoryUid) as typeof state;
      }

      // 3a. Incremental: items created or changed since the last run (minus an overlap), so edits,
      // settlements, reversals and declines are picked up.
      const cursor = state!.changes_cursor;
      if (cursor && cursor < runStart) {
        const since = iso(new Date(Date.parse(cursor) - overlapMs));
        let items: FeedItem[];
        if (Date.parse(since) > Date.parse(yearBefore(runStart)) + DAY) {
          items =
            (
              await get<{ feedItems?: FeedItem[] }>(
                "/api/v2/feed/account/{accountUid}/category/{categoryUid}",
                { accountUid: c.accountUid, categoryUid: c.categoryUid },
                { changesSince: since },
              )
            )?.feedItems ?? [];
        } else {
          // Too long since the last sync for changesSince (max a year): refetch by window.
          items = await fetchWindows(c, since, runStart);
        }
        const r = transaction(db, () => {
          const res = upsertFeedItems(db, c.accountUid, c.categoryUid, items, runStart);
          db.prepare("UPDATE sync_state SET changes_cursor = ?, last_success = ? WHERE category_uid = ?").run(
            runStart,
            runStart,
            c.categoryUid,
          );
          return res;
        });
        newItems += r.inserted;
        updatedItems += r.updated;
      }

      // 3b. Backfill, newest window first, one year at a time, down to the account's creation date.
      if (!state!.backfill_complete) {
        if (consentLapsed) {
          message =
            "Consent has lapsed, so Starling only returns the last 90 days; backfill paused until access is re-confirmed in the Developer Portal.";
          outcome = "incomplete";
          continue;
        }
        let end = state!.covered_from ?? runStart;
        while (Date.parse(end) > Date.parse(c.floor)) {
          const start = new Date(Math.max(Date.parse(c.floor), Date.parse(yearBefore(end)))).toISOString();
          const items = await fetchWindows(c, start, end);
          const r = transaction(db, () => {
            const res = upsertFeedItems(db, c.accountUid, c.categoryUid, items, runStart);
            db.prepare("UPDATE sync_state SET covered_from = ?, last_success = ? WHERE category_uid = ?").run(
              start,
              runStart,
              c.categoryUid,
            );
            return res;
          });
          newItems += r.inserted;
          updatedItems += r.updated;
          log(
            `  ${c.kind.toLowerCase()} ${c.name ?? c.categoryUid}: ${start.slice(0, 10)}..${end.slice(0, 10)} ${items.length} items`,
          );
          end = start;
        }
        db.prepare("UPDATE sync_state SET backfill_complete = 1, last_success = ? WHERE category_uid = ?").run(
          runStart,
          c.categoryUid,
        );
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) {
      db.prepare(
        "UPDATE sync_runs SET finished_at = ?, outcome = 'error', api_calls = ?, message = ? WHERE id = ?",
      ).run(iso(nowFn()), budget.usedThisRun, err instanceof Error ? err.message : String(err), runId);
      throw err;
    }
    outcome = "incomplete";
    message = `Stopped: ${err.message}. Progress is saved; run sync again to resume.`;
  }

  /** transactions-between for [from, to], split in half if a window comes back suspiciously full. */
  async function fetchWindows(c: Category, from: string, to: string): Promise<FeedItem[]> {
    const items =
      (
        await get<{ feedItems?: FeedItem[] }>(
          "/api/v2/feed/account/{accountUid}/category/{categoryUid}/transactions-between",
          { accountUid: c.accountUid, categoryUid: c.categoryUid },
          { minTransactionTimestamp: from, maxTransactionTimestamp: to },
        )
      )?.feedItems ?? [];
    const span = Date.parse(to) - Date.parse(from);
    if (items.length >= MAX_WINDOW_ITEMS && span > DAY) {
      const mid = new Date(Date.parse(from) + Math.floor(span / 2)).toISOString();
      return [...(await fetchWindows(c, from, mid)), ...(await fetchWindows(c, mid, to))];
    }
    return items;
  }

  if (opts.dryRun) outcome = "dry-run";
  const counts = db
    .prepare("SELECT COUNT(*) AS n, MIN(transaction_time) AS earliest, MAX(transaction_time) AS latest FROM feed_items")
    .get() as { n: number; earliest: string | null; latest: string | null };
  const pending = db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE backfill_complete = 0").get() as { n: number };
  const summary: SyncSummary = {
    profile: opts.profile,
    outcome,
    message,
    newItems,
    updatedItems,
    totalItems: Number(counts.n),
    earliest: counts.earliest ?? undefined,
    latest: counts.latest ?? undefined,
    categories: Number((db.prepare("SELECT COUNT(*) AS n FROM sync_state").get() as { n: number }).n),
    backfillPending: Number(pending.n),
    apiCalls: budget.usedThisRun,
    callsUsedToday: budget.usedToday(),
    plannedCalls: opts.dryRun ? planned + budget.usedThisRun : undefined,
  };
  db.prepare(
    "UPDATE sync_runs SET finished_at = ?, outcome = ?, new_items = ?, updated_items = ?, api_calls = ?, message = ? WHERE id = ?",
  ).run(iso(nowFn()), outcome, newItems, updatedItems, budget.usedThisRun, message ?? null, runId);
  return summary;
}

/** Feed calls a category still needs: one per remaining year of backfill, plus one incremental call. */
function plannedCalls(
  c: Category,
  state: { covered_from: string | null; backfill_complete: number; changes_cursor: string | null } | undefined,
  runStart: string,
  full: boolean,
): number {
  let calls = state?.changes_cursor && !full ? 1 : 0;
  if (!state || full || !state.backfill_complete) {
    const end = Date.parse((!full && state?.covered_from) || runStart);
    const years = Math.max(0, end - Date.parse(c.floor)) / (365.25 * DAY);
    calls += Math.ceil(years);
  }
  return calls;
}
