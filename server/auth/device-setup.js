const {
  saveCredentials,
  loadCredentials,
  saveDeviceConfig,
  loadDeviceConfig,
  isDeviceSetup,
} = require("../../main/secure-store");

/**
 * First-time device setup: log in via the normal Frappe cookie-session flow
 * (requires internet), then call the pos_next.api.utilities.generate_device_api_key
 * whitelisted method (added specifically for this app — see
 * C:\Users\User\pos\pos_next\api\utilities.py) to obtain a long-lived API
 * key/secret scoped to the logging-in user only. The cookie session is only
 * used transiently during this call; every request afterwards uses the
 * token, not the cookie.
 */
async function loginAndProvision({
  baseUrl,
  usr,
  pwd,
  outletCode,
  posProfile,
  defaultWarehouse,
}) {
  if (!baseUrl || !usr || !pwd) {
    throw new Error("baseUrl, usr and pwd are required");
  }
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");

  const loginRes = await fetch(`${trimmedBaseUrl}/api/method/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ usr, pwd }).toString(),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => "");
    throw new Error(`Login gagal (${loginRes.status}): ${text.slice(0, 300)}`);
  }
  const setCookie = loginRes.headers.getSetCookie
    ? loginRes.headers.getSetCookie()
    : [];
  if (!setCookie.length) {
    throw new Error("Login berhasil tapi server tidak mengembalikan session cookie");
  }
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");

  const csrfRes = await fetch(
    `${trimmedBaseUrl}/api/method/pos_next.api.utilities.get_csrf_token`,
    { headers: { Cookie: cookieHeader } }
  );
  if (!csrfRes.ok) {
    throw new Error(`Gagal mengambil CSRF token (${csrfRes.status})`);
  }
  const csrfJson = await csrfRes.json();
  const csrfToken = csrfJson.message?.csrf_token || csrfJson.csrf_token;
  if (!csrfToken) throw new Error("Response CSRF token tidak lengkap");

  const keyRes = await fetch(
    `${trimmedBaseUrl}/api/method/pos_next.api.utilities.generate_device_api_key`,
    {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "X-Frappe-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    }
  );
  if (!keyRes.ok) {
    const text = await keyRes.text().catch(() => "");
    throw new Error(`Gagal generate API key (${keyRes.status}): ${text.slice(0, 300)}`);
  }
  const keyJson = await keyRes.json();
  const payload = keyJson.message || keyJson;
  const { api_key: apiKey, api_secret: apiSecret, user } = payload;
  if (!apiKey || !apiSecret) {
    throw new Error("Response generate_device_api_key tidak berisi api_key/api_secret");
  }

  saveCredentials({ apiKey, apiSecret });
  const device = {
    baseUrl: trimmedBaseUrl,
    user,
    outletCode,
    posProfile,
    defaultWarehouse,
    setupAt: new Date().toISOString(),
  };
  saveDeviceConfig(device);

  return device;
}

module.exports = {
  loginAndProvision,
  isDeviceSetup,
  loadDeviceConfig,
  loadCredentials,
};
