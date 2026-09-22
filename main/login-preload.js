const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("posDesktop", {
  notifyLoginComplete: () => ipcRenderer.send("login-complete"),
});
