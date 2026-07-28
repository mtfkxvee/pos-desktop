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

  return db;
}

module.exports = { initDb, getDb };
