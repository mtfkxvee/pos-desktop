<template>
	<Dialog v-model="show" :options="{ title: __('Apply'), size: 'md' }">
		<template #body-content>
			<div class="flex flex-col gap-4">
				<!-- Info Banner -->
				<div class="bg-blue-50 border border-blue-200 rounded-lg p-3">
					<div class="flex items-start gap-2">
						<svg class="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
							<path fill-rule="evenodd"
								d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
								clip-rule="evenodd" />
						</svg>
						<div class="flex-1">
							<p class="text-xs font-medium text-blue-900">{{ __('Have a coupon code?') }}</p>
							<p class="text-xs text-blue-700 mt-0.5">{{ __('Enter your promotional or gift card code below') }}</p>
						</div>
					</div>
				</div>

				<!-- Coupon Code Input -->
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-2 text-start">
						{{ appliedCoupons.length ? __('Tambah kupon lain') : __('Coupon Code') }}
					</label>
					<div class="flex gap-2">
						<Input v-model="couponCode" type="text" :placeholder="__('ENTER-CODE-HERE')" class="flex-1 uppercase"
							@keyup.enter="applyCoupon" :disabled="applying" />
						<Button @click="applyCoupon" :loading="applying" theme="blue" variant="solid" class="flex-shrink-0">
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
									d="M5 13l4 4L19 7" />
							</svg>
						</Button>
					</div>
					<p class="text-xs text-gray-500 mt-1">{{ __('Code is case-insensitive') }}</p>
				</div>

				<!-- My Gift Cards -->
				<div v-if="availableGiftCards.length > 0">
					<label class="block text-sm font-medium text-gray-700 mb-2 text-start">
						<div class="flex items-center gap-2">
							<svg class="w-4 h-4 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
								<path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
								<path fill-rule="evenodd"
									d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z"
									clip-rule="evenodd" />
							</svg>
							<span>{{ __('My Gift Cards ({0})', [availableGiftCards.length]) }}</span>
						</div>
					</label>
					<div class="flex flex-col gap-2 max-h-60 overflow-y-auto pe-1">
						<div v-for="card in availableGiftCards" :key="card.coupon_code" @click="applyGiftCard(card)"
							class="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-purple-400 transition-all">
							<div class="flex items-center justify-between">
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<div
											class="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center">
											<svg class="w-4 h-4 text-purple-600" fill="currentColor"
												viewBox="0 0 20 20">
												<path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
												<path fill-rule="evenodd"
													d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z"
													clip-rule="evenodd" />
											</svg>
										</div>
										<div class="flex-1">
											<h4 class="text-sm font-bold text-gray-900">
												{{ card.coupon_code }}
											</h4>
											<p class="text-xs text-gray-600">{{ card.coupon_name }}</p>
										</div>
									</div>
								</div>
								<svg class="w-5 h-5 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
									<path fill-rule="evenodd"
										d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
										clip-rule="evenodd" />
								</svg>
							</div>
						</div>
					</div>
				</div>

				<!-- Applied Coupons (stacked, in the order applied) -->
				<div v-if="appliedCoupons.length" class="bg-green-50 border-2 border-green-500 rounded-lg p-3">
					<h4 class="text-sm font-bold text-green-900 mb-2 text-start">
						{{ __('Kupon dipakai ({0})', [appliedCoupons.length]) }}
					</h4>
					<div class="flex flex-col gap-2">
						<div v-for="c in appliedCoupons" :key="c.code"
							class="bg-white rounded-lg px-3 py-2 flex items-center justify-between gap-2">
							<div class="min-w-0 text-start">
								<p class="text-sm font-bold text-gray-900 truncate">{{ c.code }}</p>
								<p class="text-xs text-gray-500 truncate">
									{{ c.type === 'Percentage' ? __('{0}% off', [c.percentage]) : formatCurrency(c.value) }}
								</p>
							</div>
							<div class="flex items-center gap-2 flex-shrink-0">
								<span class="text-sm font-bold text-green-600">-{{ formatCurrency(c.amount) }}</span>
								<button type="button" @click="emit('coupon-removed', c.code)"
									class="w-7 h-7 rounded-full flex items-center justify-center text-red-600 hover:bg-red-50"
									:aria-label="__('Remove')">
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						</div>
					</div>
					<div v-if="appliedCoupons.length > 1"
						class="flex justify-between items-center mt-2 pt-2 border-t border-green-200">
						<span class="text-xs font-medium text-green-900">{{ __('Total diskon kupon') }}</span>
						<span class="text-base font-bold text-green-700">-{{ formatCurrency(couponTotal) }}</span>
					</div>
				</div>

				<!-- Error Message -->
				<div v-if="errorMessage" class="bg-red-50 border border-red-200 rounded-lg p-3">
					<div class="flex items-start gap-2">
						<svg class="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
							<path fill-rule="evenodd"
								d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
								clip-rule="evenodd" />
						</svg>
						<p class="text-xs text-red-800">{{ errorMessage }}</p>
					</div>
				</div>
			</div>
		</template>
		<template #actions>
			<div class="flex justify-end items-center w-full gap-2">
				<Button variant="subtle" @click="show = false">
					{{ __('Close') }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import {
	DEFAULT_CURRENCY,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { Button, Dialog, Input, createResource } from "frappe-ui"
import { computed, ref, watch } from "vue"
import { useToast } from "@/composables/useToast"

const { showError, showWarning } = useToast()

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
	// Coupons already on the cart, in the order applied (posCart.appliedCoupons)
	appliedCoupons: {
		type: Array,
		default: () => [],
	},
	couponTotal: {
		type: Number,
		default: 0,
	},
})

const emit = defineEmits([
	"update:modelValue",
	"coupon-applied",
	"coupon-removed",
])

const show = ref(props.modelValue)
const couponCode = ref("")
const giftCards = ref([])
const applying = ref(false)
const errorMessage = ref("")

const availableGiftCards = computed(() => {
	const used = new Set(props.appliedCoupons.map((c) => c.code))
	return giftCards.value.filter((card) => !used.has(String(card.coupon_code).toUpperCase()))
})

// Resource to load gift cards
const giftCardsResource = createResource({
	url: "pos_next.api.offers.get_active_coupons",
	makeParams() {
		return {
			customer: props.customer,
			company: props.company,
		}
	},
	auto: false,
	onSuccess(data) {
		giftCards.value = data?.message || data || []
	},
})

// Resource to validate coupon. No customer = the POS sells to its walk-in
// customer, which the server accepts.
const couponResource = createResource({
	url: "pos_next.api.offers.validate_coupon",
	makeParams() {
		return {
			coupon_code: couponCode.value.trim(),
			customer: props.customer || "",
			company: props.company,
		}
	},
	auto: false,
})

watch(
	() => props.modelValue,
	(val) => {
		show.value = val
		if (val) {
			loadGiftCards()
			errorMessage.value = ""
			couponCode.value = ""
		}
	},
)

watch(show, (val) => {
	emit("update:modelValue", val)
})

async function loadGiftCards() {
	giftCards.value = []
	if (!props.customer || !props.company) return
	try {
		await giftCardsResource.reload()
	} catch (error) {
		console.error("Error loading gift cards:", error)
	}
}

function applyGiftCard(card) {
	couponCode.value = card.coupon_code
	applyCoupon()
}

async function applyCoupon() {
	const code = couponCode.value.trim().toUpperCase()
	if (!code) {
		errorMessage.value = __("Masukkan kode kupon")
		return
	}
	if (props.appliedCoupons.some((c) => c.code === code)) {
		errorMessage.value = __("Kupon {0} sudah dipakai di transaksi ini", [code])
		showWarning(errorMessage.value)
		return
	}

	applying.value = true
	errorMessage.value = ""

	try {
		await couponResource.reload()
		// Frappe wraps response in { message: {...} }
		const result = couponResource.data?.message || couponResource.data

		// Handle if result is the actual response object
		const validationData =
			typeof result === "object" && result.valid !== undefined
				? result
				: couponResource.data

		if (!validationData || !validationData.valid) {
			errorMessage.value =
				validationData?.message ||
				__("The coupon code you entered is not valid")
			showError(errorMessage.value)
			return
		}

		const coupon = validationData.coupon

		// Check minimum amount (on subtotal before tax)
		if (coupon.min_amount && props.subtotal < coupon.min_amount) {
			errorMessage.value = __("Kupon ini butuh minimal belanja {0}", [
				formatCurrency(coupon.min_amount),
			])
			showWarning(errorMessage.value)
			return
		}

		// The cart works out the amount: coupons stack, each taken from what
		// the ones before it left (posCart.computeCouponAmounts).
		const isPercentage = coupon.discount_type === "Percentage"
		emit("coupon-applied", {
			name: coupon.coupon_name || coupon.coupon_code,
			code,
			percentage: isPercentage ? coupon.discount_percentage || 0 : 0,
			type: coupon.discount_type,
			coupon,
			apply_on: coupon.apply_on,
		})

		couponCode.value = ""
		errorMessage.value = ""
	} catch (error) {
		console.error("Error applying coupon:", error)
		errorMessage.value = __("Gagal memakai kupon. Silakan coba lagi.")
		showError(errorMessage.value)
	} finally {
		applying.value = false
	}
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}
</script>
