import { onMounted, onUnmounted } from "vue"
import { logger } from "@/utils/logger"

const log = logger.create("SyncedDataRefresh")

const BASE = "http://127.0.0.1:8871"
// The local server's scheduler pulls master data from ERP every 2 minutes
// (server/sync/scheduler.js). Polling its /sync/overview more often than that
// is just a cheap local read, and keeps the delay between "pulled into the
// local cache" and "visible to the cashier" short.
const POLL_MS = 30 * 1000

// Module-level so every caller shares one poller. Each key is a section of
// /sync/overview (e.g. "offers", "paymentMethods").
const listeners = new Map() // key -> Set<callback>
const lastSeen = new Map() // key -> lastSyncedAt
let pollIntervalId = null

async function poll() {
	let overview
	try {
		const res = await fetch(`${BASE}/sync/overview`)
		if (!res.ok) return
		overview = await res.json()
	} catch {
		return
	}

	for (const [key, callbacks] of listeners) {
		const syncedAt = overview?.[key]?.lastSyncedAt || null
		const previous = lastSeen.get(key)
		lastSeen.set(key, syncedAt)
		// First sighting only records the baseline — whatever is in the cache
		// right now is what the caller already loaded on startup.
		if (previous === undefined || !syncedAt || syncedAt === previous) continue

		log.debug(`${key} re-synced at ${syncedAt}, notifying`)
		for (const callback of callbacks) {
			Promise.resolve()
				.then(callback)
				.catch((err) => log.warn(`Refresh for ${key} failed:`, err))
		}
	}
}

/**
 * Run `callback` every time the background sync has refreshed `key` in the
 * local cache. Promos and payment methods are otherwise loaded into memory
 * once per session, so without this a change made in ERP only reached the
 * cashier after an app restart.
 *
 * @param {string} key - Section name in /sync/overview
 * @param {Function} callback - Reload handler (may be async)
 */
export function useSyncedDataRefresh(key, callback) {
	onMounted(() => {
		if (!listeners.has(key)) listeners.set(key, new Set())
		listeners.get(key).add(callback)
		if (!pollIntervalId) {
			poll()
			pollIntervalId = setInterval(poll, POLL_MS)
		}
	})

	onUnmounted(() => {
		const callbacks = listeners.get(key)
		callbacks?.delete(callback)
		if (callbacks && callbacks.size === 0) {
			listeners.delete(key)
			lastSeen.delete(key)
		}
		if (listeners.size === 0 && pollIntervalId) {
			clearInterval(pollIntervalId)
			pollIntervalId = null
		}
	})
}
