const express = require("express");
const { getDb } = require("../db/client");
const { searchItems, searchCustomers } = require("../db/search-index");

const router = express.Router();

router.get("/items/search", (req, res) => {
  const { q = "", group = "", limit = 50 } = req.query;
  // In-memory index (server/db/search-index.js), not a LIKE '%term%' full
  // scan. Variants stay included, as this route always did.
  res.type("json").send(
    searchItems({ term: q, group: group || null, includeVariants: true, limit: Number(limit) || 50 })
  );
});

// Offline fallback for the "Create Customer" dialog's Customer Group
// dropdown — that dropdown's options normally come from a live-only
// frappe.client.get_list call, so offline it rendered with ZERO options and
// customer_group silently defaulted to "Individual". That wrong value then
// synced straight through to the real ERP record with nothing to catch it
// (customer_group-gated offers, e.g. a member discount, require matching
// against the real value, so a customer created offline this way could
// never qualify again). Derived from customer_group values already present
// on customers cached locally — no separate table needed.
router.get("/customer-groups", (req, res) => {
  // DISTINCT in SQL — was JSON.parse-ing every one of ~90k customers.
  const groups = getDb()
    .prepare(
      `SELECT DISTINCT json_extract(data, '$.customer_group') AS g FROM customers
       WHERE json_valid(data) AND g IS NOT NULL AND g != '' ORDER BY g`
    )
    .all()
    .map((r) => r.g);
  res.json(groups);
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
  // customerSearch.js's loadAllCustomers calls this with limit=0 meaning
  // "no limit" (the FULL list, for instant local search) — 0 must not fall
  // back to 50. Sent as the raw stored JSON (no parse/stringify of ~90k rows).
  const n = limit === undefined ? 50 : Number(limit) || 0;
  res.type("json").send(searchCustomers({ term: q, limit: n }));
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
