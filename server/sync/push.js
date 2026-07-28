const { getDb } = require("../db/client");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("./ping");

const MAX_RETRY_COUNT = 3;
const MAX_IN_PROGRESS_RETRIES = 3;
const IN_PROGRESS_WAIT_MS = 2000;

// Mirrors the patterns pos_next.api.invoices.submit_invoice already throws,
// see C:\Users\User\pos\POS\src\utils\offline\sync.js for the original logic.
const DUPLICATE_ERROR_PATTERNS = ["DUPLICATE_OFFLINE_INVOICE", "already been synced"];
const SYNC_IN_PROGRESS_PATTERNS = ["SYNC_IN_PROGRESS", "currently being processed"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function matchesAny(message, patterns) {
  return patterns.some((p) => message.includes(p));
}

async function checkOfflineIdSynced(offlineId) {
  try {
    const res = await callMethod("pos_next.api.invoices.check_offline_invoice_synced", {
      offline_id: offlineId,
    });
    return res || { synced: false };
  } catch {
    // If the check itself fails, fall through to a normal submit attempt —
    // the server-side dedup ledger (Offline Invoice Sync) still protects us.
    return { synced: false };
  }
}

function markInvoiceSynced(row, salesInvoice) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE invoice_queue SET status='synced', sales_invoice=?, updated_at=? WHERE id=?"
  ).run(salesInvoice, now, row.id);
  db.prepare(
    `INSERT INTO invoice_id_map (offline_id, sales_invoice, synced_at) VALUES (?, ?, ?)
     ON CONFLICT(offline_id) DO UPDATE SET sales_invoice=excluded.sales_invoice, synced_at=excluded.synced_at`
  ).run(row.offline_id, salesInvoice, now);
}

function handleSyncFailure(row, errorMessage) {
  const db = getDb();
  const now = new Date().toISOString();
  const retryCount = (row.retry_count || 0) + 1;
  const status = retryCount >= MAX_RETRY_COUNT ? "failed" : "pending";
  db.prepare(
    "UPDATE invoice_queue SET retry_count=?, status=?, last_error=?, updated_at=? WHERE id=?"
  ).run(retryCount, status, errorMessage, now, row.id);

  if (status === "failed") {
    callMethod("pos_next.api.utilities.log_client_error", {
      title: "Offline Invoice Sync Failed",
      message: `Invoice failed to sync after ${MAX_RETRY_COUNT} attempts: ${errorMessage}`,
      context: JSON.stringify({
        offline_id: row.offline_id,
        retry_count: retryCount,
        error: errorMessage,
      }),
    }).catch(() => {});
  }
}

/**
 * Sync a single queued invoice. ALWAYS checks check_offline_invoice_synced
 * first (per the approved plan) so a retry after a previously-successful but
 * unacknowledged submit doesn't double-submit — this lines up with the
 * 5-minute pending-expiry window on the "Offline Invoice Sync" doctype.
 */
async function syncInvoiceToServer(row, retryCount = 0) {
  const syncStatus = await checkOfflineIdSynced(row.offline_id);
  if (syncStatus.synced) {
    markInvoiceSynced(row, syncStatus.sales_invoice);
    return { status: "skipped" };
  }

  const payload = JSON.parse(row.payload);

  try {
    const response = await callMethod("pos_next.api.invoices.submit_invoice", {
      data: JSON.stringify(payload),
    });
    const serverName = response?.name || response?.message;
    if (!serverName) throw new Error("Invalid server response");
    markInvoiceSynced(row, serverName);
    return { status: "success" };
  } catch (err) {
    const message = err.message || String(err);

    if (matchesAny(message, DUPLICATE_ERROR_PATTERNS)) {
      const match = message.match(/Sales Invoice: (\S+)/);
      markInvoiceSynced(row, match?.[1] || null);
      return { status: "skipped" };
    }

    if (matchesAny(message, SYNC_IN_PROGRESS_PATTERNS) && retryCount < MAX_IN_PROGRESS_RETRIES) {
      await sleep(IN_PROGRESS_WAIT_MS);
      return syncInvoiceToServer(row, retryCount + 1);
    }

    throw err;
  }
}

let syncing = false;

async function pushQueuedInvoices() {
  if (syncing) return { success: 0, failed: 0, skipped: 0, alreadyRunning: true };
  syncing = true;
  try {
    const online = await pingServer();
    if (!online) return { success: 0, failed: 0, skipped: 0, offline: true };

    // Customers first so any queued invoice referencing a temp customer id
    // gets repointed to the real one before we try to submit it.
    await pushQueuedCustomers().catch(() => {});

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM invoice_queue WHERE status = 'pending' ORDER BY id ASC")
      .all();

    const result = { success: 0, failed: 0, skipped: 0, errors: [] };
    for (const row of rows) {
      try {
        const r = await syncInvoiceToServer(row);
        if (r.status === "success") result.success++;
        else if (r.status === "skipped") result.skipped++;
      } catch (err) {
        handleSyncFailure(row, err.message || String(err));
        result.failed++;
        result.errors.push({ offlineId: row.offline_id, error: err.message });
      }
    }
    return result;
  } finally {
    syncing = false;
  }
}

function getQueueStatus() {
  const db = getDb();
  const rows = db
    .prepare("SELECT status, COUNT(*) as count FROM invoice_queue GROUP BY status")
    .all();
  const counts = { pending: 0, synced: 0, failed: 0 };
  for (const r of rows) counts[r.status] = r.count;
  return counts;
}

// Push offline-created customers to the server via the generic Frappe
// insert RPC. Simplified vs. the old app's 3-tier fallback matching
// (kode_pelanggan/mobile/name) — this is a secondary path (most sales use an
// existing or walk-in customer), so on a plain duplicate error we just mark
// it failed for manual follow-up rather than attempting to auto-resolve.
async function pushQueuedCustomers() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM customer_queue WHERE status = 'pending'").all();
  const result = { success: 0, failed: 0 };

  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    const doc = { ...payload, doctype: "Customer" };
    delete doc.offline_id;
    delete doc.name;

    try {
      const created = await callMethod("frappe.client.insert", { doc });
      const serverName = created?.name;
      if (!serverName) throw new Error("Respon insert customer tidak valid");

      const now = new Date().toISOString();
      db.prepare(
        "UPDATE customer_queue SET status='synced', customer_name=?, updated_at=? WHERE id=?"
      ).run(serverName, now, row.id);

      // Repoint any queued invoices that reference the temp customer id.
      const invoiceRows = db.prepare("SELECT id, payload FROM invoice_queue WHERE status='pending'").all();
      for (const invRow of invoiceRows) {
        const invPayload = JSON.parse(invRow.payload);
        if (invPayload.invoice?.customer === payload.name) {
          invPayload.invoice.customer = serverName;
          db.prepare("UPDATE invoice_queue SET payload=? WHERE id=?").run(
            JSON.stringify(invPayload),
            invRow.id
          );
        }
      }
      result.success++;
    } catch (err) {
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE customer_queue SET retry_count=retry_count+1, last_error=?, updated_at=? WHERE id=?"
      ).run(err.message, now, row.id);
      result.failed++;
    }
  }
  return result;
}

module.exports = { pushQueuedInvoices, pushQueuedCustomers, getQueueStatus, checkOfflineIdSynced };
