/**
 * Desktop pets — native pet protocol (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.3).
 *
 * The native renderer (`ti-pet`, built from the TracingInsights/petdex fork)
 * is a separate per-user process that outlives Electron. Electron talks to
 * it over a local socket — a Unix socket `userData/pet.sock` (the native
 * pet creates it, mode 0600) or the Windows named pipe from
 * `nativeSocketPath()` — with JSON lines: one UTF-8 JSON object per line,
 * ≤ MAX_LINE_BYTES, `kind` first. The first line Electron sends is `hello`
 * with the token from `userData/pet-token` (0600); the native pet closes the
 * connection on a wrong token or any invalid line before `hello`.
 *
 * Mirrored by `packages/ti-pet/src/protocol.zig` in the fork — change both
 * together. NATIVE_PROTOCOL_VERSION stays 1: both sides require an equal
 * version at hello / ready, so a bump would turn every skew into "no native
 * pet". New drawing features come behind the pet's `ready.caps` instead
 * (NATIVE_CAPS): `toNativeRender` and the timeline leave out what the pet
 * did not list, and the pet only sends a new event in answer to a field it
 * was sent.
 *
 * Electron → native:
 *   hello    { token, protocol, appVersion }
 *   show     { size: 's'|'m'|'l', duo: boolean, position: { x, y } | null }
 *   hide     {}
 *   render   { payload: NativeRender }          — see toNativeRender()
 *   menu     { tray: MenuItem[], pet: MenuItem[] }
 *   handoff  { timelinePath }                    — Electron is about to exit
 *   quit     {}                                  — exit now (Quit, update install)
 *
 * native → Electron:
 *   ready      { protocol, version, caps: string[], pid }
 *   event      { event: 'drag', dx, dy } | { event: 'dragEnd' | 'click' |
 *              'dblclick' | 'hover' | 'bubbleClick' } |
 *              { event: 'bubbleAction', id } | { event: 'panelAction', id }
 *              (round 3: ids from the payload; `close` = the pet shut the
 *              panel itself)
 *   position   { x, y, displayId: string|null, secondSide: 'left'|'right',
 *              walk?: true }  — `walk`: a walk (motion) ended there; save it
 *              like a drop
 *   menuAction { id, checked?: boolean }
 *   ack        { of: 'handoff' }
 *   error      { code, message }
 *
 * The native pet moves its own window while dragging (no round trip) and
 * reports `event drag` only for the running-left/right animation, then a
 * `position` after every drop and layout change. It shows its own pet menu
 * (the latest `menu.pet`) on right-click, so no contextMenu event exists.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  BUBBLE_ACTION_IDS,
  PANEL_ACTION_IDS,
  PANEL_CLOSE_ID,
  PET_SIZES,
  PET_STATES,
  PET_STATE_IDS
} from './contract.mjs';

export const NATIVE_PROTOCOL_VERSION = 1;
/** The timeline file Electron writes for a pet with the `timeline-v2` cap. */
export const TIMELINE_VERSION = 2;
/** …and for an older pet (ti-pet-v0.1.1 plays only this one). */
export const TIMELINE_VERSION_V1 = 1;
export const NATIVE_STATE_VERSION = 1;

/**
 * Round-3 capabilities a native pet lists in `ready.caps` (protocol.zig
 * `caps`); each gates what Electron may send it. ti-pet-v0.1.1 lists only
 * duo / bubble / menu / timeline.
 */
export const NATIVE_CAPS = Object.freeze({
  /** render `motion` (it walks the window itself, roam.mjs's algorithm) */
  motion: 'motion',
  /** render `sleeping` (the "z z" mark) */
  sleep: 'sleep',
  /** render `bubbleActions` → event `bubbleAction` */
  bubbleActions: 'bubble-actions',
  /** render `panel` → event `panelAction` (pet-renderer `can('panel')`) */
  panel: 'panel',
  /** render `badge` (pet-renderer `can('badge')`) */
  badge: 'badge',
  /** render `secondAnim` */
  secondAnim: 'second-anim',
  /** states look-a / look-b (rows 9–10 of 8×11 sheets) */
  v2Rows: 'v2-rows',
  /** timeline v2 (TIMELINE_VERSION) */
  timelineV2: 'timeline-v2'
});

/** States only a pet with the `v2-rows` cap knows (PET_STATES `minRows`). */
const V2_ROW_STATES = new Set(
  PET_STATES.filter((s) => s.minRows).map((s) => s.id)
);
const IDLE = PET_STATES.find((s) => s.id === 'idle');

/**
 * An animation an older pet can play: a v2 look-around state becomes idle
 * (ti-pet-v0.1.1 rejects the whole render line / timeline on an unknown
 * state). `still` stays.
 * @template {{ state: string, row: number, frames: number, durationMs: number, once?: boolean, playKey?: string }} T
 * @param {T} anim
 * @param {boolean} v2Rows the pet has the `v2-rows` cap
 * @returns {T}
 */
export function nativeAnim(anim, v2Rows) {
  if (v2Rows || !V2_ROW_STATES.has(anim.state)) return anim;
  return {
    ...anim,
    state: IDLE.id,
    row: IDLE.row,
    frames: IDLE.frames,
    durationMs: IDLE.durationMs,
    once: false,
    playKey: 'idle'
  };
}

export const MAX_LINE_BYTES = 64 * 1024;
export const SOCKET_FILE = 'pet.sock';
export const TOKEN_FILE = 'pet-token';
export const TIMELINE_FILE = 'pet-timeline.json';
export const NATIVE_STATE_FILE = 'pet-native-state.json';
/** 32 random bytes, hex. */
export const TOKEN_RE = /^[0-9a-f]{64}$/;
/** Longest Unix socket path we use (sun_path is 104–108 bytes). */
export const MAX_UNIX_SOCKET_PATH = 100;

/** argv modes (main.mjs). */
export const REFRESH_ARG = '--pets-refresh';
export const OPEN_ARG_PREFIX = '--pets-open=';
export const INSTALL_UPDATE_ARG = '--pets-install-update';

/**
 * The app path from `--pets-open=<path>` (the native pet's Open / Choose
 * pet… / bubble clicks), or null. Only same-origin paths: "/…", never
 * "//host", backslashes or control characters.
 * @param {readonly string[]} argv
 */
export function parsePetsOpenArg(argv) {
  let value = null;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(OPEN_ARG_PREFIX)) {
      value = arg.slice(OPEN_ARG_PREFIX.length);
    }
  }
  if (
    value === null ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

export const TO_NATIVE_KINDS = Object.freeze([
  'hello',
  'show',
  'hide',
  'render',
  'menu',
  'handoff',
  'quit'
]);
export const FROM_NATIVE_KINDS = Object.freeze([
  'ready',
  'event',
  'position',
  'menuAction',
  'ack',
  'error'
]);
/** `event` names, as the controller's petEvent kinds. */
export const NATIVE_EVENTS = Object.freeze([
  'drag',
  'dragEnd',
  'click',
  'dblclick',
  'hover',
  'bubbleClick',
  // round 3 (with an `id`)
  'bubbleAction',
  'panelAction'
]);
/** The ids each id-carrying event accepts (as ipc.mjs for the pet window). */
const EVENT_IDS = Object.freeze({
  bubbleAction: BUBBLE_ACTION_IDS,
  panelAction: [...PANEL_ACTION_IDS, PANEL_CLOSE_ID]
});

const MAX_DELTA = 10_000;
const MAX_COORD = 1e6;
const MENU_ID_RE = /^[a-z0-9.-]{1,64}$/;
const MAX_TEXT_CHARS = 200;

/**
 * Where the socket lives. Unix: `userData/pet.sock`, or a per-profile path in
 * the temp dir when that would exceed sun_path. Windows: a named pipe keyed
 * by a hash of the userData path (one pet per profile).
 * @param {{ platform: string, userDataDir: string, tmpDir: string }} input
 */
export function nativeSocketPath({ platform, userDataDir, tmpDir }) {
  const hash = createHash('sha256')
    .update(userDataDir)
    .digest('hex')
    .slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\tracinginsights-pet-${hash}`;
  const inside = join(userDataDir, SOCKET_FILE);
  return Buffer.byteLength(inside) <= MAX_UNIX_SOCKET_PATH
    ? inside
    : join(tmpDir, `tracinginsights-pet-${hash}.sock`);
}

/** The bundled binary's file name for this platform/arch. */
export function nativeBinaryName(platform, arch) {
  if (platform === 'win32') return `ti-pet-win32-${arch}.exe`;
  return `ti-pet-${platform}-${arch}`;
}

/**
 * One message → one line. Throws on an unknown kind or an oversized line.
 * @param {{ kind: string } & Record<string, unknown>} message
 */
export function encodeLine(message) {
  if (!TO_NATIVE_KINDS.includes(message?.kind)) {
    throw new Error(`Unknown native message kind: ${message?.kind}`);
  }
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    throw new Error('Native message too large.');
  }
  return line;
}

/**
 * Splits a byte stream into lines. A line over MAX_LINE_BYTES (or invalid
 * UTF-8 JSON) makes `push` return `{ error }`: the caller drops the
 * connection — the peer is broken or hostile.
 */
export function createLineDecoder() {
  let buffer = '';
  return {
    /**
     * @param {Buffer|string} chunk
     * @returns {{ messages: object[], error: string|null }}
     */
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const messages = [];
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          return { messages, error: 'line-too-long' };
        }
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return { messages, error: 'bad-json' };
        }
        const message = validateFromNative(parsed);
        if (!message) return { messages, error: 'bad-message' };
        messages.push(message);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        return { messages, error: 'line-too-long' };
      }
      return { messages, error: null };
    }
  };
}

const isObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteIn = (v, max) =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const shortText = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT_CHARS;

/**
 * A native → Electron message, normalised (only known fields kept), or null.
 * @param {unknown} raw
 */
export function validateFromNative(raw) {
  if (!isObject(raw) || !FROM_NATIVE_KINDS.includes(raw.kind)) return null;
  switch (raw.kind) {
    case 'ready': {
      if (!Number.isSafeInteger(raw.protocol)) return null;
      const caps = Array.isArray(raw.caps)
        ? raw.caps.filter(shortText).slice(0, 32)
        : [];
      return {
        kind: 'ready',
        protocol: raw.protocol,
        version: shortText(raw.version) ? raw.version : '',
        caps,
        pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
      };
    }
    case 'event': {
      if (!NATIVE_EVENTS.includes(raw.event)) return null;
      if (Object.hasOwn(EVENT_IDS, raw.event)) {
        return EVENT_IDS[raw.event].includes(raw.id)
          ? { kind: 'event', event: raw.event, id: raw.id }
          : null;
      }
      if (raw.event !== 'drag') return { kind: 'event', event: raw.event };
      if (!finiteIn(raw.dx, MAX_DELTA) || !finiteIn(raw.dy, MAX_DELTA))
        return null;
      return { kind: 'event', event: 'drag', dx: raw.dx, dy: raw.dy };
    }
    case 'position': {
      if (!finiteIn(raw.x, MAX_COORD) || !finiteIn(raw.y, MAX_COORD))
        return null;
      return {
        kind: 'position',
        x: Math.round(raw.x),
        y: Math.round(raw.y),
        displayId:
          typeof raw.displayId === 'string' && raw.displayId.length <= 64
            ? raw.displayId
            : null,
        secondSide: raw.secondSide === 'right' ? 'right' : 'left',
        ...(raw.walk === true ? { walk: true } : {})
      };
    }
    case 'menuAction': {
      if (typeof raw.id !== 'string' || !MENU_ID_RE.test(raw.id)) return null;
      return typeof raw.checked === 'boolean'
        ? { kind: 'menuAction', id: raw.id, checked: raw.checked }
        : { kind: 'menuAction', id: raw.id };
    }
    case 'ack':
      return raw.of === 'handoff' ? { kind: 'ack', of: 'handoff' } : null;
    case 'error':
      return {
        kind: 'error',
        code: shortText(raw.code) ? raw.code : 'unknown',
        message: shortText(raw.message) ? raw.message : ''
      };
    default:
      return null;
  }
}

/**
 * @typedef {{ path: string, rows: number, scale: number }} NativeSprite
 * @typedef {{ id: string, label: string }} NativeAction
 * @typedef {{
 *   state: string, row: number, frames: number, durationMs: number,
 *   once: boolean, still: boolean, playKey: string, delayMs: number
 * }} NativeAnim
 * @typedef {{
 *   state: string, row: number, frames: number, durationMs: number,
 *   once: boolean, still: boolean, playKey: string,
 *   bubble: string|null, size: 's'|'m'|'l',
 *   atlas: NativeSprite, second: NativeSprite|null,
 *   motion?: 'roam'|'dash'|null, sleeping?: boolean,
 *   bubbleActions?: NativeAction[]|null,
 *   panel?: { lines: string[], actions: NativeAction[] }|null,
 *   badge?: { kind: 'answer', label: string }|null,
 *   secondAnim?: NativeAnim|null
 * }} NativeRender
 */

/** The pet's `ready.caps` as a set (null / junk → none, i.e. v0.1.1). @param {unknown} caps */
export const capSet = (caps) =>
  new Set(Array.isArray(caps) ? caps.filter((c) => typeof c === 'string') : []);

/** `[{ id, label }]` with string fields, at most `max`, or null. */
function nativeActions(value, max) {
  if (!Array.isArray(value)) return null;
  const actions = value
    .filter((a) => isObject(a) && typeof a.id === 'string')
    .slice(0, max)
    .map((a) => ({ id: a.id, label: String(a.label ?? '') }));
  return actions.length > 0 ? actions : null;
}

/** The controller's `secondAnim`, played by the native pet, or null. */
function nativeSecondAnim(value, v2Rows) {
  if (!isObject(value) || !PET_STATE_IDS.includes(value.state)) return null;
  return nativeAnim(
    {
      state: value.state,
      row: value.row,
      frames: value.frames,
      durationMs: value.durationMs,
      once: Boolean(value.once),
      still: Boolean(value.still),
      playKey: String(value.playKey ?? ''),
      delayMs: Number.isFinite(value.delayMs) ? Math.max(0, value.delayMs) : 0
    },
    v2Rows
  );
}

/**
 * The controller's render payload → the native shape: sprite URLs
 * (`pet-asset://…`) become absolute file paths from the pet store; the
 * native pet never browses directories. Null when a sprite cannot be
 * resolved (the pet was removed under us).
 *
 * `caps` = the pet's `ready.caps`: each round-3 field goes only to a pet
 * that lists its cap (NATIVE_CAPS), and without `v2-rows` a look-around
 * state is sent as idle. No caps = what ti-pet-v0.1.1 understands.
 * @param {object} payload controller payload
 * @param {(url: string) => string|null} resolvePath pet-asset URL → file path
 * @param {readonly string[]|null} [caps]
 * @returns {NativeRender|null}
 */
export function toNativeRender(payload, resolvePath, caps = null) {
  if (!isObject(payload) || !PET_STATE_IDS.includes(payload.state)) return null;
  const has = capSet(caps);
  const sprite = (atlas) => {
    if (!isObject(atlas)) return null;
    const path = resolvePath(atlas.url);
    return path ? { path, rows: atlas.rows, scale: atlas.scale } : null;
  };
  const atlas = sprite(payload.atlas);
  if (!atlas) return null;
  const v2Rows = has.has(NATIVE_CAPS.v2Rows);
  const anim = nativeAnim(
    {
      state: payload.state,
      row: payload.row,
      frames: payload.frames,
      durationMs: payload.durationMs,
      once: Boolean(payload.once),
      still: Boolean(payload.still),
      playKey: String(payload.playKey ?? '')
    },
    v2Rows
  );
  const second = payload.second ? sprite(payload.second) : null;
  /** @type {NativeRender} */
  const out = {
    ...anim,
    bubble: typeof payload.bubble === 'string' ? payload.bubble : null,
    size: Object.hasOwn(PET_SIZES, payload.size) ? payload.size : 'm',
    atlas,
    second
  };
  if (has.has(NATIVE_CAPS.motion)) {
    out.motion =
      payload.motion === 'roam' || payload.motion === 'dash'
        ? payload.motion
        : null;
  }
  if (has.has(NATIVE_CAPS.sleep)) out.sleeping = Boolean(payload.sleeping);
  if (has.has(NATIVE_CAPS.bubbleActions)) {
    out.bubbleActions = out.bubble
      ? nativeActions(payload.bubbleActions, 3)
      : null;
  }
  if (has.has(NATIVE_CAPS.panel)) {
    const panel = payload.panel;
    out.panel = isObject(panel)
      ? {
          lines: Array.isArray(panel.lines)
            ? panel.lines.filter((l) => typeof l === 'string' && l).slice(0, 3)
            : [],
          actions: nativeActions(panel.actions, 6) ?? []
        }
      : null;
  }
  if (has.has(NATIVE_CAPS.badge)) {
    const badge = payload.badge;
    out.badge =
      isObject(badge) && badge.kind === 'answer'
        ? { kind: 'answer', label: String(badge.label ?? '') }
        : null;
  }
  if (has.has(NATIVE_CAPS.secondAnim)) {
    out.secondAnim = second
      ? nativeSecondAnim(payload.secondAnim, v2Rows)
      : null;
  }
  return out;
}

/**
 * @typedef {{
 *   id: string, label: string,
 *   type?: 'normal'|'checkbox'|'radio'|'separator',
 *   checked?: boolean, enabled?: boolean,
 *   submenu?: MenuItem[],
 *   offline?: { do: string, path?: string, kind?: string, size?: string }
 * }} MenuItem
 *
 * `offline` (tray.mjs) = what the native pet does with the item while no
 * Electron is connected; with Electron connected it only sends `menuAction`.
 */

/**
 * An Electron menu template (tray.mjs builders) → serialisable items with
 * stable ids + an id → click map. Ids are the label path, slugged
 * ("tray.quiet.for-1-hour"), so they survive rebuilds.
 * @param {readonly any[]} template
 * @param {string} [prefix] e.g. 'tray' / 'pet' (keeps the two menus apart)
 * @returns {{ items: MenuItem[], handlers: Map<string, (item: { checked?: boolean }) => void> }}
 */
export function menuFromTemplate(template, prefix = '') {
  const handlers = new Map();
  const slug = (label) =>
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'item';
  let separators = 0;
  const walk = (entries, prefix) =>
    entries.map((entry) => {
      if (entry.type === 'separator') {
        separators += 1;
        const sep = `sep-${separators}`;
        return {
          id: prefix ? `${prefix}.${sep}` : sep,
          label: '',
          type: 'separator'
        };
      }
      let id = prefix ? `${prefix}.${slug(entry.label)}` : slug(entry.label);
      while (handlers.has(id)) id = `${id}-x`.slice(-64);
      id = id.slice(0, 64);
      /** @type {MenuItem} */
      const item = { id, label: String(entry.label) };
      if (entry.type === 'checkbox' || entry.type === 'radio') {
        item.type = entry.type;
        item.checked = Boolean(entry.checked);
      }
      if (entry.enabled === false) item.enabled = false;
      if (isObject(entry.offline) && typeof entry.offline.do === 'string') {
        item.offline = { ...entry.offline };
      }
      if (Array.isArray(entry.submenu)) {
        item.submenu = walk(entry.submenu, id);
      } else if (typeof entry.click === 'function') {
        handlers.set(id, entry.click);
      }
      return item;
    });
  return { items: walk(template, prefix), handlers };
}
