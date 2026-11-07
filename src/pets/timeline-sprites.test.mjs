import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTimelineSpriteResolver,
  isInsideDir,
  TIMELINE_SPRITES_DIR
} from './timeline-sprites.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ti-sprites-'));
  roots.push(root);
  const userDataDir = join(root, 'ud');
  const codexPets = join(root, 'codex', 'pets', 'leclerc');
  mkdirSync(join(userDataDir, 'pets', 'petdex-lando'), { recursive: true });
  mkdirSync(codexPets, { recursive: true });
  const own = join(userDataDir, 'pets', 'petdex-lando', 'spritesheet.webp');
  const codex = join(codexPets, 'spritesheet.webp');
  writeFileSync(own, 'own-sheet');
  writeFileSync(codex, 'codex-sheet-v1');
  const paths = { 'pet-asset://pet/own': own, 'pet-asset://pet/codex': codex };
  const resolve = createTimelineSpriteResolver({
    userDataDir,
    fs,
    resolveSourcePath: (url) => paths[url] ?? null
  });
  return { userDataDir, own, codex, resolve };
}

describe('isInsideDir', () => {
  test('strictly inside only', () => {
    expect(isInsideDir('/u/ud', '/u/ud/pets/a.webp')).toBe(true);
    expect(isInsideDir('/u/ud', '/u/ud')).toBe(false);
    expect(isInsideDir('/u/ud', '/u/udx/a.webp')).toBe(false);
    expect(isInsideDir('/u/ud', '/u/ud/../x.webp')).toBe(false);
    expect(isInsideDir('/u/ud', '/home/me/.codex/pets/a/s.webp')).toBe(false);
  });
});

describe('createTimelineSpriteResolver', () => {
  test('own-store sprites keep their path; unknown urls stay null', () => {
    const { own, resolve } = setup();
    expect(resolve('pet-asset://pet/own')).toBe(own);
    expect(resolve('pet-asset://pet/missing')).toBeNull();
  });

  test('a Codex-folder sprite is copied inside userData (0600) and reused', () => {
    const { userDataDir, codex, resolve } = setup();
    const first = resolve('pet-asset://pet/codex');
    expect(first).not.toBeNull();
    expect(isInsideDir(join(userDataDir, TIMELINE_SPRITES_DIR), first)).toBe(
      true
    );
    expect(first.endsWith('.webp')).toBe(true);
    expect(readFileSync(first, 'utf8')).toBe('codex-sheet-v1');
    if (process.platform !== 'win32') {
      expect(statSync(first).mode & 0o777).toBe(0o600);
    }
    // Unchanged source: same copy, not rewritten.
    const before = statSync(first).ino;
    expect(resolve('pet-asset://pet/codex')).toBe(first);
    expect(statSync(first).ino).toBe(before);
    // The source is never modified.
    expect(readFileSync(codex, 'utf8')).toBe('codex-sheet-v1');
  });

  test('a changed Codex sprite refreshes the copy', () => {
    const { codex, resolve } = setup();
    const first = resolve('pet-asset://pet/codex');
    writeFileSync(codex, 'codex-sheet-v2-longer');
    const later = new Date(Date.now() + 5000);
    utimesSync(codex, later, later);
    expect(resolve('pet-asset://pet/codex')).toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('codex-sheet-v2-longer');
  });

  test('a missing Codex file gives null instead of throwing', () => {
    const { codex, resolve } = setup();
    rmSync(codex);
    expect(resolve('pet-asset://pet/codex')).toBeNull();
  });
});
