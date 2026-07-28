// Main offline module - exports all offline functionality.
// Desktop build: backed by the local Express server + SQLite (see
// server/routes/*, server/sync/*) instead of Dexie/IndexedDB directly.

export { db, initDB, checkDBHealth, getSetting, setSetting } from "./db";

export {
  offlineState,
  isOffline,
  setManualOffline,
  toggleManualOffline,
  getOfflineState,
  checkConnectivity,
  getConnectionQuality,
} from "./offlineState";

export {
  pingServer,
  saveOfflineInvoice,
  getOfflineInvoices,
  getOfflineInvoiceCount,
  syncOfflineInvoices,
  deleteOfflineInvoice,
  updateLocalStock,
  getLocalStock,
  saveOfflinePayment,
  saveOfflineCustomer,
  isKodePelangganTaken,
  getOfflineCustomers,
  syncOfflineCustomers,
  cacheInvoiceHistory,
  getCachedInvoiceHistory,
  clearInvoiceHistoryCache,
  cacheUnpaidInvoices,
  getCachedUnpaidInvoices,
  cacheUnpaidSummary,
  getCachedUnpaidSummary,
  generateOfflineId,
  checkOfflineIdSynced,
  cacheCustomersFromServer,
  cachePaymentMethodsFromServer,
  cacheItemsIncremental,
  cacheCustomersIncremental,
  getCachedPaymentMethods,
} from "./sync";

export { cacheItems, getCachedVariants, updateItemBatchSerialData, getCachedBatchData, getCachedSerialData } from "./items";

export { getCachedCompanyAddress, cacheCompanyAddress } from "./cache";
