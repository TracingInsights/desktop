/**
 * Generate the desktop app icons from desktop/assets/icon.svg:
 *
 *   build/icon.png  — 1024×1024 (Linux + master source)
 *   build/icon.icns — macOS (multi-size, incl. 1024 for Retina)
 *   build/icon.ico  — Windows (16–256)
 *
 * Pipeline: resvg-wasm renders the SVG → 1024 PNG; png2icons converts the
 * PNG to ICNS/ICO in pure JS (no native tools, works on any platform).
 *
 * Run:  cd desktop && bun run icons
 *       (root: bun run desktop:icons)
 *
 * The script self-verifies: it decodes the PNG and samples a few pixels
 * (background, T bar, T stem, checkered cell) so a broken render is caught
 * immediately instead of shipping a blank icon.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const require_ = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const BUILD_DIR = join(DESKTOP_DIR, 'build');
const SOURCE_SVG = join(DESKTOP_DIR, 'assets', 'icon.svg');
const ICON_SIZE = 1024;

// ---------------------------------------------------------------------------
// resvg-wasm init (same pattern as src/lib/og/generate.ts)
// ---------------------------------------------------------------------------

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) {
    const wasmPath = require_.resolve('@resvg/resvg-wasm/index_bg.wasm');
    wasmReady = initWasm(readFileSync(wasmPath));
  }
  return wasmReady;
}

function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: false },
    fitTo: { mode: 'width', value: size }
  });
  let image;
  try {
    image = resvg.render();
    return Buffer.from(image.asPng());
  } finally {
    image?.free();
    resvg.free();
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG decoder (IHDR + IDAT, unfilter) — used only for pixel checks
// ---------------------------------------------------------------------------

function decodePng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `unsupported PNG format (depth ${bitDepth}, color ${colorType})`
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = 4;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  const bytesPerPixel = channels;

  // Reverse the per-row filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth).
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[y * (stride + 1) + 1 + x];
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel] : 0;
      let value = rawByte;
      switch (filter) {
        case 0:
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor =
            pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = rawByte + predictor;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }
  return { width, height, data: out };
}

function samplePixel(png, x, y) {
  const idx = (y * png.width + x) * 4;
  return {
    r: png.data[idx],
    g: png.data[idx + 1],
    b: png.data[idx + 2],
    a: png.data[idx + 3]
  };
}

function hex({ r, g, b, a }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}${a < 255 ? `/${a}` : ''}`;
}

function isNearRose(p) {
  return p.r > 150 && p.g < 130 && p.b < 160 && p.a > 200;
}

function isNearDark(p) {
  return p.r < 48 && p.g < 48 && p.b < 56 && p.a > 200;
}
function isCheckeredCell(p) {
  // Checker cells are either near-white or near-black.
  return (
    (p.r > 200 && p.g > 200 && p.b > 200) || (p.r < 48 && p.g < 48 && p.b < 56)
  );
}

function isNearWhite(p) {
  return p.r > 200 && p.g > 200 && p.b > 200 && p.a > 200;
}

// ---------------------------------------------------------------------------
// Container-level format checks (ICNS 1024 Retina entry, ICO 256px entry)
// ---------------------------------------------------------------------------

/** true when the ICNS contains a 1024×1024 entry (ic10 or ic14). */
function icnsHas1024(buf) {
  if (buf.subarray(0, 4).toString('ascii') !== 'icns') return false;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const length = buf.readUInt32BE(offset + 4);
    if (type === 'ic10' || type === 'ic14') return true;
    if (length < 8 || offset + length > buf.length) break;
    offset += length;
  }
  return false;
}

/** true when the ICO contains a 256×256 entry (width byte 0 == 256). */
function icoHas256(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return false;
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i += 1) {
    if (buf[6 + i * 16] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// png2icons (pure-JS ICNS/ICO encoder)
// ---------------------------------------------------------------------------

async function loadPng2Icons() {
  const mod = await import('png2icons');
  return {
    createICNS: mod.createICNS ?? mod.default?.createICNS,
    createICO: mod.createICO ?? mod.default?.createICO,
    BICUBIC: mod.BICUBIC ?? 2
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await ensureWasm();
const svg = readFileSync(SOURCE_SVG, 'utf8');

console.log('rendering icon.svg → icon.png …');
const png = renderPng(svg, ICON_SIZE);

// Pixel self-check against the design:
//   corner        ≈ dark background
//   (512, 330)    T bar            (rose)
//   (512, 500)    T stem           (rose)
//   (300, 780)    checkered cell   (white or black)
const decoded = decodePng(png);
if (decoded.width !== ICON_SIZE || decoded.height !== ICON_SIZE) {
  throw new Error(
    `expected ${ICON_SIZE}×${ICON_SIZE}, got ${decoded.width}×${decoded.height}`
  );
}
const samples = {
  corner: samplePixel(decoded, 8, 8),
  bar: samplePixel(decoded, 512, 330),
  stem: samplePixel(decoded, 512, 500),
  checkerDark: samplePixel(decoded, 300, 780),
  checkerWhite: samplePixel(decoded, 240, 770)
};
for (const [name, p] of Object.entries(samples)) {
  console.log(`  ${name.padEnd(7)} ${hex(p)}`);
}
const checks = {
  'corner is dark': isNearDark(samples.corner),
  'T bar is rose': isNearRose(samples.bar),
  'T stem is rose': isNearRose(samples.stem),
  'checker dark cell': isCheckeredCell(samples.checkerDark),
  'checker white cell': isNearWhite(samples.checkerWhite)
};
const failed = Object.entries(checks).filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(
    `icon render failed checks: ${failed.map(([name]) => name).join(', ')}`
  );
}

// Write through a clean slate so a failed regeneration cannot leave stale
// files behind (e.g. an old icon.icns next to a new icon.png).
mkdirSync(BUILD_DIR, { recursive: true });
for (const file of ['icon.png', 'icon.icns', 'icon.ico']) {
  rmSync(join(BUILD_DIR, file), { force: true });
}
writeFileSync(join(BUILD_DIR, 'icon.png'), png);
console.log(`  wrote build/icon.png (${(png.length / 1024).toFixed(0)} KiB)`);

const { createICNS, createICO, BICUBIC } = await loadPng2Icons();
if (!createICNS || !createICO) {
  throw new Error('png2icons import failed — check the package export shape');
}

const icns = createICNS(png, BICUBIC, 0);
if (!icns) throw new Error('png2icons failed to encode icns');
writeFileSync(join(BUILD_DIR, 'icon.icns'), icns);
console.log(`  wrote build/icon.icns (${(icns.length / 1024).toFixed(0)} KiB)`);

const ico = createICO(png, BICUBIC, 0, true);
if (!ico) throw new Error('png2icons failed to encode ico');
writeFileSync(join(BUILD_DIR, 'icon.ico'), ico);
console.log(`  wrote build/icon.ico (${(ico.length / 1024).toFixed(0)} KiB)`);

// Format sanity: PNG magic, ICNS 'icns' magic, ICO 00 00 01 00 header.
const pngHeader = png.subarray(0, 4).toString('hex');
const icnsHeader = icns.subarray(0, 4).toString('ascii');
const icoHeader = ico.subarray(0, 4).toString('hex');
if (pngHeader !== '89504e47') throw new Error('icon.png magic mismatch');
if (icnsHeader !== 'icns') throw new Error('icon.icns magic mismatch');
if (icoHeader !== '00000100') throw new Error('icon.ico magic mismatch');
if (!icnsHas1024(icns)) {
  throw new Error('icon.icns is missing a 1024×1024 Retina entry (ic10/ic14)');
}
if (!icoHas256(ico)) {
  throw new Error('icon.ico is missing a 256×256 entry');
}
console.log('\nAll icon checks passed.');
