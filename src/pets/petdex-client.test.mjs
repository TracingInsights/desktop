import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetdexClient,
  MANIFEST_CACHE_FILE,
  parseManifest,
  reshapeSearchPet,
  THUMB_CACHE_DIR,
  THUMB_MAX_AGE_MS
} from './petdex-client.mjs';
import { createPetStore } from './pet-store.mjs';
import {
  fakeDecodeImage,
  fakeMakeThumb,
  fakeWebp,
  petJson
} from './data-test-helpers.mjs';
import { PETDEX_MANIFEST_MAX_AGE_MS } from './contract.mjs';

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init
  });

const searchHit = (slug, extra = {}) => ({
  slug,
  displayName: `Pet ${slug}`,
  description: 'desc',
  spritesheetPath: `https://assets.petdex.dev/pets/${slug}-abc/sprite.webp`,
  zipUrl: `https://assets.petdex.dev/pets/${slug}-abc/zip.zip`,
  soundUrl: null,
  kind: 'character',
  vibes: ['cheerful'],
  tags: ['f1'],
  dominantColor: '#f37e0c',
  submittedBy: { name: 'someone', imageUrl: 'https://img.clerk.com/x' },
  spriteVersionNumber: 2,
  metrics: { installCount: 3 },
  ...extra
});

const manifestBody = {
  v: 2,
  generatedAt: '2026-11-06T04:29:39.151Z',
  total: 2,
  assetBase: 'https://assets.petdex.dev',
  fields: [
    'slug',
    'displayName',
    'kind',
    'submittedBy',
    'spritesheet',
    'petJson',
    'zip',
    'spriteVersionNumber'
  ],
  pets: [
    [
      'max-4',
      'Max',
      'character',
      'Dylan C.',
      'pets/max-1/sprite.webp',
      'pets/max-1/petjson.json',
      'pets/max-1/zip.zip',
      1
    ],
    [
      'lando',
      'Lando',
      'character',
      'X',
      'pets/lando-1/sprite.webp',
      'pets/lando-1/petjson.json',
      'pets/lando-1/zip.zip',
      2
    ],
    [
      'evil',
      'Evil',
      'character',
      'X',
      'https://evil.example/sprite.webp',
      'pets/evil/petjson.json',
      'z',
      1
    ],
    [
      'Bad Slug',
      'Bad',
      'character',
      'X',
      'pets/b/sprite.webp',
      'pets/b/petjson.json',
      'z',
      1
    ]
  ]
};

let root;
let calls;
let routes;
let clock;

function fakeFetch(url, init) {
  calls.push({ url, init });
  const route = routes[url.split('?')[0]];
  if (!route) return Promise.resolve(new Response('nope', { status: 404 }));
  return Promise.resolve(route(url, init));
}

function makeClient(overrides = {}) {
  const store = createPetStore({
    userDataDir: root,
    codexHome: null,
    decodeImage: fakeDecodeImage,
    makeThumb: fakeMakeThumb,
    getSettings: () => ({ scanCodexDir: false })
  });
  return createPetdexClient({
    fetch: fakeFetch,
    userDataDir: root,
    appVersion: '0.2.0',
    store,
    now: () => clock,
    ...overrides
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tif1ai-petdex-'));
  calls = [];
  clock = Date.parse('2026-11-06T12:00:00Z');
  routes = {
    'https://petdex.dev/api/pets/search': () =>
      json({
        pets: [searchHit('pia'), searchHit('max-4')],
        nextCursor: 2,
        total: 3,
        facets: {}
      }),
    'https://petdex.dev/api/manifest/v2': () =>
      new Response(null, {
        status: 307,
        headers: {
          location: 'https://assets.petdex.dev/manifests/petdex-v2.json'
        }
      }),
    'https://assets.petdex.dev/manifests/petdex-v2.json': (_url, init) =>
      init.headers['If-None-Match'] === 'W/"e1"'
        ? new Response(null, { status: 304 })
        : json(manifestBody, { headers: { etag: 'W/"e1"' } }),
    'https://assets.petdex.dev/pets/max-1/petjson.json': () =>
      new Response(petJson({ spritesheetPath: 'spritesheet.webp' })),
    'https://assets.petdex.dev/pets/max-1/sprite.webp': () =>
      new Response(fakeWebp(1536, 1872)),
    'https://petdex.dev/api/pets/max-4/track-zip': () => json({ ok: true })
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('search', () => {
  test('re-shapes to the allowlisted fields and sends our UA + params', async () => {
    const r = await makeClient().search({
      q: 'f1',
      sort: 'popular',
      cursor: 0,
      limit: 500
    });
    expect(r.ok).toBe(true);
    expect(r.nextCursor).toBe(2);
    expect(r.pets[0]).toEqual({
      slug: 'pia',
      displayName: 'Pet pia',
      description: 'desc',
      tags: ['f1'],
      kind: 'character',
      creator: 'someone',
      spriteUrl: 'https://assets.petdex.dev/pets/pia-abc/sprite.webp',
      spriteVersion: 2,
      pageUrl: 'https://petdex.dev/pets/pia'
    });
    const url = new URL(calls[0].url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'f1',
      sort: 'popular',
      cursor: '0',
      limit: '48'
    });
    expect(calls[0].init.headers['User-Agent']).toBe(
      'TracingInsightsDesktop/0.2.0 (+https://app.tracinginsights.com)'
    );
    expect(calls[0].init.redirect).toBe('manual');
  });

  test('drops pets whose sprite is off the asset origin', async () => {
    routes['https://petdex.dev/api/pets/search'] = () =>
      json({
        pets: [
          searchHit('a', { spritesheetPath: 'https://evil.example/s.webp' }),
          searchHit('b', { spritesheetPath: 'http://assets.petdex.dev/x' }),
          searchHit('c'),
          { slug: '../x' }
        ],
        nextCursor: null
      });
    const r = await makeClient().search({});
    expect(r.pets.map((p) => p.slug)).toEqual(['c']);
    expect(r.nextCursor).toBeNull();
  });

  test('rejects bad input and HTTP errors as envelopes', async () => {
    const client = makeClient();
    expect(await client.search({ sort: 'weird' })).toEqual({
      ok: false,
      error: 'Invalid sort.'
    });
    expect(await client.search({ cursor: -1 })).toMatchObject({ ok: false });
    routes['https://petdex.dev/api/pets/search'] = () =>
      new Response('x', { status: 429 });
    expect(await client.search({ q: 'a' })).toEqual({
      ok: false,
      error: 'Petdex answered HTTP 429.'
    });
    routes['https://petdex.dev/api/pets/search'] = () => new Response('<html>');
    expect((await client.search({ q: 'a' })).ok).toBe(false);
  });

  test('redirect to a non-allowlisted host is never fetched', async () => {
    routes['https://petdex.dev/api/pets/search'] = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/x' }
      });
    const r = await makeClient().search({ q: 'a' });
    expect(r).toEqual({
      ok: false,
      error: 'Blocked request to https://evil.example.'
    });
    expect(calls.map((c) => c.url).some((u) => u.includes('evil'))).toBe(false);
  });

  test('timeout → envelope error', async () => {
    const client = makeClient({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    });
    expect(await client.search({ q: 'a' })).toEqual({
      ok: false,
      error: 'Petdex timed out.'
    });
  });

  test('oversize body is refused', async () => {
    routes['https://petdex.dev/api/pets/search'] = () =>
      new Response('x'.repeat(3 * 1024 * 1024));
    expect(await makeClient().search({ q: 'a' })).toEqual({
      ok: false,
      error: 'Petdex response is too large.'
    });
  });

  test('reshapeSearchPet ignores junk', () => {
    expect(reshapeSearchPet(null)).toBeNull();
    expect(reshapeSearchPet({ slug: 'a' })).toBeNull();
  });
});

describe('manifest', () => {
  test('follows the asset redirect, parses, caches with ETag, 304 path', async () => {
    const client = makeClient();
    const r = await client.manifest();
    expect(r.ok).toBe(true);
    expect([...r.manifest.bySlug.keys()]).toEqual(['max-4', 'lando']);
    expect(r.manifest.bySlug.get('max-4')).toEqual({
      slug: 'max-4',
      displayName: 'Max',
      kind: 'character',
      submittedBy: 'Dylan C.',
      spriteUrl: 'https://assets.petdex.dev/pets/max-1/sprite.webp',
      petJsonUrl: 'https://assets.petdex.dev/pets/max-1/petjson.json',
      spriteVersion: 1
    });
    expect(
      JSON.parse(readFileSync(join(root, MANIFEST_CACHE_FILE), 'utf8')).etag
    ).toBe('W/"e1"');

    // Fresh: no request at all.
    calls = [];
    await client.manifest();
    expect(calls).toEqual([]);

    // Stale: a new client reads the disk cache and revalidates with If-None-Match.
    clock += PETDEX_MANIFEST_MAX_AGE_MS + 1;
    const again = makeClient();
    const r2 = await again.manifest();
    expect(r2.ok).toBe(true);
    expect(r2.manifest.bySlug.size).toBe(2);
    expect(calls.map((c) => c.init.headers['If-None-Match'])).toEqual([
      'W/"e1"',
      'W/"e1"'
    ]);
  });

  test('offline with a stale cache keeps the cache; without one → envelope', async () => {
    await makeClient().manifest();
    clock += PETDEX_MANIFEST_MAX_AGE_MS + 1;
    routes['https://assets.petdex.dev/manifests/petdex-v2.json'] = () =>
      new Response('down', { status: 503 });
    expect((await makeClient().manifest()).ok).toBe(true);
    rmSync(join(root, MANIFEST_CACHE_FILE));
    expect(await makeClient().manifest()).toEqual({
      ok: false,
      error: 'Petdex answered HTTP 503.'
    });
  });

  test('parseManifest rejects wrong versions and foreign asset bases', () => {
    expect(parseManifest({ v: 1, pets: [] })).toBeNull();
    expect(
      parseManifest({ ...manifestBody, assetBase: 'https://evil.example' })
    ).toBeNull();
    // Fields are looked up by name, not position.
    const swapped = parseManifest({
      v: 2,
      assetBase: 'https://assets.petdex.dev',
      fields: ['petJson', 'spritesheet', 'slug'],
      pets: [['pets/a/p.json', 'pets/a/s.webp', 'a']]
    });
    expect(swapped.bySlug.get('a').spriteUrl).toBe(
      'https://assets.petdex.dev/pets/a/s.webp'
    );
  });
});

describe('shelf', () => {
  test('curated first, then search terms, deduped, deny removed', async () => {
    let n = 0;
    routes['https://petdex.dev/api/pets/search'] = (url) => {
      const q = new URL(url).searchParams.get('q');
      n++;
      return json({
        pets:
          q === 'f1'
            ? [searchHit('pia'), searchHit('max-4')]
            : [searchHit('senna'), searchHit('pia')],
        nextCursor: null
      });
    };
    const r = await makeClient().shelf({
      terms: ['f1', 'race-car'],
      curated: ['lando', 'unknown', 'max-4'],
      deny: ['senna']
    });
    expect(r.ok).toBe(true);
    expect(r.pets.map((p) => p.slug)).toEqual(['lando', 'max-4', 'pia']);
    expect(r.pets[0]).toMatchObject({
      description: null,
      creator: 'X',
      spriteVersion: 2,
      pageUrl: 'https://petdex.dev/pets/lando'
    });
    expect(n).toBe(2);
  });

  test('partial failure still returns what worked; total failure → error', async () => {
    routes['https://petdex.dev/api/pets/search'] = () =>
      new Response('x', { status: 500 });
    const partial = await makeClient().shelf({
      terms: ['f1'],
      curated: ['lando'],
      deny: []
    });
    expect(partial.ok && partial.pets.map((p) => p.slug)).toEqual(['lando']);
    rmSync(join(root, MANIFEST_CACHE_FILE));
    delete routes['https://assets.petdex.dev/manifests/petdex-v2.json'];
    expect(
      (
        await makeClient().shelf({
          terms: ['f1'],
          curated: ['lando'],
          deny: []
        })
      ).ok
    ).toBe(false);
  });
});

describe('install', () => {
  test('downloads, validates, stores and pings track-zip', async () => {
    const r = await makeClient().install('max-4');
    expect(r.ok).toBe(true);
    expect(r.pet).toMatchObject({
      id: 'petdex:max-4',
      creator: 'Dylan C.',
      pageUrl: 'https://petdex.dev/pets/max-4'
    });
    expect(
      existsSync(join(root, 'pets', 'petdex-max-4', 'spritesheet.webp'))
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ping = calls.find((c) => c.url.endsWith('/track-zip'));
    expect(ping.init.method).toBe('POST');
  });

  test('ping failure is ignored', async () => {
    routes['https://petdex.dev/api/pets/max-4/track-zip'] = () => {
      throw new Error('offline');
    };
    expect((await makeClient().install('max-4')).ok).toBe(true);
  });

  test('unknown / invalid slug, bad art, oversize sprite', async () => {
    const client = makeClient();
    expect(await client.install('../x')).toEqual({
      ok: false,
      error: 'Invalid Petdex slug.'
    });
    expect(await client.install('nobody')).toEqual({
      ok: false,
      error: 'That pet is not on Petdex.'
    });
    routes['https://assets.petdex.dev/pets/max-1/sprite.webp'] = () =>
      new Response(fakeWebp(10, 10));
    expect((await client.install('max-4')).ok).toBe(false);
    routes['https://assets.petdex.dev/pets/max-1/sprite.webp'] = () =>
      new Response('x', {
        headers: { 'content-length': String(9 * 1024 * 1024) }
      });
    expect(await client.install('max-4')).toEqual({
      ok: false,
      error: 'Petdex response is too large.'
    });
    expect(calls.some((c) => c.url.endsWith('/track-zip'))).toBe(false);
  });
});

describe('thumbs (gallery previews)', () => {
  const thumbUrl = (slug) => `https://petdex.dev/api/pets/${slug}/thumb`;
  const assetUrl = (slug) =>
    `https://assets.petdex.dev/pets/${slug}/thumb.webp`;

  test('follows the redirect, returns data: URLs and caches on disk', async () => {
    const webp = fakeWebp(80, 80);
    routes[thumbUrl('lando')] = () =>
      new Response(null, {
        status: 308,
        headers: { location: assetUrl('lando') }
      });
    routes[assetUrl('lando')] = () => new Response(webp);
    routes[thumbUrl('senna')] = () => new Response('<html>no</html>');
    const client = makeClient();
    const res = await client.thumbs(['lando', 'senna', 'lando', '../x']);
    expect(res.ok).toBe(true);
    expect(res.thumbs.lando).toBe(
      `data:image/webp;base64,${Buffer.from(webp).toString('base64')}`
    );
    // Not a WebP: no preview rather than an arbitrary body.
    expect(res.thumbs.senna).toBeNull();
    expect(Object.keys(res.thumbs).sort()).toEqual(['lando', 'senna']);
    expect(existsSync(join(root, THUMB_CACHE_DIR, 'lando.webp'))).toBe(true);
    // Never sends our site as referrer: no Referer header at all.
    for (const call of calls)
      expect(call.init?.headers?.Referer).toBeUndefined();

    // A fresh client reads the disk cache instead of the network.
    calls = [];
    const again = await makeClient().thumbs(['lando']);
    expect(again.thumbs.lando).toBe(res.thumbs.lando);
    expect(calls).toEqual([]);

    // Older than a week: fetched again.
    clock += THUMB_MAX_AGE_MS + 1000;
    calls = [];
    await makeClient().thumbs(['lando']);
    expect(calls.map((c) => c.url)).toContain(thumbUrl('lando'));
  });
});
