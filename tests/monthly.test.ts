import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fileFacts, slug } from "../src/files.js";
import { monthRange } from "../src/tools/accounts.js";
import { ACCOUNT, ACCOUNTS_ROUTE, connect, fakeStarling, testConfig, textOf } from "./helpers.js";

const CSV = "Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n01/10/2026,Shop,REF,CARD,-1.00,99.00\n";

let dir: string;
beforeEach(() => {
  dir = join(realpathSync(mkdtempSync(join(tmpdir(), "starling-monthly-"))), "dl");
});

describe("monthRange", () => {
  const now = new Date("2026-11-20T15:00:00Z");
  it("covers whole past months, including leap February", () => {
    expect(monthRange("2026-10", now)).toEqual({ start: "2026-10-01", end: "2026-10-31", partial: false });
    expect(monthRange("2024-02", now)).toEqual({ start: "2024-02-01", end: "2024-02-29", partial: false });
    expect(monthRange("2025-12", now).end).toBe("2025-12-31");
  });
  it("ends the current month today and refuses future months", () => {
    expect(monthRange("2026-11", now)).toEqual({ start: "2026-11-01", end: "2026-11-20", partial: true });
    expect(() => monthRange("2026-12", now)).toThrow(/future/);
  });
});

describe("helpers", () => {
  it("slugs account names safely", () => {
    expect(slug("Easy Saver")).toBe("easy-saver");
    expect(slug("Café & Co. Ltd")).toBe("cafe-co-ltd");
    expect(slug("../../etc")).toBe("etc");
    expect(slug("✨")).toBe("account");
  });
  it("reports size and sha256", () => {
    expect(fileFacts("/x", "abc")).toEqual({
      path: "/x",
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});

describe("download_monthly_export", () => {
  const exportRoute = (seen: URL[]) => ({
    "GET /api/v2/accounts/{a}/feed-export": (req: { url: URL }) => {
      seen.push(req.url);
      return { text: CSV, headers: { "content-type": "text/csv" } };
    },
  });

  it("saves one month with the default name, account number, size and sha256", async () => {
    const seen: URL[] = [];
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      ...exportRoute(seen),
      "GET /api/v2/accounts/{a}/identifiers": () => ({
        json: { accountIdentifier: "12345678", bankIdentifier: "608371" },
      }),
    });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const res = await client.callTool({ name: "download_monthly_export", arguments: { yearMonth: "2026-10" } });
    const body = JSON.parse(textOf(res));
    expect(seen[0]!.searchParams.get("start")).toBe("2026-10-01");
    expect(seen[0]!.searchParams.get("end")).toBe("2026-10-31");
    expect(body.path).toBe(join(dir, "starling-gbp-personal-12345678-statement-2026-10.csv"));
    expect(body.bytes).toBe(Buffer.byteLength(CSV));
    expect(body.sha256).toBe(createHash("sha256").update(CSV).digest("hex"));
    expect(body.transactions).toBe(1);
    expect(readFileSync(body.path, "utf8")).toBe(CSV);
    expect(statSync(body.path).mode & 0o777).toBe(0o600);
  });

  it("falls back to the first 8 characters of the account UID without account-identifier:read", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      ...exportRoute([]),
      "GET /api/v2/accounts/{a}/identifiers": () => ({
        status: 403,
        json: { errors: [{ message: "INSUFFICIENT_SCOPE" }] },
      }),
    });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const res = await client.callTool({ name: "download_monthly_export", arguments: { yearMonth: "2026-10" } });
    expect(JSON.parse(textOf(res)).path).toBe(
      join(dir, `starling-gbp-personal-${ACCOUNT.slice(0, 8)}-statement-2026-10.csv`),
    );
  });

  it("never overwrites, and refuses saveAs outside the download directory", async () => {
    const { fetchImpl } = fakeStarling({ ...ACCOUNTS_ROUTE, ...exportRoute([]) });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const a = await client.callTool({
      name: "download_monthly_export",
      arguments: { yearMonth: "2026-09", saveAs: "m.csv" },
    });
    const b = await client.callTool({
      name: "download_monthly_export",
      arguments: { yearMonth: "2026-09", saveAs: "m.csv" },
    });
    expect(JSON.parse(textOf(b)).path).toBe(join(dir, "m (1).csv"));
    expect(JSON.parse(textOf(a)).path).toBe(join(dir, "m.csv"));
    const bad = await client.callTool({
      name: "download_monthly_export",
      arguments: { yearMonth: "2026-09", saveAs: "../escape.csv" },
    });
    expect(bad.isError).toBe(true);
    expect(readdirSync(join(dir, ".."))).toEqual(["dl"]);
  });

  it("rejects malformed months before calling Starling", async () => {
    const { fetchImpl, calls } = fakeStarling({ ...ACCOUNTS_ROUTE });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const res = await client.callTool({ name: "download_monthly_export", arguments: { yearMonth: "2026-13" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("export_transactions_csv now reports size and sha256", async () => {
    const { fetchImpl } = fakeStarling({ ...ACCOUNTS_ROUTE, ...exportRoute([]) });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const res = await client.callTool({ name: "export_transactions_csv", arguments: { start: "2026-10-01" } });
    const body = JSON.parse(textOf(res));
    expect(body.bytes).toBe(Buffer.byteLength(CSV));
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
