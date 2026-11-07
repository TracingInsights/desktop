/**
 * Desktop pets — "Import pet…" (docs/DESKTOP_PETS_PLAN.md D14, §4.2).
 *
 * Main opens the native dialog (the page never passes paths). The user picks
 * a downloaded `.zip`, or a pet folder's `pet.json` (Windows and Linux file
 * dialogs cannot pick "file or folder" at once; macOS may pick the folder
 * itself). Zips are read by zip.mjs with one level of folder nesting
 * allowed; everything then goes through store.install({ source: 'import' }),
 * which runs the shared validator.
 */
import { basename, dirname, join } from 'node:path';
import { LIMITS } from './contract.mjs';
import { isBareSpritePath } from './pet-validate.mjs';
import { readZip } from './zip.mjs';

/** OS cruft zipped next to a pet (macOS resource forks, Finder files). */
function isJunkEntry(name) {
  const base = name.split('/').pop() ?? '';
  return (
    name.startsWith('__MACOSX/') ||
    base.startsWith('._') ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base === 'desktop.ini'
  );
}

/**
 * Pick pet.json + its spritesheet out of zip entries.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {{ ok: true, petJsonBuf: Buffer, imageBuf: Buffer } | { ok: false, error: string }}
 */
export function pickPetFiles(entries) {
  const files = entries.filter((e) => !isJunkEntry(e.name));
  const petJsons = files.filter((e) => {
    const parts = e.name.split('/');
    return (
      parts.length <= 2 && parts[parts.length - 1].toLowerCase() === 'pet.json'
    );
  });
  if (petJsons.length === 0) {
    return { ok: false, error: 'No pet.json found in the zip.' };
  }
  if (petJsons.length > 1) {
    return { ok: false, error: 'The zip holds more than one pet.json.' };
  }
  const petJson = petJsons[0];
  const prefix = petJson.name.includes('/')
    ? petJson.name.slice(0, petJson.name.lastIndexOf('/') + 1)
    : '';
  let spritesheetPath;
  try {
    spritesheetPath = JSON.parse(
      petJson.data.toString('utf8').replace(/^\uFEFF/, '')
    )?.spritesheetPath;
  } catch {
    return { ok: false, error: 'pet.json is not valid JSON.' };
  }
  if (!isBareSpritePath(spritesheetPath)) {
    return {
      ok: false,
      error: 'pet.json spritesheetPath must be a .webp or .png file name.'
    };
  }
  const image = files.find((e) => e.name === `${prefix}${spritesheetPath}`);
  if (!image) {
    return {
      ok: false,
      error: `The zip has no ${spritesheetPath} next to pet.json.`
    };
  }
  return { ok: true, petJsonBuf: petJson.data, imageBuf: image.data };
}

/**
 * @param {{
 *   showOpenDialog: (options: object) => Promise<{ canceled: boolean, filePaths: string[] }>,
 *   store: { install: (input: object) => { ok: true, pet: object } | { ok: false, error: string } },
 *   readFile: (path: string) => Promise<Buffer> | Buffer,
 *   stat: (path: string) => Promise<{ size: number, isFile(): boolean, isDirectory(): boolean }> | { size: number, isFile(): boolean, isDirectory(): boolean },
 *   platform?: string
 * }} options
 */
export function createImporter({
  showOpenDialog,
  store,
  readFile,
  stat,
  platform = process.platform
}) {
  async function readCapped(path, max, label) {
    let st;
    try {
      st = await stat(path);
    } catch {
      return { ok: false, error: `${label} not found.` };
    }
    if (!st.isFile()) return { ok: false, error: `${label} is not a file.` };
    if (st.size > max) return { ok: false, error: `${label} is too large.` };
    const data = await readFile(path);
    if (data.length > max)
      return { ok: false, error: `${label} is too large.` };
    return { ok: true, data };
  }

  async function fromFolder(dir) {
    const petJson = await readCapped(
      join(dir, 'pet.json'),
      LIMITS.petJsonBytes,
      'pet.json'
    );
    if (!petJson.ok) return petJson;
    let spritesheetPath;
    try {
      spritesheetPath = JSON.parse(
        petJson.data.toString('utf8').replace(/^\uFEFF/, '')
      )?.spritesheetPath;
    } catch {
      return { ok: false, error: 'pet.json is not valid JSON.' };
    }
    if (!isBareSpritePath(spritesheetPath)) {
      return {
        ok: false,
        error: 'pet.json spritesheetPath must be a .webp or .png file name.'
      };
    }
    const image = await readCapped(
      join(dir, spritesheetPath),
      LIMITS.imageBytes,
      'The spritesheet'
    );
    if (!image.ok) return image;
    return { ok: true, petJsonBuf: petJson.data, imageBuf: image.data };
  }

  async function fromZip(path) {
    const zip = await readCapped(path, LIMITS.zipBytes, 'The zip file');
    if (!zip.ok) return zip;
    let entries;
    try {
      entries = readZip(zip.data);
    } catch (error) {
      return { ok: false, error: error?.message ?? 'Could not read the zip.' };
    }
    return pickPetFiles(entries);
  }

  /** @param {string} path */
  async function importPath(path) {
    let st;
    try {
      st = await stat(path);
    } catch {
      return { ok: false, error: 'The selected file was not found.' };
    }
    /** @type {{ ok: true, petJsonBuf: Buffer, imageBuf: Buffer } | { ok: false, error: string }} */
    let files;
    if (st.isDirectory()) files = await fromFolder(path);
    else if (/\.zip$/i.test(path)) files = await fromZip(path);
    else if (basename(path).toLowerCase() === 'pet.json') {
      files = await fromFolder(dirname(path));
    } else {
      return {
        ok: false,
        error: 'Choose a pet .zip or a pet folder’s pet.json.'
      };
    }
    if (!files.ok) return files;
    return store.install({
      source: 'import',
      petJsonBuf: files.petJsonBuf,
      imageBuf: files.imageBuf,
      meta: {}
    });
  }

  return {
    importPath,
    /** @returns {Promise<{ ok: true, pet: object|null } | { ok: false, error: string }>} */
    async importPet() {
      try {
        const result = await showOpenDialog({
          title: 'Import pet',
          buttonLabel: 'Import',
          properties:
            platform === 'darwin'
              ? ['openFile', 'openDirectory']
              : ['openFile'],
          filters: [
            { name: 'Pet (.zip or pet.json)', extensions: ['zip', 'json'] }
          ]
        });
        if (!result || result.canceled || !result.filePaths?.length) {
          return { ok: true, pet: null };
        }
        return await importPath(result.filePaths[0]);
      } catch (error) {
        return {
          ok: false,
          error: `Could not import the pet: ${error?.message ?? error}`
        };
      }
    }
  };
}
