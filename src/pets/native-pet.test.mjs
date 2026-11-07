/**
 * native-pet.mjs against a real child process: the Node stub in
 * test-fixtures/native-pet-stub.mjs speaks the protocol on a real Unix
 * socket (no Zig, no Electron).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNativePet,
  CRASH_LIMIT,
  isTrustedPipeServer,
  windowsProcessPath
} from './native-pet.mjs';
import { TOKEN_FILE } from './native-protocol.mjs';

const STUB = fileURLToPath(
  new URL('./test-fixtures/native-pet-stub.mjs', import.meta.url)
);
const unix = process.platform !== 'win32';

/** @type {string[]} */
const dirs = [];
/** @type {number[]} */
const pids = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}

function setup({ env = {}, binary = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pets-native-'));
  dirs.push(dir);
  const log = join(dir, 'stub.log');
  const calls = { events: [], menu: [], saved: [], failures: [], spawns: 0 };
  const deps = {
    binaryPath: binary ? STUB : join(dir, 'missing'),
    userDataDir: dir,
    tmpDir: dir,
    platform: process.platform,
    env: { ...process.env, ...env, STUB_LOG: log },
    appVersion: '0.2.0',
    appLaunch: { execPath: '/opt/TracingInsights/tracinginsights', args: [] },
    resolvePath: (url) =>
      url.startsWith('pet-asset://') ? `/pets/${url.split('/')[3]}.webp` : null,
    getPosition: () => ({ x: 1, y: 2 }),
    savePosition: (p) => calls.saved.push(p),
    onEvent: (...args) => calls.events.push(args),
    onMenuAction: (...args) => calls.menu.push(args),
    onFailure: (reason) => calls.failures.push(reason),
    // The stub is a script: run it with this runtime.
    spawn: (bin, args, options) => {
      calls.spawns += 1;
      const child = nodeSpawn(process.execPath, [bin, ...args], options);
      if (child.pid) pids.push(child.pid);
      return child;
    },
    net,
    fs
  };
  const lines = () => {
    try {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { dir, deps, calls, lines, pet: createNativePet(deps) };
}

const PAYLOAD = {
  state: 'running',
  row: 7,
  frames: 6,
  durationMs: 820,
  once: false,
  still: false,
  playKey: 'chat:streaming',
  bubble: 'Qualifying in 30 min · São Paulo GP',
  size: 'm',
  atlas: {
    url: 'pet-asset://pet/petdex%3Amax-4/sprite?v=0',
    rows: 9,
    scale: 1
  },
  second: null
};

describe.skipIf(!unix)('native pet over a real socket (Node stub)', () => {
  test('no bundled binary → not-bundled, nothing spawned', async () => {
    const { pet, calls } = setup({ binary: false });
    expect(pet.available()).toBe(false);
    expect(await pet.start()).toEqual({ ok: false, reason: 'not-bundled' });
    expect(calls.spawns).toBe(0);
  });

  test('spawns detached with the launch args, token 0600, GDK_BACKEND=x11 on Linux', async () => {
    const { pet, lines, dir } = setup();
    const result = await pet.start();
    expect(result).toEqual({ ok: true, reason: null });
    expect(pet.connected()).toBe(true);
    expect(pet.peer()?.version).toBe('stub');
    const spawned = lines().find((l) => l.kind === 'spawned');
    expect(spawned.argv).toEqual([
      '--socket',
      join(dir, 'pet.sock'),
      '--token-file',
      join(dir, TOKEN_FILE),
      '--user-data',
      dir,
      '--app',
      '/opt/TracingInsights/tracinginsights'
    ]);
    if (process.platform === 'linux') expect(spawned.gdk).toBe('x11');
    expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600);
    const hello = lines().find((l) => l.kind === 'hello');
    expect(hello.protocol).toBe(1);
    expect(hello.appVersion).toBe('0.2.0');
    expect(hello.token).toBe(
      readFileSync(join(dir, TOKEN_FILE), 'utf8').trim()
    );
    await pet.quit();
  });

  test('show / render / menu reach the pet; sprite URLs become file paths', async () => {
    const { pet, lines } = setup();
    await pet.start();
    pet.setMenu({ tray: [{ id: 'tray.quit', label: 'Quit' }], pet: [] });
    pet.show({ size: 'm', duo: false });
    pet.render(PAYLOAD);
    await until(() => lines().some((l) => l.kind === 'render'));
    const got = lines();
    expect(got.find((l) => l.kind === 'show')).toEqual({
      kind: 'show',
      size: 'm',
      duo: false,
      position: { x: 1, y: 2 }
    });
    const render = got.find((l) => l.kind === 'render').payload;
    expect(render.atlas).toEqual({
      path: '/pets/petdex%3Amax-4.webp',
      rows: 9,
      scale: 1
    });
    expect(render.bubble).toBe(PAYLOAD.bubble);
    expect(got.find((l) => l.kind === 'menu').tray[0].id).toBe('tray.quit');
    pet.hide();
    await until(() => lines().filter((l) => l.kind === 'hide').length >= 2);
    expect(pet.isShown()).toBe(false);
    await pet.quit();
  });

  test('events, positions and menu actions come back; savePosition uses the last drop', async () => {
    const { pet, calls } = setup({ env: { STUB_EVENTS: '1' } });
    await pet.start();
    await until(() => calls.events.length > 0 && calls.menu.length > 0);
    expect(calls.events[0][0]).toBe('click');
    expect(calls.menu[0]).toEqual(['tray.open-tracinginsights', undefined]);
    expect(pet.secondSide()).toBe('right');
    pet.savePosition();
    expect(calls.saved).toEqual([{ x: 40, y: 60, displayId: 'd1' }]);
    pet.moveBy(10, 10); // the native pet moved itself
    expect(calls.saved).toHaveLength(1);
    await pet.quit();
  });

  test('a second Electron adopts the running pet instead of spawning another', async () => {
    const first = setup();
    await first.pet.start();
    first.pet.detach();
    const second = createNativePet({ ...first.deps, onFailure: () => {} });
    const before = first.calls.spawns;
    expect(await second.start()).toEqual({ ok: true, reason: null });
    expect(first.calls.spawns).toBe(before);
    // The rotated token is what the pet checks now.
    const hellos = first.lines().filter((l) => l.kind === 'hello');
    expect(hellos).toHaveLength(2);
    expect(hellos[0].token).not.toBe(hellos[1].token);
    await second.quit();
  });

  test('adopt only (refresh mode) never spawns; takeOver false sends nothing', async () => {
    const { pet, calls, lines } = setup();
    expect(await pet.start({ allowSpawn: false, takeOver: false })).toEqual({
      ok: false,
      reason: 'not-running'
    });
    expect(calls.spawns).toBe(0);
    const owner = setup();
    owner.deps.userDataDir = owner.dir;
    await owner.pet.start();
    owner.pet.detach();
    const refresh = createNativePet({ ...owner.deps });
    expect(
      (await refresh.start({ allowSpawn: false, takeOver: false })).ok
    ).toBe(true);
    await wait(100);
    // Only the first Electron's replay `hide`; the refresh run took nothing over.
    expect(owner.lines().filter((l) => l.kind === 'hide')).toHaveLength(1);
    expect(await refresh.handoff(join(owner.dir, 'pet-timeline.json'))).toBe(
      true
    );
    expect(owner.lines().at(-1)).toEqual({
      kind: 'handoff',
      timelinePath: join(owner.dir, 'pet-timeline.json')
    });
    refresh.detach();
    expect(lines()).toEqual([]);
  });

  test('a socket other users could open is refused', async () => {
    const { pet, deps } = setup();
    await pet.start();
    pet.detach();
    fs.chmodSync(pet.socketPath, 0o666);
    const other = createNativePet({ ...deps });
    expect((await other.start({ allowSpawn: false })).ok).toBe(false);
    fs.chmodSync(pet.socketPath, 0o600);
    const again = createNativePet({ ...deps });
    expect((await again.start({ allowSpawn: false })).ok).toBe(true);
    await again.quit();
  });

  test('quit waits for the pet to exit', async () => {
    const { pet, lines } = setup();
    await pet.start();
    await pet.quit();
    expect(pet.connected()).toBe(false);
    expect(lines().at(-1).kind).toBe('quit');
    expect(fs.existsSync(pet.socketPath)).toBe(false);
  });

  test(`${CRASH_LIMIT} crashes within a minute → crash-loop failure`, async () => {
    const { pet, calls } = setup({ env: { STUB_CRASH: '1' } });
    await pet.start();
    await until(() => calls.failures.length > 0, 8000);
    expect(calls.failures).toEqual(['crash-loop']);
    expect(calls.spawns).toBe(CRASH_LIMIT);
    expect(pet.failed()).toBe(true);
  });
});

describe('Windows pipe-server check (pure)', () => {
  const BIN =
    'C:\\Program Files\\TracingInsights\\resources\\ti-pet\\ti-pet-win32-x64.exe';
  const check = (pid, path, extra = {}) =>
    isTrustedPipeServer({
      pid,
      spawnedPids: new Set([4242]),
      binaryPath: BIN,
      platform: 'win32',
      getProcessPath: async () => path,
      ...extra
    });

  test('our spawn, or the bundled binary (any case); nothing else', async () => {
    expect(await check(4242, null)).toBe(true);
    expect(await check(7, BIN.toUpperCase())).toBe(true);
    expect(await check(7, BIN.replace('resources\\', 'resources\\.\\'))).toBe(
      true
    );
    expect(await check(7, 'C:\\Users\\mallory\\ti-pet-win32-x64.exe')).toBe(
      false
    );
    expect(await check(7, null)).toBe(false);
    expect(await check(7, '')).toBe(false);
    expect(
      await check(7, BIN, {
        getProcessPath: async () => {
          throw new Error('no access');
        }
      })
    ).toBe(false);
    expect(await check(7, BIN, { binaryPath: null })).toBe(false);
    for (const pid of [0, -1, 1.5, '4242', null, undefined]) {
      expect(await check(pid, BIN)).toBe(false);
    }
  });

  test('windowsProcessPath asks System32 PowerShell for a validated pid', async () => {
    const calls = [];
    const execFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '  C:\\x\\ti-pet.exe\r\n');
    };
    const env = { SystemRoot: 'D:\\Win' };
    expect(await windowsProcessPath(31, { execFile, env })).toBe(
      'C:\\x\\ti-pet.exe'
    );
    expect(calls[0].file).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
    expect(calls[0].args.at(-1)).toBe(
      '(Get-Process -Id 31 -ErrorAction SilentlyContinue).Path'
    );
    expect(calls[0].options).toMatchObject({ windowsHide: true });
    // Never interpolates anything but a positive integer.
    expect(
      await windowsProcessPath(/** @type {any} */ ('1;calc'), { execFile, env })
    ).toBeNull();
    expect(await windowsProcessPath(-3, { execFile, env })).toBeNull();
    expect(calls).toHaveLength(1);
    // Errors and empty output (gone / another user's process) → null.
    expect(
      await windowsProcessPath(5, {
        execFile: (_f, _a, _o, cb) => cb(new Error('exit 1'), ''),
        env: {}
      })
    ).toBeNull();
    expect(
      await windowsProcessPath(5, {
        execFile: (_f, _a, _o, cb) => cb(null, '\r\n'),
        env: {}
      })
    ).toBeNull();
  });
});

describe.skipIf(!unix)('pipe-server pid check over a real socket', () => {
  test('a pet we spawned is trusted without a lookup', async () => {
    let lookups = 0;
    const { deps } = setup();
    const checked = createNativePet({
      ...deps,
      verifyServerPid: true,
      getProcessPath: async () => {
        lookups += 1;
        return null;
      }
    });
    expect(await checked.start()).toEqual({ ok: true, reason: null });
    expect(lookups).toBe(0);
    await checked.quit();
  });

  test('adopting: trusted when the pid runs the bundled binary', async () => {
    const first = setup();
    await first.pet.start();
    first.pet.detach();
    const pid = first.lines().find((l) => l.kind === 'spawned').pid;
    const seen = [];
    const second = createNativePet({
      ...first.deps,
      verifyServerPid: true,
      getProcessPath: async (p) => {
        seen.push(p);
        return first.deps.binaryPath;
      }
    });
    expect(await second.start()).toEqual({ ok: true, reason: null });
    expect(seen).toEqual([pid]);
    await second.quit();
  });

  test('a server that is not our pet → pipe-untrusted, no spawn, token replaced', async () => {
    const first = setup();
    await first.pet.start();
    first.pet.detach();
    const failures = [];
    const squatted = createNativePet({
      ...first.deps,
      onFailure: (reason) => failures.push(reason),
      verifyServerPid: true,
      getProcessPath: async () => 'C:\\Users\\mallory\\evil.exe'
    });
    const spawnsBefore = first.calls.spawns;
    expect(await squatted.start()).toEqual({
      ok: false,
      reason: 'pipe-untrusted'
    });
    expect(first.calls.spawns).toBe(spawnsBefore);
    expect(squatted.connected()).toBe(false);
    // The token the server saw in `hello` is no longer valid.
    const seenToken = first
      .lines()
      .filter((l) => l.kind === 'hello')
      .at(-1).token;
    const current = readFileSync(join(first.dir, TOKEN_FILE), 'utf8').trim();
    expect(current).toMatch(/^[0-9a-f]{64}$/);
    expect(current).not.toBe(seenToken);
    // Nothing after `hello` reached the untrusted server.
    expect(first.lines().at(-1).kind).toBe('hello');
    const owner = createNativePet({ ...first.deps });
    expect((await owner.start({ allowSpawn: false })).ok).toBe(true);
    await owner.quit();
  });

  test('a lookup that never answers is untrusted after verifyTimeoutMs', async () => {
    const first = setup();
    await first.pet.start();
    first.pet.detach();
    const hung = createNativePet({
      ...first.deps,
      verifyServerPid: true,
      verifyTimeoutMs: 200,
      getProcessPath: () => new Promise(() => {})
    });
    expect(await hung.start({ allowSpawn: false })).toEqual({
      ok: false,
      reason: 'pipe-untrusted'
    });
    const owner = createNativePet({ ...first.deps });
    expect((await owner.start({ allowSpawn: false })).ok).toBe(true);
    await owner.quit();
  });
});
