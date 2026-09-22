/**
 * Desktop build replacement for the old browser-based printInvoice.js.
 *
 * The original implementation used `window.open("/printview?...")` and
 * `window.print()` — relative URLs that only work when the app is served
 * same-origin by a Frappe site. Under Electron's file:// loading, that
 * became `file:///C:/printview?...` → ERR_FILE_NOT_FOUND.
 *
 * This keeps the EXACT same exported function names/signatures so every
 * caller (POSSale.vue, InvoiceHistoryDialog.vue, OfflineInvoicesDialog.vue,
 * DraftInvoicesDialog.vue, ShiftClosingDialog.vue, POSClosingManagement.vue,
 * DeliveryNoteManagement.vue) needs zero changes — but now prints via real
 * ESC/POS commands through the local server + node-thermal-printer (see
 * server/routes/print.js, main/printer.js) instead of the OS print dialog.
 */
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"

const log = logger.create("PrintInvoice")
const BASE = "http://127.0.0.1:8871"

async function sendToPrinter(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Print gagal (HTTP ${res.status})`)
  }
  return data
}

/**
 * Print invoice via the local ESC/POS printer service.
 * @param {Object} invoiceData - The invoice document data
 * @param {string} printFormat - Unused (kept for call-site compatibility;
 *   ESC/POS output has one layout, not per-format Jinja templates)
 * @param {string} letterhead - Unused, same reason
 * @param {string} paperSize - "58mm" or "80mm"
 */
export async function printInvoice(invoiceData, printFormat = null, letterhead = null, paperSize = null) {
  if (!invoiceData || !invoiceData.name) {
    throw new Error("Invalid invoice data")
  }
  try {
    // Company address is fetched server-side from the cache pulled by
    // server/sync/pull.js's pullCompanyAddress() — no need to source or
    // send it from here.
    await sendToPrinter("/print/receipt", { invoice: invoiceData })
    return true
  } catch (error) {
    log.error("Error printing receipt:", error)
    throw error
  }
}

/** Compatibility alias — same ESC/POS path, paperFormat param unused. */
export async function printInvoiceCustom(invoiceData, printFormat = "58 PRINTER") {
  return printInvoice(invoiceData, printFormat)
}

/**
 * Print invoice by name, fetching the full doc (+ loyalty points) first.
 * @param {string} invoiceName
 */
export async function printInvoiceByName(invoiceName, printFormat = null, letterhead = null, paperSize = null) {
  try {
    const invoiceDoc = await call("pos_next.api.invoices.get_invoice", {
      invoice_name: invoiceName,
    })
    if (!invoiceDoc) throw new Error("Invoice not found")

    if (invoiceDoc.loyalty_program) {
      try {
        const loyaltyData = await call("pos_next.api.invoices.get_invoice_loyalty_points", {
          invoice_name: invoiceName,
        })
        if (loyaltyData) {
          // get_invoice_loyalty_points computes earned points from the actual
          // Loyalty Point Entry records tied to this invoice — more precise
          // than the raw doc field, and the only source for the running
          // balance. main/printer.js reads loyalty_points/loyalty_points_balance
          // (NOT earned_points/total_points) — these names must match.
          if (!invoiceDoc.redeem_loyalty_points) {
            invoiceDoc.loyalty_points = loyaltyData.earned_points
          }
          invoiceDoc.loyalty_points_balance = loyaltyData.total_points
        }
      } catch (err) {
        log.warn("Could not fetch loyalty points for print:", err)
      }
    }

    return await printInvoice(invoiceDoc, printFormat, letterhead, paperSize)
  } catch (error) {
    log.error("Error fetching invoice for print:", error)
    throw error
  }
}

/**
 * Print a shift-closing (Z-report) receipt via ESC/POS.
 * @param {Object} closingData
 * @param {string} paperSize - "58mm" or "80mm"
 */
export async function printShiftClosing(closingData, paperSize = "80mm") {
  try {
    await sendToPrinter("/print/shift-closing", { closingData })
    return true
  } catch (error) {
    log.error("Error printing shift closing:", error)
    throw error
  }
}

/**
 * Print a single cup/kitchen label via ESC/POS.
 *
 * Desktop build replacement for the old app's Web Bluetooth/WebUSB label
 * printing (see CupLabelDialog.vue) — same "one call per physical label"
 * shape, just routed through the configured receipt printer instead.
 * @param {string} itemName
 * @param {string} remarks
 * @param {number} copyNum - 1-based index of this label among totalCopies
 * @param {number} totalCopies
 */
export async function printCupLabel(itemName, remarks, copyNum = 1, totalCopies = 1) {
  try {
    await sendToPrinter("/print/cup-label", { itemName, remarks, copyNum, totalCopies })
    return true
  } catch (error) {
    log.error("Error printing cup label:", error)
    throw error
  }
}
