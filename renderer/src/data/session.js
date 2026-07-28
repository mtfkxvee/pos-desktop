import { computed, reactive } from "vue";

import { initUserFromDevice, userData } from "./user";

/**
 * Desktop build: there is no Frappe cookie session in this renderer at all —
 * the device already authenticated (API key/secret) before this window ever
 * mounted, so session.isLoggedIn is always true, and .user is just the
 * device's provisioned user (see data/user.js).
 */
export function sessionUser() {
  return userData.userId;
}

export const session = reactive({
  user: null,
  isLoggedIn: computed(() => true),
  // Kept only so components that reference session.login/.logout don't
  // crash — there is no in-app login/logout in the desktop build.
  login: { loading: false },
  logout: { loading: false },
});

export async function initSession() {
  session.user = await initUserFromDevice();
  return session.user;
}
