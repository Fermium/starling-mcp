# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Local mirror.** `starling-mcp sync --profile <p> [--full] [--dry-run] [--backup-dir <dir>] [--max-requests N] [--daily-limit N]` keeps a complete SQLite copy (`~/.local/share/starling-mcp/<profile>.sqlite`, or `STARLING_DB_PATH`) of every account, space and savings goal: the account holder, accounts, categories, all feed items with their raw JSON and an FTS5 index, balance snapshots, mandates, standing orders and payees.
  - The first run backfills in one-year windows down to each account's creation date. Later runs are incremental via `changesSince`, with a 7-day overlap, and upserts are idempotent.
  - API budgets: 600 calls per run and 900 per day by default. A run stops cleanly with exit code 75 and resumes on the next run; a 429 is treated the same way.
  - A sync lock stops two runs of one profile overlapping. Backups use `VACUUM INTO` with an atomic rename, mode 0600 and the newest 14 kept.
  - Uses Node's built-in `node:sqlite`, so there are no new dependencies and no native build.
- MCP tools that read the mirror with no API calls: `query_transactions`, `mirror_status`, `summarise_spending_offline` and `find_recurring_payments_offline`. `doctor` shows the mirror's status.
- `scripts/sync-mirrors.sh` for scheduled syncs of several profiles, with backups.
- `download_monthly_export(accountUid?, yearMonth, saveAs?)` saves one calendar month of the CSV transaction export as `starling-<currency>-<account name slug>-<account number, or first 8 chars of the UID>-statement-YYYY-MM.csv`. It writes only inside the download directory with the usual confinement and `O_EXCL` rules, and returns the path, size, SHA-256, date range, row count, and whether the month is partial (the current month ends today). The account number is used when the token has `account-identifier:read`.
- `export_transactions_csv` now returns size and SHA-256 too, as JSON (path, bytes, sha256, transactions).
- `doctor` flags `statement-pdf:read` / `statement-csv:read` as unused. Starling's API no longer serves official monthly statements: the statement routes are missing from the live spec and return 404 even with those scopes.
- Profiles (`STARLING_PROFILE`, `--profile <name>`) so one install can run as several MCP server entries, e.g. a personal and a business account. Each profile has its own Keychain item (`access-token-<env>-<profile>`, or `STARLING_KEYCHAIN_ACCOUNT`), its own download folder, and announces itself to the model.
- `doctor` and `token set` warn when a token has write scopes.
- `token rename --from <profile> --to <profile>` (and `token copy`, which keeps the original) move a stored Keychain token between profiles without re-entering it. The token is never printed, and the new item is verified before the old one is removed. `--force` replaces an existing destination.
- `doctor` shows the account holder (type, name, UID) and every account the token can see, with account UIDs, and explains that a token covers exactly one account holder. Business, sole-trader and joint accounts need their own token and profile, because Starling's API ties each token to a single account holder.

### Changed
- Requires Node.js 22.13 or later (`node:sqlite` without a flag).
- Keychain errors from `security` have the token redacted before they are shown.
- Breaking: token lookup order is now `STARLING_ACCESS_TOKEN_FILE`, then `STARLING_ACCESS_TOKEN`, then the Keychain, so an explicit setting is never silently overridden by a Keychain item. A configured token file that is missing, empty or readable by others is an error instead of a fallthrough.
- Breaking: files are only ever written directly inside `STARLING_DOWNLOAD_DIR` (new default `~/Downloads/starling-mcp/<profile>`). Other absolute paths, `..`, subfolders and unsafe server-supplied names are refused; files open with `O_EXCL | O_NOFOLLOW`. `STARLING_DOWNLOAD_DIR=off` removes the file-saving tools.
- `list_transactions` totals count only SETTLED and PENDING items, like `summarise_spending`; other matched statuses are totalled separately under `notInTotals`.
- `Retry-After` given as an HTTP date is understood.
- `list_settled_transactions` and `get_feed_changes_since` check Starling's one-year limit before calling the API and explain how to proceed.
- `npm install` from git builds automatically (`prepare` script), so `npx github:Fermium/starling-mcp#<sha>` works.
- zod updated to 4.6.7 and transitive dependencies updated (`npm audit` clean).
- npm package name is now `@zesty0wl/starling-mcp`, so directories no longer link to an unrelated package that already uses the name `starling-mcp`. The command is still `starling-mcp`.

## [0.1.0] - 2026-10-15

First public release.

### Added
- All 87 operations of the Starling Bank public API, exposed as 84 MCP tools in three access tiers: read (default), write (`STARLING_ENABLE_WRITES`) and payments (`STARLING_ENABLE_PAYMENTS`).
- Local analysis tools that need no extra API calls beyond the feed: `get_financial_overview`, `summarise_spending` (by spending category, counterparty or month) and `find_recurring_payments` (subscription detection with estimated annual cost).
- Token storage in the macOS Keychain, with `STARLING_ACCESS_TOKEN_FILE` and `STARLING_ACCESS_TOKEN` as fallbacks. The token is loaded lazily, so the server starts without one and picks up a newly stored or rotated token without a restart.
- Request signing for payment-class endpoints (RSA or ECDSA), plus `keys generate` and `keys rotation-signature`.
- Human confirmation for money movement and destructive actions: MCP elicitation where the client supports it, otherwise a preview with a single-use code that is burned on any use.
- Optional per-payment cap (`STARLING_PAYMENT_LIMIT_MINOR_UNITS`), local audit log of every state-changing call, and client-side rate limiting for Starling's 5 requests/second limit.
- CLI: `token set|delete`, `doctor`, `scopes`, `keys`.
- `npm run spec:check` compares the implementation with Starling's live OpenAPI spec.
- `Dockerfile` for container-based MCP hosts and directories (token via `STARLING_ACCESS_TOKEN`), smoke-tested in CI; `glama.json` for the Glama directory.

### Fixed (found while testing against a live account)
- `token set` silently truncated tokens to 128 characters because it relied on macOS `getpass()`. It now reads input itself, validates the token with Starling before saving, and passes it to `security` over a pipe.
- List tools returned very large results (one account's payee list was 60k characters). Results are now compact JSON; `list_payees`, `list_direct_debit_mandates`, `list_standing_orders` and `list_payment_order_payments` return trimmed rows by default, with `detail: "full"` available.
- Direct debits and standing orders hide cancelled entries by default (`includeCancelled` to show them).
- Missing photos and profile images return a message instead of a 404 error.

### Documented
- Starling refuses personal access tokens that combine `payee:create` with payment scopes; the recommended setup leaves out `payee:create`.
- `doctor` and `get_token_identity` explain the 90-day consent window.

[Unreleased]: https://github.com/Zesty0wl/starling-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Zesty0wl/starling-mcp/releases/tag/v0.1.0
