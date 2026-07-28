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

  const [items, customers, taxes, paymentMethods, posProfileData] = await Promise.all([
    pullItems(posProfile),
    pullCustomers(posProfile),
    pullTaxes(posProfile),
    pullPaymentMethods(posProfile),
    pullPosProfile(posProfile),
  ]);

  return { items, customers, taxes, paymentMethods, posProfileData };
}

module.exports = {
  pullAll,
  pullItems,
  pullCustomers,
  pullTaxes,
  pullPaymentMethods,
  pullPosProfile,
};
