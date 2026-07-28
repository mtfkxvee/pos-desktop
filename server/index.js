const express = require("express");
const path = require("path");
const { initDb, getDb } = require("./db/client");
const {
  loginAndProvision,
  isDeviceSetup,
  loadDeviceConfig,
} = require("./auth/device-setup");
const { pingServer } = require("./sync/ping");
const { pushQueuedInvoices, getQueueStatus } = require("./sync/push");
const { pullAll } = require("./sync/pull");
const { startScheduler } = require("./sync/scheduler");
const invoicesRouter = require("./routes/invoices");
const rpcRouter = require("./routes/rpc");
const cacheRouter = require("./routes/cache");
const stockRouter = require("./routes/stock");
const customersRouter = require("./routes/customers");
const dbGenericRouter = require("./routes/db-generic");
const printRouter = require("./routes/print");

function startServer({ port = 8871, dbPath } = {}) {
  const resolvedDbPath = dbPath || path.join(__dirname, "..", ".data", "pos-desktop.sqlite3");
  initDb(resolvedDbPath);

  const app = express();
  app.use(express.json());
  // Server only binds to 127.0.0.1 (never exposed externally), so a
  // permissive CORS policy here just lets the Vite dev server (5173) and the
  // built renderer (file://) talk to it without friction.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  // Sanity endpoint for the SQLite layer: lists tables created from schema.sql.
  app.get("/db/health", (req, res) => {
    try {
      const rows = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
      res.json({ status: "ok", tables: rows.map((r) => r.name) });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  app.get("/settings/:key", (req, res) => {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ key: req.params.key, value: JSON.parse(row.value) });
  });

  app.put("/settings/:key", (req, res) => {
    getDb()
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(req.params.key, JSON.stringify(req.body.value));
    res.json({ ok: true });
  });

  app.get("/auth/status", (req, res) => {
    const configured = isDeviceSetup();
    res.json({ configured, device: configured ? loadDeviceConfig() : null });
  });

  app.post("/auth/setup", async (req, res) => {
    try {
      const device = await loginAndProvision(req.body || {});
      // Sync engine only makes sense once a device is configured.
      startScheduler();
      res.json({ ok: true, device });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.use("/invoices", invoicesRouter);
  app.use("/rpc", rpcRouter);
  app.use("/cache", cacheRouter);
  app.use("/stock", stockRouter);
  app.use("/customers", customersRouter);
  app.use("/db", dbGenericRouter);
  app.use("/print", printRouter);

  // Online/offline indicator + pending-sync count, for the UI status badge.
  app.get("/sync/status", async (req, res) => {
    const online = await pingServer();
    res.json({ online, queue: getQueueStatus() });
  });

  // Manual sync trigger (e.g. a "sync now" button), in addition to the
  // automatic app-start + interval cycle from scheduler.js.
  app.post("/sync/run", async (req, res) => {
    try {
      const online = await pingServer();
      if (!online) return res.json({ online: false });
      const pull = await pullAll();
      const push = await pushQueuedInvoices();
      res.json({ online: true, pull, push });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  if (isDeviceSetup()) {
    startScheduler();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      resolve({ app, server, port });
    });
    server.on("error", reject);
  });
}

module.exports = { startServer };
