import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadAccessToken, renameToken } from "../src/credentials.js";

const dir = mkdtempSync(join(tmpdir(), "starling-cred-"));
function tokenFile(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** A fake Keychain, so tests never touch the real one (and mean something on Linux CI). */
function fakeKeychain(items: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    read: async (account: string) => {
      asked.push(account);
      return items[account];
    },
  };
}

describe("profiles and Keychain accounts", () => {
  it("derives the Keychain account from environment and profile", () => {
    expect(loadConfig({}).keychainAccount).toBe("access-token-production");
    expect(loadConfig({ STARLING_PROFILE: "business" }).keychainAccount).toBe("access-token-production-business");
    expect(loadConfig({ STARLING_PROFILE: "personal", STARLING_ENVIRONMENT: "sandbox" }).keychainAccount).toBe(
      "access-token-sandbox-personal",
    );
    expect(loadConfig({ STARLING_KEYCHAIN_ACCOUNT: "my-item" }).keychainAccount).toBe("my-item");
  });

  it.each(["a b", 'x" -w "y', "x;rm", "-flag", "../x", "a\nb"])("rejects unsafe profile %j", (profile) => {
    expect(() => loadConfig({ STARLING_PROFILE: profile })).toThrow(/STARLING_PROFILE/);
    expect(() => loadConfig({ STARLING_KEYCHAIN_ACCOUNT: profile })).toThrow(/STARLING_KEYCHAIN_ACCOUNT/);
  });

  it("gives each profile its own download folder, and can turn downloads off", () => {
    expect(loadConfig({ STARLING_PROFILE: "business" }).downloadDir).toMatch(/Downloads\/starling-mcp\/business$/);
    expect(loadConfig({}).downloadDir).toMatch(/Downloads\/starling-mcp\/default$/);
    expect(loadConfig({ STARLING_DOWNLOAD_DIR: "off" }).downloadDir).toBeUndefined();
  });
});

describe("loadAccessToken", () => {
  const config = loadConfig({ STARLING_PROFILE: "business" });

  it("prefers an explicit token file over the Keychain", async () => {
    const kc = fakeKeychain({ "access-token-production-business": "from-keychain" });
    const file = tokenFile("ok", "from-file\n");
    expect(await loadAccessToken(config, { STARLING_ACCESS_TOKEN_FILE: file }, kc.read)).toEqual({
      token: "from-file",
      source: "file",
    });
    expect(kc.asked).toEqual([]);
  });

  it("prefers STARLING_ACCESS_TOKEN over the Keychain", async () => {
    const kc = fakeKeychain({ "access-token-production-business": "from-keychain" });
    expect((await loadAccessToken(config, { STARLING_ACCESS_TOKEN: "from-env" }, kc.read)).source).toBe("environment");
  });

  it("uses only the profile's Keychain item, never the default one", async () => {
    const kc = fakeKeychain({ "access-token-production": "personal-token" });
    await expect(loadAccessToken(config, {}, kc.read)).rejects.toThrow(/profile "business".*--profile business/);
    expect(kc.asked).toEqual(["access-token-production-business"]);

    const both = fakeKeychain({ "access-token-production": "p", "access-token-production-business": "b" });
    expect((await loadAccessToken(config, {}, both.read)).token).toBe("b");
  });

  it("fails instead of falling through when the token file is unusable", async () => {
    const kc = fakeKeychain({ "access-token-production-business": "from-keychain" });
    await expect(
      loadAccessToken(config, { STARLING_ACCESS_TOKEN_FILE: join(dir, "missing") }, kc.read),
    ).rejects.toThrow();
    await expect(
      loadAccessToken(config, { STARLING_ACCESS_TOKEN_FILE: tokenFile("empty", "  \n") }, kc.read),
    ).rejects.toThrow(/empty/);
    if (process.platform !== "win32") {
      await expect(
        loadAccessToken(config, { STARLING_ACCESS_TOKEN_FILE: tokenFile("open", "t", 0o644) }, kc.read),
      ).rejects.toThrow(/chmod 600/);
    }
    expect(kc.asked).toEqual([]);
  });
});

describe("renameToken", () => {
  function memoryKeychain(items: Record<string, string>) {
    return {
      items,
      read: async (a: string) => items[a],
      store: async (w: { keychainAccount: string }, t: string) => {
        items[w.keychainAccount] = t;
      },
      remove: async (w: { keychainAccount: string }) => delete items[w.keychainAccount],
    };
  }
  const personal = loadConfig({ STARLING_PROFILE: "personal" });
  const main = loadConfig({ STARLING_PROFILE: "main" });

  it("moves a token to a new profile and removes the old item", async () => {
    const kc = memoryKeychain({ "access-token-production-personal": "tok" });
    expect(await renameToken(personal, main, {}, kc)).toEqual({ removedOld: true });
    expect(kc.items).toEqual({ "access-token-production-main": "tok" });
  });

  it("copies with keep, and refuses to overwrite without force", async () => {
    const kc = memoryKeychain({ "access-token-production-personal": "tok", "access-token-production-main": "other" });
    await expect(renameToken(personal, main, {}, kc)).rejects.toThrow(/already stored.*--force/);
    expect(kc.items["access-token-production-main"]).toBe("other");
    await renameToken(personal, main, { keep: true, force: true }, kc);
    expect(kc.items).toEqual({ "access-token-production-personal": "tok", "access-token-production-main": "tok" });
  });

  it("fails cleanly when there is nothing to move, and never puts the token in errors", async () => {
    const kc = memoryKeychain({});
    await expect(renameToken(personal, main, {}, kc)).rejects.toThrow(/No token found.*personal/);
    const broken = { ...memoryKeychain({ "access-token-production-personal": "secret-tok" }), store: async () => {} };
    const err = await renameToken(personal, main, {}, broken).catch((e: Error) => e);
    expect(String(err)).toMatch(/original was left in place/);
    expect(String(err)).not.toContain("secret-tok");
    expect(await broken.read("access-token-production-personal")).toBe("secret-tok");
  });

  it("refuses the same source and destination", async () => {
    await expect(renameToken(main, main, {}, memoryKeychain({}))).rejects.toThrow(/both the source/);
  });
});
