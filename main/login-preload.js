const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("posDesktop", {
  notifySetupComplete: () => ipcRenderer.send("device-setup-complete"),
});
