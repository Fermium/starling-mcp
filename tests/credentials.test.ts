import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadAccessToken } from "../src/credentials.js";

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
