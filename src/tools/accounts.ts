import { z } from "zod";
import { StarlingApiError } from "../client.js";
import { fileFacts, saveDownload, slug } from "../files.js";
import { formatMoney } from "../money.js";
import { accountUid, date, minorUnits } from "./schemas.js";
import { defineTool, json, type ToolContext, text } from "./types.js";

type Signed = { currency: string; minorUnits: number };

/** Starling consent lasts 90 days; afterwards only balances and the last 90 days of transactions are available. */
export function consentNote(consentExpiresAt: string | undefined, now = Date.now()): string | undefined {
  if (!consentExpiresAt) return undefined;
  const days = Math.floor((Date.parse(consentExpiresAt) - now) / 86400_000);
  if (days < 0) {
    return `Consent expired on ${consentExpiresAt.slice(0, 10)}: Starling now limits data to balances and the last 90 days of transactions. Re-confirm access in the Developer Portal to restore full history.`;
  }
  return `Consent valid until ${consentExpiresAt.slice(0, 10)} (${days} days). After that, data is limited to the last 90 days until access is re-confirmed in the Developer Portal.`;
}

export const accountTools = [
  defineTool({
    name: "get_server_status",
    title: "Server status",
    description:
      "Shows how this Starling MCP server is configured: environment, enabled access tier, whether request signing is set up, how confirmations work, and how many API requests it has made today (personal tokens allow 1,000/day). Makes no API calls.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json({
        environment: ctx.config.environment,
        apiBaseUrl: ctx.config.baseUrl,
        accessTier: ctx.config.tier,
        writesEnabled: ctx.config.tier !== "read",
        paymentsEnabled: ctx.config.tier === "payments",
        paymentLimit:
          ctx.config.paymentLimitMinorUnits === undefined
            ? "none"
            : `${ctx.config.paymentLimitMinorUnits} minor units per payment`,
        requestSigningConfigured: ctx.client.canSign,
        confirmationMode: ctx.confirmer.mode,
        clientSupportsElicitation: ctx.confirmer.elicitationSupported(),
        auditLog: ctx.config.auditLogPath ?? "disabled",
        profile: ctx.config.profile ?? "default",
        keychainAccount: ctx.config.keychainAccount,
        tokenFrom: process.env.STARLING_ACCESS_TOKEN_FILE?.trim()
          ? "STARLING_ACCESS_TOKEN_FILE"
          : process.env.STARLING_ACCESS_TOKEN?.trim()
            ? "STARLING_ACCESS_TOKEN"
            : "keychain",
        downloadDirectory: ctx.config.downloadDir ?? "disabled (STARLING_DOWNLOAD_DIR=off)",
        requestsMadeTodayByThisProcess: ctx.client.requestsToday,
      });
    },
  }),

  defineTool({
    name: "get_token_identity",
    title: "Token identity and scopes",
    description:
      "Returns the access token's granted OAuth scopes, expiry, consent expiry and account holder UID. Use this to diagnose 403 errors (missing scope).",
    tier: "read",
    operations: ["getTokenIdentity"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      const id = await ctx.client.json<{ consentExpiresAt?: string }>({
        method: "GET",
        path: "/api/v2/identity/token",
      });
      return json({ ...id, consentNote: consentNote(id?.consentExpiresAt) });
    },
  }),

  defineTool({
    name: "get_authorising_individual",
    title: "Authorising individual",
    description: "Returns the person who authorised this token (name, date of birth, email, phone).",
    tier: "read",
    operations: ["getAuthorisingIndividual"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json(await ctx.client.json({ method: "GET", path: "/api/v2/identity/individual" }));
    },
  }),

  defineTool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "Lists the accounts this token can access, with accountUid, accountType, currency, name and defaultCategory (the category UID of the main balance, needed by feed and payment endpoints).",
    tier: "read",
    operations: ["getAccounts"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json({ accounts: await ctx.accounts.list(true) });
    },
  }),

  defineTool({
    name: "get_account_balance",
    title: "Account balance",
    description:
      "Gets an account's balance. clearedBalance = settled transactions only; effectiveBalance = including pending outgoing (what the app shows). The total* fields include all spaces and savings goals. Amounts are in minor units; a formatted summary is included.",
    tier: "read",
    operations: ["getAccountBalance"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      const balance = await ctx.client.json<Record<string, Signed | undefined>>({
        method: "GET",
        path: "/api/v2/accounts/{accountUid}/balance",
        params: { accountUid: account.accountUid },
      });
      const formatted: Record<string, string> = {};
      for (const [k, v] of Object.entries(balance ?? {})) {
        if (v && typeof v.minorUnits === "number") formatted[k] = formatMoney(v.minorUnits, v.currency);
      }
      return json({ accountUid: account.accountUid, formatted, raw: balance });
    },
  }),

  defineTool({
    name: "get_account_identifiers",
    title: "Account identifiers",
    description: "Gets the account's sort code and account number, plus IBAN and BIC (and any other identifiers).",
    tier: "read",
    operations: ["getAccountIdentifiers"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/accounts/{accountUid}/identifiers",
          params: { accountUid: account.accountUid },
        }),
      );
    },
  }),

  defineTool({
    name: "check_funds",
    title: "Confirmation of funds",
    description:
      "Checks whether the account has enough available money for a payment of the given amount, taking the overdraft into account.",
    tier: "read",
    operations: ["getConfirmationOfFunds"],
    readOnly: true,
    input: { accountUid, amountMinorUnits: minorUnits("Amount to check") },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/accounts/{accountUid}/confirmation-of-funds",
          params: { accountUid: account.accountUid },
          query: { targetAmountInMinorUnits: args.amountMinorUnits },
        }),
      );
    },
  }),

  defineTool({
    name: "export_transactions_csv",
    title: "Export statement CSV",
    description:
      "Downloads Starling's CSV export of all settled transactions on the main account between two dates (the same export as the app). Saves it to a file with owner-only permissions and returns the path; set inline=true to also return the CSV text.",
    tier: "read",
    operations: ["downloadCSVFeedExportForDateRange"],
    readOnly: true,
    writesFiles: true,
    input: {
      accountUid,
      start: date("First day to include"),
      end: date("Last day to include").optional(),
      saveAs: z
        .string()
        .optional()
        .describe("Plain file name (no folders). Always saved in the download directory; see get_server_status"),
      inline: z.boolean().optional().describe("Also return the CSV contents in the response (default false)"),
    },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      const csv = await ctx.client.text({
        method: "GET",
        path: "/api/v2/accounts/{accountUid}/feed-export",
        params: { accountUid: account.accountUid },
        query: { start: args.start, end: args.end },
        accept: "text/csv",
      });
      const name = args.saveAs ?? `starling-${args.start}-to-${args.end ?? "today"}.csv`;
      const path = await saveDownload(ctx.config.downloadDir, name, csv);
      const facts = { ...fileFacts(path, csv), transactions: csvRows(csv) };
      return text(`${JSON.stringify(facts)}${args.inline ? `\n\n${csv}` : ""}`);
    },
  }),

  defineTool({
    name: "download_monthly_export",
    title: "Download monthly CSV export",
    description:
      "Saves one calendar month of Starling's CSV transaction export (all settled transactions on the account) as " +
      "starling-<currency>-<account name>-<account number>-statement-YYYY-MM.csv in the download directory, and returns the path, size and SHA-256. " +
      "Starling's API no longer offers official PDF/CSV monthly statements (those endpoints return 404 even with the statement-* scopes); this is the closest equivalent. " +
      "The current month is exported up to today and flagged partial.",
    tier: "read",
    operations: ["downloadCSVFeedExportForDateRange"],
    optionalOperations: ["getAccountIdentifiers"],
    readOnly: true,
    writesFiles: true,
    input: {
      accountUid,
      yearMonth: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM")
        .describe("Calendar month to export (YYYY-MM)"),
      saveAs: z
        .string()
        .optional()
        .describe("Plain file name (no folders) to use instead of the default. Always saved in the download directory"),
    },
    async run(args, ctx) {
      const range = monthRange(args.yearMonth);
      const account = await ctx.accounts.account(args.accountUid);
      const csv = await ctx.client.text({
        method: "GET",
        path: "/api/v2/accounts/{accountUid}/feed-export",
        params: { accountUid: account.accountUid },
        query: { start: range.start, end: range.end },
        accept: "text/csv",
      });
      const name = args.saveAs ?? (await monthlyFileName(ctx, account, args.yearMonth));
      const path = await saveDownload(ctx.config.downloadDir, name, csv);
      return json({
        ...fileFacts(path, csv),
        account: { accountUid: account.accountUid, name: account.name, currency: account.currency },
        from: range.start,
        to: range.end,
        partial: range.partial,
        transactions: csvRows(csv),
      });
    },
  }),
];

function csvRows(csv: string): number {
  return Math.max(0, csv.trim().split("\n").length - 1);
}

/** First and last day of a month (UTC); the current month ends today. Future months are refused. */
export function monthRange(yearMonth: string, now = new Date()): { start: string; end: string; partial: boolean } {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (first > today) throw new Error(`${yearMonth} is in the future.`);
  const partial = last >= today;
  const end = partial ? today : last;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { start: day(first), end: day(end), partial };
}

/**
 * starling-<currency>-<name slug>-<account number, else first 8 of the uid>-statement-YYYY-MM.csv.
 * The account number needs account-identifier:read; without it (or on error) the UID prefix is used.
 */
async function monthlyFileName(
  ctx: ToolContext,
  account: { accountUid: string; name: string; currency: string },
  yearMonth: string,
): Promise<string> {
  let number: string | undefined;
  try {
    const ids = await ctx.client.json<{ accountIdentifier?: string }>({
      method: "GET",
      path: "/api/v2/accounts/{accountUid}/identifiers",
      params: { accountUid: account.accountUid },
    });
    const digits = ids?.accountIdentifier?.replace(/[^A-Za-z0-9]/g, "");
    if (digits) number = digits;
  } catch (err) {
    if (!(err instanceof StarlingApiError)) throw err;
  }
  const id = number ?? account.accountUid.slice(0, 8);
  return `starling-${account.currency.toLowerCase()}-${slug(account.name)}-${id}-statement-${yearMonth}.csv`;
}
