/**
 * Desktop pets — custom protocols for the pet window
 * (docs/DESKTOP_PETS_PLAN.md §4.4).
 *
 * - `app://pet/<file>` serves the bundled pet page, only files directly in
 *   desktop/src/pet/ (no sub-folders, no traversal, fixed extensions).
 * - `pet-asset://pet/<encodeURIComponent(id)>/sprite` serves the validated
 *   spritesheet of an installed pet via `store.resolveAsset(id)`; no file
 *   path ever reaches the renderer. (The id lives in the path, not the host:
 *   standard-scheme hosts are lower-cased and cannot hold `:`.)
 *
 * Both handlers are installed on the pet window's own session only, so the
 * remote site in the main window cannot load either scheme.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { LIMITS, PET_ASSET_SCHEME, PET_PAGE_SCHEME } from './contract.mjs';

export const PET_PAGE_HOST = 'pet';
export const PET_PAGE_URL = `${PET_PAGE_SCHEME}://${PET_PAGE_HOST}/index.html`;
const PET_ASSET_HOST = 'pet';

/**
 * `protocol.registerSchemesAsPrivileged` may be called once per app, before
 * `ready` — main.mjs passes this list (plus any future schemes) in that call.
 */
export const PET_PRIVILEGED_SCHEMES = Object.freeze([
  {
    scheme: PET_PAGE_SCHEME,
    privileges: { standard: true, secure: true }
  },
  {
    scheme: PET_ASSET_SCHEME,
    privileges: { standard: true, secure: true }
  }
]);

/** CSP per bundled page (the meta tag carries the same policy). */
export const PET_PAGE_CSP =
  "default-src 'none'; img-src pet-asset:; style-src 'self'; script-src 'self'";

const MIME = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8'
});
const FILE_RE = /^[a-z0-9][a-z0-9-]*\.(html|css|js)$/;
const MAX_PAGE_FILE_BYTES = 256 * 1024;

/**
 * @param {string} id
 * @param {string|number} [version] cache-buster (changes when the pet does)
 */
export function petAssetUrl(id, version) {
  const query =
    version === undefined ? '' : `?v=${encodeURIComponent(String(version))}`;
  return `${PET_ASSET_SCHEME}://${PET_ASSET_HOST}/${encodeURIComponent(id)}/sprite${query}`;
}

/** @param {string} url → pet id, or null */
export function parsePetAssetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${PET_ASSET_SCHEME}:` ||
    parsed.host !== PET_ASSET_HOST
  ) {
    return null;
  }
  const match = /^\/([^/]+)\/sprite$/.exec(parsed.pathname);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return id.length > 0 && id.length <= 256 && !/[\0/\\]/.test(id) ? id : null;
}

/**
 * Map an `app://pet/<file>` URL to a file in `rootDir`, or null.
 * @param {string} url
 * @param {string} rootDir
 * @returns {{ path: string, name: string, mime: string } | null}
 */
export function resolvePetPageFile(url, rootDir) {
  // Belt and braces: refuse dot segments and backslashes before the URL
  // parser gets a chance to normalise them away.
  if (typeof url !== 'string' || /\.\.|\\|%5c/i.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${PET_PAGE_SCHEME}:` ||
    parsed.host !== PET_PAGE_HOST
  ) {
    return null;
  }
  let name;
  try {
    name = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  const match = FILE_RE.exec(name);
  if (!match) return null;
  const root = resolve(rootDir);
  const path = resolve(join(root, name));
  if (!path.startsWith(root + sep)) return null;
  return { path, name, mime: MIME[match[1]] };
}

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' }
  });

/**
 * @param {{
 *   rootDir: string,
 *   store: { resolveAsset: (id: string) => { path: string, mime: string } | null },
 *   readFile?: (path: string) => Promise<Uint8Array>
 * }} deps
 */
export function createPetProtocolHandlers({
  rootDir,
  store,
  readFile = fsReadFile
}) {
  return {
    /** @param {Request} request */
    async page(request) {
      if (request.method !== 'GET') return notFound();
      const file = resolvePetPageFile(request.url, rootDir);
      if (!file) return notFound();
      let body;
      try {
        body = await readFile(file.path);
      } catch {
        return notFound();
      }
      if (body.byteLength > MAX_PAGE_FILE_BYTES) return notFound();
      /** @type {Record<string, string>} */
      const headers = {
        'content-type': file.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      };
      if (file.name.endsWith('.html'))
        headers['content-security-policy'] = PET_PAGE_CSP;
      return new Response(body, { status: 200, headers });
    },
    /** @param {Request} request */
    async asset(request) {
      if (request.method !== 'GET') return notFound();
      const id = parsePetAssetUrl(request.url);
      if (!id) return notFound();
      let asset;
      try {
        asset = store.resolveAsset(id);
      } catch {
        asset = null;
      }
      if (!asset) return notFound();
      let body;
      try {
        body = await readFile(asset.path);
      } catch {
        return notFound();
      }
      if (body.byteLength > LIMITS.imageBytes) return notFound();
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': asset.mime,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store'
        }
      });
    }
  };
}

/**
 * Install the handlers on one session's protocol object (the pet window's).
 * @param {{ handle: (scheme: string, handler: (request: Request) => Promise<Response>) => void }} sessionProtocol
 * @param {ReturnType<typeof createPetProtocolHandlers>} handlers
 */
export function installPetProtocols(sessionProtocol, handlers) {
  sessionProtocol.handle(PET_PAGE_SCHEME, (request) => handlers.page(request));
  sessionProtocol.handle(PET_ASSET_SCHEME, (request) =>
    handlers.asset(request)
  );
}
