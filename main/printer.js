const { ThermalPrinter, PrinterTypes } = require("node-thermal-printer");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

/**
 * ESC/POS thermal receipt printing — replaces the old app's browser
 * `window.print()` (see C:\Users\User\pos\POS\src\utils\printInvoice.js,
 * which had NO real thermal/ESC-POS integration at all, just an HTML popup).
 *
 * Content is always built via node-thermal-printer (pure JS, no native
 * deps) and extracted as a raw ESC/POS byte buffer via getBuffer(), then
 * dispatched based on `printerInterface`:
 *   - "tcp://<ip>:<port>"   — network printer, sent over a plain TCP socket.
 *   - "printer:<Name>"      — Windows printer (USB or shared), sent via the
 *     RAW print spooler (main/print-raw.ps1, Win32 WritePrinter through
 *     PowerShell's Add-Type/P-Invoke).
 *
 * Why not node-thermal-printer's own "printer:" interface + the `printer`
 * npm package? That package (v0.4.0, last touched years ago) doesn't
 * compile against modern MSVC/Node — its C++ source itself has a build
 * error unrelated to anything in this project. The PowerShell RAW-print
 * route needs ZERO native compilation (PowerShell/.NET ship with every
 * Windows install), which matters a lot for shipping to many outlets
 * without repeating this native-module pain on every machine.
 */
function num(v) {
  v = Math.floor(v || 0);
  const s = Math.abs(v).toString();
  return (v < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function rp(v) {
  return `Rp${num(v)}`;
}

function buildPrinter(paperSize = "58mm") {
  // Interface value is irrelevant here — we only ever call getBuffer(),
  // never execute() against this instance, so no real transport is opened.
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: "buffer-only",
    width: paperSize === "80mm" ? 42 : 32,
    removeSpecialCharacters: false,
    lineCharacter: "-",
  });
}

async function sendOverNetwork(buffer, host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setTimeout(5000, () => socket.destroy(new Error("Printer tidak merespons (timeout)")));
    socket.on("connect", () => socket.end(buffer));
    socket.on("close", resolve);
    socket.on("error", reject);
  });
}

async function sendToWindowsPrinter(buffer, printerName) {
  const tmpFile = path.join(os.tmpdir(), `pos-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "print-raw.ps1"),
          "-PrinterName",
          printerName,
          "-FilePath",
          tmpFile,
        ],
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr?.trim() || error.message));
          resolve();
        }
      );
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Bluetooth thermal printers: paired over classic SPP, Windows hands it a
// normal virtual COM port (see main/print-serial.ps1's docstring for why
// this is the zero-native-module path instead of Web Bluetooth/`noble`).
async function sendToSerialPort(buffer, portName, baudRate) {
  const tmpFile = path.join(os.tmpdir(), `pos-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "print-serial.ps1"),
          "-PortName",
          portName,
          "-FilePath",
          tmpFile,
          "-BaudRate",
          String(baudRate || 9600),
        ],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr?.trim() || error.message));
          resolve();
        }
      );
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function sendBuffer(buffer, { printerInterface, baudRate }) {
  if (!printerInterface || printerInterface === "printer:auto") {
    throw new Error(
      "Printer belum dikonfigurasi. Set printerInterface via POST /print/config — " +
        'contoh network: "tcp://192.168.1.50:9100", Windows/USB: "printer:Nama Printer Persis Seperti di Windows", ' +
        'atau Bluetooth: "com:COM5" (pair printer dulu lewat Windows Bluetooth Settings).'
    );
  }

  const tcpMatch = /^tcp:\/\/([^:/]+)(?::(\d+))?/i.exec(printerInterface);
  if (tcpMatch) {
    await sendOverNetwork(buffer, tcpMatch[1], Number(tcpMatch[2] || 9100));
    return;
  }

  const comMatch = /^com:(.+)$/i.exec(printerInterface);
  if (comMatch) {
    await sendToSerialPort(buffer, comMatch[1], baudRate);
    return;
  }

  const printerMatch = /^printer:(.+)$/i.exec(printerInterface);
  if (printerMatch) {
    await sendToWindowsPrinter(buffer, printerMatch[1]);
    return;
  }

  throw new Error(`Format printerInterface tidak dikenali: "${printerInterface}"`);
}

async function isPrinterReady(config) {
  if (!config.printerInterface || config.printerInterface === "printer:auto") return false;
  // A cheap reachability check: TCP printers we can probe directly; Windows
  // printer names and Bluetooth COM ports we just trust exist if configured
  // (no cheap way to probe a COM port without opening it, and opening it
  // just to check readiness risks colliding with an in-flight print).
  const tcpMatch = /^tcp:\/\/([^:/]+)(?::(\d+))?/i.exec(config.printerInterface);
  if (tcpMatch) {
    return new Promise((resolve) => {
      const socket = net.connect(Number(tcpMatch[2] || 9100), tcpMatch[1]);
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
  }
  return /^printer:.+/i.test(config.printerInterface) || /^com:.+/i.test(config.printerInterface);
}

// Truncates a customer name the same way the real "58 TEST" Print Format's
// Jinja does: `customer_name.split(' XS')[0].split(' XSA')[0]
// .split(' XPY')[0].split(' - ')[0]`. Splitting on ' XS' first already
// catches ' XSA'/' XPY' (both start with ' XS'), so those two splits are
// redundant in practice — kept anyway for exact behavioral parity in case
// that ever stops being true.
function truncateCustomerName(name) {
  return String(name || "")
    .split(" XS")[0]
    .split(" XSA")[0]
    .split(" XPY")[0]
    .split(" - ")[0];
}

// Two-digit HH:MM from a "HH:MM:SS" (or Date-parsable) time value.
function shortTime(t) {
  const s = String(t || "");
  const match = /^(\d{2}:\d{2})/.exec(s);
  if (match) return match[1];
  const d = new Date(t);
  return isNaN(d) ? "" : d.toTimeString().slice(0, 5);
}

/**
 * @param {object} invoiceData - Sales/POS Invoice-shaped data: {name, owner,
 *   posting_date, posting_time, customer_name, customer, items[] (each with
 *   item_name/item_code, qty, price_list_rate, discount_amount, serial_no),
 *   total, taxes[] (description, rate, tax_amount, included_in_print_rate),
 *   discount_amount, loyalty_amount, grand_total, rounded_total, payments[]
 *   (mode_of_payment, amount), paid_amount, change_amount,
 *   outstanding_amount, loyalty_points, redeem_loyalty_points, terms,
 *   remarks}
 * @param {object} companyAddress - {address_title, address_line1, address_line2, city, phone}
 * @param {object} config - {printerInterface, paperSize}
 *
 * Field-for-field port of the real "58 TEST" Print Format's Jinja (fetched
 * via server/sync/pull.js's pullPrintFormat, cached per POS Profile under
 * settings key "print_format:<profile>" — see there for why this isn't a
 * live Jinja interpreter). Keep this in sync by hand if that format is
 * edited in ERP. companyAddress is resolved per-invoice from its own
 * pos_profile (server/routes/print.js), not a single global address.
 */
async function printReceipt(invoiceData, companyAddress, config) {
  const printer = buildPrinter(config.paperSize);

  // ── Company address header ──
  printer.alignCenter();
  if (companyAddress?.address_title) {
    printer.bold(true);
    printer.println(companyAddress.address_title);
    printer.bold(false);
  }
  if (companyAddress?.address_line1) printer.println(companyAddress.address_line1);
  if (companyAddress?.address_line2) printer.println(companyAddress.address_line2);
  const cityPhone = [companyAddress?.city, companyAddress?.phone].filter(Boolean).join(" | ");
  if (cityPhone) printer.println(cityPhone);

  // ── No / Ksr+Tgl / Pel ──
  printer.drawLine();
  printer.alignLeft();
  printer.println(`No : ${invoiceData.name}`);
  printer.println(
    `Ksr: ${String(invoiceData.owner || "").slice(0, 8)} Tgl: ${invoiceData.posting_date || ""} ${shortTime(invoiceData.posting_time)}`
  );
  printer.println(`Pel: ${truncateCustomerName(invoiceData.customer_name || invoiceData.customer || "Guest")}`);
  printer.drawLine();

  // ── Items ── (price_list_rate, not rate — matches what the format prints)
  for (const item of invoiceData.items || []) {
    const qty = item.qty ?? item.quantity ?? 0;
    const rate = item.price_list_rate ?? item.rate ?? 0;
    const baseAmount = Math.trunc(qty * rate);
    printer.println(item.item_name || item.item_code);
    const qtyDisplay = Number.isInteger(qty) ? qty : qty;
    printer.leftRight(`${qtyDisplay} x ${num(rate)}`, num(baseAmount));
    if (item.discount_amount > 0) {
      printer.leftRight("  Diskon", `-${num(item.discount_amount * qty)}`);
    }
    if (item.serial_no) {
      printer.println(`S/N: ${String(item.serial_no).replace(/\n/g, ", ")}`);
    }
  }
  printer.drawLine();

  // ── Totals ──
  printer.leftRight("Total", num(invoiceData.total ?? invoiceData.grand_total));
  for (const tax of invoiceData.taxes || []) {
    if (tax.included_in_print_rate) continue;
    const desc = tax.description || "Pajak";
    const label = desc.includes("%") ? desc : `${desc}@${tax.rate}%`;
    printer.leftRight(label, num(tax.tax_amount));
  }
  if (invoiceData.discount_amount) printer.leftRight("Diskon", `-${num(invoiceData.discount_amount)}`);
  if (invoiceData.loyalty_amount) printer.leftRight("Tukar Poin", `-${num(invoiceData.loyalty_amount)}`);

  printer.bold(true);
  printer.leftRight("Grand Total", rp(invoiceData.grand_total));
  printer.bold(false);
  if (invoiceData.rounded_total) printer.leftRight("Dibulatkan", rp(invoiceData.rounded_total));

  for (const payment of invoiceData.payments || []) {
    printer.leftRight(payment.mode_of_payment, num(payment.amount));
  }
  const paidAmount =
    invoiceData.paid_amount ?? (invoiceData.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  printer.leftRight("Bayar", num(paidAmount));
  if (invoiceData.change_amount > 0) printer.leftRight("Kembali", num(invoiceData.change_amount));
  if (invoiceData.outstanding_amount > 0) printer.leftRight("Sisa Tagihan", num(invoiceData.outstanding_amount));

  // ── Loyalty points. loyalty_points_balance (the running total, e.g. from
  // pos_next.api.invoices.get_invoice_loyalty_points) is only available when
  // printing has a live connection to look it up — an immediate print right
  // after an offline sale won't have it, a reprint (renderer/src/utils/
  // printInvoice.js's printInvoiceByName) does. ──
  if (invoiceData.loyalty_points && !invoiceData.redeem_loyalty_points) {
    printer.drawLine();
    printer.alignCenter();
    printer.println("-- LOYALTY POINTS --");
    printer.alignLeft();
    printer.leftRight("Poin Didapat", `+${invoiceData.loyalty_points}`);
    if (invoiceData.loyalty_points_balance != null) {
      printer.leftRight("Total Poin", `${invoiceData.loyalty_points_balance}`);
    }
  } else if (invoiceData.redeem_loyalty_points && invoiceData.loyalty_points) {
    printer.drawLine();
    printer.alignCenter();
    printer.println("-- LOYALTY POINTS --");
    printer.alignLeft();
    printer.leftRight("Poin Ditukar", `-${invoiceData.loyalty_points}`);
    if (invoiceData.loyalty_points_balance != null) {
      printer.leftRight("Total Poin", `${invoiceData.loyalty_points_balance}`);
    }
  }

  printer.drawLine();
  if (invoiceData.terms) printer.println(invoiceData.terms);
  if (invoiceData.remarks) printer.println(invoiceData.remarks);
  printer.alignCenter();
  printer.println("Terima kasih, sampai jumpa lagi.");
  printer.cut();

  await sendBuffer(printer.getBuffer(), config);
  return { success: true };
}

/**
 * @param {object} closingData - {pos_profile, sales_total, taxes[], payment_reconciliation[], returns_count}
 */
async function printShiftClosing(closingData, config) {
  const printer = buildPrinter(config.paperSize);

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

  await sendBuffer(printer.getBuffer(), config);
  return { success: true };
}

/**
 * Cup/kitchen label printing — port of the old app's
 * C:\Users\User\pos\POS\src\utils\bluetoothPrinter.js / usbPrinter.js
 * printLabelBT/printLabelUSB, which talked to a label printer directly from
 * the browser over Web Bluetooth/WebUSB. Electron's renderer has neither
 * API, so this reuses the exact same TCP/Windows-spooler transport as
 * receipts (sendBuffer) instead of a third printing path.
 *
 * One label per call — the old app looped per-copy client-side (BT) or
 * passed a copy/total pair for a running "x of y" footer (USB); we keep
 * that same "one call per physical label" shape so the caller controls
 * pacing between labels, and fold the copy counter into the label body.
 */
async function printCupLabel({ itemName, remarks, copyNum, totalCopies }, config) {
  const printer = buildPrinter(config.paperSize);

  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.println(String(itemName || "").trim());
  printer.bold(false);
  printer.setTextNormal();
  if (remarks) {
    printer.println(String(remarks).trim());
  }
  if (totalCopies > 1) {
    printer.println(`${copyNum}/${totalCopies}`);
  }
  printer.println(
    new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
  );
  printer.cut();

  await sendBuffer(printer.getBuffer(), config);
  return { success: true };
}

module.exports = { isPrinterReady, printReceipt, printShiftClosing, printCupLabel, num, rp };
