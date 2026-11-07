import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import {
  PET_PAGE_CSP,
  PET_PAGE_URL,
  createPetProtocolHandlers,
  parsePetAssetUrl,
  petAssetUrl,
  resolvePetPageFile
} from './protocols.mjs';

const root = '/opt/app/src/pet';

describe('resolvePetPageFile', () => {
  test('serves bundled files by name', () => {
    expect(resolvePetPageFile(PET_PAGE_URL, root)).toEqual({
      path: join(root, 'index.html'),
      name: 'index.html',
      mime: 'text/html; charset=utf-8'
    });
    expect(resolvePetPageFile('app://pet/pet.css', root)?.mime).toBe(
      'text/css; charset=utf-8'
    );
    expect(resolvePetPageFile('app://pet/pet.js?x=1', root)?.name).toBe(
      'pet.js'
    );
  });

  test('rejects traversal, sub-paths, other hosts and extensions', () => {
    const bad = [
      'app://pet/../main.mjs',
      'app://pet/%2e%2e/preload.cjs',
      'app://pet/..%2Fpets%2Fcontract.js',
      'app://pet/%2e%2e%2f%2e%2e%2fpackage.js',
      'app://pet/sub/pet.js',
      'app://pet/..\\main.js',
      'app://pet/%5c..%5cmain.js',
      'app://pet/',
      'app://pet/.hidden.js',
      'app://pet/pet.mjs',
      'app://pet/pet.cjs',
      'app://pet/PET.JS',
      'app://pet/a%00.js',
      'app://other/index.html',
      'pet-asset://pet/index.html',
      'https://pet/index.html',
      'app://pet/%E0%A4%A.js',
      'not a url'
    ];
    for (const url of bad) expect(resolvePetPageFile(url, root)).toBeNull();
  });
});

describe('pet-asset URLs', () => {
  test('round-trip ids with colons and percent signs', () => {
    for (const id of [
      'petdex:lando',
      'codex:my%20pet',
      'import:6b1f0c1e-uuid'
    ]) {
      expect(parsePetAssetUrl(petAssetUrl(id, 3))).toBe(id);
    }
    expect(petAssetUrl('petdex:lando')).toBe(
      'pet-asset://pet/petdex%3Alando/sprite'
    );
  });

  test('rejects anything else', () => {
    for (const url of [
      'pet-asset://other/petdex%3Alando/sprite',
      'pet-asset://pet/petdex%3Alando/other',
      'pet-asset://pet/a/b/sprite',
      'pet-asset://pet/%2e%2e%2fx/sprite',
      'pet-asset://pet/%E0%A4%A/sprite',
      'app://pet/petdex%3Alando/sprite'
    ]) {
      expect(parsePetAssetUrl(url)).toBeNull();
    }
  });
});

describe('createPetProtocolHandlers', () => {
  const files = new Map([
    [join(root, 'index.html'), new TextEncoder().encode('<!doctype html>')],
    ['/data/pets/petdex-lando/spritesheet.webp', new Uint8Array([1, 2, 3])]
  ]);
  const readFile = async (path) => {
    const body = files.get(path);
    if (!body) throw new Error('ENOENT');
    return body;
  };
  const store = {
    resolveAsset: (id) =>
      id === 'petdex:lando'
        ? {
            path: '/data/pets/petdex-lando/spritesheet.webp',
            mime: 'image/webp'
          }
        : null
  };
  const handlers = createPetProtocolHandlers({
    rootDir: root,
    store,
    readFile
  });
  const get = (url) => new Request(url);

  test('page: 200 with CSP + nosniff', async () => {
    const res = await handlers.page(get(PET_PAGE_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(PET_PAGE_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('page: traversal and missing files → 404', async () => {
    expect(
      (await handlers.page(get('app://pet/%2e%2e%2fmain.js'))).status
    ).toBe(404);
    expect((await handlers.page(get('app://pet/missing.js'))).status).toBe(404);
    expect(
      (
        await handlers.page(
          new Request(PET_PAGE_URL, { method: 'POST', body: 'x' })
        )
      ).status
    ).toBe(404);
  });

  test('asset: serves the store-resolved sprite only', async () => {
    const ok = await handlers.asset(get(petAssetUrl('petdex:lando', 1)));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect((await handlers.asset(get(petAssetUrl('petdex:nope')))).status).toBe(
      404
    );
  });

  test('asset: a throwing store is a 404', async () => {
    const broken = createPetProtocolHandlers({
      rootDir: root,
      store: {
        resolveAsset: () => {
          throw new Error('boom');
        }
      },
      readFile
    });
    expect((await broken.asset(get(petAssetUrl('petdex:lando')))).status).toBe(
      404
    );
  });
});

describe('bundled pet page (desktop/src/pet)', () => {
  const realRoot = join(import.meta.dir, '..', 'pet');
  const real = createPetProtocolHandlers({
    rootDir: realRoot,
    store: { resolveAsset: () => null }
  });

  test('index.html carries the same CSP as the response header', async () => {
    const res = await real.page(new Request(PET_PAGE_URL));
    expect(res.status).toBe(200);
    const html = await res.text();
    const meta =
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(meta?.[1]).toBe(PET_PAGE_CSP);
  });

  test('every local asset the page references is servable; nothing remote', async () => {
    const html = await (await real.page(new Request(PET_PAGE_URL))).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(['pet.css', 'pet.js']);
    for (const ref of refs) {
      const res = await real.page(new Request(`app://pet/${ref}`));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toMatch(/https?:\/\//);
    }
  });

  test('the page script only talks to petBridge (no require/fetch/eval)', async () => {
    const js = await (await real.page(new Request('app://pet/pet.js'))).text();
    for (const banned of [
      'require(',
      'fetch(',
      'eval(',
      'new Function',
      'XMLHttpRequest',
      'innerHTML'
    ]) {
      expect(js).not.toContain(banned);
    }
    expect(js).toContain('window.petBridge');
  });
});
