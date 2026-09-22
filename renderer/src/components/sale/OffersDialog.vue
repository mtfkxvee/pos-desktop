<template>
	<Dialog
		v-model="show"
		:options="{ title: __('Available Offers'), size: 'lg' }"
	>
		<template #body-content>
			<div class="flex flex-col gap-4">
				<!-- Loading State -->
				<div v-if="loading" class="py-8 text-center">
					<div class="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500 mx-auto"></div>
					<p class="mt-3 text-sm text-gray-500">{{ __('Loading offers...') }}</p>
				</div>

				<!--
					Fetch-Failed State — offersStore.hasFetched only flips to true on
					a REAL success now (see posOffers.js: it used to also flip true
					on failure "to prevent infinite retries", which made a single
					502 permanently disable retries and leave the loading spinner
					above stuck forever, since `loading` depends on !hasFetched).
					With that fixed, hasFetched can legitimately stay false for the
					whole duration of the retry/backoff loop AND after it gives up —
					so without this branch, a cashier facing a flaky server would
					stare at "Loading offers..." forever with no way to tell it had
					actually failed, and no way to retry.
				-->
				<div v-else-if="fetchFailed" class="py-8 text-center">
					<div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-amber-100">
						<svg class="h-8 w-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
						</svg>
					</div>
					<h3 class="mt-4 text-sm font-medium text-gray-900">{{ __('Failed to load offers') }}</h3>
					<p class="mt-2 text-xs text-gray-500">{{ __('Could not reach the server. Check your connection and try again.') }}</p>
					<button
						type="button"
						@click="cartStore.forceRefreshOffers()"
						class="mt-4 px-4 py-2 rounded-lg text-sm font-semibold bg-green-600 hover:bg-green-700 text-white transition-colors"
					>
						{{ __('Try Again') }}
					</button>
				</div>

				<!-- Empty State -->
				<div v-else-if="eligibleOffers.length === 0" class="py-12 text-center">
					<div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-gray-100">
						<svg class="h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/>
						</svg>
					</div>
					<h3 class="mt-4 text-sm font-medium text-gray-900">{{ __('No offers available') }}</h3>
					<p class="mt-2 text-xs text-gray-500">
						{{ __('Add items to your cart to see eligible offers') }}
					</p>
				</div>

				<!-- Offers List -->
				<div v-else>
					<div class="flex flex-col gap-3 max-h-[500px] overflow-y-auto pe-2">
						<div
							v-for="offer in eligibleOffers"
							:key="offer.name"
							:class="[
								'relative rounded-xl p-4 transition-all duration-200 border-2',
								isOfferApplied(offer)
									? 'bg-green-50 border-green-500 shadow-md'
									: 'bg-gradient-to-r from-green-50 to-emerald-50 border-green-200 hover:border-green-400 hover:shadow-lg cursor-pointer'
							]"
						>
						<!-- Applied Badge -->
						<div
							v-if="isOfferApplied(offer)"
							class="absolute top-2 end-2 bg-green-600 text-white text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1"
						>
							<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
								<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
							</svg>
							<span>{{ __('APPLIED') }}</span>
						</div>

						<!-- Source Badge (Pricing Rule vs Promotional Scheme) -->
						<div
							:class="[
								'absolute top-2 text-[10px] font-bold px-2 py-1 rounded-full',
								isOfferApplied(offer) ? 'end-24' : 'end-2',
								offer.source === 'Pricing Rule'
									? 'bg-blue-600 text-white'
									: 'bg-purple-600 text-white'
							]"
						>
							{{ offer.source === 'Pricing Rule' ? __('PRICING RULE') : __('PROMO SCHEME') }}
						</div>

						<!-- Offer Header -->
						<div class="mb-3 me-28">
							<h4 class="text-base font-bold text-gray-900 text-start">
								{{ offer.title || offer.name }}
							</h4>
							<p v-if="offer.description" class="text-xs text-gray-600 mt-1 text-start">
								{{ offer.description }}
							</p>
						</div>

						<!-- Discount Display -->
						<div class="flex items-center gap-3 mb-3">
							<div
								:class="[
									'text-white px-4 py-2 rounded-lg transition-all',
									isOfferApplied(offer)
										? 'bg-green-700 ring-2 ring-green-600'
										: offer.offer === 'Give Product'
											? 'bg-purple-600'
											: offer.discount_percentage
												? 'bg-orange-600'
												: 'bg-green-600'
								]"
							>
								<div class="text-lg font-bold">
									<span v-if="offer.discount_percentage">{{ __('{0}% OFF', [Number(offer.discount_percentage).toFixed(2)]) }}</span>
									<span v-else-if="offer.discount_amount">{{ __('{0} OFF', [formatCurrency(offer.discount_amount)]) }}</span>
									<span v-else>{{ __('Special Offer') }}</span>
								</div>
							</div>
							<div v-if="offer.offer === 'Give Product'" class="text-xs bg-purple-100 text-purple-700 px-3 py-1 rounded-full font-semibold">
								{{ __('+ Free Item') }}
							</div>
						</div>

						<!-- Offer Details -->
						<div class="grid grid-cols-2 gap-3 mb-3">
							<!-- Min Amount -->
							<div v-if="offer.min_amt" class="flex items-center gap-2">
								<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
								</svg>
								<div>
									<p class="text-[10px] text-gray-500">{{ __('Min Purchase') }}</p>
									<p class="text-xs font-semibold text-gray-900">{{ formatCurrency(offer.min_amt) }}</p>
								</div>
							</div>

							<!-- Min Quantity -->
							<div v-if="offer.min_qty" class="flex items-center gap-2">
								<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/>
								</svg>
								<div>
									<p class="text-[10px] text-gray-500">{{ __('Min Quantity') }}</p>
									<p class="text-xs font-semibold text-gray-900">{{ __('{0} items', [offer.min_qty]) }}</p>
								</div>
							</div>

							<!-- Valid Until -->
							<div v-if="offer.valid_upto" class="flex items-center gap-2">
								<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
								</svg>
								<div>
									<p class="text-[10px] text-gray-500">{{ __('Valid Until') }}</p>
									<p class="text-xs font-semibold text-gray-900">{{ formatDate(offer.valid_upto) }}</p>
								</div>
							</div>

							<!-- Offer Type -->
							<div class="flex items-center gap-2">
								<svg class="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 20 20">
									<path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/>
								</svg>
								<div>
									<p class="text-[10px] text-gray-500">{{ __('Type') }}</p>
									<p class="text-xs font-semibold text-gray-900">{{ offer.offer || __('Discount') }}</p>
								</div>
							</div>
						</div>

						<!-- Progress Bar for Min Amount (only shown if not eligible) -->
						<div v-if="offer.min_amt && offersStore.cartSnapshot.subtotal < offer.min_amt" class="mt-3">
							<div class="flex items-center justify-between text-xs mb-1">
								<span class="text-gray-600">{{ __('Subtotal (before tax)') }}</span>
								<span class="text-gray-900 font-semibold">
									{{ formatCurrency(offersStore.cartSnapshot.subtotal) }} / {{ formatCurrency(offer.min_amt) }}
								</span>
							</div>
							<div class="w-full bg-gray-200 rounded-full h-2">
								<div
									class="bg-green-600 h-2 rounded-full transition-all"
									:style="{ width: `${Math.min((offersStore.cartSnapshot.subtotal / offer.min_amt) * 100, 100)}%` }"
								></div>
							</div>
							<p class="text-xs text-orange-600 mt-1 font-medium">
								{{ __('Add {0} more to unlock', [formatCurrency(offersStore.getUnlockAmount(offer))]) }}
							</p>
						</div>

						<!-- Offer Status -->
						<div class="mt-3">
							<div
								v-if="isOfferApplied(offer)"
								class="w-full py-2 px-4 rounded-lg font-semibold text-sm bg-green-100 text-green-800 border border-green-300 flex items-center justify-center gap-2"
							>
								<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
									<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
								</svg>
								{{ __('Applied') }}
							</div>
							<!-- Manual activation required -->
							<button
								v-else-if="offer.validate_applied_rule"
								type="button"
								:disabled="applyingOfferName === offer.name"
								class="w-full py-2 px-4 rounded-lg font-semibold text-sm bg-orange-500 hover:bg-orange-600 active:bg-orange-700 disabled:opacity-70 disabled:cursor-not-allowed text-white flex items-center justify-center gap-2 transition-colors"
								@click="handleApplyClick(offer)"
							>
								<template v-if="applyingOfferName === offer.name">
									<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
									</svg>
									{{ __('Applying...') }}
								</template>
								<template v-else>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
									</svg>
									{{ __('Tap to Apply') }}
								</template>
							</button>
							<!-- Auto-apply -->
							<div
								v-else
								class="w-full py-2 px-4 rounded-lg font-semibold text-sm bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center gap-2"
							>
								<svg class="w-4 h-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
								</svg>
								{{ __('Will apply when eligible') }}
							</div>
						</div>
					</div>
				</div>
			</div>
			</div>
		</template>
		<template #actions>
			<div class="flex justify-end w-full">
				<Button variant="subtle" @click="show = false">
					{{ __('Close') }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSOffersStore } from "@/stores/posOffers"
import {
	DEFAULT_CURRENCY,
	DEFAULT_LOCALE,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, ref, watch } from "vue"

// Use Pinia stores
const offersStore = usePOSOffersStore()
const cartStore = usePOSCartStore()

const props = defineProps({
	modelValue: Boolean,
	subtotal: {
		type: Number,
		required: true,
		note: __("Cart subtotal BEFORE tax - used for discount calculations"),
	},
	items: Array,
	posProfile: String,
	customer: String,
	company: String,
	currency: {
		type: String,
		default: DEFAULT_CURRENCY,
	},
	appliedOffers: {
		type: Array,
		default: () => [],
	},
})

const emit = defineEmits(["update:modelValue", "apply-offer"])

const show = ref(props.modelValue)

// Per-offer "applying" spinner for the "Tap to Apply" button. The parent
// (POSSale.vue) holds a template ref to this component and calls
// resetApplyingState() on every failure path inside cartStore.applyOffer()
// (network error, offline, cart no longer eligible, etc.) — that method
// didn't exist here at all, so every one of those failure paths threw
// "resetApplyingState is not a function" instead of just showing the error
// toast, which also meant the button never got any visual feedback while
// the request was in flight to begin with. Tracking it properly here fixes
// both: a real spinner during the request, and a working reset on failure.
const applyingOfferName = ref(null)

function handleApplyClick(offer) {
	if (applyingOfferName.value) return // ignore taps while one is in flight
	applyingOfferName.value = offer.name
	emit("apply-offer", offer)
}

defineExpose({
	resetApplyingState: () => {
		applyingOfferName.value = null
	},
})
const appliedOfferCodes = computed(() => {
	return new Set(
		(props.appliedOffers || []).map((entry) => entry?.code).filter(Boolean),
	)
})

// Use ALL eligible offers from store (includes both auto and manual offers)
const eligibleOffers = computed(() => offersStore.allEligibleOffersSorted)

// Loading state - check if offers are still being fetched (incl. the
// retry/backoff loop under a flaky server — see triggerOfferProcessing in
// posCart.js). isProcessing reflects that ongoing attempt; hasFetched alone
// used to be enough to detect "done" back when a failed fetch immediately
// latched hasFetched=true, but that's no longer true (see posOffers.js), so
// checking isProcessing too avoids the spinner clearing mid-retry only to
// flip back to it on the next attempt.
const loading = computed(() => {
	if (offersStore.hasFetched) return false
	if (eligibleOffers.value.length > 0) return false
	return cartStore.offerProcessingState.isProcessing || !cartStore.offerProcessingState.error
})

// Retries genuinely exhausted with nothing to show — surface an explicit
// failure + retry action instead of leaving the spinner above stuck forever.
const fetchFailed = computed(() => {
	return (
		!offersStore.hasFetched &&
		eligibleOffers.value.length === 0 &&
		!cartStore.offerProcessingState.isProcessing &&
		!!cartStore.offerProcessingState.error
	)
})

watch(
	() => props.modelValue,
	(val) => {
		show.value = val
		// No need to load offers - they're already in the store
	},
)

watch(show, (val) => {
	emit("update:modelValue", val)
})

function isOfferApplied(offer) {
	return appliedOfferCodes.value.has(offer?.name)
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}

function formatDate(dateStr) {
	if (!dateStr) return ""
	const date = new Date(dateStr)
	return date.toLocaleDateString(DEFAULT_LOCALE, {
		month: "short",
		day: "numeric",
		year: "numeric",
	})
}
</script>
