<template>
	<div class="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-50">
		<div class="w-full max-w-md mx-4 bg-white rounded-2xl shadow-xl p-8">
			<div class="flex justify-center mb-6">
				<div class="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center">
					<div
						v-if="busy"
						class="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"
					></div>
					<svg v-else-if="error" class="w-10 h-10 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
					</svg>
					<svg v-else class="w-10 h-10 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
					</svg>
				</div>
			</div>

			<h2 class="text-xl font-bold text-gray-900 text-center mb-1">
				{{ __('Menyiapkan Data') }}
			</h2>
			<p class="text-sm text-gray-500 text-center mb-6">
				{{ __('Mengunduh produk, pelanggan, promo, dan data lain untuk perangkat ini — sekali saja, setelahnya kasir bisa jalan tanpa menunggu ini lagi.') }}
			</p>

			<div class="flex flex-col gap-2 mb-6">
				<div
					v-for="step in steps"
					:key="step.key"
					class="flex items-center gap-3 px-3 py-2 rounded-lg"
					:class="step.done ? 'bg-green-50' : 'bg-gray-50'"
				>
					<div
						class="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
						:class="step.done ? 'bg-green-500' : 'bg-gray-300'"
					>
						<svg v-if="step.done" class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
							<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
						</svg>
						<div v-else-if="busy" class="w-2 h-2 bg-white rounded-full animate-pulse"></div>
					</div>
					<span class="text-sm" :class="step.done ? 'text-green-700 font-medium' : 'text-gray-500'">
						{{ step.label }}
					</span>
				</div>
			</div>

			<div v-if="error" class="mb-4 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
				{{ error }}
			</div>

			<button
				v-if="error && !busy"
				@click="retry"
				class="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition-colors"
			>
				{{ __('Coba Lagi') }}
			</button>
			<p v-else-if="busy" class="text-center text-xs text-gray-400">
				{{ __('Mohon tunggu, jangan tutup aplikasi...') }}
			</p>
		</div>
	</div>
</template>

<script setup>
/**
 * Shown once between login and POSSale — see useInitialSync.js. App.vue
 * decides whether this even renders (skipped entirely when the local cache
 * is already fully populated, e.g. every login after the very first one).
 */
import { computed, onMounted } from "vue"
import { useInitialSync, STEPS, isFullyReady } from "@/composables/useInitialSync"

// App.vue already did the initial check before ever mounting this component
// (so the common case — data already downloaded from a previous login —
// never flashes this screen at all) and only renders it when NOT ready. So
// this component's own job starts from "not ready", straight into syncing.
const emit = defineEmits(["ready"])

const { checking, syncing, overview, error, check, runSync } = useInitialSync()

const busy = computed(() => checking.value || syncing.value)

const steps = computed(() =>
	STEPS.map((s) => {
		const entry = overview.value?.[s.key]
		const done = s.key === "posProfiles" ? (entry?.count || 0) > 0 : !!entry?.lastSyncedAt
		return { ...s, done }
	})
)

async function start() {
	await check()
	if (isFullyReady(overview.value)) {
		emit("ready")
		return
	}
	const ok = await runSync()
	if (ok) emit("ready")
}

function retry() {
	start()
}

onMounted(start)
</script>
