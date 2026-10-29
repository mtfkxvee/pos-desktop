const { pullAll } = require("./pull");
const { pushQueuedInvoices } = require("./push");
const { pingServer } = require("./ping");
const { isCheckoutBusy } = require("./activity");

let timer = null;

// Background cycles hold off while the cashier is mid-checkout, retrying
// shortly after, but never for longer than MAX_DEFER_MS so stock/price data
// can't go stale through a long rush. Manual syncs (runSyncCycle() with no
// options) always run immediately.
const BUSY_WINDOW_MS = 15 * 1000;
const RETRY_DEFER_MS = 20 * 1000;
const MAX_DEFER_MS = 10 * 60 * 1000;
let deferredSince = null;
let deferTimer = null;

function shouldDefer() {
  if (!isCheckoutBusy(BUSY_WINDOW_MS)) {
    deferredSince = null;
    return false;
  }
  if (deferredSince === null) deferredSince = Date.now();
  if (Date.now() - deferredSince > MAX_DEFER_MS) {
    deferredSince = null;
    return false;
  }
  return true;
}

function runBackgroundCycle() {
  if (shouldDefer()) {
    if (!deferTimer) {
      deferTimer = setTimeout(() => {
        deferTimer = null;
        runBackgroundCycle();
      }, RETRY_DEFER_MS);
    }
    return;
  }
  runSyncCycle().catch(() => {});
}

async function runSyncCycle() {
  const online = await pingServer();
  if (!online) return { online: false };

  const pull = await pullAll().catch((err) => ({ error: err.message }));
  const push = await pushQueuedInvoices().catch((err) => ({ error: err.message }));
  return { online: true, pull, push };
}

// Default 2 minutes — stock/master data is an estimate from last sync, not
// real-time, so there's no socket.io/push channel to replace.
function startScheduler({ intervalMs = 2 * 60 * 1000 } = {}) {
  if (timer) return timer;
  runSyncCycle().catch(() => {});
  timer = setInterval(runBackgroundCycle, intervalMs);
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  if (deferTimer) clearTimeout(deferTimer);
  deferTimer = null;
  deferredSince = null;
}

module.exports = { runSyncCycle, startScheduler, stopScheduler };
