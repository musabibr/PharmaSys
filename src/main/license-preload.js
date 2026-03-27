/**
 * Minimal preload for the activation screen.
 * Only exposes license-related IPC — no access to app APIs.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseApi', {
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  getStatus: () => ipcRenderer.invoke('license:getStatus'),
});
