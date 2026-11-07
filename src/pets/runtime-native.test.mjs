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

function fakeElectron(log) {
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        on,
        send: on,
        setWindowOpenHandler: on,
        session: {}
      };
      log.push(['window', options?.title ?? null]);
    }
    on() {}
    once() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
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

function setup({ stubEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pets-runtime-native-'));
  dirs.push(dir);
  const log = [];
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
    electron: fakeElectron(log),
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
