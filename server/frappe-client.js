const { loadCredentials, loadDeviceConfig } = require("./auth/device-setup");

/**
 * Authenticated HTTP client to the real Frappe server, used once device
 * setup (Tahap 3) is complete. Auth is via `Authorization: token key:secret`
 * — no cookies, no CSRF, so it works fine after long offline periods.
 */
function getAuthHeader() {
  const creds = loadCredentials();
  if (!creds) throw new Error("Device belum ter-setup (tidak ada API key/secret tersimpan)");
  return `token ${creds.apiKey}:${creds.apiSecret}`;
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

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.exception || json?.message || `HTTP ${res.status}`;
    throw new Error(`${method} gagal: ${message}`);
  }
  return json.message !== undefined ? json.message : json;
}

module.exports = { callMethod, getAuthHeader, getBaseUrl };
