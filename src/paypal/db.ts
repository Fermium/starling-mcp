import type { DatabaseSync } from "node:sqlite";
import { openDatabase, openDatabaseReadOnly } from "../mirror/db.js";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    transaction_id TEXT NOT NULL UNIQUE,
    paypal_reference_id TEXT,
    paypal_reference_id_type TEXT,
    event_code TEXT,
    status TEXT,
    initiation_date TEXT,
    updated_date TEXT,
    currency TEXT,
    gross_minor INTEGER,
    fee_minor INTEGER,
    net_minor INTEGER,
    gross_value TEXT,
    fee_value TEXT,
    ending_balance_value TEXT,
    subject TEXT,
    note TEXT,
    invoice_id TEXT,
    custom_field TEXT,
    payer_account_id TEXT,
    payer_name TEXT,
    payer_email TEXT,
    shipping_name TEXT,
    bank_reference_id TEXT,
    payment_method_type TEXT,
    instrument_type TEXT,
    item_names TEXT,
    item_details_json TEXT,
    raw_json TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );
  CREATE INDEX transactions_date ON transactions (initiation_date);
  CREATE INDEX transactions_ref ON transactions (paypal_reference_id);

  CREATE VIRTUAL TABLE transactions_fts USING fts5(
    payer_name, payer_email, shipping_name, subject, note, invoice_id, item_names,
    content = 'transactions', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER transactions_ai AFTER INSERT ON transactions BEGIN
    INSERT INTO transactions_fts (rowid, payer_name, payer_email, shipping_name, subject, note, invoice_id, item_names)
    VALUES (new.id, new.payer_name, new.payer_email, new.shipping_name, new.subject, new.note, new.invoice_id, new.item_names);
  END;
  CREATE TRIGGER transactions_ad AFTER DELETE ON transactions BEGIN
    INSERT INTO transactions_fts (transactions_fts, rowid, payer_name, payer_email, shipping_name, subject, note, invoice_id, item_names)
    VALUES ('delete', old.id, old.payer_name, old.payer_email, old.shipping_name, old.subject, old.note, old.invoice_id, old.item_names);
  END;
  CREATE TRIGGER transactions_au AFTER UPDATE ON transactions BEGIN
    INSERT INTO transactions_fts (transactions_fts, rowid, payer_name, payer_email, shipping_name, subject, note, invoice_id, item_names)
    VALUES ('delete', old.id, old.payer_name, old.payer_email, old.shipping_name, old.subject, old.note, old.invoice_id, old.item_names);
    INSERT INTO transactions_fts (rowid, payer_name, payer_email, shipping_name, subject, note, invoice_id, item_names)
    VALUES (new.id, new.payer_name, new.payer_email, new.shipping_name, new.subject, new.note, new.invoice_id, new.item_names);
  END;

  CREATE TABLE balances (
    as_of_time TEXT NOT NULL,
    currency TEXT NOT NULL,
    is_primary INTEGER,
    total_minor INTEGER,
    available_minor INTEGER,
    withheld_minor INTEGER,
    raw_json TEXT NOT NULL,
    PRIMARY KEY (as_of_time, currency)
  );

  -- One row: how far back the backfill reached and where incremental syncs resume.
  CREATE TABLE sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    backfill_floor TEXT NOT NULL,
    covered_from TEXT,
    backfill_complete INTEGER NOT NULL DEFAULT 0,
    cursor TEXT,
    last_refreshed TEXT,
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
  `,
];

export const PAYPAL_SCHEMA_VERSION = MIGRATIONS.length;

export function openPayPalDb(path: string): DatabaseSync {
  return openDatabase(path, MIGRATIONS);
}

export function openPayPalDbReadOnly(path: string): DatabaseSync | undefined {
  return openDatabaseReadOnly(path, PAYPAL_SCHEMA_VERSION);
}
