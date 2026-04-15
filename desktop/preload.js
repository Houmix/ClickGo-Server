const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updaterAPI', {
  checkForUpdate:      () => ipcRenderer.invoke('updater-check'),
  installUpdate:       () => ipcRenderer.invoke('updater-install'),
  getStatus:           () => ipcRenderer.invoke('updater-status'),
  getVersion:          () => ipcRenderer.invoke('app-version'),
  onUpdateAvailable:   (cb) => ipcRenderer.on('updater-available',    (_e, version) => cb(version)),
  onUpdateProgress:    (cb) => ipcRenderer.on('updater-progress',     (_e, pct) => cb(pct)),
  onUpdateDownloaded:  (cb) => ipcRenderer.on('updater-downloaded',   (_e, version) => cb(version)),
  onUpdateNotAvailable:(cb) => ipcRenderer.on('updater-not-available',(_e) => cb()),
  onUpdateError:       (cb) => ipcRenderer.on('updater-error',        (_e, msg) => cb(msg)),
});
