/**
 * Desktop pets — the one validator every pet passes before it is shown
 * (Petdex, Codex folder, import; docs/DESKTOP_PETS_PLAN.md §4.2).
 *
 * The image is identified by its magic bytes, never its extension, and its
 * dimensions come from `decodeImage` (Electron injects a nativeImage-based
 * decoder; tests pass a fake). Pure: no fs, no Electron.
 */
import {
  ATLAS_ROWS,
  LIMITS,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH
} from './contract.mjs';

const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 128;
const IMAGE_TYPES = Object.freeze({
  png: 'image/png',
  webp: 'image/webp'
});

/** @param {string} text @param {number} max */
function cleanText(text, max) {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return [...cleaned].slice(0, max).join('');
}

/**
 * Port of Petdex `detectSpriteAtlas` (src/lib/sprite-atlas.ts, MIT): v1
 * (8×9 cells) or v2 (8×11), proportionally scaled sheets accepted only when
 * every cell lands on an integer boundary.
 * @param {unknown} width
 * @param {unknown} height
 * @returns {{ version: 1|2, rows: number, width: number, height: number, scale: number } | null}
 */
export function detectAtlas(width, height) {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  for (const version of /** @type {const} */ ([1, 2])) {
    const rows = ATLAS_ROWS[version];
    const canonicalWidth = SPRITE_COLUMNS * SPRITE_FRAME_WIDTH;
    const canonicalHeight = rows * SPRITE_FRAME_HEIGHT;
    if (
      width % SPRITE_COLUMNS !== 0 ||
      height % rows !== 0 ||
      BigInt(width) * BigInt(canonicalHeight) !==
        BigInt(height) * BigInt(canonicalWidth)
    ) {
      continue;
    }
    return { version, rows, width, height, scale: width / canonicalWidth };
  }
  return null;
}

/**
 * Identify a PNG or WebP by magic bytes.
 * @param {Uint8Array|null|undefined} buf
 * @returns {'png'|'webp'|null}
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  const ascii = (from, to) => String.fromCharCode(...buf.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** MIME type of a sniffed image type. @param {'png'|'webp'} type */
export function imageMime(type) {
  return IMAGE_TYPES[type];
}

/**
 * `spritesheetPath` must be a bare file name ending in .webp / .png.
 * @param {unknown} value
 */
export function isBareSpritePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    !/[/\\:]/.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.') &&
    /\.(webp|png)$/i.test(value)
  );
}

/**
 * Parse and check a pet.json buffer.
 * @param {Uint8Array|null|undefined} buf
 * @returns {{ ok: true, petJson: { id: string|null, displayName: string, description: string|null, spritesheetPath: string, spriteVersionNumber: 1|2|null } } | { ok: false, error: string }}
 */
export function validatePetJson(buf) {
  if (!buf || buf.length === 0)
    return { ok: false, error: 'pet.json is missing.' };
  if (buf.length > LIMITS.petJsonBytes) {
    return { ok: false, error: 'pet.json is too large.' };
  }
  let raw;
  try {
    raw = JSON.parse(
      Buffer.from(buf)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
    );
  } catch {
    return { ok: false, error: 'pet.json is not valid JSON.' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'pet.json must be an object.' };
  }
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? cleanText(raw.id, MAX_ID_CHARS)
      : null;
  const displayName =
    typeof raw.displayName === 'string' && raw.displayName.trim()
      ? cleanText(raw.displayName, LIMITS.displayNameChars)
      : id
        ? cleanText(id, LIMITS.displayNameChars)
        : '';
  if (!displayName) return { ok: false, error: 'pet.json has no displayName.' };
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') {
      return { ok: false, error: 'pet.json description must be text.' };
    }
  }
  const description =
    typeof raw.description === 'string' && raw.description.trim()
      ? cleanText(raw.description, LIMITS.descriptionChars)
      : null;
  if (!isBareSpritePath(raw.spritesheetPath)) {
    return {
      ok: false,
      error: 'pet.json spritesheetPath must be a .webp or .png file name.'
    };
  }
  const version = raw.spriteVersionNumber;
  if (
    version !== undefined &&
    version !== null &&
    version !== 1 &&
    version !== 2
  ) {
    return { ok: false, error: 'pet.json spriteVersionNumber must be 1 or 2.' };
  }
  return {
    ok: true,
    petJson: {
      id,
      displayName,
      description,
      spritesheetPath: raw.spritesheetPath,
      spriteVersionNumber: version ?? null
    }
  };
}

/**
 * Validate a pet.json + spritesheet pair.
 * @param {{
 *   petJsonBuf: Uint8Array|null|undefined,
 *   imageBuf: Uint8Array|null|undefined,
 *   decodeImage: (buf: Uint8Array) => { width: number, height: number } | null
 * }} input
 * @returns {{ ok: true, pet: { id: string|null, displayName: string, description: string|null, spritesheetPath: string, ext: 'png'|'webp', mime: string, atlas: { version: 1|2, rows: number, scale: number, width: number, height: number } } } | { ok: false, error: string }}
 */
export function validatePet({ petJsonBuf, imageBuf, decodeImage }) {
  const parsed = validatePetJson(petJsonBuf);
  if (!parsed.ok) return parsed;
  const { petJson } = parsed;
  if (!imageBuf || imageBuf.length === 0) {
    return { ok: false, error: 'The spritesheet is missing.' };
  }
  if (imageBuf.length > LIMITS.imageBytes) {
    return { ok: false, error: 'The spritesheet is too large.' };
  }
  const ext = sniffImageType(imageBuf);
  if (!ext)
    return { ok: false, error: 'The spritesheet is not a PNG or WebP image.' };
  let size;
  try {
    size = decodeImage(imageBuf);
  } catch {
    size = null;
  }
  if (!size)
    return { ok: false, error: 'The spritesheet could not be decoded.' };
  const atlas = detectAtlas(size.width, size.height);
  if (!atlas) {
    return {
      ok: false,
      error: `The spritesheet is ${size.width}×${size.height}; expected an 8×9 or 8×11 grid of 192×208 cells (or a whole-pixel scale of it).`
    };
  }
  if (
    petJson.spriteVersionNumber !== null &&
    petJson.spriteVersionNumber !== atlas.version
  ) {
    return {
      ok: false,
      error: `pet.json says sprite version ${petJson.spriteVersionNumber} but the image is a version ${atlas.version} atlas.`
    };
  }
  return {
    ok: true,
    pet: {
      id: petJson.id,
      displayName: petJson.displayName,
      description: petJson.description,
      spritesheetPath: petJson.spritesheetPath,
      ext,
      mime: imageMime(ext),
      atlas: {
        version: atlas.version,
        rows: atlas.rows,
        scale: atlas.scale,
        width: atlas.width,
        height: atlas.height
      }
    }
  };
}
