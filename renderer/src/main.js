/**
 * POS Desktop - Renderer Entry Point
 *
 * Desktop build: no PWA service worker, no CSRF (auth is handled by the local
 * server via API key/secret), no background Worker for offline sync (that's
 * now the local server's job — see server/sync/scheduler.js). The renderer
 * only ever mounts after device setup is complete (see main/index.js), so
 * there is no Login route/cookie-session bootstrap here either.
 */
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { initSession } from "./data/session";
import router from "./router";
import { setLocalResourceFetcher } from "./utils/localResourceFetcher";
import { logger } from "./utils/logger";
import translationPlugin from "./utils/translation";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorMessage,
  FormControl,
  Input,
  TextInput,
  pageMetaPlugin,
  resourcesPlugin,
} from "frappe-ui";

import "./index.css";

const log = logger.create("Main");

const globalComponents = {
  Button,
  TextInput,
  Input,
  FormControl,
  ErrorMessage,
  Dialog,
  Alert,
  Badge,
};

async function initializeApp() {
  // Point frappe-ui's createResource/call() at the local Express server
  // instead of a same-origin Frappe site. This one call is what lets ~45
  // largely-unmodified files (every store/composable that used
  // createResource or apiWrapper's call()) keep working unchanged.
  setLocalResourceFetcher();

  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(resourcesPlugin);
  app.use(pageMetaPlugin);
  app.use(translationPlugin);

  for (const key in globalComponents) {
    app.component(key, globalComponents[key]);
  }

  app.directive("touch-action", {
    mounted: (el) => (el.style.touchAction = "manipulation"),
  });

  await initSession();

  app.use(router);
  app.mount("#app");
  log.info("POS Desktop renderer mounted");
}

initializeApp().catch((error) => {
  console.error("Fatal: POS app initialization failed", error);

  const el = document.getElementById("app");
  if (!el) return;

  el.innerHTML = `
    <div style="
      display:flex; flex-direction:column; align-items:center;
      justify-content:center; height:100vh; font-family:sans-serif;
      background:#F9FAFB; color:#111827; text-align:center; padding:24px;
    ">
      <h2 style="margin:0 0 8px; font-size:18px; font-weight:600;">POS gagal memuat</h2>
      <p style="margin:0 0 24px; color:#6B7280; font-size:14px; max-width:320px;">
        ${error?.message || "Terjadi kesalahan tak terduga."}
      </p>
      <button onclick="location.reload()" style="
        padding:10px 28px; background:#4F46E5; color:#fff;
        border:none; border-radius:8px; font-size:14px;
        font-weight:600; cursor:pointer;
      ">Coba Lagi</button>
    </div>
  `;
});
