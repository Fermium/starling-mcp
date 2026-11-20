import { describe, expect, it } from "vitest";
import { retryAfterSeconds } from "../src/client.js";
import { assertWithinOneYear } from "../src/feed.js";
import { ACCOUNT, ACCOUNTS_ROUTE, CATEGORY, connect, fakeStarling, testConfig, textOf } from "./helpers.js";

describe("Retry-After", () => {
  it("accepts seconds and HTTP dates", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(retryAfterSeconds("3", now)).toBe(3);
    expect(retryAfterSeconds(null, now)).toBe(1);
    expect(retryAfterSeconds("Fri, 20 Nov 2026 12:00:05 GMT", now)).toBe(5);
    expect(retryAfterSeconds("Fri, 20 Nov 2026 11:59:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("Fri, 20 Nov 2026 13:00:00 GMT", now)).toBe(3600);
    expect(retryAfterSeconds("soon", now)).toBeNaN();
  });
});

describe("one-year range limit", () => {
  it("allows exactly a calendar year (including leap years) and rejects longer", () => {
    expect(() => assertWithinOneYear("2024-02-29T00:00:00.000Z", "2025-03-01T00:00:00.000Z", "q", "")).not.toThrow();
    expect(() =>
      assertWithinOneYear("2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "q", "Split it."),
    ).not.toThrow();
    expect(() => assertWithinOneYear("2025-01-01T00:00:00.000Z", "2026-01-01T23:59:59.999Z", "q", "Split it.")).toThrow(
      /at most one year.*Split it/,
    );
    expect(() => assertWithinOneYear("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "q", "")).toThrow(
      /before the start/,
    );
  });

  it("list_settled_transactions refuses ranges over a year without calling Starling", async () => {
    const { fetchImpl, calls } = fakeStarling({ ...ACCOUNTS_ROUTE });
    const client = await connect(testConfig(), fetchImpl);
    const res = await client.callTool({
      name: "list_settled_transactions",
      arguments: { from: "2024-01-01", to: "2025-06-01" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/at most one year/);
    expect(calls).toHaveLength(0);
  });

  it("get_feed_changes_since refuses timestamps over a year old", async () => {
    const { fetchImpl, calls } = fakeStarling({ ...ACCOUNTS_ROUTE });
    const client = await connect(testConfig(), fetchImpl);
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    const res = await client.callTool({ name: "get_feed_changes_since", arguments: { changesSince: old } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("list_transactions totals", () => {
  const item = (uid: string, status: string, direction: "IN" | "OUT", minorUnits: number) => ({
    feedItemUid: uid,
    categoryUid: CATEGORY,
    amount: { currency: "GBP", minorUnits },
    sourceAmount: { currency: "GBP", minorUnits },
    direction,
    transactionTime: "2026-11-10T10:00:00.000Z",
    status,
    counterPartyName: `Shop ${uid}`,
  });

  it("counts only SETTLED and PENDING, and reports the rest separately", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      "GET /api/v2/feed/account/{a}/category/{c}/transactions-between": () => ({
        json: {
          feedItems: [
            item("1", "SETTLED", "OUT", 1000),
            item("2", "PENDING", "OUT", 500),
            item("3", "DECLINED", "OUT", 99900),
            item("4", "UPCOMING", "OUT", 2000),
            item("5", "REVERSED", "OUT", 300),
            item("6", "SETTLED", "IN", 10000),
          ],
        },
      }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const res = await client.callTool({
      name: "list_transactions",
      arguments: { accountUid: ACCOUNT, from: "2026-11-01", to: "2026-11-20" },
    });
    const body = JSON.parse(textOf(res));
    expect(body.matched).toBe(6);
    expect(body.totals.GBP).toEqual({ in: "£100.00", out: "£15.00", net: "£85.00", count: 3 });
    expect(Object.keys(body.notInTotals).sort()).toEqual(["DECLINED", "REVERSED", "UPCOMING"]);
    expect(body.notInTotals.DECLINED.GBP.out).toBe("£999.00");
  });
});
