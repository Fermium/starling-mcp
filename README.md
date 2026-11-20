# starling-mcp (Fermium fork)

[![CI](https://github.com/Fermium/starling-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Fermium/starling-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

A privacy-first [Model Context Protocol](https://modelcontextprotocol.io) server for the [Starling Bank public API](https://developer.starlingbank.com/docs), forked from [Zesty0wl/starling-mcp](https://github.com/Zesty0wl/starling-mcp). It lets an AI assistant such as Claude read **your own** Starling accounts: balances, transactions, spaces, savings goals, cards, direct debits, payees and standing orders, plus local analysis (spending summaries, subscription detection, a one-call overview).

**This fork is used read-only.** Write and payment tools exist in the code but are never registered unless you set `STARLING_ENABLE_WRITES` / `STARLING_ENABLE_PAYMENTS`. Don't set them, and give the token read scopes only. The token's scopes are a second, independent limit. What the fork adds:

- **Personal and business accounts side by side.** Each Starling login gets its own *profile*: its own Keychain item, its own MCP server entry and its own download folder. A token file or variable you set explicitly always wins over the Keychain.
- **File writes are confined to one folder.** CSV exports and attachments can only be saved directly inside the download directory. Paths elsewhere, `..`, subfolders, symlinks and unsafe server-supplied file names are all refused. `STARLING_DOWNLOAD_DIR=off` removes the file-saving tools.
- **Honest totals.** `list_transactions` totals count only `SETTLED` and `PENDING` items, the same as `summarise_spending`. Declined, upcoming and reversed items are reported separately under `notInTotals`.

> Not affiliated with or endorsed by Starling Bank.

## Run locally (macOS)

You need **Node.js 22.13 or later** (for the built-in SQLite used by the local mirror) (`node -v`; `brew install node` if missing) and the Xcode command line tools for `git`. There are no native modules, so nothing is compiled.

```sh
git clone https://github.com/Fermium/starling-mcp.git ~/src/starling-mcp
cd ~/src/starling-mcp
npm ci                       # installs and builds (via `prepare`); about 15 seconds
npm test                     # optional: runs the test suite against a fake Starling API, no network
npm link                     # puts `starling-mcp` on your PATH (or use `node dist/index.js` wherever it says starling-mcp)
starling-mcp --help
```

`npm ci` on npm 11 may print an `allow-scripts` warning about `fsevents`. It is harmless (an optional file-watcher used only by the test runner).

Before adding a real token, you can check that the server starts and lists its tools. It starts without a token, and tools that need one return a clear error:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | STARLING_ENVIRONMENT=sandbox node dist/index.js | grep -o '"readOnlyHint":true' | wc -l   # → 59 read-only tools
```

You can also run it without cloning, with `npx`. It builds from source on first run. Pin a commit so the code can't change under you:

```sh
npx -y github:Fermium/starling-mcp#<commit-sha> --help
```

Cloning is the recommended setup: you can read the code you run, and `node /absolute/path/dist/index.js` starts instantly. The first `npx` run takes about 25 seconds, which can hit an MCP client's startup timeout.

## Read-only setup for a personal and a business account

### 1. Create one read-only token per account

**One token covers one account holder, so a personal and a business account need two tokens.** In Starling, personal, business, sole-trader and joint accounts are separate *account holders*. Starling's API docs say: "Each access token is associated with a single account holder… each kind of account holder is a separate entity and hence requires a separate access token." There is no endpoint or header that switches one token between account holders. Starling also allows each Developer Portal login to be linked to only one Starling account. For the business account, sign up for a second Developer Portal login, link it to the business account, and create the second token there.

One account holder can still have several accounts, such as a GBP account, a euro account and an Easy Saver. One token sees all of them, and tools pick between them with `accountUid`. `starling-mcp doctor --profile <name>` prints the account holder type (`INDIVIDUAL`, `BUSINESS`, `SOLE_TRADER` or `JOINT`) and every account the token can reach, so you can check which one you've stored.

In the [Starling Developer Portal](https://developer.starlingbank.com), go to *Personal Access*, link the Starling login, and create a token. Tick **only `:read` scopes**. Never tick anything ending in `:create`, `:edit`, `:delete` or `:write`.

| | Scopes |
|---|---|
| **Needed** for balances, transactions, spaces and the analysis tools | `account:read`, `balance:read`, `transaction:read`, `space:read`, `savings-goal:read` |
| **Useful** for a finance assistant | `account-identifier:read` (sort code / IBAN), `mandate:read` (direct debits), `standing-order:read`, `payee:read`, `card:read`, `customer:read` (personal details), `account-holder-type:read`, `feed-export-csv:read` (CSV exports, including `download_monthly_export`), `attachment:read` and `receipts:read` (receipts) |
| **Not needed** | `statement-pdf:read` and `statement-csv:read`. Starling still offers these scopes, but its API no longer serves statements, so they do nothing (`doctor` flags them as unused) |
| **Everything else read-only** | `starling-mcp scopes` lists all 29 read scopes the server can use |

`starling-mcp doctor` shows which tools the token's scopes don't cover, and warns if the token has any write scopes.

### 2. Store each token in the Keychain under its own profile

Run this in a terminal and paste the token when asked. Input is hidden, and the token is checked with Starling before it is saved:

```sh
starling-mcp token set --profile personal
starling-mcp token set --profile business
# or from the clipboard: pbpaste | starling-mcp token set --profile business && pbcopy < /dev/null

starling-mcp doctor --profile personal
starling-mcp doctor --profile business
```

Profiles are stored in the Keychain as service `starling-mcp`, account `access-token-production-<profile>`. A server entry with a profile only ever reads its own item and never falls back to another one.

If you stored a token under the wrong profile name, move it without pasting it again. The token is never printed. The new item is checked before the old one is removed:

```sh
starling-mcp token rename --from personal --to business   # add --force to replace an existing item
starling-mcp token copy   --from personal --to backup     # keeps the original
```

A token stored without a profile (plain `starling-mcp token set`) lives under `access-token-production`. Run `starling-mcp token set --profile <name>` again to give it a profile.

If you'd rather use a file than the Keychain, put the token in a file only you can read (`chmod 600`; the server refuses files that other users can read) and set `STARLING_ACCESS_TOKEN_FILE`.

### 3. Add two MCP server entries

Claude Code, one command per account:

```sh
claude mcp add starling-personal --scope user -e STARLING_PROFILE=personal -- node ~/src/starling-mcp/dist/index.js
claude mcp add starling-business --scope user -e STARLING_PROFILE=business -- node ~/src/starling-mcp/dist/index.js
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) or any other MCP client. Use absolute paths: `~` is not expanded in `args`, and GUI apps don't see your shell's `PATH`. Put the output of `which node` (e.g. `/opt/homebrew/bin/node`) in `command` if `node` isn't found or an old version is picked up:

```json
{
  "mcpServers": {
    "starling-personal": {
      "command": "node",
      "args": ["/Users/you/src/starling-mcp/dist/index.js"],
      "env": { "STARLING_PROFILE": "personal" }
    },
    "starling-business": {
      "command": "node",
      "args": ["/Users/you/src/starling-mcp/dist/index.js"],
      "env": { "STARLING_PROFILE": "business" }
    }
  }
}
```

Using token files instead of the Keychain (e.g. on Linux):

```json
"starling-business": {
  "command": "node",
  "args": ["/home/you/starling-mcp/dist/index.js"],
  "env": { "STARLING_PROFILE": "business", "STARLING_ACCESS_TOKEN_FILE": "/home/you/.config/starling-mcp/business.token" }
}
```

Set token variables (`STARLING_ACCESS_TOKEN`, `STARLING_ACCESS_TOKEN_FILE`) only in a server entry's `env`, never globally in your shell profile. They take precedence over the Keychain, so a globally exported token would be used by *both* entries. `starling-mcp doctor --profile <name>` and the `get_server_status` tool show where each entry's token comes from.

Each entry announces its profile to the assistant (server name `starling-<profile>`, plus a line in its instructions), so figures from the two accounts are not mixed up. Exports go to `~/Downloads/starling-mcp/<profile>/`. macOS may ask once whether the MCP client (or Terminal) may access Downloads; if you'd rather avoid that, set `STARLING_DOWNLOAD_DIR` to a folder outside Downloads, Documents and Desktop, or to `off`.

A single account works the same way without `STARLING_PROFILE` (`starling-mcp token set`, then `claude mcp add starling --scope user -- node ~/src/starling-mcp/dist/index.js`).

### Docker

A `Dockerfile` is included for MCP hosts and directories that run servers in containers. The macOS Keychain isn't available inside a container, so mount a `chmod 600` token file and set `STARLING_ACCESS_TOKEN_FILE` (or pass `STARLING_ACCESS_TOKEN`):

```sh
docker build -t starling-mcp .
docker run --rm -i -e STARLING_ACCESS_TOKEN starling-mcp
```

On a Mac, running it natively is more private, because the token stays in the Keychain.

## Local mirror

`starling-mcp sync` keeps a complete local copy of a profile's Starling data in SQLite. Most questions then cost no API calls, and your history survives the 90-day consent lapse: after consent expires, Starling only serves the last 90 days.

```sh
starling-mcp sync --profile personal --dry-run    # estimate the API calls first
starling-mcp sync --profile personal              # first run: full history; later runs: incremental
starling-mcp sync --profile personal --backup-dir "$HOME/Library/CloudStorage/GoogleDrive-<you>/My Drive/Finance/Starling/mirror-backups"
```

- **Storage.** One file per profile, `~/.local/share/starling-mcp/<profile>.sqlite` (`STARLING_DB_PATH` overrides it). Mode 0600, WAL journal, schema version in `PRAGMA user_version` with migrations. Tables:
  - `account_holder`, `accounts`, `categories` (main balance, savings goals, spending spaces)
  - `feed_items`: every column, the raw JSON, `first_seen` and `last_updated`, plus an FTS5 index on counterparty, reference and note
  - `balance_snapshots`, `direct_debit_mandates`, `standing_orders`, `payees`
  - `sync_state` (per-category cursors), `sync_runs`, `api_usage`
- **First run.** Backfills every category of every account, newest first, in one-year windows (Starling's limit) down to the account's `createdAt`. A window that comes back with 1,000 or more items is split in half and fetched again. If consent has lapsed, the backfill pauses instead of recording 90 days as the full history.
- **Later runs.** Incremental via the changes feed (`changesSince`), starting 7 days before the previous run started, so settled, edited, reversed and declined items are updated. Upserts are idempotent, and only rows whose JSON changed are rewritten. If the last sync is over a year old, sync refetches by window instead.
- **API budget.** Calls are paced at 5/second. A run makes at most 600 calls (`--max-requests`), and the mirror makes at most 900 per UTC day (`--daily-limit`), so the assistant keeps some of Starling's 1,000. A 429 counts as the limit being reached. In every case the run saves its progress and exits with code 75; run `sync` again to resume. `--full` re-backfills from scratch.
- **Backups.** `--backup-dir` runs only after a complete sync. It writes a consistent copy (`VACUUM INTO`) named `<profile>-YYYY-MM-DD.sqlite`: first to a temporary name, then made 0600 and renamed, so a Drive client never uploads a half-written file. It keeps the newest 14 and deletes only files matching that name pattern. The live database is never written there, and sync refuses to back up into the live folder.
- **MCP tools (no API calls):**
  - `query_transactions`: date and amount range, direction, full-text search, spending category, account, space and status, across every account and space. Each row names its profile, account and space.
  - `mirror_status`: last sync, rows and coverage per category, backfill state, empty months.
  - `summarise_spending_offline` and `find_recurring_payments_offline`: the same analyses as the live tools, over the whole history. Each reports the mirror's age and says when it is stale (more than 36 hours old).
  - `doctor` also shows the mirror's status.
- **Not detected.** Items deleted on Starling's side (the changes feed doesn't report removals), and spaces closed before the first sync.
- **No raw SQL tool.** Node's SQLite driver is synchronous and can't interrupt a query, so one runaway query would freeze the server. The fixed tools cover the common questions. For anything else, open the file yourself with `sqlite3 ~/.local/share/starling-mcp/<profile>.sqlite`.

**Typical cost.** A first sync uses about 10 calls for metadata, plus one per category per year of history. A daily incremental sync uses about 15 calls plus one per category.

### Scheduled sync (macOS)

`scripts/sync-mirrors.sh` syncs several profiles one after another and backs each one up. Run it daily from a LaunchAgent. Use absolute paths, because launchd doesn't see your shell's `PATH`. The Keychain must be unlocked, so the job runs while you're logged in. The first time it writes to a cloud folder, macOS may ask for permission, so run it once from Terminal first.

`~/Library/LaunchAgents/com.example.starling-mcp.sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.starling-mcp.sync</string>
  <key>ProgramArguments</key><array>
    <string>/Users/you/src/starling-mcp/scripts/sync-mirrors.sh</string>
    <string>personal</string><string>business</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>NODE</key><string>/opt/homebrew/bin/node</string>
    <key>STARLING_BACKUP_DIR</key><string>/Users/you/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/Finance/Starling/mirror-backups</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/Users/you/.local/state/starling-mcp/sync.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.local/state/starling-mcp/sync.log</string>
</dict></plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.starling-mcp.sync.plist
launchctl kickstart gui/$(id -u)/com.example.starling-mcp.sync   # run it now once
```

## Privacy and safety design

Your bank token can move money, so the design assumes it must never leak and that the model can be manipulated.

- **Local only.** stdio transport, no HTTP listener, no telemetry, no analytics, no third-party services. The only host it ever contacts is `api.starlingbank.com` (or `api-sandbox.starlingbank.com`). That host is hard-coded, redirects are refused, and path parameters are percent-encoded.
- **Token in the macOS Keychain.** `starling-mcp token set` reads the token at a hidden prompt (or from a pipe, e.g. `pbpaste | starling-mcp token set`), checks it with Starling, and only then stores it in the Keychain, passing it to macOS's `security` tool over a pipe. It never appears in shell history, process arguments or config files. Environment variables and a `chmod 600` file are supported as fallbacks.
- **Read-only by default.** Write tools and payment tools are not even registered unless you opt in with `STARLING_ENABLE_WRITES` / `STARLING_ENABLE_PAYMENTS` (this fork never does). The token's own scopes are a second, independent limit.
- **Human confirmation for anything risky.** Payments, standing orders, payee changes, cancelling direct debits, deleting savings spaces, personal-detail changes and token revocation all require explicit approval:
  - With clients that support MCP *elicitation*, the client shows you a confirmation dialog directly. The model cannot answer it, which is the strongest defence against prompt injection (for example, instructions hidden in a payment reference someone sent you).
  - Otherwise a two-step flow is used. The first call returns a preview and a one-time code, and only an identical second call with that code within 5 minutes executes. Codes are single-use and burn on any mismatch.
- **Payments only to existing payees.** This is Starling's rule for personal tokens, and the confirmation names the payee, sort code and account number before anything is sent. An optional hard cap applies per payment (`STARLING_PAYMENT_LIMIT_MINOR_UNITS`).
- **Request signing** for payment-class endpoints, using your own key pair. Private keys stay on disk with `0600` permissions, and the server refuses to load keys other users can read.
- **Local audit log** of every state-changing call (no tokens), at `~/.local/state/starling-mcp/audit.log` with `0600` permissions.
- **Rate-limit aware.** Requests are paced to Starling's 5/second limit for personal tokens. 429s are retried only when Starling says to retry soon, and writes are never blindly retried after a server error.
- **Minimal dependencies.** Only the official MCP SDK and `zod`. HTTP, crypto and signing use Node's standard library.
- **Files go to one folder only.** Tools can only write directly inside `STARLING_DOWNLOAD_DIR`: no other absolute paths, no `..`, no subfolders. Files are created with `O_EXCL | O_NOFOLLOW` and `0600`, so nothing is overwritten and no symlink is followed. File names suggested by Starling are used only if they are a plain name. `STARLING_DOWNLOAD_DIR=off` removes the file-saving tools.

## Configuration

All configuration is through environment variables. None of them hold secrets except the token fallbacks.

| Variable | Default | Purpose |
|---|---|---|
| `STARLING_PROFILE` | none | Name for this server entry, e.g. `personal` or `business`. Selects the Keychain item `access-token-<environment>-<profile>` and the download folder. Letters, digits, `.`, `_`, `-`. |
| `STARLING_KEYCHAIN_ACCOUNT` | `access-token-<environment>[-<profile>]` | Override the Keychain account name directly. |
| `STARLING_ACCESS_TOKEN_FILE` | none | Path to a file containing the token (must not be readable by other users: `chmod 600`). Takes precedence over the Keychain. If set, it must work; there is no silent fallback. |
| `STARLING_ACCESS_TOKEN` | none | Token in the environment. Takes precedence over the Keychain. Avoid it if you can, because environment variables are easy to leak. |
| `STARLING_ENVIRONMENT` | `production` | `production` or `sandbox`. |
| `STARLING_DOWNLOAD_DIR` | `~/Downloads/starling-mcp/<profile or "default">` | The only folder files are ever written to (CSV exports, attachments, images with `saveAs`). `off` removes `export_transactions_csv` and `download_transaction_attachment` and disables `saveAs`. |
| `STARLING_DEFAULT_ACCOUNT_UID` | none | Account used when a tool's `accountUid` is omitted (otherwise the only account, or the `PRIMARY` one). |
| `STARLING_AUDIT_LOG` | `~/.local/state/starling-mcp/audit.log` | Path, or `off`. Only state-changing calls are logged, so it stays empty when read-only. |
| `STARLING_REQUESTS_PER_SECOND` | `5` | Client-side pacing. |

Token lookup order: `STARLING_ACCESS_TOKEN_FILE`, then `STARLING_ACCESS_TOKEN`, then the Keychain item for this entry's profile.

### Write and payment settings (not used by this fork)

These are kept from upstream. Leave them unset for read-only use.

| Variable | Default | Purpose |
|---|---|---|
| `STARLING_ENABLE_WRITES` | `false` | Registers tools that change things: notes, categories, receipts, attachments, card controls, savings spaces, round-ups, direct-debit cancellation, profile and contact details. |
| `STARLING_ENABLE_PAYMENTS` | `false` | Also registers payments, standing orders and payee management. Requires writes. |
| `STARLING_PAYMENT_LIMIT_MINOR_UNITS` | none | Maximum amount per payment or standing order, in pence (`50000` = £500). |
| `STARLING_CONFIRMATION` | `auto` | `auto` uses elicitation when the client supports it and falls back to codes otherwise. `elicit` requires elicitation and refuses otherwise. `token` always uses codes. |
| `STARLING_SIGNING_KEY_UID` | none | UID of your uploaded API signing key; enables signed endpoints. |
| `STARLING_SIGNING_KEY_PATH` | `~/.config/starling-mcp/keys/starling-api-private.key` | Private key used for signing. |

Upstream's write-enabled setup, for reference only: `claude mcp add starling --scope user -e STARLING_ENABLE_WRITES=true -e STARLING_ENABLE_PAYMENTS=true -e STARLING_PAYMENT_LIMIT_MINOR_UNITS=50000 -e STARLING_SIGNING_KEY_UID=<uid> -- node /path/to/dist/index.js`. With payments, Starling refuses tokens that combine `payee:create` with `pay-local:create` / `standing-order:create`.

## Request signing (payments, standing orders, email and address changes)

Starling requires these endpoints to be [signed](https://developer.starlingbank.com/docs#api-keys-and-message-signing) with a key pair you control:

```sh
starling-mcp keys generate
```

This creates RSA-4096 *API* and *rotation* key pairs in `~/.config/starling-mcp/keys` (private keys `0600`) and prints the public keys. Upload both public keys in the Developer Portal under *Personal Access → Keys*, then set `STARLING_SIGNING_KEY_UID` to the API key's UID. To rotate keys later, use `starling-mcp keys rotation-signature <new-public.key> <rotation-key-uid>`.

## Tools

✋ = asks for your confirmation before acting. Amounts are always integers in minor units (pence). `accountUid` and `categoryUid` are optional almost everywhere and default to your primary account's main balance. A space or savings goal UID can be used as a `categoryUid`.

### Overview and analysis (computed locally)

| Tool | Tier | What it does |
|---|---|---|
| `get_server_status` | read | Shows how this Starling MCP server is configured: environment, enabled access tier, whether request signing is set up, how confirmations work, and how many API requests it has made today (personal tokens allow 1,000/day). |
| `get_financial_overview` | read | One-call snapshot of every account: balances (cleared, effective, total including spaces), plus each savings space and spending space with its balance. |
| `summarise_spending` | read | Analyses transactions locally and totals them by spending category, by counterparty (merchant/payee), or by month (in/out/net). |
| `find_recurring_payments` | read | Scans outgoing transactions (default: last 12 months) for payments that repeat on a regular cadence: subscriptions, direct debits, standing orders, memberships. |
| `list_spending_categories` | read | Lists every spending category value Starling accepts (for filtering and recategorising). |

### Accounts and balances

| Tool | Tier | What it does |
|---|---|---|
| `list_accounts` | read | Lists the accounts this token can access, with accountUid, accountType, currency, name and defaultCategory (the category UID of the main balance, needed by feed and payment endpoints). |
| `get_account_balance` | read | Gets an account's balance. |
| `get_account_identifiers` | read | Gets the account's sort code and account number, plus IBAN and BIC (and any other identifiers). |
| `check_funds` | read | Checks whether the account has enough available money for a payment of the given amount, taking the overdraft into account. |
| `export_transactions_csv` | read | Downloads Starling's CSV export of all settled transactions on the main account between two dates (the same export as the app). Returns the path, size and SHA-256. |
| `download_monthly_export` | read | Saves one calendar month (`YYYY-MM`) of the CSV export as `starling-<currency>-<account name>-<account number>-statement-YYYY-MM.csv` and returns the path, size and SHA-256. This is the closest equivalent to a monthly statement. |

### Transactions

| Tool | Tier | What it does |
|---|---|---|
| `list_transactions` | read | Lists transactions (feed items) for the main account or a space between two dates, newest first, with optional filters. |
| `get_feed_changes_since` | read | Returns feed items created or updated since a timestamp (within the last year). |
| `list_settled_transactions` | read | Lists settled transactions across the whole account (all categories) whose SETTLEMENT time falls between two timestamps (max 1 year). |
| `get_transaction` | read | Gets every detail of a single feed item (transaction). |
| `get_card_transaction_details` | read | For card payments: Mastercard details such as merchant identifier, merchant category code (MCC), point-of-sale time, authorisation code and card last 4 digits. |
| `list_transaction_attachments` | read | Lists the files (images / PDFs) attached to a transaction. |
| `download_transaction_attachment` | read | Downloads a file attached to a transaction. |
| `get_transaction_receipt` | read | Gets the itemised receipt that this application (token) submitted for a transaction. |
| `list_transaction_receipts` | read | Gets all itemised receipts for a transaction, from any source (you, Starling, or partners). |
| `set_transaction_note` | write | Sets (or clears, with an empty string) your private note on a transaction. |
| `set_transaction_spending_category` | write | Changes a transaction's spending category (e.g. |
| `upload_transaction_attachment` | write | Attaches a local image or PDF (e.g. |
| `submit_transaction_receipt` | write | Creates or updates an itemised receipt for a transaction (merchant, line items, tax, payment methods). |

### Spaces, savings goals and round-ups

| Tool | Tier | What it does |
|---|---|---|
| `list_spaces` | read | Lists all active spaces on an account: savings spaces (savings goals: name, total saved, target, %) and spending spaces (e.g. |
| `get_spending_space` | read | Gets one spending space (balance, type, linked card). |
| `get_space_photo` | read | Returns the photo of a space (savings or spending). |
| `list_savings_goals` | read | Lists savings goals (savings spaces) with total saved, target and percentage. |
| `get_savings_goal` | read | Gets one savings goal. |
| `get_savings_goal_photo` | read | Returns the photo of a savings goal. |
| `get_savings_goal_recurring_transfer` | read | Gets the recurring transfer (automatic top-up) into a savings space, if one is set. |
| `get_round_up` | read | Shows whether round-ups are active, which savings space they go to, and the multiplier. |
| `create_savings_goal` | write | Creates a new savings space, optionally with a target and photo. |
| `update_savings_goal` | write | Renames a savings space or changes its target / photo. |
| `delete_savings_goal` | write ✋ | Deletes a savings space. |
| `transfer_to_savings_goal` | write | Moves money from the main balance into one of your own savings spaces. |
| `withdraw_from_savings_goal` | write | Moves money from one of your savings spaces back to the main balance. |
| `set_savings_goal_recurring_transfer` | write | Creates or replaces an automatic recurring transfer from the main balance into a savings space (e.g. |
| `delete_savings_goal_recurring_transfer` | write | Stops the automatic recurring transfer into a savings space. |
| `enable_round_up` | write | Turns on round-ups: each card payment is rounded up to the next pound and the difference (times the multiplier, 1-10) is moved into a savings space. |
| `disable_round_up` | write | Turns off round-ups for the account. |

### Cards

| Tool | Tier | What it does |
|---|---|---|
| `list_cards` | read | Lists the account holder's cards with their controls: enabled (not locked), ATM, online, POS (contactless/chip & PIN), mobile wallet, gambling, mag stripe, currency flags, last 4 digits and activation/cancellation state. |
| `set_card_control` | write | Turns a card control on or off. |
| `set_card_currency_switch` | write | Enables or disables card payments in a specific currency (the card's currency switch control). |

### Direct debits

| Tool | Tier | What it does |
|---|---|---|
| `list_direct_debit_mandates` | read | Lists direct debit mandates (who can take money by direct debit): originator, reference, status, created date, last payment date and amount, and the category (space) it is paid from. |
| `get_direct_debit_mandate` | read | Gets one direct debit mandate. |
| `list_direct_debit_payments` | read | Lists the payments taken under a direct debit mandate since a date. |
| `cancel_direct_debit_mandate` | write ✋ | Cancels a direct debit mandate so the originator can no longer collect payments. |

### Payees

| Tool | Tier | What it does |
|---|---|---|
| `list_payees` | read | Lists saved payees, one compact row per payee account: name, payeeUid, payeeAccountUid, sort code / account number and recent references. |
| `get_payee` | read | Gets one saved payee and its accounts. |
| `get_payee_image` | read | Returns the payee's image (PNG), if one exists. |
| `list_payee_payments` | read | Lists the history of payments made to a payee account since a date. |
| `list_payee_scheduled_payments` | read | Lists scheduled (future-dated and recurring) payments to a payee account. |
| `create_payee` | payments ✋ | Saves a new payee with one or more bank accounts. |
| `update_payee` | payments ✋ | Updates a payee's details (name, type, contact details). |
| `add_payee_account` | payments ✋ | Adds another bank account to an existing payee. |
| `delete_payee` | payments ✋ | Deletes a saved payee and all its accounts. |
| `delete_payee_account` | payments ✋ | Removes one bank account from a payee. |

### Payments and standing orders

| Tool | Tier | What it does |
|---|---|---|
| `get_payment_order` | read | Gets a payment order (an instructed payment or standing order) by its paymentOrderUid. |
| `list_payment_order_payments` | read | Lists the actual payments made under a payment order (newest first), with status (PENDING, ACCEPTED, REJECTED) and reasons. |
| `list_standing_orders` | read | Lists standing orders paid from the main account (or a space): payee name, amount, reference, schedule and next date. |
| `get_standing_order` | read | Gets one standing order. |
| `list_standing_order_upcoming_payments` | read | Lists the next payment dates of a standing order (1 to 100, default 10). |
| `make_payment` | payments ✋ | Sends an immediate payment (UK Faster Payments, or SEPA from a EUR account) to an EXISTING saved payee account. |
| `create_standing_order` | payments ✋ | Creates a standing order to an EXISTING saved payee account. |
| `update_standing_order` | payments ✋ | Changes a standing order's amount, reference, schedule or spending category. |
| `cancel_standing_order` | payments ✋ | Cancels a standing order so no further payments are made. |

### Identity and account holder

| Tool | Tier | What it does |
|---|---|---|
| `get_token_identity` | read | Returns the access token's granted OAuth scopes, expiry, consent expiry and account holder UID. |
| `get_authorising_individual` | read | Returns the person who authorised this token (name, date of birth, email, phone). |
| `get_account_holder` | read | Returns the account holder UID and type (INDIVIDUAL, JOINT, SOLE_TRADER or BUSINESS). |
| `get_account_holder_name` | read | Returns the account holder's name. |
| `get_individual_details` | read | Personal account holders: title, name, date of birth, email and phone. |
| `get_joint_account_details` | read | Joint account holders: details of both people on the account. |
| `get_business_details` | read | Business account holders: company name, type, registration number, VAT number, etc. |
| `get_sole_trader_details` | read | Sole trader account holders: trading name, business category and subcategory. |
| `get_business_registered_address` | read | Business account holders: the company's registered address. |
| `get_business_correspondence_address` | read | Business account holders: correspondence address (falls back to the registered address). |
| `get_addresses` | read | Returns the account holder's current and previous addresses. |
| `get_settle_up_profile` | read | Returns the account holder's Settle Up profile (their Starling payment link/handle) if they have one. |
| `get_profile_image` | read | Returns the account holder's profile image, if one exists. |
| `update_profile_image` | write | Replaces the account holder's profile image with a local JPEG/PNG/GIF/WEBP/HEIC file. |
| `delete_profile_image` | write | Deletes the account holder's profile image. |
| `update_email` | write ✋ | Changes the individual account holder's email address with Starling. |
| `update_address` | write ✋ | Changes the account holder's current residential address with Starling. |
| `logout_all_tokens` | write ✋ | Logs the individual out by disabling ALL of their active API access tokens, including the one this server uses. |

## Rate limits

Personal access tokens are limited to **5 requests per second and 1,000 per day**. The analysis tools are designed around this: a year of transactions is one request, and `get_financial_overview` costs 1 + 2 requests per account. `get_server_status` shows how many requests this process has used today.

## What is deliberately not included

- **Open Banking AISP/PISP APIs.** These are only for FCA-regulated third-party providers.
- **Payment Services API.** This is for payment businesses using Starling as a payment rail; it needs mTLS and a commercial agreement.
- **Onboarding / Banking-as-a-Service and Marketplace OAuth.** These are partner-only APIs.
- **Webhooks.** Starling pushes these to a public HTTPS endpoint. Receiving them would mean running an internet-facing server, which conflicts with this project's local-only design. Use `get_feed_changes_since` to pick up changes instead.
- **Official monthly statements (PDF/CSV) and spending-insights endpoints.** Starling has withdrawn these from the public API. They are not in the live OpenAPI spec, and `GET /api/v2/accounts/{accountUid}/statement/available-periods`, `/statement/download` and `/statement/downloadForDateRange` return an empty 404 (the same as any unknown route), even for tokens granted `statement-pdf:read` / `statement-csv:read` (checked November 2026). Use `download_monthly_export` (one month of the CSV export, with size and SHA-256), `export_transactions_csv` and `summarise_spending` instead. For an official PDF statement, download it from the Starling app or website.

## Development

```sh
npm test            # unit + MCP integration tests (fake Starling API, no network)
npm run check       # lint + type-check
npm run build
npm run spec:check  # compare against Starling's live OpenAPI spec (network)
```

Tool definitions live in `src/tools/`. Each tool declares the Starling `operationId`s it calls, its access tier, and whether it needs confirmation, and the test suite enforces the safety invariants: read-tier tools only issue GETs, and every signed or payment-tier tool requires confirmation.

## Licence

MIT
