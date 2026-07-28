const express = require("express");
const { isPrinterReady, printReceipt, printShiftClosing } = require("../../main/printer");
const { loadDeviceConfig, saveDeviceConfig } = require("../auth/device-setup");

const router = express.Router();

function printerConfig() {
  const device = loadDeviceConfig() || {};
  return {
    printerInterface: device.printerInterface || "printer:auto",
    paperSize: device.paperSize || "58mm",
  };
}

router.get("/status", async (req, res) => {
  const ready = await isPrinterReady(printerConfig());
  res.json({ ready });
});

router.post("/config", (req, res) => {
  const device = loadDeviceConfig();
  if (!device) return res.status(400).json({ error: "Device belum ter-setup" });
  saveDeviceConfig({
    ...device,
    printerInterface: req.body.printerInterface || device.printerInterface,
    paperSize: req.body.paperSize || device.paperSize,
  });
  res.json({ success: true });
});

router.post("/receipt", async (req, res) => {
  try {
    const { invoice, companyAddress } = req.body || {};
    const result = await printReceipt(invoice, companyAddress, printerConfig());
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

module.exports = router;
