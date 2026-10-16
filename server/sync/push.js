const { getDb } = require("../db/client");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("./ping");
const { pushQueuedShifts, resolveShiftName, isShiftPending } = require("./shifts");

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
  if (payload.invoice?.posa_pos_opening_shift) {
    payload.invoice.posa_pos_opening_shift = resolveShiftName(payload.invoice.posa_pos_opening_shift);
  }

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
    // Shifts opened offline must exist on the server before any invoice that
    // references them is submitted.
    await pushQueuedShifts().catch(() => {});

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM invoice_queue WHERE status = 'pending' ORDER BY id ASC")
      .all();

    const result = { success: 0, failed: 0, skipped: 0, errors: [] };
    for (const row of rows) {
      const shiftName = JSON.parse(row.payload).invoice?.posa_pos_opening_shift;
      if (isShiftPending(shiftName)) {
        result.skipped++;
        continue;
      }
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

const DUPLICATE_CUSTOMER_PATTERNS = ["DuplicateEntryError", "UniqueValidationError", "already exists", "Duplicate entry"];

// Finishes a customer_queue row as synced under `serverName` — shared by the
// plain insert-succeeded path and the duplicate-resolved path below, since
// both need to do the exact same local cleanup/repoint afterward.
function adoptCustomerSyncSuccess(db, row, payload, serverName) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE customer_queue SET status='synced', customer_name=?, updated_at=? WHERE id=?"
  ).run(serverName, now, row.id);

  // Replace the stale local cache row (inserted under the temp name by
  // POST /customers/queue, "so it's searchable immediately") with one
  // under the REAL server name. Nothing used to do this — the temp row
  // just sat there forever, so a later search for this customer (e.g.
  // the cashier re-doing a sale that failed) could still find and select
  // the dead temp id, producing the exact "Could not find Customer:
  // OFL-CUST-..." failure a second time, and feeding offer eligibility
  // checks (e.g. a member discount) whatever customer_group the temp
  // row happened to have instead of the real, possibly since-corrected,
  // ERP value.
  db.prepare("DELETE FROM customers WHERE name = ?").run(payload.name);
  db.prepare(
    `INSERT INTO customers (name, customer_name, mobile_no, email_id, modified, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data, customer_name = excluded.customer_name,
       mobile_no = excluded.mobile_no, email_id = excluded.email_id, modified = excluded.modified`
  ).run(
    serverName,
    payload.customer_name,
    payload.mobile_no || null,
    payload.email_id || null,
    now,
    JSON.stringify({ ...payload, name: serverName })
  );

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
}

// If a Customer with the same custom_kode_pelanggan (the dedup key the UI
// itself checks via isKodePelangganTaken before letting a cashier submit)
// already exists on the server, this finds it. Used when insert fails with
// a duplicate error — see pushQueuedCustomers below.
async function findExistingCustomerByKode(kode) {
  if (!kode) return null;
  const matches = await callMethod("frappe.client.get_list", {
    doctype: "Customer",
    filters: { custom_kode_pelanggan: kode },
    fields: ["name"],
    limit_page_length: 1,
  });
  return matches?.[0]?.name || null;
}

// Push offline-created customers to the server via the generic Frappe
// insert RPC.
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
      adoptCustomerSyncSuccess(db, row, payload, serverName);
      result.success++;
    } catch (err) {
      // A duplicate means this customer already exists on the server —
      // almost certainly because the SAME offline customer got queued
      // twice (e.g. created again after the first attempt appeared to
      // fail/not show up yet). Previously this was just marked 'failed'
      // forever, which permanently orphaned it: the local cache entry
      // under the temp id never resolved to the real one, so any invoice
      // referencing it kept retrying and failing with "Could not find
      // Customer: OFL-CUST-..." indefinitely, even after the REAL customer
      // was sitting right there on the server the whole time. Look it up
      // by custom_kode_pelanggan and, if found, treat it exactly like a
      // successful sync instead of leaving it stuck.
      if (matchesAny(err.message, DUPLICATE_CUSTOMER_PATTERNS)) {
        try {
          const existingName = await findExistingCustomerByKode(payload.custom_kode_pelanggan);
          if (existingName) {
            adoptCustomerSyncSuccess(db, row, payload, existingName);
            result.success++;
            continue;
          }
        } catch {
          // Lookup itself failed (network, etc.) — fall through to the
          // normal failed/retry bookkeeping below.
        }
      }
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
