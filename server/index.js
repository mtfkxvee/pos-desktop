const express = require("express");
const path = require("path");
const { initDb, getDb } = require("./db/client");
const {
  login,
  logout,
  isLoggedIn,
  getActiveUser,
  isDeviceConfigured,
  loadDeviceConfig,
} = require("./auth/device-setup");
const { pingServer } = require("./sync/ping");
const { pushQueuedInvoices, getQueueStatus } = require("./sync/push");
const {
  pullAll,
  pullItems,
  pullCustomers,
  pullTaxes,
  pullPaymentMethods,
  pullOffers,
} = require("./sync/pull");
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
    const configured = isDeviceConfigured();
    const loggedIn = isLoggedIn();
    res.json({
      configured,
      loggedIn,
      device: configured ? loadDeviceConfig() : null,
      username: loggedIn ? getActiveUser().username : null,
    });
  });

  // Per-cashier login. First-time-ever on this device, the request body also
  // needs outletCode/posProfile/defaultWarehouse; every login after that
  // (any cashier) just needs baseUrl(optional)/usr/pwd.
  app.post("/auth/login", async (req, res) => {
    try {
      const result = await login(req.body || {});
      startScheduler();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/auth/logout", (req, res) => {
    logout();
    res.json({ ok: true });
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

  // Full breakdown of what's cached and when — powers the Sync Status
  // dialog so the cashier/support can see exactly how stale each type of
  // local data is, not just a single vague "last synced" number.
  app.get("/sync/overview", async (req, res) => {
    const db = getDb();
    const online = await pingServer();

    const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    const syncState = Object.fromEntries(
      db.prepare("SELECT table_name, last_synced_at FROM sync_state").all()
        .map((r) => [r.table_name, r.last_synced_at])
    );
    const latestFetchedAt = (table) => {
      const row = db.prepare(`SELECT MAX(fetched_at) t FROM ${table}`).get();
      return row?.t || null;
    };

    res.json({
      online,
      items: { count: count("items"), lastSyncedAt: syncState.items || null },
      customers: { count: count("customers"), lastSyncedAt: syncState.customers || null },
      taxes: { count: count("pos_taxes"), lastSyncedAt: latestFetchedAt("pos_taxes") },
      paymentMethods: { count: count("payment_methods"), lastSyncedAt: latestFetchedAt("payment_methods") },
      offers: { count: count("offers"), lastSyncedAt: syncState.offers || null },
      posProfiles: { count: count("pos_profiles") },
      invoiceQueue: getQueueStatus(),
      customerQueue: {
        pending: db.prepare("SELECT COUNT(*) c FROM customer_queue WHERE status='pending'").get().c,
        failed: db.prepare("SELECT COUNT(*) c FROM customer_queue WHERE status='failed'").get().c,
      },
    });
  });

  // Manual sync trigger (e.g. a "sync now" button), in addition to the
  // automatic app-start + interval cycle from scheduler.js.
  app.post("/sync/run", async (req, res) => {
    const online = await pingServer();
    if (!online) return res.json({ online: false });

    // Pull and push are independent — a hiccup in one (e.g. a flaky
    // connection dropping mid-request) shouldn't 500 the whole cycle and
    // spam the renderer's error toast; report per-step errors instead.
    const pull = await pullAll().catch((err) => ({ error: err.message }));
    const push = await pushQueuedInvoices().catch((err) => ({ error: err.message }));
    res.json({ online: true, pull, push });
  });

  // Per-category manual sync (SyncStatusDialog's individual "Sync" buttons)
  // — lets the outlet refresh just, say, promos right after a new one was
  // configured in ERP, instead of waiting for the next ~2 min background
  // cycle or running a full pullAll() for one changed table.
  const SYNCABLE = {
    items: pullItems,
    customers: pullCustomers,
    taxes: pullTaxes,
    paymentMethods: pullPaymentMethods,
    offers: pullOffers,
  };
  app.post("/sync/run/:type", async (req, res) => {
    const puller = SYNCABLE[req.params.type];
    if (!puller) {
      return res.status(400).json({ error: `Tipe sync tidak dikenal: "${req.params.type}"` });
    }
    const online = await pingServer();
    if (!online) return res.json({ online: false });

    const device = loadDeviceConfig();
    if (!device?.posProfile) {
      return res.status(400).json({ error: "Device belum ter-setup (POS Profile tidak ditemukan)" });
    }
    try {
      const result = await puller(device.posProfile);
      res.json({ online: true, result });
    } catch (err) {
      res.status(502).json({ online: true, error: err.message });
    }
  });

  // No auto-start here — activeUser is in-memory and always starts empty on
  // process boot, so the scheduler only makes sense once /auth/login
  // succeeds (see above).

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      resolve({ app, server, port });
    });
    server.on("error", reject);
  });
}

module.exports = { startServer };
