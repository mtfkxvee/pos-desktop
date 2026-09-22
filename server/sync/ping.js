const { getBaseUrl, getAuthHeader } = require("../frappe-client");

let lastKnownOnline = false;
let lastCheckedAt = 0;
let inFlight = null;

// Cache the result briefly so a burst of related calls (e.g. reprinting an
// invoice does get_invoice then get_invoice_loyalty_points; opening Invoice
// History then viewing a detail then printing) doesn't pay for a fresh
// connectivity check on every single one. Without this, EVERY non-cached
// /rpc call independently re-pings — and on a flaky/dead connection, each
// ping eats its own full timeoutMs before falling back, compounding into
// exactly the "reprint takes forever" complaint this was written to fix.
const CACHE_TTL_MS = 5000;

async function pingOnce(timeoutMs) {
  try {
    const baseUrl = getBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/api/method/frappe.auth.get_logged_user`, {
      headers: { Authorization: getAuthHeader() },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Health-check ping against the real Frappe server. Used to decide whether
 * an invoice goes straight through or gets queued, and drives the
 * online/offline indicator in the UI.
 */
async function pingServer({ timeoutMs = 3000, fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && now - lastCheckedAt < CACHE_TTL_MS) {
    return lastKnownOnline;
  }
  // Coalesce concurrent callers (e.g. two /rpc requests firing back-to-back)
  // into a single in-flight ping instead of racing two separate ones.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let ok = await pingOnce(timeoutMs);
    if (!ok) {
      // One quick retry before declaring offline. A single failed attempt
      // was enough to flip the whole app offline (visible as the UI
      // flapping "online"/"offline" within seconds and unrelated calls
      // 503-ing) on what was really just a transient blip — DNS/TLS
      // handshake jitter or a momentarily slow response, not a genuine
      // outage. This retry is still bounded by the 5s result cache above,
      // so it can't compound into repeated back-to-back pings.
      ok = await pingOnce(timeoutMs);
    }
    lastKnownOnline = ok;
    lastCheckedAt = Date.now();
    inFlight = null;
    return ok;
  })();

  return inFlight;
}

function isOnline() {
  return lastKnownOnline;
}

module.exports = { pingServer, isOnline };
