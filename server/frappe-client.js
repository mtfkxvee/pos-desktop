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

// Frappe's human-readable error text (frappe.throw / ValidationError — the
// usual cause of a 417) lives in `_server_messages`, a JSON string of JSON
// strings, not in `exception`/`message`. Without this the cashier only saw
// "HTTP 417" with no idea what the server actually rejected.
function serverMessages(json) {
  if (!json?._server_messages) return null;
  try {
    const text = JSON.parse(json._server_messages)
      .map((m) => {
        try {
          return JSON.parse(m).message;
        } catch {
          return m;
        }
      })
      .filter(Boolean)
      .join(" | ")
      .replace(/<[^>]+>/g, "");
    return text || null;
  } catch {
    return null;
  }
}

// Every ERP call is bounded. Without a limit a slow (not dead) server kept
// each request open for minutes — Node's fetch only gives up after ~5 min —
// so pulls, pushes and proxied /rpc calls piled up behind it.
const DEFAULT_TIMEOUT_MS = 120 * 1000;

/**
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] abort after this long (0 = no limit).
 */
async function callMethod(method, params = {}, { httpMethod = "POST", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${getBaseUrl()}/api/method/${method}`;
  const headers = {
    Authorization: getAuthHeader(),
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  let json;
  try {
    res = await fetch(url, {
      method: httpMethod,
      headers,
      body: httpMethod === "GET" ? undefined : JSON.stringify(params),
      signal: controller.signal,
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${method} gagal: server tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik`);
    }
    // Node's fetch throws a bare TypeError("fetch failed") for any
    // connection-level failure and keeps the real reason (ECONNRESET,
    // ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...) in err.cause. The bare text
    // is all a cashier ever saw, with no hint it was just the connection.
    if (err instanceof TypeError && err.message === "fetch failed") {
      const reason = err.cause?.code || err.cause?.message;
      throw new Error(
        `${method} gagal: koneksi internet terputus/tidak stabil${reason ? ` (${reason})` : ""}. Coba Sync lagi setelah koneksi normal.`,
        { cause: err }
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  // A body that fails to parse (e.g. genuinely empty, which Frappe sends for
  // a whitelisted method that returns None) must NOT become `{}` here — `{}`
  // is truthy, so a caller doing `if (result)` (e.g. check_opening_shift's
  // "is there an open shift" check) would wrongly treat "no data" as "found
  // something empty", the exact bug that let an empty-object cache entry
  // masquerade as an open shift and skip the shift-opening screen.
  // (Parsed inside the try above so the body read is bounded by the timeout too.)
  if (!res.ok) {
    const message =
      serverMessages(json) || json?.exception || json?.exc_type || json?.message || `HTTP ${res.status}`;
    throw new Error(`${method} gagal: ${message}`);
  }
  if (json === null) return null;
  return json.message !== undefined ? json.message : json;
}

module.exports = { callMethod, getAuthHeader, getBaseUrl };
