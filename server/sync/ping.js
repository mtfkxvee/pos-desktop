const { getBaseUrl, getAuthHeader } = require("../frappe-client");

let lastKnownOnline = false;

/**
 * Health-check ping against the real Frappe server. Used to decide whether
 * an invoice goes straight through or gets queued, and drives the
 * online/offline indicator in the UI.
 */
async function pingServer({ timeoutMs = 3000 } = {}) {
  try {
    const baseUrl = getBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/api/method/frappe.auth.get_logged_user`, {
      headers: { Authorization: getAuthHeader() },
      signal: controller.signal,
    });
    clearTimeout(timer);
    lastKnownOnline = res.ok;
    return res.ok;
  } catch {
    lastKnownOnline = false;
    return false;
  }
}

function isOnline() {
  return lastKnownOnline;
}

module.exports = { pingServer, isOnline };
