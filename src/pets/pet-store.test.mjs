import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetStore,
  encodeFolderName,
  parsePetId,
  petFolderHomes
} from './pet-store.mjs';
import {
  fakeDecodeImage,
  fakeMakeThumb,
  fakePng,
  fakeWebp,
  petJson
} from './data-test-helpers.mjs';

let root;
let userDataDir;
let codexHome;
let petdexHome;
let settings;
let decodeCalls;

function makeStore(overrides = {}) {
  return createPetStore({
    userDataDir,
    codexHome,
    petdexHome,
    decodeImage: (buf) => {
      decodeCalls++;
      return fakeDecodeImage(buf);
    },
    makeThumb: fakeMakeThumb,
    getSettings: () => settings,
    now: () => Date.parse('2026-11-06T10:00:00Z'),
    ...overrides
  });
}

function codexPet(folder, fields = {}, image = fakePng(1536, 1872)) {
  return folderPet(codexHome, folder, fields, image);
}

/** A pet as `npx petdex install` leaves it in ~/.petdex/pets. */
function cliPet(folder, fields = {}, image = fakePng(1536, 1872)) {
  return folderPet(petdexHome, folder, fields, image);
}

function folderPet(home, folder, fields, image) {
  const dir = join(home, 'pets', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pet.json'),
    petJson({ displayName: folder, ...fields })
  );
  writeFileSync(join(dir, fields.spritesheetPath ?? 'spritesheet.png'), image);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tif1ai-pet-store-'));
  userDataDir = join(root, 'userData');
  codexHome = join(root, 'codex');
  petdexHome = join(root, 'petdex');
  mkdirSync(userDataDir);
  settings = { scanCodexDir: true };
  decodeCalls = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pet store', () => {
  test('install petdex pet → list, get, resolveAsset', () => {
    const store = makeStore();
    const r = store.install({
      source: 'petdex',
      slug: 'max-4',
      petJsonBuf: petJson({ spritesheetPath: 'whatever.webp' }),
      imageBuf: fakeWebp(1536, 1872),
      meta: {
        creator: 'Dylan C.',
        tags: ['f1', 42, 'x'.repeat(100)],
        pageUrl: 'https://evil.example'
      }
    });
    expect(r).toEqual({
      ok: true,
      pet: {
        id: 'petdex:max-4',
        source: 'petdex',
        displayName: 'Test Pet',
        description: 'A generated test pet.',
        creator: 'Dylan C.',
        slug: 'max-4',
        pageUrl: 'https://petdex.dev/pets/max-4',
        thumb: 'data:image/png;base64,thumb-1',
        removable: true
      }
    });
    const dir = join(userDataDir, 'pets', 'petdex-max-4');
    expect(readdirSync(dir).sort()).toEqual([
      'pet.json',
      'source.json',
      'spritesheet.webp'
    ]);
    const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    expect(source).toMatchObject({
      source: 'petdex',
      slug: 'max-4',
      installedAt: '2026-11-06T10:00:00.000Z'
    });
    expect(source.tags).toEqual(['f1', 'x'.repeat(40)]);
    expect(store.list().map((p) => p.id)).toEqual(['petdex:max-4']);
    expect(store.get('petdex:max-4')).toMatchObject({
      source: 'petdex',
      dir,
      imagePath: join(dir, 'spritesheet.webp'),
      mime: 'image/webp',
      atlas: { version: 1, rows: 9 }
    });
    expect(store.resolveAsset('petdex:max-4')).toEqual({
      path: join(dir, 'spritesheet.webp'),
      mime: 'image/webp'
    });
    expect(store.resolveAsset('petdex:nope')).toBeNull();
  });

  test('validation failure leaves nothing behind', () => {
    const store = makeStore();
    const r = store.install({
      source: 'import',
      petJsonBuf: petJson(),
      imageBuf: fakePng(10, 10)
    });
    expect(r.ok).toBe(false);
    let left = [];
    try {
      left = readdirSync(join(userDataDir, 'pets'));
    } catch {
      // never created
    }
    expect(left).toEqual([]);
  });

  test('bad slug / source rejected', () => {
    const store = makeStore();
    const base = { petJsonBuf: petJson(), imageBuf: fakePng(1536, 1872) };
    expect(store.install({ ...base, source: 'petdex', slug: '../x' }).ok).toBe(
      false
    );
    expect(store.install({ ...base, source: 'codex' }).ok).toBe(false);
  });

  test('import gets a uuid id; reinstall replaces; remove', () => {
    const store = makeStore();
    const imported = store.install({
      source: 'import',
      petJsonBuf: petJson(),
      imageBuf: fakePng(1536, 1872)
    });
    expect(imported.pet.id).toMatch(/^import:[0-9a-f-]{36}$/);
    expect(imported.pet.pageUrl).toBeNull();
    const base = {
      source: 'petdex',
      slug: 'lando',
      imageBuf: fakePng(1536, 1872)
    };
    store.install({ ...base, petJsonBuf: petJson({ displayName: 'One' }) });
    store.install({ ...base, petJsonBuf: petJson({ displayName: 'Two' }) });
    const names = store.list().map((p) => p.displayName);
    expect(names).toContain('Two');
    expect(names).not.toContain('One');
    expect(
      readdirSync(join(userDataDir, 'pets')).filter((n) => n.startsWith('.'))
    ).toEqual([]);
    expect(store.remove('petdex:lando')).toEqual({ ok: true });
    expect(store.remove('petdex:lando').ok).toBe(false);
    expect(store.remove(imported.pet.id)).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
  });

  test('codex pets: listed read-only, invalid skipped, symlinks skipped, setting respected', () => {
    codexPet('good pet');
    codexPet('wrong-size', {}, fakePng(100, 100));
    codexPet('escape', { spritesheetPath: '../escape.png' });
    mkdirSync(join(codexHome, 'pets', 'empty'));
    const outside = codexPet('outside-target');
    symlinkSync(outside, join(codexHome, 'pets', 'linked'));
    const linkedSprite = codexPet('linked-sprite', {
      spritesheetPath: 'sheet.png'
    });
    rmSync(join(linkedSprite, 'sheet.png'));
    symlinkSync(
      join(outside, 'spritesheet.png'),
      join(linkedSprite, 'sheet.png')
    );

    const store = makeStore();
    const pets = store.list();
    expect(pets.map((p) => p.id)).toEqual([
      'codex:good%20pet',
      'codex:outside-target'
    ]);
    expect(pets[0]).toMatchObject({
      source: 'codex',
      removable: false,
      slug: null,
      creator: null
    });
    expect(store.remove('codex:good%20pet').ok).toBe(false);
    expect(readdirSync(join(codexHome, 'pets')).sort()).toContain('good pet');
    expect(store.get('codex:good%20pet')?.mime).toBe('image/png');

    settings = { scanCodexDir: false };
    expect(store.list()).toEqual([]);
    expect(store.get('codex:good%20pet')).toBeNull();
  });

  test('Petdex CLI folder: listed read-only, never written, setting respected', () => {
    const dir = cliPet(
      'boba',
      { spritesheetPath: 'spritesheet.webp' },
      fakeWebp(1536, 2288)
    );
    cliPet('broken', {}, fakePng(100, 100));
    const before = readdirSync(dir).sort();
    const store = makeStore();
    expect(store.list()).toEqual([
      {
        id: 'petdex-cli:boba',
        source: 'petdex-cli',
        displayName: 'boba',
        description: 'A generated test pet.',
        creator: null,
        slug: null,
        pageUrl: null,
        thumb: 'data:image/png;base64,thumb-2',
        removable: false
      }
    ]);
    expect(store.get('petdex-cli:boba')).toMatchObject({
      source: 'petdex-cli',
      dir,
      mime: 'image/webp',
      atlas: { version: 2, rows: 11 }
    });
    expect(store.resolveAsset('petdex-cli:boba')).toEqual({
      path: join(dir, 'spritesheet.webp'),
      mime: 'image/webp'
    });
    expect(store.remove('petdex-cli:boba')).toEqual({
      ok: false,
      error: 'Petdex CLI pets are managed by Petdex.'
    });
    // The same folder name never resolves in the other root.
    expect(store.get('codex:boba')).toBeNull();
    expect(readdirSync(dir).sort()).toEqual(before);

    settings = { scanCodexDir: false };
    expect(store.list()).toEqual([]);
    expect(store.get('petdex-cli:boba')).toBeNull();
  });

  test('one install in both folders is listed once, as the Petdex CLI copy', () => {
    // `npx petdex install` writes identical bytes into both folders.
    cliPet('boba');
    codexPet('boba');
    // Same name, different sheet: two different pets.
    cliPet('lando', {}, fakePng(1536, 1872, 1));
    codexPet('lando', {}, fakePng(1536, 1872, 2));
    // Same sheet, different folder names: not the same install.
    codexPet('boba-copy');
    const store = makeStore();
    expect(store.list().map((p) => p.id)).toEqual([
      'petdex-cli:boba',
      'petdex-cli:lando',
      'codex:boba-copy',
      'codex:lando'
    ]);
    // An id saved before (codex:<folder>) still resolves.
    expect(store.get('codex:boba')?.dir).toBe(join(codexHome, 'pets', 'boba'));
    expect(store.getListed('codex:boba')?.id).toBe('codex:boba');
  });

  test('a duplicate in use keeps its own id in the list', () => {
    cliPet('boba');
    codexPet('boba');
    const store = makeStore();
    settings = { scanCodexDir: true, activePetId: 'codex:boba' };
    expect(store.list().map((p) => p.id)).toEqual(['codex:boba']);
    settings = { scanCodexDir: true, secondPetId: 'codex:boba' };
    expect(store.list().map((p) => p.id)).toEqual(['codex:boba']);
    settings = {
      scanCodexDir: true,
      activePetId: 'petdex-cli:boba',
      secondPetId: 'codex:boba'
    };
    expect(store.list().map((p) => p.id)).toEqual([
      'petdex-cli:boba',
      'codex:boba'
    ]);
    settings = { scanCodexDir: true, activePetId: 'petdex-cli:boba' };
    expect(store.list().map((p) => p.id)).toEqual(['petdex-cli:boba']);
  });

  test('folder homes: $CODEX_HOME is honoured, ~/.petdex always', () => {
    expect(petFolderHomes({ env: {}, homeDir: '/home/u' })).toEqual({
      codexHome: join('/home/u', '.codex'),
      petdexHome: join('/home/u', '.petdex')
    });
    // The Petdex CLI reads no $PETDEX_HOME (petdex-cli bin/petdex.ts).
    expect(
      petFolderHomes({
        env: { CODEX_HOME: '/opt/codex', PETDEX_HOME: '/opt/petdex' },
        homeDir: '/home/u'
      })
    ).toEqual({
      codexHome: '/opt/codex',
      petdexHome: join('/home/u', '.petdex')
    });
  });

  test('missing codex home is fine', () => {
    expect(
      createPetStore({
        ...{},
        userDataDir,
        codexHome: null,
        decodeImage: fakeDecodeImage,
        makeThumb: fakeMakeThumb,
        getSettings: () => settings
      }).list()
    ).toEqual([]);
    expect(makeStore().list()).toEqual([]);
  });

  test('validation is cached until the files change', () => {
    codexPet('a');
    const store = makeStore();
    store.list();
    store.list();
    store.get('codex:a');
    expect(decodeCalls).toBe(1);
  });

  test('a thumb failure still lists the pet', () => {
    codexPet('a');
    const store = makeStore({
      makeThumb: () => {
        throw new Error('no');
      }
    });
    expect(store.list()[0].thumb).toBe('');
  });

  test('ids', () => {
    expect(encodeFolderName('my pet/é')).toBe('my%20pet%2F%C3%A9');
    expect(parsePetId('codex:my%20pet')).toEqual({
      source: 'codex',
      key: 'my%20pet'
    });
    expect(parsePetId('petdex-cli:boba')).toEqual({
      source: 'petdex-cli',
      key: 'boba'
    });
    expect(parsePetId('petdex-cli:%2E%2E')).toBeNull();
    expect(parsePetId('codex:%2E%2E')).toBeNull();
    expect(parsePetId('codex:a%2Fb')).toBeNull();
    expect(parsePetId('import:not-a-uuid')).toBeNull();
    expect(parsePetId('petdex:UPPER')).toBeNull();
    expect(parsePetId(5)).toBeNull();
  });
});
