const LOCAL_SERVER_BASE = "http://127.0.0.1:8871";

/**
 * Desktop build: frappe-ui's own exported `call()` is a standalone function
 * that does a hardcoded relative fetch("/api/method/...") — it does NOT go
 * through setConfig("resourceFetcher", ...) like createResource/
 * createListResource do. Under file:// (how Electron loads the renderer),
 * that relative fetch has no valid origin to resolve against, so every call
 * site using the raw frappe-ui `call` failed with "Failed to fetch".
 *
 * This re-implements call() with the same absolute-URL transport as
 * localResourceFetcher.js, talking to the local server's /rpc proxy.
 * Every file must import `call` from HERE (not from "frappe-ui" directly) —
 * see the sibling fix that repointed the ~7 components that were importing
 * it straight from frappe-ui.
 */
export async function call(method, params = {}) {
  const res = await fetch(`${LOCAL_SERVER_BASE}/rpc/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(params || {}),
  });

  const data = await res.json().catch(() => ({}));

  if (res.ok) {
    return data.message !== undefined ? data.message : data;
  }

  const err = new Error(data.error || data.message || res.statusText);
  err.status = res.status;
  throw err;
}
