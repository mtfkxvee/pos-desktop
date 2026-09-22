const express = require("express");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("../sync/ping");
const { getDb } = require("../db/client");
const {
  pullTaxes,
  pullPaymentMethods,
  pullPosProfile,
  pullPrintFormat,
  pullCompanyAddress,
  pullPinnedItems,
  pullPinnedCategories,
} = require("../sync/pull");

const router = express.Router();

function parseRows(table) {
  return getDb()
    .prepare(`SELECT data FROM ${table}`)
    .all()
    .map((r) => JSON.parse(r.data));
}

// Master-data reads: served from local SQLite ALWAYS, never waiting on a
// live server round-trip — the cache is the source of truth for the UI, kept
// fresh in the background by the pull sync (server/sync/pull.js, every ~2
// min + on app start/login), not by blocking reads on network calls. This
// is what makes item/customer search instant regardless of connectivity,
// matching the same offline-first principle as invoice submission (always
// local first, sync happens separately/later, never on the critical path).
const OFFLINE_FALLBACK = {
  // Mirrors the server-side filters that are actually used by the UI
  // (search_term, item_group, start/limit pagination) — this is the DEFAULT
  // path now (not just an offline edge case), so it needs to behave close
  // enough to the real pos_next.api.items.get_items that category browsing
  // and search don't regress. It's still a simpler match than the server's
  // relevance-scored search — exact/substring only, no bundle-availability
  // or variant-attribute logic — a deliberate trade for instant, always-on
  // results.
  "pos_next.api.items.get_items"(params) {
    const term = (params?.search_term || "").trim().toLowerCase();
    const itemGroup = params?.item_group;
    const start = params?.start || 0;
    const limit = params?.limit || 50;
    // Real get_items/get_items_bulk hide variant SKUs from normal catalog
    // browsing by default (surfaced only via the template's variant-picker
    // dialog) — match that here too, now that pullItems() caches variants
    // locally (for that dialog's offline fallback) alongside everything
    // else. Without this filter, variants would leak into the main grid.
    const includeVariants = !!Number(params?.include_variants);

    const conditions = [];
    const args = [];
    if (!includeVariants) {
      conditions.push("(variant_of IS NULL OR variant_of = '')");
    }
    if (itemGroup) {
      conditions.push("item_group = ?");
      args.push(itemGroup);
    }
    if (term) {
      conditions.push("(LOWER(item_code) LIKE ? OR LOWER(item_name) LIKE ?)");
      args.push(`%${term}%`, `%${term}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = getDb()
      .prepare(`SELECT data FROM items ${where} ORDER BY item_name LIMIT ? OFFSET ?`)
      .all(...args, limit, start);
    return rows.map((r) => JSON.parse(r.data));
  },
  "pos_next.api.items.get_items_bulk"(params) {
    const includeVariants = !!Number(params?.include_variants);
    const rows = parseRows("items");
    return includeVariants ? rows : rows.filter((i) => !i.variant_of);
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
    // Mirrors the real pos_next.api.customers.get_customers: limit=0 means
    // "no limit" (used by customerSearch.js's loadAllCustomers to pull the
    // FULL customer list once for instant local search). `params?.limit || 50`
    // broke this — 0 is falsy in JS, so it silently fell back to 50, meaning
    // only the first 50 cached customers (by SQLite insertion order) were
    // ever loaded client-side. Any customer beyond that was "downloaded"
    // (present in the local cache table) but invisible to search.
    const limit = params?.limit === undefined ? 50 : Number(params.limit) || 0;
    return limit > 0 ? rows.slice(0, limit) : rows;
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
  // Pinned items/categories were the one thing on the item grid NOT cache-
  // first — they went through the generic online-first path below (ping +
  // real round-trip), so the pinned row visibly popped in after the rest of
  // the (already cache-first) item grid had rendered. Cached per-profile by
  // server/sync/pull.js's pullPinnedItems/pullPinnedCategories, kept fresh
  // by the same background pull cycle as everything else here.
  "pos_next.api.pinned_items.get_pinned_items"(params) {
    return getSetting(`pinned_items:${params?.pos_profile}`) || [];
  },
  // The real backend's get_pinned_item_details re-fetches each pinned code
  // through get_items (a full search round-trip per code) — pointless here
  // since the full item objects are already sitting in our own items cache.
  "pos_next.api.pinned_items.get_pinned_item_details"(params) {
    let codes = params?.item_codes;
    if (typeof codes === "string") {
      try {
        codes = JSON.parse(codes);
      } catch {
        codes = [];
      }
    }
    if (!Array.isArray(codes) || !codes.length) return [];
    const stmt = getDb().prepare("SELECT data FROM items WHERE item_code = ?");
    return codes
      .map((code) => {
        const row = stmt.get(code);
        return row ? JSON.parse(row.data) : null;
      })
      .filter(Boolean);
  },
  "pos_next.api.pinned_categories.get_pinned_categories"(params) {
    return getSetting(`pinned_categories:${params?.pos_profile}`) || [];
  },
};

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, JSON.stringify(value));
}

// Shift status: NOT unconditionally cache-first like master data above
// (shift state needs to be timely — e.g. reflect a shift closed from Desk or
// another device), so this stays online-first. But the fallback used to be
// the renderer's own browser localStorage (see the old useShift.js onError
// handler), which blindly trusted whatever was left over from a PREVIOUS
// session/test — causing a stale "shift open" state (wrong POS Profile) to
// bypass the shift-opening screen entirely on a fresh/no-shift login. Fixed
// by mirroring every genuine server answer into SQLite here (write-through,
// server-side, invisible to the renderer) and falling back to THAT instead —
// reliable, and explicitly cleared to null on an honest "no open shift"
// response so old data can never masquerade as current.
const STALE_OK_FALLBACK = {
  "pos_next.api.shifts.check_opening_shift"() {
    return getSetting("shift_state");
  },
  "pos_next.api.pos_profile.get_pos_profiles"() {
    const rows = getDb().prepare("SELECT data FROM pos_profiles").all();
    return rows
      .map((r) => JSON.parse(r.data)?.pos_profile)
      .filter(Boolean)
      .map((p) => ({
        name: p.name,
        company: p.company,
        currency: p.currency,
        warehouse: p.warehouse,
        selling_price_list: p.selling_price_list,
        write_off_account: p.write_off_account,
        write_off_cost_center: p.write_off_cost_center,
      }));
  },
};

const SHIFT_MIRROR_METHODS = new Set([
  "pos_next.api.shifts.check_opening_shift",
  "pos_next.api.shifts.create_opening_shift",
]);

// The cashier can open a shift under ANY POS Profile they have access to
// (get_pos_profiles returns the full list) — not just the one profile the
// device happened to be set up with. pull.js's scheduled sync only ever
// downloads master data (taxes, payment methods, profile details) for that
// single configured profile, so opening a shift under a different one left
// it with no local data at all (Speed Mode readiness stuck on "fetching",
// payment methods empty). Whenever a genuinely-open shift names a profile
// we haven't cached yet, pull that profile's data too, in the background —
// doesn't block the response, and only runs once per profile (checked via
// the pos_profiles cache table).
function ensureProfileDataCached(profileName) {
  if (!profileName) return;

  // Pinned items/categories are cheap and can change independently of the
  // rest of the profile — always best-effort refresh them on every shift
  // check, NOT gated behind the "already cached" guard below. A profile
  // that got cached in an earlier session (before pinned items were part of
  // this pull) would otherwise never pick them up: the guard saw the profile
  // already had a pos_profiles row and skipped the whole pull, silently
  // leaving pinned_items/pinned_categories empty in the cache forever even
  // though the real server had dozens of pinned items for it.
  Promise.all([pullPinnedItems(profileName), pullPinnedCategories(profileName)]).catch(() => {});

  const already = getDb()
    .prepare("SELECT 1 FROM pos_profiles WHERE name = ?")
    .get(profileName);
  if (already) return;
  Promise.all([
    pullTaxes(profileName),
    pullPaymentMethods(profileName),
    pullPosProfile(profileName),
  ])
    .then(() => Promise.all([pullPrintFormat(profileName), pullCompanyAddress(profileName)]))
    .catch(() => {});
}

router.post("/:method", async (req, res) => {
  const method = req.params.method;
  const params = req.body || {};

  // Offline-first: master-data reads never touch the network, so search/
  // browse is instant and identical whether online or offline. The
  // background pull sync is what keeps this data current, not this request.
  if (OFFLINE_FALLBACK[method]) {
    try {
      return res.json({ message: OFFLINE_FALLBACK[method](params), source: "cache" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const online = await pingServer();

  if (!online) {
    if (STALE_OK_FALLBACK[method]) {
      return res.json({ message: STALE_OK_FALLBACK[method](params), offline: true });
    }
    return res.status(503).json({
      error: "Fitur ini butuh koneksi internet (belum didukung saat offline)",
    });
  }

  try {
    const result = await callMethod(method, params);

    // Write-through: keep the local shift-state mirror in sync with every
    // genuine server answer, including an honest "no shift" (null) —
    // otherwise a previously-cached open shift would outlive its closure.
    // Only ever store something with a real pos_opening_shift — never a
    // bare truthy-but-empty value (e.g. `{}` from a response-parsing edge
    // case), which would otherwise masquerade as "a shift is open".
    if (SHIFT_MIRROR_METHODS.has(method)) {
      setSetting("shift_state", result?.pos_opening_shift ? result : null);
      ensureProfileDataCached(result?.pos_profile?.name);
    }
    if (method === "pos_next.api.shifts.submit_closing_shift") {
      setSetting("shift_state", null);
    }
    // Same write-through idea for pin/unpin: reflect it in the cache
    // immediately instead of waiting for the next ~2 min pull cycle, so a
    // toggle right before going offline isn't lost from the cached list.
    if (method === "pos_next.api.pinned_items.toggle_pinned_item" && params?.pos_profile) {
      setSetting(`pinned_items:${params.pos_profile}`, result?.pinned_items || []);
    }
    if (method === "pos_next.api.pinned_categories.toggle_pinned_category" && params?.pos_profile) {
      setSetting(`pinned_categories:${params.pos_profile}`, result?.pinned_categories || []);
    }

    return res.json({ message: result });
  } catch (err) {
    if (STALE_OK_FALLBACK[method]) {
      return res.json({ message: STALE_OK_FALLBACK[method](params), offline: true });
    }
    return res.status(502).json({ error: err.message });
  }
});

module.exports = router;
