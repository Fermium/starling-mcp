import { readGenericPassword } from "../credentials.js";
import type { PayPalConfig } from "./config.js";

export { loadPayPalConfig, PAYPAL_BASE_URLS, type PayPalConfig } from "./config.js";

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

/** Reads the REST app's client id and secret from the Keychain (never printed). */
export async function loadPayPalCredentials(
  config: PayPalConfig,
  read: (service: string, account: string) => Promise<string | undefined> = readGenericPassword,
): Promise<PayPalCredentials> {
  const clientId = await read(config.keychainService, "client_id");
  const clientSecret = await read(config.keychainService, "client_secret");
  if (!clientId || !clientSecret) {
    throw new Error(
      `PayPal credentials not found in the Keychain (service "${config.keychainService}", accounts "client_id" and "client_secret"). ` +
        `Store them with: starling-mcp paypal token set --profile ${config.profile}`,
    );
  }
  return { clientId, clientSecret };
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PayPalRateLimited extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal read-only PayPal REST client: OAuth2 client credentials (token cached until shortly before it expires),
 * GETs only, hard-coded host, redirects refused, 429s retried with backoff.
 */
export class PayPalClient {
  private token: { value: string; expiresAt: number } | undefined;
  private lastRequest = 0;
  requests = 0;

  constructor(
    private readonly config: PayPalConfig,
    private readonly credentials: () => Promise<PayPalCredentials>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: {
      minIntervalMs?: number;
      maxRetries?: number;
      wait?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private async pace(): Promise<void> {
    const gap = (this.options.minIntervalMs ?? 250) - (Date.now() - this.lastRequest);
    if (gap > 0) await (this.options.wait ?? sleep)(gap);
    this.lastRequest = Date.now();
  }

  /** Fetches (or reuses) an access token. The secret is only ever sent in the Authorization header. */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const { clientId, clientSecret } = await this.credentials();
    await this.pace();
    this.requests++;
    const res = await this.fetchImpl(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      scope?: string;
    };
    if (!res.ok || !body.access_token) {
      // Only PayPal's error code is shown: never the request, which carries the credentials.
      throw new PayPalApiError(
        res.status,
        `PayPal rejected the app credentials (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}). ` +
          `Check the client id/secret in Keychain service "${this.config.keychainService}" and that the app is ${this.config.environment}.`,
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 300) - 120) * 1000,
    };
    return body.access_token;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    if (!path.startsWith("/v1/reporting/")) throw new Error(`Refusing non-reporting PayPal path ${path}`);
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const maxRetries = this.options.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      await this.pace();
      this.requests++;
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => "");
      if (res.status === 401 && attempt === 0) {
        this.token = undefined; // expired early: fetch a new token once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        if (delay > 120_000) break;
        await (this.options.wait ?? sleep)(delay);
        continue;
      }
      if (res.status === 429) throw new PayPalRateLimited("PayPal kept returning 429 (rate limited)");
      let detail = "";
      try {
        const err = JSON.parse(text) as {
          name?: string;
          message?: string;
          details?: { issue?: string; description?: string }[];
        };
        detail = [err.name, err.message, ...(err.details ?? []).map((d) => d.issue ?? d.description)]
          .filter(Boolean)
          .join(": ");
      } catch {
        detail = text.slice(0, 200);
      }
      throw new PayPalApiError(res.status, `PayPal ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    throw new PayPalRateLimited("PayPal asked to wait more than 2 minutes (429)");
  }
}
