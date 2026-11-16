import { describe, test, expect } from 'bun:test';
import {
  createPetWindowManager,
  duoOffset,
  SCREEN_MARGIN
} from './pet-window.mjs';
import {
  DASH_MAX_MS,
  MOTION_TICK_MS,
  ROAM_MIN_DISTANCE_PX,
  ROAM_PAUSE_MAX_MS
} from './roam.mjs';

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = {
  id: 2,
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 }
};

function fakeClock(start = 5_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((x) => x.at),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    }
  };
}

function fakeScreen(displays) {
  const listeners = new Map();
  const state = { displays, primary: displays[0] };
  const within = (area, p) =>
    p.x >= area.x &&
    p.y >= area.y &&
    p.x < area.x + area.width &&
    p.y < area.y + area.height;
  return {
    state,
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => state.primary,
    getDisplayMatching: (rect) =>
      state.displays.find((d) =>
        within(d.workArea, {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2
        })
      ) ?? state.primary,
    getDisplayNearestPoint: (p) =>
      state.displays.find((d) => within(d.workArea, p)) ?? state.primary,
    on: (event, fn) => listeners.set(event, fn),
    emit: (event) => listeners.get(event)()
  };
}

function fakeBrowserWindow(options, clock) {
  const handlers = new Map();
  const wcHandlers = new Map();
  const win = {
    bounds: {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height
    },
    /** [time, bounds] per setBounds call. */
    moves: [],
    sent: [],
    destroyed: false,
    isDestroyed: () => win.destroyed,
    destroy() {
      win.destroyed = true;
      handlers.get('closed')?.();
    },
    setBounds(b) {
      win.bounds = b;
      win.moves.push([clock.now(), b]);
    },
    setAlwaysOnTop: () => {},
    setVisibleOnAllWorkspaces: () => {},
    showInactive: () => {},
    loadURL: () => {},
    once: (e, fn) => handlers.set(e, fn),
    on: (e, fn) => handlers.set(e, fn),
    webContents: {
      send: (channel, payload) => win.sent.push(payload),
      setWindowOpenHandler: () => {},
      on: (e, fn) => wcHandlers.set(e, fn),
      fire: (e, ...a) => wcHandlers.get(e)?.(...a)
    }
  };
  return win;
}

function setup({
  positions = {},
  displays = [primary, second],
  randoms = []
} = {}) {
  const clock = fakeClock();
  const screen = fakeScreen(displays);
  let current = { positions };
  const saves = [];
  const windows = [];
  const queue = [...randoms];
  const manager = createPetWindowManager({
    createWindow: (options) => {
      const win = fakeBrowserWindow(options, clock);
      windows.push(win);
      return win;
    },
    screen,
    settings: {
      get: () => current,
      update: (patch) => {
        current = { ...current, ...patch };
        saves.push(structuredClone(patch.positions));
      }
    },
    pageUrl: 'app://pet/index.html',
    preloadPath: '/x/pet-preload.cjs',
    petSession: {},
    platform: 'linux',
    renderChannel: 'pet:render',
    now: clock.now,
    random: () => (queue.length > 0 ? queue.shift() : 0.5),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const open = (payload = {}) => {
    manager.show({ size: payload.size ?? 'm', duo: Boolean(payload.second) });
    windows.at(-1).webContents.fire('did-finish-load');
    manager.render(base(payload));
    return windows.at(-1);
  };
  return { manager, windows, screen, clock, saves, open };
}

const base = (over = {}) => ({
  state: 'idle',
  row: 0,
  frames: 6,
  durationMs: 1100,
  once: false,
  still: false,
  playKey: 'idle',
  size: 'm',
  bubble: null,
  atlas: { url: 'pet-asset://pet/a', rows: 9, scale: 1 },
  second: null,
  motion: null,
  ...over
});

/** Most setBounds calls inside any one-second window. */
function maxMovesPerSecond(moves) {
  let best = 0;
  for (let i = 0; i < moves.length; i += 1) {
    let n = 0;
    for (let j = i; j < moves.length && moves[j][0] < moves[i][0] + 1000; j++)
      n += 1;
    best = Math.max(best, n);
  }
  return best;
}

describe('pet window — roaming (2a)', () => {
  test('motion null: never a walking timer', () => {
    const { manager, clock, open } = setup();
    const win = open();
    manager.render(base({ bubble: 'Hi' }));
    manager.render(base());
    expect(clock.pending()).toEqual([]);
    clock.advance(10 * 60 * 1000);
    expect(win.moves).toHaveLength(2); // bubble grow + shrink only
    expect(manager.motionState()).toEqual({
      mode: null,
      phase: 'idle',
      timer: false
    });
  });

  test('roam: pause, walk along the same y with the running row, save once, idle row again', () => {
    // Pause 10 s, target draw 0 (the far left), next pause 40 s.
    const { manager, clock, saves, open } = setup({ randoms: [0, 0, 1] });
    const win = open({ motion: 'roam' });
    const start = manager.spriteRect();
    expect(start.x).toBe(1920 - 144 - SCREEN_MARGIN);
    expect(clock.pending()).toEqual([clock.now() + 10_000]);

    clock.advance(10_000);
    expect(win.sent.at(-1)).toMatchObject({
      state: 'running-left',
      row: 2,
      frames: 8,
      once: false,
      still: false,
      playKey: 'walk:left',
      motion: 'roam'
    });
    // 1752 px at 60 px/s ≈ 29.2 s.
    clock.advance(15_000);
    const mid = manager.spriteRect();
    expect(mid.y).toBe(start.y);
    expect(mid.x).toBeLessThan(start.x);
    expect(mid.x).toBeGreaterThan(0);
    expect(saves).toEqual([]);
    clock.advance(15_000);
    expect(manager.spriteRect()).toMatchObject({ x: 0, y: start.y });
    expect(saves).toEqual([
      { 1: { x: 0, y: start.y }, last: { x: 0, y: start.y } }
    ]);
    // Back on the payload's row; the next pause is armed.
    expect(win.sent.at(-1)).toMatchObject({ state: 'idle', row: 0 });
    expect(manager.motionState()).toMatchObject({
      phase: 'pause',
      timer: true
    });
    // Armed at the arrival (≈ 29.2 s into the walk) for the 40 s draw.
    const [next] = clock.pending();
    expect(clock.pending()).toHaveLength(1);
    expect(next).toBeGreaterThan(clock.now());
    expect(next).toBeLessThanOrEqual(clock.now() + ROAM_PAUSE_MAX_MS);
    // ≤ 30 window moves per second; every move inside the work area.
    expect(maxMovesPerSecond(win.moves)).toBeLessThanOrEqual(30);
    for (const [, b] of win.moves) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1920);
      expect(b.y).toBe(start.y);
    }
  });

  test('walks stay on the display the pet is on', () => {
    const { manager, clock, open } = setup({
      positions: { last: { x: 2000, y: 300 } }
    });
    const win = open({ motion: 'roam' });
    clock.advance(30 * 60 * 1000);
    expect(win.moves.length).toBeGreaterThan(100);
    for (const [, b] of win.moves) {
      expect(b.x).toBeGreaterThanOrEqual(1920);
      expect(b.x + b.width).toBeLessThanOrEqual(1920 + 2560);
      expect(b.y).toBe(300);
    }
    expect(manager.spriteRect().y).toBe(300);
  });

  test('a duo walks as one group, the pair inside the work area', () => {
    const { manager, clock, open } = setup({
      positions: { last: { x: 400, y: 500 } },
      randoms: [0, 0]
    });
    // The second's own pose (4b) gives way to the running row while walking.
    const secondAnim = {
      state: 'waving',
      row: 3,
      frames: 4,
      durationMs: 700,
      once: true,
      still: false,
      playKey: 'duo-wave:1:second',
      delayMs: 700
    };
    const win = open({
      motion: 'roam',
      second: { url: 'pet-asset://pet/b', rows: 9, scale: 1 },
      secondAnim
    });
    clock.advance(10_000 + 1000);
    expect(win.sent.at(-1)).toMatchObject({
      state: 'running-left',
      secondAnim: null
    });
    // 249 px at 60 px/s ≈ 4.2 s (the next pause is 25 s).
    clock.advance(4000);
    expect(win.sent.at(-1)).toMatchObject({ state: 'idle', secondAnim });
    const offset = duoOffset(144, true);
    // Target draw 0 = the far left the pair can reach.
    expect(manager.spriteRect().x).toBe(offset);
    expect(manager.groupRect()).toMatchObject({ x: 0, width: 144 + offset });
    for (const [, b] of win.moves) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.width).toBe(144 + offset);
    }
    expect(win.sent.at(-1).box.second).toMatchObject({ left: 0 });
  });

  test('motion → null mid-walk: stops at once, saved once, no timers left', () => {
    const { manager, clock, saves, open } = setup({ randoms: [0, 0] });
    const win = open({ motion: 'roam' });
    clock.advance(10_000 + 3000);
    const here = manager.spriteRect().x;
    manager.render(base({ state: 'waving', row: 3, playKey: 'hover:1' }));
    expect(saves).toHaveLength(1);
    expect(saves[0].last).toEqual({ x: here, y: manager.spriteRect().y });
    expect(clock.pending()).toEqual([]);
    // The page gets the payload's own row straight away.
    expect(win.sent.at(-1)).toMatchObject({ state: 'waving', row: 3 });
    clock.advance(60_000);
    expect(manager.spriteRect().x).toBe(here);
  });

  test('a display change stops the walk (saved) and pauses before the next', () => {
    const { manager, clock, saves, screen, open } = setup({
      randoms: [0, 0, 0]
    });
    open({ motion: 'roam' });
    clock.advance(10_000 + 2000);
    screen.emit('display-metrics-changed');
    expect(saves).toHaveLength(1);
    expect(manager.motionState()).toMatchObject({ phase: 'pause' });
    expect(clock.pending()).toEqual([clock.now() + 10_000]);
  });

  test('a drag stops the walk (saved); the window follows the drag only', () => {
    const { manager, clock, saves, open } = setup({ randoms: [0, 0] });
    const win = open({ motion: 'roam' });
    clock.advance(10_000 + 2000);
    const here = manager.spriteRect().x;
    manager.moveBy(30, -20);
    expect(saves).toHaveLength(1);
    expect(manager.spriteRect()).toMatchObject({ x: here + 30 });
    // The controller then sends motion null (the drag is an interaction).
    manager.render(base({ state: 'running-right', row: 1 }));
    const moves = win.moves.length;
    clock.advance(60_000);
    expect(win.moves).toHaveLength(moves);
    expect(clock.pending()).toEqual([]);
  });

  test('hide mid-walk saves and clears; showing again starts afresh', () => {
    const { manager, clock, saves, open } = setup({ randoms: [0, 0] });
    open({ motion: 'roam' });
    clock.advance(10_000 + 2000);
    manager.hide();
    expect(saves).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
    const win = open({ motion: 'roam' });
    expect(manager.spriteRect().x).toBe(saves[0].last.x);
    expect(manager.motionState()).toMatchObject({
      mode: 'roam',
      phase: 'pause'
    });
    clock.advance(ROAM_PAUSE_MAX_MS + 1000);
    expect(win.moves.length).toBeGreaterThan(0);
  });

  test('a size change mid-walk stops it (saved) and pauses', () => {
    const { manager, clock, saves, open } = setup({ randoms: [0, 0, 0] });
    open({ motion: 'roam' });
    clock.advance(10_000 + 2000);
    manager.render(base({ size: 'l', motion: 'roam' }));
    expect(saves).toHaveLength(1);
    expect(manager.motionState()).toMatchObject({ phase: 'pause' });
  });

  test('dash: out to the far edge and back with the bubble, no save at the end', () => {
    const { manager, clock, saves, open } = setup();
    const win = open({
      motion: 'dash',
      bubble: 'Lights out! · Las Vegas GP',
      state: 'running',
      row: 7,
      playKey: 'running'
    });
    const startX = manager.spriteRect().x;
    expect(win.sent.at(-1)).toMatchObject({
      state: 'running-left',
      bubble: 'Lights out! · Las Vegas GP'
    });
    expect(win.sent.at(-1).box.bubble).toBe('above');
    // 1752 px out at 438 px/s = 4 s; the first tick after it turns at x 0.
    clock.advance(DASH_MAX_MS / 2 + MOTION_TICK_MS);
    expect(manager.spriteRect().x).toBe(0);
    expect(win.sent.at(-1).state).toBe('running-right');
    // With a bubble every move re-sends the layout (the bubble stays on screen).
    const sends = win.sent.length;
    clock.advance(MOTION_TICK_MS);
    expect(win.sent.length).toBeGreaterThan(sends);
    clock.advance(DASH_MAX_MS);
    expect(manager.spriteRect().x).toBe(startX);
    expect(saves).toEqual([]);
    expect(win.sent.at(-1)).toMatchObject({ state: 'running', row: 7 });
    expect(clock.pending()).toEqual([]);
    expect(maxMovesPerSecond(win.moves)).toBeLessThanOrEqual(30);
    for (const [, b] of win.moves) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1920);
    }
    // Another payload still saying 'dash' does not run it again.
    manager.render(base({ motion: 'dash', bubble: 'Lights out!' }));
    clock.advance(DASH_MAX_MS);
    expect(manager.spriteRect().x).toBe(startX);
  });

  test('a roam target is never closer than 120 px', () => {
    const { manager, clock, saves, open } = setup();
    open({ motion: 'roam' });
    let previous = manager.spriteRect().x;
    clock.advance(20 * 60 * 1000);
    expect(saves.length).toBeGreaterThan(5);
    for (const saved of saves) {
      expect(Math.abs(saved.last.x - previous)).toBeGreaterThanOrEqual(
        ROAM_MIN_DISTANCE_PX
      );
      previous = saved.last.x;
    }
  });
});
