/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preloads must be CommonJS (ESM preloads are unsupported with sandbox: true). */
// Preload for the Bridge Info window (sandboxed, CommonJS).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeInfoApi', {
  get: () => ipcRenderer.invoke('bridge:info'),
  copyText: (text) => ipcRenderer.invoke('bridge:copy-text', text),
  reset: () => ipcRenderer.invoke('bridge:reset-token'),
  openMain: () => ipcRenderer.invoke('bridge:open-main'),
  onChanged: (callback) => {
    ipcRenderer.on('bridge:changed', (_event, info) => callback(info));
  }
});
