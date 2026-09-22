import { createResource } from "frappe-ui"
import { computed, ref } from "vue"
import { friendlyError } from "@/utils/errorHandler"
import { useToast } from "@/composables/useToast"

export const shiftState = ref({
	pos_opening_shift: null,
	pos_profile: null,
	company: null,
	isOpen: false,
	/** Initial elapsed ms at the moment shift data was received from server */
	_initialElapsedMs: 0,
	/** Local timestamp (Date.now()) when shift data was received */
	_receivedAt: 0,
})

export function useShift() {
	const { showError } = useToast()
	// Check for existing open shift. The local server (server/routes/rpc.js)
	// already mirrors every genuine answer into SQLite and serves THAT when
	// offline/unreachable — so onSuccess below covers both the real and the
	// offline-fallback case identically. onError is now only a rare
	// last-resort (e.g. the local server itself isn't up yet); deliberately
	// does NOT assume a shift is open on error — a previous bug here trusted
	// stale browser localStorage on any failure, which could show a stale
	// "shift open" with the wrong POS Profile instead of the shift-opening
	// screen. When we can't reliably determine shift status, the safe
	// default is "no shift" (shows the opening dialog), not a guess.
	const checkOpeningShift = createResource({
		url: "pos_next.api.shifts.check_opening_shift",
		auto: false,
		onSuccess(data) {
			// Require an actual pos_opening_shift, not just any truthy value —
			// a bare `{}` (seen from a response-parsing edge case, see
			// server/frappe-client.js) must never be treated as "shift open".
			if (data?.pos_opening_shift) {
				// Compute initial elapsed time using server timestamps
				// (avoids timezone mismatch between server and browser)
				let initialElapsedMs = 0
				if (data.server_now && data.pos_opening_shift?.period_start_date) {
					const serverNow = new Date(data.server_now).getTime()
					const shiftStart = new Date(
						data.pos_opening_shift.period_start_date,
					).getTime()
					initialElapsedMs = Math.max(0, serverNow - shiftStart)
				}
				shiftState.value = {
					pos_opening_shift: data.pos_opening_shift,
					pos_profile: data.pos_profile,
					company: data.company,
					isOpen: true,
					_initialElapsedMs: initialElapsedMs,
					_receivedAt: Date.now(),
				}
			} else {
				shiftState.value = {
					pos_opening_shift: null,
					pos_profile: null,
					company: null,
					isOpen: false,
					_initialElapsedMs: 0,
					_receivedAt: 0,
				}
			}
		},
		onError(error) {
			console.error("Error checking opening shift:", error)
		},
	})

	// Get opening dialog data (POS profiles, payment methods, etc.)
	const getOpeningDialogData = createResource({
		url: "pos_next.api.shifts.get_opening_dialog_data",
		auto: false,
	})

	// Create new opening shift
	const createOpeningShift = createResource({
		url: "pos_next.api.shifts.create_opening_shift",
		makeParams({ pos_profile, company, balance_details }) {
			return {
				pos_profile,
				company,
				balance_details: JSON.stringify(balance_details),
			}
		},
		onSuccess(data) {
			shiftState.value = {
				pos_opening_shift: data.pos_opening_shift,
				pos_profile: data.pos_profile,
				company: data.company,
				isOpen: true,
				_initialElapsedMs: 0,
				_receivedAt: Date.now(),
			}
			// Local server already mirrored this into SQLite (server/routes/rpc.js,
			// SHIFT_MIRROR_METHODS) — no renderer-side persistence needed.
		},
		onError(error) {
			console.error("Error creating opening shift:", error)
			showError(friendlyError(error, __("Failed to open shift. Please try again.")))
		},
	})

	// Get closing shift data
	const getClosingShiftData = createResource({
		url: "pos_next.api.shifts.get_closing_shift_data",
		makeParams({ opening_shift }) {
			return { opening_shift }
		},
		auto: false,
	})

	// Submit closing shift
	const submitClosingShift = createResource({
		url: "pos_next.api.shifts.submit_closing_shift",
		makeParams({ closing_shift }) {
			return { closing_shift: JSON.stringify(closing_shift) }
		},
		onSuccess() {
			shiftState.value = {
				pos_opening_shift: null,
				pos_profile: null,
				company: null,
				isOpen: false,
				_initialElapsedMs: 0,
				_receivedAt: 0,
			}
			// Local server already cleared its SQLite mirror (server/routes/rpc.js).
		},
		onError(error) {
			console.error("Error submitting closing shift:", error)
			showError(friendlyError(error, __("Failed to close shift. Please try again.")))
		},
	})

	// Computed properties
	const hasOpenShift = computed(() => shiftState.value.isOpen)
	const currentShift = computed(() => shiftState.value.pos_opening_shift)
	const currentProfile = computed(() => shiftState.value.pos_profile)
	const currentCompany = computed(() => shiftState.value.company)

	return {
		// State
		shiftState,
		hasOpenShift,
		currentShift,
		currentProfile,
		currentCompany,

		// Resources
		checkOpeningShift,
		getOpeningDialogData,
		createOpeningShift,
		getClosingShiftData,
		submitClosingShift,
	}
}
