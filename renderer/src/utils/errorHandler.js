/**
 * Common Error Handler for API Exceptions
 * Provides consistent error parsing and user-friendly messages
 *
 * Usage:
 *
 * import { parseError } from '@/utils/errorHandler'
 *
 * try {
 *   await api.submitInvoice()
 * } catch (error) {
 *   const errorContext = parseError(error)
 *   // errorContext = { title, message, type, technicalDetails, retryable }
 *
 *   // Set dialog state
 *   errorTitle.value = errorContext.title
 *   errorMessage.value = errorContext.message
 *   showErrorDialog.value = true
 * }
 */

/**
 * Clean HTML and extra whitespace from error messages
 */
function cleanErrorMessage(rawMessage) {
	if (!rawMessage) return ""

	if (Array.isArray(rawMessage)) {
		return cleanErrorMessage(rawMessage[0])
	}

	if (typeof rawMessage === "object" && rawMessage !== null) {
		return cleanErrorMessage(
			rawMessage.message || rawMessage.title || rawMessage.value,
		)
	}

	let text = typeof rawMessage === "string" ? rawMessage : String(rawMessage)

	// Remove HTML tags
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		const container = document.createElement("div")
		container.innerHTML = text
		text = container.textContent || container.innerText || ""
	} else {
		text = text.replace(/<[^>]*>/g, " ")
	}

	return text.replace(/\s+/g, " ").trim()
}

// ERPNext field labels that show up in "Value missing for: X" messages.
const FIELD_LABELS_ID = {
	"item name": "Nama Item",
	item: "Item",
	"item code": "Kode Item",
	customer: "Pelanggan",
	"mode of payment": "Metode Pembayaran",
	warehouse: "Gudang",
	uom: "Satuan",
	qty: "Jumlah",
	quantity: "Jumlah",
	rate: "Harga",
	"price list": "Daftar Harga",
	company: "Perusahaan",
	"pos profile": "POS Profile",
	"cost center": "Cost Center",
	account: "Akun",
}

// Known English messages coming back from ERPNext / pos_next / the local
// sync server, rewritten into Indonesian for cashiers. Order matters: more
// specific patterns first. Anything unmatched is shown as-is.
const SERVER_MESSAGE_RULES = [
	[/\S*pos_next\.api\.[\w.]+ gagal:\s*/g, () => "Gagal kirim ke server: "],
	[/\s*\|\s*Error:\s*/g, () => " | "],
	[/Payment methods refreshed\.?\s*Please review before proceeding\.?/gi, () => "Metode pembayaran diperbarui, silakan cek sebelum melanjutkan."],
	[/(?:Sales Invoice Item |Sales Invoice Payment |Sales Order Item )?Row #?\s*(\d+)\s*:/gi, (_, n) => `Baris #${n}:`],
	[/Value missing for:?\s*([^|.]+?)(?=\s*(?:\||$|\.))/gi, (_, f) => `Data wajib belum diisi: ${FIELD_LABELS_ID[f.trim().toLowerCase()] || f.trim()}`],
	[/Mandatory fields required in [^:]*:?\s*/gi, () => "Data wajib belum diisi: "],
	[/(\d+(?:\.\d+)?)\s+units?\s+of\s+(?:Item\s+)?(.+?)\s+needed\s+in\s+(?:Warehouse\s+)?(.+?)(?:\s+on\s+.+?)?\s+to complete this transaction\.?/gi,
		(_, q, item, wh) => `Stok "${item}" kurang ${q} di gudang ${wh}.`],
	[/Deadlock found when trying to get lock;?\s*try restarting transaction\.?/gi, () => "Server sedang sibuk, silakan coba lagi."],
	[/Document has been modified after you have opened it[^.|]*\.?/gi, () => "Dokumen sudah diubah di tempat lain. Muat ulang lalu coba lagi."],
	[/Insufficient Permission for\s+/gi, () => "Tidak punya izin untuk "],
	[/\bNot permitted\b\.?/gi, () => "Tidak diizinkan."],
	[/Could not find\s+(.+?)(?=\s*(?:\||$))/gi, (_, x) => `${x} tidak ditemukan`],
	[/\b(Item|Customer|Warehouse|Mode of Payment)\s+(.+?)\s+is disabled\b\.?/gi, (_, t, x) => `${FIELD_LABELS_ID[t.toLowerCase()] || t} ${x} dinonaktifkan.`],
	[/Request Timed Out|timed out/gi, () => "Waktu habis menunggu server"],
	[/Failed to fetch|NetworkError[^|]*/gi, () => "Tidak bisa terhubung ke server"],
]

/**
 * Translate a raw server / sync error message into Indonesian where a known
 * pattern matches. Safe to call on already-Indonesian or unknown text.
 * @param {string} message
 * @returns {string}
 */
export function translateServerMessage(message) {
	if (!message || typeof message !== "string") return message
	let text = message
	for (const [pattern, replace] of SERVER_MESSAGE_RULES) {
		text = text.replace(pattern, replace)
	}
	return text
}

/**
 * Parse error and return structured error information
 * @param {Error} error - The error object from API call
 * @returns {Object} - Structured error information
 */
export function parseError(error) {
	const defaultMessage = __("Terjadi kesalahan yang tidak terduga")
	const context = {
		title: __("Kesalahan"),
		message: defaultMessage,
		type: "error", // error, warning, validation
		retryable: false,
		technicalDetails: null,
	}

	// Build technical details
	const detailsParts = []
	if (error.exc_type) detailsParts.push(__("Type: {0}", [error.exc_type]))
	if (error.httpStatus || error.status)
		detailsParts.push(__("Status: {0}", [error.httpStatus || error.status]))
	if (error.exception)
		detailsParts.push(__("Exception: {0}", [error.exception], "Error"))
	context.technicalDetails =
		detailsParts.length > 0 ? detailsParts.join(" | ") : null

	// Detect error type from status code
	if (error.httpStatus === 417 || error.status === 417) {
		context.type = "validation"
		context.title = __("Data Tidak Valid")
	} else if (error.httpStatus === 403 || error.status === 403) {
		context.type = "error"
		context.title = __("Akses Ditolak")
	} else if (error.httpStatus === 404 || error.status === 404) {
		context.type = "warning"
		context.title = __("Tidak Ditemukan")
	} else if (error.httpStatus >= 500 || error.status >= 500) {
		context.type = "error"
		context.title = __("Server Bermasalah")
	}

	// Extract primary message
	if (
		error.messages &&
		Array.isArray(error.messages) &&
		error.messages.length > 0
	) {
		context.message = cleanErrorMessage(error.messages[0])
	} else if (error._server_messages) {
		try {
			const serverMessages = JSON.parse(error._server_messages)
			if (serverMessages && serverMessages.length > 0) {
				const firstMessage = JSON.parse(serverMessages[0])
				context.message = cleanErrorMessage(
					firstMessage.message || firstMessage.title,
				)
				if (firstMessage.title) context.title = firstMessage.title
			}
		} catch (parseError) {
			console.error("Error parsing _server_messages:", parseError)
		}
	} else if (error.message) {
		context.message = cleanErrorMessage(error.message)
	}

	// Categorize by exception type and message content
	const normalizedMessage = (context.message || "").toLowerCase()
	const excType = (error.exc_type || "").toLowerCase()

	// Insufficient Stock
	if (
		excType === "negativestockerror" ||
		normalizedMessage.includes("needed in") ||
		normalizedMessage.includes("insufficient stock") ||
		normalizedMessage.includes("negative stock")
	) {
		context.type = "warning"
		context.title = __("Stok Tidak Cukup")

		// Parse the message to extract item and quantity information
		// Example: "1.0 units of Item IPhone 17-WHI needed in Warehouse Goods In Transit - BrD"
		const match = context.message.match(
			/(\d+\.?\d*)\s+units?\s+of\s+(?:Item\s+)?(.+?)\s+needed\s+in\s+(?:Warehouse\s+)?(.+?)(?:\s+to complete|$)/i,
		)

		if (match) {
			const [, quantity, itemName, warehouse] = match
			const qty = Number.parseFloat(quantity)
			context.message = `Stok "${itemName}" tidak cukup.\n\nButuh ${qty}, tapi stok di gudang "${warehouse}" tidak mencukupi.\n\nKurangi jumlahnya atau cek gudang lain.`
		} else if (!context.message || context.message === defaultMessage) {
			context.message = __(
				"Stok di gudang tidak cukup.\n\nKurangi jumlahnya atau cek ketersediaan stok.",
			)
		}

		context.retryable = true
	}
	// Validation Errors
	else if (excType === "validationerror" || context.type === "validation") {
		context.type = "validation"
		context.title = __("Data Tidak Valid")
		context.retryable = true
	}
	// Price List Errors
	else if (
		normalizedMessage.includes("price list") ||
		normalizedMessage.includes("price not found")
	) {
		context.type = "warning"
		context.title = __("Harga Bermasalah")
		context.retryable = true
	}
	// Customer/Party Errors
	else if (
		normalizedMessage.includes("customer") ||
		normalizedMessage.includes("party")
	) {
		context.type = "validation"
		context.title = __("Data Pelanggan Bermasalah")
		context.retryable = true
	}
	// Tax Errors
	else if (
		normalizedMessage.includes("tax") ||
		normalizedMessage.includes("account")
	) {
		context.type = "warning"
		context.title = __("Pengaturan Pajak Bermasalah")
		context.retryable = false
	}
	// Payment Errors
	else if (
		normalizedMessage.includes("payment") ||
		normalizedMessage.includes("mode of payment")
	) {
		context.type = "validation"
		context.title = __("Pembayaran Bermasalah")
		context.retryable = true
	}
	// Series/Naming Errors
	else if (
		normalizedMessage.includes("series") ||
		normalizedMessage.includes("naming")
	) {
		context.type = "error"
		context.title = __("Penomoran Dokumen Bermasalah")
		context.retryable = false
	}
	// Permission Errors
	else if (
		normalizedMessage.includes("permission") ||
		normalizedMessage.includes("not allowed")
	) {
		context.type = "error"
		context.title = __("Akses Ditolak")
		context.retryable = false
	}
	// Network/Connection Errors
	else if (
		normalizedMessage.includes("network") ||
		normalizedMessage.includes("timeout") ||
		normalizedMessage.includes("connection") ||
		normalizedMessage.includes("fetch")
	) {
		context.type = "warning"
		context.title = __("Koneksi Bermasalah")
		context.message = __(
			"Tidak bisa terhubung ke server. Cek koneksi internet.",
		)
		context.retryable = true
	}
	// Duplicate Errors
	else if (
		normalizedMessage.includes("duplicate") ||
		normalizedMessage.includes("already exists")
	) {
		context.type = "validation"
		context.title = __("Data Duplikat")
		context.retryable = false
	}

	// Categorization above matches on ERPNext's English text, so translate last.
	context.message = translateServerMessage(context.message)

	return context
}

/**
 * Format error for clipboard (for reporting)
 * @param {Object} errorContext - Parsed error context
 * @param {Object} additionalInfo - Additional context (user, profile, etc)
 * @returns {string} - Formatted error report
 */
export function formatErrorReport(errorContext, additionalInfo = {}) {
	const lines = [
		__("Error Report - NursaPOS"),
		"=".repeat(40),
		__("Title: {0}", [errorContext.title]),
		__("Type: {0}", [errorContext.type]),
		__("Message: {0}", [errorContext.message]),
		"",
	]

	if (errorContext.technicalDetails) {
		lines.push(__("Technical: {0}", [errorContext.technicalDetails]))
		lines.push("")
	}

	if (additionalInfo.timestamp) {
		lines.push(__("Timestamp: {0}", [additionalInfo.timestamp]))
	}
	if (additionalInfo.user) {
		lines.push(__("User: {0}", [additionalInfo.user]))
	}
	if (additionalInfo.posProfile) {
		lines.push(__("POS Profile: {0}", [additionalInfo.posProfile]))
	}

	return lines.join("\n")
}

/**
 * Convert an API error to a human-readable string safe to show to end users.
 * Falls back to `defaultMsg` when the raw message looks technical.
 *
 * @param {Error|Object} error - Error from createResource onError / catch block
 * @param {string} defaultMsg  - Fallback message if error is unreadable
 * @returns {string}
 */
export function friendlyError(error, defaultMsg) {
	const fallback = defaultMsg || __("Terjadi kesalahan. Silakan coba lagi.")

	const excType = (error?.exc_type || "").toLowerCase()

	// DB-level uniqueness constraint — always replace with something readable
	if (excType === "uniquevalidationerror" || excType.includes("integrity")) {
		return __("Data sudah ada. Gunakan nilai lain.")
	}

	// Permission / auth errors
	if (excType === "permissionerror" || error?.httpStatus === 403) {
		return __("Tidak punya izin untuk melakukan tindakan ini.")
	}
	if (excType === "authenticationerror" || error?.httpStatus === 401) {
		return __("Sesi sudah habis. Silakan login lagi.")
	}

	// Use parseError to extract a cleaned message
	const parsed = parseError(error)
	const msg = parsed.message || ""

	// If the cleaned message still looks technical, use fallback
	const TECHNICAL_PATTERNS = [
		"traceback", "exception", "stacktrace",
		"uniquevalidationerror", "integrityerror",
		"attributeerror", "typeerror", "keyerror",
		"file \"/", "line \\d+",
	]
	const isTechnical = TECHNICAL_PATTERNS.some((p) =>
		msg.toLowerCase().includes(p),
	)

	if (!msg || isTechnical) return fallback
	return msg
}

/**
 * Get toast icon class based on error type
 * @param {string} errorType - error, warning, or validation
 * @returns {string} - Tailwind CSS class
 */
export function getErrorIconClass(errorType) {
	switch (errorType) {
		case "error":
			return "text-red-600"
		case "warning":
			return "text-orange-600"
		case "validation":
			return "text-yellow-600"
		default:
			return "text-red-600"
	}
}

/**
 * Handle API error with toast notification
 * @param {Error} error - The error object
 * @param {Function} toastFn - Toast creation function
 * @param {Object} options - Additional options
 */
export function handleApiError(error, toastFn, options = {}) {
	const errorContext = parseError(error)

	const toastOptions = {
		title: errorContext.title,
		text: errorContext.message,
		icon: "alert-circle",
		iconClasses: getErrorIconClass(errorContext.type),
		timeout: options.timeout || 6000,
	}

	if (toastFn) {
		toastFn(toastOptions)
	}

	return errorContext
}
