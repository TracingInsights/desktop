import { describe, test, expect } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { isSafeEntryName, readZip } from './zip.mjs';
import { makeZip } from './data-test-helpers.mjs';

describe('readZip', () => {
  test('reads stored and deflated entries, skipping directories', () => {
    const zip = makeZip([
      {
        name: 'pet/',
        data: '',
        method: 0,
        externalAttrs: (0o40755 << 16) >>> 0
      },
      { name: 'pet/pet.json', data: '{"a":1}', method: 0 },
      { name: 'pet/spritesheet.png', data: Buffer.alloc(5000, 7) }
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual([
      'pet/pet.json',
      'pet/spritesheet.png'
    ]);
    expect(files[0].data.toString()).toBe('{"a":1}');
    expect(files[1].data.equals(Buffer.alloc(5000, 7))).toBe(true);
  });

  test('rejects non-zip input', () => {
    expect(() => readZip(Buffer.from('not a zip at all, clearly'))).toThrow(
      'Not a zip'
    );
  });

  test.each([
    ['../evil.json'],
    ['/etc/passwd'],
    ['pet/../../x'],
    ['pet\\..\\x'],
    ['C:/x.png'],
    ['a//b'],
    ['./a']
  ])('rejects unsafe path %s (zip-slip)', (name) => {
    expect(() => readZip(makeZip([{ name, data: 'x' }]))).toThrow(
      'Unsafe path'
    );
  });

  test('rejects symlinks', () => {
    const zip = makeZip([
      {
        name: 'pet.json',
        data: '/etc/passwd',
        externalAttrs: (0o120777 << 16) >>> 0
      }
    ]);
    expect(() => readZip(zip)).toThrow('Symbolic links');
  });

  test('ignores unix mode bits from non-unix creators', () => {
    const zip = makeZip([
      {
        name: 'a.txt',
        data: 'x',
        madeBy: 0x0014,
        externalAttrs: (0o120777 << 16) >>> 0
      }
    ]);
    expect(readZip(zip)).toHaveLength(1);
  });

  test('rejects encrypted entries', () => {
    expect(() =>
      readZip(makeZip([{ name: 'a', data: 'x', flags: 1 }]))
    ).toThrow('Encrypted');
  });

  test('rejects zip64', () => {
    expect(() =>
      readZip(makeZip([{ name: 'a', data: 'x' }], { zip64Locator: true }))
    ).toThrow('Zip64');
  });

  test('rejects too many entries', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({
      name: `f${i}`,
      data: 'x'
    }));
    expect(() => readZip(makeZip(entries))).toThrow('more than 8 entries');
  });

  test('rejects an oversized archive', () => {
    expect(() =>
      readZip(Buffer.alloc(100), { limits: { zipBytes: 50 } })
    ).toThrow('too large');
  });

  test('zip bomb: declared size over the cap', () => {
    const zip = makeZip([{ name: 'a', data: Buffer.alloc(2000) }]);
    expect(() =>
      readZip(zip, { limits: { zipUncompressedBytes: 1000 } })
    ).toThrow('too large');
  });

  test('zip bomb: entry lying about its size is capped while inflating', () => {
    const zip = makeZip([
      { name: 'a', data: Buffer.alloc(200_000), declaredSize: 10 }
    ]);
    expect(() =>
      readZip(zip, { limits: { zipUncompressedBytes: 1000 } })
    ).toThrow('too large');
  });

  test('size mismatch under the cap is corrupt', () => {
    const zip = makeZip([
      { name: 'a', data: Buffer.alloc(500), declaredSize: 10 }
    ]);
    expect(() => readZip(zip)).toThrow('size mismatch');
  });

  test('CRC mismatch is corrupt', () => {
    const zip = makeZip([{ name: 'a', data: 'hello', method: 0 }]);
    zip[30 + 1] ^= 0xff; // flip a data byte after the 30-byte header + 1-byte name
    expect(() => readZip(zip)).toThrow('CRC');
  });

  test('rejects duplicate names and unknown methods', () => {
    expect(() =>
      readZip(
        makeZip([
          { name: 'a', data: 'x' },
          { name: 'A', data: 'y' }
        ])
      )
    ).toThrow('Duplicate');
    const zip = makeZip([{ name: 'a', data: 'x', method: 0 }]);
    // Patch the central method field to 12 (bzip2).
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(12, cd + 10);
    expect(() => readZip(zip)).toThrow('compression method');
  });

  test('truncated / corrupt deflate data', () => {
    const good = deflateRawSync(Buffer.alloc(100, 1));
    const zip = makeZip([{ name: 'a', data: Buffer.alloc(100, 1) }]);
    const at = zip.indexOf(good);
    zip.fill(0xff, at, at + good.length);
    expect(() => readZip(zip)).toThrow();
  });
});

describe('isSafeEntryName', () => {
  test('accepts nested relative paths', () => {
    expect(isSafeEntryName('pet/pet.json')).toBe(true);
    expect(isSafeEntryName('pet/')).toBe(true);
    expect(isSafeEntryName('')).toBe(false);
    expect(isSafeEntryName('a\u0000b')).toBe(false);
  });
});
