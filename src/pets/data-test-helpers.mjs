/**
 * Test helpers for the pets data layer: synthetic images (no pet art — plan
 * D1) and hand-built zip archives.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A PNG signature + IHDR chunk with the given size. Not a full image — the
 * fake decoder below only reads the header.
 */
export function fakePng(width, height, padding = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const type = Buffer.from('IHDR');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, ihdr])) >>> 0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    type,
    ihdr,
    crc,
    Buffer.alloc(padding)
  ]);
}

/** RIFF/WEBP header carrying the size in bytes 12..19 (for the fake decoder). */
export function fakeWebp(width, height) {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('FAKE', 12, 'ascii');
  buf.writeUInt32LE(width, 16);
  buf.writeUInt32LE(height, 20);
  return buf;
}

/** Stand-in for Electron's nativeImage decoder. */
export function fakeDecodeImage(buf) {
  if (buf[0] === 0x89 && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.toString('ascii', 8, 12) === 'WEBP' &&
    buf.toString('ascii', 12, 16) === 'FAKE'
  ) {
    return { width: buf.readUInt32LE(16), height: buf.readUInt32LE(20) };
  }
  return null;
}

export const fakeMakeThumb = (_buf, atlas) =>
  `data:image/png;base64,thumb-${atlas.version}`;

export function petJson(fields = {}) {
  return Buffer.from(
    JSON.stringify({
      id: 'test-pet',
      displayName: 'Test Pet',
      description: 'A generated test pet.',
      spritesheetPath: 'spritesheet.png',
      ...fields
    })
  );
}

/**
 * Build a zip archive by hand.
 * @param {{ name: string, data?: Buffer|string, method?: 0|8, madeBy?: number,
 *   externalAttrs?: number, flags?: number, declaredSize?: number }[]} entries
 * @param {{ zip64Locator?: boolean, totalEntries?: number }} [options]
 */
export function makeZip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const size = entry.declaredSize ?? data.length;
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttrs ?? (0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const parts = [...locals, cd];
  if (options.zip64Locator) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    parts.push(locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const total = options.totalEntries ?? entries.length;
  eocd.writeUInt16LE(total, 8);
  eocd.writeUInt16LE(total, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}
