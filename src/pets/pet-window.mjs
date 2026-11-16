/**
 * Desktop pets — the pet window (docs/DESKTOP_PETS_PLAN.md §4.4).
 *
 * A transparent, frameless, always-on-top, non-resizable window that only
 * ever loads the bundled `app://pet/index.html` on the pet session. Its
 * bounds are the sprite box; while a bubble shows it grows upward (or
 * downward when there is no room above) and shrinks back afterwards, so no
 * click-through is needed (Linux has none).
 *
 * Position = the sprite's top-left in screen DIP, saved per display
 * (`positions[<displayId>]`) plus `positions.last` (the display it was on
 * last); clamped into the work area on show, drag and display changes.
 *
 * Duo (plan §12 #8): a render payload with `second` adds a second sprite
 * to the LEFT of the first, so the window grows leftward and the first pet
 * stays where it was. Saved positions stay the first sprite's top-left;
 * clamping applies to the pair (it shifts both sprites, never swaps them).
 * `duoSecondSide` reads the side off this geometry; the duo head-to-head
 * bubble orders its names by it, so the text matches the sprites.
 *
 * Roaming (round 3, 2a): while a payload's `motion` is set, `createPetWalker`
 * (roam.mjs) walks the pair along the work area on its own timer and swaps
 * the row for running-left/right (both sprites: `secondAnim` is dropped);
 * drags, display changes and resizes stop the walk (saved like a drop). No
 * walking timers while `motion` is null.
 */
import {
  PET_SIZES,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH
} from './contract.mjs';
import { createPetWalker, sizeScale, walkRange } from './roam.mjs';

export const SCREEN_MARGIN = 24;
export const BUBBLE_HEIGHT = 64;
export const BUBBLE_MIN_WIDTH = 240;
export const LAST_POSITION_KEY = 'last';
/** Gap between the duo's sprites, as a share of the sprite width. */
export const DUO_GAP_RATIO = 0.05;

/** Sprite box for a size preset. @param {string} size */
export function spriteSize(size) {
  const scale = PET_SIZES[size] ?? PET_SIZES.m;
  return {
    width: Math.round(SPRITE_FRAME_WIDTH * scale),
    height: Math.round(SPRITE_FRAME_HEIGHT * scale)
  };
}

/**
 * Clamp a rect's top-left so the rect lies inside `area` (when it fits).
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {{ x: number, y: number, width: number, height: number }} area
 */
export function clampRect(rect, area) {
  const maxX = area.x + Math.max(0, area.width - rect.width);
  const maxY = area.y + Math.max(0, area.height - rect.height);
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), maxY))
  };
}

/** Bottom-right of a work area with the default margin. */
export function defaultSpritePosition(workArea, sprite) {
  return {
    x: workArea.x + workArea.width - sprite.width - SCREEN_MARGIN,
    y: workArea.y + workArea.height - sprite.height - SCREEN_MARGIN
  };
}

/** How far the pair reaches left of the first sprite (0 without a duo). @param {number} spriteWidth */
export function duoOffset(spriteWidth, duo) {
  return duo ? spriteWidth + Math.round(spriteWidth * DUO_GAP_RATIO) : 0;
}

/**
 * The rect both sprites cover (the first sprite plus, for a duo, the second
 * one to its left).
 * @param {{ x: number, y: number, width: number, height: number }} sprite first sprite
 * @param {boolean} duo
 */
export function groupRect(sprite, duo) {
  const offset = duoOffset(sprite.width, duo);
  return {
    x: sprite.x - offset,
    y: sprite.y,
    width: sprite.width + offset,
    height: sprite.height
  };
}

/**
 * Which side of the first sprite the duo's second sprite is drawn on, read
 * from the layout geometry (the one place that decides it).
 * @param {{ x: number, y: number, width: number, height: number }} sprite first sprite
 * @returns {'left'|'right'}
 */
export function duoSecondSide(sprite) {
  return groupRect(sprite, true).x < sprite.x ? 'left' : 'right';
}

/** Clamp the pair into `area`; returns the first sprite's rect. */
export function clampSprite(sprite, duo, area) {
  const offset = duoOffset(sprite.width, duo);
  const group = clampRect(groupRect(sprite, duo), area);
  return { ...sprite, x: group.x + offset, y: group.y };
}

const contains = (area, point) =>
  point.x >= area.x &&
  point.y >= area.y &&
  point.x < area.x + area.width &&
  point.y < area.y + area.height;

/**
 * Where the sprite goes when the window (re)appears.
 * @param {{
 *   displays: { id: number|string, workArea: { x: number, y: number, width: number, height: number } }[],
 *   primary: { id: number|string, workArea: { x: number, y: number, width: number, height: number } },
 *   positions: Record<string, { x: number, y: number }>,
 *   sprite: { width: number, height: number },
 *   duo?: boolean
 * }} input
 * @returns {{ x: number, y: number, displayId: string }} the first sprite's top-left
 */
export function initialSpritePosition({
  displays,
  primary,
  positions,
  sprite,
  duo = false
}) {
  const centre = (p) => ({
    x: p.x + sprite.width / 2,
    y: p.y + sprite.height / 2
  });
  const place = (p, display) => {
    const r = clampSprite({ ...p, ...sprite }, duo, display.workArea);
    return { x: r.x, y: r.y, displayId: String(display.id) };
  };
  const last = positions[LAST_POSITION_KEY];
  if (last) {
    const display = displays.find((d) => contains(d.workArea, centre(last)));
    if (display) return place(last, display);
  }
  for (const display of [primary, ...displays]) {
    const saved = positions[String(display.id)];
    if (saved) return place(saved, display);
  }
  return place(defaultSpritePosition(primary.workArea, sprite), primary);
}

// --- Bubble buttons + click panel (round 3, 2e / 3a) ---
// Sizes estimated from the payload with the 12 px metrics in pet.css. The
// per-character widths are generous (common UI fonts run 6–7 px, DejaVu Sans
// Bold ~7.6 px), so a row the estimate fits should not wrap: the usual cost
// is a little transparent space beside the bubble / panel.

/** Widest a bubble with buttons grows to. */
export const BUBBLE_MAX_WIDTH = 440;
export const PANEL_MIN_WIDTH = 300;
/** Button: text + padding 7 px + border 1 px each side; rows 24 px apart by 6. */
export const ACTION_CHAR_PX = 8;
export const ACTION_CHROME_PX = 16;
export const ACTION_GAP_PX = 6;
export const ACTION_ROW_PX = 24;
/** Panel lines: 12 px / 16 px rows, at most two rows each. */
export const LINE_CHAR_PX = 7.5;
export const LINE_ROW_PX = 16;
export const LINE_MAX_ROWS = 2;
/** Bubble / panel chrome per side: window margin 4 + padding 12 + border 1. */
const CARD_SIDE_PX = 17;
/** Panel chrome above + below its content: margin 4 + border 1 + padding 10, twice. */
const PANEL_VERTICAL_PX = 30;
/** Between the panel's lines and its buttons. */
const PANEL_SECTION_GAP_PX = 8;

/** Estimated width of one button. @param {string} label */
export function actionWidth(label) {
  return Math.ceil(String(label).length * ACTION_CHAR_PX) + ACTION_CHROME_PX;
}

/**
 * Rows a list of buttons wraps into within `width` content px (greedy, the
 * way flex-wrap fills rows).
 * @param {readonly { label: string }[]} actions @param {number} width
 */
export function actionRows(actions, width) {
  let rows = 0;
  let used = 0;
  for (const action of actions) {
    const w = actionWidth(action.label);
    if (rows === 0 || used + ACTION_GAP_PX + w > width) {
      rows += 1;
      used = w;
    } else {
      used += ACTION_GAP_PX + w;
    }
  }
  return rows;
}

/** Height of `rows` button rows. @param {number} rows */
const actionRowsHeight = (rows) =>
  rows > 0 ? rows * ACTION_ROW_PX + (rows - 1) * ACTION_GAP_PX : 0;

/**
 * Area the bubble takes above / below the sprites: today's 240 × 64 without
 * buttons; with buttons as wide as their row needs (≤ BUBBLE_MAX_WIDTH) and
 * taller by the row(s) plus a 6 px gap.
 * @param {readonly { label: string }[]|null} actions @param {number} minWidth
 */
export function bubbleArea(actions, minWidth) {
  if (!actions || actions.length === 0) {
    return {
      width: Math.max(minWidth, BUBBLE_MIN_WIDTH),
      height: BUBBLE_HEIGHT
    };
  }
  const row =
    actions.reduce((sum, action) => sum + actionWidth(action.label), 0) +
    (actions.length - 1) * ACTION_GAP_PX;
  const width = Math.max(
    minWidth,
    BUBBLE_MIN_WIDTH,
    Math.min(BUBBLE_MAX_WIDTH, row + 2 * CARD_SIDE_PX)
  );
  const rows = actionRows(actions, width - 2 * CARD_SIDE_PX);
  return {
    width,
    height: BUBBLE_HEIGHT + ACTION_GAP_PX + actionRowsHeight(rows)
  };
}

/**
 * Area the click panel takes above / below the sprites.
 * @param {{ lines?: readonly string[], actions?: readonly { label: string }[] }} panel
 * @param {number} minWidth
 */
export function panelArea(panel, minWidth) {
  const width = Math.max(minWidth, PANEL_MIN_WIDTH);
  const inner = width - 2 * CARD_SIDE_PX;
  const lines = Array.isArray(panel?.lines) ? panel.lines : [];
  const actions = Array.isArray(panel?.actions) ? panel.actions : [];
  const lineRows = lines.reduce(
    (sum, line) =>
      sum +
      Math.min(
        LINE_MAX_ROWS,
        Math.max(1, Math.ceil((String(line).length * LINE_CHAR_PX) / inner))
      ),
    0
  );
  const rows = actionRows(actions, inner);
  const gap = lineRows > 0 && rows > 0 ? PANEL_SECTION_GAP_PX : 0;
  return {
    width,
    height:
      PANEL_VERTICAL_PX + lineRows * LINE_ROW_PX + gap + actionRowsHeight(rows)
  };
}

/**
 * Window bounds + where the sprite(s) and bubble sit inside it. `box.second`
 * is the duo's second sprite (same size, `side` of the first) or null. A
 * bubble with buttons (`bubbleActions`) is taller; the click panel (`panel`,
 * shown instead of the bubble) takes its own area on the same side rules
 * (`box.panel`).
 * @param {{
 *   sprite: { x: number, y: number, width: number, height: number },
 *   bubble: boolean,
 *   workArea: { x: number, y: number, width: number, height: number },
 *   duo?: boolean,
 *   bubbleActions?: readonly { label: string }[]|null,
 *   panel?: { lines?: readonly string[], actions?: readonly { label: string }[] }|null
 * }} input
 */
export function windowLayout({
  sprite,
  bubble,
  workArea,
  duo = false,
  bubbleActions = null,
  panel = null
}) {
  const group = groupRect(sprite, duo);
  const boxFor = (bounds, bubbleSide, panelSide = null) => ({
    width: bounds.width,
    height: bounds.height,
    spriteLeft: sprite.x - bounds.x,
    spriteTop: sprite.y - bounds.y,
    spriteWidth: sprite.width,
    spriteHeight: sprite.height,
    bubble: bubbleSide,
    panel: panelSide,
    second: duo
      ? {
          left: group.x - bounds.x,
          top: sprite.y - bounds.y,
          side: duoSecondSide(sprite)
        }
      : null
  });
  const area = panel
    ? panelArea(panel, group.width)
    : bubble
      ? bubbleArea(bubbleActions, group.width)
      : null;
  if (!area) {
    const bounds = { ...group };
    return { bounds, box: boxFor(bounds, null) };
  }
  const width = area.width;
  const height = group.height + area.height;
  const above = group.y - area.height >= workArea.y;
  const wanted = {
    x: Math.round(group.x + group.width / 2 - width / 2),
    y: above ? group.y - area.height : group.y,
    width,
    height
  };
  const bounds = clampRect(wanted, workArea);
  const side = above ? 'above' : 'below';
  return {
    bounds,
    box: panel ? boxFor(bounds, null, side) : boxFor(bounds, side)
  };
}

/**
 * @param {{
 *   createWindow: (options: object) => any,
 *   screen: {
 *     getAllDisplays: () => any[], getPrimaryDisplay: () => any,
 *     getDisplayMatching: (rect: object) => any, getDisplayNearestPoint: (point: object) => any,
 *     on: (event: string, listener: () => void) => void
 *   },
 *   settings: { get: () => { positions: Record<string, { x: number, y: number }> }, update: (patch: object, options: object) => unknown },
 *   pageUrl: string,
 *   preloadPath: string,
 *   petSession: unknown,
 *   platform: string,
 *   devTools?: boolean,
 *   renderChannel: string,
 *   onShown?: () => void,
 *   onClosed?: () => void,
 *   now?: () => number,
 *   random?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (id: any) => void
 * }} deps  `now` / `random` / timers drive roaming (injected in tests).
 */
export function createPetWindowManager(deps) {
  const {
    createWindow,
    screen,
    settings,
    pageUrl,
    preloadPath,
    petSession,
    platform,
    devTools = false,
    renderChannel,
    onShown = () => {},
    onClosed = () => {},
    now = Date.now,
    random = Math.random,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout
  } = deps;

  let win = null;
  let pageReady = false;
  /** Sprite rect in screen DIP. */
  let sprite = null;
  let size = 'm';
  let bubbleShown = false;
  /** Buttons under the bubble (payload.bubbleActions), or null. */
  let bubbleActions = null;
  /** The click panel (payload.panel), or null. */
  let panel = null;
  /** Duo: a second sprite beside the first (payload.second). */
  let duo = false;
  /** @type {object|null} */
  let lastPayload = null;
  let lastBoundsJson = '';

  const live = () => win && !win.isDestroyed();

  function workAreaFor(rect) {
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return screen.getDisplayNearestPoint(centre).workArea;
  }

  /** Keep the pair on the display the first sprite is on. */
  const clampHere = (rect) => clampSprite(rect, duo, workAreaFor(rect));

  function layout() {
    return windowLayout({
      sprite,
      bubble: bubbleShown,
      workArea: workAreaFor(sprite),
      duo,
      bubbleActions,
      panel
    });
  }

  function applyBounds() {
    if (!live() || !sprite) return null;
    const next = layout();
    const json = JSON.stringify(next.bounds);
    if (json !== lastBoundsJson) {
      lastBoundsJson = json;
      win.setBounds(next.bounds, false);
    }
    return next;
  }

  function send() {
    if (!live() || !pageReady || !lastPayload) return;
    const next = applyBounds();
    win.webContents.send(renderChannel, {
      ...lastPayload,
      ...walker.pose(),
      box: next?.box ?? null
    });
  }

  function placeSprite() {
    const box = spriteSize(size);
    const start = initialSpritePosition({
      displays: screen.getAllDisplays(),
      primary: screen.getPrimaryDisplay(),
      positions: settings.get().positions ?? {},
      sprite: box,
      duo
    });
    sprite = { x: start.x, y: start.y, ...box };
  }

  /** Displays changed: keep the sprite on a connected screen. */
  function reclamp() {
    if (!live() || !sprite) return;
    const centre = {
      x: sprite.x + sprite.width / 2,
      y: sprite.y + sprite.height / 2
    };
    const onScreen = screen
      .getAllDisplays()
      .some((d) => contains(d.workArea, centre));
    if (!onScreen) placeSprite();
    else sprite = clampHere(sprite);
    walker.interrupt();
    send();
  }
  for (const event of [
    'display-added',
    'display-removed',
    'display-metrics-changed'
  ]) {
    screen.on(event, reclamp);
  }

  // --- Roaming (round 3, 2a) ---
  const walker = createPetWalker({
    now,
    random,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    position: () =>
      live() && sprite
        ? {
            x: sprite.x,
            scale: sizeScale(size),
            range: walkRange(
              sprite,
              duoOffset(sprite.width, duo),
              workAreaFor(sprite)
            )
          }
        : null,
    moveTo: (x) => {
      if (!live() || !sprite || x === sprite.x) return;
      sprite = clampHere({ ...sprite, x });
      applyBounds();
      if (bubbleShown || panel) send();
    },
    save: () => manager.savePosition(),
    repaint: send
  });

  const manager = {
    isShown: () => Boolean(live()),
    /** The BrowserWindow (for sender checks and the context menu). */
    window: () => (live() ? win : null),

    /** @param {{ size: string, duo?: boolean }} options */
    show(options) {
      if (live()) return;
      walker.stop();
      size = Object.hasOwn(PET_SIZES, options?.size) ? options.size : 'm';
      bubbleShown = false;
      bubbleActions = null;
      panel = null;
      duo = Boolean(options?.duo);
      pageReady = false;
      lastBoundsJson = '';
      placeSprite();
      const { bounds } = layout();
      win = createWindow({
        ...bounds,
        show: false,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        // Does not steal focus from the app the user is in (Windows/macOS).
        // Linux keeps it focusable: GNOME's Mutter refuses always-on-top for
        // a non-focusable X11 window (measured 2026-11-06, Ubuntu GNOME via
        // XWayland); showInactive() still avoids taking focus on show.
        focusable: platform === 'linux',
        title: 'TracingInsights pet',
        webPreferences: {
          preload: preloadPath,
          session: petSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          devTools
        }
      });
      lastBoundsJson = JSON.stringify(bounds);
      win.setAlwaysOnTop(true, 'floating');
      if (platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.webContents.on('did-finish-load', () => {
        pageReady = true;
        send();
      });
      win.once('ready-to-show', () => {
        if (!live()) return;
        win.showInactive();
        // X11 (incl. XWayland) only takes _NET_WM_STATE_ABOVE on a mapped
        // window: the pre-show call above is dropped there.
        win.setAlwaysOnTop(true, 'floating');
      });
      const window = win;
      window.on('closed', () => {
        // A late `closed` from a destroyed window must not drop its successor.
        if (win === window) {
          win = null;
          pageReady = false;
        }
        onClosed();
      });
      win.loadURL(pageUrl);
      onShown();
    },

    hide() {
      walker.stop();
      if (live()) win.destroy();
      win = null;
      pageReady = false;
    },

    /** @param {object & { size: string, bubble: string|null, second?: object|null, bubbleActions?: object[]|null, panel?: object|null }} payload */
    render(payload) {
      lastPayload = payload;
      const nextSize = Object.hasOwn(PET_SIZES, payload.size)
        ? payload.size
        : size;
      const nextDuo = Boolean(payload.second);
      const resized = nextSize !== size;
      if (sprite && resized) {
        // Grow/shrink around the sprite's bottom-right corner (the default anchor).
        const box = spriteSize(nextSize);
        sprite = {
          x: sprite.x + sprite.width - box.width,
          y: sprite.y + sprite.height - box.height,
          ...box
        };
      }
      size = nextSize;
      const duoChanged = nextDuo !== duo;
      duo = nextDuo;
      // The second sprite joins on the left; clamping may shift the pair.
      if (sprite && (resized || duoChanged)) sprite = clampHere(sprite);
      bubbleShown = Boolean(payload.bubble);
      bubbleActions =
        bubbleShown &&
        Array.isArray(payload.bubbleActions) &&
        payload.bubbleActions.length > 0
          ? payload.bubbleActions
          : null;
      panel =
        payload.panel && typeof payload.panel === 'object'
          ? payload.panel
          : null;
      if (resized || duoChanged) walker.interrupt();
      walker.setMotion(payload.motion ?? null);
      send();
    },

    moveBy(dx, dy) {
      if (!live() || !sprite) return;
      // A drag never walks: stop (the drop saves again).
      walker.interrupt();
      const moved = { ...sprite, x: sprite.x + dx, y: sprite.y + dy };
      sprite = clampHere(moved);
      applyBounds();
      if (bubbleShown || panel) send();
    },

    /** Persist the drop point for its display and as the last position. */
    savePosition() {
      if (!sprite) return;
      const display = screen.getDisplayMatching(sprite);
      const point = { x: sprite.x, y: sprite.y };
      const positions = { ...(settings.get().positions ?? {}) };
      if (display) positions[String(display.id)] = point;
      positions[LAST_POSITION_KEY] = point;
      settings.update({ positions }, { trusted: true });
    },

    /** First sprite's rect (tests / diagnostics, the ask window's anchor). */
    spriteRect: () => (sprite ? { ...sprite } : null),
    /**
     * Side the duo's second sprite is (or would be) drawn on, for the
     * head-to-head bubble's left → right name order.
     * @returns {'left'|'right'}
     */
    secondSide: () =>
      duoSecondSide(sprite ?? { x: 0, y: 0, ...spriteSize(size) }),
    /** Both sprites' rect in screen DIP, or null while hidden. */
    groupRect: () => (sprite && live() ? groupRect(sprite, duo) : null),
    /** Roaming state (tests / diagnostics). */
    motionState: () => walker.state(),
    /** The bundled pet page draws every round-3 feature (panel, badge). */
    can: () => true
  };
  return manager;
}
