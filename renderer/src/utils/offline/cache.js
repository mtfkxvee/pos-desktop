/**
 * Desktop build shim for the old cache.js module. Only getCachedCompanyAddress
 * is consumed elsewhere (printInvoice.js, for offline receipt printing) —
 * everything else the old module did (item/customer caching, payment method
 * caching, cache stats) now lives in workerClient.js / server/routes/cache.js.
 */
import { getSetting, setSetting } from "./db";

export async function getCachedCompanyAddress() {
  return getSetting("company_address", null);
}

export async function cacheCompanyAddress(company, addressName) {
  return setSetting("company_address", { company, addressName });
}
