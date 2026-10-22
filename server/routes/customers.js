const express = require("express");
const crypto = require("crypto");
const { getDb } = require("../db/client");
const { refresh: refreshSearch } = require("../db/search-index");

const router = express.Router();

// Pending AND failed (not 'synced') — a failed customer used to be
// invisible: it just retried silently forever with nothing in the UI to
// show for it (see server/sync/push.js). Now it's listed here the same way
// OfflineInvoicesDialog.vue already lists failed invoices, with enough to
// show an error and offer a retry.
router.get("/queue", (req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM customer_queue WHERE status != 'synced' ORDER BY id DESC")
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      offline_id: r.offline_id,
      data: JSON.parse(r.payload),
      status: r.status,
      retry_count: r.retry_count,
      error: r.last_error,
      synced: false,
    }))
  );
});

// Mirrors /invoices/queue/:id/retry — resets retry_count so a failed
// customer gets the full MAX_RETRY_COUNT attempts again on the next sync.
router.post("/queue/:id/retry", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT id FROM customer_queue WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Antrian customer tidak ditemukan" });
  db.prepare(
    "UPDATE customer_queue SET status='pending', retry_count=0, last_error=NULL, updated_at=? WHERE id=?"
  ).run(new Date().toISOString(), row.id);
  res.json({ success: true });
});

// Discards a stuck customer_queue entry (e.g. a genuine data problem the
// cashier would rather just redo online than keep retrying) and its
// matching temp row in the customers cache, so it stops showing up in
// search. Does NOT touch any invoice still referencing the temp id —
// that's handled separately via the Offline Invoices dialog, same as any
// other invoice sync problem.
router.delete("/queue/:id", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT payload FROM customer_queue WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Antrian customer tidak ditemukan" });
  const payload = JSON.parse(row.payload);
  db.prepare("DELETE FROM customer_queue WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM customers WHERE name = ?").run(payload.name);
  refreshSearch("customers", [payload.name]);
  res.json({ success: true });
});

router.post("/queue", (req, res) => {
  const customerData = req.body || {};
  if (!customerData.customer_name) {
    return res.status(400).json({ error: "customer_name wajib diisi" });
  }
  const offlineId = `OFL-CUST-${crypto.randomUUID()}`;
  const tempName = `OFL-CUST-${Date.now()}`;
  const payload = { ...customerData, name: tempName, offline_id: offlineId };

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO customer_queue (offline_id, status, payload, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)"
  ).run(offlineId, JSON.stringify(payload), now, now);

  // Also surface it immediately in the customers cache so it's searchable.
  db.prepare(
    `INSERT INTO customers (name, customer_name, mobile_no, email_id, modified, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data`
  ).run(tempName, payload.customer_name, payload.mobile_no || null, payload.email_id || null, now, JSON.stringify(payload));
  refreshSearch("customers", [tempName]);

  res.json({ success: true, offline_id: offlineId, name: tempName, customer_name: payload.customer_name });
});

router.get("/queue/kode-taken/:code", (req, res) => {
  const code = (req.params.code || "").trim().toLowerCase();
  const db = getDb();
  const cached = db
    .prepare("SELECT data FROM customers")
    .all()
    .some((r) => (JSON.parse(r.data).custom_kode_pelanggan || "").trim().toLowerCase() === code);
  const pending = db
    .prepare("SELECT payload FROM customer_queue WHERE status = 'pending'")
    .all()
    .some((r) => (JSON.parse(r.payload).custom_kode_pelanggan || "").trim().toLowerCase() === code);
  res.json({ taken: cached || pending });
});

module.exports = router;
