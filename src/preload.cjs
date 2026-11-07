/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preloads must be CommonJS (ESM preloads are unsupported with sandbox: true). */
// Main-window preload (sandboxed, CommonJS). Exposes the narrow, typed
// harness surface to the web app (docs/custom-providers-desktop.md §7.2).
// Keys are write-only over IPC: only hasKey/masked signals return to the page.
const { contextBridge, ipcRenderer } = require('electron');

// Keep in sync with HARNESS_VERSION in desktop/src/main.mjs — sandboxed
// preloads cannot read local files, so this string is duplicated here.
const HARNESS_VERSION = '1.1.0';

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tif1aiDesktop', {
  platform: process.platform,
  harnessVersion: HARNESS_VERSION,

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    add: (input) => ipcRenderer.invoke('providers:add', input),
    update: (id, patch) => ipcRenderer.invoke('providers:update', id, patch),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
    test: (id) => ipcRenderer.invoke('providers:test', id),
    listModels: (input) => ipcRenderer.invoke('providers:listModels', input),
    keysStoredUnencrypted: () =>
      ipcRenderer.invoke('providers:keysStoredUnencrypted')
  },

  codex: {
    status: () => ipcRenderer.invoke('codex:status'),
    startDeviceAuth: () => ipcRenderer.invoke('codex:startDeviceAuth'),
    pollDeviceAuth: () => ipcRenderer.invoke('codex:pollDeviceAuth'),
    connect: (credential) => ipcRenderer.invoke('codex:connect', credential),
    disconnect: () => ipcRenderer.invoke('codex:disconnect'),
    listModels: () => ipcRenderer.invoke('codex:listModels')
  },

  xai: {
    startDeviceAuth: () => ipcRenderer.invoke('xai:startDeviceAuth'),
    pollDeviceAuth: () => ipcRenderer.invoke('xai:pollDeviceAuth'),
    status: () => ipcRenderer.invoke('xai:status'),
    connect: (credential) => ipcRenderer.invoke('xai:connect', credential),
    disconnect: () => ipcRenderer.invoke('xai:disconnect'),
    listModels: () => ipcRenderer.invoke('xai:listModels')
  },

  inference: {
    generate: (input) => ipcRenderer.invoke('inference:generate', input),
    stream: (input) => ipcRenderer.invoke('inference:stream', input),
    abort: (requestId) => ipcRenderer.invoke('inference:abort', requestId)
  },

  // Desktop pets (harness 1.1.0; docs/DESKTOP_PETS_PLAN.md §4.8). Shape =
  // DesktopPetsSurface in src/lib/desktop-pets/contract.ts; channel names =
  // PETS_CHANNELS in pets/contract.mjs. Every call resolves an envelope.
  pets: {
    status: () => ipcRenderer.invoke('pets:status'),
    search: (input) => ipcRenderer.invoke('pets:search', input),
    shelf: (input) => ipcRenderer.invoke('pets:shelf', input),
    thumbs: (slugs) => ipcRenderer.invoke('pets:thumbs', slugs),
    list: () => ipcRenderer.invoke('pets:list'),
    install: (slug) => ipcRenderer.invoke('pets:install', slug),
    importPet: () => ipcRenderer.invoke('pets:import'),
    remove: (id) => ipcRenderer.invoke('pets:remove', id),
    setActive: (id) => ipcRenderer.invoke('pets:setActive', id),
    updateSettings: (patch) => ipcRenderer.invoke('pets:updateSettings', patch),
    quiet: (kind) => ipcRenderer.invoke('pets:quiet', kind),
    signal: (state) => ipcRenderer.invoke('pets:signal', state),
    restartApp: () => ipcRenderer.invoke('pets:restartApp'),
    // Companion features (docs/DESKTOP_PETS_PLAN.md §12).
    setFavorite: (driverId) => ipcRenderer.invoke('pets:setFavorite', driverId),
    setSecondPet: (id) => ipcRenderer.invoke('pets:setSecondPet', id),
    celebrate: (input) => ipcRenderer.invoke('pets:celebrate', input),
    onboardingDone: () => ipcRenderer.invoke('pets:onboardingDone'),
    openAsk: () => ipcRenderer.invoke('pets:openAsk'),
    onChange: (callback) => subscribe('pets:changed', () => callback())
  },

  // Streaming events: { requestId, delta } chunks and
  // { requestId, text, usage?, finishReason?, error? } end frames.
  onStreamChunk: (callback) => subscribe('inference:chunk', callback),
  onStreamEnd: (callback) => subscribe('inference:end', callback)
});
