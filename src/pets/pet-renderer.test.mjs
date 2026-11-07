import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetRenderer,
  lastNativeStartFailed,
  NATIVE_FAILURE_FILE,
  recordNativeOutcome
} from './pet-renderer.mjs';

function fakeWindow(name, log) {
  let shown = false;
  return {
    isShown: () => shown,
    show: (o) => {
      shown = true;
      log.push([name, 'show', o]);
    },
    hide: () => {
      shown = false;
      log.push([name, 'hide']);
    },
    render: (p) => log.push([name, 'render', p.state]),
    moveBy: () => log.push([name, 'moveBy']),
    savePosition: () => log.push([name, 'savePosition']),
    secondSide: () => (name === 'native' ? 'right' : 'left'),
    groupRect: () => ({ name }),
    window: () => ({ name })
  };
}

function fakeNative(log, result, available = true) {
  return {
    ...fakeWindow('native', log),
    available: () => available,
    start: () => result
  };
}

const payload = (state, extra = {}) => ({
  state,
  size: 'm',
  second: null,
  ...extra
});

describe('createPetRenderer', () => {
  test('no bundled binary → the Electron window at once, as before', () => {
    const log = [];
    const changes = [];
    const renderer = createPetRenderer({
      native: null,
      electronWindow: fakeWindow('electron', log),
      onChange: (...c) => changes.push(c)
    });
    expect(renderer.kind()).toBe('electron');
    expect(renderer.reason()).toBe('not-bundled');
    expect(changes).toEqual([['electron', 'not-bundled']]);
    renderer.show({ size: 'm', duo: false });
    renderer.render(payload('idle'));
    expect(log).toEqual([
      ['electron', 'show', { size: 'm', duo: false }],
      ['electron', 'render', 'idle']
    ]);
    expect(renderer.window()).toEqual({ name: 'electron' });
  });

  test('pending records, then replays on the native pet', async () => {
    const log = [];
    const renderer = createPetRenderer({
      native: fakeNative(log, Promise.resolve({ ok: true, reason: null })),
      electronWindow: fakeWindow('electron', log)
    });
    expect(renderer.kind()).toBe('pending');
    renderer.show({ size: 's', duo: false });
    renderer.render(payload('waiting', { size: 'l', second: {} }));
    expect(renderer.isShown()).toBe(true);
    expect(log).toEqual([]);
    expect(await renderer.start()).toBe('native');
    // Seeded before connecting (its replay is a show, never a hide), then
    // the payload. The real native pet ignores the second show.
    expect(log).toEqual([
      ['native', 'show', { size: 'l', duo: true }],
      ['native', 'show', { size: 'l', duo: true }],
      ['native', 'render', 'waiting']
    ]);
    expect(renderer.secondSide()).toBe('right');
    // The native pet has no BrowserWindow (no pet:* IPC sender).
    expect(renderer.window()).toBeNull();
  });

  test('native start fails → Electron with the reason', async () => {
    const log = [];
    const renderer = createPetRenderer({
      native: fakeNative(
        log,
        Promise.resolve({ ok: false, reason: 'connect-timeout' })
      ),
      electronWindow: fakeWindow('electron', log)
    });
    renderer.show({ size: 'm', duo: false });
    expect(await renderer.start()).toBe('electron');
    expect(renderer.reason()).toBe('connect-timeout');
    expect(log).toEqual([
      // The seed of a pet that never connected (nothing is sent).
      ['native', 'show', { size: 'm', duo: false }],
      ['electron', 'show', { size: 'm', duo: false }]
    ]);
  });

  test('a later failure hides the native pet and moves the pet over', async () => {
    const log = [];
    const renderer = createPetRenderer({
      native: fakeNative(log, Promise.resolve({ ok: true, reason: null })),
      electronWindow: fakeWindow('electron', log)
    });
    await renderer.start();
    renderer.show({ size: 'm', duo: false });
    renderer.render(payload('running'));
    log.length = 0;
    renderer.fallback('crash-loop');
    expect(renderer.kind()).toBe('electron');
    expect(renderer.reason()).toBe('crash-loop');
    expect(log).toEqual([
      ['native', 'hide'],
      ['electron', 'show', { size: 'm', duo: false }],
      ['electron', 'render', 'running']
    ]);
    renderer.fallback('again');
    expect(renderer.reason()).toBe('crash-loop');
  });

  test('TIF1AI_PETS_RENDERER=electron (forceElectron) never starts the native pet', async () => {
    const log = [];
    let started = false;
    const native = {
      ...fakeNative(log, null),
      start: () => {
        started = true;
        return Promise.resolve({ ok: true, reason: null });
      }
    };
    const renderer = createPetRenderer({
      native,
      electronWindow: fakeWindow('electron', log),
      forceElectron: true
    });
    expect(await renderer.start()).toBe('electron');
    expect(renderer.reason()).toBe('disabled');
    expect(started).toBe(false);
  });
});

describe('native failure record (Wayland fallback)', () => {
  test('a failed start is remembered for that binary; success clears it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-renderer-'));
    try {
      const binaryPath = join(dir, 'ti-pet-linux-x64');
      writeFileSync(binaryPath, 'v1');
      const input = { fs, userDataDir: dir, binaryPath };
      expect(lastNativeStartFailed(input)).toBe(false);

      // Not failures: no binary / forced off / still pending.
      for (const [kind, reason] of [
        ['electron', 'not-bundled'],
        ['electron', 'disabled'],
        ['pending', null]
      ]) {
        recordNativeOutcome({ ...input, kind, reason });
        expect(lastNativeStartFailed(input)).toBe(false);
      }

      recordNativeOutcome({
        ...input,
        kind: 'electron',
        reason: 'connect-timeout'
      });
      expect(lastNativeStartFailed(input)).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(join(dir, NATIVE_FAILURE_FILE), 'utf8'))
          .reason
      ).toBe('connect-timeout');

      // A different build (an update) is tried as new.
      writeFileSync(binaryPath, 'v2-longer');
      utimesSync(binaryPath, new Date(), new Date(Date.now() + 5000));
      expect(lastNativeStartFailed(input)).toBe(false);

      recordNativeOutcome({ ...input, kind: 'electron', reason: 'crash-loop' });
      expect(lastNativeStartFailed(input)).toBe(true);
      recordNativeOutcome({ ...input, kind: 'native', reason: null });
      expect(lastNativeStartFailed(input)).toBe(false);
      expect(fs.existsSync(join(dir, NATIVE_FAILURE_FILE))).toBe(false);

      // No binary at all → never "failed"; a missing binary never throws.
      expect(lastNativeStartFailed({ ...input, binaryPath: null })).toBe(false);
      rmSync(binaryPath);
      recordNativeOutcome({
        ...input,
        kind: 'electron',
        reason: 'spawn-failed'
      });
      expect(lastNativeStartFailed(input)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
