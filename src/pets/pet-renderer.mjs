/**
 * Desktop pets — renderer choice (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.1, N3).
 *
 * The controller drives one `petWindow`; this module is that object. It
 * forwards to the native pet (native-pet.mjs) when the bundled binary starts,
 * else to the Electron pet window (pet-window.mjs) — the automatic fallback.
 * With no bundled binary the choice is made synchronously at creation, so
 * builds without `ti-pet` behave exactly as before.
 *
 * While the native pet is starting (`pending`), show / hide / render are
 * recorded and replayed on whichever renderer wins; a later native failure
 * (crash loop) switches to the Electron window the same way.
 *
 * `kind()` / `reason()` feed `pets.status()` (`renderer`, `rendererReason`):
 *   'not-bundled' · 'disabled' (TIF1AI_PETS_RENDERER=electron) ·
 *   'spawn-failed' · 'connect-timeout' · 'token-failed' · 'crash-loop' ·
 *   'handoff-failed' · 'pipe-untrusted' (Windows: the pipe is not our pet's).
 */
import { join } from 'node:path';

/**
 * @typedef {{
 *   show: (options: { size: string, duo?: boolean }) => void,
 *   hide: () => void,
 *   isShown: () => boolean,
 *   render: (payload: object) => void,
 *   moveBy: (dx: number, dy: number) => void,
 *   savePosition: () => void,
 *   secondSide?: () => 'left'|'right',
 *   groupRect?: () => object|null,
 *   window?: () => any
 * }} PetWindowLike
 */

/**
 * @param {{
 *   native: (PetWindowLike & {
 *     available: () => boolean,
 *     start: (options?: { allowSpawn?: boolean }) => Promise<{ ok: boolean, reason: string|null }>
 *   }) | null,
 *   electronWindow: PetWindowLike,
 *   forceElectron?: boolean,
 *   onChange?: (kind: 'pending'|'native'|'electron', reason: string|null) => void
 * }} deps
 */
export function createPetRenderer(deps) {
  const { native, electronWindow, forceElectron = false } = deps;
  const onChange = deps.onChange ?? (() => {});

  /** @type {'pending'|'native'|'electron'} */
  let kind = 'pending';
  /** @type {string|null} */
  let reason = null;
  /** @type {PetWindowLike|null} */
  let impl = null;

  let shown = false;
  /** @type {null | { size: string, duo: boolean }} */
  let showOptions = null;
  /** @type {object|null} */
  let lastPayload = null;

  /** @param {'native'|'electron'} next @param {string|null} why */
  function use(next, why) {
    const target = next === 'native' ? native : electronWindow;
    if (impl === target && kind === next) return;
    if (impl && impl !== target && impl.isShown()) impl.hide();
    impl = target;
    kind = next;
    reason = why;
    if (shown && showOptions) {
      impl.show(currentShowOptions());
      if (lastPayload) impl.render(lastPayload);
    }
    onChange(kind, reason);
  }

  /** show() options for the pet as it looks now (the last payload wins). */
  function currentShowOptions() {
    if (!showOptions) return { size: 'm', duo: false };
    return lastPayload
      ? {
          size: /** @type {any} */ (lastPayload).size ?? showOptions.size,
          duo: Boolean(/** @type {any} */ (lastPayload).second)
        }
      : showOptions;
  }

  if (!native || !native.available()) use('electron', 'not-bundled');
  else if (forceElectron) use('electron', 'disabled');

  return {
    kind: () => kind,
    reason: () => reason,

    /**
     * Start the native pet (no-op once decided). Resolves the kind in use.
     * @param {{ allowSpawn?: boolean }} [options]
     */
    async start(options) {
      if (kind !== 'pending' || !native) return kind;
      // Tell the native pet what to show before it connects: its first
      // replay is then `show`, not a `hide` that would blink a pet adopted
      // from the timeline (and let the window manager re-place it).
      if (shown && showOptions) native.show(currentShowOptions());
      const result = await native.start(options);
      if (kind !== 'pending') return kind;
      if (result.ok) use('native', null);
      else use('electron', result.reason ?? 'connect-timeout');
      return kind;
    },

    /** The native pet failed after starting (crash loop, no hand-off ack). @param {string} why */
    fallback(why) {
      if (kind === 'electron') return;
      use('electron', why);
    },

    // --- petWindow interface ---

    isShown: () => (impl ? impl.isShown() : shown),
    /** @param {{ size: string, duo?: boolean }} options */
    show(options) {
      shown = true;
      showOptions = { size: options?.size ?? 'm', duo: Boolean(options?.duo) };
      impl?.show(options);
    },
    hide() {
      shown = false;
      lastPayload = null;
      impl?.hide();
    },
    /** @param {object} payload */
    render(payload) {
      lastPayload = payload;
      impl?.render(payload);
    },
    /** @param {number} dx @param {number} dy */
    moveBy(dx, dy) {
      impl?.moveBy(dx, dy);
    },
    savePosition() {
      impl?.savePosition();
    },
    /** @returns {'left'|'right'} */
    secondSide: () => impl?.secondSide?.() ?? 'left',
    groupRect: () => impl?.groupRect?.() ?? null,
    /** The Electron pet's BrowserWindow (sender checks, context menu), else null. */
    window: () =>
      kind === 'electron' ? (electronWindow.window?.() ?? null) : null
  };
}

/**
 * Last native start failed (docs/DESKTOP_PETS_NATIVE_PLAN.md N3). On a Linux
 * Wayland session Electron skips its XWayland relaunch when it expects the
 * native pet, so a binary that cannot run (no GTK 4 / WebP loader) would
 * leave the fallback pet unable to show on every start. The runtime records
 * each native failure here, keyed by the binary (path + size + mtime), and
 * main.mjs relaunches under XWayland while the record matches. The native pet
 * is still tried on every start; its first success deletes the record.
 */
export const NATIVE_FAILURE_FILE = 'pet-native-failure.json';

/** Reasons that are not a failed native start (no binary / forced off). */
const NOT_FAILURES = new Set(['not-bundled', 'disabled']);

/**
 * @param {string} binaryPath
 * @param {{ statSync: (path: string) => { size: number, mtimeMs: number } }} fs
 */
function binaryKey(binaryPath, fs) {
  const st = fs.statSync(binaryPath);
  return `${binaryPath}|${st.size}|${Math.trunc(st.mtimeMs)}`;
}

/**
 * Did the native pet fail to start last time, with this same binary?
 * @param {{
 *   fs: { readFileSync: (path: string, encoding: string) => string, statSync: (path: string) => { size: number, mtimeMs: number } },
 *   userDataDir: string,
 *   binaryPath: string|null
 * }} input
 */
export function lastNativeStartFailed({ fs, userDataDir, binaryPath }) {
  if (!binaryPath) return false;
  try {
    const record = JSON.parse(
      fs.readFileSync(join(userDataDir, NATIVE_FAILURE_FILE), 'utf8')
    );
    return record?.binary === binaryKey(binaryPath, fs);
  } catch {
    return false;
  }
}

/**
 * Record the renderer outcome: 'native' clears the record, a fallback for a
 * real failure writes it. Best effort (never throws).
 * @param {{
 *   fs: {
 *     statSync: (path: string) => { size: number, mtimeMs: number },
 *     writeFileSync: (path: string, data: string) => void,
 *     rmSync: (path: string, options?: object) => void
 *   },
 *   userDataDir: string,
 *   binaryPath: string|null,
 *   kind: 'pending'|'native'|'electron',
 *   reason: string|null
 * }} input
 */
export function recordNativeOutcome({
  fs,
  userDataDir,
  binaryPath,
  kind,
  reason
}) {
  if (!binaryPath) return;
  const path = join(userDataDir, NATIVE_FAILURE_FILE);
  try {
    if (kind === 'native') fs.rmSync(path, { force: true });
    else if (kind === 'electron' && reason && !NOT_FAILURES.has(reason)) {
      fs.writeFileSync(
        path,
        JSON.stringify({ binary: binaryKey(binaryPath, fs), reason })
      );
    }
  } catch (error) {
    console.warn('[pets] native failure record:', error);
  }
}
