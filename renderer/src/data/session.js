import { computed, reactive } from "vue";

import { initUserFromDevice, userData } from "./user";

/**
 * Desktop build: no Frappe cookie session in this renderer — the currently
 * active cashier already authenticated (API key/secret) via the login
 * window before this renderer ever mounted, so session.isLoggedIn is always
 * true while this window is open. Logging out closes this window and
 * returns to the login window (see main/index.js's "logout" IPC handler).
 */
export function sessionUser() {
  return userData.userId;
}

export const session = reactive({
  user: null,
  isLoggedIn: computed(() => true),
  login: { loading: false },
  logout: {
    loading: false,
    async submit() {
      session.logout.loading = true;
      try {
        await fetch("http://127.0.0.1:8871/auth/logout", { method: "POST" });
      } finally {
        session.logout.loading = false;
        window.posDesktop?.logout();
      }
    },
  },
});

export async function initSession() {
  session.user = await initUserFromDevice();
  return session.user;
}
