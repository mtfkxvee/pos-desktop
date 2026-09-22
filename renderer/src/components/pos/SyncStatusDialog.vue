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
							<p class="text-xs text-gray-500">
								{{ __('Terakhir diperbarui:') }}
								<span :class="row.lastSyncedAt ? 'text-gray-700' : 'text-amber-600'">
									{{ formatRelative(row.lastSyncedAt) }}
								</span>
							</p>
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
	CheckCircleIcon,
} from "@heroicons/vue/24/outline"
import { useToast } from "@/composables/useToast"

defineEmits(["close"])
const { showSuccess, showError } = useToast()

const BASE = "http://127.0.0.1:8871"

const loading = ref(true)
const syncing = ref(false)
const overview = ref(null)
let pollTimer = null

const dataRows = computed(() => {
	if (!overview.value) return []
	return [
		{ label: __("Katalog Barang"), icon: CubeIcon, count: overview.value.items.count, lastSyncedAt: overview.value.items.lastSyncedAt },
		{ label: __("Pelanggan"), icon: UserGroupIcon, count: overview.value.customers.count, lastSyncedAt: overview.value.customers.lastSyncedAt },
		{ label: __("Pajak"), icon: ReceiptPercentIcon, count: overview.value.taxes.count, lastSyncedAt: overview.value.taxes.lastSyncedAt },
		{ label: __("Metode Pembayaran"), icon: CreditCardIcon, count: overview.value.paymentMethods.count, lastSyncedAt: overview.value.paymentMethods.lastSyncedAt },
		{ label: __("POS Profile"), icon: BuildingStorefrontIcon, count: overview.value.posProfiles.count, lastSyncedAt: overview.value.paymentMethods.lastSyncedAt },
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
