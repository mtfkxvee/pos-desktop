const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const { startServer } = require("../server");

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

function openMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.on("closed", () => {
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
  loginWindow = new BrowserWindow({
    // Roughly square — the login background artwork is landscape (~16:9),
    // so a narrow/tall window (previously 480x700) crops most of it away on
    // the sides. A more square window crops top/bottom instead, which
    // preserves the horizontally-spread illustration + logo much better.
    width: 840,
    height: 760,
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
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "login-preload.js"),
    },
  });
  loginWindow.on("closed", () => {
    loginWindow = null;
  });
  attachWindowShortcuts(loginWindow.webContents);
  loginWindow.loadFile(path.join(__dirname, "..", "renderer", "login.html"));
}

async function bootstrap() {
  const dbPath = path.join(app.getPath("userData"), "pos-desktop.sqlite3");
  await startServer({ port: 8871, dbPath });

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

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});
