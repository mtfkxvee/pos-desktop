const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("posDesktop", {
  logout: () => ipcRenderer.send("logout"),

  // Auto-update UI (see main/index.js's initAutoUpdate + AppUpdateBanner.vue).
  // "update-ready" fires once a new version has actually finished
  // downloading in the background — nothing to show before that, there's
  // no partial-progress UI, just "it's ready whenever you want it".
  onUpdateReady: (callback) => {
    ipcRenderer.on("update-ready", (_event, info) => callback(info));
  },
  // Pull counterpart to onUpdateReady — catches an update that finished
  // downloading before this window had a listener attached (see
  // main/index.js's get-pending-update handler for why that happens).
  getPendingUpdate: () => ipcRenderer.invoke("get-pending-update"),
  installUpdateNow: () => ipcRenderer.send("install-update-now"),
});
