import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeNativeState, parseNativeState } from './native-state.mjs';
import { NATIVE_STATE_FILE } from './native-protocol.mjs';
import { createPetsSettings } from './settings.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pets-native-state-'));
  dirs.push(dir);
  return dir;
};

describe('parseNativeState', () => {
  test('valid fields only, field by field', () => {
    expect(
      parseNativeState({
        v: 1,
        enabled: false,
        size: 'xl',
        quietUntil: '2026-11-07T19:00:00.000Z',
        launchAtLogin: 'yes',
        position: { x: 10.6, y: -3 },
        shownMoments: [
          { name: 'lastFactDay', value: '2026-11-07' },
          { name: 'activePetId', value: 'petdex:evil' }
        ]
      })
    ).toEqual({
      patch: { enabled: false, quietUntil: '2026-11-07T19:00:00.000Z' },
      markers: [{ name: 'lastFactDay', value: '2026-11-07' }],
      position: { x: 11, y: -3 }
    });
    expect(parseNativeState({ v: 2, enabled: true }).patch).toEqual({});
    expect(parseNativeState(null).patch).toEqual({});
  });
});

describe('mergeNativeState', () => {
  test('applies the native pet’s changes, then deletes the file', () => {
    const dir = tempDir();
    const settings = createPetsSettings({ userDataDir: dir });
    settings.update({ enabled: true, size: 'm' }, { trusted: true });
    writeFileSync(
      join(dir, NATIVE_STATE_FILE),
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-07T10:00:00.000Z',
        size: 'l',
        quietUntil: null,
        position: { x: 100, y: 200 },
        shownMoments: [
          { name: 'lastRateKey', value: '2026-21-race' },
          { name: 'lastFactDay', value: '2026-11-07' }
        ]
      })
    );
    const result = mergeNativeState({ userDataDir: dir, settings });
    expect(result).toEqual({
      applied: ['size', 'quietUntil', 'position'],
      markers: 2
    });
    const after = settings.get();
    expect(after.size).toBe('l');
    expect(after.enabled).toBe(true);
    expect(after.positions.last).toEqual({ x: 100, y: 200 });
    expect(after.lastRateKey).toBe('2026-21-race');
    expect(after.lastFactDay).toBe('2026-11-07');
    expect(existsSync(join(dir, NATIVE_STATE_FILE))).toBe(false);
  });

  test('no file → nothing; a corrupt file is dropped', () => {
    const dir = tempDir();
    const settings = createPetsSettings({ userDataDir: dir });
    expect(mergeNativeState({ userDataDir: dir, settings })).toEqual({
      applied: [],
      markers: 0
    });
    writeFileSync(join(dir, NATIVE_STATE_FILE), '{oops');
    expect(mergeNativeState({ userDataDir: dir, settings }).applied).toEqual(
      []
    );
    expect(existsSync(join(dir, NATIVE_STATE_FILE))).toBe(false);
  });
});
