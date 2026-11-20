import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { StarlingClient } from "../src/client.js";
import { backupMirror } from "../src/mirror/backup.js";
import { openMirror, openMirrorReadOnly } from "../src/mirror/db.js";
import { sync } from "../src/mirror/sync.js";
import { ftsQuery } from "../src/tools/mirror.js";
import { ACCOUNT, CATEGORY, connect, fakeStarling, type Recorded, testConfig, textOf } from "./helpers.js";

const GOAL = "77777777-7777-4777-8777-777777777777";
const CREATED = "2023-06-01T00:00:00.000Z";

function item(uid: string, category: string, time: string, over: Record<string, unknown> = {}) {
  return {
    feedItemUid: uid,
    categoryUid: category,
    amount: { currency: "GBP", minorUnits: 1000 },
    sourceAmount: { currency: "GBP", minorUnits: 1000 },
    direction: "OUT",
    transactionTime: time,
    status: "SETTLED",
    counterPartyName: `Shop ${uid}`,
    reference: `REF ${uid}`,
    spendingCategory: "GROCERIES",
    ...over,
  };
}

/** A fake Starling with feed items spread over three years, a savings goal and optional overrides. */
function world(opts: { consentExpiresAt?: string; changes?: () => unknown[]; fail429After?: number } = {}) {
  const main = [
    item("a1", CATEGORY, "2023-07-15T10:00:00.000Z", { counterPartyName: "Tesco Stores", userNote: "weekly shop" }),
    item("a2", CATEGORY, "2024-03-02T10:00:00.000Z", {
      counterPartyName: "Netflix",
      spendingCategory: "ENTERTAINMENT",
    }),
    item("a3", CATEGORY, "2025-08-20T10:00:00.000Z", {
      direction: "IN",
      counterPartyName: "Employer Ltd",
      amount: { currency: "GBP", minorUnits: 250000 },
    }),
    item("a4", CATEGORY, "2026-11-01T10:00:00.000Z", { status: "DECLINED", counterPartyName: "Café Nero" }),
    item("a5", CATEGORY, "2026-11-02T10:00:00.000Z", {
      counterPartyType: "CATEGORY",
      source: "INTERNAL_TRANSFER",
      counterPartyName: "Holiday",
    }),
  ];
  const goal = [
    item("g1", GOAL, "2026-11-02T10:00:00.000Z", {
      direction: "IN",
      counterPartyType: "CATEGORY",
      source: "INTERNAL_TRANSFER",
    }),
  ];
  let calls = 0;
  const inRange = (list: typeof main, req: Recorded) => {
    const min = req.url.searchParams.get("minTransactionTimestamp")!;
    const max = req.url.searchParams.get("maxTransactionTimestamp")!;
    return list.filter((i) => i.transactionTime >= min && i.transactionTime <= max);
  };
  const guard =
    <T>(fn: () => T) =>
    () => {
      calls++;
      if (opts.fail429After !== undefined && calls > opts.fail429After)
        return { status: 429, headers: { "retry-after": "3600" } };
      return fn();
    };
  const fake = fakeStarling({
    "GET /api/v2/identity/token": guard(() => ({
      json: { accountHolderUid: "h1", scopes: [], consentExpiresAt: opts.consentExpiresAt ?? "2099-01-01T00:00:00Z" },
    })),
    "GET /api/v2/account-holder": guard(() => ({ json: { accountHolderUid: "h1", accountHolderType: "INDIVIDUAL" } })),
    "GET /api/v2/account-holder/name": guard(() => ({ json: { accountHolderName: "Test Person" } })),
    "GET /api/v2/accounts": guard(() => ({
      json: {
        accounts: [
          {
            accountUid: ACCOUNT,
            accountType: "PRIMARY",
            defaultCategory: CATEGORY,
            currency: "GBP",
            createdAt: CREATED,
            name: "Personal",
          },
        ],
      },
    })),
    "GET /api/v2/account/{a}/spaces": guard(() => ({
      json: { savingsGoals: [{ savingsGoalUid: GOAL, name: "Holiday", state: "ACTIVE" }], spendingSpaces: [] },
    })),
    "GET /api/v2/accounts/{a}/balance": guard(() => ({
      json: {
        effectiveBalance: { currency: "GBP", minorUnits: 5000 },
        clearedBalance: { currency: "GBP", minorUnits: 5000 },
      },
    })),
    "GET /api/v2/payments/local/account/{a}/category/{c}/standing-orders": guard(() => ({
      status: 403,
      json: { errors: [{ message: "INSUFFICIENT_SCOPE" }] },
    })),
    "GET /api/v2/payees": guard(() => ({
      json: { payees: [{ payeeUid: "p1", payeeName: "Jane", payeeType: "INDIVIDUAL" }] },
    })),
    "GET /api/v2/direct-debit/mandates": guard(() => ({
      json: { mandates: [{ uid: "m1", originatorName: "Gym", status: "LIVE" }] },
    })),
    "GET /api/v2/feed/account/{a}/category/{c}/transactions-between": (req) =>
      guard(() => ({ json: { feedItems: inRange(req.url.pathname.includes(GOAL) ? goal : main, req) } }))(),
    "GET /api/v2/feed/account/{a}/category/{c}": (req) =>
      guard(() => ({ json: { feedItems: req.url.pathname.includes(GOAL) ? [] : (opts.changes?.() ?? []) } }))(),
  });
  return { ...fake, main, goal, callCount: () => calls };
}

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "starling-mirror-")));
  dbPath = join(dir, "data", "test.sqlite");
});

const client = (fetchImpl: typeof fetch) => new StarlingClient(testConfig(), "t", undefined, fetchImpl);
const at = (iso: string) => () => new Date(iso);

describe("sync", () => {
  it("backfills every category to the account's creation date, one year per call", async () => {
    const w = world();
    const s = await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });
    expect(s.outcome).toBe("complete");
    expect(s.newItems).toBe(6);
    expect(s.totalItems).toBe(6);
    expect(s.backfillPending).toBe(0);
    expect(s.categories).toBe(2);
    expect(s.earliest).toBe("2023-07-15T10:00:00.000Z");
    // 2023-06-01 .. 2026-11-20 is just under 3.5 years: 4 windows per category.
    const windows = w.calls.filter((c) => c.url.pathname.endsWith("/transactions-between"));
    expect(windows).toHaveLength(8);
    for (const c of windows) {
      const span =
        Date.parse(c.url.searchParams.get("maxTransactionTimestamp")!) -
        Date.parse(c.url.searchParams.get("minTransactionTimestamp")!);
      expect(span).toBeLessThanOrEqual(366 * 86400_000);
      expect(c.url.searchParams.get("minTransactionTimestamp")! >= CREATED).toBe(true);
    }
    expect(s.apiCalls).toBe(w.calls.length);
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync)) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    const db = openMirrorReadOnly(dbPath)!;
    expect(db.prepare("SELECT COUNT(*) AS n FROM payees").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM direct_debit_mandates").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM balance_snapshots").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT account_holder_type AS t FROM account_holder").get()).toEqual({ t: "INDIVIDUAL" });
    db.close();
  });

  it("re-syncs idempotently and picks up changed items through changesSince with an overlap", async () => {
    let changes: unknown[] = [];
    const w = world({ changes: () => changes });
    await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });

    const again = await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-21T12:00:00Z") });
    expect(again).toMatchObject({ outcome: "complete", newItems: 0, updatedItems: 0, totalItems: 6 });
    const since = w.calls
      .filter((c) => c.url.searchParams.has("changesSince"))
      .map((c) => c.url.searchParams.get("changesSince"));
    expect(since[0]).toBe("2026-11-13T12:00:00.000Z"); // last run start minus the 7-day overlap

    changes = [
      { ...w.main[3], status: "REVERSED" },
      item("a6", CATEGORY, "2026-11-21T09:00:00.000Z", { counterPartyName: "Pret" }),
      w.main[0],
    ];
    const third = await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-22T12:00:00Z") });
    expect(third).toMatchObject({ newItems: 1, updatedItems: 1, totalItems: 7 });
    const db = openMirrorReadOnly(dbPath)!;
    expect(db.prepare("SELECT status FROM feed_items WHERE feed_item_uid = 'a4'").get()).toEqual({
      status: "REVERSED",
    });
    // FTS follows updates (no stale or duplicate rows).
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed_items_fts WHERE feed_items_fts MATCH 'nero'").get()).toEqual({
      n: 1,
    });
    db.close();
  });

  it("stops cleanly at --max-requests and resumes to the same result", async () => {
    const full = world();
    const reference = await sync(client(full.fetchImpl), join(dir, "ref.sqlite"), {
      profile: "t",
      now: at("2026-11-20T12:00:00Z"),
    });

    const w = world();
    const first = await sync(client(w.fetchImpl), dbPath, {
      profile: "test",
      maxRequests: 14,
      now: at("2026-11-20T12:00:00Z"),
    });
    expect(first.outcome).toBe("incomplete");
    expect(first.apiCalls).toBe(14);
    expect(first.backfillPending).toBeGreaterThan(0);
    expect(first.message).toMatch(/max-requests.*run sync again/);

    let last = first;
    for (let i = 0; i < 5 && last.outcome !== "complete"; i++) {
      last = await sync(client(w.fetchImpl), dbPath, {
        profile: "test",
        maxRequests: 14,
        now: at("2026-11-20T13:00:00Z"),
      });
    }
    expect(last.outcome).toBe("complete");
    expect(last.totalItems).toBe(reference.totalItems);
    expect(last.earliest).toBe(reference.earliest);
  });

  it("treats a daily-limit 429 as a resumable stop, and keeps a per-day call count", async () => {
    const w = world({ fail429After: 12 });
    const s = await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });
    expect(s.outcome).toBe("incomplete");
    expect(s.message).toMatch(/429/);
    const db = openMirrorReadOnly(dbPath)!;
    expect(Number((db.prepare("SELECT requests FROM api_usage").get() as { requests: number }).requests)).toBe(
      s.callsUsedToday,
    );
    db.close();
    const capped = await sync(client(world().fetchImpl), dbPath, {
      profile: "test",
      dailyLimit: s.callsUsedToday,
      now: at("2026-11-20T12:30:00Z"),
    });
    expect(capped.outcome).toBe("incomplete");
    expect(capped.apiCalls).toBe(0);
  });

  it("does not mark history complete when consent has lapsed (Starling then serves only 90 days)", async () => {
    const w = world({ consentExpiresAt: "2026-01-01T00:00:00Z" });
    const s = await sync(client(w.fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });
    expect(s.outcome).toBe("incomplete");
    expect(s.message).toMatch(/Consent has lapsed/);
    expect(w.calls.some((c) => c.url.pathname.endsWith("/transactions-between"))).toBe(false);
  });

  it("refuses to run two syncs of one mirror at once", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(`${dbPath}.lock`, String(process.pid));
    await expect(sync(client(world().fetchImpl), dbPath, { profile: "test" })).rejects.toThrow(/Another sync/);
  });

  it("dry run estimates calls without fetching the feed", async () => {
    const w = world();
    const s = await sync(client(w.fetchImpl), dbPath, {
      profile: "test",
      dryRun: true,
      now: at("2026-11-20T12:00:00Z"),
    });
    expect(s.outcome).toBe("dry-run");
    expect(s.plannedCalls).toBe(s.apiCalls + 8);
    expect(w.calls.some((c) => c.url.pathname.includes("/feed/"))).toBe(false);
  });
});

describe("mirror schema", () => {
  it("records its schema version and reopens without re-running migrations", () => {
    const db = openMirror(dbPath);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
    openMirror(dbPath).close();
    const ro = openMirrorReadOnly(dbPath)!;
    expect(() => ro.exec("DELETE FROM feed_items")).toThrow(/readonly/);
    ro.close();
  });
});

describe("backups", () => {
  it("writes a 0600 copy named <profile>-YYYY-MM-DD.sqlite and keeps 14", async () => {
    await sync(client(world().fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });
    const backups = join(dir, "drive", "backups");
    mkdirSync(backups, { recursive: true });
    for (let d = 1; d <= 20; d++)
      writeFileSync(join(backups, `test-2026-10-${String(d).padStart(2, "0")}.sqlite`), "old");
    writeFileSync(join(backups, "notes.txt"), "keep me");
    writeFileSync(join(backups, "other-2026-10-01.sqlite"), "other profile");
    const { path, removed } = backupMirror(dbPath, backups, "test", new Date("2026-11-20T12:00:00Z"));
    expect(path).toBe(join(backups, "test-2026-11-20.sqlite"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(removed).toHaveLength(7);
    const left = readdirSync(backups);
    expect(left.filter((f) => f.startsWith("test-"))).toHaveLength(14);
    expect(left).toContain("notes.txt");
    expect(left).toContain("other-2026-10-01.sqlite");
    expect(left.some((f) => f.endsWith(".tmp"))).toBe(false);
    const copy = openMirrorReadOnly(path)!;
    expect(copy.prepare("SELECT COUNT(*) AS n FROM feed_items").get()).toEqual({ n: 6 });
    copy.close();
    // Same day again replaces that day's copy.
    expect(backupMirror(dbPath, backups, "test", new Date("2026-11-20T18:00:00Z")).path).toBe(path);
  });

  it("refuses to back up into the live mirror's folder", async () => {
    await sync(client(world().fetchImpl), dbPath, { profile: "test", now: at("2026-11-20T12:00:00Z") });
    expect(() => backupMirror(dbPath, join(dir, "data"), "test")).toThrow(/must not be/);
  });
});

describe("mirror tools", () => {
  async function mcp() {
    await sync(client(world().fetchImpl), dbPath, { profile: "test" });
    const { fetchImpl, calls } = fakeStarling({});
    return {
      client: await connect(testConfig({ STARLING_DB_PATH: dbPath, STARLING_PROFILE: "personal" }), fetchImpl),
      calls,
    };
  }

  it("query_transactions searches every account and space, labels rows and makes no API calls", async () => {
    const { client: c, calls } = await mcp();
    const all = JSON.parse(textOf(await c.callTool({ name: "query_transactions", arguments: {} })));
    expect(all.matched).toBe(6);
    expect(all.profile).toBe("personal");
    expect(all.accountHolderType).toBe("INDIVIDUAL");
    expect(all.mirror.stale).toBe(false);
    expect(all.transactions[0]).toMatchObject({ profile: "personal", account: "Personal" });
    expect(all.transactions.some((t: { space?: string }) => t.space === "Holiday")).toBe(true);
    // Totals: SETTLED/PENDING only, internal transfers excluded (so the goal move is not double counted).
    expect(all.totals.GBP).toEqual({ in: "£2,500.00", out: "£20.00", count: 3 });

    const search = JSON.parse(
      textOf(await c.callTool({ name: "query_transactions", arguments: { search: 'tesc "weekly' } })),
    );
    expect(search.transactions.map((t: { feedItemUid: string }) => t.feedItemUid)).toEqual(["a1"]);
    const cafe = JSON.parse(textOf(await c.callTool({ name: "query_transactions", arguments: { search: "cafe" } })));
    expect(cafe.matched).toBe(1);

    const filtered = JSON.parse(
      textOf(
        await c.callTool({
          name: "query_transactions",
          arguments: { from: "2024-01-01", to: "2025-12-31", direction: "OUT", statuses: ["SETTLED"] },
        }),
      ),
    );
    expect(filtered.transactions.map((t: { feedItemUid: string }) => t.feedItemUid)).toEqual(["a2"]);
    expect(calls).toHaveLength(0);
  });

  it("mirror_status and the offline analysis tools work without the API", async () => {
    const { client: c, calls } = await mcp();
    const status = JSON.parse(textOf(await c.callTool({ name: "mirror_status", arguments: {} })));
    expect(status).toMatchObject({ profile: "personal", totalRows: 6, historyComplete: true });
    expect(status.categories).toHaveLength(2);
    const summary = JSON.parse(
      textOf(
        await c.callTool({
          name: "summarise_spending_offline",
          arguments: { from: "2023-01-01", groupBy: "counterParty" },
        }),
      ),
    );
    expect(summary.groups.map((g: { counterParty: string }) => g.counterParty).sort()).toEqual([
      "Netflix",
      "Tesco Stores",
    ]);
    const rec = await c.callTool({ name: "find_recurring_payments_offline", arguments: {} });
    expect(rec.isError).toBeFalsy();
    expect(calls).toHaveLength(0);
  });

  it("explains how to create the mirror when there is none", async () => {
    const c = await connect(testConfig({ STARLING_DB_PATH: join(dir, "missing.sqlite") }), fakeStarling({}).fetchImpl);
    const res = await c.callTool({ name: "query_transactions", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/starling-mcp sync/);
  });
});

describe("ftsQuery", () => {
  it("quotes every word so FTS syntax in user text cannot break the query", () => {
    expect(ftsQuery('tesco "x OR y" -z')).toBe('"tesco"* "x"* "OR"* "y"* "-z"*');
    expect(ftsQuery('  "" ')).toBeUndefined();
  });
});
