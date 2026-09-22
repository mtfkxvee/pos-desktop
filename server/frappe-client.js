const { getActiveUser, loadDeviceConfig } = require("./auth/device-setup");

/**
 * Authenticated HTTP client to the real Frappe server, used once a cashier
 * is logged in. Auth is via `Authorization: token key:secret` — no cookies,
 * no CSRF, so it works fine after long offline periods. Credentials are the
 * CURRENTLY ACTIVE cashier's, not a fixed device-wide identity — see
 * server/auth/device-setup.js.
 */
function getAuthHeader() {
  const user = getActiveUser();
  if (!user) throw new Error("Belum ada kasir yang login di device ini");
  return `token ${user.apiKey}:${user.apiSecret}`;
}

function getBaseUrl() {
  const device = loadDeviceConfig();
  if (!device?.baseUrl) throw new Error("Device belum ter-setup (base URL server tidak ditemukan)");
  return device.baseUrl;
}

async function callMethod(method, params = {}, { httpMethod = "POST" } = {}) {
  const url = `${getBaseUrl()}/api/method/${method}`;
  const headers = {
    Authorization: getAuthHeader(),
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method: httpMethod,
    headers,
    body: httpMethod === "GET" ? undefined : JSON.stringify(params),
  });

  // A body that fails to parse (e.g. genuinely empty, which Frappe sends for
  // a whitelisted method that returns None) must NOT become `{}` here — `{}`
  // is truthy, so a caller doing `if (result)` (e.g. check_opening_shift's
  // "is there an open shift" check) would wrongly treat "no data" as "found
  // something empty", the exact bug that let an empty-object cache entry
  // masquerade as an open shift and skip the shift-opening screen.
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json?.exception || json?.message || `HTTP ${res.status}`;
    throw new Error(`${method} gagal: ${message}`);
  }
  if (json === null) return null;
  return json.message !== undefined ? json.message : json;
}

module.exports = { callMethod, getAuthHeader, getBaseUrl };
