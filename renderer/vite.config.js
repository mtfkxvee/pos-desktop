import path from "node:path";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

// Desktop build: no frappe-ui/vite plugin (that's for same-origin Frappe
// bench proxying + Jinja boot data, neither of which applies here — the
// renderer always talks to the local Express server), no PWA plugin (no
// service worker in Electron), no static-copy for the old offline.worker.js
// (replaced entirely by the server-side sync engine).
export default defineConfig({
  // Loaded via file:// in Electron (BrowserWindow.loadFile) — asset paths
  // must be relative, not absolute, or they resolve against the filesystem
  // root instead of the dist folder.
  base: "./",
  plugins: [vue(), Icons({ compiler: "vue3" })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
