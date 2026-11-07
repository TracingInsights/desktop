import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetStoreWindow,
  isPetStoreUrl,
  isPetZipDownload,
  PET_STORE_PARTITION
} from './store-window.mjs';

describe('isPetStoreUrl', () => {
  test('https store sites (and www.) only', () => {
    for (const url of [
      'https://petdex.dev/pets/lando',
      'https://codex-pet.org/',
      'https://www.codexpets.net/gallery/lando',
      'https://petscodex.com/pets/x'
    ]) {
      expect(isPetStoreUrl(url)).toBe(true);
    }
    for (const url of [
      'http://petdex.dev/',
      'https://petdex.dev:8443/',
      'https://assets.petdex.dev/pets/x/sprite.webp',
      'https://petdex.dev.evil.example/',
      'https://github.com/crafter-station/petdex',
      'javascript:alert(1)',
      'not a url'
    ]) {
      expect(isPetStoreUrl(url)).toBe(false);
    }
  });

  test('only a pet-sized .zip is imported', () => {
    expect(isPetZipDownload('lando.zip', 2_000_000)).toBe(true);
    expect(isPetZipDownload('LANDO.ZIP', 0)).toBe(true);
    expect(isPetZipDownload('lando.zip', 50 * 1024 * 1024)).toBe(false);
    expect(isPetZipDownload('setup.exe', 1000)).toBe(false);
  });
});

function fakeElectron() {
  const sessionHandlers = {};
  const fakeSession = {
    permissionRequest: null,
    setPermissionRequestHandler(fn) {
      this.permissionRequest = fn;
    },
    setPermissionCheckHandler(fn) {
      this.permissionCheck = fn;
    },
    on(event, fn) {
      sessionHandlers[event] = fn;
    }
  };
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.loaded = [];
      this.handlers = {};
      const wcHandlers = {};
      this.webContents = {
        handlers: wcHandlers,
        on: (e, fn) => (wcHandlers[e] = fn),
        setWindowOpenHandler: (fn) => (this.openHandler = fn),
        loadURL: (url) => this.loaded.push(url),
        getURL: () => this.loaded.at(-1),
        reload: () => {},
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
          goBack: () => {},
          goForward: () => {}
        }
      };
      windows.push(this);
    }
    loadURL(url) {
      this.loaded.push(url);
      return Promise.resolve();
    }
    on(e, fn) {
      this.handlers[e] = fn;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    show() {}
    focus() {}
    destroy() {
      this.destroyed = true;
      this.handlers.closed?.();
    }
  }
  return {
    BrowserWindow,
    windows,
    sessionHandlers,
    fakeSession,
    session: {
      fromPartition: (p) => {
        fakeSession.partition = p;
        return fakeSession;
      }
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) }
  };
}

function setup() {
  const fake = fakeElectron();
  const external = [];
  const imported = [];
  const store = createPetStoreWindow({
    BrowserWindow: fake.BrowserWindow,
    session: fake.session,
    Menu: fake.Menu,
    openExternal: (url) => external.push(url),
    downloadDir: join(mkdtempSync(join(tmpdir(), 'tif1ai-store-')), 'dl'),
    onPetDownload: (path) => imported.push(path)
  });
  return { ...fake, store, external, imported };
}

describe('createPetStoreWindow', () => {
  test('opens store links in one sandboxed window without a preload', () => {
    const { store, windows, external, fakeSession } = setup();
    store.open('https://codex-pet.org/');
    store.open('https://petdex.dev/pets/lando');
    expect(windows.length).toBe(1);
    expect(windows[0].loaded).toEqual([
      'https://codex-pet.org/',
      'https://petdex.dev/pets/lando'
    ]);
    const prefs = windows[0].options.webPreferences;
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    });
    expect(prefs.preload).toBeUndefined();
    expect(fakeSession.partition).toBe(PET_STORE_PARTITION);
    let granted = null;
    fakeSession.permissionRequest(
      null,
      'notifications',
      (ok) => (granted = ok)
    );
    expect(granted).toBe(false);
    expect(external).toEqual([]);
  });

  test('non-store links go to the default browser', () => {
    const { store, windows, external } = setup();
    store.open('https://github.com/x');
    expect(windows.length).toBe(0);
    store.open('https://petdex.dev/');
    const wc = windows[0].webContents;
    expect(wc.handlers['will-navigate']).toBeDefined();
    const nav = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      }
    };
    wc.handlers['will-navigate'](
      nav,
      'https://github.com/crafter-station/petdex'
    );
    expect(nav.prevented).toBe(true);
    const inStore = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      }
    };
    wc.handlers['will-navigate'](inStore, 'https://petdex.dev/pets/max-4');
    expect(inStore.prevented).toBe(false);
    expect(windows[0].openHandler({ url: 'https://petscodex.com/x' })).toEqual({
      action: 'deny'
    });
    expect(windows[0].loaded.at(-1)).toBe('https://petscodex.com/x');
    windows[0].openHandler({ url: 'https://example.com/' });
    expect(external).toEqual([
      'https://github.com/x',
      'https://github.com/crafter-station/petdex',
      'https://example.com/'
    ]);
  });

  test('a pet .zip download is saved to a temp file and imported', () => {
    const { store, sessionHandlers, imported } = setup();
    store.open('https://codexpets.net/');
    let savePath = null;
    let done = null;
    sessionHandlers['will-download'](null, {
      getFilename: () => 'lando.zip',
      getTotalBytes: () => 1_000_000,
      setSavePath: (p) => (savePath = p),
      once: (_e, fn) => (done = fn)
    });
    expect(savePath).toMatch(/[/\\]dl[/\\][0-9a-f-]+\.zip$/);
    done(null, 'completed');
    expect(imported).toEqual([savePath]);

    // Other files keep Electron's save dialog (no save path set).
    let otherPath = null;
    sessionHandlers['will-download'](null, {
      getFilename: () => 'readme.pdf',
      getTotalBytes: () => 1000,
      setSavePath: (p) => (otherPath = p),
      once: () => {}
    });
    expect(otherPath).toBeNull();
  });
});
