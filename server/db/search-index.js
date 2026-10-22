const { getDb } = require("./client");

/**
 * In-memory search index for the two hot search paths (items, customers).
 *
 * `LOWER(col) LIKE '%term%'` can't use a b-tree index, so every keystroke
 * was a full scan of ~74k items / ~92k customers on the ONE synchronous
 * SQLite connection — which also lives in Electron's main process, so a slow
 * query stalls everything else (other requests, window input) while it runs.
 *
 * Instead, keep just the searchable columns, pre-lowercased, in plain JS
 * arrays (a few MB) and scan those (~2-5ms), then fetch the full JSON
 * payload for only the rows that matched, by rowid. Rebuilt lazily after the
 * underlying table changes — writers call invalidate().
 */

const indexes = { items: null, customers: null };

function invalidate(table) {
  indexes[table] = null;
  // Rebuild off the request path so the first search after a sync stays fast.
  setImmediate(() => {
    try {
      if (!indexes[table]) build(table);
    } catch {
      // DB closed (reset) — next search rebuilds
    }
  });
}

const SQL = {
  items: `SELECT rowid AS id, item_code, item_name, item_group, variant_of, barcode FROM items`,
  customers: `SELECT rowid AS id, name, customer_name, mobile_no, email_id,
                json_extract(data, '$.custom_kode_pelanggan') AS kode
              FROM customers`,
};
const KEY_COL = { items: "item_code", customers: "name" };
const SORT_COL = { items: "item_name", customers: "customer_name" };

function toEntry(table, r) {
  if (table === "items") {
    return {
      id: r.id,
      key: r.item_code,
      sort: r.item_name || "",
      code: (r.item_code || "").toLowerCase(),
      name: (r.item_name || "").toLowerCase(),
      barcode: (r.barcode || "").toLowerCase(),
      group: r.item_group,
      isVariant: !!r.variant_of,
    };
  }
  return {
    id: r.id,
    key: r.name,
    sort: r.customer_name || "",
    keyLc: (r.name || "").toLowerCase(),
    name: (r.customer_name || "").toLowerCase(),
    mobile: r.mobile_no || "",
    email: (r.email_id || "").toLowerCase(),
    kode: (r.kode || "").toLowerCase(),
  };
}

function build(table) {
  // ORDER BY the display name (indexed), matching the ORDER BY item_name the
  // SQL search used — results come out already sorted.
  indexes[table] = getDb()
    .prepare(`${SQL[table]} ORDER BY ${SORT_COL[table]}`)
    .all()
    .map((r) => toEntry(table, r));
  return indexes[table];
}

// Incremental-pull deltas are usually a handful of rows every ~2 min — patch
// them into the sorted index in place instead of a full rebuild (~200-300ms
// of main-thread time). Large deltas still just rebuild.
function refresh(table, keys) {
  const index = indexes[table];
  if (!index) return;
  if (keys.length > 2000) return invalidate(table);
  const wanted = new Set(keys);
  const kept = index.filter((e) => !wanted.has(e.key));
  const stmt = getDb().prepare(`${SQL[table]} WHERE ${KEY_COL[table]} = ?`);
  for (const key of wanted) {
    const row = stmt.get(key);
    if (!row) continue;
    const entry = toEntry(table, row);
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[mid].sort <= entry.sort) lo = mid + 1;
      else hi = mid;
    }
    kept.splice(lo, 0, entry);
  }
  indexes[table] = kept;
}

function get(table) {
  return indexes[table] || build(table);
}

// Every whitespace-separated word must appear somewhere — so "kapuk bantal"
// finds "BANTAL KAPUK", which a single LIKE '%kapuk bantal%' never did.
function tokens(term) {
  return (term || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function rawRows(table, ids) {
  if (!ids.length) return "[]";
  const stmt = getDb().prepare(`SELECT data FROM ${table} WHERE rowid = ?`);
  const parts = [];
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) parts.push(row.data);
  }
  return `[${parts.join(",")}]`;
}

/**
 * @returns {string} JSON array text of the matching items' `data` payloads
 *   (already JSON in SQLite — no parse/stringify round trip).
 */
function searchItems({ term, group, includeVariants = false, start = 0, limit = 50 }) {
  const words = tokens(term);
  const exact = words.join(" ");
  const ids = [];
  const exactIds = [];
  let skipped = 0;
  for (const it of get("items")) {
    if (!includeVariants && it.isVariant) continue;
    if (group && it.group !== group) continue;
    if (words.length) {
      // Scanner / typed exact code or barcode → always first.
      if (it.code === exact || (it.barcode && it.barcode === exact)) {
        exactIds.push(it.id);
        continue;
      }
      let ok = true;
      for (const w of words) {
        if (!it.name.includes(w) && !it.code.includes(w)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    if (skipped < start) {
      skipped++;
      continue;
    }
    if (ids.length < limit) ids.push(it.id);
    else if (!words.length) break;
  }
  const merged = start === 0 ? [...exactIds, ...ids].slice(0, limit) : ids;
  return rawRows("items", merged);
}

function customerScore(c, term, words) {
  if (c.kode && c.kode === term) return 300;
  if (c.name === term || c.mobile === term) return 290;
  if (c.name.startsWith(term)) return 270;
  if (c.mobile && c.mobile.startsWith(term)) return 250;
  if (c.kode && c.kode.startsWith(term)) return 240;
  for (const w of words) {
    if (
      !c.name.includes(w) &&
      !c.mobile.includes(w) &&
      !c.kode.includes(w) &&
      !c.keyLc.includes(w) &&
      !c.email.includes(w)
    ) {
      return 0;
    }
  }
  return 100;
}

/**
 * @param {number} limit 0 = everything (the renderer's full-list preload).
 * @returns {string} JSON array text.
 */
function searchCustomers({ term, limit = 50 }) {
  const words = tokens(term);
  if (!words.length) {
    const sql = limit > 0 ? "SELECT data FROM customers LIMIT ?" : "SELECT data FROM customers";
    const stmt = getDb().prepare(sql);
    const rows = limit > 0 ? stmt.all(limit) : stmt.all();
    return `[${rows.map((r) => r.data).join(",")}]`;
  }
  const t = words.join(" ");
  const hits = [];
  for (const c of get("customers")) {
    const score = customerScore(c, t, words);
    if (score) hits.push({ id: c.id, score });
  }
  // Stable sort keeps customer_name order within the same score.
  hits.sort((a, b) => b.score - a.score);
  const ids = (limit > 0 ? hits.slice(0, limit) : hits).map((h) => h.id);
  return rawRows("customers", ids);
}

module.exports = { invalidate, refresh, searchItems, searchCustomers };
