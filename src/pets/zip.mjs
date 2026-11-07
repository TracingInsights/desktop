/**
 * Desktop pets — minimal ZIP reader (docs/DESKTOP_PETS_PLAN.md §4.2).
 *
 * Just enough of the format for a pet download: End-of-central-directory →
 * central directory → local headers, stored (0) and deflate (8) entries only,
 * inflated with node:zlib. Anything unusual is rejected rather than handled:
 * zip64, encryption, symlinks, absolute or `..` paths, backslashes, more
 * entries or bytes than LIMITS allows (declared AND actual inflated sizes).
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { LIMITS } from './contract.mjs';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;
const MAX_COMMENT = 0xffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const MAX_NAME_BYTES = 255;

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

function fail(message) {
  throw new ZipError(message);
}

function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + EOCD_MIN + commentLength === buf.length) return i;
    }
  }
  return -1;
}

/**
 * A safe relative entry name: forward slashes only, no absolute / drive
 * paths, no `.` / `..` / empty segments, no control characters.
 * @param {string} name
 */
export function isSafeEntryName(name) {
  if (!name || name.length > MAX_NAME_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(name)) return false;
  if (name.startsWith('/')) return false;
  const segments = name.endsWith('/')
    ? name.slice(0, -1).split('/')
    : name.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Read every file entry of a ZIP archive (directory entries are skipped).
 * @param {Buffer|Uint8Array} input
 * @param {{ limits?: Partial<typeof LIMITS> }} [options]
 * @returns {{ name: string, data: Buffer }[]}
 * @throws {ZipError}
 */
export function readZip(input, { limits: overrides } = {}) {
  const limits = { ...LIMITS, ...overrides };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length > limits.zipBytes) fail('The zip file is too large.');
  if (buf.length < EOCD_MIN) fail('Not a zip file.');

  const eocd = findEocd(buf);
  if (eocd < 0) fail('Not a zip file.');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    fail('Zip64 archives are not supported.');
  }
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    fail('Zip64 archives are not supported.');
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    fail('Multi-part zip archives are not supported.');
  }
  if (totalEntries > limits.zipEntries) {
    fail(`The zip has more than ${limits.zipEntries} entries.`);
  }
  if (cdOffset + cdSize > eocd) fail('Corrupt zip central directory.');

  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  const seen = new Set();
  let declaredTotal = 0;
  let actualTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + CENTRAL_MIN > cdOffset + cdSize) fail('Corrupt zip entry.');
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) fail('Corrupt zip entry.');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + CENTRAL_MIN + nameLength + extraLength + commentLength;
    if (next > cdOffset + cdSize) fail('Corrupt zip entry.');
    const name = buf.toString(
      'utf8',
      p + CENTRAL_MIN,
      p + CENTRAL_MIN + nameLength
    );
    p = next;

    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      fail('Zip64 archives are not supported.');
    }
    if (flags & 0x41) fail('Encrypted zip entries are not supported.');
    if (!isSafeEntryName(name))
      fail(`Unsafe path in zip: ${JSON.stringify(name)}`);
    const unixMode = madeBy >> 8 === 3 ? externalAttrs >>> 16 : 0;
    if ((unixMode & S_IFMT) === S_IFLNK)
      fail('Symbolic links are not allowed.');
    const key = name.toLowerCase();
    if (seen.has(key)) fail(`Duplicate zip entry: ${name}`);
    seen.add(key);
    if (name.endsWith('/')) continue;

    if (method !== 0 && method !== 8) {
      fail('Unsupported zip compression method.');
    }
    declaredTotal += size;
    if (declaredTotal > limits.zipUncompressedBytes) {
      fail('The zip contents are too large.');
    }

    if (localOffset + LOCAL_MIN > cdOffset) fail('Corrupt zip entry.');
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) fail('Corrupt zip entry.');
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart =
      localOffset + LOCAL_MIN + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) fail('Corrupt zip entry.');
    const raw = buf.subarray(dataStart, dataEnd);

    const remaining = limits.zipUncompressedBytes - actualTotal;
    /** @type {Buffer} */
    let data;
    if (method === 0) {
      if (compressedSize !== size) fail('Corrupt zip entry.');
      data = Buffer.from(raw);
    } else {
      try {
        // Cap the inflate at what is left of the budget (zip bombs lie
        // about their declared sizes).
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) });
      } catch (error) {
        if (
          error?.code === 'ERR_BUFFER_TOO_LARGE' ||
          error instanceof RangeError
        ) {
          fail('The zip contents are too large.');
        }
        fail('Corrupt zip data.');
      }
    }
    if (data.length !== size) fail('Corrupt zip entry (size mismatch).');
    actualTotal += data.length;
    if (actualTotal > limits.zipUncompressedBytes) {
      fail('The zip contents are too large.');
    }
    if (crc32(data) >>> 0 !== crc) fail('Corrupt zip entry (CRC mismatch).');
    files.push({ name, data });
  }
  return files;
}
