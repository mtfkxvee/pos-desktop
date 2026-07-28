/**
 * Drop-in replacement for frappe-ui's default `frappeRequest` resourceFetcher.
 *
 * frappe-ui's createResource()/createListResource()/call() are all backend-
 * agnostic: they send everything through whatever function is registered via
 * setConfig("resourceFetcher", fn). The original app pointed that at Frappe's
 * own /api/method/<dotted.path> (same-origin, cookie+CSRF auth). Here we point
 * it at the local Express server's generic RPC proxy instead
 * (server/routes/rpc.js), which itself decides — per method — whether to pass
 * through to the real Frappe server (token auth) or answer from the local
 * SQLite cache when offline.
 *
 * Because this is the ONLY thing that changes, every store/composable that
 * already used createResource/createListResource/apiWrapper's call() keeps
 * working completely unmodified.
 */

import { setConfig } from "frappe-ui";

const LOCAL_SERVER_BASE = "http://127.0.0.1:8871";

function request(options) {
  let url = options.url;
  if (!url.startsWith("/") && !url.startsWith("http")) {
    url = `${LOCAL_SERVER_BASE}/rpc/${url}`;
  } else if (url.startsWith("/")) {
    url = `${LOCAL_SERVER_BASE}${url}`;
  }

  const method = options.method || "POST";
  const headers = Object.assign(
    { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
    options.headers || {}
  );

  let body;
  if (options.params) {
    if (method === "GET") {
      const qs = new URLSearchParams(options.params).toString();
      url += (url.includes("?") ? "&" : "?") + qs;
    } else {
      body = JSON.stringify(options.params);
    }
  }

  return fetch(url, { method, headers, body })
    .then(async (response) => {
      if (response.ok) {
        const data = await response.json();
        return data.message !== undefined ? data.message : data;
      }
      const errorBody = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(errorBody);
      } catch {
        parsed = {};
      }
      const err = new Error(parsed.error || parsed.message || response.statusText);
      err.response = response;
      err.status = response.status;
      err.messages = [parsed.error || parsed.message || "Request gagal"];
      options.onError && options.onError(err);
      throw err;
    })
    .catch((err) => {
      options.onError && options.onError(err);
      throw err;
    });
}

export function localResourceFetcher(options) {
  return request(options);
}

export function setLocalResourceFetcher() {
  setConfig("resourceFetcher", localResourceFetcher);
}
