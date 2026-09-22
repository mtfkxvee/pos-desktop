const express = require("express");
const { execFile } = require("child_process");
const { isPrinterReady, printReceipt, printShiftClosing, printCupLabel } = require("../../main/printer");
const { loadDeviceConfig, saveDeviceConfig } = require("../../main/secure-store");
const { getDb } = require("../db/client");

const router = express.Router();

// Cached by server/sync/pull.js's pullCompanyAddress(posProfile), keyed per
// POS Profile — this outlet chain has one Address per branch/profile (POS
// Profile's own `company_address` link field), so the address must be
// looked up for the SPECIFIC profile the invoice was created under, not a
// single global value. Read here instead of trusting whatever the renderer
// sends — the old renderer-side cache was never actually populated by
// anything, so it always sent nothing.
function getCachedCompanyAddress(posProfile) {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`company_address:${posProfile}`);
  return row ? JSON.parse(row.value) : null;
}

// Lists Windows-installed printers (USB and shared) so the settings UI can
// offer a dropdown instead of asking the cashier/admin to type the exact
// Windows printer name by hand.
function listWindowsPrinters() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-Printer | Select-Object Name, PortName | ConvertTo-Json -Compress",
      ],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr?.trim() || error.message));
        try {
          const parsed = JSON.parse(stdout || "[]");
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve(list.map((p) => ({ name: p.Name, port: p.PortName })));
        } catch (err) {
          reject(new Error(`Gagal membaca daftar printer: ${err.message}`));
        }
      }
    );
  });
}

// Lists COM ports Windows currently knows about, tagged with friendly names
// (Device Manager's "FriendlyName", e.g. "Standard Serial over Bluetooth
// link (COM5)") so a paired Bluetooth printer's port is recognizable in the
// dropdown instead of a bare "COM5" a cashier has to guess at.
function listComPorts() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-CimInstance -ClassName Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | Select-Object Name | ConvertTo-Json -Compress",
      ],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr?.trim() || error.message));
        try {
          const parsed = JSON.parse(stdout || "[]");
          const list = Array.isArray(parsed) ? parsed : parsed && parsed.Name ? [parsed] : [];
          const ports = list
            .map((p) => {
              const match = /\((COM\d+)\)/.exec(p.Name || "");
              return match ? { port: match[1], label: p.Name } : null;
            })
            .filter(Boolean);
          resolve(ports);
        } catch (err) {
          reject(new Error(`Gagal membaca daftar COM port: ${err.message}`));
        }
      }
    );
  });
}

function printerConfig() {
  const device = loadDeviceConfig() || {};
  return {
    printerInterface: device.printerInterface || "printer:auto",
    paperSize: device.paperSize || "58mm",
    baudRate: device.baudRate || 9600,
  };
}

router.get("/status", async (req, res) => {
  const ready = await isPrinterReady(printerConfig());
  res.json({ ready, config: printerConfig() });
});

// Windows printers (for a dropdown) — network printers aren't discoverable
// this way, the UI just takes a free-text IP:port for those.
router.get("/printers", async (req, res) => {
  try {
    const printers = await listWindowsPrinters();
    res.json({ printers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bluetooth (and any other serial) printers — pair the printer via Windows
// Bluetooth Settings FIRST, then it shows up here as a COM port.
router.get("/com-ports", async (req, res) => {
  try {
    const ports = await listComPorts();
    res.json({ ports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/config", (req, res) => {
  res.json(printerConfig());
});

router.post("/config", (req, res) => {
  const device = loadDeviceConfig();
  if (!device) return res.status(400).json({ error: "Device belum ter-setup" });
  saveDeviceConfig({
    ...device,
    printerInterface: req.body.printerInterface || device.printerInterface,
    paperSize: req.body.paperSize || device.paperSize,
    baudRate: req.body.baudRate || device.baudRate,
  });
  res.json({ success: true, config: printerConfig() });
});

router.post("/receipt", async (req, res) => {
  try {
    const { invoice } = req.body || {};
    const result = await printReceipt(invoice, getCachedCompanyAddress(invoice?.pos_profile), printerConfig());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/shift-closing", async (req, res) => {
  try {
    const result = await printShiftClosing(req.body?.closingData, printerConfig());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/cup-label", async (req, res) => {
  try {
    const result = await printCupLabel(req.body || {}, printerConfig());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
