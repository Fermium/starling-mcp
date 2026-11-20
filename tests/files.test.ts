import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { plainFileName, saveDownload, serverFileName } from "../src/files.js";
import { ACCOUNT, ACCOUNTS_ROUTE, CATEGORY, connect, fakeStarling, testConfig, textOf } from "./helpers.js";

let root: string;
let dir: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "starling-files-")));
  dir = join(root, "downloads");
  outside = join(root, "outside");
  mkdirSync(outside);
});

describe("saveDownload", () => {
  it("saves plain names in the download directory with 0600 and never overwrites", async () => {
    const a = await saveDownload(dir, "export.csv", "one");
    const b = await saveDownload(dir, "export.csv", "two");
    expect(a).toBe(join(dir, "export.csv"));
    expect(b).toBe(join(dir, "export (1).csv"));
    expect(readFileSync(a, "utf8")).toBe("one");
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("accepts an absolute path only when its folder is the download directory", async () => {
    mkdirSync(dir, { recursive: true });
    expect(await saveDownload(dir, join(dir, "x.csv"), "ok")).toBe(join(dir, "x.csv"));
    await expect(saveDownload(dir, join(outside, "x.csv"), "no")).rejects.toThrow(/only be saved directly/);
    await expect(saveDownload(dir, "/etc/passwd", "no")).rejects.toThrow(/only be saved directly/);
    await expect(saveDownload(dir, join(dir, "sub", "x.csv"), "no")).rejects.toThrow(/only be saved directly/);
    await expect(saveDownload(dir, "~/x.csv", "no")).rejects.toThrow(/only be saved directly/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each(["../x.csv", "..", ".", "sub/x.csv", "a\\b.csv", ".bashrc", "x\u0000.csv", "x\n.csv", "", "a".repeat(300)])(
    "rejects unsafe name %j",
    async (name) => {
      await expect(saveDownload(dir, name, "no")).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it("rejects absolute paths that escape with ..", async () => {
    mkdirSync(dir, { recursive: true });
    await expect(saveDownload(dir, join(dir, "..", "outside", "x.csv"), "no")).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not follow a symlink planted at the target name", async () => {
    mkdirSync(dir, { recursive: true });
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "original");
    symlinkSync(victim, join(dir, "report.csv"));
    const saved = await saveDownload(dir, "report.csv", "attacker");
    expect(saved).toBe(join(dir, "report (1).csv"));
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("does not follow a symlinked folder inside the download directory", async () => {
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "link"));
    await expect(saveDownload(dir, join(dir, "link", "x.csv"), "no")).rejects.toThrow(/only be saved directly/);
    await expect(saveDownload(dir, "link/x.csv", "no")).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses everything when downloads are disabled", async () => {
    await expect(saveDownload(undefined, "x.csv", "no")).rejects.toThrow(/STARLING_DOWNLOAD_DIR/);
  });
});

describe("server-supplied file names", () => {
  it("uses only plain names and falls back otherwise", () => {
    expect(serverFileName("receipt.pdf", "fallback.pdf")).toBe("receipt.pdf");
    expect(serverFileName("../../.ssh/authorized_keys", "fallback.pdf")).toBe("fallback.pdf");
    expect(serverFileName("/etc/cron.d/x", "fallback.pdf")).toBe("fallback.pdf");
    expect(serverFileName("..\\x.exe", "fallback.pdf")).toBe("fallback.pdf");
    expect(serverFileName(".hidden", "fallback.pdf")).toBe("fallback.pdf");
    expect(serverFileName(undefined, "fallback.pdf")).toBe("fallback.pdf");
    expect(plainFileName("Invoice 2026-01.pdf")).toBe("Invoice 2026-01.pdf");
  });

  it("download_transaction_attachment ignores a hostile Content-Disposition name", async () => {
    const ATT = "55555555-5555-4555-8555-555555555555";
    const ITEM = "66666666-6666-4666-8666-666666666666";
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      "GET /api/v2/feed/account/{a}/category/{c}/{f}/attachments/{x}": () => ({
        text: "%PDF-1.4",
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="..%2F..%2Foutside%2Fpwned.pdf"',
        },
      }),
    });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const res = await client.callTool({
      name: "download_transaction_attachment",
      arguments: { accountUid: ACCOUNT, categoryUid: CATEGORY, feedItemUid: ITEM, feedItemAttachmentUid: ATT },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(join(dir, `attachment-${ATT}.pdf`));
    expect(readdirSync(outside)).toEqual([]);
  });

  it("export_transactions_csv refuses a saveAs outside the download directory", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      "GET /api/v2/accounts/{a}/feed-export": () => ({ text: "Date,Amount\n2026-01-01,1\n" }),
    });
    const client = await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fetchImpl);
    const bad = await client.callTool({
      name: "export_transactions_csv",
      arguments: { start: "2026-01-01", saveAs: join(outside, "x.csv") },
    });
    expect(bad.isError).toBe(true);
    const ok = await client.callTool({ name: "export_transactions_csv", arguments: { start: "2026-01-01" } });
    expect(textOf(ok)).toContain(join(dir, "starling-2026-01-01-to-today.csv"));
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not register file-saving tools when downloads are off", async () => {
    const on = (
      await (await connect(testConfig({ STARLING_DOWNLOAD_DIR: dir }), fakeStarling({}).fetchImpl)).listTools()
    ).tools;
    const off = (
      await (await connect(testConfig({ STARLING_DOWNLOAD_DIR: "off" }), fakeStarling({}).fetchImpl)).listTools()
    ).tools;
    const offNames = off.map((t) => t.name);
    expect(on.length - off.length).toBe(2);
    expect(offNames).not.toContain("export_transactions_csv");
    expect(offNames).not.toContain("download_transaction_attachment");
    expect(offNames).toContain("get_profile_image");
  });
});
