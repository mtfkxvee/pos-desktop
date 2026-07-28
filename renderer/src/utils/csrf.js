/**
 * Desktop build: no CSRF. Auth is API key/secret held by the local server
 * (see server/frappe-client.js), never exposed to the renderer, so there is
 * no token to fetch/refresh here. These are no-op stubs purely so files that
 * still import them (apiWrapper.js, main.js, a few components) don't break.
 */
export function isCSRFApiError() {
  return false;
}

export async function ensureCSRFToken() {
  return true;
}

export async function forceRefreshCSRFToken() {
  return false;
}

export function getCSRFTokenFromCookie() {
  return null;
}

export function onCSRFTokenRefresh() {
  return () => {};
}

export function createCSRFAwareRequest(fn) {
  return fn;
}
