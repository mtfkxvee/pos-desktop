const express = require("express");
const crypto = require("crypto");
const { getDb } = require("../db/client");

const router = express.Router();

router.get("/queue", (req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM customer_queue WHERE status = 'pending' ORDER BY id DESC")
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      offline_id: r.offline_id,
      data: JSON.parse(r.payload),
      synced: false,
    }))
  );
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
