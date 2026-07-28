import { computed, reactive } from "vue";

/**
 * Desktop build: no Frappe cookie session to poll. The device's user is
 * fixed at setup time (see server/auth/device-setup.js) and read once from
 * the local server's /auth/status endpoint.
 */
export const userData = reactive({
  userId: null,
  fullName: null,
  userImage: null,
  refresh() {},
  getDisplayName() {
    return this.fullName || this.userId || "Kasir";
  },
  getImageUrl() {
    return this.userImage;
  },
  getInitials() {
    const parts = this.getDisplayName().split(" ").filter(Boolean);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : this.getDisplayName().substring(0, 2).toUpperCase();
  },
});

export const useUserData = () => ({
  userName: computed(() => userData.getDisplayName()),
  userImage: computed(() => userData.getImageUrl()),
  userInitials: computed(() => userData.getInitials()),
  userId: computed(() => userData.userId),
  refresh: () => userData.refresh(),
});

// Compatibility shim for the handful of places that still treat this like a
// frappe-ui createResource (fetch()/promise/loading/reload/reset).
export const userResource = {
  loading: false,
  data: null,
  promise: Promise.resolve(null),
  fetch() {
    return this.promise;
  },
  reload() {
    return this.promise;
  },
  reset() {},
};

export async function initUserFromDevice() {
  try {
    const res = await fetch("http://127.0.0.1:8871/auth/status").then((r) => r.json());
    if (res?.device?.user) {
      userData.userId = res.device.user;
      userData.fullName = res.device.user;
    }
    return res?.device?.user || null;
  } catch {
    return null;
  }
}
