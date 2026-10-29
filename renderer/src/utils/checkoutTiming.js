import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"

const log = logger.create("CheckoutTiming")

// Anything slower than this is worth a line in the ERP Error Log so support
// can see WHICH checkout stage is slow at a given outlet (local save, print,
// loyalty wait) without needing the cashier's console.
const SLOW_MS = 2000

/**
 * Log how long a checkout stage took since `startedAt` (performance.now()),
 * and report it to the ERP Error Log when it was slow. Best-effort: never
 * throws and never blocks the caller.
 * @returns {number} elapsed milliseconds
 */
export function reportStage(stage, startedAt, context = {}) {
	const ms = Math.round(performance.now() - startedAt)
	if (ms < SLOW_MS) {
		log.debug(`[checkout] ${stage} took ${ms}ms`)
		return ms
	}
	log.warn(`[checkout] ${stage} was slow: ${ms}ms`, context)
	try {
		call("pos_next.api.utilities.log_client_error", {
			title: "POS Slow Checkout Stage",
			message: `${stage} took ${ms}ms`,
			context: JSON.stringify({ stage, ms, ...context }),
		}).catch(() => {})
	} catch {
		// logging must never affect the sale
	}
	return ms
}
