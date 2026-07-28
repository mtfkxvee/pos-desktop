const express = require("express");
const { getDb } = require("../db/client");

const router = express.Router();

// Tables safe to expose via the generic Dexie-compatibility shim (see
// renderer/src/utils/offline/db.js). Each maps to {pk, jsonCol} so the
// generic route knows how to read/write full "documents".
const TABLE_META = {
  items: { pk: "item_code", jsonCol: "data" },
  customers: { pk: "name", jsonCol: "data" },
  offers: { pk: "name", jsonCol: "data" },
  invoice_history: { pk: "name", jsonCol: "data" },
  unpaid_invoices: { pk: "name", jsonCol: "data" },
  drafts: { pk: "name", jsonCol: "data" },
  translations: { pk: "locale", jsonCol: "data" },
};

function meta(table) {
  const m = TABLE_META[table];
  if (!m) throw new Error(`Table "${table}" tidak diizinkan diakses via /db generic route`);
  return m;
}

router.get("/:table", (req, res) => {
  try {
    const { jsonCol } = meta(req.params.table);
    const rows = getDb()
      .prepare(`SELECT ${jsonCol} as blob FROM ${req.params.table}`)
      .all()
      .map((r) => JSON.parse(r.blob));
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:table/:key", (req, res) => {
  try {
    const { pk, jsonCol } = meta(req.params.table);
    const row = getDb()
      .prepare(`SELECT ${jsonCol} as blob FROM ${req.params.table} WHERE ${pk} = ?`)
      .get(req.params.key);
    res.json(row ? JSON.parse(row.blob) : null);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/:table/:key", (req, res) => {
  try {
    const { pk, jsonCol } = meta(req.params.table);
    const doc = { ...(req.body || {}), [pk]: req.params.key };
    getDb()
      .prepare(
        `INSERT INTO ${req.params.table} (${pk}, ${jsonCol}) VALUES (?, ?)
         ON CONFLICT(${pk}) DO UPDATE SET ${jsonCol} = excluded.${jsonCol}`
      )
      .run(req.params.key, JSON.stringify(doc));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:table/:key", (req, res) => {
  try {
    const { pk } = meta(req.params.table);
    getDb().prepare(`DELETE FROM ${req.params.table} WHERE ${pk} = ?`).run(req.params.key);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:table", (req, res) => {
  try {
    meta(req.params.table);
    getDb().exec(`DELETE FROM ${req.params.table}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
