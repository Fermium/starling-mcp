#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StarlingApiError, StarlingClient } from "./client.js";
import { type AccessTier, CONFIG_DIR, type Config, loadConfig, tierAllows } from "./config.js";
import {
  assertPrivateFile,
  deleteToken,
  loadAccessToken,
  readHidden,
  renameToken,
  storeGenericPassword,
  storeToken,
} from "./credentials.js";
import { backupMirror } from "./mirror/backup.js";
import { openMirrorReadOnly } from "./mirror/db.js";
import { sync } from "./mirror/sync.js";
import { OPERATIONS } from "./operations.js";
import { loadPayPalConfig, loadPayPalCredentials, PayPalClient } from "./paypal/client.js";
import { openPayPalDbReadOnly } from "./paypal/db.js";
import { syncPayPal } from "./paypal/sync.js";
import { createServer, registeredToolCount, toolEnabled, VERSION } from "./server.js";
import { loadSigner, type RequestSigner } from "./signing.js";
import { consentNote } from "./tools/accounts.js";
import { ALL_TOOLS } from "./tools/index.js";

const KEY_DIR = join(CONFIG_DIR, "keys");
const log = (msg: string) => process.stderr.write(`${msg}\n`);

function loadSignerIfConfigured(config: Config): RequestSigner | undefined {
  if (!config.signingKeyUid) return undefined;
  if (!existsSync(config.signingKeyPath)) {
    log(
      `starling-mcp: STARLING_SIGNING_KEY_UID is set but ${config.signingKeyPath} does not exist; signed endpoints disabled`,
    );
    return undefined;
  }
  return loadSigner(config.signingKeyUid, config.signingKeyPath);
}

async function makeClient(config: Config) {
  const { token, source } = await loadAccessToken(config);
  return { client: new StarlingClient(config, token, loadSignerIfConfigured(config)), source };
}

async function serve(): Promise<void> {
  const config = loadConfig();
  // The token is loaded on first use, so the server starts (and explains how to add a token) even before one is stored.
  const client = new StarlingClient(
    config,
    async () => (await loadAccessToken(config)).token,
    loadSignerIfConfigured(config),
  );
  const server = createServer(config, client);
  await server.connect(new StdioServerTransport());
  log(
    `starling-mcp ${VERSION}: ${config.environment}${config.profile ? ` (profile ${config.profile})` : ""}, tier=${config.tier}, ${registeredToolCount(config)} tools, ` +
      `signing ${client.canSign ? "on" : "off"}`,
  );
}

function scopesForTier(tier: AccessTier): string[] {
  const config = { tier } as Config;
  const scopes = new Set<string>();
  for (const tool of ALL_TOOLS) {
    if (!tierAllows(config, tool.tier)) continue;
    for (const op of tool.operations) for (const s of OPERATIONS[op]?.scopes ?? []) scopes.add(s);
  }
  return [...scopes].sort();
}

function printScopes(): void {
  let previous = new Set<string>();
  for (const tier of ["read", "write", "payments"] as AccessTier[]) {
    const all = scopesForTier(tier);
    const added = all.filter((s) => !previous.has(s));
    console.log(`\n${tier} tier${tier === "read" ? "" : " adds"} (${added.length}):\n  ${added.join("\n  ")}`);
    previous = new Set(all);
  }
  console.log(
    "\nTick only the scopes for the tier you plan to enable. You can always create a new token with more scopes later.\n" +
      "Starling will not issue a token with payee:create AND payment scopes (pay-local:create, standing-order:create).\n" +
      "Recommended: leave out payee:create and add payees in the Starling app, so the model can only pay payees you approved.",
  );
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  console.log(`Environment:   ${config.environment} (${config.baseUrl})`);
  console.log(`Profile:       ${config.profile ?? "(none)"}  [Keychain account: ${config.keychainAccount}]`);
  console.log(`Downloads:     ${config.downloadDir ?? "disabled (file-saving tools not registered)"}`);
  console.log(`Access tier:   ${config.tier} (${registeredToolCount(config)} tools)`);
  console.log(`Confirmation:  ${config.confirmation}`);
  console.log(`Payment limit: ${config.paymentLimitMinorUnits ?? "none"}`);
  console.log(`Audit log:     ${config.auditLogPath ?? "disabled"}`);

  const { client, source } = await makeClient(config);
  console.log(
    `Token source:  ${source}${source === "environment" ? "  (consider the Keychain: starling-mcp token set)" : ""}`,
  );
  if (config.signingKeyUid) {
    console.log(
      `Signing:       ${client.canSign ? `key ${config.signingKeyUid} from ${config.signingKeyPath}` : "configured but key file missing"}`,
    );
  } else {
    console.log("Signing:       not configured (payments, standing orders, email and address changes need it)");
  }

  const identity = await client.json<{
    scopes?: string[];
    expiresAt?: string;
    consentExpiresAt?: string;
    accountHolderUid?: string;
  }>({
    method: "GET",
    path: "/api/v2/identity/token",
  });
  const granted = new Set(identity.scopes ?? []);
  console.log(`Token expires: ${identity.expiresAt ?? "unknown"}`);
  const note = consentNote(identity.consentExpiresAt);
  if (note) console.log(`Consent:       ${note}`);
  console.log(`Granted scopes (${granted.size}): ${[...granted].sort().join(", ")}`);
  const statementScopes = [...granted].filter((sc) => sc.startsWith("statement-")).sort();
  if (statementScopes.length) {
    console.log(
      `Unused scopes: ${statementScopes.join(", ")}\n` +
        "               Starling's API no longer serves monthly statements (the statement endpoints return 404), so these\n" +
        "               scopes are not used. download_monthly_export saves a month of the CSV export instead (feed-export-csv:read).",
    );
  }
  const writeScopes = [...granted].filter((sc) => !sc.endsWith(":read")).sort();
  if (writeScopes.length) {
    console.log(
      `Write scopes:  ${writeScopes.join(", ")}\n               The server stays read-only unless STARLING_ENABLE_WRITES is set, but a read-only token is safer.`,
    );
  }

  const optional = <T>(path: string) =>
    client.json<T>({ method: "GET", path }).catch((err: unknown) => {
      if (err instanceof StarlingApiError && (err.status === 403 || err.status === 404)) return undefined;
      throw err;
    });
  const holder = await optional<{ accountHolderUid?: string; accountHolderType?: string }>("/api/v2/account-holder");
  const holderName = granted.has("account-holder-name:read")
    ? await optional<{ accountHolderName?: string }>("/api/v2/account-holder/name")
    : undefined;
  const accounts = await client.json<{
    accounts?: { accountUid: string; name: string; currency: string; accountType: string }[];
  }>({ method: "GET", path: "/api/v2/accounts" });

  console.log(
    `\nAccount holder: ${holder?.accountHolderType ?? "type unknown (needs account-holder-type:read or customer:read)"}` +
      `${holderName?.accountHolderName ? `, ${holderName.accountHolderName}` : ""}` +
      `  [uid ${holder?.accountHolderUid ?? identity.accountHolderUid ?? "unknown"}]`,
  );
  const list = accounts.accounts ?? [];
  if (!list.length) console.log("  (no accounts visible: the token needs account:read or account-list:read)");
  for (const a of list) console.log(`  ${a.name} (${a.currency}, ${a.accountType})  accountUid ${a.accountUid}`);
  console.log(
    "\nA Starling token is tied to exactly ONE account holder. Personal, business, sole-trader and joint accounts\n" +
      "are separate account holders, each needing its own token (and its own Developer Portal login). To add another,\n" +
      'store its token under a second profile: starling-mcp token set --profile business (see the README section "Read-only setup for a personal and a business account").',
  );

  const blocked: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!toolEnabled(config, tool)) continue;
    const missing = new Set<string>();
    for (const op of tool.operations) {
      const needed = OPERATIONS[op]?.scopes ?? [];
      if (needed.length && !needed.some((s) => granted.has(s))) for (const s of needed) missing.add(s);
    }
    if (missing.size) blocked.push(`  ${tool.name}: needs ${[...missing].join(" or ")}`);
  }
  console.log(
    blocked.length
      ? `\nTools the token's scopes do not cover (${blocked.length}):\n${blocked.join("\n")}`
      : "\nAll enabled tools are covered by the token's scopes.",
  );
  console.log(`\n${mirrorSummary(config).join("\n")}`);
  for (const line of paypalSummary()) console.log(line);
  console.log(`\nAPI requests used by this check: ${client.requestsToday}`);
}

function mirrorSummary(config: Config): string[] {
  const db = openMirrorReadOnly(config.dbPath);
  if (!db)
    return [
      `Local mirror:  none yet at ${config.dbPath} (create it with: starling-mcp sync${config.profile ? ` --profile ${config.profile}` : ""})`,
    ];
  try {
    const rows = db
      .prepare("SELECT COUNT(*) AS n, MIN(transaction_time) AS a, MAX(transaction_time) AS b FROM feed_items")
      .get() as { n: number; a: string | null; b: string | null };
    const last = db
      .prepare(
        "SELECT finished_at, outcome, api_calls, message FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get() as { finished_at: string; outcome: string; api_calls: number; message: string | null } | undefined;
    const pending = (
      db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE backfill_complete = 0").get() as { n: number }
    ).n;
    const cats = (db.prepare("SELECT COUNT(*) AS n FROM sync_state").get() as { n: number }).n;
    return [
      `Local mirror:  ${config.dbPath}`,
      `               ${rows.n} transactions, ${rows.a?.slice(0, 10) ?? "-"} to ${rows.b?.slice(0, 10) ?? "-"}; ${cats} categories, ${pending ? `${pending} still backfilling` : "history complete"}`,
      `               last sync ${last ? `${last.finished_at} (${last.outcome}, ${last.api_calls} calls)` : "never"}${last?.message ? `: ${last.message}` : ""}`,
    ];
  } finally {
    db.close();
  }
}

async function runSyncCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const profile = config.profile ?? "default";
  const number = (name: string) => {
    const v = optionValue(args, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  const backupDir = optionValue(args, "--backup-dir");
  const { client } = await makeClient(config);
  const verbose = args.includes("--verbose");
  const summary = await sync(client, config.dbPath, {
    profile,
    full: args.includes("--full"),
    dryRun: args.includes("--dry-run"),
    maxRequests: number("--max-requests"),
    dailyLimit: number("--daily-limit"),
    log: verbose ? (line) => console.log(line) : undefined,
  });
  if (summary.outcome === "dry-run") {
    console.log(
      `${profile}: dry run. About ${summary.plannedCalls} API calls needed (${summary.apiCalls} used to plan), ` +
        `${summary.categories || "?"} categories known, ${summary.callsUsedToday} mirror calls used today.`,
    );
    return;
  }
  console.log(
    `${profile}: ${summary.outcome}. ${summary.newItems} new, ${summary.updatedItems} updated, ${summary.totalItems} total transactions ` +
      `(${summary.earliest?.slice(0, 10) ?? "-"} to ${summary.latest?.slice(0, 10) ?? "-"}), ${summary.categories} categories` +
      `${summary.backfillPending ? `, ${summary.backfillPending} still backfilling` : ""}. ` +
      `${summary.apiCalls} API calls (${summary.callsUsedToday} by the mirror today).`,
  );
  if (summary.message) console.log(summary.message);
  if (summary.outcome !== "complete") {
    process.exitCode = 75; // EX_TEMPFAIL: incomplete but resumable
    return;
  }
  if (backupDir) {
    const { path, removed } = backupMirror(config.dbPath, expandPath(backupDir), profile);
    console.log(`Backup written to ${path}${removed.length ? ` (removed ${removed.length} old copies)` : ""}.`);
  }
}

function expandPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function paypalCommand(sub: string | undefined, args: string[]): Promise<void> {
  const config = loadPayPalConfig(process.env, process.env.STARLING_PROFILE);
  if (sub === "token" && args[0] === "set") {
    const clientId = await readHidden(`PayPal ${config.environment} REST app client ID (hidden), then Return: `);
    const clientSecret = await readHidden("Client secret (hidden), then Return: ");
    if (!clientId || !clientSecret) throw new Error("Both the client ID and the secret are needed.");
    const client = new PayPalClient(config, async () => ({ clientId, clientSecret }));
    console.log("Checking them with PayPal…");
    await client.accessToken();
    await storeGenericPassword(config.keychainService, "client_id", `PayPal ${config.profile} client id`, clientId);
    await storeGenericPassword(
      config.keychainService,
      "client_secret",
      `PayPal ${config.profile} client secret`,
      clientSecret,
    );
    console.log(`Credentials OK and saved to the Keychain (service "${config.keychainService}").`);
    return;
  }
  if (sub === "sync") {
    const number = (name: string) => {
      const v = optionValue(args, name);
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
      return n;
    };
    const client = new PayPalClient(config, () => loadPayPalCredentials(config));
    const summary = await syncPayPal(client, config.dbPath, {
      profile: config.profile,
      full: args.includes("--full"),
      maxRequests: number("--max-requests"),
      overlapDays: number("--overlap-days"),
      log: args.includes("--verbose") ? (line) => console.log(line) : undefined,
    });
    console.log(
      `${config.profile}: ${summary.outcome}. ${summary.newItems} new, ${summary.updatedItems} updated, ${summary.totalItems} total transactions ` +
        `(${summary.earliest?.slice(0, 10) ?? "-"} to ${summary.latest?.slice(0, 10) ?? "-"})` +
        `${summary.backfillComplete ? "" : ", history still backfilling"}. ${summary.apiCalls} API calls` +
        `${summary.dataRefreshedAt ? `; PayPal data refreshed ${summary.dataRefreshedAt}` : ""}.`,
    );
    if (summary.message) console.log(summary.message);
    if (summary.outcome !== "complete") {
      process.exitCode = 75;
      return;
    }
    const backupDir = optionValue(args, "--backup-dir");
    if (backupDir) {
      const { path, removed } = backupMirror(config.dbPath, expandPath(backupDir), config.profile);
      console.log(`Backup written to ${path}${removed.length ? ` (removed ${removed.length} old copies)` : ""}.`);
    }
    return;
  }
  throw new Error(
    "Usage: starling-mcp paypal sync --profile <name> [--full] [--backup-dir <dir>] | paypal token set --profile <name>",
  );
}

function paypalSummary(): string[] {
  const profile = process.env.PAYPAL_PROFILE?.trim();
  if (!profile) return [];
  const config = loadPayPalConfig(process.env);
  const db = openPayPalDbReadOnly(config.dbPath);
  if (!db)
    return [`PayPal mirror: none yet at ${config.dbPath} (starling-mcp paypal sync --profile ${config.profile})`];
  try {
    const r = db
      .prepare("SELECT COUNT(*) AS n, MIN(initiation_date) AS a, MAX(initiation_date) AS b FROM transactions")
      .get() as { n: number; a: string | null; b: string | null };
    const last = db
      .prepare("SELECT finished_at, outcome FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { finished_at: string; outcome: string } | undefined;
    return [
      `PayPal mirror: ${config.dbPath} (${config.environment}, Keychain service "${config.keychainService}")`,
      `               ${r.n} transactions, ${r.a?.slice(0, 10) ?? "-"} to ${r.b?.slice(0, 10) ?? "-"}; last sync ${last ? `${last.finished_at} (${last.outcome})` : "never"}`,
    ];
  } finally {
    db.close();
  }
}

async function generateKeys(force: boolean): Promise<void> {
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  for (const name of ["api", "rotation"]) {
    const priv = join(KEY_DIR, `starling-${name}-private.key`);
    const pub = join(KEY_DIR, `starling-${name}-public.key`);
    if (existsSync(priv) && !force) {
      console.log(`${priv} already exists; keeping it (use --force to replace).`);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      await writeFile(priv, privateKey, { mode: 0o600, flag: force ? "w" : "wx" });
      await writeFile(pub, publicKey, { mode: 0o644 });
    }
    console.log(`\n${name.toUpperCase()} public key (${pub}):\n${readFileSync(pub, "utf8")}`);
  }
  console.log(
    "Upload both PUBLIC keys in the Starling Developer Portal (Personal Access → Keys), production environment.\n" +
      "Then set STARLING_SIGNING_KEY_UID to the API key's UID shown in the portal. Private keys never leave this machine.",
  );
}

/** Signs a new public API key with the rotation key, for uploading during key rotation. */
function rotationSignature(newPublicKeyPath: string, keyId: string): void {
  const rotationKey = join(KEY_DIR, "starling-rotation-private.key");
  assertPrivateFile(rotationKey);
  const body = createPublicKey(readFileSync(newPublicKeyPath))
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const date = new Date().toISOString();
  const digest = createHash("sha512").update(body).digest("base64");
  const signature = createSign("SHA512")
    .update(`Date: ${date}\nDigest: ${digest}`)
    .sign(createPrivateKey(readFileSync(rotationKey)), "base64");
  console.log(`Signature timestamp (upload within 5 minutes): ${date}`);
  console.log(
    `Signature: Signature keyid="${keyId}",algorithm="rsa-sha512",headers="Date Digest",signature="${signature}"`,
  );
}

function usage(): void {
  console.log(`starling-mcp ${VERSION} — privacy-first MCP server for the Starling Bank API

Usage:
  starling-mcp                         Run the MCP server on stdio (what MCP clients launch)
  starling-mcp token set [--sandbox] [--profile <name>]
                                       Check a personal access token and store it in the macOS Keychain (hidden prompt,
                                       or pipe it: pbpaste | starling-mcp token set --profile personal)
  starling-mcp token delete [--sandbox] [--profile <name>]
  starling-mcp token rename --from <profile> --to <profile> [--sandbox] [--keep] [--force]
                                       Move a stored token to another profile name without re-entering it
                                       (e.g. --from personal --to business). "token copy" keeps the original.
  starling-mcp doctor [--profile <name>]
                                       Check configuration, token scopes and account access
  starling-mcp sync [--profile <name>] [--full] [--dry-run] [--backup-dir <dir>] [--max-requests N] [--verbose]
                                       Update the local SQLite mirror (read-only API calls). First run backfills all history;
                                       later runs are incremental. Exit code 75 = stopped early (budget), run again to resume.
  starling-mcp paypal sync --profile <name> [--full] [--backup-dir <dir>] [--max-requests N] [--overlap-days N]
                                       Read-only mirror of a PayPal business account (Transaction Search API)
  starling-mcp paypal token set --profile <name>
                                       Store a PayPal REST app's client ID and secret in the Keychain (hidden input)
  starling-mcp scopes                  List the token scopes each access tier needs
  starling-mcp keys generate [--force] Create request-signing key pairs in ${KEY_DIR}
  starling-mcp keys rotation-signature <new-public-key.pem> <rotation-key-uid>

--profile <name> is the same as STARLING_PROFILE=<name>: one Keychain item (and download folder) per
Starling login, so personal and business accounts can run as two MCP server entries.
Configuration is by environment variable; see README.md.`);
}

function optionValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(args: string[]): Promise<void> {
  let argv = args;
  const profileAt = argv.indexOf("--profile");
  if (profileAt >= 0) {
    const name = argv[profileAt + 1];
    if (!name || name.startsWith("--")) throw new Error("--profile needs a name, e.g. --profile business");
    process.env.STARLING_PROFILE = name;
    argv = [...argv.slice(0, profileAt), ...argv.slice(profileAt + 2)];
  }
  if (argv.includes("--sandbox")) process.env.STARLING_ENVIRONMENT = "sandbox";
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "serve":
      return serve();
    case "token":
      if (sub === "set") {
        const config = loadConfig();
        const who = `${config.environment}${config.profile ? ` "${config.profile}"` : ""}`;
        const token = await readHidden(
          `Paste your Starling ${who} personal access token (hidden), then press Return: `,
        );
        if (!token) throw new Error("No token entered.");
        console.log(`Received ${token.length} characters. Checking it with Starling…`);
        const client = new StarlingClient(config, token, undefined);
        const id = await client.json<{ scopes?: string[]; expiresAt?: string }>({
          method: "GET",
          path: "/api/v2/identity/token",
        });
        await storeToken(config, token);
        console.log(
          `Token OK and saved to the macOS Keychain (account "${config.keychainAccount}"). ${id.scopes?.length ?? 0} scopes granted; expires ${id.expiresAt ?? "never"}.`,
        );
        const writeScopes = (id.scopes ?? []).filter((sc) => /:(create|edit|delete|write)$/.test(sc));
        if (writeScopes.length) {
          console.log(
            `Note: this token also has write scopes (${writeScopes.join(", ")}). For read-only use, create a token with only :read scopes.`,
          );
        }
        if (!process.stdin.isTTY) console.log("If you piped it from the clipboard, clear it with: pbcopy < /dev/null");
        return;
      }
      if (sub === "rename" || sub === "copy") {
        const from = optionValue(rest, "--from");
        const to = optionValue(rest, "--to");
        if (!from || !to)
          throw new Error(`Usage: starling-mcp token ${sub} --from <profile> --to <profile> [--sandbox]`);
        const fromConfig = loadConfig({ ...process.env, STARLING_PROFILE: from, STARLING_KEYCHAIN_ACCOUNT: "" });
        const toConfig = loadConfig({ ...process.env, STARLING_PROFILE: to, STARLING_KEYCHAIN_ACCOUNT: "" });
        const { removedOld } = await renameToken(fromConfig, toConfig, {
          keep: sub === "copy" || rest.includes("--keep"),
          force: rest.includes("--force"),
        });
        console.log(
          `Token ${removedOld ? "moved" : "copied"} from Keychain account "${fromConfig.keychainAccount}" to "${toConfig.keychainAccount}". ` +
            `Use STARLING_PROFILE=${to} (or --profile ${to}) from now on.`,
        );
        return;
      }
      if (sub === "delete") {
        const config = loadConfig();
        console.log(
          (await deleteToken(config))
            ? `Token removed from the Keychain (account "${config.keychainAccount}").`
            : `No token found in the Keychain under account "${config.keychainAccount}".`,
        );
        return;
      }
      break;
    case "doctor":
      return doctor();
    case "paypal":
      return paypalCommand(sub, rest);
    case "sync":
      return runSyncCommand([sub, ...rest].filter((x): x is string => x !== undefined));
    case "scopes":
      return printScopes();
    case "keys":
      if (sub === "generate") return generateKeys(rest.includes("--force"));
      if (sub === "rotation-signature" && rest[0] && rest[1]) return rotationSignature(rest[0], rest[1]);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      return usage();
  }
  usage();
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  log(`starling-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
