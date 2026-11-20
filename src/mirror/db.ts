import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | undefined;

/**
 * Loads node:sqlite on first use, so the MCP server, doctor and other commands
 * don't load it (or print its ExperimentalWarning on Node 22) unless the mirror
 * is used. Only the SQLite experimental warning is silenced.
 */
export function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

/** Schema migrations, applied in order; PRAGMA user_version records how many have run. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE account_holder (
    account_holder_uid TEXT PRIMARY KEY,
    account_holder_type TEXT,
    name TEXT,
    raw_json TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE accounts (
    account_uid TEXT PRIMARY KEY,
    account_type TEXT,
    default_category TEXT NOT NULL,
    currency TEXT NOT NULL,
    name TEXT,
    created_at TEXT,
    raw_json TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  -- Every category the mirror syncs: the main balance of each account, plus spaces and savings goals.
  CREATE TABLE categories (
    category_uid TEXT PRIMARY KEY,
    account_uid TEXT NOT NULL REFERENCES accounts(account_uid),
    kind TEXT NOT NULL CHECK (kind IN ('MAIN', 'SAVINGS_GOAL', 'SPENDING_SPACE')),
    name TEXT,
    state TEXT,
    raw_json TEXT,
    last_seen TEXT NOT NULL
  );

  CREATE TABLE feed_items (
    id INTEGER PRIMARY KEY,
    feed_item_uid TEXT NOT NULL,
    account_uid TEXT NOT NULL,
    category_uid TEXT NOT NULL,
    direction TEXT,
    status TEXT,
    amount_minor INTEGER,
    currency TEXT,
    source_amount_minor INTEGER,
    source_currency TEXT,
    transaction_time TEXT,
    settlement_time TEXT,
    updated_at TEXT,
    source TEXT,
    source_sub_type TEXT,
    counter_party_type TEXT,
    counter_party_uid TEXT,
    counter_party_name TEXT,
    counter_party_sub_entity_name TEXT,
    reference TEXT,
    country TEXT,
    spending_category TEXT,
    user_note TEXT,
    has_attachment INTEGER,
    has_receipt INTEGER,
    raw_json TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    UNIQUE (category_uid, feed_item_uid)
  );
  CREATE INDEX feed_items_time ON feed_items (transaction_time);
  CREATE INDEX feed_items_account_time ON feed_items (account_uid, transaction_time);

  CREATE VIRTUAL TABLE feed_items_fts USING fts5(
    counter_party_name, reference, user_note,
    content = 'feed_items', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER feed_items_ai AFTER INSERT ON feed_items BEGIN
    INSERT INTO feed_items_fts (rowid, counter_party_name, reference, user_note)
    VALUES (new.id, new.counter_party_name, new.reference, new.user_note);
  END;
  CREATE TRIGGER feed_items_ad AFTER DELETE ON feed_items BEGIN
    INSERT INTO feed_items_fts (feed_items_fts, rowid, counter_party_name, reference, user_note)
    VALUES ('delete', old.id, old.counter_party_name, old.reference, old.user_note);
  END;
  CREATE TRIGGER feed_items_au AFTER UPDATE ON feed_items BEGIN
    INSERT INTO feed_items_fts (feed_items_fts, rowid, counter_party_name, reference, user_note)
    VALUES ('delete', old.id, old.counter_party_name, old.reference, old.user_note);
    INSERT INTO feed_items_fts (rowid, counter_party_name, reference, user_note)
    VALUES (new.id, new.counter_party_name, new.reference, new.user_note);
  END;

  CREATE TABLE balance_snapshots (
    account_uid TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    currency TEXT,
    cleared_minor INTEGER,
    effective_minor INTEGER,
    total_effective_minor INTEGER,
    raw_json TEXT NOT NULL,
    PRIMARY KEY (account_uid, taken_at)
  );

  CREATE TABLE direct_debit_mandates (
    mandate_uid TEXT PRIMARY KEY,
    originator_name TEXT,
    reference TEXT,
    status TEXT,
    category_uid TEXT,
    raw_json TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE standing_orders (
    payment_order_uid TEXT PRIMARY KEY,
    account_uid TEXT NOT NULL,
    category_uid TEXT NOT NULL,
    payee_name TEXT,
    amount_minor INTEGER,
    currency TEXT,
    reference TEXT,
    next_date TEXT,
    raw_json TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE payees (
    payee_uid TEXT PRIMARY KEY,
    payee_name TEXT,
    payee_type TEXT,
    raw_json TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  -- Per category: how far back the backfill has reached, and where incremental syncs resume.
  CREATE TABLE sync_state (
    category_uid TEXT PRIMARY KEY,
    account_uid TEXT NOT NULL,
    backfill_floor TEXT NOT NULL,
    covered_from TEXT,
    backfill_complete INTEGER NOT NULL DEFAULT 0,
    changes_cursor TEXT,
    last_success TEXT
  );

  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    new_items INTEGER DEFAULT 0,
    updated_items INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    message TEXT
  );

  CREATE TABLE api_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
}

/** Opens (creating if needed) a SQLite file for writing: WAL, 0600 files, the given migrations applied. */
export function openDatabase(path: string, migrations: string[]): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Create the file with 0600 before SQLite opens it: SQLite gives -wal and -shm the same mode.
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  configure(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrate(db, migrations);
  return db;
}

/** Opens an existing SQLite file read-only (SQLite refuses every write on this connection). */
export function openDatabaseReadOnly(path: string, maxVersion?: number): DatabaseSync | undefined {
  if (!existsSync(path)) return undefined;
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  configure(db);
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (maxVersion !== undefined && version > maxVersion) {
    db.close();
    throw new Error(`${path} was created by a newer starling-mcp (schema ${version}); update this install.`);
  }
  return db;
}

/** Opens (creating if needed) the Starling mirror for writing. */
export function openMirror(path: string): DatabaseSync {
  return openDatabase(path, MIGRATIONS);
}

/** Opens an existing Starling mirror read-only. */
export function openMirrorReadOnly(path: string): DatabaseSync | undefined {
  return openDatabaseReadOnly(path, SCHEMA_VERSION);
}

export function migrate(db: DatabaseSync, migrations: string[] = MIGRATIONS): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current > migrations.length) {
    throw new Error(`The database uses schema ${current}, newer than this starling-mcp (${migrations.length}).`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Runs fn in a transaction (BEGIN IMMEDIATE, so a concurrent writer waits instead of failing mid-way). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
