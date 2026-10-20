const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { startServer } = require("../server");
const { autoUpdater } = require("electron-updater");
const { getDb, closeDb } = require("../server/db/client");

app.setName("pos-desktop");

// Mitigates a known Electron/Chromium crash on some GPU/driver combos:
// "FATAL: Detected dangling raw_ptr in unretained" — a PartitionAlloc
// dangling-pointer DCHECK inside Chromium's GPU/compositor code, not
// something in our app code. Disabling GPU compositing avoids the code
// path that trips the check. POS receipt/cart UI has no need for GPU
// acceleration anyway.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-features", "PartitionAllocDanglingPtr");

// No File/Edit/View/Window menu bar — this should feel like a native
// desktop app, not a browser window. The default Electron menu also ships
// "Reload"/"Force Reload" items, which is one of the ways a cashier could
// hard-refresh mid-sale; removing the whole bar closes that path too (the
// keyboard-shortcut interception below closes the rest — see attachWindowShortcuts).
Menu.setApplicationMenu(null);

let mainWindow;
let loginWindow;

// Set once a downloaded update is ready to install, and re-sent every time
// openMainWindow() runs — a fresh window (e.g. after a logout/re-login)
// otherwise has no way to know an update became ready while it didn't
// exist yet (the IPC 'update-ready' event only reaches windows that are
// listening for it at the moment it's sent).
let pendingUpdateInfo = null;

function notifyMainWindowOfUpdate() {
  if (pendingUpdateInfo && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-ready", pendingUpdateInfo);
  }
}

// Auto-update: checks the GitHub Releases feed configured in
// electron-builder.yml's `publish` block. Deliberately does NOT force a
// restart mid-check — checkForUpdatesAndNotify() downloads in the
// background, and by default only installs the next time the app quits
// (electron-updater hooks app 'before-quit' for this itself via
// autoInstallOnAppQuit). AppUpdateBanner.vue additionally lets the cashier
// trigger the install explicitly (e.g. "update now, it's quiet") via the
// 'install-update-now' IPC below — either path works, whichever comes
// first. Only runs on a packaged build: app.isPackaged is false when
// running via `npm run dev`/`electron .` from source, where there's no
// published feed to check against anyway (it would just throw "Cannot
// find latest.yml").
function initAutoUpdate() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    // Never fatal — an outlet with no internet right now, or between
    // releases, should just keep running the version it already has.
    console.error("[autoUpdater] error:", err?.message || err);
  });
  autoUpdater.on("update-available", (info) => {
    console.log(`[autoUpdater] update available: v${info.version} — downloading in background`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[autoUpdater] v${info.version} downloaded — ready to install`);
    pendingUpdateInfo = { version: info.version };
    notifyMainWindowOfUpdate();
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error("[autoUpdater] checkForUpdatesAndNotify failed:", err?.message || err);
  });
}

const APP_ICON = path.join(__dirname, "..", "build", "icon.png");

// Reload shortcuts (Ctrl+R, Ctrl+Shift+R, F5, Shift+F5) must never work in
// this app — a hard refresh mid-sale would drop the in-memory cart with no
// warning, unlike a real desktop POS terminal. DevTools (F12/Ctrl+Shift+I)
// stays available for support/debugging — it doesn't reload the page.
//
// Note: removing the application menu (Menu.setApplicationMenu(null) above)
// also removes its built-in accelerators, including the default Ctrl+Shift+I
// DevTools toggle — so it's wired explicitly here instead of relying on that.
function attachWindowShortcuts(webContents) {
  webContents.on("before-input-event", (event, input) => {
    const key = input.key?.toLowerCase();
    if (key === "f5") {
      event.preventDefault();
      return;
    }
    if ((input.control || input.meta) && key === "r") {
      event.preventDefault();
      return;
    }
    if (key === "f12" || ((input.control || input.meta) && input.shift && key === "i")) {
      event.preventDefault();
      webContents.toggleDevTools();
    }
  });
}

// ============================================================================
// Screen fit — both windows' layouts were tuned at a fixed size (MAIN_BASE /
// LOGIN_BASE, in CSS px). On a smaller screen (1366x768, 1280x720, 1024x768
// laptops at outlets) a window that size either spills past the taskbar or,
// once squeezed, crams the POS layout into its cramped small-screen
// breakpoints. Instead, each window is shrunk to fit the display's work area
// and its page zoomed out by the same ratio, so the page still lays out as
// if it had the full base size — everything just renders proportionally
// smaller. workArea is already in DIPs, so Windows' own display scaling
// (125%/150%) is accounted for. Never zooms above 1: bigger screens keep the
// layout at its native size, with the extra room going to the window.
// ============================================================================
const MAIN_BASE = { width: 1280, height: 800 };
const LOGIN_BASE = { width: 840, height: 760 };
// Below this the text gets too small to read at a till; past it, the window
// is allowed to scroll rather than shrink further.
const MIN_ZOOM = 0.6;

function fitZoom(base, display = screen.getPrimaryDisplay()) {
  const { width, height } = display.workArea;
  const zoom = Math.min(1, width / base.width, height / base.height);
  return Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100);
}

// Re-applied after every load, not just set once: Chromium keeps zoom per
// origin, and the login and main windows are both file:// pages, so
// whichever one loaded last would otherwise leave its zoom on the other.
function applyZoom(win, getZoom) {
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(getZoom());
  });
}

function openMainWindow() {
  const display = screen.getPrimaryDisplay();
  const zoom = fitZoom(MAIN_BASE, display);
  mainWindow = new BrowserWindow({
    width: Math.min(MAIN_BASE.width, display.workArea.width),
    height: Math.min(MAIN_BASE.height, display.workArea.height),
    icon: APP_ICON,
    // A plain BrowserWindow paints solid white the instant it's created and
    // stays that way until the page's first real frame — visible as a
    // "blank white" flash right after login, worse on a heavier bundle
    // (POSSale's chunk) or a slow first paint. backgroundColor swaps that
    // white for the same gray-50 the app's own loading states use, and
    // show:false + ready-to-show only reveals the window once Chromium has
    // something real to show, instead of the still-white shell.
    backgroundColor: "#f9fafb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      zoomFactor: zoom,
    },
  });
  // A screen smaller than the base size gets the whole work area — a
  // floating window there would only waste the little room there is.
  if (zoom < 1) mainWindow.maximize();
  const win = mainWindow;
  const currentZoom = () => fitZoom(MAIN_BASE, screen.getDisplayMatching(win.getBounds()));
  applyZoom(win, currentZoom);
  // Dragged onto a different monitor, or the resolution/scaling changed
  // while the app was open — refit to whichever display it's on now.
  const refit = () => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(currentZoom());
  };
  win.on("moved", refit);
  screen.on("display-metrics-changed", refit);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    notifyMainWindowOfUpdate();
  });
  mainWindow.on("closed", () => {
    screen.removeListener("display-metrics-changed", refit);
    mainWindow = null;
  });
  attachWindowShortcuts(mainWindow.webContents);

  // Dev mode (see scripts/dev.js): loads straight from the Vite dev server
  // so renderer edits take effect via HMR immediately, instead of requiring
  // `npm run build:renderer` before every test. Only set when that script
  // launched us; a plain `electron .` (or the packaged app) always falls
  // back to the built dist/index.html.
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  }
}

function openLoginWindow() {
  // Scaled as a whole (window size and zoom by the same ratio) rather than
  // just clamped to the screen — keeps the aspect ratio the artwork
  // alignment below depends on.
  const zoom = fitZoom(LOGIN_BASE);
  loginWindow = new BrowserWindow({
    // Roughly square — the login background artwork is landscape (~16:9),
    // so a narrow/tall window (previously 480x700) crops most of it away on
    // the sides. A more square window crops top/bottom instead, which
    // preserves the horizontally-spread illustration + logo much better.
    width: Math.round(LOGIN_BASE.width * zoom),
    height: Math.round(LOGIN_BASE.height * zoom),
    // Fixed size, deliberately. The background artwork is one baked-in
    // image using `background-size: cover` (login.html) — how much of it
    // gets cropped, and where the logo ends up relative to the login card,
    // depends on the window's aspect ratio (cover's scale factor is driven
    // by whichever dimension is more "constrained", which flips between
    // width- and height-driven as the window is resized). Maximizing the
    // window changes that ratio enough that the card visibly drifts away
    // from sitting right under the "X-Sha" wordmark. Locking the size to
    // the one this layout was actually tuned against avoids chasing pixel
    // alignment across arbitrary window shapes.
    resizable: false,
    maximizable: false,
    icon: APP_ICON,
    // Same white-flash fix as openMainWindow — login.html's background is
    // a baked-in image, so a flash of solid white before it loads is even
    // more visible here than a plain color would be.
    backgroundColor: "#f9fafb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "login-preload.js"),
      zoomFactor: zoom,
    },
  });
  applyZoom(loginWindow, () => zoom);
  loginWindow.once("ready-to-show", () => {
    loginWindow?.show();
  });
  loginWindow.on("closed", () => {
    loginWindow = null;
  });
  attachWindowShortcuts(loginWindow.webContents);
  loginWindow.loadFile(path.join(__dirname, "..", "renderer", "login.html"));
}

// ============================================================================
// App Settings (system tray) — right-click the tray icon for admin/support
// actions that don't belong in the cashier-facing UI: resetting this
// device's local data, or force-terminating a frozen app. A Windows taskbar
// icon's right-click menu (a "Jump List") can't have nested submenus or run
// code in the already-running process — only a real Tray icon can, so that's
// what backs this rather than the taskbar icon itself.
// ============================================================================
let tray = null;

function countPendingSyncItems() {
  try {
    const db = getDb();
    const count = (table) =>
      db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE status = 'pending'`).get().c;
    return count("invoice_queue") + count("shift_queue") + count("customer_queue");
  } catch {
    // DB not initialized (e.g. right after a reset, before relaunch) — no
    // pending items to warn about either way.
    return 0;
  }
}

function resetLocalData() {
  const pending = countPendingSyncItems();
  const warningLines = [
    "Ini akan menghapus SEMUA data lokal device ini:",
    "- Setup device (server, outlet, POS Profile)",
    "- Akun kasir yang tersimpan (harus login ulang)",
    "- Seluruh cache & antrian offline (invoice/shift/customer)",
    "",
    "Aplikasi akan restart dan kembali ke layar setup awal.",
  ];
  if (pending > 0) {
    warningLines.splice(
      4,
      0,
      "",
      `PERINGATAN: ada ${pending} data yang BELUM tersinkron ke server. Data ini akan HILANG PERMANEN kalau direset sekarang.`,
    );
  }

  const response = dialog.showMessageBoxSync(mainWindow || loginWindow || null, {
    type: "warning",
    buttons: ["Batal", pending > 0 ? "Reset Walau Ada Data Belum Sinkron" : "Reset Data"],
    defaultId: 0,
    cancelId: 0,
    title: "Reset Data Lokal",
    message: "Yakin reset data device ini?",
    detail: warningLines.join("\n"),
  });

  if (response !== 1) return;

  try {
    closeDb();
    const userData = app.getPath("userData");
    const toDelete = [
      path.join(userData, "pos-desktop.sqlite3"),
      path.join(userData, "pos-desktop.sqlite3-wal"),
      path.join(userData, "pos-desktop.sqlite3-shm"),
      path.join(userData, "config.json"),
      path.join(userData, "users.enc"),
    ];
    for (const f of toDelete) {
      fs.rmSync(f, { force: true });
    }
  } catch (err) {
    dialog.showErrorBox("Reset Gagal", `Gagal menghapus data lokal: ${err.message}`);
    return;
  }

  app.relaunch();
  app.exit(0);
}

function terminateApp() {
  const response = dialog.showMessageBoxSync(mainWindow || loginWindow || null, {
    type: "warning",
    buttons: ["Batal", "Terminate"],
    defaultId: 0,
    cancelId: 0,
    title: "Terminate Aplikasi",
    message: "Matikan aplikasi secara paksa?",
    detail:
      "Ini langsung mematikan proses tanpa penutupan normal — beda dari 'Keluar' biasa. Pakai ini hanya kalau aplikasi macet/tidak merespons. Transaksi yang belum disubmit di cart bisa hilang.",
  });
  if (response !== 1) return;
  app.exit(1);
}

function buildTrayMenu() {
  const pending = countPendingSyncItems();
  return Menu.buildFromTemplate([
    { label: `NursaPOS v${app.getVersion()}`, enabled: false },
    { type: "separator" },
    {
      label: "Buka Aplikasi",
      click: () => {
        if (mainWindow) mainWindow.show();
        else if (loginWindow) loginWindow.show();
      },
    },
    { type: "separator" },
    {
      label: "App Settings",
      submenu: [
        {
          label:
            pending > 0
              ? `Reset Data Lokal... (${pending} belum sinkron)`
              : "Reset Data Lokal...",
          click: resetLocalData,
        },
        { type: "separator" },
        { label: "Terminate Aplikasi", click: terminateApp },
      ],
    },
    { type: "separator" },
    { label: "Keluar", click: () => app.quit() },
  ]);
}

function createAppTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("NursaPOS");
  tray.on("click", () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on("right-click", () => tray.popUpContextMenu(buildTrayMenu()));
}

async function bootstrap() {
  const dbPath = path.join(app.getPath("userData"), "pos-desktop.sqlite3");
  await startServer({ port: 8871, dbPath });

  createAppTray();
  initAutoUpdate();

  // The active session lives only in the server's in-memory state (see
  // server/auth/device-setup.js), which always starts empty on process
  // boot — so every app start (and every explicit logout) requires a
  // cashier to log in again, per-cashier, rather than the app being bound
  // to whichever identity did the very first device setup.
  openLoginWindow();
}

ipcMain.on("login-complete", () => {
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
  openMainWindow();
});

ipcMain.on("logout", () => {
  if (mainWindow) {
    mainWindow.close();
    mainWindow = null;
  }
  openLoginWindow();
});

// Cashier chose "Update Sekarang" from AppUpdateBanner.vue instead of
// waiting for the next natural quit. quitAndInstall() closes every window
// itself (no need to close mainWindow/loginWindow by hand first) and
// relaunches on the new version.
ipcMain.on("install-update-now", () => {
  autoUpdater.quitAndInstall();
});

// Pull-based complement to the push in notifyMainWindowOfUpdate(): a
// download can (and in testing, reliably does) finish before POSHeader.vue
// has even mounted — e.g. while still on the login screen, or while
// App.vue's own initial-sync gate is still resolving — so the one-shot
// `webContents.send("update-ready", ...)` on 'ready-to-show' fires before
// any renderer-side listener exists to catch it, and that message is just
// dropped (Electron IPC doesn't queue for late listeners). useAppUpdate.js
// calls this once on mount to pick up whatever was already downloaded,
// instead of only ever waiting for a live push it may have already missed.
ipcMain.handle("get-pending-update", () => pendingUpdateInfo);

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});
