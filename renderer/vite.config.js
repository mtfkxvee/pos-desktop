import path from "node:path";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const TEXT_EDITOR_STUB = path.resolve(__dirname, "src/stubs/empty.js");
const TEXT_EDITOR_RE = /\/components\/TextEditor(\/extensions\/(image|suggestion))?$/;

// Dev-server only: frappe-ui's barrel (src/index.ts) unconditionally
// re-exports its TextEditor component — unused anywhere in this app — which
// drags in a chain of CJS deps (highlight.js, prosemirror/tiptap,
// ~icons/lucide/* virtual imports for its toolbar) that broke Vite's dev
// dependency prebundler one at a time as each was reached. Production
// `vite build` (Rollup) tree-shakes the unused re-export away automatically,
// so this only needs to exist for `vite`/serve mode. A declarative
// resolve.alias regex entry didn't reliably intercept this relative import
// (`./components/TextEditor` from within frappe-ui/src/index.ts) — an
// explicit resolveId hook does.
function stubFrappeUiTextEditor() {
  return {
    name: "stub-frappe-ui-texteditor",
    enforce: "pre",
    resolveId(id, importer) {
      if (importer?.includes("frappe-ui") && TEXT_EDITOR_RE.test(id)) {
        return TEXT_EDITOR_STUB;
      }
      return null;
    },
  };
}

// Desktop build: no frappe-ui/vite plugin (that's for same-origin Frappe
// bench proxying + Jinja boot data, neither of which applies here — the
// renderer always talks to the local Express server), no PWA plugin (no
// service worker in Electron), no static-copy for the old offline.worker.js
// (replaced entirely by the server-side sync engine).
export default defineConfig(({ command }) => ({
  // Loaded via file:// in Electron (BrowserWindow.loadFile) — asset paths
  // must be relative, not absolute, or they resolve against the filesystem
  // root instead of the dist folder.
  base: "./",
  plugins: [
    vue(),
    Icons({ compiler: "vue3" }),
    ...(command === "serve" ? [stubFrappeUiTextEditor()] : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Dev-server-only latency mitigation: unlike the production build (one
    // pre-minified bundle), the dev server transforms each .vue/.js module
    // on-demand, the FIRST time anything requests it — so every dialog/page
    // that hasn't been opened yet in this session pays a compile-on-click
    // cost, felt as "every menu feels slow to open." Once a component has
    // been transformed once it's cached and fast, hence it easing up as you
    // click around more. Warming up the whole component tree at server
    // startup (while scripts/dev.js is still waiting for the server before
    // Electron even opens a window) front-loads all of that cost instead of
    // spreading it across each first click. This doesn't touch the
    // shell-renders-instantly/only-content-loads pattern the app already
    // follows — that's unaffected either way, this is purely about dev
    // transform latency, which a packaged/production build doesn't have at
    // all (test with `npm run build:renderer && npm start` for the true,
    // final feel).
    warmup: {
      clientFiles: [
        "./src/main.js",
        "./src/App.vue",
        "./src/pages/**/*.vue",
        "./src/components/**/*.vue",
      ],
    },
  },
  optimizeDeps: {
    // The resolveId hook above only rewrites frappe-ui's own module graph at
    // actual serve/transform time — esbuild's dependency SCANNER (a
    // separate, more limited pass used to decide what to prebundle) doesn't
    // honor custom Vite plugins and still walks into TextEditor/commands.js,
    // hitting its `~icons/lucide/*` virtual imports. Excluding frappe-ui
    // from the scanner sidesteps that entirely.
    exclude: command === "serve" ? ["frappe-ui"] : [],
    // FeatherIcon.vue (used broadly — Button, Dialog, DatePicker, etc., not
    // just the now-stubbed-out TextEditor) imports feather-icons, a CommonJS
    // package. Excluding frappe-ui above means the scanner no longer
    // discovers feather-icons through it either, so it'd otherwise be
    // served raw and rejected by the browser's native ESM loader ("does not
    // provide an export named 'default'") — force it into prebundling
    // directly instead.
    // interactjs is the same story for grid-layout-plus (drag/resize grid),
    // unrelated to frappe-ui/TextEditor.
    // debug is pulled in by socket.io-client, itself pulled in transitively
    // by frappe-ui (a real-time feature this app doesn't use, but which is
    // still part of frappe-ui's barrel export graph).
    include: ["feather-icons", "interactjs", "debug"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: true,
  },
}));
