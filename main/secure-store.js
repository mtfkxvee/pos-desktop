const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

function credentialsPath() {
  return path.join(app.getPath("userData"), "credentials.enc");
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

// API key/secret — the long-lived credential used for all requests after
// first-time device setup. Never stored in plaintext.
function saveCredentials({ apiKey, apiSecret }) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-level encryption (safeStorage) is not available on this device");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify({ apiKey, apiSecret }));
  fs.writeFileSync(credentialsPath(), encrypted);
}

function loadCredentials() {
  const p = credentialsPath();
  if (!fs.existsSync(p)) return null;
  const decrypted = safeStorage.decryptString(fs.readFileSync(p));
  return JSON.parse(decrypted);
}

// Device identity — outlet code, default POS Profile/warehouse, server URL.
// Not secret, kept as plain JSON for easy inspection/support.
function saveDeviceConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function loadDeviceConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isDeviceSetup() {
  return fs.existsSync(credentialsPath()) && fs.existsSync(configPath());
}

module.exports = {
  saveCredentials,
  loadCredentials,
  saveDeviceConfig,
  loadDeviceConfig,
  isDeviceSetup,
};
