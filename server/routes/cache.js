const express = require("express");
const { getDb } = require("../db/client");

const router = express.Router();

router.get("/items/search", (req, res) => {
  const { q = "", group = "", limit = 50 } = req.query;
  const term = q.toLowerCase();
  let rows = getDb()
    .prepare("SELECT data FROM items" + (group ? " WHERE item_group = ?" : ""))
    .all(...(group ? [group] : []))
    .map((r) => JSON.parse(r.data));
  if (term) {
    rows = rows.filter(
      (i) => i.item_code?.toLowerCase().includes(term) || i.item_name?.toLowerCase().includes(term)
    );
  }
  res.json(rows.slice(0, Number(limit) || 50));
});

router.get("/items/count", (req, res) => {
  const { group = "" } = req.query;
  const row = group
    ? getDb().prepare("SELECT COUNT(*) c FROM items WHERE item_group = ?").get(group)
    : getDb().prepare("SELECT COUNT(*) c FROM items").get();
  res.json({ count: row.c });
});

router.get("/customers/search", (req, res) => {
  const { q = "", limit } = req.query;
  const term = q.toLowerCase();
  let rows = getDb()
    .prepare("SELECT data FROM customers")
    .all()
    .map((r) => JSON.parse(r.data));
  if (term) {
    rows = rows.filter(
      (c) => c.customer_name?.toLowerCase().includes(term) || c.mobile_no?.includes(term)
    );
  }
  // customerSearch.js's loadAllCustomers calls this with limit=0 meaning
  // "no limit" (it wants the FULL customer list once, for instant local
  // search) — `Number(limit) || 50` broke that: 0 is falsy in JS, so it
  // silently capped to the first 50 cached customers (arbitrary SQLite
  // order), making every customer beyond that unsearchable even though it
  // was genuinely present in the local cache.
  const n = limit === undefined ? 50 : Number(limit) || 0;
  res.json(n > 0 ? rows.slice(0, n) : rows);
});

router.get("/payment-methods/:posProfile", (req, res) => {
  const row = getDb()
    .prepare("SELECT data FROM payment_methods WHERE pos_profile = ?")
    .get(req.params.posProfile);
  res.json(row ? JSON.parse(row.data) : []);
});

router.get("/offers", (req, res) => {
  const { pos_profile } = req.query;
  const rows = getDb()
    .prepare("SELECT data FROM offers" + (pos_profile ? " WHERE pos_profile = ?" : ""))
    .all(...(pos_profile ? [pos_profile] : []))
    .map((r) => JSON.parse(r.data));
  res.json(rows);
});

router.delete("/invoice-history", (req, res) => {
  const { pos_profile } = req.query;
  if (pos_profile) {
    getDb().prepare("DELETE FROM invoice_history WHERE pos_profile = ?").run(pos_profile);
  } else {
    getDb().exec("DELETE FROM invoice_history");
  }
  res.json({ success: true });
});

router.get("/status", (req, res) => {
  const db = getDb();
  const itemCount = db.prepare("SELECT COUNT(*) c FROM items").get().c;
  const customerCount = db.prepare("SELECT COUNT(*) c FROM customers").get().c;
  const syncRows = db.prepare("SELECT table_name, last_modified, last_synced_at FROM sync_state").all();
  const lastSync = {};
  for (const r of syncRows) lastSync[r.table_name] = r.last_synced_at;
  res.json({
    ready: itemCount > 0,
    itemCount,
    customerCount,
    lastSync,
  });
});

router.post("/invoice-history", (req, res) => {
  const { invoices, pos_profile } = req.body || {};
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO invoice_history (name, pos_profile, posting_date, customer, modified, data)
    VALUES (@name, @pos_profile, @posting_date, @customer, @modified, @data)
    ON CONFLICT(name) DO UPDATE SET
      pos_profile=excluded.pos_profile, posting_date=excluded.posting_date,
      customer=excluded.customer, modified=excluded.modified, data=excluded.data
  `);
  const now = new Date().toISOString();
  for (const inv of invoices || []) {
    upsert.run({
      name: inv.name,
      pos_profile,
      posting_date: inv.posting_date || null,
      customer: inv.customer || null,
      modified: now,
      data: JSON.stringify(inv),
    });
  }
  res.json({ success: true, count: (invoices || []).length });
});

router.get("/invoice-history", (req, res) => {
  const { pos_profile, limit = 100 } = req.query;
  const rows = getDb()
    .prepare(
      "SELECT data FROM invoice_history" +
        (pos_profile ? " WHERE pos_profile = ?" : "") +
        " ORDER BY posting_date DESC LIMIT ?"
    )
    .all(...(pos_profile ? [pos_profile, Number(limit)] : [Number(limit)]))
    .map((r) => JSON.parse(r.data));
  res.json(rows);
});

router.post("/unpaid-invoices", (req, res) => {
  const { invoices, pos_profile } = req.body || {};
  const db = getDb();
  db.prepare("DELETE FROM unpaid_invoices WHERE pos_profile = ?").run(pos_profile);
  const insert = db.prepare(`
    INSERT INTO unpaid_invoices (name, pos_profile, customer, outstanding_amount, modified, data)
    VALUES (@name, @pos_profile, @customer, @outstanding_amount, @modified, @data)
  `);
  const now = new Date().toISOString();
  for (const inv of invoices || []) {
    insert.run({
      name: inv.name,
      pos_profile,
      customer: inv.customer || null,
      outstanding_amount: Number(inv.outstanding_amount) || 0,
      modified: now,
      data: JSON.stringify(inv),
    });
  }
  res.json({ success: true });
});

router.get("/unpaid-invoices", (req, res) => {
  const { pos_profile, limit = 100 } = req.query;
  const rows = getDb()
    .prepare(
      "SELECT data FROM unpaid_invoices WHERE pos_profile = ? ORDER BY outstanding_amount DESC LIMIT ?"
    )
    .all(pos_profile, Number(limit))
    .map((r) => JSON.parse(r.data));
  res.json(rows);
});

router.get("/unpaid-summary/:posProfile", (req, res) => {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`unpaid_summary_${req.params.posProfile}`);
  res.json(row ? JSON.parse(row.value) : { count: 0, total_outstanding: 0, total_paid: 0 });
});

router.put("/unpaid-summary/:posProfile", (req, res) => {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(`unpaid_summary_${req.params.posProfile}`, JSON.stringify(req.body.value || {}));
  res.json({ success: true });
});

module.exports = router;
