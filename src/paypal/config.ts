import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The only hosts the PayPal client will talk to. */
export const PAYPAL_BASE_URLS = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
} as const;

export interface PayPalConfig {
  /** Name of this PayPal mirror, e.g. "paypal-business"; names the DB file and default Keychain service. */
  profile: string;
  environment: keyof typeof PAYPAL_BASE_URLS;
  baseUrl: string;
  /** Keychain service holding accounts "client_id" and "client_secret". */
  keychainService: string;
  dbPath: string;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env, profileOverride?: string): PayPalConfig {
  const profile = (profileOverride ?? env.PAYPAL_PROFILE ?? "paypal-business").trim();
  if (!SAFE.test(profile))
    throw new Error(`PayPal profile may only contain letters, digits, ".", "_" and "-": ${profile}`);
  const environment = (env.PAYPAL_ENVIRONMENT ?? "live").trim().toLowerCase();
  if (environment !== "live" && environment !== "sandbox") {
    throw new Error(`PAYPAL_ENVIRONMENT must be "live" or "sandbox", got "${environment}"`);
  }
  const keychainService = (env.PAYPAL_KEYCHAIN_SERVICE ?? `fermium-${profile}`).trim();
  if (!SAFE.test(keychainService)) throw new Error(`Unsafe PAYPAL_KEYCHAIN_SERVICE: ${keychainService}`);
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const dbPath = resolve(
    expand(
      env.PAYPAL_DB_PATH?.trim() ||
        join(
          homedir(),
          ".local",
          "share",
          "starling-mcp",
          `${profile}${environment === "sandbox" ? "-sandbox" : ""}.sqlite`,
        ),
    ),
  );
  return { profile, environment, baseUrl: PAYPAL_BASE_URLS[environment], keychainService, dbPath };
}
