const { getDb } = require("../db/client");
const { callMethod } = require("../frappe-client");
const { loadDeviceConfig } = require("../auth/device-setup");

function getSyncState(table) {
  const db = getDb();
  return db.prepare("SELECT * FROM sync_state WHERE table_name = ?").get(table);
}

function setSyncState(table, { lastModified, lastSyncedAt }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO sync_state (table_name, last_modified, last_synced_at) VALUES (?, ?, ?)
     ON CONFLICT(table_name) DO UPDATE SET
       last_modified = excluded.last_modified,
       last_synced_at = excluded.last_synced_at`
  ).run(table, lastModified || null, lastSyncedAt || null);
}

function maxModified(rows) {
  return rows.reduce(
    (max, r) => (r.modified && (!max || r.modified > max) ? r.modified : max),
    null
  );
}

// --- Incremental pulls (support modified_after) -----------------------------

async function pullItems(posProfile) {
  const state = getSyncState("items");
  const items = await callMethod("pos_next.api.items.get_items_bulk", {
    pos_profile: posProfile,
    modified_after: state?.last_modified || null,
    start: 0,
    limit: 100000,
    // Real get_items/get_items_bulk exclude variant SKUs by default (they're
    // meant to stay hidden from the main catalog, surfaced only via the
    // template's variant-picker dialog) — but that dialog's OWN offline
    // fallback (ItemSelectionDialog.vue's getCachedVariants) reads from this
    // SAME local items cache. Without include_variants here, variants were
    // never cached at all: the variant picker would silently show zero
    // options offline, leaving the cashier unable to add that item to the
    // cart. rpc.js's get_items/get_items_bulk cache-first handlers filter
    // variants back out for normal catalog browsing, matching real backend
    // default behavior — this flag only controls what gets STORED locally.
    include_variants: 1,
  });
  const rows = items || [];

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO items (item_code, item_name, item_group, variant_of, barcode, modified, data)
    VALUES (@item_code, @item_name, @item_group, @variant_of, @barcode, @modified, @data)
    ON CONFLICT(item_code) DO UPDATE SET
      item_name = excluded.item_name,
      item_group = excluded.item_group,
      variant_of = excluded.variant_of,
      barcode = excluded.barcode,
      modified = excluded.modified,
      data = excluded.data
  `);
  db.exec("BEGIN");
  try {
    for (const item of rows) {
      upsert.run({
        item_code: item.item_code,
        item_name: item.item_name || null,
        item_group: item.item_group || null,
        variant_of: item.variant_of || null,
        barcode: item.barcode || null,
        modified: item.modified || null,
        data: JSON.stringify(item),
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  setSyncState("items", {
    lastModified: maxModified(rows) || state?.last_modified || null,
    lastSyncedAt: new Date().toISOString(),
  });
  return { count: rows.length };
}

async function pullCustomers(posProfile) {
  const state = getSyncState("customers");
  const customers = await callMethod("pos_next.api.customers.get_customers", {
    pos_profile: posProfile,
    modified_after: state?.last_modified || null,
    start: 0,
    limit: 100000,
  });
  const rows = customers || [];

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO customers (name, customer_name, mobile_no, email_id, modified, data)
    VALUES (@name, @customer_name, @mobile_no, @email_id, @modified, @data)
    ON CONFLICT(name) DO UPDATE SET
      customer_name = excluded.customer_name,
      mobile_no = excluded.mobile_no,
      email_id = excluded.email_id,
      modified = excluded.modified,
      data = excluded.data
  `);
  db.exec("BEGIN");
  try {
    for (const c of rows) {
      upsert.run({
        name: c.name,
        customer_name: c.customer_name || null,
        mobile_no: c.mobile_no || null,
        email_id: c.email_id || null,
        modified: c.modified || null,
        data: JSON.stringify(c),
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  setSyncState("customers", {
    lastModified: maxModified(rows) || state?.last_modified || null,
    lastSyncedAt: new Date().toISOString(),
  });
  return { count: rows.length };
}

// --- Full-refetch pulls (endpoints with no modified_after support) --------

async function pullTaxes(posProfile) {
  const taxes = await callMethod("pos_next.api.pos_profile.get_taxes", {
    pos_profile: posProfile,
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO pos_taxes (pos_profile, fetched_at, data) VALUES (?, ?, ?)
     ON CONFLICT(pos_profile) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`
  ).run(posProfile, new Date().toISOString(), JSON.stringify(taxes || []));
  return { count: (taxes || []).length };
}

async function pullPaymentMethods(posProfile) {
  const methods = await callMethod("pos_next.api.pos_profile.get_payment_methods", {
    pos_profile: posProfile,
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO payment_methods (pos_profile, fetched_at, data) VALUES (?, ?, ?)
     ON CONFLICT(pos_profile) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`
  ).run(posProfile, new Date().toISOString(), JSON.stringify(methods || []));
  return { count: (methods || []).length };
}

async function pullPosProfile(posProfile) {
  const data = await callMethod("pos_next.api.pos_profile.get_pos_profile_data", {
    pos_profile: posProfile,
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO pos_profiles (name, modified, data) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET modified = excluded.modified, data = excluded.data`
  ).run(posProfile, new Date().toISOString(), JSON.stringify(data || {}));
  return { fetched: !!data };
}

function setSettingValue(key, value) {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, JSON.stringify(value));
}

/**
 * Company address for the receipt header. This outlet chain has MANY
 * Address records all flagged is_your_company_address=1 (one per branch),
 * none flagged is_primary_address=1 — so that generic flag combo (what the
 * real "58 TEST" Print Format falls back to when doc.company_address is
 * unset) can't disambiguate branches at all, it just grabs an arbitrary one.
 * POS Profile itself carries the correct field directly: `company_address`
 * (a Link to Address, e.g. profile "OCW" -> "X-SHA CIAWI-Shop") — this is
 * the SAME field Sales Invoice inherits from its POS Profile when created
 * online, so using it here matches real per-outlet behavior exactly. Cached
 * per POS Profile (settings key `company_address:<profile>`) since
 * different profiles/outlets have different addresses.
 */
async function pullCompanyAddress(posProfile) {
  const row = getDb().prepare("SELECT data FROM pos_profiles WHERE name = ?").get(posProfile);
  const profileAddress = row ? JSON.parse(row.data)?.pos_profile?.company_address : null;

  const fields = ["name", "address_title", "address_line1", "address_line2", "city", "phone"];
  let addr = null;

  if (profileAddress) {
    const doc = await callMethod("frappe.client.get", {
      doctype: "Address",
      name: profileAddress,
    });
    if (doc) {
      addr = {
        name: doc.name,
        address_title: doc.address_title,
        address_line1: doc.address_line1,
        address_line2: doc.address_line2,
        city: doc.city,
        phone: doc.phone,
      };
    }
  }

  if (!addr) {
    // Last-resort fallback only if the profile has no company_address set —
    // arbitrary among branches, but better than nothing offline.
    let rows = await callMethod("frappe.client.get_list", {
      doctype: "Address",
      filters: { is_your_company_address: 1, is_primary_address: 1 },
      fields,
      limit_page_length: 1,
    });
    if (!rows?.length) {
      rows = await callMethod("frappe.client.get_list", {
        doctype: "Address",
        filters: { is_your_company_address: 1 },
        fields,
        limit_page_length: 1,
      });
    }
    addr = rows?.[0] || null;
  }

  setSettingValue(`company_address:${posProfile}`, addr);
  return { found: !!addr };
}

/**
 * Fetches (and caches) the actual Print Format doc configured for this POS
 * Profile (print_settings.print_format from get_pos_profile_data, already
 * cached by pullPosProfile — must run after it). The receipt printer
 * (main/printer.js) doesn't interpret this Jinja/HTML at runtime — ESC/POS
 * has no concept of HTML/CSS — but its content/field-order was hand-ported
 * to match this exact format. Cached raw so it's inspectable and so a
 * future re-port has a concrete diff to work from if the outlet edits their
 * format in ERP.
 */
async function pullPrintFormat(posProfile) {
  const row = getDb().prepare("SELECT data FROM pos_profiles WHERE name = ?").get(posProfile);
  const formatName = row ? JSON.parse(row.data)?.print_settings?.print_format : null;
  if (!formatName) return { skipped: true };

  const doc = await callMethod("frappe.client.get", {
    doctype: "Print Format",
    name: formatName,
  });
  setSettingValue(`print_format:${posProfile}`, {
    name: formatName,
    html: doc?.html || null,
    fetched_at: new Date().toISOString(),
  });
  return { name: formatName, fetched: !!doc };
}

/**
 * Pinned items/categories were the one thing on the item grid that wasn't
 * cache-first — every load went through the generic online-first /rpc path
 * (a real ping + round-trip), so the pinned row visibly popped in after the
 * rest of the (already cache-first) item grid had already rendered. Caching
 * the code lists here, read back instantly by rpc.js's OFFLINE_FALLBACK,
 * fixes that — pinned items now render in the same pass as everything else.
 */
async function pullPinnedItems(posProfile) {
  const codes = await callMethod("pos_next.api.pinned_items.get_pinned_items", {
    pos_profile: posProfile,
  });
  setSettingValue(`pinned_items:${posProfile}`, codes || []);
  return { count: (codes || []).length };
}

async function pullPinnedCategories(posProfile) {
  const groups = await callMethod("pos_next.api.pinned_categories.get_pinned_categories", {
    pos_profile: posProfile,
  });
  setSettingValue(`pinned_categories:${posProfile}`, groups || []);
  return { count: (groups || []).length };
}

/**
 * Run one full pull cycle for the device's configured POS Profile. Called at
 * app start and on the scheduler interval (see scheduler.js) — never
 * real-time/push, stock and master data are always "as of last sync".
 */
async function pullAll() {
  const device = loadDeviceConfig();
  if (!device?.posProfile) {
    throw new Error("Device belum ter-setup (POS Profile tidak ditemukan)");
  }
  const posProfile = device.posProfile;

  const [items, customers, taxes, paymentMethods, posProfileData, pinnedItems, pinnedCategories] = await Promise.all([
    pullItems(posProfile),
    pullCustomers(posProfile),
    pullTaxes(posProfile),
    pullPaymentMethods(posProfile),
    pullPosProfile(posProfile),
    pullPinnedItems(posProfile).catch((err) => ({ error: err.message })),
    pullPinnedCategories(posProfile).catch((err) => ({ error: err.message })),
  ]);

  // Depends on pos_profiles already being cached above (reads the
  // print_settings.print_format name back out of it).
  const [printFormat, companyAddress] = await Promise.all([
    pullPrintFormat(posProfile).catch((err) => ({ error: err.message })),
    pullCompanyAddress(posProfile).catch((err) => ({ error: err.message })),
  ]);

  return {
    items,
    customers,
    taxes,
    paymentMethods,
    posProfileData,
    pinnedItems,
    pinnedCategories,
    printFormat,
    companyAddress,
  };
}

module.exports = {
  pullAll,
  pullItems,
  pullCustomers,
  pullTaxes,
  pullPaymentMethods,
  pullPosProfile,
  pullPrintFormat,
  pullCompanyAddress,
  pullPinnedItems,
  pullPinnedCategories,
};
