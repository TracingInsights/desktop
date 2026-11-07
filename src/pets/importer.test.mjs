import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImporter, pickPetFiles } from './importer.mjs';
import { createPetStore } from './pet-store.mjs';
import {
  fakeDecodeImage,
  fakeMakeThumb,
  fakePng,
  makeZip,
  petJson
} from './data-test-helpers.mjs';

let root;
let store;
let picked;

const sprite = fakePng(1536, 1872);

function importer(platform = 'linux') {
  return createImporter({
    showOpenDialog: async () => picked,
    store,
    readFile: (p) => readFileSync(p),
    stat: (p) => statSync(p),
    platform
  });
}

function writeZip(entries, name = 'pet.zip') {
  const path = join(root, name);
  writeFileSync(path, makeZip(entries));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tif1ai-importer-'));
  mkdirSync(join(root, 'userData'));
  store = createPetStore({
    userDataDir: join(root, 'userData'),
    codexHome: null,
    decodeImage: fakeDecodeImage,
    makeThumb: fakeMakeThumb,
    getSettings: () => ({ scanCodexDir: false })
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('importer', () => {
  test('cancel → ok with null pet', async () => {
    picked = { canceled: true, filePaths: [] };
    expect(await importer().importPet()).toEqual({ ok: true, pet: null });
  });

  test('flat zip', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'pet.json', data: petJson() },
          { name: 'spritesheet.png', data: sprite }
        ])
      ]
    };
    const r = await importer().importPet();
    expect(r.ok).toBe(true);
    expect(r.pet).toMatchObject({
      source: 'import',
      displayName: 'Test Pet',
      removable: true
    });
    expect(store.list()).toHaveLength(1);
  });

  test('nested folder zip with macOS junk', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'lando/', data: '', method: 0 },
          { name: 'lando/pet.json', data: petJson() },
          { name: 'lando/spritesheet.png', data: sprite },
          { name: '__MACOSX/lando/._pet.json', data: 'junk' },
          { name: 'lando/.DS_Store', data: 'junk' }
        ])
      ]
    };
    expect((await importer().importPet()).ok).toBe(true);
  });

  test('deeper nesting is not found', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'a/b/pet.json', data: petJson() },
          { name: 'a/b/spritesheet.png', data: sprite }
        ])
      ]
    };
    expect(await importer().importPet()).toMatchObject({
      ok: false,
      error: 'No pet.json found in the zip.'
    });
  });

  test('zip-slip entry is rejected', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'pet.json', data: petJson() },
          { name: '../spritesheet.png', data: sprite }
        ])
      ]
    };
    const r = await importer().importPet();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Unsafe path');
  });

  test('symlink entry is rejected', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'pet.json', data: petJson() },
          {
            name: 'spritesheet.png',
            data: '/etc/passwd',
            externalAttrs: (0o120777 << 16) >>> 0
          }
        ])
      ]
    };
    expect((await importer().importPet()).error).toContain('Symbolic links');
  });

  test('too many entries', async () => {
    const entries = [
      { name: 'pet.json', data: petJson() },
      { name: 'spritesheet.png', data: sprite }
    ];
    for (let i = 0; i < 7; i++) entries.push({ name: `x${i}.txt`, data: 'x' });
    picked = { canceled: false, filePaths: [writeZip(entries)] };
    expect((await importer().importPet()).error).toContain(
      'more than 8 entries'
    );
  });

  test('zip bomb (uncompressed cap)', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'pet.json', data: petJson() },
          { name: 'spritesheet.png', data: Buffer.alloc(21 * 1024 * 1024) }
        ])
      ]
    };
    expect((await importer().importPet()).error).toContain('too large');
  });

  test('two pet.json files are ambiguous; missing sprite reported', async () => {
    picked = {
      canceled: false,
      filePaths: [
        writeZip([
          { name: 'a/pet.json', data: petJson() },
          { name: 'b/pet.json', data: petJson() }
        ])
      ]
    };
    expect((await importer().importPet()).error).toContain('more than one');
    picked = {
      canceled: false,
      filePaths: [writeZip([{ name: 'pet.json', data: petJson() }], 'b.zip')]
    };
    expect((await importer().importPet()).error).toContain('spritesheet.png');
  });

  test('folder import via pet.json and via the folder itself (macOS)', async () => {
    const dir = join(root, 'my-pet');
    mkdirSync(dir);
    writeFileSync(join(dir, 'pet.json'), petJson());
    writeFileSync(join(dir, 'spritesheet.png'), sprite);
    picked = { canceled: false, filePaths: [join(dir, 'pet.json')] };
    expect((await importer().importPet()).ok).toBe(true);
    picked = { canceled: false, filePaths: [dir] };
    expect((await importer('darwin').importPet()).ok).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  test('folder with an escaping spritesheetPath / invalid image', async () => {
    const dir = join(root, 'bad');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'pet.json'),
      petJson({ spritesheetPath: '../x.png' })
    );
    picked = { canceled: false, filePaths: [dir] };
    expect((await importer().importPet()).ok).toBe(false);
    writeFileSync(join(dir, 'pet.json'), petJson());
    writeFileSync(join(dir, 'spritesheet.png'), fakePng(10, 10));
    expect((await importer().importPet()).ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test('other file types are refused; dialog options per platform', async () => {
    writeFileSync(join(root, 'x.png'), sprite);
    picked = { canceled: false, filePaths: [join(root, 'x.png')] };
    expect((await importer().importPet()).ok).toBe(false);
    let options;
    const imp = createImporter({
      showOpenDialog: async (o) => {
        options = o;
        return { canceled: true, filePaths: [] };
      },
      store,
      readFile: readFileSync,
      stat: statSync,
      platform: 'darwin'
    });
    await imp.importPet();
    expect(options.properties).toEqual(['openFile', 'openDirectory']);
  });

  test('dialog failure → envelope', async () => {
    const imp = createImporter({
      showOpenDialog: async () => {
        throw new Error('no display');
      },
      store,
      readFile: readFileSync,
      stat: statSync
    });
    expect(await imp.importPet()).toMatchObject({ ok: false });
  });

  test('pickPetFiles ignores junk pet.json copies', () => {
    const r = pickPetFiles([
      { name: '__MACOSX/._pet.json', data: Buffer.from('x') },
      { name: 'pet.json', data: petJson() },
      { name: 'spritesheet.png', data: sprite }
    ]);
    expect(r.ok).toBe(true);
  });
});
