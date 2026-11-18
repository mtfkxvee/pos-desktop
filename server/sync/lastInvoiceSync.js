// When an invoice last reached the ERP — by any path: the direct online
// submit, the offline queue push, or a renderer call to submit_invoice
// through the RPC proxy. Closing a shift has to wait a while after this so
// the ERP has finished posting the last sale before the closing totals it.
// Kept in the settings table (not memory) so an app restart can't skip the wait.
const { getDb } = require("../db/client");

const KEY = "last_invoice_synced_at";
const CLOSING_WAIT_MS = 60_000;

function markInvoiceReachedServer() {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(KEY, JSON.stringify(new Date().toISOString()));
}

function getLastInvoiceSyncedAt() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY);
  return row ? JSON.parse(row.value) : null;
}

// Milliseconds the cashier still has to wait before closing; 0 when free to close.
function closingWaitRemainingMs() {
  const last = Date.parse(getLastInvoiceSyncedAt() || "");
  if (!last) return 0;
  return Math.max(0, last + CLOSING_WAIT_MS - Date.now());
}

module.exports = { markInvoiceReachedServer, getLastInvoiceSyncedAt, closingWaitRemainingMs, CLOSING_WAIT_MS };
