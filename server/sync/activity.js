// Tracks when the cashier last did something on the checkout critical path
// (saving a sale, printing a receipt). The background sync scheduler uses it
// to hold off the heavy pull — big JSON parse + search-index rebuild on the
// same single-threaded process — until the cashier has a quiet moment.
let lastCheckoutAt = 0;

function markCheckoutActivity() {
  lastCheckoutAt = Date.now();
}

function isCheckoutBusy(windowMs) {
  return Date.now() - lastCheckoutAt < windowMs;
}

module.exports = { markCheckoutActivity, isCheckoutBusy };
