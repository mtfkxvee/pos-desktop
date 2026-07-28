const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { startServer } = require("../server");
const { isDeviceSetup } = require("./secure-store");

app.setName("pos-desktop");

let mainWindow;
let loginWindow;

function openMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
}

function openLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 480,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "login-preload.js"),
    },
  });
  loginWindow.loadFile(path.join(__dirname, "..", "renderer", "login.html"));
}

async function bootstrap() {
  const dbPath = path.join(app.getPath("userData"), "pos-desktop.sqlite3");
  await startServer({ port: 8871, dbPath });

  if (isDeviceSetup()) {
    openMainWindow();
  } else {
    openLoginWindow();
  }
}

ipcMain.on("device-setup-complete", () => {
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
  openMainWindow();
});

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});
