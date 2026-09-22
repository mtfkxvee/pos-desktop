const {
  getUserCredentials,
  saveUserCredentials,
  verifyPasswordOffline,
  saveDeviceConfig,
  loadDeviceConfig,
  isDeviceConfigured,
} = require("../../main/secure-store");

// Distinguish "the credentials were actually checked and rejected" (401/403
// — a real "wrong password", must never fall back to offline) from
// EVERYTHING else that can go wrong reaching a login endpoint: no network at
// all (fetch throws a TypeError), a slow/dead connection (our own timeout
// below), or the server responding but broken (502/503/504 from a proxy, a
// maintenance page, etc.). All of those genuinely mean "couldn't verify
// online right now" and should allow the offline-hash fallback — only the
// first big attempt at this used a TypeError-only check, which missed the
// "network technically up but the real server/proxy is erroring" case.
function shouldFallBackOffline(err) {
  if (err instanceof TypeError) return true; // no connection at all
  if (err?.code === "TIMEOUT") return true; // our own abort below
  if (err?.httpStatus && err.httpStatus !== 401 && err.httpStatus !== 403) return true;
  return false;
}

// Which cashier is currently using this running app instance. In-memory only
// — cleared on logout AND on every app restart, so every session starts at
// the login screen (per-cashier login), unlike the old one-time
// device-bound setup.
let activeUser = null;

async function cookieLogin(baseUrl, usr, pwd) {
  // Without an explicit timeout, a dead-but-not-refused connection (e.g. WiFi
  // still "connected" to a router with no real internet) leaves the cashier
  // stuck on a spinner instead of promptly falling back to offline login.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let loginRes;
  try {
    loginRes = await fetch(`${baseUrl}/api/method/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ usr, pwd }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error("Login timeout — server tidak merespons");
      timeoutErr.code = "TIMEOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => "");
    // Full raw response (Frappe's error JSON + Python traceback) is only
    // useful for debugging, not for the cashier staring at the login
    // screen — it used to be dumped straight into the UI verbatim. Log it
    // server-side in full, but surface a short, human message instead.
    console.error(`[cookieLogin] HTTP ${loginRes.status} from ${baseUrl}/api/method/login:`, text.slice(0, 1000));

    let friendly;
    if (loginRes.status === 401 || loginRes.status === 403) {
      friendly = "Username atau password salah. Silakan periksa kembali.";
    } else if (loginRes.status >= 500) {
      friendly = "Server sedang bermasalah. Coba lagi beberapa saat.";
    } else {
      // Fall back to Frappe's own top-level message if there's one worth
      // showing, else a generic but still status-coded message.
      try {
        const parsedMessage = JSON.parse(text)?.message;
        friendly = typeof parsedMessage === "string" && parsedMessage.length < 200 ? parsedMessage : null;
      } catch {
        friendly = null;
      }
      friendly = friendly || `Login gagal (kode ${loginRes.status}). Coba lagi atau hubungi admin.`;
    }

    const err = new Error(friendly);
    err.httpStatus = loginRes.status;
    throw err;
  }
  const setCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
  if (!setCookie.length) {
    throw new Error("Login berhasil tapi server tidak mengembalikan session cookie");
  }
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

/**
 * Full cookie-session login + call pos_next.api.utilities.generate_device_api_key
 * (added specifically for this app — see C:\Users\User\pos\pos_next\api\utilities.py)
 * to obtain a long-lived API key/secret scoped to this one user. The cookie
 * session is only used transiently here; every request afterwards uses the
 * token, not the cookie.
 */
async function generateApiKey(baseUrl, usr, pwd) {
  const cookieHeader = await cookieLogin(baseUrl, usr, pwd);

  const csrfRes = await fetch(`${baseUrl}/api/method/pos_next.api.utilities.get_csrf_token`, {
    headers: { Cookie: cookieHeader },
  });
  if (!csrfRes.ok) {
    throw new Error(`Gagal mengambil CSRF token (${csrfRes.status})`);
  }
  const csrfJson = await csrfRes.json();
  const csrfToken = csrfJson.message?.csrf_token || csrfJson.csrf_token;
  if (!csrfToken) throw new Error("Response CSRF token tidak lengkap");

  const keyRes = await fetch(
    `${baseUrl}/api/method/pos_next.api.utilities.generate_device_api_key`,
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
    console.error(`[generateApiKey] HTTP ${keyRes.status} from generate_device_api_key:`, text.slice(0, 1000));
    throw new Error(
      `Gagal menyiapkan akun untuk device ini (kode ${keyRes.status}). Coba lagi atau hubungi admin.`
    );
  }
  const keyJson = await keyRes.json();
  const payload = keyJson.message || keyJson;
  const { api_key: apiKey, api_secret: apiSecret, user } = payload;
  if (!apiKey || !apiSecret) {
    throw new Error("Response generate_device_api_key tidak berisi api_key/api_secret");
  }
  return { apiKey, apiSecret, user };
}

/**
 * Per-cashier login. First-time-ever on this device also requires the
 * device fields (outlet code, POS Profile, warehouse) and persists them.
 * Every login after that just needs username/password.
 *
 * - Username seen for the first time on this device: MUST be online (no way
 *   to generate an API key without hitting the server).
 * - Username seen before: tries a real online password check first (and
 *   refreshes the local offline-verification hash while at it, so a
 *   password change while online is picked up before it's ever needed
 *   offline). If the server is genuinely unreachable (not just a bad
 *   password), falls back to verifying against that locally-stored hash
 *   instead — so a cashier isn't locked out of the till just because the
 *   internet happens to be down when their shift starts. A previously-seen
 *   username with a WRONG password is rejected in both cases.
 */
async function login({ baseUrl, usr, pwd, outletCode, posProfile, defaultWarehouse }) {
  if (!usr || !pwd) {
    throw new Error("Username dan password wajib diisi");
  }

  const configured = isDeviceConfigured();
  const trimmedBaseUrl = (baseUrl || loadDeviceConfig()?.baseUrl || "").replace(/\/+$/, "");
  if (!trimmedBaseUrl) {
    throw new Error("Server URL wajib diisi");
  }
  if (!configured && (!outletCode || !posProfile || !defaultWarehouse)) {
    throw new Error("Setup device pertama kali butuh kode outlet, POS Profile, dan default warehouse");
  }

  const cached = getUserCredentials(usr);
  let apiKey, apiSecret;

  if (cached) {
    try {
      await cookieLogin(trimmedBaseUrl, usr, pwd); // verifies password online
      ({ apiKey, apiSecret } = cached);
      saveUserCredentials(usr, { apiKey, apiSecret, password: pwd }); // refresh offline hash
    } catch (err) {
      if (!shouldFallBackOffline(err)) throw err; // genuinely wrong password/account issue
      if (!verifyPasswordOffline(usr, pwd)) {
        throw new Error(
          "Server tidak terjangkau dan password tidak cocok dengan sesi offline terakhir."
        );
      }
      ({ apiKey, apiSecret } = cached);
    }
  } else {
    const generated = await generateApiKey(trimmedBaseUrl, usr, pwd);
    apiKey = generated.apiKey;
    apiSecret = generated.apiSecret;
    saveUserCredentials(usr, { apiKey, apiSecret, password: pwd });
  }

  if (!configured) {
    saveDeviceConfig({
      baseUrl: trimmedBaseUrl,
      outletCode,
      posProfile,
      defaultWarehouse,
      setupAt: new Date().toISOString(),
    });
  }

  activeUser = { username: usr, apiKey, apiSecret };
  return { username: usr, device: loadDeviceConfig() };
}

function logout() {
  activeUser = null;
}

function getActiveUser() {
  return activeUser;
}

function isLoggedIn() {
  return !!activeUser;
}

module.exports = {
  login,
  logout,
  getActiveUser,
  isLoggedIn,
  isDeviceConfigured,
  loadDeviceConfig,
};
