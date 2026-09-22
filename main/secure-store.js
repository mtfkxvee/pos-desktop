const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function usersPath() {
  return path.join(app.getPath("userData"), "users.enc");
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

// Per-cashier API key/secret cache, keyed by Frappe username. Each cashier
// logs in with their own account; the first time a given username logs in on
// this device we call generate_device_api_key for them and cache the result
// here so subsequent logins by the same person don't rotate (and thereby
// invalidate) their key every single time.
function loadUsersMap() {
  const p = usersPath();
  if (!fs.existsSync(p)) return {};
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-level encryption (safeStorage) is not available on this device");
  }
  const decrypted = safeStorage.decryptString(fs.readFileSync(p));
  return JSON.parse(decrypted);
}

function saveUsersMap(map) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-level encryption (safeStorage) is not available on this device");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(map));
  fs.writeFileSync(usersPath(), encrypted);
}

function getUserCredentials(username) {
  const map = loadUsersMap();
  return map[username] || null;
}

// Password verification for OFFLINE logins only. Never the plaintext —
// scrypt hash + random salt, stored alongside the API credentials. Online
// logins keep verifying against the real Frappe password (cookieLogin) as
// before; this only kicks in when the server is unreachable, so a cashier
// isn't locked out of the till just because the internet is down.
function hashPassword(pwd, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(pwd, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPasswordOffline(username, pwd) {
  const creds = getUserCredentials(username);
  if (!creds?.passwordSalt || !creds?.passwordHash) return false;
  const { hash } = hashPassword(pwd, creds.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(creds.passwordHash));
}

function saveUserCredentials(username, { apiKey, apiSecret, password }) {
  const map = loadUsersMap();
  const existing = map[username] || {};
  const { salt, hash } = password ? hashPassword(password) : {};
  map[username] = {
    apiKey,
    apiSecret,
    passwordSalt: salt || existing.passwordSalt,
    passwordHash: hash || existing.passwordHash,
    lastLogin: new Date().toISOString(),
  };
  saveUsersMap(map);
}

function removeUserCredentials(username) {
  const map = loadUsersMap();
  delete map[username];
  saveUsersMap(map);
}

function listUsers() {
  return Object.keys(loadUsersMap());
}

// Device identity — server URL, outlet code, default POS Profile/warehouse.
// Set once per device (first-time setup); NOT per-user. Not secret, kept as
// plain JSON for easy inspection/support.
function saveDeviceConfig(config) {
  const existing = isDeviceConfigured() ? loadDeviceConfig() : {};
  fs.writeFileSync(configPath(), JSON.stringify({ ...existing, ...config }, null, 2));
}

function loadDeviceConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isDeviceConfigured() {
  return fs.existsSync(configPath());
}

module.exports = {
  getUserCredentials,
  saveUserCredentials,
  removeUserCredentials,
  verifyPasswordOffline,
  listUsers,
  saveDeviceConfig,
  loadDeviceConfig,
  isDeviceConfigured,
};
