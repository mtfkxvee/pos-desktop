const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("posDesktop", {
  logout: () => ipcRenderer.send("logout"),
});
