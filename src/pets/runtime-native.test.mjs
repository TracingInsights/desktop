/**
 * runtime.mjs with the native pet (docs/DESKTOP_PETS_NATIVE_PLAN.md N1–N4):
 * the Node stub in test-fixtures/ plays `ti-pet`, Electron is faked. The
 * native pet gets the tray + pet menus, its menu actions reach the app,
 * closing the main window writes the timeline, hands over and quits — and
 * a real Quit stops the pet first.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPetsRuntime } from './runtime.mjs';
import { TIMELINE_FILE } from './native-protocol.mjs';
import { SCHEDULE_REFRESH_MS } from './contract.mjs';
import { SETTINGS_FILE } from './settings.mjs';

const STUB = fileURLToPath(
  new URL('./test-fixtures/native-pet-stub.mjs', import.meta.url)
);
const dirs = [];
const pids = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}

const on = () => {};
const display = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  bounds: { x: 0, y: 0, width: 1920, height: 1080 }
};

function fakeElectron(log, windows = []) {
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        on,
        send: on,
        setWindowOpenHandler: on,
        session: {}
      };
      this.handlers = new Map();
      this.destroyed = false;
      log.push(['window', options?.title ?? null]);
      windows.push(this);
    }
    on(event, fn) {
      this.handlers.set(event, fn);
    }
    once() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {}
    focus() {}
    isMinimized() {
      return false;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.handlers.get('closed')?.();
    }
    destroy() {
      this.close();
    }
  }
  const session = {
    protocol: { handle: on },
    setPermissionRequestHandler: on,
    setPermissionCheckHandler: on,
    webRequest: { onBeforeRequest: on },
    on
  };
  return {
    app: {
      quit: () => log.push(['app.quit']),
      isPackaged: true,
      relaunch: on,
      exit: on,
      setLoginItemSettings: (s) => log.push(['login', s])
    },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (t) => ({ popup: on, template: t }) },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    Tray: class {
      constructor() {
        log.push(['electron-tray']);
      }
      setContextMenu() {}
      setToolTip() {}
      on() {}
      isDestroyed() {
        return false;
      }
    },
    dialog: {},
    ipcMain: { handle: on, on, removeHandler: on },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
      createEmpty: () => ({})
    },
    powerMonitor: { on, isOnBatteryPower: () => false },
    screen: {
      on,
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display
    },
    session: { fromPartition: () => session },
    systemPreferences: {}
  };
}

function setup({ stubEnv = {}, installArmed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pets-runtime-native-'));
  dirs.push(dir);
  const log = [];
  /** BrowserWindows the runtime created (ask, store, pet). */
  const windows = [];
  const stubLog = join(dir, 'stub.log');
  const fakeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: on,
    show: () => log.push(['mainShow']),
    focus: on,
    on,
    webContents: { isDestroyed: () => false, send: on }
  });
  let mainWindow = fakeMain();
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  const runtime = createPetsRuntime({
    electron: fakeElectron(log, windows),
    appUrl: 'http://127.0.0.1:5999',
    appOrigin: 'http://127.0.0.1:5999',
    getMainWindow: () => mainWindow,
    createMainWindow: (path) => {
      log.push(['createMain', path ?? null]);
      mainWindow = fakeMain();
      return mainWindow;
    },
    userDataDir: dir,
    iconPath: join(dir, 'icon.png'),
    petPageDir: dir,
    petPreloadPath: join(dir, 'pet-preload.cjs'),
    mainPreloadPath: join(dir, 'preload.cjs'),
    openExternal: on,
    platform: process.platform,
    env: { ...process.env, ...stubEnv, STUB_LOG: stubLog },
    argv: ['app'],
    execPath: '/opt/TracingInsights/tracinginsights',
    homeDir: dir,
    appVersion: '0.2.0',
    nativePetPath: STUB,
    appLaunch: { execPath: '/opt/TracingInsights/tracinginsights', args: [] },
    tmpDir: dir,
    beforeHandoffQuit: () => log.push(['beforeHandoffQuit']),
    installArmed,
    spawnNative: (bin, args, options) => {
      const child = nodeSpawn(process.execPath, [bin, ...args], options);
      if (child.pid) pids.push(child.pid);
      return child;
    }
  });
  const stub = () => {
    try {
      return readFileSync(stubLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    dir,
    log,
    runtime,
    stub,
    windows,
    closeMain: () => {
      mainWindow = null;
    }
  };
}

describe.skipIf(process.platform === 'win32')(
  'runtime + native pet (stub)',
  () => {
    test('the native pet owns the tray; its menu actions reach the app', async () => {
      const { runtime, stub, log } = setup({ stubEnv: { STUB_EVENTS: '1' } });
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      const menu = await until(() => stub().find((l) => l.kind === 'menu'));
      expect(menu.tray.map((i) => i.id)).toContain('tray.open-tracinginsights');
      expect(menu.pet.map((i) => i.id)).toContain('pet.choose-pet');
      // No Electron tray while the native pet runs.
      expect(log.some(([k]) => k === 'electron-tray')).toBe(false);
      // The stub clicked "Open TracingInsights" right after `ready`.
      await until(() => log.some(([k]) => k === 'mainShow'));
      const beforeQuit = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        }
      };
      runtime.beforeQuit(beforeQuit);
      // A real Quit stops the pet first.
      expect(beforeQuit.prevented).toBe(true);
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(stub().at(-1).kind).toBe('quit');
    });

    test('closing the main window: timeline written, handed over, Electron quits, pet stays', async () => {
      const { runtime, stub, log, dir, closeMain } = setup();
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('tray');
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(log.filter(([k]) => k === 'beforeHandoffQuit')).toHaveLength(1);
      const path = join(dir, TIMELINE_FILE);
      expect(existsSync(path)).toBe(true);
      const timeline = JSON.parse(readFileSync(path, 'utf8'));
      expect(timeline.v).toBe(1);
      expect(timeline.pets).toEqual({ first: null, second: null });
      // No pet chosen: tray-only, the timeline says "hidden".
      expect(timeline.entries.every((e) => e.visible === false)).toBe(true);
      expect(stub().find((l) => l.kind === 'handoff')).toEqual({
        kind: 'handoff',
        timelinePath: path
      });
      // The hand-off quit leaves the pet running.
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        }
      };
      runtime.beforeQuit(event);
      expect(event.prevented).toBe(false);
      expect(stub().some((l) => l.kind === 'quit')).toBe(false);
    });

    test('a round-3 pet: v2 timeline with its panel; a walk’s end is saved (L6)', async () => {
      const caps = [
        'duo',
        'bubble',
        'menu',
        'timeline',
        'motion',
        'sleep',
        'bubble-actions',
        'panel',
        'badge',
        'second-anim',
        'v2-rows',
        'timeline-v2'
      ].join(',');
      const { runtime, log, dir, closeMain } = setup({
        stubEnv: { STUB_CAPS: caps, STUB_ROUND3: '1' }
      });
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      // The stub's walk ended at (300, 60) on display d2: saved like a drop.
      const saved = await until(() => {
        try {
          const raw = JSON.parse(
            readFileSync(join(dir, SETTINGS_FILE), 'utf8')
          );
          return raw.positions?.['native:d2'] ? raw.positions : null;
        } catch {
          return null;
        }
      });
      expect(saved['native:d2']).toEqual({ x: 300, y: 60 });
      expect(saved.last).toEqual({ x: 300, y: 60 });
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('tray');
      await until(() => log.some(([k]) => k === 'app.quit'));
      const timeline = JSON.parse(
        readFileSync(join(dir, TIMELINE_FILE), 'utf8')
      );
      expect(timeline.v).toBe(2);
      expect(timeline.panel).toMatchObject({ countdown: true });
      expect(timeline.panel.actions.map((a) => a.id)).toEqual([
        'ask',
        'stats',
        'hot-lap',
        'pets'
      ]);
    });

    test('the main window closing while the renderer is pending still hands over', async () => {
      const { runtime, stub, log, closeMain } = setup();
      runtime.start({ hidden: false });
      expect(runtime.rendererKind()).toBe('pending');
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('tray');
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(stub().some((l) => l.kind === 'handoff')).toBe(true);
    });

    test('the ask or store window closing last hands over too', async () => {
      const { runtime, stub, log, windows, closeMain } = setup();
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      runtime.openAsk();
      runtime.openStore('https://petdex.dev/pets/boba');
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('tray');
      const [ask, store] = ['Ask an F1 question', 'Pet stores'].map((title) =>
        windows.find((w) => w.options?.title?.startsWith(title))
      );
      ask.close();
      await wait(100);
      expect(stub().some((l) => l.kind === 'handoff')).toBe(false);
      store.close();
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(stub().some((l) => l.kind === 'handoff')).toBe(true);
    });

    test('a close during an armed update install waits, then the download installs', async () => {
      const { runtime, stub, log, closeMain } = setup({
        installArmed: () => true
      });
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('held');
      await wait(150);
      expect(stub().some((l) => l.kind === 'handoff')).toBe(false);
      expect(log.some(([k]) => k === 'app.quit')).toBe(false);
      // The download lands: main.mjs stops the pet, then quitAndInstall.
      const petGone = runtime.prepareForUpdate();
      expect(petGone).not.toBeNull();
      await petGone;
      expect(stub().at(-1).kind).toBe('quit');
    });

    test('a close during an armed install, then a cancel, hands over', async () => {
      let armed = true;
      const { runtime, stub, log, windows, closeMain } = setup({
        installArmed: () => armed
      });
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      runtime.openAsk();
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('held');
      // The ask window closing last is held too.
      windows
        .find((w) => w.options?.title?.startsWith('Ask an F1 question'))
        .close();
      await wait(150);
      expect(stub().some((l) => l.kind === 'handoff')).toBe(false);
      // No update after all: the close the main window made happens now.
      armed = false;
      expect(runtime.installCancelled()).toBe('tray');
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(stub().some((l) => l.kind === 'handoff')).toBe(true);
      expect(runtime.installCancelled()).toBeNull();
    });

    test('the store window closing last during an armed install waits for the cancel', async () => {
      let armed = true;
      const { runtime, stub, log, windows, closeMain } = setup({
        installArmed: () => armed
      });
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      runtime.openStore('https://petdex.dev/pets/boba');
      // Closed before the install was armed: back to the tray as usual.
      armed = false;
      closeMain();
      expect(runtime.onMainWindowClosed()).toBe('tray');
      armed = true;
      windows.find((w) => w.options?.title?.startsWith('Pet stores')).close();
      await wait(150);
      expect(stub().some((l) => l.kind === 'handoff')).toBe(false);
      armed = false;
      expect(runtime.installCancelled()).toBe('app');
      await until(() => log.some(([k]) => k === 'app.quit'));
      expect(stub().some((l) => l.kind === 'handoff')).toBe(true);
    });

    test('a window opened during the hand-off keeps Electron and the live pet', async () => {
      const { runtime, stub, log, closeMain } = setup();
      runtime.start({ hidden: false });
      await until(() => runtime.rendererKind() === 'native');
      closeMain();
      runtime.onMainWindowClosed();
      // "Open TracingInsights" from the pet before its ack arrives.
      runtime.lifecycle.openMain();
      await until(() => stub().some((l) => l.kind === 'handoff'));
      await wait(150);
      expect(log.some(([k]) => k === 'app.quit')).toBe(false);
      expect(log.some(([k]) => k === 'beforeHandoffQuit')).toBe(false);
      // Driving again: the replay follows the hand-off.
      const lines = stub();
      const handoffAt = lines.findIndex((l) => l.kind === 'handoff');
      expect(lines.slice(handoffAt + 1).map((l) => l.kind)).toContain('menu');
    });

    test('a refresh run adopts the running pet, recompiles and hands over', async () => {
      const owner = setup();
      owner.runtime.start({ hidden: false });
      await until(() => owner.runtime.rendererKind() === 'native');
      owner.closeMain();
      owner.runtime.onMainWindowClosed();
      await until(() => owner.stub().some((l) => l.kind === 'handoff'));
      const handoffs = () =>
        owner.stub().filter((l) => l.kind === 'handoff').length;

      // A second runtime on the same profile, as `--pets-refresh` would build.
      let exited = false;
      // Same profile (socket + token) as the owner, as `--pets-refresh` would build.
      const refreshRuntime = createPetsRuntime(refreshOptionsFrom(owner));
      const result = await refreshRuntime.refreshAndExit({
        exit: () => {
          exited = true;
        }
      });
      expect(result).toBe('handed-off');
      expect(exited).toBe(true);
      expect(handoffs()).toBe(2);
    });

    test('a refresh run promoted during the schedule fetch keeps the 24 h refresh', async () => {
      const owner = setup();
      owner.runtime.start({ hidden: false });
      await until(() => owner.runtime.rendererKind() === 'native');
      owner.closeMain();
      owner.runtime.onMainWindowClosed();
      await until(() => owner.stub().some((l) => l.kind === 'handoff'));

      let releaseFetch;
      const fetchGate = new Promise((resolve) => (releaseFetch = resolve));
      globalThis.fetch = async () => {
        await fetchGate;
        return new Response('nope', { status: 404 });
      };
      // The schedule's 24 h refresh timers that are still armed.
      const refreshTimers = new Set();
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => {
        const timer = realSetTimeout(fn, ms, ...args);
        if (ms === SCHEDULE_REFRESH_MS) refreshTimers.add(timer);
        return timer;
      };
      globalThis.clearTimeout = (timer) => {
        refreshTimers.delete(timer);
        return realClearTimeout(timer);
      };
      try {
        const refreshRuntime = createPetsRuntime(refreshOptionsFrom(owner));
        const result = refreshRuntime.refreshAndExit({ exit: () => {} });
        await until(() => refreshTimers.size > 0);
        refreshRuntime.promote();
        releaseFetch();
        expect(await result).toBe('promoted');
        expect(refreshTimers.size).toBe(1);
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        for (const timer of refreshTimers) realClearTimeout(timer);
      }
    });
  }
);

/** Runtime options for a refresh run on `owner`'s profile. */
function refreshOptionsFrom(owner) {
  const log = [];
  return {
    electron: fakeElectron(log),
    appUrl: 'http://127.0.0.1:5999',
    appOrigin: 'http://127.0.0.1:5999',
    getMainWindow: () => null,
    createMainWindow: () => null,
    userDataDir: owner.dir,
    iconPath: join(owner.dir, 'icon.png'),
    petPageDir: owner.dir,
    petPreloadPath: join(owner.dir, 'pet-preload.cjs'),
    mainPreloadPath: join(owner.dir, 'preload.cjs'),
    openExternal: on,
    platform: process.platform,
    env: { ...process.env },
    argv: ['app', '--pets-refresh'],
    execPath: '/opt/TracingInsights/tracinginsights',
    homeDir: owner.dir,
    appVersion: '0.2.0',
    nativePetPath: STUB,
    appLaunch: { execPath: '/opt/TracingInsights/tracinginsights', args: [] },
    tmpDir: owner.dir,
    spawnNative: () => {
      throw new Error('a refresh run must never spawn a pet');
    }
  };
}
