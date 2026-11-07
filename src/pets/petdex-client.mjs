/**
 * Desktop pets — Petdex client (docs/DESKTOP_PETS_PLAN.md §3, §4.3, D4, D15).
 *
 * Only the main process talks to Petdex, only to PETDEX_ORIGIN (API) and
 * PETDEX_ASSET_ORIGIN (files; the v2 manifest redirects there). Redirects
 * are followed by hand so every hop is origin-checked before it is fetched;
 * bodies are size-capped while streaming; every request times out after
 * PETDEX_TIMEOUT_MS. Responses are re-shaped to the allowlisted PetdexPet
 * fields (contract.ts) — nothing else reaches the page.
 *
 * Facts checked 2026-11-06: search returns `{ pets: [{ slug, displayName,
 * description, spritesheetPath (absolute asset URL), zipUrl, kind, tags,
 * submittedBy: { name }, spriteVersionNumber, … }], nextCursor }`;
 * `/api/manifest/v2` 307s to assets.petdex.dev/manifests/petdex-v2.json
 * (weak ETag); `POST /api/pets/<slug>/track-zip` counts a download and lets
 * non-browser clients (no Origin / Sec-Fetch-Site) through.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  LIMITS,
  PETDEX_ASSET_ORIGIN,
  PETDEX_MANIFEST_MAX_AGE_MS,
  PETDEX_ORIGIN,
  PETDEX_SEARCH_MAX_LIMIT,
  PETDEX_TIMEOUT_MS
} from './contract.mjs';
import { isPetdexSlug, petdexPageUrl } from './pet-store.mjs';

export const MANIFEST_CACHE_FILE = 'petdex-manifest.json';
export const PETDEX_SORTS = Object.freeze([
  'popular',
  'recent',
  'alpha',
  'curated'
]);
const SEARCH_DEFAULT_LIMIT = 24;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_CHARS = 100;
const MAX_SHELF_ITEMS = 50;
const MAX_REDIRECTS = 3;
const ALLOWED_ORIGINS = new Set([PETDEX_ORIGIN, PETDEX_ASSET_ORIGIN]);
/**
 * Gallery previews: Petdex's assets refuse other sites' referrers (hotlink
 * protection), so the page cannot show them directly. The main process
 * fetches each pet's 80×80 `thumb.webp` (≈ 2 KB) without a referrer, like an
 * install, and hands the page a data: URL. Cached in userData for a week.
 */
export const THUMB_CACHE_DIR = 'petdex-thumbs';
export const THUMB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const THUMB_MAX_BYTES = 64 * 1024;
export const THUMBS_PER_CALL = 48;
const THUMB_CONCURRENCY = 6;

/** RIFF…WEBP magic. */
export function isWebp(buf) {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}
const MANIFEST_FIELDS = Object.freeze([
  'slug',
  'displayName',
  'kind',
  'submittedBy',
  'spritesheet',
  'petJson',
  'zip',
  'spriteVersionNumber'
]);

/** @param {unknown} v @param {number} max */
function capText(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t ? [...t].slice(0, max).join('') : null;
}

/** An https URL on the Petdex asset origin, else null. @param {unknown} value */
export function assetUrl(value, base = PETDEX_ASSET_ORIGIN) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, `${base}/`);
    if (url.origin !== PETDEX_ASSET_ORIGIN || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function petdexPet({
  slug,
  displayName,
  description,
  tags,
  kind,
  creator,
  spriteUrl,
  spriteVersion
}) {
  return {
    slug,
    displayName: capText(displayName, LIMITS.displayNameChars) ?? slug,
    description: capText(description, LIMITS.descriptionChars),
    tags: Array.isArray(tags)
      ? tags
          .map((t) => capText(t, 40))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    kind: capText(kind, 40),
    creator: capText(creator, 80),
    spriteUrl,
    spriteVersion: spriteVersion === 2 ? 2 : 1,
    pageUrl: petdexPageUrl(slug)
  };
}

/**
 * Re-shape one search hit to PetdexPet; null when the slug or sprite URL
 * fails the allowlist.
 * @param {any} raw
 */
export function reshapeSearchPet(raw) {
  if (!raw || typeof raw !== 'object' || !isPetdexSlug(raw.slug)) return null;
  const spriteUrl = assetUrl(raw.spritesheetPath);
  if (!spriteUrl || !/^https:/.test(raw.spritesheetPath)) return null;
  return petdexPet({
    slug: raw.slug,
    displayName: raw.displayName,
    description: raw.description,
    tags: raw.tags,
    kind: raw.kind,
    creator: raw.submittedBy?.name,
    spriteUrl,
    spriteVersion: raw.spriteVersionNumber
  });
}

/**
 * Parse a v2 manifest into a slug index. Rows whose asset paths leave the
 * asset origin are dropped.
 * @param {any} raw
 * @returns {{ generatedAt: string|null, assetBase: string, bySlug: Map<string, { slug: string, displayName: string, kind: string|null, submittedBy: string|null, spriteUrl: string, petJsonUrl: string, spriteVersion: 1|2 }> } | null}
 */
export function parseManifest(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.v !== 2 ||
    !Array.isArray(raw.pets)
  ) {
    return null;
  }
  const fields = Array.isArray(raw.fields) ? raw.fields : MANIFEST_FIELDS;
  const at = Object.fromEntries(
    MANIFEST_FIELDS.map((f) => [f, fields.indexOf(f)])
  );
  if (at.slug < 0 || at.spritesheet < 0 || at.petJson < 0) return null;
  const assetBase =
    typeof raw.assetBase === 'string' ? raw.assetBase.replace(/\/+$/, '') : '';
  if (assetUrl(assetBase) === null) return null;
  const bySlug = new Map();
  for (const row of raw.pets) {
    if (!Array.isArray(row)) continue;
    const slug = row[at.slug];
    if (!isPetdexSlug(slug) || bySlug.has(slug)) continue;
    const spriteUrl = assetUrl(row[at.spritesheet], assetBase);
    const petJsonUrl = assetUrl(row[at.petJson], assetBase);
    if (!spriteUrl || !petJsonUrl) continue;
    bySlug.set(slug, {
      slug,
      displayName:
        capText(row[at.displayName], LIMITS.displayNameChars) ?? slug,
      kind: at.kind >= 0 ? capText(row[at.kind], 40) : null,
      submittedBy:
        at.submittedBy >= 0 ? capText(row[at.submittedBy], 80) : null,
      spriteUrl,
      petJsonUrl,
      spriteVersion: row[at.spriteVersionNumber] === 2 ? 2 : 1
    });
  }
  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    assetBase,
    bySlug
  };
}

class PetdexError extends Error {}

/**
 * @param {{
 *   fetch: typeof fetch,
 *   userDataDir: string,
 *   appVersion: string,
 *   store: { install: (input: object) => { ok: true, pet: object } | { ok: false, error: string } },
 *   now?: () => number,
 *   timeoutMs?: number
 * }} options
 */
export function createPetdexClient({
  fetch: fetchImpl,
  userDataDir,
  appVersion,
  store,
  now = Date.now,
  timeoutMs = PETDEX_TIMEOUT_MS
}) {
  const userAgent = `TracingInsightsDesktop/${appVersion} (+https://app.tracinginsights.com)`;
  const cachePath = join(userDataDir, MANIFEST_CACHE_FILE);
  /** @type {{ etag: string|null, fetchedAt: number, raw: any, parsed: NonNullable<ReturnType<typeof parseManifest>> } | null | undefined} */
  let manifestCache;
  /** @type {Promise<any> | null} */
  let manifestInFlight = null;

  async function readCapped(response, max) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      throw new PetdexError('Petdex response is too large.');
    }
    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > max)
        throw new PetdexError('Petdex response is too large.');
      return buf;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new PetdexError('Petdex response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /**
   * GET/POST an allowlisted URL, following redirects by hand. The timeout
   * covers the body read (`consume`).
   * @template T
   * @param {string} url
   * @param {{ method?: string, headers?: Record<string, string>, accept304?: boolean }} init
   * @param {(response: Response) => Promise<T>} consume
   * @returns {Promise<T>}
   */
  async function request(url, init, consume) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = new URL(current);
        if (!ALLOWED_ORIGINS.has(parsed.origin)) {
          throw new PetdexError(`Blocked request to ${parsed.origin}.`);
        }
        const response = await fetchImpl(current, {
          method: init.method ?? 'GET',
          headers: { 'User-Agent': userAgent, ...init.headers },
          redirect: 'manual',
          signal: controller.signal
        });
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.status !== 304
        ) {
          const location = response.headers.get('location');
          if (!location)
            throw new PetdexError('Petdex redirect without a location.');
          current = new URL(location, current).href;
          continue;
        }
        if (response.status === 304 && init.accept304) return consume(response);
        if (!response.ok) {
          throw new PetdexError(`Petdex answered HTTP ${response.status}.`);
        }
        return await consume(response);
      }
      throw new PetdexError('Too many Petdex redirects.');
    } catch (error) {
      if (controller.signal.aborted) throw new PetdexError('Petdex timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const errorEnvelope = (error, fallback) => ({
    ok: false,
    error:
      error instanceof PetdexError
        ? error.message
        : `${fallback}: ${error?.message ?? error}`
  });

  async function searchRaw({ q, sort, cursor, limit } = {}) {
    const url = new URL('/api/pets/search', PETDEX_ORIGIN);
    if (q !== undefined && q !== null && q !== '') {
      if (typeof q !== 'string') throw new PetdexError('Invalid search text.');
      url.searchParams.set('q', q.slice(0, MAX_QUERY_CHARS));
    }
    if (sort !== undefined && sort !== null) {
      if (!PETDEX_SORTS.includes(sort)) throw new PetdexError('Invalid sort.');
      url.searchParams.set('sort', sort);
    }
    if (cursor !== undefined && cursor !== null) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new PetdexError('Invalid cursor.');
      }
      url.searchParams.set('cursor', String(cursor));
    }
    const n =
      Number.isSafeInteger(limit) && limit > 0
        ? Math.min(limit, PETDEX_SEARCH_MAX_LIMIT)
        : SEARCH_DEFAULT_LIMIT;
    url.searchParams.set('limit', String(n));
    const body = await request(
      url.href,
      { headers: { Accept: 'application/json' } },
      (res) => readCapped(res, SEARCH_MAX_BYTES)
    );
    let raw;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      throw new PetdexError('Petdex sent an unreadable search response.');
    }
    if (!raw || !Array.isArray(raw.pets)) {
      throw new PetdexError('Petdex sent an unexpected search response.');
    }
    const pets = raw.pets.map(reshapeSearchPet).filter(Boolean);
    const nextCursor =
      Number.isSafeInteger(raw.nextCursor) && raw.nextCursor >= 0
        ? raw.nextCursor
        : null;
    return { pets, nextCursor };
  }

  function loadManifestCache() {
    if (manifestCache !== undefined) return manifestCache;
    manifestCache = null;
    try {
      const file = JSON.parse(readFileSync(cachePath, 'utf8'));
      const parsed = parseManifest(file?.manifest);
      if (parsed && Number.isFinite(file.fetchedAt)) {
        manifestCache = {
          etag: typeof file.etag === 'string' ? file.etag : null,
          fetchedAt: file.fetchedAt,
          raw: file.manifest,
          parsed
        };
      }
    } catch {
      // No cache or a corrupt one: fetch fresh.
    }
    return manifestCache;
  }

  function saveManifestCache(entry) {
    const tmp = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(
        tmp,
        JSON.stringify({
          etag: entry.etag,
          fetchedAt: entry.fetchedAt,
          manifest: entry.raw
        })
      );
      renameSync(tmp, cachePath);
    } catch {
      rmSync(tmp, { force: true });
    }
  }

  async function refreshManifest(cached) {
    const result = await request(
      `${PETDEX_ORIGIN}/api/manifest/v2`,
      {
        headers: {
          Accept: 'application/json',
          ...(cached?.etag ? { 'If-None-Match': cached.etag } : {})
        },
        accept304: Boolean(cached)
      },
      async (res) => {
        if (res.status === 304) return { notModified: true };
        return {
          notModified: false,
          etag: res.headers.get('etag'),
          body: await readCapped(res, MANIFEST_MAX_BYTES)
        };
      }
    );
    if (result.notModified && cached) {
      const entry = { ...cached, fetchedAt: now() };
      saveManifestCache(entry);
      return entry;
    }
    let raw;
    try {
      raw = JSON.parse(result.body.toString('utf8'));
    } catch {
      throw new PetdexError('Petdex sent an unreadable manifest.');
    }
    const parsed = parseManifest(raw);
    if (!parsed) throw new PetdexError('Petdex sent an unexpected manifest.');
    const entry = { etag: result.etag ?? null, fetchedAt: now(), raw, parsed };
    saveManifestCache(entry);
    return entry;
  }

  /** @returns {Promise<NonNullable<ReturnType<typeof parseManifest>>>} */
  async function getManifest() {
    const cached = loadManifestCache();
    if (cached && now() - cached.fetchedAt < PETDEX_MANIFEST_MAX_AGE_MS) {
      return cached.parsed;
    }
    if (!manifestInFlight) {
      manifestInFlight = refreshManifest(cached)
        .then((entry) => {
          manifestCache = entry;
          return entry.parsed;
        })
        .catch((error) => {
          // Offline / Petdex down: a stale cache beats no catalog.
          if (cached) return cached.parsed;
          throw error;
        })
        .finally(() => {
          manifestInFlight = null;
        });
    }
    return manifestInFlight;
  }

  function pingInstall(slug) {
    request(
      `${PETDEX_ORIGIN}/api/pets/${slug}/track-zip`,
      { method: 'POST' },
      async (res) => {
        await res.body?.cancel?.().catch(() => {});
      }
    ).catch(() => {});
  }

  function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v) => typeof v === 'string' && v)
      .slice(0, MAX_SHELF_ITEMS);
  }

  const thumbDir = join(userDataDir, THUMB_CACHE_DIR);
  /** slug → data: URL (null = Petdex has none) for this run. */
  const thumbMemory = new Map();

  async function fetchThumb(slug) {
    if (thumbMemory.has(slug)) return thumbMemory.get(slug);
    const file = join(thumbDir, `${slug}.webp`);
    let buf = null;
    try {
      if (now() - statSync(file).mtimeMs < THUMB_MAX_AGE_MS) {
        buf = readFileSync(file);
        if (!isWebp(buf)) buf = null;
      }
    } catch {
      // Not cached yet.
    }
    if (!buf) {
      try {
        buf = await request(
          `${PETDEX_ORIGIN}/api/pets/${encodeURIComponent(slug)}/thumb`,
          {},
          (res) => readCapped(res, THUMB_MAX_BYTES)
        );
      } catch {
        buf = null;
      }
      if (buf && !isWebp(buf)) buf = null;
      if (buf) {
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          mkdirSync(thumbDir, { recursive: true });
          writeFileSync(tmp, buf);
          // Age is measured with the client's clock (`now`), not the disk's.
          const stamp = now() / 1000;
          utimesSync(tmp, stamp, stamp);
          renameSync(tmp, file);
        } catch {
          rmSync(tmp, { force: true });
        }
      }
    }
    const url = buf ? `data:image/webp;base64,${buf.toString('base64')}` : null;
    // Remember misses too, so a pet without a thumbnail is asked once a run.
    thumbMemory.set(slug, url);
    return url;
  }

  return {
    /**
     * Static 80×80 previews for gallery cards, as data: URLs.
     * @param {string[]} slugs
     * @returns {Promise<{ ok: true, thumbs: Record<string, string|null> }>}
     */
    async thumbs(slugs) {
      const wanted = [...new Set(slugs)]
        .filter(isPetdexSlug)
        .slice(0, THUMBS_PER_CALL);
      const thumbs = {};
      let next = 0;
      const worker = async () => {
        while (next < wanted.length) {
          const slug = wanted[next++];
          thumbs[slug] = await fetchThumb(slug);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(THUMB_CONCURRENCY, wanted.length) },
          worker
        )
      );
      return { ok: true, thumbs };
    },

    /**
     * @param {{ q?: string, sort?: string, cursor?: number, limit?: number }} [input]
     * @returns {Promise<{ ok: true, pets: object[], nextCursor: number|null } | { ok: false, error: string }>}
     */
    async search(input = {}) {
      try {
        return { ok: true, ...(await searchRaw(input ?? {})) };
      } catch (error) {
        return errorEnvelope(error, 'Petdex search failed');
      }
    },

    /**
     * The v2 manifest (cached, refreshed at most every 12 h).
     * @returns {Promise<{ ok: true, manifest: NonNullable<ReturnType<typeof parseManifest>> } | { ok: false, error: string }>}
     */
    async manifest() {
      try {
        return { ok: true, manifest: await getManifest() };
      } catch (error) {
        return errorEnvelope(error, 'Could not load the Petdex catalog');
      }
    },

    /**
     * Racing shelf: curated slugs first, then every term's search hits,
     * deduplicated by slug, minus `deny`.
     * @param {{ terms: string[], curated: string[], deny: string[] }} input
     */
    async shelf(input) {
      const terms = stringList(input?.terms);
      const curated = stringList(input?.curated);
      const deny = new Set(stringList(input?.deny));
      const seen = new Set();
      const pets = [];
      const add = (pet) => {
        if (!pet || seen.has(pet.slug) || deny.has(pet.slug)) return;
        seen.add(pet.slug);
        pets.push(pet);
      };
      let failures = 0;
      let lastError = null;
      if (curated.length) {
        try {
          const manifest = await getManifest();
          for (const slug of curated) {
            const entry = manifest.bySlug.get(slug);
            if (!entry) continue;
            add(
              petdexPet({
                slug,
                displayName: entry.displayName,
                description: null,
                tags: [],
                kind: entry.kind,
                creator: entry.submittedBy,
                spriteUrl: entry.spriteUrl,
                spriteVersion: entry.spriteVersion
              })
            );
          }
        } catch (error) {
          failures++;
          lastError = error;
        }
      }
      const searches = await Promise.allSettled(
        terms.map((q) => searchRaw({ q, limit: PETDEX_SEARCH_MAX_LIMIT }))
      );
      for (const result of searches) {
        if (result.status === 'fulfilled') result.value.pets.forEach(add);
        else {
          failures++;
          lastError = result.reason;
        }
      }
      const attempts = terms.length + (curated.length ? 1 : 0);
      if (attempts > 0 && failures === attempts) {
        return errorEnvelope(lastError, 'Could not load the racing shelf');
      }
      return { ok: true, pets };
    },

    /**
     * Download, validate and store a Petdex pet; pings Petdex's counter.
     * @param {string} slug
     * @returns {Promise<{ ok: true, pet: object } | { ok: false, error: string }>}
     */
    async install(slug) {
      if (!isPetdexSlug(slug))
        return { ok: false, error: 'Invalid Petdex slug.' };
      try {
        const manifest = await getManifest();
        const entry = manifest.bySlug.get(slug);
        if (!entry) return { ok: false, error: 'That pet is not on Petdex.' };
        const [petJsonBuf, imageBuf] = await Promise.all([
          request(entry.petJsonUrl, {}, (res) =>
            readCapped(res, LIMITS.petJsonBytes)
          ),
          request(entry.spriteUrl, {}, (res) =>
            readCapped(res, LIMITS.imageBytes)
          )
        ]);
        const result = store.install({
          source: 'petdex',
          slug,
          petJsonBuf,
          imageBuf,
          meta: {
            pageUrl: petdexPageUrl(slug),
            creator: entry.submittedBy,
            description: null,
            tags: []
          }
        });
        if (result.ok) pingInstall(slug);
        return result;
      } catch (error) {
        return errorEnvelope(error, 'Could not install the pet');
      }
    }
  };
}
