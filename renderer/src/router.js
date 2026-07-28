import { createRouter, createWebHashHistory } from "vue-router";

// Desktop build: no Login route. The device is already authenticated (API
// key/secret provisioned during first-time setup — see the separate Electron
// login window) before this renderer ever mounts, so POSSale is the only
// real route.
//
// Hash-based history (not createWebHistory) — required when the app is
// loaded via file:// (Electron's loadFile). History-mode routing relies on
// server-side URL rewrites that don't exist under file://, so pushState
// navigation corrupts the address to "file:///" with no path, and a reload
// then fails with ERR_FILE_NOT_FOUND (blank white screen).
const routes = [
  { path: "/", name: "POSSale", component: () => import("@/pages/POSSale.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
