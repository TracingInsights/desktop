/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preloads must be CommonJS (ESM preloads are unsupported with sandbox: true). */
// Pet-window preload (sandboxed, CommonJS). Exposes the minimal `petBridge`
// to the bundled app://pet page (docs/DESKTOP_PETS_PLAN.md §4.8): one-way
// pet:* events out, pet:render payloads in. Channel names mirror
// PET_WINDOW_CHANNELS in pets/contract.mjs (sandboxed preloads cannot import
// local files).
const { contextBridge, ipcRenderer } = require('electron');

const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld('petBridge', {
  ready: (info) =>
    send('pet:ready', { reducedMotion: Boolean(info && info.reducedMotion) }),
  drag: (dx, dy) => send('pet:drag', Number(dx), Number(dy)),
  dragEnd: () => send('pet:dragEnd'),
  click: () => send('pet:click'),
  dblclick: () => send('pet:dblclick'),
  hover: () => send('pet:hover'),
  contextMenu: () => send('pet:contextMenu'),
  bubbleClick: () => send('pet:bubbleClick'),
  onRender: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pet:render', listener);
    return () => ipcRenderer.removeListener('pet:render', listener);
  }
});
