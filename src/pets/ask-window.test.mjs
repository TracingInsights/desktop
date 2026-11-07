import { describe, test, expect } from 'bun:test';
import {
  ASK_WINDOW_GAP,
  ASK_WINDOW_HEIGHT,
  ASK_WINDOW_WIDTH,
  askNavigation,
  askWindowBounds,
  createAskWindow,
  isCloseKey
} from './ask-window.mjs';
import { ASK_PATH } from './contract.mjs';

const APP_URL = 'https://app.tracinginsights.com';
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('askWindowBounds', () => {
  test('left of the pet, bottom edges aligned', () => {
    const pet = { x: 1700, y: 860, width: 144, height: 156 };
    expect(askWindowBounds({ pet, workArea: area })).toEqual({
      x: 1700 - ASK_WINDOW_GAP - ASK_WINDOW_WIDTH,
      y: 860 + 156 - ASK_WINDOW_HEIGHT,
      width: ASK_WINDOW_WIDTH,
      height: ASK_WINDOW_HEIGHT
    });
  });

  test('right of the pet when there is no room on the left', () => {
    const pet = { x: 40, y: 100, width: 144, height: 156 };
    const b = askWindowBounds({ pet, workArea: area });
    expect(b.x).toBe(40 + 144 + ASK_WINDOW_GAP);
    // Pet near the top: clamped onto the screen.
    expect(b.y).toBe(0);
  });

  test("stays on the pet's display (second monitor)", () => {
    const pet = { x: 1930, y: 1200, width: 144, height: 156 };
    const b = askWindowBounds({ pet, workArea: right });
    expect(b.x).toBe(1930 + 144 + ASK_WINDOW_GAP);
    expect(b.x + b.width).toBeLessThanOrEqual(1920 + 2560);
    expect(b.y + b.height).toBe(1356);
  });

  test('no pet: bottom-right of the work area; small screens shrink it', () => {
    expect(askWindowBounds({ pet: null, workArea: area })).toEqual({
      x: 1920 - ASK_WINDOW_WIDTH - 24,
      y: 1040 - ASK_WINDOW_HEIGHT - 24,
      width: ASK_WINDOW_WIDTH,
      height: ASK_WINDOW_HEIGHT
    });
    const tiny = { x: 0, y: 0, width: 400, height: 500 };
    expect(askWindowBounds({ pet: null, workArea: tiny })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 500
    });
  });
});

describe('isCloseKey / askNavigation', () => {
  test('plain Esc key-down only', () => {
    expect(isCloseKey({ type: 'keyDown', key: 'Escape' })).toBe(true);
    expect(isCloseKey({ type: 'keyUp', key: 'Escape' })).toBe(false);
    expect(isCloseKey({ type: 'keyDown', key: 'Escape', control: true })).toBe(
      false
    );
    expect(isCloseKey({ type: 'keyDown', key: 'Enter' })).toBe(false);
  });

  test('the ask page stays; other app paths go to the main window', () => {
    const o = new URL(APP_URL).origin;
    expect(askNavigation(`${APP_URL}${ASK_PATH}?x=1#a`, o)).toEqual({
      kind: 'stay'
    });
    expect(askNavigation(`${APP_URL}/chat?q=1#t`, o)).toEqual({
      kind: 'main',
      path: '/chat?q=1#t'
    });
    expect(askNavigation('https://petdex.dev/pets/boba', o)).toEqual({
      kind: 'outside',
      url: 'https://petdex.dev/pets/boba'
    });
    // Lookalike origin is outside, not the app.
    expect(
      askNavigation('https://app.tracinginsights.com.evil.com/chat', o).kind
    ).toBe('outside');
    expect(askNavigation('not a url', o).kind).toBe('outside');
  });
});

function fakeElectron() {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = new Map();
      this.calls = [];
      const wcHandlers = new Map();
      this.webContents = {
        handlers: wcHandlers,
        zoom: 0,
        on: (e, fn) => {
          const list = wcHandlers.get(e) ?? [];
          list.push(fn);
          wcHandlers.set(e, list);
        },
        fire: (e, ...a) => (wcHandlers.get(e) ?? []).forEach((fn) => fn(...a)),
        setWindowOpenHandler: (fn) => (this.openHandler = fn),
        getZoomLevel: () => this.webContents.zoom,
        setZoomLevel: (z) => (this.webContents.zoom = z)
      };
      windows.push(this);
    }
    loadURL(url) {
      this.calls.push(['load', url]);
      this.url = url;
      return Promise.resolve();
    }
    on(e, fn) {
      this.handlers.set(e, fn);
    }
    once(e, fn) {
      this.handlers.set(e, fn);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    setAlwaysOnTop(...a) {
      this.calls.push(['alwaysOnTop', ...a]);
    }
    setVisibleOnAllWorkspaces(...a) {
      this.calls.push(['allWorkspaces', ...a]);
    }
    show() {
      this.calls.push(['show']);
    }
    focus() {
      this.calls.push(['focus']);
    }
    restore() {}
    close() {
      this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.handlers.get('closed')?.();
    }
  }
  return { BrowserWindow, windows };
}

function setup({ pet = { x: 1700, y: 860, width: 144, height: 156 } } = {}) {
  const { BrowserWindow, windows } = fakeElectron();
  const log = [];
  const ask = createAskWindow({
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: area }),
      getDisplayMatching: () => ({ workArea: area })
    },
    appUrl: APP_URL,
    appOrigin: new URL(APP_URL).origin,
    preloadPath: '/app/src/preload.cjs',
    getPetRect: () => pet,
    openMain: (path) => log.push(['main', path]),
    openOutside: (url) => log.push(['outside', url]),
    platform: 'linux',
    onCreated: (w) => log.push(['created', w.options.title]),
    onClosed: () => log.push(['closed'])
  });
  return { ask, windows, log };
}

describe('createAskWindow', () => {
  test('a small framed, resizable, always-on-top window on the ask page with the main preload', () => {
    const { ask, windows, log } = setup();
    expect(ask.open()).toEqual({ ok: true });
    const [win] = windows;
    expect(win.options).toMatchObject({
      width: ASK_WINDOW_WIDTH,
      height: ASK_WINDOW_HEIGHT,
      x: 1700 - ASK_WINDOW_GAP - ASK_WINDOW_WIDTH,
      frame: true,
      resizable: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: '/app/src/preload.cjs',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    expect(win.options.webPreferences.session).toBeUndefined();
    expect(win.url).toBe(`${APP_URL}${ASK_PATH}`);
    expect(win.calls).toContainEqual(['alwaysOnTop', true, 'floating']);
    expect(log[0][0]).toBe('created');
    win.handlers.get('ready-to-show')();
    expect(win.calls).toContainEqual(['show']);
    expect(ask.window()).toBe(win);
  });

  test('one instance: a second open focuses it', () => {
    const { ask, windows } = setup();
    ask.open();
    ask.open();
    expect(windows.length).toBe(1);
    expect(windows[0].calls).toContainEqual(['focus']);
  });

  test('no pet → bottom-right of the primary display', () => {
    const { ask, windows } = setup({ pet: null });
    ask.open();
    expect(windows[0].options.x).toBe(1920 - ASK_WINDOW_WIDTH - 24);
  });

  test('Esc closes; the instance can be reopened', () => {
    const { ask, windows, log } = setup();
    ask.open();
    let prevented = false;
    windows[0].webContents.fire(
      'before-input-event',
      { preventDefault: () => (prevented = true) },
      { type: 'keyDown', key: 'Escape' }
    );
    expect(prevented).toBe(true);
    expect(windows[0].destroyed).toBe(true);
    expect(log.at(-1)).toEqual(['closed']);
    expect(ask.window()).toBeNull();
    ask.open();
    expect(windows.length).toBe(2);
  });

  test('zoom keys work like the main window', () => {
    const { ask, windows } = setup();
    ask.open();
    windows[0].webContents.fire(
      'before-input-event',
      { preventDefault() {} },
      { type: 'keyDown', key: '=', code: 'Equal', control: true }
    );
    expect(windows[0].webContents.zoom).toBe(0.5);
    expect(windows[0].destroyed).toBe(false);
  });

  test('navigation: app links open in the main window, others outside', () => {
    const { ask, windows, log } = setup();
    ask.open();
    const wc = windows[0].webContents;
    const nav = (url) => {
      let prevented = false;
      wc.fire(
        'will-navigate',
        { preventDefault: () => (prevented = true) },
        url
      );
      return prevented;
    };
    expect(nav(`${APP_URL}${ASK_PATH}`)).toBe(false);
    expect(nav(`${APP_URL}/chat`)).toBe(true);
    expect(nav('https://petdex.dev/')).toBe(true);
    expect(nav('https://example.com/')).toBe(true);
    expect(log.slice(1)).toEqual([
      ['main', '/chat'],
      ['outside', 'https://petdex.dev/'],
      ['outside', 'https://example.com/']
    ]);
    // New-window links never open a window.
    expect(windows[0].openHandler({ url: `${APP_URL}/stats` })).toEqual({
      action: 'deny'
    });
    expect(windows[0].openHandler({ url: `${APP_URL}${ASK_PATH}` })).toEqual({
      action: 'deny'
    });
    expect(log.slice(4)).toEqual([['main', '/stats']]);
  });

  test('a client-side route change leaves for the main window and reloads the ask page', () => {
    const { ask, windows, log } = setup();
    ask.open();
    const win = windows[0];
    win.webContents.fire(
      'did-navigate-in-page',
      {},
      `${APP_URL}${ASK_PATH}#x`,
      true
    );
    expect(log.length).toBe(1);
    win.webContents.fire('did-navigate-in-page', {}, `${APP_URL}/chat`, true);
    expect(log.at(-1)).toEqual(['main', '/chat']);
    expect(win.calls.filter((c) => c[0] === 'load').at(-1)).toEqual([
      'load',
      `${APP_URL}${ASK_PATH}`
    ]);
    // Sub-frame navigations are ignored.
    win.webContents.fire('did-navigate-in-page', {}, `${APP_URL}/x`, false);
    expect(log.at(-1)).toEqual(['main', '/chat']);
  });

  test('destroy closes it', () => {
    const { ask, windows } = setup();
    ask.open();
    ask.destroy();
    expect(windows[0].destroyed).toBe(true);
    expect(ask.window()).toBeNull();
  });
});
