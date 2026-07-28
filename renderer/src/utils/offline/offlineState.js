/**
 * Desktop build replacement for the old ~800-line browser network monitor
 * (backoff, cross-tab BroadcastChannel sync, captive-portal detection, etc).
 *
 * None of that is needed here: the local Express server already owns
 * connectivity detection (server/sync/ping.js pings the real Frappe server
 * and server/sync/scheduler.js runs the pull/push cycle), and exposes the
 * result via GET /sync/status. This shim just polls that endpoint and keeps
 * the same public surface (`offlineState`, `isOffline()`, etc.) so consuming
 * components don't need to change.
 */
import { logger } from "../logger";

const log = logger.create("OfflineState");
const BASE = "http://127.0.0.1:8871";
const POLL_MS = 5000;

class OfflineStateShim {
  constructor() {
    this._serverOnline = true;
    this._listeners = new Set();
    this._timer = null;
  }

  get isOffline() {
    return !this._serverOnline;
  }

  get isServerDown() {
    return !this._serverOnline;
  }

  get serverOnline() {
    return this._serverOnline;
  }

  get browserOnline() {
    return typeof navigator !== "undefined" ? navigator.onLine : true;
  }

  get manualOffline() {
    return false;
  }

  setServerOnline(value) {
    if (this._serverOnline === value) return;
    this._serverOnline = value;
    this._notify();
  }

  setManualOffline() {
    // Manual offline mode isn't meaningful here — connectivity is a fact
    // reported by the local server, not something the renderer can fake.
  }

  toggleManualOffline() {
    return false;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getState() {
    return {
      isOffline: this.isOffline,
      manualOffline: false,
      serverOnline: this._serverOnline,
      browserOnline: this.browserOnline,
      isServerDown: this.isServerDown,
      quality: { quality: "unknown", avgLatency: 0 },
    };
  }

  getConnectionQuality() {
    return { quality: "unknown", avgLatency: 0 };
  }

  async checkConnectivity() {
    await this._poll();
    return this.getState();
  }

  _notify() {
    const state = this.getState();
    for (const listener of this._listeners) {
      try {
        listener(state);
      } catch (error) {
        log.error("Error in offline state listener", error);
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("offlineStateChange", { detail: state }));
    }
  }

  async _poll() {
    try {
      const res = await fetch(`${BASE}/sync/status`, { cache: "no-store" });
      const data = await res.json();
      this.setServerOnline(!!data.online);
    } catch {
      this.setServerOnline(false);
    }
  }

  start() {
    if (this._timer) return;
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  initialize() {
    this.start();
  }

  destroy() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._listeners.clear();
  }
}

export const offlineState = new OfflineStateShim();

export function isOffline() {
  return offlineState.isOffline;
}

export const setManualOffline = (value) => offlineState.setManualOffline(value);
export const toggleManualOffline = () => offlineState.toggleManualOffline();
export const getOfflineState = () => offlineState.getState();
export const checkConnectivity = () => offlineState.checkConnectivity();
export const getConnectionQuality = () => offlineState.getConnectionQuality();
export const getIsServerDown = () => offlineState.isServerDown;

if (typeof window !== "undefined") {
  offlineState.start();
}
