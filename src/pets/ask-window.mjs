/**
 * Desktop pets — the quick-ask window (docs/DESKTOP_PETS_PLAN.md §12 #9).
 *
 * "Ask an F1 question…" (pet menu, tray, `pets:openAsk`) opens one small,
 * framed, resizable, always-on-top window on `${appUrl}${ASK_PATH}` — the
 * compact chat — with the MAIN preload, so chat providers (BYOK, the
 * desktop harness) work exactly as in the main window. The harness and the
 * pets IPC trust it like the main window (same app-origin check, see
 * `isTrustedAppSender` in ../ipc.mjs).
 *
 * Placement: beside the pet (left of it, else right) on the pet's display,
 * bottom edges aligned; without a pet, the bottom-right of the primary work
 * area. Esc closes it. Navigation stays on ASK_PATH: other app-origin links
 * open in the main window, pet-store links in the store window, the rest in
 * the default browser (`openOutside`).
 */
import { ASK_PATH } from './contract.mjs';
import { attachZoomKeys } from '../zoom-keys.mjs';

export const ASK_WINDOW_WIDTH = 420;
export const ASK_WINDOW_HEIGHT = 600;
export const ASK_WINDOW_MIN_WIDTH = 340;
export const ASK_WINDOW_MIN_HEIGHT = 420;
/** Space between the pet and the ask window. */
export const ASK_WINDOW_GAP = 12;
const SCREEN_MARGIN = 24;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

/**
 * Where the ask window opens.
 * @param {{ pet: Rect|null, workArea: Rect, width?: number, height?: number }} input
 *   `workArea` = the pet's display (or the primary one without a pet)
 * @returns {Rect}
 */
export function askWindowBounds({
  pet,
  workArea,
  width = ASK_WINDOW_WIDTH,
  height = ASK_WINDOW_HEIGHT
}) {
  const w = Math.min(width, workArea.width);
  const h = Math.min(height, workArea.height);
  let x;
  let y;
  if (pet) {
    const left = pet.x - ASK_WINDOW_GAP - w;
    const right = pet.x + pet.width + ASK_WINDOW_GAP;
    if (left >= workArea.x) x = left;
    else if (right + w <= workArea.x + workArea.width) x = right;
    else x = left;
    y = pet.y + pet.height - h;
  } else {
    x = workArea.x + workArea.width - w - SCREEN_MARGIN;
    y = workArea.y + workArea.height - h - SCREEN_MARGIN;
  }
  const maxX = workArea.x + workArea.width - w;
  const maxY = workArea.y + workArea.height - h;
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(y, workArea.y), maxY)),
    width: w,
    height: h
  };
}

/** true for a plain Esc key press (closes the window). */
export function isCloseKey(input) {
  return (
    input?.type === 'keyDown' &&
    input.key === 'Escape' &&
    !input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift
  );
}

/**
 * What a navigation from the ask window does.
 * @param {string} url
 * @param {string} appOrigin
 * @returns {{ kind: 'stay' } | { kind: 'main', path: string } | { kind: 'outside', url: string }}
 */
export function askNavigation(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'outside', url };
  }
  if (parsed.origin !== appOrigin) return { kind: 'outside', url: parsed.href };
  if (parsed.pathname === ASK_PATH) return { kind: 'stay' };
  return {
    kind: 'main',
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`
  };
}

/**
 * @param {{
 *   BrowserWindow: new (options: object) => any,
 *   screen: { getPrimaryDisplay: () => { workArea: Rect }, getDisplayMatching: (rect: Rect) => { workArea: Rect } },
 *   appUrl: string,
 *   appOrigin: string,
 *   preloadPath: string,
 *   getPetRect: () => Rect|null,
 *   openMain: (path: string) => void,
 *   openOutside: (url: string) => void,
 *   platform: string,
 *   iconPath?: string,
 *   webPreferences?: object,
 *   onCreated?: (window: any) => void,
 *   onClosed?: () => void
 * }} deps
 */
export function createAskWindow(deps) {
  const {
    BrowserWindow,
    screen,
    appUrl,
    appOrigin,
    preloadPath,
    getPetRect,
    openMain,
    openOutside,
    platform,
    iconPath,
    webPreferences = {},
    onCreated = () => {},
    onClosed = () => {}
  } = deps;
  const askUrl = new URL(ASK_PATH, appUrl).href;
  let win = null;

  const live = () => Boolean(win && !win.isDestroyed());

  function bounds() {
    const pet = getPetRect();
    const workArea = pet
      ? screen.getDisplayMatching(pet).workArea
      : screen.getPrimaryDisplay().workArea;
    return askWindowBounds({ pet, workArea });
  }

  /** Route a navigation away from the ask page. */
  function leave(target) {
    if (target.kind === 'main') openMain(target.path);
    else if (target.kind === 'outside') openOutside(target.url);
  }

  function create() {
    win = new BrowserWindow({
      ...bounds(),
      minWidth: ASK_WINDOW_MIN_WIDTH,
      minHeight: ASK_WINDOW_MIN_HEIGHT,
      show: false,
      frame: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: 'Ask an F1 question — TracingInsights',
      backgroundColor: '#0b0b0f',
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        ...webPreferences,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const window = win;
    window.setAlwaysOnTop(true, 'floating');
    if (platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    const contents = window.webContents;
    attachZoomKeys(contents, platform);
    contents.on('before-input-event', (event, input) => {
      if (!isCloseKey(input)) return;
      event.preventDefault();
      window.close();
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Never a second window: a new-tab link to the ask page itself is dropped.
      leave(askNavigation(url, appOrigin));
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const target = askNavigation(url, appOrigin);
      if (target.kind === 'stay') return;
      event.preventDefault();
      leave(target);
    });
    // A client-side (SvelteKit) link never fires will-navigate: send the
    // path to the main window and put the ask page back.
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame === false) return;
      const target = askNavigation(url, appOrigin);
      if (target.kind === 'stay') return;
      leave(target);
      void window.loadURL(askUrl);
    });
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return;
      window.show();
      // X11 only takes _NET_WM_STATE_ABOVE on a mapped window.
      window.setAlwaysOnTop(true, 'floating');
    });
    window.on('closed', () => {
      if (win === window) win = null;
      onClosed();
    });
    onCreated(window);
    void window.loadURL(askUrl);
  }

  return {
    /** Open (one instance) or bring the existing window forward. */
    open() {
      if (live()) {
        if (win.isMinimized?.()) win.restore();
        win.show();
        win.focus();
        return { ok: true };
      }
      create();
      return { ok: true };
    },
    close() {
      if (live()) win.close();
    },
    /** The BrowserWindow while open (sender checks), else null. */
    window: () => (live() ? win : null),
    destroy() {
      if (live()) win.destroy();
      win = null;
    }
  };
}
