const { pullAll } = require("./pull");
const { pushQueuedInvoices } = require("./push");
const { pingServer } = require("./ping");

let timer = null;

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
  timer = setInterval(() => {
    runSyncCycle().catch(() => {});
  }, intervalMs);
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runSyncCycle, startScheduler, stopScheduler };
