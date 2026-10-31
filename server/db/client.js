const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

let db = null;

function getDb() {
  if (!db) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return db;
}

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrateOffersTable(db);

  return db;
}

// Devices created before the (name, pos_profile) key still have `name` alone
// as the primary key. CREATE TABLE IF NOT EXISTS leaves that table as it is,
// and SQLite can't change a primary key in place, so rebuild it and keep the
// cached promos (a device that is offline right after updating must still
// have them).
function migrateOffersTable(db) {
  const cols = db.prepare("PRAGMA table_info(offers)").all();
  const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
  if (pkCols.length === 2) return;

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE offers_new (
        name TEXT NOT NULL,
        pos_profile TEXT NOT NULL DEFAULT '',
        valid_upto TEXT,
        modified TEXT,
        data TEXT NOT NULL,
        PRIMARY KEY (name, pos_profile)
      );
      INSERT INTO offers_new (name, pos_profile, valid_upto, modified, data)
        SELECT name, COALESCE(pos_profile, ''), valid_upto, modified, data FROM offers;
      DROP TABLE offers;
      ALTER TABLE offers_new RENAME TO offers;
      CREATE INDEX IF NOT EXISTS idx_offers_pos_profile ON offers(pos_profile);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Used by the "Reset Data" admin action (see main/index.js) — the sqlite
// file (and its -wal/-shm sidecars under WAL mode) can't be deleted on
// Windows while this connection still holds it open.
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDb, getDb, closeDb };
