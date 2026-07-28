const { ThermalPrinter, PrinterTypes } = require("node-thermal-printer");

/**
 * ESC/POS thermal receipt printing — replaces the old app's browser
 * `window.print()` (see C:\Users\User\pos\POS\src\utils\printInvoice.js,
 * which had NO real thermal/ESC-POS integration at all, just an HTML popup).
 *
 * `interface` addressing (node-thermal-printer / escpos convention):
 *   - Windows shared/USB printer name: "printer:POS-80" (name as seen in
 *     Windows' list of printers)
 *   - Network printer:                "tcp://192.168.1.100:9100"
 */
function num(v) {
  v = Math.floor(v || 0);
  const s = Math.abs(v).toString();
  return (v < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function rp(v) {
  return `Rp${num(v)}`;
}

function makePrinter({ printerInterface, paperSize = "58mm" }) {
  if (!printerInterface || printerInterface === "printer:auto") {
    // "printer:" interfaces need the separate `printer` npm package (native
    // module) installed — not bundled by default. Until a real
    // tcp://<ip>:<port> or configured printer name is set, fail with a
    // message that actually explains what to do, not node-thermal-printer's
    // raw "No driver set!".
    throw new Error(
      "Printer belum dikonfigurasi. Set printerInterface ke tcp://<ip-printer>:9100 (network) via POST /print/config."
    );
  }
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: printerInterface,
    width: paperSize === "80mm" ? 42 : 32,
    removeSpecialCharacters: false,
    lineCharacter: "-",
  });
}

async function isPrinterReady(config) {
  try {
    const printer = makePrinter(config);
    return await printer.isPrinterConnected();
  } catch {
    return false;
  }
}

/**
 * @param {object} invoiceData - same shape the old printInvoiceCustom() used:
 *   {name, posting_date, posting_time, customer_name, customer, owner, items[],
 *    taxes[], payments[], grand_total, discount_amount, loyalty_amount,
 *    change_amount, outstanding_amount, company, terms}
 * @param {object} companyAddress - {address_title, address_line1, address_line2, city, phone}
 * @param {object} config - {printerInterface, paperSize}
 */
async function printReceipt(invoiceData, companyAddress, config) {
  const printer = makePrinter(config);

  printer.alignCenter();
  if (companyAddress?.address_title) {
    printer.bold(true);
    printer.println(companyAddress.address_title);
    printer.bold(false);
  } else if (invoiceData.company) {
    printer.println(invoiceData.company);
  }
  if (companyAddress?.address_line1) printer.println(companyAddress.address_line1);
  if (companyAddress?.address_line2) printer.println(companyAddress.address_line2);
  const cityPhone = [companyAddress?.city, companyAddress?.phone].filter(Boolean).join(" | ");
  if (cityPhone) printer.println(cityPhone);

  printer.drawLine();
  printer.alignLeft();
  printer.println(`No  : ${invoiceData.name}`);
  printer.println(`Ksr : ${(invoiceData.owner || "Kasir").substring(0, 12)}`);
  printer.println(`Pel : ${(invoiceData.customer_name || invoiceData.customer || "Guest").split(" - ")[0]}`);
  printer.drawLine();

  for (const item of invoiceData.items || []) {
    const qty = item.qty ?? item.quantity ?? 0;
    const rate = item.rate ?? item.price_list_rate ?? 0;
    const amount = item.amount ?? qty * rate;
    printer.println(item.item_name || item.item_code);
    printer.leftRight(`${qty} x ${num(rate)}`, num(amount));
    if (item.discount_amount > 0) printer.leftRight("  Diskon", `-${num(item.discount_amount)}`);
  }

  printer.drawLine();
  printer.leftRight("Total", num(invoiceData.total ?? invoiceData.grand_total));
  for (const tax of invoiceData.taxes || []) {
    if (tax.included_in_print_rate) continue;
    printer.leftRight(tax.description || "Pajak", num(tax.tax_amount));
  }
  if (invoiceData.discount_amount) printer.leftRight("Diskon", `-${num(invoiceData.discount_amount)}`);
  if (invoiceData.loyalty_amount) printer.leftRight("Tukar Poin", `-${num(invoiceData.loyalty_amount)}`);

  printer.bold(true);
  printer.leftRight("GRAND TOTAL", rp(invoiceData.grand_total));
  printer.bold(false);

  const paidAmount =
    invoiceData.paid_amount ?? (invoiceData.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  for (const payment of invoiceData.payments || []) {
    printer.leftRight(payment.mode_of_payment, num(payment.amount));
  }
  printer.leftRight("Bayar", num(paidAmount));
  if (invoiceData.change_amount > 0) printer.leftRight("Kembali", num(invoiceData.change_amount));
  if (invoiceData.outstanding_amount > 0) printer.leftRight("Sisa Tagihan", num(invoiceData.outstanding_amount));

  printer.drawLine();
  printer.alignCenter();
  printer.println("Terima kasih, sampai jumpa lagi.");
  printer.cut();

  await printer.execute();
  return { success: true };
}

/**
 * @param {object} closingData - {pos_profile, sales_total, taxes[], payment_reconciliation[], returns_count}
 */
async function printShiftClosing(closingData, config) {
  const printer = makePrinter(config);

  printer.alignCenter();
  printer.bold(true);
  printer.println("LAPORAN TUTUP SHIFT");
  printer.bold(false);
  printer.println(closingData.pos_profile || "");
  printer.drawLine();
  printer.alignLeft();

  const salesTotal = closingData.sales_total ?? closingData.grand_total ?? 0;
  printer.leftRight("Total Penjualan", rp(salesTotal));

  const reconciliation = (closingData.payment_reconciliation || []).filter(
    (p) => Number(p.expected_amount) > 0 || Number(p.closing_amount) > 0
  );
  if (reconciliation.length) {
    printer.drawLine();
    printer.println("REKONSILIASI PEMBAYARAN");
    for (const p of reconciliation) {
      const diff = Number(p.closing_amount || 0) - Number(p.expected_amount || 0);
      printer.println(p.mode_of_payment || "");
      printer.leftRight("  Expected", num(p.expected_amount));
      printer.leftRight("  Actual", num(p.closing_amount));
      if (diff !== 0) printer.leftRight("  Selisih", num(diff));
    }
  }

  printer.drawLine();
  printer.alignCenter();
  printer.println(new Date().toLocaleString("id-ID"));
  printer.cut();

  await printer.execute();
  return { success: true };
}

module.exports = { isPrinterReady, printReceipt, printShiftClosing, num, rp };
