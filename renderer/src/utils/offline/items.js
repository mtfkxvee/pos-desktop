/**
 * Desktop build shim for the old items.js cache module. Only the exports
 * actually consumed elsewhere (itemSearch.js, ItemSelectionDialog.vue,
 * BatchSerialDialog.vue) are implemented — batch/serial offline caching is a
 * simplification left for a later pass (core sale flow doesn't depend on it).
 */
import { db } from "./db";

export async function cacheItems() {
  return { success: true };
}

export async function getCachedVariants(templateItem) {
  const rows = await db.items.toArray();
  return rows.filter((i) => i.variant_of === templateItem);
}

// Batch/serial-tracked items aren't cached offline yet — returns empty so
// callers degrade gracefully (batch/serial picker will show "no data
// offline" instead of crashing).
export async function updateItemBatchSerialData() {
  return { success: true };
}
export async function getCachedBatchData() {
  return [];
}
export async function getCachedSerialData() {
  return [];
}
