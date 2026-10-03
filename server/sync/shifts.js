const crypto = require("crypto");
const { getDb } = require("../db/client");
const { callMethod } = require("../frappe-client");
const { pingServer } = require("./ping");

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

function createOfflineShift({ pos_profile, company, balance_details }) {
  const db = getDb();
  const profileRow = db.prepare("SELECT data FROM pos_profiles WHERE name = ?").get(pos_profile);
  if (!profileRow) {
    throw new Error("Data POS Profile belum tersimpan di perangkat. Buka shift saat online dulu.");
  }
  const profile = JSON.parse(profileRow.data)?.pos_profile;
  const now = new Date().toISOString();
  const offlineName = `OFFLINE-SHIFT-${crypto.randomUUID()}`;
  const details = typeof balance_details === "string" ? JSON.parse(balance_details) : balance_details || [];

  db.prepare(
    `INSERT INTO shift_queue (offline_name, status, pos_profile, company, payload, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?)`
  ).run(offlineName, pos_profile, company || profile?.company || null, JSON.stringify({ balance_details: details, period_start_date: now }), now, now);

  const shift = {
    pos_opening_shift: { name: offlineName, pos_profile: pos_profile, period_start_date: now, status: "Open", offline: true },
    pos_profile: profile,
    company: company || profile?.company || null,
  };
  setSetting("shift_state", shift);
  return shift;
}

// Maps an offline shift name to the real server name once it has been created.
// Names that were never offline (or are already real) pass through unchanged.
function resolveShiftName(name) {
  if (!name) return name;
  const row = getDb()
    .prepare("SELECT server_name FROM shift_queue WHERE offline_name = ? AND status = 'synced'")
    .get(name);
  return row?.server_name || name;
}

function hasPendingShifts() {
  return !!getDb().prepare("SELECT 1 FROM shift_queue WHERE status = 'pending' LIMIT 1").get();
}

function isShiftPending(name) {
  if (!name) return false;
  return !!getDb()
    .prepare("SELECT 1 FROM shift_queue WHERE offline_name = ? AND status = 'pending'")
    .get(name);
}

async function pushQueuedShifts() {
  const online = await pingServer();
  if (!online) return { success: 0, failed: 0, offline: true };

  const db = getDb();
  const rows = db.prepare("SELECT * FROM shift_queue WHERE status = 'pending' ORDER BY id ASC").all();
  const result = { success: 0, failed: 0 };

  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    try {
      const created = await callMethod("pos_next.api.shifts.create_opening_shift", {
        pos_profile: row.pos_profile,
        company: row.company,
        balance_details: JSON.stringify(payload.balance_details),
      });
      const serverName = created?.pos_opening_shift?.name;
      if (!serverName) throw new Error("Respon create_opening_shift tidak valid");

      db.prepare(
        "UPDATE shift_queue SET status='synced', server_name=?, last_error=NULL, updated_at=? WHERE id=?"
      ).run(serverName, new Date().toISOString(), row.id);

      const current = getSetting("shift_state");
      if (current?.pos_opening_shift?.name === row.offline_name) {
        setSetting("shift_state", created);
      }
      result.success++;
    } catch (err) {
      db.prepare(
        "UPDATE shift_queue SET retry_count=retry_count+1, last_error=?, updated_at=? WHERE id=?"
      ).run(err.message, new Date().toISOString(), row.id);
      result.failed++;
    }
  }
  return result;
}

function remapOfflineShifts(text) {
  if (typeof text !== "string" || !text.includes("OFFLINE-SHIFT-")) return text;
  const rows = getDb()
    .prepare("SELECT offline_name, server_name FROM shift_queue WHERE status = 'synced'")
    .all();
  let out = text;
  for (const r of rows) out = out.split(r.offline_name).join(r.server_name);
  return out;
}

function listOfflineShifts() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM shift_queue WHERE status = 'pending' ORDER BY id ASC")
    .all();
  return rows.map((r) => {
    const linked = db
      .prepare("SELECT payload FROM invoice_queue WHERE status != 'synced'")
      .all()
      .filter((inv) => JSON.parse(inv.payload).invoice?.posa_pos_opening_shift === r.offline_name).length;
    return {
      offline_name: r.offline_name,
      pos_profile: r.pos_profile,
      created_at: r.created_at,
      retry_count: r.retry_count,
      last_error: r.last_error,
      invoice_count: linked,
    };
  });
}

// Moves every unsynced invoice that points at an offline shift onto the
// server's currently open shift, then drops the offline shift. Used when the
// offline shift can't be created on the server (e.g. another shift is already
// open for this cashier) and the cashier chooses to continue on that one.
async function useActiveShift(offlineName) {
  const online = await pingServer();
  if (!online) return { error: "Harus online untuk memakai shift aktif di server." };

  const db = getDb();
  const row = db.prepare("SELECT * FROM shift_queue WHERE offline_name = ? AND status = 'pending'").get(offlineName);
  if (!row) return { error: "Shift offline tidak ditemukan atau sudah tersinkron." };

  const active = await callMethod("pos_next.api.shifts.check_opening_shift", {});
  const activeName = active?.pos_opening_shift?.name;
  if (!activeName) return { error: "Tidak ada shift terbuka di server. Coba Retry dulu." };

  const now = new Date().toISOString();
  const invRows = db.prepare("SELECT id, payload FROM invoice_queue WHERE status != 'synced'").all();
  for (const inv of invRows) {
    const payload = JSON.parse(inv.payload);
    if (payload.invoice?.posa_pos_opening_shift !== offlineName) continue;
    payload.invoice.posa_pos_opening_shift = activeName;
    db.prepare("UPDATE invoice_queue SET payload = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(payload),
      now,
      inv.id
    );
  }
  db.prepare(
    "UPDATE shift_queue SET status='discarded', server_name=?, last_error='Dipindahkan ke shift aktif di server', updated_at=? WHERE id=?"
  ).run(activeName, now, row.id);
  setSetting("shift_state", active);
  return { ok: true, shift: activeName };
}

module.exports = {
  createOfflineShift,
  pushQueuedShifts,
  resolveShiftName,
  isShiftPending,
  hasPendingShifts,
  remapOfflineShifts,
  listOfflineShifts,
  useActiveShift,
};
