import { describe, test, expect } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main,
  NOTICE_FILES,
  OUT_DIR,
  parsePin,
  PIN_FILE,
  planFetch,
  resolveTargets,
  sha256
} from './fetch-native-pet.mjs';

const HASH = 'a'.repeat(64);
const PIN = {
  repo: 'TracingInsights/petdex',
  tag: 'ti-pet-v0.1.0',
  files: {
    'linux-x64': { asset: 'ti-pet-linux-x64', sha256: HASH },
    'win32-x64': { asset: 'ti-pet-win32-x64.exe', sha256: HASH },
    'darwin-arm64': { asset: 'ti-pet-darwin-arm64', sha256: HASH },
    'darwin-x64': { asset: 'ti-pet-darwin-x64', sha256: null }
  }
};

describe('fetch-native-pet', () => {
  test('the committed pin parses (and is unpinned until the fork ships)', () => {
    const parsed = parsePin(JSON.parse(readFileSync(PIN_FILE, 'utf8')));
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.pin.files).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64'
    ]);
  });

  test('pin validation', () => {
    expect(parsePin(PIN).ok).toBe(true);
    expect(parsePin({ ...PIN, tag: 'v1' }).ok).toBe(false);
    expect(parsePin({ ...PIN, repo: 'x' }).ok).toBe(false);
    expect(
      parsePin({
        ...PIN,
        files: { 'linux-x64': { asset: '../x', sha256: HASH } }
      }).ok
    ).toBe(false);
    expect(
      parsePin({
        ...PIN,
        files: { 'linux-x64': { asset: 'x', sha256: 'ABC' } }
      }).ok
    ).toBe(false);
    expect(
      parsePin({ ...PIN, files: { 'beos-x64': { asset: 'x', sha256: HASH } } })
        .ok
    ).toBe(false);
  });

  test('targets: macOS fetches both arches (universal app)', () => {
    expect(
      resolveTargets('darwin', { platform: 'linux', arch: 'x64' })
    ).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(resolveTargets(null, { platform: 'linux', arch: 'x64' })).toEqual([
      'linux-x64'
    ]);
    expect(
      resolveTargets('win32-x64', { platform: 'linux', arch: 'x64' })
    ).toEqual(['win32-x64']);
  });

  test('plan: release URL, hash and output name; unpinned targets reported', () => {
    const { items, missing } = planFetch(PIN, [
      'linux-x64',
      'darwin-x64',
      'linux-arm64'
    ]);
    expect(items).toEqual([
      {
        target: 'linux-x64',
        url: 'https://github.com/TracingInsights/petdex/releases/download/ti-pet-v0.1.0/ti-pet-linux-x64',
        asset: 'ti-pet-linux-x64',
        sha256: HASH,
        out: join(OUT_DIR, 'ti-pet-linux-x64')
      }
    ]);
    expect(missing).toEqual([
      'darwin-x64: not pinned yet',
      'linux-arm64: not in the pin'
    ]);
    expect(planFetch({ ...PIN, tag: null }, ['linux-x64']).items).toEqual([]);
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  test('unpinned: a warning and exit 0 (no native pet), --require fails', async () => {
    const warn = console.warn;
    const error = console.error;
    console.warn = () => {};
    console.error = () => {};
    // An unpinned copy: the committed native-pet.json may be pinned.
    const dir = mkdtempSync(join(tmpdir(), 'ti-pin-'));
    const pinFile = join(dir, 'native-pet.json');
    const committed = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
    writeFileSync(
      pinFile,
      JSON.stringify({
        ...committed,
        tag: null,
        files: Object.fromEntries(
          Object.entries(committed.files).map(([k, f]) => [
            k,
            { ...f, sha256: null }
          ])
        )
      })
    );
    try {
      expect(await main(['--target', 'linux-x64'], { pinFile })).toBe(0);
      expect(
        await main(['--target', 'linux-x64', '--require'], { pinFile })
      ).toBe(1);
      expect(await main(['--target', 'beos'], { pinFile })).toBe(1);
    } finally {
      console.warn = warn;
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('license texts are committed beside the binary and packed with it', () => {
    for (const name of NOTICE_FILES) {
      expect(existsSync(join(OUT_DIR, name))).toBe(true);
    }
    expect(readFileSync(join(OUT_DIR, 'LICENSE-petdex.txt'), 'utf8')).toContain(
      'MIT License'
    );
    expect(
      readFileSync(join(OUT_DIR, 'LICENSE-native-sdk.txt'), 'utf8')
    ).toContain('Apache License');
    const gitignore = readFileSync(join(OUT_DIR, '.gitignore'), 'utf8');
    const builder = readFileSync(
      join(OUT_DIR, '..', '..', 'electron-builder.yml'),
      'utf8'
    );
    for (const name of NOTICE_FILES) {
      expect(gitignore).toContain(`!${name}`);
    }
    expect(builder).toContain("- 'LICENSE-*.txt'");
    expect(builder).toContain("- 'THIRD-PARTY-NOTICES.md'");
  });
});
