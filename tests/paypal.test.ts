import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { StarlingClient } from "../src/client.js";
import { sync as syncStarling } from "../src/mirror/sync.js";
import {
  loadPayPalConfig,
  loadPayPalCredentials,
  PayPalApiError,
  PayPalClient,
  type PayPalConfig,
} from "../src/paypal/client.js";
import { openPayPalDbReadOnly } from "../src/paypal/db.js";
import { normaliseDate, syncPayPal, toMinor } from "../src/paypal/sync.js";
import { ACCOUNT, CATEGORY, connect, fakeStarling, testConfig, textOf } from "./helpers.js";

const SECRET = "s3cr3t-value-never-shown";
const CREDS = async () => ({ clientId: "client-id-123", clientSecret: SECRET });
const noWait = async () => {};

function tx(id: string, date: string, value: string, over: Record<string, unknown> = {}, currency = "GBP") {
  const { payer, ...info } = over as { payer?: Record<string, unknown> };
  return {
    transaction_info: {
      transaction_id: id,
      transaction_event_code: "T0006",
      transaction_initiation_date: date.replace(/\.\d{3}Z$/, "+0000").replace(/Z$/, "+0000"),
      transaction_updated_date: date.replace(/\.\d{3}Z$/, "+0000").replace(/Z$/, "+0000"),
      transaction_amount: { currency_code: currency, value },
      fee_amount: { currency_code: currency, value: "0.00" },
      transaction_status: "S",
      ...info,
    },
    payer_info: {
      email_address: `${id}@example.com`,
      payer_name: { alternate_full_name: `Party ${id}` },
      ...(payer ?? {}),
    },
    cart_info: { item_details: [{ item_name: `Widget ${id}` }] },
  };
}

/** A fake PayPal API over a set of transactions, with 2-item pages so pagination is exercised. */
function fakePayPal(opts: { data?: () => ReturnType<typeof tx>[]; fail429?: number; oauthStatus?: number } = {}) {
  const calls: { method: string; url: URL; auth?: string }[] = [];
  let tooMany = opts.fail429 ?? 0;
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = (init.headers as Record<string, string>)?.Authorization;
    calls.push({ method: init.method ?? "GET", url, auth });
    if (url.pathname === "/v1/oauth2/token") {
      if (opts.oauthStatus)
        return new Response(JSON.stringify({ error: "invalid_client" }), { status: opts.oauthStatus });
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 32400 }), { status: 200 });
    }
    if (tooMany > 0) {
      tooMany--;
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    }
    if (url.pathname === "/v1/reporting/balances") {
      return new Response(
        JSON.stringify({
          as_of_time: "2026-11-20T10:00:00+0000",
          balances: [{ currency: "GBP", primary: true, total_balance: { currency_code: "GBP", value: "123.45" } }],
        }),
      );
    }
    if (url.pathname === "/v1/reporting/transactions") {
      const start = normaliseDate(url.searchParams.get("start_date")!)!;
      const end = normaliseDate(url.searchParams.get("end_date")!)!;
      const page = Number(url.searchParams.get("page"));
      const all = (opts.data?.() ?? []).filter((d) => {
        const t = normaliseDate(d.transaction_info.transaction_initiation_date)!;
        return t >= start && t <= end;
      });
      const size = 2;
      return new Response(
        JSON.stringify({
          transaction_details: all.slice((page - 1) * size, page * size),
          total_pages: Math.max(1, Math.ceil(all.length / size)),
          last_refreshed_datetime: "2026-11-20T09:00:00+0000",
        }),
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let dir: string;
let config: PayPalConfig;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "starling-paypal-")));
  config = loadPayPalConfig(
    { PAYPAL_DB_PATH: join(dir, "pp.sqlite"), PAYPAL_ENVIRONMENT: "sandbox" },
    "paypal-business",
  );
});

const DATA = [
  tx("A", "2024-01-10T10:00:00Z", "-25.00", { transaction_subject: "Hosting" }),
  tx("B", "2025-06-01T10:00:00Z", "100.00", { transaction_event_code: "T0300" }),
  tx("C", "2026-11-01T10:00:00Z", "-12.00", {}, "EUR"),
  tx("C2", "2026-11-01T10:00:30Z", "12.00", { transaction_event_code: "T0200", paypal_reference_id: "C" }, "EUR"),
  tx("C3", "2026-11-01T10:00:30Z", "-10.40", { transaction_event_code: "T0200", paypal_reference_id: "C" }),
  tx("D", "2026-11-05T10:00:00Z", "-50.00", { transaction_event_code: "T0400" }),
  tx("E", "2026-11-10T10:00:00Z", "-9.99", { transaction_status: "P" }),
];

describe("money and dates", () => {
  it("parses amounts exactly by currency exponent", () => {
    expect(toMinor({ currency_code: "GBP", value: "-12.34" })).toBe(-1234);
    expect(toMinor({ currency_code: "GBP", value: "0.1" })).toBe(10);
    expect(toMinor({ currency_code: "JPY", value: "1500" })).toBe(1500);
    expect(toMinor({ currency_code: "GBP", value: "1234567.89" })).toBe(123456789);
    expect(toMinor(undefined)).toBeNull();
  });
  it("normalises PayPal's +0000 offsets", () => {
    expect(normaliseDate("2026-11-01T10:00:00+0000")).toBe("2026-11-01T10:00:00.000Z");
    expect(normaliseDate("2026-11-01T11:00:00+0100")).toBe("2026-11-01T10:00:00.000Z");
  });
});

describe("PayPal client", () => {
  it("caches the OAuth token, retries 429s, and only calls reporting GETs on the configured host", async () => {
    const pp = fakePayPal({ fail429: 2 });
    const c = new PayPalClient(config, CREDS, pp.fetchImpl, { minIntervalMs: 0, wait: noWait });
    await c.get("/v1/reporting/balances");
    await c.get("/v1/reporting/balances");
    expect(pp.calls.filter((x) => x.url.pathname === "/v1/oauth2/token")).toHaveLength(1);
    expect(pp.calls.every((x) => x.url.origin === "https://api-m.sandbox.paypal.com")).toBe(true);
    expect(pp.calls.filter((x) => x.method !== "GET").map((x) => x.url.pathname)).toEqual(["/v1/oauth2/token"]);
    await expect(c.get("/v1/payments/payment")).rejects.toThrow(/non-reporting/);
  });

  it("never puts the secret in errors", async () => {
    const c = new PayPalClient(config, CREDS, fakePayPal({ oauthStatus: 401 }).fetchImpl, { minIntervalMs: 0 });
    const err = await c.get("/v1/reporting/balances").catch((e: Error) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(String((err as Error).message)).toMatch(/invalid_client/);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain("client-id-123");
  });

  it("explains how to store missing credentials", async () => {
    await expect(loadPayPalCredentials(config, async () => undefined)).rejects.toThrow(
      /paypal token set --profile paypal-business/,
    );
    expect(loadPayPalConfig({}, "paypal-business").keychainService).toBe("fermium-paypal-business");
    expect(loadPayPalConfig({}).baseUrl).toBe("https://api-m.paypal.com");
  });
});

describe("paypal sync", () => {
  const at = (iso: string) => () => new Date(iso);
  const client = (f: typeof fetch) => new PayPalClient(config, CREDS, f, { minIntervalMs: 0, wait: noWait });

  it("backfills three years in ≤31-day windows with pagination, then re-syncs idempotently", async () => {
    let data = DATA.map((d) => structuredClone(d));
    const pp = fakePayPal({ data: () => data });
    const s = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
      profile: "paypal-business",
      now: at("2026-11-20T12:00:00Z"),
    });
    expect(s).toMatchObject({ outcome: "complete", newItems: 7, totalItems: 7, backfillComplete: true });
    const windows = pp.calls.filter(
      (c) => c.url.pathname === "/v1/reporting/transactions" && c.url.searchParams.get("page") === "1",
    );
    for (const w of windows) {
      const a = Date.parse(w.url.searchParams.get("start_date")!);
      const b = Date.parse(w.url.searchParams.get("end_date")!);
      expect(b - a).toBeLessThanOrEqual(31 * 86400_000);
      expect(a).toBeGreaterThanOrEqual(Date.parse("2023-11-20T12:00:00Z"));
      expect(w.url.searchParams.get("fields")).toBe("all");
      expect(w.url.searchParams.get("page_size")).toBe("500");
    }
    expect(windows.length).toBeGreaterThanOrEqual(35);
    // The November window holds 5 items: 3 pages of 2.
    expect(pp.calls.filter((c) => c.url.searchParams.get("page") === "3")).toHaveLength(1);

    const again = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
      profile: "paypal-business",
      now: at("2026-11-21T12:00:00Z"),
    });
    expect(again).toMatchObject({ newItems: 0, updatedItems: 0, totalItems: 7 });

    data = data.map((d) =>
      d.transaction_info.transaction_id === "E"
        ? { ...d, transaction_info: { ...d.transaction_info, transaction_status: "S" } }
        : d,
    );
    const third = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
      profile: "paypal-business",
      now: at("2026-11-22T12:00:00Z"),
    });
    expect(third).toMatchObject({ newItems: 0, updatedItems: 1, totalItems: 7 });
    const db = openPayPalDbReadOnly(config.dbPath)!;
    expect(
      db
        .prepare("SELECT status, gross_minor, net_minor, payer_name FROM transactions WHERE transaction_id = 'E'")
        .get(),
    ).toEqual({
      status: "S",
      gross_minor: -999,
      net_minor: -999,
      payer_name: "Party E",
    });
    expect(db.prepare("SELECT total_minor FROM balances").get()).toEqual({ total_minor: 12345 });
    db.close();
  });

  it("stops at --max-requests and resumes to the same result", async () => {
    const pp = fakePayPal({ data: () => DATA });
    const first = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
      profile: "paypal-business",
      maxRequests: 10,
      now: at("2026-11-20T12:00:00Z"),
    });
    expect(first.outcome).toBe("incomplete");
    let last = first;
    for (let i = 0; i < 10 && last.outcome !== "complete"; i++) {
      last = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
        profile: "paypal-business",
        maxRequests: 10,
        now: at("2026-11-20T13:00:00Z"),
      });
    }
    expect(last).toMatchObject({ outcome: "complete", totalItems: 7, backfillComplete: true });
  });

  it("treats persistent 429s as a resumable stop", async () => {
    const pp = fakePayPal({ data: () => DATA, fail429: 100 });
    const s = await syncPayPal(client(pp.fetchImpl), config.dbPath, {
      profile: "paypal-business",
      now: at("2026-11-20T12:00:00Z"),
    });
    expect(s.outcome).toBe("incomplete");
    expect(s.message).toMatch(/429/);
  });
});

describe("PayPal MCP tools", () => {
  const STARLING_ITEMS = [
    // Bank deposit into PayPal (B) → Starling debit to PayPal 2 days later.
    { uid: "s1", time: "2025-06-03T09:00:00.000Z", dir: "OUT", minor: 10000, name: "PayPal Europe" },
    // Converted EUR payment (C, GBP leg 10.40) → Starling debit.
    { uid: "s2", time: "2026-11-02T09:00:00.000Z", dir: "OUT", minor: 1040, name: "PAYPAL *SOMESHOP" },
    // Withdrawal to bank (D) → Starling credit.
    { uid: "s3", time: "2026-11-06T09:00:00.000Z", dir: "IN", minor: 5000, name: "PayPal" },
    // A PayPal debit with no PayPal counterpart.
    { uid: "s4", time: "2026-11-15T09:00:00.000Z", dir: "OUT", minor: 777, name: "PayPal" },
    // Same amount as A but not PayPal-labelled: ignored by default.
    { uid: "s5", time: "2024-01-11T09:00:00.000Z", dir: "OUT", minor: 2500, name: "Tesco" },
  ];

  async function setup() {
    const pp = fakePayPal({ data: () => DATA });
    await syncPayPal(new PayPalClient(config, CREDS, pp.fetchImpl, { minIntervalMs: 0, wait: noWait }), config.dbPath, {
      profile: "paypal-business",
    });
    const starlingDb = join(dir, "business.sqlite");
    const feed = STARLING_ITEMS.map((i) => ({
      feedItemUid: i.uid,
      categoryUid: CATEGORY,
      amount: { currency: "GBP", minorUnits: i.minor },
      sourceAmount: { currency: "GBP", minorUnits: i.minor },
      direction: i.dir,
      transactionTime: i.time,
      status: "SETTLED",
      counterPartyName: i.name,
    }));
    const { fetchImpl } = fakeStarling({
      "GET /api/v2/identity/token": () => ({ json: { consentExpiresAt: "2099-01-01T00:00:00Z" } }),
      "GET /api/v2/account-holder": () => ({ json: { accountHolderUid: "h", accountHolderType: "BUSINESS" } }),
      "GET /api/v2/accounts": () => ({
        json: {
          accounts: [
            {
              accountUid: ACCOUNT,
              accountType: "PRIMARY",
              defaultCategory: CATEGORY,
              currency: "GBP",
              createdAt: "2023-01-01T00:00:00Z",
              name: "Business",
            },
          ],
        },
      }),
      "GET /api/v2/feed/account/{a}/category/{c}/transactions-between": (req) => ({
        json: {
          feedItems: feed.filter(
            (f) =>
              f.transactionTime >= req.url.searchParams.get("minTransactionTimestamp")! &&
              f.transactionTime <= req.url.searchParams.get("maxTransactionTimestamp")!,
          ),
        },
      }),
    });
    await syncStarling(new StarlingClient(testConfig(), "t", undefined, fetchImpl), starlingDb, {
      profile: "business",
    });
    const api = fakeStarling({});
    const c = await connect(
      testConfig({
        STARLING_PROFILE: "business",
        STARLING_DB_PATH: starlingDb,
        PAYPAL_PROFILE: "paypal-business",
        PAYPAL_DB_PATH: config.dbPath,
      }),
      api.fetchImpl,
    );
    return { c, calls: api.calls };
  }

  it("are only registered when PAYPAL_PROFILE is set", async () => {
    const without = (await (await connect(testConfig(), fakeStarling({}).fetchImpl)).listTools()).tools.map(
      (t) => t.name,
    );
    expect(without.some((n) => n.startsWith("paypal_"))).toBe(false);
    const { c } = await setup();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["paypal_query_transactions", "paypal_mirror_status", "paypal_match_starling"]),
    );
    expect(names.some((n) => /paypal_(create|refund|invoice|pay|send)/.test(n))).toBe(false);
  });

  it("paypal_query_transactions filters by date, amount, text, event type and status", async () => {
    const { c, calls } = await setup();
    const q = async (args: Record<string, unknown>) =>
      JSON.parse(textOf(await c.callTool({ name: "paypal_query_transactions", arguments: args })));
    expect((await q({})).matched).toBe(7);
    expect(
      (await q({ search: "hosting" })).transactions.map((t: { transactionId: string }) => t.transactionId),
    ).toEqual(["A"]);
    expect((await q({ search: "widget e" })).transactions[0].transactionId).toBe("E");
    expect((await q({ eventCodes: ["T02"] })).matched).toBe(2);
    expect((await q({ statuses: ["P"] })).transactions[0]).toMatchObject({
      transactionId: "E",
      statusMeaning: "pending",
    });
    expect((await q({ direction: "OUT", minAmountMinorUnits: 2000, currency: "GBP" })).matched).toBe(2);
    expect((await q({ from: "2026-11-01", to: "2026-11-01" })).matched).toBe(3);
    const status = JSON.parse(textOf(await c.callTool({ name: "paypal_mirror_status", arguments: {} })));
    expect(status).toMatchObject({ transactions: 7, historyComplete: true });
    expect(calls).toHaveLength(0);
  });

  it("paypal_match_starling pairs deposits, converted payments and withdrawals with Starling items", async () => {
    const { c, calls } = await setup();
    const res = JSON.parse(
      textOf(await c.callTool({ name: "paypal_match_starling", arguments: { from: "2023-12-01", to: "2026-11-20" } })),
    );
    const byId = Object.fromEntries(
      res.results.map((r: { paypal: { transactionId: string }; starling: { feedItemUid: string } | null }) => [
        r.paypal.transactionId,
        r.starling?.feedItemUid ?? null,
      ]),
    );
    expect(byId).toMatchObject({ B: "s1", C: "s2", D: "s3", A: null, E: null });
    const c2 = res.results.find((r: { paypal: { transactionId: string } }) => r.paypal.transactionId === "C");
    expect(c2.conversion).toMatchObject({ from: "€12.00", to: "£10.40" });
    expect(res.unmatchedStarlingPayPalItems.map((s: { feedItemUid: string }) => s.feedItemUid)).toEqual(["s4"]);
    expect(res.starlingAccountHolderType).toBe("BUSINESS");

    const any = JSON.parse(
      textOf(
        await c.callTool({
          name: "paypal_match_starling",
          arguments: { from: "2023-12-01", to: "2026-11-20", anyCounterparty: true, onlyUnmatched: true },
        }),
      ),
    );
    expect(any.results.map((r: { paypal: { transactionId: string } }) => r.paypal.transactionId)).toEqual(["E"]);
    expect(calls).toHaveLength(0);
  });
});
