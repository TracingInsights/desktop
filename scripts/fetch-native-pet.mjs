/**
 * Fetch the pinned native pet (`ti-pet`) into resources/ti-pet/ for the
 * installer (docs/DESKTOP_PETS_NATIVE_PLAN.md N5).
 *
 * desktop/native-pet.json pins one `ti-pet-v*` release of the
 * TracingInsights/petdex fork and a SHA-256 per platform. This script
 * downloads the pinned assets from that GitHub release, verifies every hash
 * and writes them as resources/ti-pet/<ti-pet-<platform>-<arch>[.exe]>
 * (mode 755), where electron-builder's `extraResources` picks them up.
 *
 *   bun run scripts/fetch-native-pet.mjs                    # dry run: what would be fetched
 *   bun run scripts/fetch-native-pet.mjs --write            # download + verify (this platform)
 *   bun run scripts/fetch-native-pet.mjs --write --target darwin   # both macOS arches (universal app)
 *   bun run scripts/fetch-native-pet.mjs --write --from <dir>      # verify local assets instead of downloading
 *   --require   fail when the pin is not set (default: warn and ship without a native pet)
 *
 * An unset pin (tag or a hash null) is not an error: the installer ships
 * without the native pet and the Electron pet runs (fallback, N3).
 *
 * resources/ti-pet/ also holds the committed license texts the binary needs
 * (NOTICE_FILES: Petdex MIT, Native SDK Apache-2.0). This script only adds
 * binaries next to them and refuses to write a binary without them.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBinaryName } from '../src/pets/native-protocol.mjs';

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const PIN_FILE = join(DESKTOP_DIR, 'native-pet.json');
export const OUT_DIR = join(DESKTOP_DIR, 'resources', 'ti-pet');
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
/** Committed third-party notices shipped beside the binary (extraResources). */
export const NOTICE_FILES = [
  'THIRD-PARTY-NOTICES.md',
  'LICENSE-petdex.txt',
  'LICENSE-native-sdk.txt'
];

const TARGET_RE = /^(linux|win32|darwin)-(x64|arm64)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TAG_RE = /^ti-pet-v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;
const ASSET_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validate the pin document.
 * @param {unknown} raw
 * @returns {{ ok: true, pin: { repo: string, tag: string|null, files: Record<string, { asset: string, sha256: string|null }> } } | { ok: false, error: string }}
 */
export function parsePin(raw) {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'not an object' };
  const { repo, tag, files } = /** @type {any} */ (raw);
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, error: 'bad repo' };
  }
  if (tag !== null && (typeof tag !== 'string' || !TAG_RE.test(tag))) {
    return { ok: false, error: 'bad tag (ti-pet-vX.Y.Z or null)' };
  }
  if (!files || typeof files !== 'object')
    return { ok: false, error: 'no files' };
  /** @type {Record<string, { asset: string, sha256: string|null }>} */
  const out = {};
  for (const [target, file] of Object.entries(files)) {
    if (!TARGET_RE.test(target))
      return { ok: false, error: `bad target ${target}` };
    if (!file || typeof file.asset !== 'string' || !ASSET_RE.test(file.asset)) {
      return { ok: false, error: `bad asset for ${target}` };
    }
    if (
      file.sha256 !== null &&
      (typeof file.sha256 !== 'string' || !SHA_RE.test(file.sha256))
    ) {
      return { ok: false, error: `bad sha256 for ${target}` };
    }
    out[target] = { asset: file.asset, sha256: file.sha256 };
  }
  return { ok: true, pin: { repo, tag, files: out } };
}

/**
 * Targets for a `--target` value: 'darwin' = both macOS arches (the app is
 * universal), 'linux-x64' etc. as is; none → this machine.
 * @param {string|null} value @param {{ platform: string, arch: string }} host
 */
export function resolveTargets(value, host) {
  if (value === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (value) return [value];
  return host.platform === 'darwin'
    ? ['darwin-arm64', 'darwin-x64']
    : [`${host.platform}-${host.arch}`];
}

/** @param {Uint8Array} buf */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Plan the fetch: per target the URL, expected hash and output file — or why
 * it cannot run (unpinned / unknown target).
 * @param {{ repo: string, tag: string|null, files: Record<string, { asset: string, sha256: string|null }> }} pin
 * @param {string[]} targets
 */
export function planFetch(pin, targets) {
  const missing = [];
  const items = [];
  for (const target of targets) {
    const file = pin.files[target];
    if (!file) {
      missing.push(`${target}: not in the pin`);
      continue;
    }
    if (!pin.tag || !file.sha256) {
      missing.push(`${target}: not pinned yet`);
      continue;
    }
    const [platform, arch] = target.split('-');
    items.push({
      target,
      url: `https://github.com/${pin.repo}/releases/download/${pin.tag}/${file.asset}`,
      asset: file.asset,
      sha256: file.sha256,
      out: join(OUT_DIR, nativeBinaryName(platform, arch))
    });
  }
  return { items, missing };
}

/** Write atomically with mode 755. @param {string} path @param {Uint8Array} buf */
function writeBinary(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, buf, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

async function download(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'tif1ai-desktop-release' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    throw new Error(`${url} is larger than ${MAX_ASSET_BYTES} bytes`);
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > MAX_ASSET_BYTES) throw new Error(`${url} is too large`);
  return buf;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null;
}

/**
 * @param {string[]} argv
 * @param {{ pinFile?: string }} [options] tests point this at their own pin
 */
export async function main(argv, { pinFile = PIN_FILE } = {}) {
  const write = argv.includes('--write');
  const requirePin = argv.includes('--require');
  const from = argValue(argv, '--from');
  const targetArg = argValue(argv, '--target');
  if (targetArg && targetArg !== 'darwin' && !TARGET_RE.test(targetArg)) {
    console.error(`error: bad --target ${targetArg}`);
    return 1;
  }
  const parsed = parsePin(JSON.parse(readFileSync(pinFile, 'utf8')));
  if (!parsed.ok) {
    console.error(`error: native-pet.json: ${parsed.error}`);
    return 1;
  }
  const targets = resolveTargets(targetArg, {
    platform: process.platform,
    arch: process.arch
  });
  const { items, missing } = planFetch(parsed.pin, targets);
  if (missing.length) {
    const message = `native pet not fetched — ${missing.join('; ')}. The installer ships without it (Electron pet fallback).`;
    if (requirePin) {
      console.error(`error: ${message}`);
      return 1;
    }
    console.warn(`warning: ${message}`);
    if (!items.length) return 0;
  }
  const missingNotices = NOTICE_FILES.filter(
    (name) => !existsSync(join(OUT_DIR, name))
  );
  if (write && missingNotices.length) {
    console.error(
      `error: resources/ti-pet/ lacks ${missingNotices.join(', ')} — the binary must ship with its licenses.`
    );
    return 1;
  }
  for (const item of items) {
    const source = from ? join(from, item.asset) : item.url;
    if (!write) {
      console.log(`[dry run] ${source} → ${item.out} (sha256 ${item.sha256})`);
      continue;
    }
    const buf = from ? readFileSync(source) : await download(source);
    const actual = sha256(buf);
    if (actual !== item.sha256) {
      console.error(
        `error: ${item.asset}: sha256 ${actual} does not match the pin ${item.sha256}`
      );
      return 1;
    }
    writeBinary(item.out, buf);
    console.log(`✓ ${item.target}: ${item.out}`);
  }
  if (!write) console.log('Dry run: pass --write to fetch.');
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
