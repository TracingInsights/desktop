/**
 * Integration test for desktop/src/main.mjs's pets wiring, with `electron`
 * mocked (no Electron binary needed): privileged schemes before ready, the
 * pets runtime after ready, close-to-tray, reopen via second-instance and
 * IPC trust after the main window is recreated.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PET_WINDOW_CHANNELS, PETS_CHANNELS } from './contract.mjs';
import { PET_STORE_PARTITION } from './store-window.mjs';

const userData = mkdtempSync(join(tmpdir(), 'pets-main-'));
const realFetch = globalThis.fetch;
const realAppUrl = process.env.TIF1AI_APP_URL;
afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  if (realAppUrl === undefined) delete process.env.TIF1AI_APP_URL;
  else process.env.TIF1AI_APP_URL = realAppUrl;
});

const APP_URL = 'http://127.0.0.1:5999';
process.env.TIF1AI_APP_URL = APP_URL;
globalThis.fetch = async () => new Response('nope', { status: 404 });

const events = new Map();
const appCalls = [];
const ipcHandlers = new Map();
const ipcListeners = new Map();
const windows = [];
const trays = [];
const notifications = [];
/** Shown FakeNotification instances (click handlers). */
const shown = [];
const updaterEvents = new Map();
const privileged = [];
const sessions = new Map();
let readyResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

class FakeWebContents {
  constructor(win) {
    this.win = win;
    this.handlers = new Map();
    this.sent = [];
    this.id = windows.length + 1;
  }
  on(event, fn) {
    this.handlers.set(event, fn);
  }
  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
  isDestroyed() {
    return this.win.destroyed;
  }
  executeJavaScript() {
    return Promise.resolve('');
  }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.handlers = new Map();
    this.webContents = new FakeWebContents(this);
    windows.push(this);
  }
  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }
  on(event, fn) {
    this.handlers.set(event, fn);
  }
  once(event, fn) {
    this.handlers.set(event, fn);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  show() {}
  focus() {}
  showInactive() {}
  setBounds() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  destroy() {
    this.close();
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.handlers.get('destroyed')?.();
    this.handlers.get('closed')?.();
    if (windows.every((w) => w.destroyed)) events.get('window-all-closed')?.();
  }
  static getAllWindows() {
    return windows.filter((w) => !w.destroyed);
  }
}

class FakeTray {
  constructor(image) {
    this.image = image;
    this.destroyed = false;
    trays.push(this);
  }
  setToolTip() {}
  setContextMenu(menu) {
    this.menu = menu;
  }
  on() {}
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeNotification {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
  }
  on(event, fn) {
    this.handlers.set(event, fn);
  }
  show() {
    notifications.push(this.options);
    shown.push(this);
  }
  static isSupported() {
    return true;
  }
}

const image = {
  isEmpty: () => false,
  resize: () => image,
  getSize: () => ({ width: 1, height: 1 }),
  crop: () => image,
  toDataURL: () => 'data:image/png;base64,AA=='
};
const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

// Packaged only while main.mjs starts, so the auto-updater registers its
// handlers (the test fires 'update-downloaded'); false afterwards.
const fakeApp = {
  getPath: () => userData,
  getVersion: () => '0.2.0',
  getAppPath: () => '/app',
  isPackaged: true,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  on: (event, fn) => events.set(event, fn),
  whenReady: () => ready,
  quit: () => appCalls.push('quit'),
  exit: (code) => appCalls.push(['exit', code]),
  relaunch: (o) => appCalls.push(['relaunch', o]),
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ wasOpenedAtLogin: false })
};

mock.module('electron', () => ({
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  Menu: {
    buildFromTemplate: (template) => ({ template, popup() {} }),
    setApplicationMenu: (menu) => {
      globalThis.__appMenu = menu;
    }
  },
  Notification: FakeNotification,
  Tray: FakeTray,
  clipboard: { writeText() {} },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox() {}
  },
  ipcMain: {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
    on: (channel, fn) => ipcListeners.set(channel, fn)
  },
  nativeImage: {
    createFromPath: () => image,
    createFromBuffer: () => image,
    createEmpty: () => image
  },
  powerMonitor: { on() {}, isOnBatteryPower: () => false },
  protocol: {
    registerSchemesAsPrivileged: (schemes) => privileged.push(...schemes)
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString()
  },
  screen: {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    on() {}
  },
  session: {
    fromPartition: (name) => {
      const s = {
        handled: new Map(),
        protocol: { handle: (scheme, fn) => s.handled.set(scheme, fn) },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        events: new Map(),
        on: (event, fn) => s.events.set(event, fn),
        webRequest: {
          onBeforeRequest: (filter, fn) => (s.blocker = { filter, fn })
        }
      };
      sessions.set(name, s);
      return s;
    }
  },
  shell: { openExternal: async () => {} },
  systemPreferences: {
    getAnimationSettings: () => ({ prefersReducedMotion: false })
  }
}));
mock.module('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event, fn) => updaterEvents.set(event, fn),
      checkForUpdates: async () => {},
      quitAndInstall: () => appCalls.push('quitAndInstall')
    }
  }
}));

const main = await import('../main.mjs');
readyResolve();
await ready;
await new Promise((resolve) => setTimeout(resolve, 0));
fakeApp.isPackaged = false;

/** Poll a condition across a few event-loop turns (async import paths). */
async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

const mainWindows = () => windows.filter((w) => w.options.minWidth === 1024);
const invoke = (channel, win, ...args) =>
  ipcHandlers.get(channel)(
    {
      sender: win.webContents,
      senderFrame: { url: `${APP_URL}/settings/pets` }
    },
    ...args
  );

describe('main.mjs pets wiring (electron mocked)', () => {
  test('harness version 1.1.0 and privileged schemes registered before ready', () => {
    expect(main.HARNESS_VERSION).toBe('1.1.0');
    expect(privileged.map((s) => s.scheme)).toEqual(['app', 'pet-asset']);
  });

  test('every pets:* handler and pet:* listener is registered next to the harness', () => {
    for (const [key, channel] of Object.entries(PETS_CHANNELS)) {
      if (key !== 'changed') expect(ipcHandlers.has(channel)).toBe(true);
    }
    for (const [key, channel] of Object.entries(PET_WINDOW_CHANNELS)) {
      if (key !== 'render') expect(ipcListeners.has(channel)).toBe(true);
    }
    expect(ipcHandlers.has('providers:list')).toBe(true);
  });

  test('the pet session serves only the custom schemes and blocks the network', () => {
    const petSession = [...sessions.values()][0];
    expect([...petSession.handled.keys()]).toEqual(['app', 'pet-asset']);
    let cancelled = null;
    petSession.blocker.fn(
      { url: 'https://example.com/' },
      (r) => (cancelled = r.cancel)
    );
    expect(cancelled).toBe(true);
  });

  test('one main window on start, no tray, pets off by default', async () => {
    expect(mainWindows().length).toBe(1);
    expect(trays.length).toBe(0);
    const result = await invoke(PETS_CHANNELS.status, mainWindows()[0]);
    expect(result.ok).toBe(true);
    expect(result.status.settings.enabled).toBe(false);
    expect(result.status.settings).not.toHaveProperty('positions');
  });

  test('first start with no pet opens the welcome step once', async () => {
    expect(mainWindows()[0].url).toBe(`${APP_URL}/settings/pets?welcome=1`);
    const result = await invoke(PETS_CHANNELS.status, mainWindows()[0]);
    expect(result.status.settings.onboardingShown).toBe(true);
  });

  test('the app menu has Pets… and Quit', () => {
    const items = globalThis.__appMenu.template.find(
      (m) => m.label === 'TracingInsights'
    ).submenu;
    expect(items.map((i) => i.label ?? i.role)).toContain('Pets…');
    expect(items.some((i) => i.role === 'quit')).toBe(true);
  });

  test('closing the window goes to the tray with a one-time notice', () => {
    const first = mainWindows()[0];
    first.close();
    expect(appCalls).not.toContain('quit');
    expect(trays.length).toBe(1);
    expect(notifications.map((n) => n.title)).toEqual([
      'TracingInsights is still running'
    ]);
  });

  test('second-instance recreates the window; IPC trusts the new one only', async () => {
    const old = mainWindows()[0];
    events.get('second-instance')();
    const fresh = mainWindows()[1];
    expect(fresh).toBeDefined();
    expect(fresh.destroyed).toBe(false);
    expect((await invoke(PETS_CHANNELS.list, fresh)).ok).toBe(true);
    expect((await invoke(PETS_CHANNELS.list, old)).ok).toBe(false);
    // Harness IPC follows the recreated window too.
    expect(
      await ipcHandlers.get('providers:list')({
        sender: fresh.webContents,
        senderFrame: { url: `${APP_URL}/` }
      })
    ).toBeDefined();
    await expect(
      ipcHandlers.get('providers:list')({
        sender: old.webContents,
        senderFrame: { url: `${APP_URL}/` }
      })
    ).rejects.toThrow();
  });

  test('a second close does not notify again; Pets… opens /settings/pets', () => {
    mainWindows()[1].close();
    expect(notifications.length).toBe(1);
    const items = globalThis.__appMenu.template.find(
      (m) => m.label === 'TracingInsights'
    ).submenu;
    items.find((i) => i.label === 'Pets…').click();
    expect(mainWindows()[2].url).toBe(`${APP_URL}/settings/pets`);
  });

  test('tray "Ask an F1 question…" opens one ask window the harness and pets IPC trust', async () => {
    const tray = trays.at(-1);
    const item = tray.menu.template.find(
      (i) => i.label === 'Ask an F1 question…'
    );
    expect(item).toBeDefined();
    item.click();
    item.click();
    const asks = windows.filter((w) =>
      w.options.title?.startsWith('Ask an F1 question')
    );
    expect(asks.length).toBe(1);
    const [ask] = asks;
    expect(ask.url).toBe(`${APP_URL}/desktop/ask`);
    expect(ask.options.webPreferences.preload).toMatch(/[/\\]preload\.cjs$/);
    expect(ask.options.alwaysOnTop).toBe(true);
    const askEvent = (url = `${APP_URL}/desktop/ask`) => ({
      sender: ask.webContents,
      senderFrame: { url }
    });
    expect(await ipcHandlers.get('providers:list')(askEvent())).toBeDefined();
    expect((await ipcHandlers.get(PETS_CHANNELS.list)(askEvent())).ok).toBe(
      true
    );
    // Origin checks still apply to the ask window.
    await expect(
      ipcHandlers.get('providers:list')(askEvent('https://evil.example/'))
    ).rejects.toThrow();
    // An app link from the ask page opens in the main window.
    let prevented = false;
    ask.webContents.handlers.get('will-navigate')(
      { preventDefault: () => (prevented = true) },
      `${APP_URL}/chat`
    );
    expect(prevented).toBe(true);
    expect(mainWindows().at(-1).url).toBe(`${APP_URL}/chat`);
    // Closed: no longer trusted.
    ask.close();
    await expect(
      ipcHandlers.get('providers:list')(askEvent())
    ).rejects.toThrow();
  });

  test('notifications off: no update / import notices; the tray and app menu still offer the update', async () => {
    const win = mainWindows().at(-1);
    const setNotifications = async (value) =>
      expect(
        (
          await invoke(PETS_CHANNELS.updateSettings, win, {
            notifications: value
          })
        ).ok
      ).toBe(true);
    const before = notifications.length;

    // On (default): "Update ready", a click installs.
    updaterEvents.get('update-downloaded')({ version: '0.3.0' });
    expect(notifications.slice(before).map((n) => n.title)).toEqual([
      'Update ready'
    ]);
    shown.at(-1).handlers.get('click')();
    expect(appCalls).toContain('quitAndInstall');

    // Off: no notification, the restart stays in the tray + app menu.
    await setNotifications(false);
    const status = await invoke(PETS_CHANNELS.status, win);
    expect(status.status.settings.notifications).toBe(false);
    updaterEvents.get('update-downloaded')({ version: '0.3.1' });
    expect(notifications.length).toBe(before + 1);
    expect(
      trays
        .at(-1)
        .menu.template.some((i) => i.label === 'Restart to update (0.3.1)')
    ).toBe(true);
    expect(
      globalThis.__appMenu.template
        .find((m) => m.label === 'TracingInsights')
        .submenu.some((i) => i.label === 'Restart to Update (0.3.1)')
    ).toBe(true);

    // A pet-store download that is not a pet: logged, no notification.
    win.webContents.openHandler({ url: 'https://petdex.dev/pets/boba' });
    const storeSession = sessions.get(PET_STORE_PARTITION);
    const download = () => {
      let done;
      storeSession.events.get('will-download')(
        {},
        {
          getFilename: () => 'boba.zip',
          getTotalBytes: () => 10,
          setSavePath() {},
          once: (_event, fn) => (done = fn)
        }
      );
      done({}, 'completed');
    };
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      download();
      await waitFor(() => warned.some((w) => w.includes('import failed')));
      expect(notifications.length).toBe(before + 1);

      // Back on: the same failure is a notification that opens Pets.
      await setNotifications(true);
      download();
      await waitFor(() => notifications.length === before + 2);
    } finally {
      console.warn = warn;
    }
    expect(notifications.at(-1).title).toBe('Could not import the pet');
    shown.at(-1).handlers.get('click')();
    expect(mainWindows().at(-1).url).toBe(`${APP_URL}/settings/pets`);
  });

  test("closeToTray off → closing quits (today's behaviour)", async () => {
    const win = mainWindows()[2];
    expect(
      (await invoke(PETS_CHANNELS.updateSettings, win, { closeToTray: false }))
        .ok
    ).toBe(true);
    win.close();
    expect(appCalls).toContain('quit');
  });
});
