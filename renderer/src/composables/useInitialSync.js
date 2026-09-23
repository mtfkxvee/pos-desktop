/**
 * Gate between login and the POS screen: makes sure items, customers, taxes,
 * payment methods, the POS Profile, and promos/offers are all actually
 * present in the local cache before the cashier can start selling — instead
 * of POSSale.vue mounting straight away and silently showing an empty/broken
 * catalog (or, worse, no promos at all — see pullOffers()'s docstring in
 * server/sync/pull.js for a real bug that caused exactly that) on a brand
 * new device or a fresh profile switch.
 *
 * Readiness is read from GET /sync/overview (already powers SyncStatusDialog)
 * rather than a new endpoint — a table having ever been synced is judged by
 * its own lastSyncedAt marker, NOT by row count, because an empty result is
 * legitimate for some of these (e.g. a profile with zero active promos right
 * now must not be mistaken for "promos were never even fetched").
 */
import { ref } from "vue"
import { logger } from "@/utils/logger"

const log = logger.create("InitialSync")
const BASE = "http://127.0.0.1:8871"

export const STEPS = [
	{ key: "items", label: "Produk" },
	{ key: "customers", label: "Pelanggan" },
	{ key: "taxes", label: "Pajak" },
	{ key: "paymentMethods", label: "Metode Pembayaran" },
	{ key: "offers", label: "Promo & Kupon" },
	{ key: "posProfiles", label: "Profil POS" },
]

function isStepDone(overview, key) {
	const entry = overview?.[key]
	if (!entry) return false
	// posProfiles has no lastSyncedAt of its own (see /sync/overview) — a
	// row existing at all means pullPosProfile() succeeded at least once.
	if (key === "posProfiles") return (entry.count || 0) > 0
	return !!entry.lastSyncedAt
}

export async function fetchSyncOverview() {
	const res = await fetch(`${BASE}/sync/overview`)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

export function isFullyReady(overview) {
	return STEPS.every((s) => isStepDone(overview, s.key))
}

export function useInitialSync() {
	const checking = ref(true)
	const syncing = ref(false)
	const overview = ref(null)
	const error = ref("")

	async function check() {
		checking.value = true
		error.value = ""
		try {
			overview.value = await fetchSyncOverview()
		} catch (err) {
			log.error("Failed to read sync overview", err)
			error.value = err.message || "Gagal membaca status data lokal"
		} finally {
			checking.value = false
		}
	}

	async function runSync() {
		syncing.value = true
		error.value = ""
		try {
			const res = await fetch(`${BASE}/sync/run`, { method: "POST" })
			const data = await res.json()
			if (data.online === false) {
				error.value = "Tidak ada koneksi internet. Sinkronisasi pertama kali butuh koneksi internet."
				return false
			}
			if (data.pull?.error) {
				error.value = data.pull.error
				return false
			}
			await check()
			return isFullyReady(overview.value)
		} catch (err) {
			log.error("Initial sync failed", err)
			error.value = err.message || "Sinkronisasi gagal"
			return false
		} finally {
			syncing.value = false
		}
	}

	return { checking, syncing, overview, error, check, runSync }
}
