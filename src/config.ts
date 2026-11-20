import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Environment = "production" | "sandbox";

/** Which tools are registered. Each tier includes the ones before it. */
export type AccessTier = "read" | "write" | "payments";

export interface Config {
  environment: Environment;
  baseUrl: string;
  tier: AccessTier;
  /** Largest single external payment / standing order amount allowed, in minor units. */
  paymentLimitMinorUnits: number | undefined;
  /** How dangerous calls are confirmed. */
  confirmation: "auto" | "elicit" | "token";
  signingKeyUid: string | undefined;
  signingKeyPath: string;
  auditLogPath: string | undefined;
  /** The only directory tools may write files into; undefined disables file-writing tools. */
  downloadDir: string | undefined;
  /** Optional name for this server entry (e.g. "personal", "business"); selects its own Keychain item. */
  profile: string | undefined;
  /** Keychain account name the token is stored under. */
  keychainAccount: string;
  /** SQLite file of the local mirror (see `starling-mcp sync`). */
  dbPath: string;
  requestsPerSecond: number;
  defaultAccountUid: string | undefined;
}

/** The only hosts this server will ever talk to. */
export const BASE_URLS: Record<Environment, string> = {
  production: "https://api.starlingbank.com",
  sandbox: "https://api-sandbox.starlingbank.com",
};

export const CONFIG_DIR = join(homedir(), ".config", "starling-mcp");
export const STATE_DIR = join(homedir(), ".local", "state", "starling-mcp");
export const KEYCHAIN_SERVICE = "starling-mcp";

function flag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Profile and Keychain account names end up in a command written to
 * `security -i`, so they are restricted to a safe character set.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function safeName(variable: string, value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!SAFE_NAME.test(v)) {
    throw new Error(`${variable} may only contain letters, digits, ".", "_" and "-" (max 64), got "${v}"`);
  }
  return v;
}

/** Keychain account for a token: access-token-<environment>[-<profile>]. */
export function defaultKeychainAccount(environment: Environment, profile?: string): string {
  return profile ? `access-token-${environment}-${profile}` : `access-token-${environment}`;
}

const OFF = ["off", "false", "0", "none", "disabled"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = (env.STARLING_ENVIRONMENT ?? "production").toLowerCase();
  if (environment !== "production" && environment !== "sandbox") {
    throw new Error(`STARLING_ENVIRONMENT must be "production" or "sandbox", got "${environment}"`);
  }

  let tier: AccessTier = "read";
  if (flag(env.STARLING_ENABLE_WRITES)) tier = "write";
  if (flag(env.STARLING_ENABLE_PAYMENTS)) {
    if (tier !== "write") {
      throw new Error("STARLING_ENABLE_PAYMENTS requires STARLING_ENABLE_WRITES=true as well");
    }
    tier = "payments";
  }

  let paymentLimitMinorUnits: number | undefined;
  if (env.STARLING_PAYMENT_LIMIT_MINOR_UNITS) {
    paymentLimitMinorUnits = Number(env.STARLING_PAYMENT_LIMIT_MINOR_UNITS);
    if (!Number.isSafeInteger(paymentLimitMinorUnits) || paymentLimitMinorUnits < 0) {
      throw new Error("STARLING_PAYMENT_LIMIT_MINOR_UNITS must be a non-negative integer (e.g. 50000 for £500)");
    }
  }

  const confirmation = (env.STARLING_CONFIRMATION ?? "auto").toLowerCase();
  if (confirmation !== "auto" && confirmation !== "elicit" && confirmation !== "token") {
    throw new Error(`STARLING_CONFIRMATION must be "auto", "elicit" or "token", got "${confirmation}"`);
  }

  const audit = env.STARLING_AUDIT_LOG?.trim();
  const auditLogPath =
    audit && OFF.includes(audit.toLowerCase()) ? undefined : expandHome(audit || join(STATE_DIR, "audit.log"));

  const requestsPerSecond = Number(env.STARLING_REQUESTS_PER_SECOND ?? 5);
  if (!(requestsPerSecond > 0)) throw new Error("STARLING_REQUESTS_PER_SECOND must be positive");

  const profile = safeName("STARLING_PROFILE", env.STARLING_PROFILE);
  const keychainAccount =
    safeName("STARLING_KEYCHAIN_ACCOUNT", env.STARLING_KEYCHAIN_ACCOUNT) ??
    defaultKeychainAccount(environment, profile);

  // Downloads go to one directory only. Each profile gets its own subfolder by default,
  // so personal and business files never mix. "off" disables every tool that writes files.
  const download = env.STARLING_DOWNLOAD_DIR?.trim();
  const downloadDir =
    download && OFF.includes(download.toLowerCase())
      ? undefined
      : resolve(expandHome(download || join(homedir(), "Downloads", "starling-mcp", profile ?? "default")));

  const dbPath = resolve(
    expandHome(
      env.STARLING_DB_PATH?.trim() ||
        join(
          homedir(),
          ".local",
          "share",
          "starling-mcp",
          `${profile ?? "default"}${environment === "sandbox" ? "-sandbox" : ""}.sqlite`,
        ),
    ),
  );

  return {
    environment,
    baseUrl: BASE_URLS[environment],
    tier,
    paymentLimitMinorUnits,
    confirmation,
    signingKeyUid: env.STARLING_SIGNING_KEY_UID?.trim() || undefined,
    signingKeyPath: expandHome(env.STARLING_SIGNING_KEY_PATH ?? join(CONFIG_DIR, "keys", "starling-api-private.key")),
    auditLogPath,
    downloadDir,
    profile,
    keychainAccount,
    dbPath,
    requestsPerSecond,
    defaultAccountUid: env.STARLING_DEFAULT_ACCOUNT_UID?.trim() || undefined,
  };
}

export function tierAllows(config: Config, required: AccessTier): boolean {
  const order: AccessTier[] = ["read", "write", "payments"];
  return order.indexOf(config.tier) >= order.indexOf(required);
}
