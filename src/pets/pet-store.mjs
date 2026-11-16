/**
 * Desktop pets — installed-pet store (docs/DESKTOP_PETS_PLAN.md §4.2, D6).
 *
 * Own pets live in `userData/pets/<source>-<slug|uuid>/` (pet.json,
 * spritesheet.webp|png, source.json). The folders other apps install into —
 * Codex (`<codexHome>/pets`, ids `codex:<folder>`) and the Petdex CLI /
 * Petdex Desktop (`~/.petdex/pets`, ids `petdex-cli:<folder>`) — are scanned
 * read-only on every `list()` (when `scanCodexDir`) and never written. Every
 * pet, own or folder, passes `validatePet` before it is listed or served;
 * symlinks are skipped. Installs go to a temp dir and are renamed into
 * place, so a failed install leaves nothing behind.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { LIMITS, PETDEX_ORIGIN } from './contract.mjs';
import { validatePet } from './pet-validate.mjs';

export const PETS_DIR = 'pets';
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX_ID_RE = /^[A-Za-z0-9._%-]{1,200}$/;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 40;
const MAX_CREATOR_CHARS = 80;
/** Read-only folder sources, in list order (duplicates keep the first). */
const FOLDER_SOURCES = Object.freeze(['petdex-cli', 'codex']);

/** A pet from a folder another app owns (never written or removed). */
const isFolderSource = (source) => FOLDER_SOURCES.includes(source);

/**
 * The read-only pet folders' homes: `$CODEX_HOME` (else `~/.codex`) and
 * `~/.petdex`. `npx petdex install` and Petdex Desktop write
 * `<home>/.petdex/pets/<slug>/` from the home directory (petdex-cli
 * `bin/petdex.ts` installOne, petdex-desktop-native `installer.zig`): neither
 * reads a $PETDEX_HOME, so neither do we.
 * @param {{ env: Record<string, string|undefined>, homeDir: string }} input
 */
export function petFolderHomes({ env, homeDir }) {
  return {
    codexHome: env.CODEX_HOME || join(homeDir, '.codex'),
    petdexHome: join(homeDir, '.petdex')
  };
}

/** @param {unknown} v @param {number} max */
function capText(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t ? [...t].slice(0, max).join('') : null;
}

/** Petdex slugs (their own `[a-z0-9-]{1,60}` rule). @param {unknown} slug */
export function isPetdexSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/** `https://petdex.dev/pets/<slug>` @param {string} slug */
export function petdexPageUrl(slug) {
  return `${PETDEX_ORIGIN}/pets/${slug}`;
}

/**
 * Codex folder name → id-safe token (percent-encodes everything outside
 * `[A-Za-z0-9._-]`, so the id survives settings validation and URLs).
 * @param {string} name
 */
export function encodeFolderName(name) {
  let out = '';
  for (const ch of name) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** @param {string} token @returns {string|null} */
function decodeFolderToken(token) {
  if (!CODEX_ID_RE.test(token)) return null;
  try {
    const name = decodeURIComponent(token);
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[/\\]/.test(name) ||
      name.includes('\0')
    ) {
      return null;
    }
    return name;
  } catch {
    return null;
  }
}

/**
 * Parse a pet id into its source and folder location.
 * @param {unknown} id
 * @returns {{ source: 'petdex'|'import'|'codex'|'petdex-cli', key: string } | null}
 */
export function parsePetId(id) {
  if (typeof id !== 'string') return null;
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const source = id.slice(0, colon);
  const key = id.slice(colon + 1);
  if (source === 'petdex' && SLUG_RE.test(key)) return { source, key };
  if (source === 'import' && UUID_RE.test(key)) return { source, key };
  if (isFolderSource(source) && decodeFolderToken(key) !== null) {
    return { source, key };
  }
  return null;
}

/** Read a regular (non-symlink) file up to `max` bytes, else null. */
function readRegularFile(path, max) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return { data: readFileSync(path), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function isRealDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sanitiseMeta(source, slug, meta = {}) {
  const tags = Array.isArray(meta?.tags)
    ? meta.tags
        .map((t) => capText(t, MAX_TAG_CHARS))
        .filter(Boolean)
        .slice(0, MAX_TAGS)
    : [];
  return {
    source,
    slug: source === 'petdex' ? slug : null,
    pageUrl: source === 'petdex' ? petdexPageUrl(slug) : null,
    creator: capText(meta?.creator, MAX_CREATOR_CHARS),
    description: capText(meta?.description, LIMITS.descriptionChars),
    tags
  };
}

/**
 * @param {{
 *   userDataDir: string,
 *   codexHome: string|null,
 *   petdexHome?: string|null,
 *   decodeImage: (buf: Uint8Array) => { width: number, height: number } | null,
 *   makeThumb: (imageBuf: Buffer, atlas: object) => string,
 *   getSettings: () => { scanCodexDir: boolean, activePetId?: string|null, secondPetId?: string|null },
 *   now?: () => number
 * }} options
 */
export function createPetStore({
  userDataDir,
  codexHome,
  petdexHome = null,
  decodeImage,
  makeThumb,
  getSettings,
  now = Date.now
}) {
  const ownRoot = join(userDataDir, PETS_DIR);
  /** Read-only roots by folder source. */
  const folderRoots = {
    'petdex-cli': petdexHome ? join(petdexHome, 'pets') : null,
    codex: codexHome ? join(codexHome, 'pets') : null
  };
  /** dir → { stamp, record, listed, spriteHash } */
  const cache = new Map();

  function thumbFor(imageBuf, atlas) {
    try {
      const url = makeThumb(imageBuf, atlas);
      return typeof url === 'string' ? url : '';
    } catch {
      return '';
    }
  }

  /**
   * Load + validate one pet folder. Cached on the files' mtimes and sizes.
   * @returns {{ record: object, listed: object } | null}
   */
  function loadDir(id, source, dir) {
    if (!isRealDir(dir)) return null;
    const petJson = readRegularFile(join(dir, 'pet.json'), LIMITS.petJsonBytes);
    if (!petJson) return null;
    let spritesheetPath;
    try {
      spritesheetPath = JSON.parse(
        petJson.data.toString('utf8')
      )?.spritesheetPath;
    } catch {
      return null;
    }
    if (typeof spritesheetPath !== 'string' || /[/\\]/.test(spritesheetPath)) {
      return null;
    }
    const imagePath = join(dir, spritesheetPath);
    let imageStat;
    try {
      imageStat = lstatSync(imagePath);
    } catch {
      return null;
    }
    if (!imageStat.isFile() || imageStat.size > LIMITS.imageBytes) return null;
    const sourceFile = isFolderSource(source)
      ? null
      : readRegularFile(join(dir, 'source.json'), 64 * 1024);
    const stamp = [
      petJson.mtimeMs,
      petJson.size,
      imageStat.mtimeMs,
      imageStat.size,
      sourceFile?.mtimeMs ?? 0
    ].join(':');
    const cached = cache.get(dir);
    if (cached && cached.stamp === stamp) return cached;

    const image = readRegularFile(imagePath, LIMITS.imageBytes);
    if (!image) return null;
    const checked = validatePet({
      petJsonBuf: petJson.data,
      imageBuf: image.data,
      decodeImage
    });
    if (!checked.ok) {
      cache.delete(dir);
      return null;
    }
    let meta = {
      source,
      slug: null,
      pageUrl: null,
      creator: null,
      description: null,
      tags: []
    };
    if (sourceFile) {
      try {
        const raw = JSON.parse(sourceFile.data.toString('utf8'));
        meta = sanitiseMeta(
          source,
          source === 'petdex' ? parsePetId(id)?.key : null,
          raw
        );
      } catch {
        // Missing / corrupt source.json: the pet still works without credits.
      }
    }
    const pet = checked.pet;
    const description = pet.description ?? meta.description;
    const record = {
      id,
      source,
      dir,
      imagePath,
      mime: pet.mime,
      atlas: pet.atlas,
      meta: {
        displayName: pet.displayName,
        description,
        creator: meta.creator,
        slug: meta.slug,
        pageUrl: meta.pageUrl,
        tags: meta.tags
      }
    };
    const listed = {
      id,
      source,
      displayName: pet.displayName,
      description,
      creator: meta.creator,
      slug: meta.slug,
      pageUrl: meta.pageUrl,
      thumb: thumbFor(image.data, pet.atlas),
      removable: !isFolderSource(source)
    };
    // Folder duplicates are told apart by their sheet bytes (listFolders).
    const spriteHash = isFolderSource(source)
      ? createHash('sha256').update(image.data).digest('hex')
      : null;
    const entry = { stamp, record, listed, spriteHash };
    cache.set(dir, entry);
    return entry;
  }

  function ownDirFor(source, key) {
    return join(ownRoot, `${source}-${key}`);
  }

  function locate(id) {
    const parsed = parsePetId(id);
    if (!parsed) return null;
    if (isFolderSource(parsed.source)) {
      const root = folderRoots[parsed.source];
      if (!root || !getSettings().scanCodexDir) return null;
      const name = decodeFolderToken(parsed.key);
      return name ? { ...parsed, dir: join(root, name) } : null;
    }
    return { ...parsed, dir: ownDirFor(parsed.source, parsed.key) };
  }

  function listOwn() {
    /** @type {object[]} */
    const pets = [];
    let names;
    try {
      names = readdirSync(ownRoot);
    } catch {
      return pets;
    }
    for (const name of names.sort()) {
      const match = /^(petdex|import)-(.+)$/.exec(name);
      if (!match) continue;
      const id = `${match[1]}:${match[2]}`;
      if (!parsePetId(id)) continue;
      const loaded = loadDir(id, match[1], join(ownRoot, name));
      if (loaded) pets.push(loaded.listed);
    }
    return pets;
  }

  /**
   * Valid pets in one read-only folder root, sorted by folder name.
   * @param {'petdex-cli'|'codex'} source
   * @returns {{ name: string, loaded: { listed: object, spriteHash: string|null } }[]}
   */
  function scanFolder(source) {
    const root = folderRoots[source];
    /** @type {{ name: string, loaded: any }[]} */
    const pets = [];
    if (!root) return pets;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return pets;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const token = encodeFolderName(entry.name);
      if (!CODEX_ID_RE.test(token)) continue;
      const loaded = loadDir(
        `${source}:${token}`,
        source,
        join(root, entry.name)
      );
      if (loaded) pets.push({ name: entry.name, loaded });
    }
    return pets;
  }

  /**
   * Folder pets (when scanCodexDir), Petdex CLI first. The Petdex CLI writes
   * one install into both folders, so a Codex pet with the same folder name
   * and the same spritesheet bytes as a Petdex CLI pet is listed once — as
   * the Petdex CLI copy, unless only the Codex id is in use (active or duo
   * pet), so a choice saved before both folders were read stays marked.
   * Every id still resolves through `get` either way.
   */
  function listFolders() {
    const current = getSettings();
    if (!current.scanCodexDir) return [];
    const inUse = new Set([current.activePetId, current.secondPetId]);
    const cli = scanFolder('petdex-cli');
    const codex = scanFolder('codex');
    const codexByName = new Map(codex.map((pet) => [pet.name, pet]));
    const hidden = new Set();
    for (const pet of cli) {
      const twin = codexByName.get(pet.name);
      if (!twin || twin.loaded.spriteHash !== pet.loaded.spriteHash) continue;
      const cliUsed = inUse.has(pet.loaded.listed.id);
      const codexUsed = inUse.has(twin.loaded.listed.id);
      if (cliUsed && codexUsed) continue;
      hidden.add(codexUsed ? pet : twin);
    }
    return [...cli, ...codex]
      .filter((pet) => !hidden.has(pet))
      .map((pet) => pet.loaded.listed);
  }

  function get(id) {
    const where = locate(id);
    if (!where) return null;
    return loadDir(id, where.source, where.dir)?.record ?? null;
  }

  return {
    /** Own pets first, then the folder pets (when scanCodexDir). */
    list() {
      return [...listOwn(), ...listFolders()];
    },
    /** @param {string} id */
    get,
    /** InstalledPet for one id, or null. @param {string} id */
    getListed(id) {
      const where = locate(id);
      if (!where) return null;
      return loadDir(id, where.source, where.dir)?.listed ?? null;
    },
    /**
     * Validate and store a pet.
     * @param {{ source: 'petdex'|'import', slug?: string, petJsonBuf: Buffer, imageBuf: Buffer, meta?: { creator?: string, description?: string, tags?: string[] } }} input
     * @returns {{ ok: true, pet: object } | { ok: false, error: string }}
     */
    install({ source, slug, petJsonBuf, imageBuf, meta }) {
      if (source !== 'petdex' && source !== 'import') {
        return { ok: false, error: 'Unknown pet source.' };
      }
      if (source === 'petdex' && !isPetdexSlug(slug)) {
        return { ok: false, error: 'Invalid Petdex slug.' };
      }
      const checked = validatePet({ petJsonBuf, imageBuf, decodeImage });
      if (!checked.ok) return checked;
      const pet = checked.pet;
      const key = source === 'petdex' ? slug : randomUUID();
      const id = `${source}:${key}`;
      const finalDir = ownDirFor(source, key);
      const tmpDir = join(ownRoot, `.tmp-${randomUUID()}`);
      const oldDir = join(ownRoot, `.old-${randomUUID()}`);
      const spriteName = `spritesheet.${pet.ext}`;
      const cleanMeta = sanitiseMeta(source, slug, meta);
      try {
        mkdirSync(tmpDir, { recursive: true });
        writeFileSync(
          join(tmpDir, 'pet.json'),
          `${JSON.stringify(
            {
              id: pet.id ?? key,
              displayName: pet.displayName,
              description: pet.description,
              spritesheetPath: spriteName,
              spriteVersionNumber: pet.atlas.version
            },
            null,
            2
          )}\n`
        );
        writeFileSync(join(tmpDir, spriteName), imageBuf);
        writeFileSync(
          join(tmpDir, 'source.json'),
          `${JSON.stringify(
            { ...cleanMeta, installedAt: new Date(now()).toISOString() },
            null,
            2
          )}\n`
        );
        const replacing = existsSync(finalDir);
        if (replacing) renameSync(finalDir, oldDir);
        try {
          renameSync(tmpDir, finalDir);
        } catch (error) {
          if (replacing) renameSync(oldDir, finalDir);
          throw error;
        }
        if (replacing) rmSync(oldDir, { recursive: true, force: true });
      } catch (error) {
        rmSync(tmpDir, { recursive: true, force: true });
        return {
          ok: false,
          error: `Could not save the pet: ${error?.message ?? error}`
        };
      }
      cache.delete(finalDir);
      const listed = loadDir(id, source, finalDir)?.listed;
      if (!listed)
        return { ok: false, error: 'The saved pet could not be read back.' };
      return { ok: true, pet: listed };
    },
    /**
     * Delete an own pet (folder pets — Codex, Petdex CLI — are never removable).
     * @param {string} id
     * @returns {{ ok: true } | { ok: false, error: string }}
     */
    remove(id) {
      const parsed = parsePetId(id);
      if (!parsed) return { ok: false, error: 'Unknown pet.' };
      if (parsed.source === 'codex') {
        return { ok: false, error: 'Codex pets are managed by Codex.' };
      }
      if (isFolderSource(parsed.source)) {
        return { ok: false, error: 'Petdex CLI pets are managed by Petdex.' };
      }
      const dir = ownDirFor(parsed.source, parsed.key);
      if (!isRealDir(dir)) return { ok: false, error: 'Unknown pet.' };
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        return {
          ok: false,
          error: `Could not remove the pet: ${error?.message ?? error}`
        };
      }
      cache.delete(dir);
      return { ok: true };
    },
    /**
     * For the pet-asset:// protocol: the validated spritesheet of a pet.
     * @param {string} id
     * @returns {{ path: string, mime: string } | null}
     */
    resolveAsset(id) {
      const record = get(id);
      return record ? { path: record.imagePath, mime: record.mime } : null;
    }
  };
}
