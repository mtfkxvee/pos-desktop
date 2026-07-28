const express = require("express");
const crypto = require("crypto");
const { getDb } = require("../db/client");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("../sync/ping");
const { loadDeviceConfig } = require("../auth/device-setup");

const router = express.Router();

function generateOfflineId(outletCode) {
  return `OFFLINE-${outletCode || "UNKNOWN"}-${crypto.randomUUID()}`;
}

function queueInvoiceLocally({ invoice, data, device }) {
  const offlineId = generateOfflineId(device?.outletCode);
  const db = getDb();
  const now = new Date().toISOString();
  const payload = {
    invoice: { ...invoice, offline_id: offlineId },
    data: data || {},
  };
  db.prepare(
    `INSERT INTO invoice_queue (offline_id, pos_profile, status, payload, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`
  ).run(offlineId, invoice.pos_profile || device?.posProfile || null, JSON.stringify(payload), now, now);
  return offlineId;
}

// Submit a sale. Online: goes straight to update_invoice + submit_invoice.
// Offline (or if the online attempt itself fails to reach the server): falls
// back to the local queue so the cashier is never blocked mid-sale.
router.post("/", async (req, res) => {
  const { invoice, data } = req.body || {};
  if (!invoice?.items?.length) {
    return res.status(400).json({ error: "invoice.items tidak boleh kosong" });
  }

  const device = loadDeviceConfig();
  const online = await pingServer();

  if (online) {
    try {
      const draft = await callMethod("pos_next.api.invoices.update_invoice", {
        data: JSON.stringify(invoice),
      });
      const draftName = draft?.name || invoice.name;
      const submitted = await callMethod("pos_next.api.invoices.submit_invoice", {
        data: JSON.stringify({ invoice: { ...invoice, name: draftName }, data: data || {} }),
      });
      return res.json({
        ok: true,
        online: true,
        sales_invoice: submitted?.name || submitted?.message,
      });
    } catch (err) {
      const offlineId = queueInvoiceLocally({ invoice, data, device });
      return res.json({
        ok: true,
        online: false,
        offline_id: offlineId,
        note: `Submit online gagal (${err.message}), disimpan ke antrian offline`,
      });
    }
  }

  const offlineId = queueInvoiceLocally({ invoice, data, device });
  res.json({ ok: true, online: false, offline_id: offlineId });
});

router.get("/queue-status", (req, res) => {
  const { getQueueStatus } = require("../sync/push");
  res.json(getQueueStatus());
});

// List pending (not-yet-synced) queued invoices, for the "Offline Invoices"
// dialog — same shape saveOfflineInvoice()/getOfflineInvoices() used to
// return from the old Dexie queue.
router.get("/queue", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM invoice_queue WHERE status != 'synced' ORDER BY id DESC")
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      offline_id: r.offline_id,
      data: JSON.parse(r.payload).invoice,
      timestamp: new Date(r.created_at).getTime(),
      synced: false,
      retry_count: r.retry_count,
      error: r.last_error,
    }))
  );
});

// Direct enqueue — used by the renderer when it has already decided (via
// /sync/status) that it's offline, equivalent to the old saveOfflineInvoice().
router.post("/queue", (req, res) => {
  const device = loadDeviceConfig();
  const { invoice, data } = req.body || {};
  if (!invoice?.items?.length) {
    return res.status(400).json({ error: "invoice.items tidak boleh kosong" });
  }
  const offlineId = queueInvoiceLocally({ invoice, data, device });
  res.json({ success: true, offline_id: offlineId });
});

router.delete("/queue/:id", (req, res) => {
  getDb().prepare("DELETE FROM invoice_queue WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
