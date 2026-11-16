/**
 * runtime.mjs × round 3 (L4), Electron faked, no native pet: a synthetic
 * Codex-folder pet is shown in the Electron pet window, and the real IPC,
 * service, controller, pet window and ask window are wired as in the app.
 * Covers the "Answer ready" badge end to end (which window sent `done`,
 * click → Ask window, focus / open / close clear it) and the click panel's
 * actions. OS-level behaviour (real focus, real windows) is not covered.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetsRuntime } from './runtime.mjs';
import { PET_WINDOW_CHANNELS, PETS_CHANNELS } from './contract.mjs';
import { SETTINGS_FILE } from './settings.mjs';
import { fakeDecodeImage, fakePng, petJson } from './data-test-helpers.mjs';

const APP = 'http://127.0.0.1:5999';
const dirs = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const noop = () => {};
const display = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  bounds: { x: 0, y: 0, width: 1920, height: 1080 }
};

/** A nativeImage stand-in that reads sizes off the fake PNG header. */
function fakeImage(buf) {
  const size = buf ? fakeDecodeImage(buf) : null;
  const image = {
    isEmpty: () => !size && Boolean(buf),
    getSize: () => size ?? { width: 16, height: 16 },
    crop: () => image,
    resize: () => image,
    toDataURL: () => 'data:image/png;base64,AA==',
    toPNG: () => Buffer.alloc(0),
    addRepresentation: noop,
    setTemplateImage: noop
  };
  return image;
}

function fakeElectron(windows, ipc) {
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.calls = [];
      this.destroyed = false;
      this.visible = true;
      this.focused = true;
      const wcHandlers = new Map();
      this.webContents = {
        sent: [],
        on: (event, fn) => wcHandlers.set(event, fn),
        fire: (event, ...args) => wcHandlers.get(event)?.(...args),
        send: (channel, payload) =>
          this.webContents.sent.push([channel, payload]),
        setWindowOpenHandler: noop,
        isDestroyed: () => this.destroyed,
        getZoomLevel: () => 0,
        setZoomLevel: noop,
        session: {}
      };
      windows.push(this);
    }
    on(event, fn) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    once(event, fn) {
      this.on(event, fn);
    }
    fire(event) {
      for (const fn of this.handlers.get(event) ?? []) fn();
    }
    loadURL(url) {
      this.url = url;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    show() {
      this.calls.push('show');
    }
    focus() {
      this.calls.push('focus');
    }
    showInactive() {}
    setBounds(bounds) {
      this.bounds = bounds;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.fire('closed');
    }
    destroy() {
      this.close();
    }
  }
  const session = {
    protocol: { handle: noop },
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    webRequest: { onBeforeRequest: noop },
    on: noop
  };
  return {
    app: {
      quit: noop,
      isPackaged: true,
      relaunch: noop,
      exit: noop,
      setLoginItemSettings: noop,
      getLoginItemSettings: () => ({})
    },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (template) => ({ popup: noop, template }) },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    Tray: class {
      setContextMenu() {}
      setToolTip() {}
      on() {}
      isDestroyed() {
        return false;
      }
      destroy() {}
    },
    dialog: {},
    ipcMain: {
      handle: (channel, fn) => ipc.handlers.set(channel, fn),
      on: (channel, fn) => ipc.listeners.set(channel, fn)
    },
    nativeImage: {
      createFromPath: () => fakeImage(null),
      createFromBuffer: (buf) => fakeImage(buf),
      createEmpty: () => fakeImage(null)
    },
    powerMonitor: { on: noop, isOnBatteryPower: () => false },
    screen: {
      on: noop,
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display
    },
    session: { fromPartition: () => session },
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: false })
    }
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pets-runtime-round3-'));
  dirs.push(dir);
  const userDataDir = join(dir, 'userData');
  mkdirSync(userDataDir, { recursive: true });
  // A pet from the Codex folder (synthetic header only, no art).
  const petDir = join(dir, '.codex', 'pets', 'lando');
  mkdirSync(petDir, { recursive: true });
  writeFileSync(join(petDir, 'pet.json'), petJson({ displayName: 'Lando' }));
  writeFileSync(join(petDir, 'spritesheet.png'), fakePng(1536, 1872));
  writeFileSync(
    join(userDataDir, SETTINGS_FILE),
    JSON.stringify({
      v: 1,
      enabled: true,
      activePetId: 'codex:lando',
      onboardingShown: true
    })
  );
  globalThis.fetch = async () => new Response('nope', { status: 404 });

  const windows = [];
  const ipc = { handlers: new Map(), listeners: new Map() };
  /** App URLs the main window was opened / navigated on. */
  const created = [];
  const mainContents = { isDestroyed: () => false, send: noop };
  let mainWindow = null;
  const makeMain = (path) => {
    if (path) created.push(path);
    mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: noop,
      show: noop,
      focus: noop,
      on: noop,
      loadURL: (url) => created.push(new URL(url).pathname),
      webContents: mainContents
    };
    return mainWindow;
  };
  makeMain();
  const runtime = createPetsRuntime({
    electron: fakeElectron(windows, ipc),
    appUrl: APP,
    appOrigin: APP,
    getMainWindow: () => mainWindow,
    createMainWindow: makeMain,
    userDataDir,
    iconPath: join(dir, 'icon.png'),
    petPageDir: dir,
    petPreloadPath: join(dir, 'pet-preload.cjs'),
    mainPreloadPath: join(dir, 'preload.cjs'),
    openExternal: noop,
    platform: 'linux',
    env: {},
    argv: ['app'],
    execPath: '/opt/TracingInsights/tracinginsights',
    homeDir: dir,
    appVersion: '0.2.0',
    nativePetPath: null
  });
  runtime.start({ hidden: false });

  const petWindow = () =>
    windows.find(
      (w) => w.options.title === 'TracingInsights pet' && !w.destroyed
    );
  const askWindows = () =>
    windows.filter((w) => w.options.title?.startsWith('Ask an F1 question'));
  const pet = petWindow();
  pet.webContents.fire('did-finish-load');
  const lastRender = () =>
    pet.webContents.sent
      .filter(([c]) => c === PET_WINDOW_CHANNELS.render)
      .at(-1)?.[1];

  /** pet:* event from the pet page. */
  const petSend = (channel, ...args) =>
    ipc.listeners.get(channel)(
      { sender: pet.webContents, senderFrame: { url: 'app://pet/index.html' } },
      ...args
    );
  /** pets:signal from a window's page. */
  const signalFrom = (contents, url, state) =>
    ipc.handlers.get(PETS_CHANNELS.signal)(
      { sender: contents, senderFrame: { url } },
      state
    );
  return {
    runtime,
    windows,
    askWindows,
    lastRender,
    petSend,
    signalFrom,
    mainContents,
    created
  };
}

describe('runtime round 3 (Electron pet, faked Electron)', () => {
  test('an Ask-window done in the background badges the pet; a click opens the Ask window and clears it', async () => {
    const ctx = setup();
    expect(ctx.lastRender()).toMatchObject({ badge: null, panel: null });
    ctx.runtime.openAsk();
    const [ask] = ctx.askWindows();
    ask.focused = false;
    const result = await ctx.signalFrom(
      ask.webContents,
      `${APP}/desktop/ask`,
      'done'
    );
    expect(result.ok).toBe(true);
    expect(ctx.lastRender().badge).toEqual({
      kind: 'answer',
      label: 'Answer ready'
    });
    ask.calls.length = 0;
    ctx.petSend(PET_WINDOW_CHANNELS.click);
    expect(ask.calls).toEqual(['show', 'focus']);
    expect(ctx.askWindows().length).toBe(1);
    expect(ctx.lastRender()).toMatchObject({ badge: null, panel: null });
  });

  test('no badge for a done from the main window or a focused Ask window', async () => {
    const ctx = setup();
    ctx.runtime.openAsk();
    const [ask] = ctx.askWindows();
    ask.focused = false;
    await ctx.signalFrom(ctx.mainContents, `${APP}/chat`, 'done');
    expect(ctx.lastRender().badge).toBeNull();
    ask.focused = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ctx.signalFrom(ask.webContents, `${APP}/desktop/ask`, 'done');
    expect(ctx.lastRender().badge).toBeNull();
  });

  test('focusing, reopening or closing the Ask window clears the badge', async () => {
    const ctx = setup();
    ctx.runtime.openAsk();
    const [ask] = ctx.askWindows();
    const badge = async () => {
      ask.focused = false;
      await ctx.signalFrom(ask.webContents, `${APP}/desktop/ask`, 'done');
      expect(ctx.lastRender().badge).not.toBeNull();
    };
    await badge();
    ask.fire('focus');
    expect(ctx.lastRender().badge).toBeNull();
    await badge();
    ctx.runtime.openAsk();
    expect(ctx.lastRender().badge).toBeNull();
    await badge();
    ask.close();
    expect(ctx.lastRender().badge).toBeNull();
  });

  test('the click panel: shown on click, its actions open the main window or the Ask window', () => {
    const ctx = setup();
    ctx.petSend(PET_WINDOW_CHANNELS.click);
    const panel = ctx.lastRender().panel;
    expect(panel.actions.map((a) => a.id)).toEqual([
      'ask',
      'stats',
      'hot-lap',
      'pets'
    ]);
    expect(ctx.lastRender().box.panel).toBe('above');
    ctx.petSend(PET_WINDOW_CHANNELS.panelAction, { id: 'pets' });
    expect(ctx.created).toEqual(['/settings/pets']);
    expect(ctx.lastRender().panel).toBeNull();
    // A forged id is dropped by ipc.mjs; Escape (close) closes.
    ctx.petSend(PET_WINDOW_CHANNELS.click);
    ctx.petSend(PET_WINDOW_CHANNELS.panelAction, { id: '/etc/passwd' });
    expect(ctx.lastRender().panel).not.toBeNull();
    ctx.petSend(PET_WINDOW_CHANNELS.panelAction, { id: 'close' });
    expect(ctx.lastRender().panel).toBeNull();
    // Ask F1 opens the Ask window, never a main window on /desktop/ask.
    ctx.petSend(PET_WINDOW_CHANNELS.click);
    ctx.petSend(PET_WINDOW_CHANNELS.panelAction, { id: 'ask' });
    expect(ctx.askWindows().length).toBe(1);
    expect(ctx.askWindows()[0].url).toBe(`${APP}/desktop/ask`);
    expect(ctx.created).toEqual(['/settings/pets']);
  });

  test('a bubble button with no bubble showing does nothing', () => {
    const ctx = setup();
    const before = ctx.lastRender();
    ctx.petSend(PET_WINDOW_CHANNELS.bubbleAction, { id: 'quiet-1h' });
    expect(ctx.lastRender()).toEqual(before);
    expect(ctx.created).toEqual([]);
  });
});
