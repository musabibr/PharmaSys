/**
 * Minimal preload bridge for the license activation screen.
 * Exposes only the two license IPC calls — nothing else.
 * This file is CommonJS (not TypeScript) to keep it lightweight and avoid
 * compilation dependencies.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseApi', {
  /**
   * Open a file-picker dialog and activate the selected .pharmalicense file.
   * Returns { success: boolean, reason?: string }
   */
  importFile: () => ipcRenderer.invoke('license:importFile'),
});
