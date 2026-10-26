import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"
import { offlineWorker } from "@/utils/offline/workerClient"
import { logger } from "@/utils/logger"
import { defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"

const log = logger.create("CustomerSearch")

export const useCustomerSearchStore = defineStore("customerSearch", () => {
	// State
	// shallowRef: ~90k customers. A deep ref() wrapped every customer object
	// in a reactive Proxy, making every scan over the list (each keystroke)
	// several times slower for no benefit — the list is only ever replaced
	// wholesale, never mutated in place.
	const allCustomers = shallowRef([])
	const searchTerm = ref("")
	const loading = ref(false)
	// True once an initial load attempt has SETTLED — success or failure —
	// as opposed to allCustomers.length > 0, which InvoiceCart.vue used to
	// gate its customer search box on directly. That conflated "no
	// customers exist yet" with "the fetch failed", so a single flaky
	// server response (502/503/timeout) on first load left the search box
	// permanently disabled for the rest of the session, with no retry and
	// no way to recover short of restarting the app.
	const loadAttempted = ref(false)
	const loadRetryCount = ref(0)
	const selectedIndex = ref(-1)
	const recentSearches = ref([])
	const frequentCustomers = ref([])

	// Pre-computed lowercase search fields, rebuilt only when allCustomers is
	// replaced. Plain (non-reactive) on purpose: these used to be ref(Map)s
	// written to from inside the filteredCustomers computed, so every
	// keystroke also triggered reactive bookkeeping on up to ~90k entries.
	let indexSource = null
	let index = []
	const resultCache = new Map()
	// Can't collide with a typed search term (those are trimmed)
	const EMPTY_KEY = " empty"

	function getIndex() {
		if (indexSource !== allCustomers.value) {
			indexSource = allCustomers.value
			resultCache.clear()
			index = indexSource.map((customer) => {
				const name = (customer.customer_name || "").toLowerCase()
				const entry = {
					customer,
					name,
					nameWords: name.split(" "),
					mobile: (customer.mobile_no || "").toLowerCase(),
					email: (customer.email_id || "").toLowerCase(),
					id: (customer.name || "").toLowerCase(),
					code: (customer.custom_kode_pelanggan || "").toLowerCase(),
				}
				// All fields joined, so the common no-match case costs a single
				// includes() instead of the full scoring chain below.
				entry.all = [entry.name, entry.mobile, entry.code, entry.email, entry.id].join("\u0001")
				return entry
			})
		}
		return index
	}

	// Ultra-fast search helper - optimized for speed
	function quickMatch(term, cached) {
		if (!cached.all.includes(term)) return 0

		// Lightning-fast checks in priority order
		// Name checks (most important)
		if (cached.name === term) return 300 // Exact name match
		if (cached.code === term) return 290 // Custom Code match (Very High Priority)
		if (cached.name.startsWith(term)) return 270 // Name starts with
		if (cached.code.startsWith(term)) return 260
		if (cached.mobile === term) return 250

		// Check each word start
		for (const word of cached.nameWords) {
			if (word.startsWith(term)) return 240 // Word in name starts with
		}

		// Phone checks (very important for POS)
		if (cached.mobile.startsWith(term)) return 225
		if (cached.email.startsWith(term)) return 200
		if (cached.name.includes(term)) return 180 // Name contains
		if (cached.mobile.includes(term)) return 150
		if (cached.code.includes(term)) return 140
		if (cached.id.startsWith(term)) return 135
		if (cached.email.includes(term)) return 120
		if (cached.id.includes(term)) return 90

		return 0 // No match
	}

	// Full ranked scan over the pre-computed index (~5-10ms for ~90k).
	// Hits go into per-score buckets capped at `limit` — no sort over the
	// thousands of matches a short term like "id" produces; equal scores
	// keep list order.
	function rankCustomers(term, limit) {
		const q = term.toLowerCase()
		const buckets = new Map()
		for (const entry of getIndex()) {
			const score = quickMatch(q, entry)
			if (!score) continue
			let bucket = buckets.get(score)
			if (!bucket) buckets.set(score, (bucket = []))
			if (bucket.length < limit) bucket.push(entry.customer)
		}
		const results = []
		for (const score of [...buckets.keys()].sort((a, b) => b - a)) {
			for (const customer of buckets.get(score)) {
				results.push(customer)
				if (results.length >= limit) return results
			}
		}
		return results
	}

	// Getters - ULTRA OPTIMIZED for zero delay
	const filteredCustomers = computed(() => {
		const term = searchTerm.value.trim()

		// Show recent/frequent customers when no search term (CACHED)
		if (!term) {
			const cacheKey = EMPTY_KEY
			getIndex() // drops cached results if the list was replaced
			let cached = resultCache.get(cacheKey)

			if (!cached) {
				// Build index maps once for O(1) lookup
				const recentSet = new Set(recentSearches.value)
				const frequentSet = new Set(frequentCustomers.value)

				// Separate into buckets
				const recent = []
				const frequent = []
				const other = []

				for (const c of allCustomers.value) {
					if (recentSet.has(c.name)) recent.push(c)
					else if (frequentSet.has(c.name)) frequent.push(c)
					else other.push(c)
				}

				cached = [...recent, ...frequent, ...other].slice(0, 50)
				resultCache.set(cacheKey, cached)
			}

			return cached
		}

		const cacheKey = term.toLowerCase()
		getIndex() // drops cached results if the list was replaced
		let final = resultCache.get(cacheKey)
		if (!final) {
			final = rankCustomers(term, 50)
			resultCache.set(cacheKey, final)
			// Limit cache size to prevent memory bloat
			if (resultCache.size > 100) {
				resultCache.delete(resultCache.keys().next().value)
			}
		}
		return final
	})

	// Recommendations based on search patterns
	const recommendations = computed(() => {
		const term = searchTerm.value.trim().toLowerCase()
		if (!term || term.length < 2) return []

		const recs = []

		// Check if it looks like a phone number
		if (/^\d+$/.test(term)) {
			recs.push({
				type: "phone",
				text: __("Search by phone: {0}", [term]),
				icon: "📱",
			})
		}

		// Check if it looks like an email
		if (term.includes("@")) {
			recs.push({
				type: "email",
				text: __("Search by email: {0}", [term]),
				icon: "✉️",
			})
		}

		// Suggest creating new customer if no exact matches
		const exactMatch = allCustomers.value.some(
			(c) => c.customer_name?.toLowerCase() === term,
		)
		if (!exactMatch && filteredCustomers.value.length < 5) {
			recs.push({
				type: "create",
				text: __("Create new customer: {0}", [term]),
				icon: "➕",
			})
		}

		return recs
	})

	// Actions

	// In-flight loadAllCustomers() call, if any — de-dupes concurrent callers
	// onto the SAME attempt instead of racing separate fetches. This started
	// mattering once loadAllCustomers got a second caller (POSSale.vue's
	// initPOS now prewarms it at shift-open, in addition to InvoiceCart.vue's
	// own on-mount call) — without this guard, two concurrent calls could
	// both see allCustomers still empty, both proceed, and each independently
	// retry-loop on failure, corrupting the shared loadRetryCount/loadAttempted
	// bookkeeping and leaving the customer search box disabled far longer
	// than the intended ~15s retry budget (observed live: still disabled and
	// flapping in/out of the DOM after 30s+).
	let loadPromise = null

	async function loadAllCustomers(posProfile, forceReload = false) {
		if (!posProfile) {
			return
		}

		// Skip if already loaded (unless forceReload)
		if (!forceReload && allCustomers.value.length > 0) {
			return
		}

		if (loadPromise) {
			return loadPromise
		}

		loadPromise = loadAllCustomersImpl(posProfile)
		try {
			return await loadPromise
		} finally {
			loadPromise = null
		}
	}

	async function loadAllCustomersImpl(posProfile) {
		loading.value = true
		try {
			// Try to get from worker cache first (no limit — all cached customers)
			const cachedCustomers = await offlineWorker.searchCachedCustomers("", 0)

			if (cachedCustomers && cachedCustomers.length > 0) {
				allCustomers.value = cachedCustomers
				log.debug(`Loaded ${cachedCustomers.length} customers from cache`)
			} else if (!isOffline()) {
				// Fetch all customers from server in one request (limit=0 = no limit)
				const response = await call("pos_next.api.customers.get_customers", {
					pos_profile: posProfile,
					search_term: "",
					limit: 0,
				})
				const allFetched = response?.message || response || []
				allCustomers.value = Array.isArray(allFetched) ? allFetched : []

				// Cache for future use
				if (allCustomers.value.length) {
					await offlineWorker.cacheCustomers(allCustomers.value)
				}
				log.debug(`Loaded ${allCustomers.value.length} customers from server`)
			} else {
				// Offline and cache is empty
				log.warn("Offline mode: No cached customers available")
				allCustomers.value = []
			}

			loadRetryCount.value = 0
			loadAttempted.value = true
		} catch (error) {
			log.error("Error loading customers:", error)
			allCustomers.value = []

			// Retry a flaky failure a few times before giving up — a
			// transient 502/503 shouldn't require an app restart to recover
			// from. Bounded so a genuinely dead server doesn't retry forever.
			const MAX_LOAD_RETRIES = 5
			if (loadRetryCount.value < MAX_LOAD_RETRIES) {
				loadRetryCount.value++
				const delay = Math.min(1000 * loadRetryCount.value, 5000)
				setTimeout(() => loadAllCustomers(posProfile, true), delay)
			} else {
				// Give up retrying, but still mark the attempt as settled so
				// the search UI unblocks — the cashier can keep working
				// (WALK IN CUST default, manual customer search on demand)
				// instead of being stuck on a permanently-disabled input.
				loadAttempted.value = true
			}
		} finally {
			loading.value = false
		}
	}

	async function addCustomerToCache(customer) {
		try {
			// Add to local array (at the beginning for visibility)
			const existingWithoutNew = allCustomers.value.filter(
				(cust) => cust.name !== customer.name,
			)
			allCustomers.value = [customer, ...existingWithoutNew]

			// Cache in worker (IndexedDB)
			await offlineWorker.cacheCustomers([customer])

			log.success(`New customer cached: ${customer.customer_name}`)
		} catch (error) {
			log.error("Error caching newly created customer:", error)
		}
	}

	function setSearchTerm(term) {
		searchTerm.value = term
		selectedIndex.value = -1
	}

	function clearSearch() {
		searchTerm.value = ""
		selectedIndex.value = -1
		// Don't clear resultCache on empty search - it's beneficial
	}

	function setSelectedIndex(index) {
		selectedIndex.value = index
	}

	function resetSelectedIndex() {
		selectedIndex.value = -1
	}

	function trackCustomerSelection(customerId) {
		// Add to recent searches (max 10)
		recentSearches.value = [
			customerId,
			...recentSearches.value.filter((id) => id !== customerId),
		].slice(0, 10)

		// Track frequency
		const index = frequentCustomers.value.indexOf(customerId)
		if (index > -1) {
			// Move to front if already exists
			frequentCustomers.value.splice(index, 1)
		}
		frequentCustomers.value = [customerId, ...frequentCustomers.value].slice(
			0,
			20,
		)

		// Persist to localStorage
		try {
			localStorage.setItem(
				"pos_recent_customers",
				JSON.stringify(recentSearches.value),
			)
			localStorage.setItem(
				"pos_frequent_customers",
				JSON.stringify(frequentCustomers.value),
			)
		} catch (e) {
			log.warn("Failed to persist customer history:", e)
		}
	}

	function loadCustomerHistory() {
		try {
			const recent = localStorage.getItem("pos_recent_customers")
			const frequent = localStorage.getItem("pos_frequent_customers")

			if (recent) recentSearches.value = JSON.parse(recent)
			if (frequent) frequentCustomers.value = JSON.parse(frequent)
		} catch (e) {
			log.warn("Failed to load customer history:", e)
		}
	}

	// Local-cache search that doesn't touch `searchTerm`/`resultCache` — those
	// back the main transaction customer picker's own search box, and this is
	// called from a DIFFERENT search box (CustomerSelector's "Customers"
	// tab), so sharing them would make the two boxes' results bleed into each
	// other. Reuses the same quickMatch scoring as filteredCustomers above.
	function searchLocalCustomers(term, limit = 50) {
		const q = (term || "").trim()
		if (!q) return []
		return rankCustomers(q, limit)
	}

	async function searchOnlineCustomers(searchTerm, posProfile, limit = 20) {
		if (isOffline()) {
			throw new Error("Tidak bisa mencari pelanggan online saat offline")
		}

		try {
			console.log("Searching online customers with:", {
				searchTerm,
				posProfile,
			})

			// Fallback to standard Frappe API for robust searching
			const searchFilters = searchTerm
				? [
						["name", "like", "%" + searchTerm + "%"],
						["customer_name", "like", "%" + searchTerm + "%"],
						["mobile_no", "like", "%" + searchTerm + "%"],
						["email_id", "like", "%" + searchTerm + "%"],
						["custom_kode_pelanggan", "like", "%" + searchTerm + "%"],
					]
				: []

			const apiArgs = {
				doctype: "Customer",
				fields: [
					"name",
					"customer_name",
					"mobile_no",
					"email_id",
					"image",
					"loyalty_program",
					"customer_group",
					"primary_address",
					"custom_tanggal_lahir",
					"custom_kode_pelanggan",
				],
				limit_page_length: limit,
				order_by: "creation desc",
			}

			if (searchTerm) {
				apiArgs.or_filters = searchFilters
			}

			const response = await call("frappe.client.get_list", apiArgs)
			return response || []
		} catch (error) {
			log.error("Error searching online customers:", error)
			throw error
		}
	}

	return {
		// State
		allCustomers,
		searchTerm,
		loading,
		loadAttempted,
		selectedIndex,
		recentSearches,
		frequentCustomers,

		// Getters
		filteredCustomers,
		recommendations,

		// Actions
		loadAllCustomers,
		addCustomerToCache,
		setSearchTerm,
		clearSearch,
		setSelectedIndex,
		resetSelectedIndex,
		trackCustomerSelection,
		loadCustomerHistory,
		searchLocalCustomers,
		searchOnlineCustomers, // New action
	}
})
