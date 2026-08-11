/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preloads must be CommonJS (ESM preloads are unsupported with sandbox: true). */
// Main-window preload (sandboxed, CommonJS). Exposes a small, typed surface
// to the web app so it can auto-connect to the localhost bridge with no
// copy-paste. See the Window.tif1aiDesktop declaration in
// src/lib/ai/desktop-bridge.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tif1aiDesktop', {
  platform: process.platform,
  getBridgeInfo: () => ipcRenderer.invoke('bridge:info'),
  resetBridgeToken: () => ipcRenderer.invoke('bridge:reset-token'),
  // Subscribe to 'bridge:changed' pushes from the main process (a pairing
  // token reset from the Bridge menu / Bridge Info window). Returns an
  // unsubscribe function so the page can tear the listener down when it no
  // longer needs it.
  onBridgeChanged: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('bridge:changed', listener);
    return () => ipcRenderer.removeListener('bridge:changed', listener);
  }
});
