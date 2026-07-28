const express = require("express");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("../sync/ping");
const { getDb } = require("../db/client");

const router = express.Router();

function parseRows(table) {
  return getDb()
    .prepare(`SELECT data FROM ${table}`)
    .all()
    .map((r) => JSON.parse(r.data));
}

// Methods with a local SQLite fallback for when the real Frappe server is
// unreachable. Everything else genuinely requires connectivity (matches the
// original scope: only the sale-critical path — items, customers, pricing,
// tax, pos profile, stock estimate, invoice submit — needs to work offline).
const OFFLINE_FALLBACK = {
  "pos_next.api.items.get_items"(params) {
    const term = (params?.search_term || "").toLowerCase();
    let rows = parseRows("items");
    if (term) {
      rows = rows.filter(
        (i) =>
          i.item_code?.toLowerCase().includes(term) ||
          i.item_name?.toLowerCase().includes(term)
      );
    }
    return rows.slice(0, params?.limit || 50);
  },
  "pos_next.api.items.get_items_bulk"(params) {
    return parseRows("items");
  },
  "pos_next.api.items.search_by_barcode"(params) {
    const rows = parseRows("items");
    return rows.find((i) => i.barcode === params?.barcode) || null;
  },
  "pos_next.api.customers.get_customers"(params) {
    const term = (params?.search_term || "").toLowerCase();
    let rows = parseRows("customers");
    if (term) {
      rows = rows.filter(
        (c) =>
          c.customer_name?.toLowerCase().includes(term) ||
          c.mobile_no?.includes(term)
      );
    }
    return rows.slice(0, params?.limit || 50);
  },
  "pos_next.api.pos_profile.get_taxes"(params) {
    const row = getDb()
      .prepare("SELECT data FROM pos_taxes WHERE pos_profile = ?")
      .get(params?.pos_profile);
    return row ? JSON.parse(row.data) : [];
  },
  "pos_next.api.pos_profile.get_payment_methods"(params) {
    const row = getDb()
      .prepare("SELECT data FROM payment_methods WHERE pos_profile = ?")
      .get(params?.pos_profile);
    return row ? JSON.parse(row.data) : [];
  },
  "pos_next.api.pos_profile.get_pos_profile_data"(params) {
    const row = getDb()
      .prepare("SELECT data FROM pos_profiles WHERE name = ?")
      .get(params?.pos_profile);
    return row ? JSON.parse(row.data) : null;
  },
};

router.post("/:method", async (req, res) => {
  const method = req.params.method;
  const params = req.body || {};
  const online = await pingServer();

  if (online) {
    try {
      const result = await callMethod(method, params);
      return res.json({ message: result });
    } catch (err) {
      if (OFFLINE_FALLBACK[method]) {
        try {
          return res.json({ message: OFFLINE_FALLBACK[method](params), offline_fallback: true });
        } catch {}
      }
      return res.status(502).json({ error: err.message });
    }
  }

  if (OFFLINE_FALLBACK[method]) {
    try {
      return res.json({ message: OFFLINE_FALLBACK[method](params), offline: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(503).json({
    error: "Fitur ini butuh koneksi internet (belum didukung saat offline)",
  });
});

module.exports = router;
