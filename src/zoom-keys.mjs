/**
 * Page zoom from the keyboard, the way browsers do it.
 *
 * The View menu's zoom-in accelerator (`CmdOrCtrl+Plus`) does not fire for
 * the usual "Ctrl +" key press on Linux/Windows layouts where "+" shares the
 * "=" key, and the numpad keys were never bound. This handles Ctrl/Cmd +
 * `+`/`=`/numpad-plus, `-`/numpad-minus and `0`/numpad-0 on a window's
 * webContents and stops the menu from zooming a second time. Steps match the
 * menu roles (±0.5 zoom level).
 */

export const ZOOM_STEP = 0.5;
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 5;

/**
 * @param {{ type: string, control?: boolean, meta?: boolean, alt?: boolean, key: string, code?: string }} input
 * @param {string} platform
 * @returns {'in'|'out'|'reset'|null}
 */
export function zoomActionFor(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.alt) return null;
  const modifier = platform === 'darwin' ? input.meta : input.control;
  if (!modifier) return null;
  if (
    input.key === '+' ||
    input.key === '=' ||
    input.code === 'Equal' ||
    input.code === 'NumpadAdd'
  )
    return 'in';
  if (
    input.key === '-' ||
    input.key === '_' ||
    input.code === 'Minus' ||
    input.code === 'NumpadSubtract'
  )
    return 'out';
  if (input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}

/** @param {'in'|'out'|'reset'} action @param {number} level */
export function nextZoomLevel(action, level) {
  if (action === 'reset') return 0;
  const next = level + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, next));
}

/**
 * @param {{ on: Function, getZoomLevel: () => number, setZoomLevel: (level: number) => void }} webContents
 * @param {string} [platform]
 */
export function attachZoomKeys(webContents, platform = process.platform) {
  webContents.on('before-input-event', (event, input) => {
    const action = zoomActionFor(input, platform);
    if (!action) return;
    event.preventDefault();
    webContents.setZoomLevel(nextZoomLevel(action, webContents.getZoomLevel()));
  });
}
