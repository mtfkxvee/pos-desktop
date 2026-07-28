-- pos-desktop local SQLite schema.
-- Mirrors the offline data model from the old Dexie schema
-- (C:\Users\User\pos\POS\src\utils\offline\db.js) but on SQLite via node:sqlite.
--
-- Convention: each cache table keeps a few indexed/filterable columns pulled out
-- of the Frappe response, plus a `data` column holding the full JSON payload as
-- returned by the pos_next.api.* endpoint, so the server layer never has to
-- reshape data beyond what the UI already expects.

-- Generic key-value store: device config, last-login info, app-level settings.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON-serialized
);

-- Per-table incremental sync cursor (pull.js reads/writes this).
CREATE TABLE IF NOT EXISTS sync_state (
  table_name TEXT PRIMARY KEY,
  last_modified TEXT,   -- max `modified` timestamp seen from server, for incremental pull
  last_synced_at TEXT   -- wall-clock time of last successful pull, for full-refetch tables
);

-- Item master cache (from get_items / get_items_bulk).
CREATE TABLE IF NOT EXISTS items (
  item_code TEXT PRIMARY KEY,
  item_name TEXT,
  item_group TEXT,
  variant_of TEXT,
  barcode TEXT,
  modified TEXT,
  data TEXT NOT NULL -- full JSON payload consumed by the UI as-is
);
CREATE INDEX IF NOT EXISTS idx_items_item_group ON items(item_group);
CREATE INDEX IF NOT EXISTS idx_items_variant_of ON items(variant_of);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);

-- Item price list cache (per price_list + item_code).
CREATE TABLE IF NOT EXISTS item_prices (
  price_list TEXT NOT NULL,
  item_code TEXT NOT NULL,
  rate REAL,
  modified TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (price_list, item_code)
);

-- Local stock qty cache (estimate only, not authoritative — no locking).
CREATE TABLE IF NOT EXISTS stock (
  item_code TEXT NOT NULL,
  warehouse TEXT NOT NULL,
  actual_qty REAL,
  modified TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (item_code, warehouse)
);

-- Customer cache (from get_customers).
CREATE TABLE IF NOT EXISTS customers (
  name TEXT PRIMARY KEY,
  customer_name TEXT,
  mobile_no TEXT,
  email_id TEXT,
  modified TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile_no);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(customer_name);

-- POS Profile cache (from get_pos_profiles / get_pos_profile_data).
CREATE TABLE IF NOT EXISTS pos_profiles (
  name TEXT PRIMARY KEY,
  modified TEXT,
  data TEXT NOT NULL
);

-- Tax template rows per POS profile (from get_taxes). Full-refetch table (no modified_after).
CREATE TABLE IF NOT EXISTS pos_taxes (
  pos_profile TEXT PRIMARY KEY,
  fetched_at TEXT,
  data TEXT NOT NULL -- JSON array of tax rows
);

-- Payment methods per POS profile (from get_payment_methods). Full-refetch table.
CREATE TABLE IF NOT EXISTS payment_methods (
  pos_profile TEXT PRIMARY KEY,
  fetched_at TEXT,
  data TEXT NOT NULL -- JSON array
);

-- Promotional offers cache (from get_offers).
CREATE TABLE IF NOT EXISTS offers (
  name TEXT PRIMARY KEY,
  pos_profile TEXT,
  valid_upto TEXT,
  modified TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_pos_profile ON offers(pos_profile);

-- Invoice history cache, for offline browsing (read-only, from get_invoices-style calls).
CREATE TABLE IF NOT EXISTS invoice_history (
  name TEXT PRIMARY KEY,
  pos_profile TEXT,
  posting_date TEXT,
  customer TEXT,
  modified TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_history_pos_profile ON invoice_history(pos_profile);

-- Unpaid invoices cache, for partial-payment flows offline.
CREATE TABLE IF NOT EXISTS unpaid_invoices (
  name TEXT PRIMARY KEY,
  pos_profile TEXT,
  customer TEXT,
  outstanding_amount REAL,
  modified TEXT,
  data TEXT NOT NULL
);

-- Translations cache (from localization endpoints).
CREATE TABLE IF NOT EXISTS translations (
  locale TEXT PRIMARY KEY,
  fetched_at TEXT,
  data TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Queues: offline-created records waiting to be pushed to the Frappe server.
-- ---------------------------------------------------------------------------

-- Offline invoice queue. offline_id is the idempotency key used against
-- pos_next.api.invoices.submit_invoice / check_offline_invoice_synced.
CREATE TABLE IF NOT EXISTS invoice_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offline_id TEXT UNIQUE NOT NULL,   -- e.g. OFFLINE-<outlet_code>-<uuid>
  pos_profile TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | synced | failed
  payload TEXT NOT NULL,             -- JSON: {invoice, data} as sent to update_invoice/submit_invoice
  sales_invoice TEXT,                -- real ERPNext name once synced
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_queue_status ON invoice_queue(status);

-- Local-id -> server-id mapping, kept even after invoice_queue row could be pruned.
CREATE TABLE IF NOT EXISTS invoice_id_map (
  offline_id TEXT PRIMARY KEY,
  sales_invoice TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- Offline-created customers, synced via frappe.client.insert once online.
CREATE TABLE IF NOT EXISTS customer_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offline_id TEXT UNIQUE NOT NULL,   -- e.g. OFL-CUST-<uuid>
  status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
  payload TEXT NOT NULL,
  customer_name TEXT,                -- real Customer name once synced
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_queue_status ON customer_queue(status);

-- Draft invoices cache (docstatus=0), for resuming without connectivity.
CREATE TABLE IF NOT EXISTS drafts (
  name TEXT PRIMARY KEY,
  pos_profile TEXT,
  modified TEXT,
  data TEXT NOT NULL
);
