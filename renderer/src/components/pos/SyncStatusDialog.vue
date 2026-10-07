<template>
	<div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
		<div
			class="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
			@click.stop
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
				<h2 class="text-xl font-bold text-gray-900">{{ __('Status Sinkronisasi') }}</h2>
				<button
					@click="$emit('close')"
					class="p-2 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
				>
					<XMarkIcon class="w-6 h-6" />
				</button>
			</div>

			<!-- Content -->
			<div class="flex-1 overflow-y-auto p-6 space-y-6">
				<div v-if="loading" class="flex justify-center py-12">
					<div class="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
				</div>

				<template v-else-if="overview">
					<!-- Overall Status -->
					<div class="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
						<div class="flex items-center gap-4">
							<div
								class="w-12 h-12 rounded-full flex items-center justify-center"
								:class="overview.online ? 'bg-green-100 text-green-600' : 'bg-orange-100 text-orange-600'"
							>
								<WifiIcon v-if="overview.online" class="w-6 h-6" />
								<SignalSlashIcon v-else class="w-6 h-6" />
							</div>
							<div>
								<h3 class="font-bold text-gray-900">
									{{ overview.online ? __('Online') : __('Offline') }}
								</h3>
								<p class="text-sm text-gray-500">
									{{
										overview.online
											? __('Terhubung ke server. Data lokal disinkronkan di latar belakang.')
											: __('Bekerja secara lokal. Akan sinkron otomatis begitu online.')
									}}
								</p>
								<p v-if="overview.onlineCheck?.reason" class="text-xs text-gray-400 mt-1 break-words">
									{{ __('Cek koneksi: {0}', [overview.onlineCheck.reason]) }}
									<span v-if="overview.onlineCheck.ms != null">({{ overview.onlineCheck.ms }} ms)</span>
								</p>
							</div>
						</div>
						<button
							@click="handleSyncNow"
							:disabled="syncing || !overview.online"
							class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<ArrowPathIcon class="w-4 h-4" :class="{ 'animate-spin': syncing }" />
							{{ syncing ? __('Menyinkronkan...') : __('Sync Sekarang') }}
						</button>
					</div>

					<!-- Per-data-type last-updated grid -->
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div
							v-for="row in dataRows"
							:key="row.label"
							class="p-4 border border-gray-100 rounded-xl"
						>
							<div class="flex items-center justify-between mb-2">
								<div class="flex items-center gap-2">
									<component :is="row.icon" class="w-5 h-5 text-gray-400" />
									<span class="font-medium text-gray-900">{{ row.label }}</span>
								</div>
								<span class="font-mono text-sm text-gray-600">{{ formatNumber(row.count) }}</span>
							</div>
							<div class="flex items-center justify-between">
								<p v-if="row.noTimestamp" class="text-xs text-gray-500">
									<span :class="row.count > 0 ? 'text-gray-700' : 'text-amber-600'">
										{{ row.count > 0 ? __('Tersedia') : __('Belum pernah') }}
									</span>
								</p>
								<p v-else class="text-xs text-gray-500">
									{{ __('Terakhir diperbarui:') }}
									<span :class="row.lastSyncedAt ? 'text-gray-700' : 'text-amber-600'">
										{{ formatRelative(row.lastSyncedAt) }}
									</span>
								</p>
								<button
									v-if="row.type"
									@click="handleSyncType(row.type)"
									:disabled="syncingType === row.type || !overview.online"
									class="text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
								>
									<ArrowPathIcon class="w-3 h-3" :class="{ 'animate-spin': syncingType === row.type }" />
									{{ syncingType === row.type ? __('Sync...') : __('Sync') }}
								</button>
							</div>
						</div>
					</div>

					<!-- Shifts opened while offline -->
					<div
						v-for="shift in overview.offlineShifts"
						:key="shift.offline_name"
						class="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3"
					>
						<div class="flex items-center gap-2">
							<BuildingStorefrontIcon class="w-5 h-5 text-amber-600" />
							<span class="font-bold text-amber-900">{{ __('Shift dibuka offline: {0}', [shift.pos_profile]) }}</span>
						</div>
						<p class="text-sm text-amber-800">
							{{ __('Belum tersinkron ke server. {0} invoice menunggu shift ini.', [shift.invoice_count]) }}
						</p>
						<p v-if="shift.last_error" class="text-xs text-red-700 break-words">{{ shift.last_error }}</p>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
							<button
								@click="handleRetryOfflineShifts"
								:disabled="busyShift || !overview.online"
								class="px-3 py-2 text-sm font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{{ __('Coba Lagi') }}
							</button>
							<button
								@click="handleUseActiveShift(shift)"
								:disabled="busyShift || !overview.online"
								class="px-3 py-2 text-sm font-semibold rounded-lg bg-white border border-amber-400 text-amber-900 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{{ __('Pakai Shift Aktif di Server') }}
							</button>
						</div>
					</div>

					<!-- Pending queue -->
					<div
						v-if="pendingTotal > 0"
						class="p-4 bg-orange-50 border border-orange-100 rounded-xl"
					>
						<div class="flex items-center justify-between mb-2">
							<div class="flex items-center gap-2">
								<DocumentTextIcon class="w-5 h-5 text-orange-500" />
								<span class="font-bold text-orange-900">{{ __('Antrian Belum Sinkron') }}</span>
							</div>
							<span class="bg-orange-200 text-orange-800 text-xs font-bold px-2 py-1 rounded-full">
								{{ pendingTotal }}
							</span>
						</div>
						<p class="text-sm text-orange-700">
							{{ __('Invoice: {0} tertunda, {1} gagal · Customer: {2} tertunda, {3} gagal', [
								overview.invoiceQueue.pending, overview.invoiceQueue.failed,
								overview.customerQueue.pending, overview.customerQueue.failed,
							]) }}
						</p>
						<button
							v-if="overview.invoiceQueue.pending > 0 || overview.invoiceQueue.failed > 0"
							@click="$emit('open-offline-invoices')"
							class="mt-3 w-full px-3 py-2 text-sm font-semibold rounded-lg bg-orange-600 hover:bg-orange-700 text-white transition-colors flex items-center justify-center gap-2"
						>
							<DocumentTextIcon class="w-4 h-4" />
							{{ __('Lihat & Transaksi Ulang') }}
						</button>
					</div>
					<div v-else class="p-4 bg-green-50 border border-green-100 rounded-xl flex items-center gap-2">
						<CheckCircleIcon class="w-5 h-5 text-green-600" />
						<span class="text-sm text-green-800 font-medium">{{ __('Semua data sudah tersinkron ke server.') }}</span>
					</div>
				</template>

				<div v-else class="text-center text-sm text-red-600 py-8">
					{{ __('Gagal memuat status sinkronisasi.') }}
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue"
import {
	XMarkIcon,
	ArrowPathIcon,
	WifiIcon,
	SignalSlashIcon,
	CubeIcon,
	UserGroupIcon,
	DocumentTextIcon,
	ReceiptPercentIcon,
	CreditCardIcon,
	BuildingStorefrontIcon,
	TagIcon,
	CheckCircleIcon,
} from "@heroicons/vue/24/outline"
import { useToast } from "@/composables/useToast"
import { useShift } from "@/composables/useShift"

defineEmits(["close", "open-offline-invoices"])
const { showSuccess, showError } = useToast()

const BASE = "http://127.0.0.1:8871"

const loading = ref(true)
const syncing = ref(false)
const syncingType = ref(null)
const overview = ref(null)
let pollTimer = null
const busyShift = ref(false)
const { checkOpeningShift } = useShift()

// `type` matches server/index.js's SYNCABLE map (POST /sync/run/:type) —
// only set for rows the outlet can manually refresh on their own (item,
// customer, promo, payment method, per what was actually asked for).
// Taxes/POS Profile stay read-only here, refreshed by "Sync Sekarang".
const dataRows = computed(() => {
	if (!overview.value) return []
	return [
		{ label: __("Katalog Barang"), icon: CubeIcon, type: "items", count: overview.value.items.count, lastSyncedAt: overview.value.items.lastSyncedAt },
		{ label: __("Pelanggan"), icon: UserGroupIcon, type: "customers", count: overview.value.customers.count, lastSyncedAt: overview.value.customers.lastSyncedAt },
		{ label: __("Promo & Kupon"), icon: TagIcon, type: "offers", count: overview.value.offers.count, lastSyncedAt: overview.value.offers.lastSyncedAt },
		{ label: __("Metode Pembayaran"), icon: CreditCardIcon, type: "paymentMethods", count: overview.value.paymentMethods.count, lastSyncedAt: overview.value.paymentMethods.lastSyncedAt },
		{ label: __("Pajak"), icon: ReceiptPercentIcon, count: overview.value.taxes.count, lastSyncedAt: overview.value.taxes.lastSyncedAt },
		// posProfiles has no lastSyncedAt of its own in /sync/overview (a
		// full-refetch table with no separate timestamp column) — a row
		// existing at all means it was fetched successfully at least once.
		{ label: __("POS Profile"), icon: BuildingStorefrontIcon, count: overview.value.posProfiles.count, noTimestamp: true },
	]
})

const pendingTotal = computed(() => {
	if (!overview.value) return 0
	const { invoiceQueue, customerQueue } = overview.value
	return (invoiceQueue.pending || 0) + (invoiceQueue.failed || 0) + (customerQueue.pending || 0) + (customerQueue.failed || 0)
})

function formatNumber(num) {
	return (num || 0).toLocaleString("id-ID")
}

function formatRelative(iso) {
	if (!iso) return __("Belum pernah")
	const diffMs = Date.now() - new Date(iso).getTime()
	const minutes = Math.floor(diffMs / 60000)
	if (minutes < 1) return __("Baru saja")
	if (minutes < 60) return __("{0} menit lalu", [minutes])
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return __("{0} jam lalu", [hours])
	const days = Math.floor(hours / 24)
	return __("{0} hari lalu", [days])
}

async function loadOverview() {
	try {
		const res = await fetch(`${BASE}/sync/overview`)
		overview.value = await res.json()
	} catch {
		overview.value = null
	} finally {
		loading.value = false
	}
}

async function handleSyncType(type) {
	syncingType.value = type
	try {
		const res = await fetch(`${BASE}/sync/run/${type}`, { method: "POST" })
		const data = await res.json()
		if (!res.ok || data.error) {
			showError(data.error || __("Sync gagal"))
		} else if (data.online === false) {
			showError(__("Tidak bisa sync — server tidak terjangkau."))
		} else {
			showSuccess(__("Berhasil disinkronkan."))
		}
		await loadOverview()
	} catch (e) {
		showError(__("Sync gagal: {0}", [e.message]))
	} finally {
		syncingType.value = null
	}
}

async function handleRetryOfflineShifts() {
	busyShift.value = true
	try {
		const res = await fetch(`${BASE}/sync/offline-shifts/retry`, { method: "POST" })
		const data = await res.json()
		if (data.shifts?.failed > 0) showError(__("Shift offline belum bisa dibuat di server. Lihat pesan error di bawah."))
		else showSuccess(__("Shift offline berhasil disinkronkan."))
		await checkOpeningShift.fetch()
	} catch (e) {
		showError(__("Gagal sinkron: {0}", [e.message]))
	} finally {
		busyShift.value = false
		await loadOverview()
	}
}

async function handleUseActiveShift(shift) {
	const ok = window.confirm(
		__("Invoice offline ({0}) akan dipindah ke shift yang sedang terbuka di server. Lanjutkan?", [shift.invoice_count]),
	)
	if (!ok) return
	busyShift.value = true
	try {
		const res = await fetch(`${BASE}/sync/offline-shifts/${encodeURIComponent(shift.offline_name)}/use-active`, { method: "POST" })
		const data = await res.json()
		if (!res.ok || data.error) {
			showError(data.error || __("Gagal memakai shift aktif"))
		} else {
			showSuccess(__("Invoice dipindah ke shift aktif di server."))
			await checkOpeningShift.fetch()
		}
	} catch (e) {
		showError(__("Gagal: {0}", [e.message]))
	} finally {
		busyShift.value = false
		await loadOverview()
	}
}

async function handleSyncNow() {
	syncing.value = true
	try {
		const res = await fetch(`${BASE}/sync/run`, { method: "POST" })
		const data = await res.json()
		if (!data.online) {
			showError(__("Tidak bisa sync — server tidak terjangkau."))
		} else {
			showSuccess(__("Sinkronisasi selesai."))
		}
		await loadOverview()
	} catch (e) {
		showError(__("Sync gagal: {0}", [e.message]))
	} finally {
		syncing.value = false
	}
}

onMounted(() => {
	loadOverview()
	// Keep the numbers fresh while the dialog is open (e.g. watching a
	// background sync cycle complete), without the cashier needing to close
	// and reopen it.
	pollTimer = setInterval(loadOverview, 5000)
})

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer)
})
</script>
