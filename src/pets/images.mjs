/**
 * Desktop pets — image decoding for the main process (docs/DESKTOP_PETS_PLAN.md §4.2).
 *
 * Electron's `nativeImage.createFromBuffer` decodes PNG and JPEG only, never
 * WebP — and most Petdex atlases are WebP. So:
 *
 * - `decodeImage` (validator input): PNG through nativeImage (a full decode),
 *   WebP dimensions from the RIFF header (VP8 / VP8L / VP8X). The pixels are
 *   decoded by Chromium in the sandboxed pet window; a broken file just shows
 *   nothing there.
 * - `makeThumb` (store input, synchronous): PNG → nativeImage crop of idle
 *   frame 0; WebP → '' (filled in later).
 * - `createThumbRenderer`: WebP thumbs from a hidden, sandboxed window on the
 *   pet session (`about:blank`, no preload, network blocked) — Chromium
 *   decodes the image, a canvas crops frame 0 to a PNG data URL. Created on
 *   demand, destroyed after a short idle, results cached by content hash.
 */
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import {
  LIMITS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH
} from './contract.mjs';
import { sniffImageType } from './pet-validate.mjs';

const THUMB_PREFIX = 'data:image/png;base64,';
const MAX_THUMB_CHARS = 512 * 1024;
export const THUMB_IDLE_MS = 20_000;
export const THUMB_TIMEOUT_MS = 10_000;
const THUMB_CACHE_MAX = 64;

const fourcc = (buf, at) => String.fromCharCode(...buf.subarray(at, at + 4));
const u24le = (buf, at) => buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16);

/**
 * WebP canvas size from the header, or null. Animated WebPs are refused.
 * @param {Uint8Array} buf
 * @returns {{ width: number, height: number } | null}
 */
export function readWebpSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WEBP') return null;
  const chunk = fourcc(buf, 12);
  const at = 20;
  if (chunk === 'VP8X') {
    const flags = buf[at];
    if (flags & 0x02) return null; // animation
    return { width: u24le(buf, at + 4) + 1, height: u24le(buf, at + 7) + 1 };
  }
  if (chunk === 'VP8L') {
    if (buf[at] !== 0x2f) return null;
    const bits =
      (buf[at + 1] |
        (buf[at + 2] << 8) |
        (buf[at + 3] << 16) |
        (buf[at + 4] << 24)) >>>
      0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (buf[at + 3] !== 0x9d || buf[at + 4] !== 0x01 || buf[at + 5] !== 0x2a)
      return null;
    const width = (buf[at + 6] | (buf[at + 7] << 8)) & 0x3fff;
    const height = (buf[at + 8] | (buf[at + 9] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * The validator's `decodeImage`, Electron-backed.
 * @param {{ createFromBuffer: (buf: Buffer) => { isEmpty: () => boolean, getSize: () => { width: number, height: number } } }} nativeImage
 */
export function createDecodeImage(nativeImage) {
  /** @param {Uint8Array} buf */
  return (buf) => {
    const type = sniffImageType(buf);
    if (type === 'webp') return readWebpSize(buf);
    if (type !== 'png') return null;
    const image = nativeImage.createFromBuffer(Buffer.from(buf));
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    return { width, height };
  };
}

/** Thumb geometry: idle frame 0 at the atlas scale → ≤ 192×208. */
export function thumbGeometry(atlas) {
  const scale =
    Number.isFinite(atlas?.scale) && atlas.scale > 0 ? atlas.scale : 1;
  const sw = Math.round(SPRITE_FRAME_WIDTH * scale);
  const sh = Math.round(SPRITE_FRAME_HEIGHT * scale);
  const fit = Math.min(1, SPRITE_FRAME_WIDTH / sw, SPRITE_FRAME_HEIGHT / sh);
  return { sw, sh, dw: Math.round(sw * fit), dh: Math.round(sh * fit) };
}

/**
 * The store's synchronous `makeThumb`: PNG via nativeImage, WebP → ''.
 * @param {{ createFromBuffer: (buf: Buffer) => any }} nativeImage
 */
export function createMakeThumb(nativeImage) {
  return (imageBuf, atlas) => {
    if (sniffImageType(imageBuf) !== 'png') return '';
    const { sw, sh, dw, dh } = thumbGeometry(atlas);
    let image = nativeImage.createFromBuffer(Buffer.from(imageBuf));
    if (image.isEmpty()) return '';
    image = image.crop({ x: 0, y: 0, width: sw, height: sh });
    if (dw !== sw || dh !== sh)
      image = image.resize({ width: dw, height: dh, quality: 'good' });
    return image.toDataURL();
  };
}

/** True for a PNG data URL of sane size. @param {unknown} value */
export function isThumbDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(THUMB_PREFIX) &&
    value.length <= MAX_THUMB_CHARS &&
    /^[A-Za-z0-9+/=]+$/.test(value.slice(THUMB_PREFIX.length))
  );
}

/**
 * Runs inside the hidden window (serialised with Function#toString).
 * @param {{ dataUrl: string, sw: number, sh: number, dw: number, dh: number }} input
 */
async function renderThumbInPage({ dataUrl, sw, sh, dw, dh }) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, sw, sh, 0, 0, dw, dh);
  return canvas.toDataURL('image/png');
}

/**
 * @param {{
 *   createWindow: () => { webContents: { executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown> }, loadURL: (url: string) => Promise<void>, destroy: () => void, isDestroyed: () => boolean },
 *   readFile?: (path: string) => Promise<Uint8Array>,
 *   setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout,
 *   idleMs?: number,
 *   timeoutMs?: number
 * }} deps
 */
export function createThumbRenderer({
  createWindow,
  readFile = fsReadFile,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  idleMs = THUMB_IDLE_MS,
  timeoutMs = THUMB_TIMEOUT_MS
}) {
  /** hash → data URL ('' = could not render; not retried until the bytes change) */
  const cache = new Map();
  let win = null;
  let ready = null;
  let idleTimer = null;
  let queue = Promise.resolve();

  function dispose() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = null;
  }

  function armIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(dispose, idleMs);
    idleTimer?.unref?.();
  }

  async function ensureWindow() {
    if (win && !win.isDestroyed() && ready) return ready;
    win = createWindow();
    ready = win.loadURL('about:blank').then(() => win);
    return ready;
  }

  async function renderOnce(imageBuf, atlas) {
    const { sw, sh, dw, dh } = thumbGeometry(atlas);
    const dataUrl = `data:image/webp;base64,${Buffer.from(imageBuf).toString('base64')}`;
    const code = `(${renderThumbInPage.toString()})(${JSON.stringify({ dataUrl, sw, sh, dw, dh })})`;
    const target = await ensureWindow();
    let timeout;
    try {
      return await Promise.race([
        target.webContents.executeJavaScript(code, false),
        new Promise((_, reject) => {
          timeout = setTimer(
            () => reject(new Error('thumb timeout')),
            timeoutMs
          );
        })
      ]);
    } finally {
      clearTimer(timeout);
    }
  }

  return {
    /**
     * PNG data URL of idle frame 0 for a stored WebP pet, or ''.
     * @param {{ imagePath: string, atlas: object } | null} record
     * @returns {Promise<string>}
     */
    thumbFor(record) {
      const job = queue.then(async () => {
        if (!record?.imagePath) return '';
        let bytes;
        try {
          bytes = await readFile(record.imagePath);
        } catch {
          return '';
        }
        if (
          bytes.byteLength > LIMITS.imageBytes ||
          sniffImageType(bytes) !== 'webp'
        )
          return '';
        const key =
          createHash('sha256').update(bytes).digest('hex') +
          JSON.stringify(thumbGeometry(record.atlas));
        if (cache.has(key)) return cache.get(key);
        let result;
        try {
          const out = await renderOnce(bytes, record.atlas);
          result = isThumbDataUrl(out) ? out : '';
        } catch {
          result = '';
          dispose();
        }
        if (cache.size >= THUMB_CACHE_MAX)
          cache.delete(cache.keys().next().value);
        cache.set(key, result);
        armIdle();
        return result;
      });
      queue = job.catch(() => '');
      return job;
    },
    dispose
  };
}
