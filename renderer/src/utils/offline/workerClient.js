/**
 * Desktop build replacement for the old Web Worker client.
 *
 * The original app ran cache lookups (item/customer search, stock sync,
 * offline invoice queue) inside a Web Worker backed by Dexie/IndexedDB, to
 * keep the main thread responsive. Here, the "background" work already runs
 * out-of-process — in the local Express server (server/sync/*, backed by
 * SQLite) — so there is no need for a Worker at all. This module preserves
 * the exact `offlineWorker.<method>()` surface every store/composable
 * already calls, just implemented as plain fetch() calls to that server.
 */

const BASE = "http://127.0.0.1:8871";

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export const offlineWorker = {
  // Compat no-op: there is no worker thread to spin up anymore.
  async init() {
    return { success: true };
  },

  // --- item / customer search (reads from the server's SQLite cache) ------
  async searchCachedItems(term, limit = 50) {
    return getJSON(`/cache/items/search?q=${encodeURIComponent(term || "")}&limit=${limit}`);
  },
  async searchCachedItemsByGroup(group, term, limit = 50) {
    return getJSON(
      `/cache/items/search?group=${encodeURIComponent(group || "")}&q=${encodeURIComponent(term || "")}&limit=${limit}`
    );
  },
  async countCachedItemsByGroup(group) {
    const r = await getJSON(`/cache/items/count?group=${encodeURIComponent(group || "")}`);
    return r.count;
  },
  async searchCachedCustomers(term, limit = 50) {
    return getJSON(`/cache/customers/search?q=${encodeURIComponent(term || "")}&limit=${limit}`);
  },
  async getCachedPaymentMethods(posProfile) {
    return getJSON(`/cache/payment-methods/${encodeURIComponent(posProfile)}`);
  },
  async getCachedOffers(posProfile) {
    return getJSON(`/cache/offers?pos_profile=${encodeURIComponent(posProfile || "")}`);
  },

  // --- cache status ---------------------------------------------------------
  async isCacheReady() {
    const r = await getJSON("/cache/status");
    return r.ready;
  },
  async getCacheStats() {
    // Old app's getCacheStats() shape: {items, customers, queuedInvoices,
    // cacheReady, stockReady, lastSync}. /cache/status uses different field
    // names server-side (itemCount/customerCount/ready) — remap here so
    // consumers (posSync.js, useSpeedModeReadiness.js) don't need changes.
    const r = await getJSON("/cache/status");
    let queuedInvoices = 0;
    try {
      const q = await getJSON("/invoices/queue-status");
      queuedInvoices = (q.pending || 0) + (q.failed || 0);
    } catch {
      // best-effort
    }
    return {
      items: r.itemCount || 0,
      customers: r.customerCount || 0,
      queuedInvoices,
      cacheReady: !!r.ready,
      stockReady: !!r.ready,
      lastSync: r.lastSync?.items || r.lastSync?.customers || "Never",
    };
  },

  // --- explicit "cache this" calls: no-ops. Items/customers/payment methods
  // already live in SQLite via the server's own pull cycle (server/sync/pull.js)
  // running independently on a timer — the renderer doesn't need to ask for
  // it explicitly. Kept as resolved no-ops so call sites don't need changes.
  async cacheItems(items) {
    return { success: true, count: items?.length || 0 };
  },
  async cacheCustomers(customers) {
    return { success: true, count: customers?.length || 0 };
  },
  async cachePaymentMethods() {
    return { success: true };
  },
  async cacheOffers() {
    return { success: true };
  },
  async removeItemsByGroups() {
    return { success: true };
  },
  async clearItemsCache() {
    return { success: true };
  },

  // Trigger a real pull-from-server-now (used by "sync now"-style UI).
  async cacheItemsFromServer() {
    return postJSON("/sync/run");
  },
  async cacheCustomersFromServer() {
    return postJSON("/sync/run");
  },

  // --- stock (estimate only, no locking — see server/routes/stock.js) ------
  async updateStockQuantities(items) {
    return postJSON("/stock/decrement", { items });
  },
  // The old app ran a dedicated periodic stock-only sync inside the worker;
  // that's now just the server's normal 2-minute scheduler (server/sync/scheduler.js),
  // so start/stop/configure become no-ops and status reports from sync_state.
  async getStockSyncStatus() {
    const r = await getJSON("/cache/status");
    return { running: true, lastSync: r.lastSync?.items || null };
  },
  async configureStockSync() {
    return { success: true };
  },
  async startStockSync() {
    return { success: true };
  },
  async stopStockSync() {
    return { success: true };
  },

  // --- manual offline toggle (persisted, but real online/offline detection
  // is driven by the server pinging Frappe — see server/sync/ping.js) -------
  async setManualOffline(value) {
    const res = await fetch(`${BASE}/settings/manual_offline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: !!value }),
    }).catch(() => null);
    return { success: !!res?.ok };
  },

  // Not needed — auth is API key/secret held entirely by the local server.
  async setCSRFToken() {
    return { success: true };
  },

  // --- offline invoice queue -------------------------------------------------
  async getOfflineInvoiceCount() {
    const r = await getJSON("/invoices/queue-status");
    return (r.pending || 0) + (r.failed || 0);
  },
  async saveOfflineInvoice(data) {
    return postJSON("/invoices/queue", { invoice: data, data: {} });
  },
  async getOfflineInvoices() {
    return getJSON("/invoices/queue");
  },
  async deleteOfflineInvoice(id) {
    await del(`/invoices/queue/${id}`);
    return true;
  },

  // Manually trigger the same pull+push cycle the scheduler runs automatically.
  async syncOfflineInvoices() {
    return postJSON("/sync/run");
  },
};
