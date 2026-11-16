import { describe, test, expect } from 'bun:test';
import {
  ACTION_GAP_PX,
  ACTION_ROW_PX,
  actionRows,
  actionWidth,
  BUBBLE_HEIGHT,
  BUBBLE_MAX_WIDTH,
  BUBBLE_MIN_WIDTH,
  bubbleArea,
  LINE_ROW_PX,
  PANEL_MIN_WIDTH,
  panelArea,
  SCREEN_MARGIN,
  clampRect,
  clampSprite,
  duoOffset,
  duoSecondSide,
  groupRect,
  createPetWindowManager,
  initialSpritePosition,
  spriteSize,
  windowLayout
} from './pet-window.mjs';

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = {
  id: 2,
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 }
};
const M = spriteSize('m');

describe('geometry', () => {
  test('sizes follow PET_SIZES', () => {
    expect(spriteSize('s')).toEqual({ width: 96, height: 104 });
    expect(spriteSize('m')).toEqual({ width: 144, height: 156 });
    expect(spriteSize('l')).toEqual({ width: 192, height: 208 });
    expect(spriteSize('xl')).toEqual(M);
  });

  test('clampRect keeps the rect inside the area', () => {
    const area = primary.workArea;
    expect(
      clampRect({ x: -50, y: 2000, width: 100, height: 100 }, area)
    ).toMatchObject({
      x: 0,
      y: 940
    });
  });

  test('default: bottom-right of the primary work area, 24 px margin', () => {
    expect(
      initialSpritePosition({
        displays: [primary, second],
        primary,
        positions: {},
        sprite: M
      })
    ).toEqual({
      x: 1920 - 144 - SCREEN_MARGIN,
      y: 1040 - 156 - SCREEN_MARGIN,
      displayId: '1'
    });
  });

  test('last position wins when its display is connected', () => {
    const positions = { 1: { x: 10, y: 10 }, last: { x: 2000, y: 100 } };
    expect(
      initialSpritePosition({
        displays: [primary, second],
        primary,
        positions,
        sprite: M
      })
    ).toEqual({ x: 2000, y: 100, displayId: '2' });
  });

  test('display gone → primary saved position, clamped', () => {
    const positions = { 1: { x: 5000, y: 5000 }, last: { x: 2000, y: 100 } };
    expect(
      initialSpritePosition({
        displays: [primary],
        primary,
        positions,
        sprite: M
      })
    ).toEqual({
      x: 1920 - 144,
      y: 1040 - 156,
      displayId: '1'
    });
  });

  test('layout without a bubble = the sprite box', () => {
    const sprite = { x: 100, y: 500, ...M };
    expect(
      windowLayout({ sprite, bubble: false, workArea: primary.workArea })
    ).toEqual({
      bounds: { x: 100, y: 500, ...M },
      box: {
        width: 144,
        height: 156,
        spriteLeft: 0,
        spriteTop: 0,
        spriteWidth: 144,
        spriteHeight: 156,
        bubble: null,
        panel: null,
        second: null
      }
    });
  });

  test('a bubble grows the window upward and keeps the sprite in place', () => {
    const sprite = { x: 500, y: 500, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: true,
      workArea: primary.workArea
    });
    expect(bounds.height).toBe(156 + BUBBLE_HEIGHT);
    expect(bounds.width).toBe(BUBBLE_MIN_WIDTH);
    expect(bounds.y).toBe(500 - BUBBLE_HEIGHT);
    expect(bounds.x + box.spriteLeft).toBe(500);
    expect(bounds.y + box.spriteTop).toBe(500);
    expect(box.bubble).toBe('above');
  });

  test('no room above → bubble below; screen edge clamps the window, not the sprite', () => {
    const sprite = { x: 1920 - 144, y: 10, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: true,
      workArea: primary.workArea
    });
    expect(box.bubble).toBe('below');
    expect(bounds.x + bounds.width).toBe(1920);
    expect(bounds.x + box.spriteLeft).toBe(sprite.x);
    expect(bounds.y + box.spriteTop).toBe(sprite.y);
  });
});

describe('duo geometry', () => {
  const offset = duoOffset(M.width, true);

  test('the second sprite sits left of the first with a small gap', () => {
    expect(duoOffset(M.width, false)).toBe(0);
    expect(offset).toBe(144 + 7);
    expect(groupRect({ x: 500, y: 300, ...M }, true)).toEqual({
      x: 500 - offset,
      y: 300,
      width: 144 + offset,
      height: 156
    });
  });

  test('layout widens the window leftward; the first sprite stays put', () => {
    const sprite = { x: 1000, y: 500, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: false,
      workArea: primary.workArea,
      duo: true
    });
    expect(bounds).toEqual({
      x: 1000 - offset,
      y: 500,
      width: 144 + offset,
      height: 156
    });
    expect(bounds.x + box.spriteLeft).toBe(1000);
    expect(box.second).toEqual({ left: 0, top: 0, side: 'left' });
    expect(box.width).toBe(bounds.width);
  });

  test('the bubble is centred over both sprites', () => {
    const sprite = { x: 1000, y: 500, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: true,
      workArea: primary.workArea,
      duo: true
    });
    const group = groupRect(sprite, true);
    expect(bounds.width).toBe(Math.max(group.width, BUBBLE_MIN_WIDTH));
    expect(bounds.x + bounds.width / 2).toBeCloseTo(
      group.x + group.width / 2,
      0
    );
    expect(bounds.x + box.spriteLeft).toBe(1000);
    expect(bounds.x + box.second.left).toBe(group.x);
    expect(bounds.y + box.second.top).toBe(500);
    expect(box.bubble).toBe('above');
  });

  test('duoSecondSide reads the side off the layout: always left', () => {
    expect(duoSecondSide({ x: 1000, y: 500, ...M })).toBe('left');
    expect(duoSecondSide({ x: 0, y: 0, ...spriteSize('s') })).toBe('left');
  });

  test('edge clamping shifts the pair but never swaps the sprites', () => {
    for (const x of [-5000, 0, 50, 1900, 9000]) {
      const r = clampSprite({ x, y: 500, ...M }, true, primary.workArea);
      const { bounds, box } = windowLayout({
        sprite: r,
        bubble: true,
        workArea: primary.workArea,
        duo: true
      });
      expect(box.second.left).toBeLessThan(box.spriteLeft);
      expect(box.second.side).toBe('left');
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
    }
  });

  test('clamping keeps the pair inside the work area', () => {
    const r = clampSprite({ x: 50, y: 900, ...M }, true, primary.workArea);
    expect(r.x).toBe(offset);
    expect(r.y).toBe(1040 - 156);
    expect(clampSprite({ x: 50, y: 0, ...M }, false, primary.workArea).x).toBe(
      50
    );
  });

  test('initial position: saved first-sprite point, pair clamped', () => {
    const start = initialSpritePosition({
      displays: [primary],
      primary,
      positions: { last: { x: 20, y: 100 } },
      sprite: M,
      duo: true
    });
    expect(start).toEqual({ x: offset, y: 100, displayId: '1' });
    const def = initialSpritePosition({
      displays: [primary],
      primary,
      positions: {},
      sprite: M,
      duo: true
    });
    expect(def.x).toBe(1920 - 144 - SCREEN_MARGIN);
  });
});

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

function fakeBrowserWindow(options) {
  const handlers = new Map();
  const wcHandlers = new Map();
  const win = {
    options,
    bounds: {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height
    },
    sent: [],
    calls: [],
    destroyed: false,
    isDestroyed: () => win.destroyed,
    destroy() {
      win.destroyed = true;
      handlers.get('closed')?.();
    },
    setBounds(b) {
      win.bounds = b;
    },
    setAlwaysOnTop: (...a) => win.calls.push(['alwaysOnTop', ...a]),
    setVisibleOnAllWorkspaces: (...a) =>
      win.calls.push(['allWorkspaces', ...a]),
    showInactive: () => win.calls.push(['showInactive']),
    loadURL: (url) => {
      win.url = url;
    },
    once: (e, fn) => handlers.set(e, fn),
    on: (e, fn) => handlers.set(e, fn),
    fire: (e) => handlers.get(e)?.(),
    webContents: {
      send: (channel, payload) => win.sent.push([channel, payload]),
      setWindowOpenHandler: (fn) => (win.openHandler = fn),
      on: (e, fn) => wcHandlers.set(e, fn),
      fire: (e, ...a) => wcHandlers.get(e)?.(...a)
    }
  };
  return win;
}

function setup({
  positions = {},
  platform = 'linux',
  displays = [primary, second]
} = {}) {
  const screen = fakeScreen(displays);
  let current = { positions };
  const windows = [];
  const manager = createPetWindowManager({
    createWindow: (options) => {
      const win = fakeBrowserWindow(options);
      windows.push(win);
      return win;
    },
    screen,
    settings: {
      get: () => current,
      update: (patch) => {
        current = { ...current, ...patch };
      }
    },
    pageUrl: 'app://pet/index.html',
    preloadPath: '/x/pet-preload.cjs',
    petSession: { name: 'pet' },
    platform,
    renderChannel: 'pet:render'
  });
  return { manager, windows, screen, settings: () => current };
}

const payload = (over = {}) => ({
  state: 'idle',
  size: 'm',
  bubble: null,
  atlas: {},
  ...over
});

describe('createPetWindowManager', () => {
  test('creates a transparent, frameless, always-on-top, sandboxed window', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    const [win] = windows;
    expect(win.options).toMatchObject({
      transparent: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Linux: focusable, or Mutter refuses always-on-top.
      focusable: true,
      show: false,
      webPreferences: {
        preload: '/x/pet-preload.cjs',
        session: { name: 'pet' },
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    expect(win.url).toBe('app://pet/index.html');
    expect(win.calls).toContainEqual(['alwaysOnTop', true, 'floating']);
    expect(win.openHandler()).toEqual({ action: 'deny' });
    const nav = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      }
    };
    win.webContents.fire('will-navigate', nav);
    expect(nav.prevented).toBe(true);
    win.fire('ready-to-show');
    expect(win.calls).toContainEqual(['showInactive']);
  });

  test('macOS: visible on all workspaces, over full-screen apps', () => {
    const { manager, windows } = setup({ platform: 'darwin' });
    // Windows/macOS: never takes focus from the app the user is in.
    manager.show({ size: 'm' });
    expect(windows[0].options.focusable).toBe(false);
    manager.hide();
    windows.length = 0;
    manager.show({ size: 'm' });
    expect(windows[0].calls).toContainEqual([
      'allWorkspaces',
      true,
      { visibleOnFullScreen: true }
    ]);
  });

  test('renders are held until the page loaded, then sent with the layout box', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    manager.render(payload());
    expect(windows[0].sent).toEqual([]);
    windows[0].webContents.fire('did-finish-load');
    expect(windows[0].sent[0][0]).toBe('pet:render');
    expect(windows[0].sent[0][1].box).toMatchObject({
      spriteWidth: 144,
      bubble: null
    });
  });

  test('a bubble grows the window and shrinks back', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    windows[0].webContents.fire('did-finish-load');
    const before = { ...windows[0].bounds };
    manager.render(payload({ bubble: 'Lights out!' }));
    expect(windows[0].bounds.height).toBe(before.height + BUBBLE_HEIGHT);
    manager.render(payload());
    expect(windows[0].bounds).toEqual(before);
  });

  test('drag moves within the work area and saves per display + last', () => {
    const { manager, windows, settings } = setup();
    manager.show({ size: 'm' });
    manager.moveBy(10_000, 10_000);
    const rect = manager.spriteRect();
    // Nearest display to the far bottom-right is still clamped on a screen.
    expect(rect.x + rect.width).toBeLessThanOrEqual(1920 + 2560);
    manager.moveBy(-200, -200);
    manager.savePosition();
    const saved = settings().positions;
    expect(saved.last).toEqual({
      x: manager.spriteRect().x,
      y: manager.spriteRect().y
    });
    expect(Object.keys(saved)).toContain('last');
    expect(windows[0].bounds.x).toBe(manager.spriteRect().x);
  });

  test('a removed display moves the pet back to a connected screen', () => {
    const { manager, screen } = setup({
      positions: { last: { x: 3000, y: 300 } }
    });
    manager.show({ size: 'm' });
    expect(manager.spriteRect().x).toBe(3000);
    screen.state.displays = [primary];
    screen.emit('display-removed');
    const rect = manager.spriteRect();
    expect(rect.x + rect.width).toBeLessThanOrEqual(1920);
  });

  test('a size change keeps the bottom-right corner', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    windows[0].webContents.fire('did-finish-load');
    const before = manager.spriteRect();
    manager.render(payload({ size: 'l' }));
    const after = manager.spriteRect();
    expect(after.x + after.width).toBe(before.x + before.width);
    expect(after.y + after.height).toBe(before.y + before.height);
  });

  test('duo: a second pet widens the window to the left and back', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    windows[0].webContents.fire('did-finish-load');
    const solo = { ...windows[0].bounds };
    const first = manager.spriteRect();
    manager.render(payload({ second: { url: 'pet-asset://pet/b', rows: 9 } }));
    const offset = duoOffset(144, true);
    expect(windows[0].bounds).toEqual({
      ...solo,
      x: solo.x - offset,
      width: solo.width + offset
    });
    expect(manager.spriteRect()).toEqual(first);
    expect(manager.groupRect().width).toBe(144 + offset);
    const sent = windows[0].sent.at(-1)[1];
    expect(sent.second).toEqual({ url: 'pet-asset://pet/b', rows: 9 });
    expect(sent.box.second).toEqual({ left: 0, top: 0, side: 'left' });
    expect(manager.secondSide()).toBe('left');
    expect(sent.box.spriteLeft).toBe(offset);
    manager.render(payload({ second: null }));
    expect(windows[0].bounds).toEqual(solo);
    expect(windows[0].sent.at(-1)[1].box.second).toBeNull();
  });

  test('duo at the left screen edge shifts the pair, drags clamp the pair', () => {
    const { manager, windows, settings } = setup({
      positions: { last: { x: 0, y: 400 } }
    });
    manager.show({ size: 'm' });
    windows[0].webContents.fire('did-finish-load');
    manager.render(payload({ second: { url: 'pet-asset://pet/b' } }));
    const offset = duoOffset(144, true);
    expect(manager.spriteRect().x).toBe(offset);
    expect(windows[0].bounds.x).toBe(0);
    expect(manager.secondSide()).toBe('left');
    manager.moveBy(-500, 0);
    expect(manager.spriteRect().x).toBe(offset);
    expect(windows[0].sent.at(-1)[1].box.second.side).toBe('left');
    expect(manager.secondSide()).toBe('left');
    manager.savePosition();
    expect(settings().positions.last).toEqual({ x: offset, y: 400 });
  });

  test("a late 'closed' from the old window keeps the new one", () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    const closed = windows[0].fire.bind(null, 'closed');
    windows[0].destroy = () => {
      windows[0].destroyed = true;
    };
    manager.hide();
    manager.show({ size: 'm' });
    closed();
    expect(manager.window()).toBe(windows[1]);
  });

  test('hide destroys the window', () => {
    const { manager, windows } = setup();
    manager.show({ size: 'm' });
    manager.hide();
    expect(windows[0].destroyed).toBe(true);
    expect(manager.isShown()).toBe(false);
    expect(manager.window()).toBeNull();
  });
});

// --- Round 3 (L4): bubble buttons, click panel, badge ---

const ACTIONS_LIVE = [
  { id: 'ok', label: 'OK' },
  { id: 'quiet-session', label: 'Quiet this session' },
  { id: 'mute', label: 'No result reactions' }
];
const PANEL = {
  lines: [
    'Qualifying in 2 h 14 min · Las Vegas GP',
    'Max Verstappen won the São Paulo GP'
  ],
  actions: [
    { id: 'ask', label: 'Ask F1' },
    { id: 'rate', label: 'Rate São Paulo GP' },
    { id: 'stats', label: 'On this day' },
    { id: 'hot-lap', label: 'Hot lap' },
    { id: 'pets', label: 'Pets' }
  ]
};

describe('round-3 layout estimates', () => {
  test('button widths and greedy rows (flex-wrap)', () => {
    expect(actionWidth('OK')).toBe(2 * 8 + 16);
    expect(actionRows([], 300)).toBe(0);
    expect(actionRows([{ label: 'OK' }], 300)).toBe(1);
    // 3 × 112 px + 2 gaps = 348 > 300 → two rows.
    const wide = Array.from({ length: 3 }, () => ({ label: 'x'.repeat(12) }));
    expect(actionRows(wide, 300)).toBe(2);
    expect(actionRows(wide, 348)).toBe(1);
  });

  test("without buttons the bubble area is today's 240 × 64", () => {
    expect(bubbleArea(null, 144)).toEqual({
      width: BUBBLE_MIN_WIDTH,
      height: BUBBLE_HEIGHT
    });
    expect(bubbleArea([], 400)).toEqual({ width: 400, height: BUBBLE_HEIGHT });
  });

  test('a button row makes the bubble taller and as wide as its one row', () => {
    const area = bubbleArea(ACTIONS_LIVE, 144);
    expect(area.height).toBe(BUBBLE_HEIGHT + ACTION_GAP_PX + ACTION_ROW_PX);
    const row =
      ACTIONS_LIVE.reduce((sum, a) => sum + actionWidth(a.label), 0) +
      2 * ACTION_GAP_PX;
    expect(area.width).toBe(row + 34);
    expect(area.width).toBeLessThanOrEqual(BUBBLE_MAX_WIDTH);
    expect(actionRows(ACTIONS_LIVE, area.width - 34)).toBe(1);
    // Short labels keep the minimum width.
    expect(bubbleArea([{ id: 'ok', label: 'OK' }], 144).width).toBe(
      BUBBLE_MIN_WIDTH
    );
  });

  test('a row wider than BUBBLE_MAX_WIDTH wraps and reserves the rows', () => {
    const many = Array.from({ length: 6 }, () => ({ label: 'x'.repeat(10) }));
    const area = bubbleArea(many, 144);
    expect(area.width).toBe(BUBBLE_MAX_WIDTH);
    const rows = actionRows(many, BUBBLE_MAX_WIDTH - 34);
    expect(rows).toBe(2);
    expect(area.height).toBe(
      BUBBLE_HEIGHT + ACTION_GAP_PX + 2 * ACTION_ROW_PX + ACTION_GAP_PX
    );
  });

  test('panel area: lines (≤ 2 rows each) + wrapped buttons', () => {
    const area = panelArea(PANEL, 144);
    expect(area.width).toBe(PANEL_MIN_WIDTH);
    const inner = PANEL_MIN_WIDTH - 34;
    const rows = actionRows(PANEL.actions, inner);
    expect(rows).toBe(2);
    // 266 px rows at 7.5 px a character: the 39-character countdown is
    // reserved two rows (a little spare room in most fonts), the winner one.
    expect(area.height).toBe(
      30 + 3 * LINE_ROW_PX + 8 + 2 * ACTION_ROW_PX + ACTION_GAP_PX
    );
    // A 60-character line takes two rows, never more.
    const long = panelArea({ lines: ['x'.repeat(60)], actions: [] }, 144);
    expect(long.height).toBe(30 + 2 * LINE_ROW_PX);
    const huge = panelArea({ lines: ['x'.repeat(500)], actions: [] }, 144);
    expect(huge.height).toBe(long.height);
    // A duo at size l is wider than the minimum: the panel follows it.
    expect(panelArea(PANEL, 394).width).toBe(394);
    expect(panelArea({ lines: [], actions: [] }, 144).height).toBe(30);
  });

  test('windowLayout: the panel takes the bubble’s place above the pet, sprite fixed', () => {
    const sprite = { x: 800, y: 600, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: false,
      panel: PANEL,
      workArea: primary.workArea
    });
    const area = panelArea(PANEL, M.width);
    expect(box).toMatchObject({ panel: 'above', bubble: null });
    expect(bounds.height).toBe(M.height + area.height);
    expect(bounds.width).toBe(area.width);
    expect(bounds.y).toBe(600 - area.height);
    expect(bounds.x + box.spriteLeft).toBe(800);
    expect(bounds.y + box.spriteTop).toBe(600);
  });

  test('windowLayout: no room above → the panel goes below; it wins over a bubble', () => {
    const sprite = { x: 800, y: 20, ...M };
    const { bounds, box } = windowLayout({
      sprite,
      bubble: true,
      bubbleActions: ACTIONS_LIVE,
      panel: PANEL,
      workArea: primary.workArea
    });
    expect(box).toMatchObject({ panel: 'below', bubble: null, spriteTop: 0 });
    expect(bounds.y).toBe(20);
    expect(bounds.height).toBe(M.height + panelArea(PANEL, M.width).height);
  });

  test('windowLayout: a bubble with buttons is taller and wider', () => {
    const sprite = { x: 800, y: 600, ...M };
    const plain = windowLayout({
      sprite,
      bubble: true,
      workArea: primary.workArea
    });
    const withButtons = windowLayout({
      sprite,
      bubble: true,
      bubbleActions: ACTIONS_LIVE,
      workArea: primary.workArea
    });
    expect(withButtons.box).toMatchObject({ bubble: 'above', panel: null });
    expect(withButtons.bounds.height - plain.bounds.height).toBe(
      ACTION_GAP_PX + ACTION_ROW_PX
    );
    expect(withButtons.bounds.width).toBe(bubbleArea(ACTIONS_LIVE, 144).width);
    expect(withButtons.bounds.y + withButtons.box.spriteTop).toBe(600);
    // bubbleActions without a bubble change nothing.
    expect(
      windowLayout({
        sprite,
        bubble: false,
        bubbleActions: ACTIONS_LIVE,
        workArea: primary.workArea
      }).bounds
    ).toEqual({ x: 800, y: 600, ...M });
  });
});

describe('createPetWindowManager (round 3)', () => {
  function shown() {
    const ctx = setup();
    ctx.manager.show({ size: 'm' });
    ctx.windows[0].webContents.fire('did-finish-load');
    return ctx;
  }

  test('bubble buttons grow the window; the payload reaches the page with the box', () => {
    const { manager, windows } = shown();
    const before = { ...windows[0].bounds };
    manager.render(
      payload({ bubble: 'P3 for Lando', bubbleActions: ACTIONS_LIVE })
    );
    expect(windows[0].bounds.height).toBe(
      before.height + BUBBLE_HEIGHT + ACTION_GAP_PX + ACTION_ROW_PX
    );
    const [channel, sent] = windows[0].sent.at(-1);
    expect(channel).toBe('pet:render');
    expect(sent.bubbleActions).toEqual(ACTIONS_LIVE);
    expect(sent.box).toMatchObject({ bubble: 'above', panel: null });
    manager.render(payload());
    expect(windows[0].bounds).toEqual(before);
  });

  test('the panel opens above the pet and closes back; the sprite never moves', () => {
    const { manager, windows } = shown();
    const sprite = manager.spriteRect();
    const before = { ...windows[0].bounds };
    manager.render(payload({ panel: PANEL }));
    const sent = windows[0].sent.at(-1)[1];
    expect(sent.box.panel).toBe('above');
    expect(windows[0].bounds.height).toBe(
      before.height + panelArea(PANEL, M.width).height
    );
    expect(windows[0].bounds.y + sent.box.spriteTop).toBe(sprite.y);
    expect(windows[0].bounds.x + sent.box.spriteLeft).toBe(sprite.x);
    manager.render(payload({ panel: null }));
    expect(windows[0].bounds).toEqual(before);
    expect(manager.spriteRect()).toEqual(sprite);
  });

  test('dragging with the panel open re-sends the layout', () => {
    const { manager, windows } = shown();
    manager.render(payload({ panel: PANEL }));
    const count = windows[0].sent.length;
    manager.moveBy(-30, -40);
    expect(windows[0].sent.length).toBe(count + 1);
    expect(windows[0].sent.at(-1)[1].box.panel).toBe('above');
  });

  test('a badge needs no extra space', () => {
    const { manager, windows } = shown();
    const before = { ...windows[0].bounds };
    manager.render(
      payload({ badge: { kind: 'answer', label: 'Answer ready' } })
    );
    expect(windows[0].bounds).toEqual(before);
    expect(windows[0].sent.at(-1)[1].badge).toEqual({
      kind: 'answer',
      label: 'Answer ready'
    });
  });

  test('the Electron pet window draws every round-3 feature', () => {
    const { manager } = setup();
    expect(manager.can('panel')).toBe(true);
    expect(manager.can('badge')).toBe(true);
  });
});
