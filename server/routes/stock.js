const express = require("express");
const { getDb } = require("../db/client");

const router = express.Router();

// Local stock is an ESTIMATE only (per the original scope — no real-time
// accuracy, no locking). This just decrements the cached qty so the UI has a
// plausible number between syncs; the server-side pull (see
// server/sync/pull.js) periodically overwrites it with the real figure.
router.post("/decrement", (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items harus array" });

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO stock (item_code, warehouse, actual_qty, modified, data)
    VALUES (@item_code, @warehouse, @qty, @modified, @data)
    ON CONFLICT(item_code, warehouse) DO UPDATE SET
      actual_qty = actual_qty - @qty,
      modified = @modified
  `);

  const now = new Date().toISOString();
  for (const item of items) {
    if (!item.item_code || !item.warehouse) continue;
    const qty = Number(item.qty || item.quantity || 0);
    upsert.run({
      item_code: item.item_code,
      warehouse: item.warehouse,
      qty,
      modified: now,
      data: JSON.stringify({ item_code: item.item_code, warehouse: item.warehouse, actual_qty: -qty }),
    });
  }
  res.json({ success: true });
});

router.get("/:itemCode/:warehouse", (req, res) => {
  const row = getDb()
    .prepare("SELECT actual_qty FROM stock WHERE item_code = ? AND warehouse = ?")
    .get(req.params.itemCode, req.params.warehouse);
  res.json({ qty: row?.actual_qty || 0 });
});

module.exports = router;
