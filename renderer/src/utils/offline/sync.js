/**
 * Desktop build replacement for the old Dexie-backed sync.js.
 *
 * Invoice queuing/pushing is now entirely the local server's job (see
 * server/routes/invoices.js and server/sync/push.js — including the
 * dedup-before-retry logic via check_offline_invoice_synced). This module
 * only re-implements the handful of exports still imported directly by a few
 * components (POSSale.vue, InvoiceManagement.vue, InvoiceHistoryDialog.vue,
 * OfflineInvoicesDialog.vue), backed by HTTP calls instead of IndexedDB.
 */
import { call } from "@/utils/apiWrapper";
import { isOffline as offlineStateIsOffline } from "./offlineState";
import { offlineWorker } from "./workerClient";

const BASE = "http://127.0.0.1:8871";

export function generateOfflineId() {
  return `pos_offline_${crypto.randomUUID()}`;
}

// Kept for the few files that import it from here instead of offlineState.
export function isOffline() {
  return offlineStateIsOffline();
}

export async function checkOfflineIdSynced(offlineId) {
  if (!offlineId) return { synced: false };
  try {
    return (await call("pos_next.api.invoices.check_offline_invoice_synced", { offline_id: offlineId })) || {
      synced: false,
    };
  } catch {
    return { synced: false };
  }
}

export const saveOfflineInvoice = (data) => offlineWorker.saveOfflineInvoice(data);
export const getOfflineInvoices = () => offlineWorker.getOfflineInvoices();
export const getOfflineInvoiceCount = () => offlineWorker.getOfflineInvoiceCount();
export const deleteOfflineInvoice = (id) => offlineWorker.deleteOfflineInvoice(id);
export const retryOfflineInvoice = (id) => offlineWorker.retryOfflineInvoice(id);
export const syncOfflineInvoices = () => offlineWorker.syncOfflineInvoices();

export async function getOfflineInvoicesForHistory() {
  const queued = await offlineWorker.getOfflineInvoices();
  return queued.map((entry) => {
    const data = entry.data || {};
    const paidAmount = (data.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const grandTotal = Number(data.grand_total) || 0;
    return {
      name: data.name || entry.offline_id,
      customer: typeof data.customer === "object" ? data.customer?.name : data.customer,
      customer_name: data.customer_name,
      posting_date: data.posting_date,
      posting_time: data.posting_time,
      grand_total: grandTotal,
      paid_amount: paidAmount,
      outstanding_amount: Math.max(grandTotal - paidAmount, 0),
      status: "Pending Sync",
      docstatus: 0,
      is_return: !!data.is_return,
      items: data.items || [],
      payments: data.payments || [],
      is_offline_pending: true,
      offline_id: entry.offline_id,
    };
  });
}

export async function cacheInvoiceHistory(invoices, posProfile) {
  if (!invoices?.length) return false;
  const res = await fetch(`${BASE}/cache/invoice-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoices, pos_profile: posProfile }),
  });
  return res.ok;
}

export async function getCachedInvoiceHistory(posProfile, options = {}) {
  const params = new URLSearchParams();
  if (posProfile) params.set("pos_profile", posProfile);
  if (options.limit) params.set("limit", options.limit);
  const res = await fetch(`${BASE}/cache/invoice-history?${params}`);
  return res.ok ? res.json() : [];
}

export async function cacheUnpaidInvoices(invoices, posProfile) {
  const res = await fetch(`${BASE}/cache/unpaid-invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoices: invoices || [], pos_profile: posProfile }),
  });
  return res.ok;
}

export async function getCachedUnpaidInvoices(posProfile, options = {}) {
  const params = new URLSearchParams({ pos_profile: posProfile || "" });
  if (options.limit) params.set("limit", options.limit);
  const res = await fetch(`${BASE}/cache/unpaid-invoices?${params}`);
  return res.ok ? res.json() : [];
}

export async function cacheUnpaidSummary(summary, posProfile) {
  const res = await fetch(`${BASE}/cache/unpaid-summary/${encodeURIComponent(posProfile)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: { ...summary, cached_at: Date.now() } }),
  });
  return res.ok;
}

export async function getCachedUnpaidSummary(posProfile) {
  const res = await fetch(`${BASE}/cache/unpaid-summary/${encodeURIComponent(posProfile)}`);
  return res.ok ? res.json() : { count: 0, total_outstanding: 0, total_paid: 0 };
}

export async function clearInvoiceHistoryCache(posProfile) {
  const params = posProfile ? `?pos_profile=${encodeURIComponent(posProfile)}` : "";
  const res = await fetch(`${BASE}/cache/invoice-history${params}`, { method: "DELETE" });
  return res.ok;
}

export async function pingServer() {
  try {
    const res = await fetch(`${BASE}/sync/status`, { cache: "no-store" });
    const data = await res.json();
    return !!data.online;
  } catch {
    return false;
  }
}

// --- offline customer queue (simplified — see server/sync/push.js) ---------

export async function saveOfflineCustomer(customerData) {
  const res = await fetch(`${BASE}/customers/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(customerData),
  });
  if (!res.ok) throw new Error("Gagal menyimpan customer offline");
  const data = await res.json();
  return { success: true, ...data };
}

export async function getOfflineCustomers() {
  const res = await fetch(`${BASE}/customers/queue`);
  return res.ok ? res.json() : [];
}

export async function syncOfflineCustomers() {
  return offlineWorker.syncOfflineInvoices(); // triggers the same /sync/run cycle
}

export async function isKodePelangganTaken(kode) {
  if (!kode?.trim()) return false;
  try {
    const res = await fetch(`${BASE}/customers/queue/kode-taken/${encodeURIComponent(kode.trim())}`);
    const data = await res.json();
    return !!data.taken;
  } catch {
    return false;
  }
}

// Not wired into any submit path in the ported UI yet — kept as a no-op so
// imports don't break.
export async function saveOfflinePayment() {
  return true;
}

export async function updateLocalStock(items) {
  return offlineWorker.updateStockQuantities(items);
}

// Trigger a real pull-from-server-now for a given entity — the local server
// already pulls all of these together (server/sync/pull.js), so both just
// delegate to the same /sync/run cycle.
export async function cacheCustomersFromServer() {
  return offlineWorker.cacheCustomersFromServer();
}
export async function cachePaymentMethodsFromServer() {
  return offlineWorker.cacheItemsFromServer();
}
export async function cacheItemsIncremental() {
  return offlineWorker.cacheItemsFromServer();
}
export async function cacheCustomersIncremental() {
  return offlineWorker.cacheCustomersFromServer();
}
export async function getCachedPaymentMethods(posProfile) {
  return offlineWorker.getCachedPaymentMethods(posProfile);
}

export async function getLocalStock(itemCode, warehouse) {
  try {
    const res = await fetch(`${BASE}/stock/${encodeURIComponent(itemCode)}/${encodeURIComponent(warehouse)}`);
    const data = await res.json();
    return data.qty || 0;
  } catch {
    return 0;
  }
}
