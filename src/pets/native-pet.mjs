/**
 * Desktop pets — native pet connection (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.1,
 * §4.4, decisions N1–N4).
 *
 * Starts or adopts the native renderer (`ti-pet`) and exposes the same
 * seven-method interface the controller drives on pet-window.mjs (`show`,
 * `hide`, `isShown`, `render`, `moveBy`, `savePosition`, `secondSide`), plus
 * the hand-off, menu and quit calls the runtime needs.
 *
 * - Adopt first: a pet left running by an earlier Electron (closed to the
 *   tray) is reconnected, never duplicated. Otherwise the bundled binary is
 *   spawned detached (it must outlive us) and we connect within
 *   `connectTimeoutMs`.
 * - Trust: a fresh 32-byte token is written to `userData/pet-token` (0600)
 *   on every start; the native pet re-reads the file on each `hello`. On
 *   Unix the socket must be ours (owner uid, no group/other bits) before we
 *   connect. A Windows named pipe has no owner check Node can make, and
 *   another local user could create the name first (the pet's own pipe
 *   carries a current-user DACL, pipe_windows.zig): the `ready` pid must be
 *   a pet we spawned or a process whose executable is the bundled binary,
 *   else the pipe is refused (`pipe-untrusted` → the Electron pet) and the
 *   token the squatter saw is replaced.
 * - Crash guard: an unexpected disconnect respawns and replays the last
 *   show / menu / render; the third within CRASH_WINDOW_MS gives up
 *   (`onFailure('crash-loop')` → the runtime falls back to the Electron pet).
 * - The native pet moves its own window while dragging, so `moveBy` is a
 *   no-op here; `position` messages keep the last drop point for
 *   `savePosition` and the duo's `secondSide`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { join, posix, win32 } from 'node:path';
import {
  createLineDecoder,
  encodeLine,
  NATIVE_PROTOCOL_VERSION,
  nativeSocketPath,
  toNativeRender,
  TOKEN_FILE
} from './native-protocol.mjs';
import { groupRect, spriteSize } from './pet-window.mjs';

export const CONNECT_TIMEOUT_MS = 3000;
export const HANDOFF_ACK_MS = 1000;
export const QUIT_WAIT_MS = 3000;
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 60_000;
/** Longest wait for the Windows pipe-server pid check (a PowerShell lookup). */
export const VERIFY_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 100;

/**
 * Windows: the executable path of `pid`, via PowerShell's Get-Process (the
 * absolute System32 path, never PATH). Null when the process is gone or
 * belongs to another user (no path without admin rights) — both untrusted.
 * @param {number} pid
 * @param {{
 *   execFile: (file: string, args: string[], options: object, callback: (error: Error|null, stdout: string) => void) => void,
 *   env: Record<string, string|undefined>
 * }} deps
 * @returns {Promise<string|null>}
 */
export function windowsProcessPath(pid, { execFile, env }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const powershell = win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return new Promise((resolve) => {
    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`
      ],
      { timeout: 8000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const path = error ? '' : String(stdout ?? '').trim();
        resolve(path || null);
      }
    );
  });
}

/**
 * Is the pipe server that answered `ready` our pet? Trusted when its pid is
 * one we spawned, or when that process runs the bundled binary (a pet left
 * by an earlier Electron). Windows paths compare case-insensitively.
 * @param {{
 *   pid: unknown,
 *   spawnedPids: ReadonlySet<number>,
 *   binaryPath: string|null,
 *   platform: string,
 *   getProcessPath: (pid: number) => Promise<string|null>
 * }} input
 * @returns {Promise<boolean>}
 */
export async function isTrustedPipeServer({
  pid,
  spawnedPids,
  binaryPath,
  platform,
  getProcessPath
}) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  if (spawnedPids.has(pid)) return true;
  if (!binaryPath) return false;
  let path;
  try {
    path = await getProcessPath(pid);
  } catch {
    return false;
  }
  if (typeof path !== 'string' || !path) return false;
  const norm = (value) =>
    platform === 'win32'
      ? win32.resolve(value).toLowerCase()
      : posix.resolve(value);
  return norm(path) === norm(binaryPath);
}

/**
 * @param {{
 *   binaryPath: string|null,
 *   userDataDir: string,
 *   tmpDir: string,
 *   platform: string,
 *   env: Record<string, string|undefined>,
 *   appVersion: string,
 *   appLaunch: { execPath: string, args: readonly string[] },
 *   resolvePath: (spriteUrl: string) => string|null,
 *   getPosition: () => ({ x: number, y: number } | null),
 *   savePosition: (position: { x: number, y: number, displayId: string|null }) => void,
 *   onEvent: (event: string, dx?: number, dy?: number) => void,
 *   onMenuAction: (id: string, checked?: boolean) => void,
 *   onFailure: (reason: string) => void,
 *   spawn: (command: string, args: string[], options: object) => any,
 *   net: { createConnection: (path: string) => any },
 *   fs: {
 *     existsSync: (path: string) => boolean,
 *     writeFileSync: (path: string, data: string, options?: object) => void,
 *     chmodSync: (path: string, mode: number) => void,
 *     lstatSync: (path: string) => { isSocket: () => boolean, uid: number, mode: number }
 *   },
 *   getProcessPath?: (pid: number) => Promise<string|null>,
 *   verifyServerPid?: boolean,
 *   verifyTimeoutMs?: number,
 *   getuid?: () => number,
 *   randomBytes?: (n: number) => Buffer,
 *   now?: () => number,
 *   setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout,
 *   connectTimeoutMs?: number
 * }} deps
 */
export function createNativePet(deps) {
  const {
    binaryPath,
    userDataDir,
    tmpDir,
    platform,
    env,
    appVersion,
    appLaunch,
    resolvePath,
    getPosition,
    savePosition,
    onEvent,
    onMenuAction,
    onFailure,
    spawn,
    net,
    fs,
    // Windows: executable of a pid (runtime.mjs asks PowerShell). Without
    // it only pets we spawned ourselves are trusted.
    getProcessPath = async () => null,
    // The pipe-server pid check; on by default on Windows (tests turn it
    // on over a Unix socket).
    verifyServerPid = platform === 'win32',
    verifyTimeoutMs = VERIFY_TIMEOUT_MS,
    getuid = () => process.getuid?.() ?? -1,
    randomBytes = nodeRandomBytes,
    now = Date.now,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    connectTimeoutMs = CONNECT_TIMEOUT_MS
  } = deps;

  const socketPath = nativeSocketPath({ platform, userDataDir, tmpDir });
  const tokenPath = join(userDataDir, TOKEN_FILE);

  /** @type {any} */
  let socket = null;
  let ready = false;
  let failed = false;
  /** Set once we told the native pet to go (quit) or to carry on alone (handoff). */
  let released = false;
  /**
   * Connected but not driving: the pet keeps playing its timeline until the
   * first show / hide / render / menu (refresh mode never takes over).
   */
  let takeOver = true;
  let token = '';
  /** @type {any} */
  let child = null;
  /** @type {number[]} */
  const crashes = [];
  /** @type {null | { version: string, caps: string[], pid: number|null }} */
  let peer = null;
  /** Pids of pets this Electron spawned (trusted without a path lookup). */
  /** @type {Set<number>} */
  const spawnedPids = new Set();
  /** Set when a pipe server failed the pid check: stop, never retry. */
  let untrusted = false;

  // Replayed after every (re)connect.
  let shown = false;
  /** @type {null | { size: string, duo: boolean }} */
  let showOptions = null;
  /** @type {object|null} */
  let lastRender = null;
  /** @type {object|null} */
  let lastMenu = null;
  /** @type {null | { x: number, y: number, displayId: string|null, secondSide: 'left'|'right' }} */
  let position = null;

  /** @type {Set<() => void>} */
  const ackWaiters = new Set();
  /** @type {Set<() => void>} */
  const closeWaiters = new Set();

  /** `promise`, or false after `ms` (a hung process lookup is untrusted). */
  const withTimeout = (promise, ms) =>
    new Promise((resolve) => {
      const t = setTimer(() => resolve(false), ms);
      promise.then(
        (value) => {
          clearTimer(t);
          resolve(value);
        },
        () => {
          clearTimer(t);
          resolve(false);
        }
      );
    });

  const delay = (ms) =>
    new Promise((resolve) => {
      const t = setTimer(resolve, ms);
      t?.unref?.();
    });

  function writeToken() {
    token = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    // writeFileSync keeps an existing file's mode.
    if (platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
  }

  /** A Unix socket we may connect to: ours, not group/other accessible. */
  function socketIsSafe() {
    if (platform === 'win32') return true;
    try {
      const st = fs.lstatSync(socketPath);
      return st.isSocket() && st.uid === getuid() && (st.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!socket || !ready) return false;
    try {
      socket.write(encodeLine(message));
      return true;
    } catch (error) {
      console.warn('[pets] native send:', error);
      return false;
    }
  }

  function handle(message) {
    switch (message.kind) {
      case 'event':
        onEvent(message.event, message.dx, message.dy);
        return;
      case 'position':
        position = {
          x: message.x,
          y: message.y,
          displayId: message.displayId,
          secondSide: message.secondSide
        };
        return;
      case 'menuAction':
        onMenuAction(message.id, message.checked);
        return;
      case 'ack':
        for (const resolve of ackWaiters) resolve();
        ackWaiters.clear();
        return;
      case 'error':
        console.warn('[pets] native error:', message.code, message.message);
        return;
      default:
    }
  }

  /**
   * Connect, say hello, wait for `ready`. Resolves the socket or null.
   * @returns {Promise<any>}
   */
  function connectOnce() {
    return new Promise((resolve) => {
      if (!socketIsSafe()) {
        resolve(null);
        return;
      }
      let settled = false;
      const decoder = createLineDecoder();
      const conn = net.createConnection(socketPath);
      const timer = setTimer(() => finish(null), connectTimeoutMs);
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (!value) conn.destroy?.();
        resolve(value);
      }
      conn.on('error', () => finish(null));
      conn.on('connect', () => {
        conn.write(
          encodeLine({
            kind: 'hello',
            token,
            protocol: NATIVE_PROTOCOL_VERSION,
            appVersion
          })
        );
      });
      /** Lines that arrive while the server's pid is being checked. */
      /** @type {object[]|null} */
      let held = null;
      let closedWhileHeld = false;
      function accept(message) {
        peer = {
          version: message.version,
          caps: message.caps,
          pid: message.pid
        };
        finish(conn);
      }
      conn.on('data', (chunk) => {
        const { messages, error } = decoder.push(chunk);
        for (const message of messages) {
          if (held) {
            held.push(message);
            continue;
          }
          if (!settled) {
            if (
              message.kind === 'ready' &&
              message.protocol === NATIVE_PROTOCOL_VERSION
            ) {
              if (!verifyServerPid) {
                accept(message);
                continue;
              }
              // The lookup may take longer than the connect window.
              clearTimer(timer);
              held = [];
              void withTimeout(
                isTrustedPipeServer({
                  pid: message.pid,
                  spawnedPids,
                  binaryPath,
                  platform,
                  getProcessPath
                }),
                verifyTimeoutMs
              ).then((trusted) => {
                const later = held ?? [];
                held = null;
                if (settled) return;
                if (closedWhileHeld && trusted) {
                  finish(null);
                  return;
                }
                if (!trusted) {
                  untrusted = true;
                  console.warn(
                    '[pets] native pipe server is not our pet (pid',
                    message.pid,
                    '): refused'
                  );
                  finish(null);
                  return;
                }
                accept(message);
                for (const next of later) handle(next);
              });
              continue;
            }
            finish(null);
            return;
          }
          handle(message);
        }
        if (error) {
          console.warn('[pets] native protocol error:', error);
          conn.destroy?.();
        }
      });
      conn.on('close', () => {
        if (!settled) {
          if (held) closedWhileHeld = true;
          else finish(null);
        } else if (socket === conn) onDisconnect();
      });
    });
  }

  /** Try to connect until `deadline` (the pet may still be starting). */
  async function connectUntil(deadline) {
    for (;;) {
      const conn = await connectOnce();
      if (conn) return conn;
      if (untrusted || now() >= deadline) return null;
      await delay(CONNECT_RETRY_MS);
    }
  }

  /** argv for the native pet (spawn and the login item). */
  function nativeArgs() {
    return [
      '--socket',
      socketPath,
      '--token-file',
      tokenPath,
      '--user-data',
      userDataDir,
      '--app',
      appLaunch.execPath,
      ...appLaunch.args.flatMap((arg) => ['--app-arg', arg])
    ];
  }

  function spawnNative() {
    const args = nativeArgs();
    const childEnv = { ...env };
    // ti-pet marks its window above others through X11 (plan §3): under a
    // Wayland session it runs on XWayland, Electron itself does not have to.
    if (platform === 'linux') childEnv.GDK_BACKEND = 'x11';
    child = spawn(binaryPath, args, {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
      windowsHide: true
    });
    const spawned = child;
    if (typeof spawned?.pid === 'number') spawnedPids.add(spawned.pid);
    spawned.on?.('error', (error) => {
      console.warn('[pets] native spawn:', error);
    });
    spawned.on?.('exit', () => {
      if (child === spawned) child = null;
    });
    spawned.unref?.();
  }

  /** Take over (again): menus + the pet's current look; hidden → `hide`. */
  function replay() {
    if (!takeOver) return;
    if (lastMenu) send({ kind: 'menu', ...lastMenu });
    if (shown && showOptions) {
      send({ kind: 'show', ...showOptions, position: getPosition() });
      if (lastRender) send({ kind: 'render', payload: lastRender });
    } else {
      send({ kind: 'hide' });
    }
  }

  /** A squatter saw the token in our `hello`: replace it (best effort). */
  function refuseUntrusted() {
    try {
      writeToken();
    } catch (error) {
      console.warn('[pets] native token:', error);
    }
    return { ok: false, reason: 'pipe-untrusted' };
  }

  async function establish({ allowSpawn }) {
    let conn = await connectOnce();
    if (untrusted) return refuseUntrusted();
    if (!conn && allowSpawn) {
      try {
        spawnNative();
      } catch (error) {
        console.warn('[pets] native spawn:', error);
        return { ok: false, reason: 'spawn-failed' };
      }
      conn = await connectUntil(now() + connectTimeoutMs);
      if (untrusted) return refuseUntrusted();
    }
    if (!conn) {
      return {
        ok: false,
        reason: allowSpawn ? 'connect-timeout' : 'not-running'
      };
    }
    socket = conn;
    ready = true;
    replay();
    return { ok: true, reason: null };
  }

  function fail(reason) {
    if (failed) return;
    failed = true;
    ready = false;
    socket?.destroy?.();
    socket = null;
    onFailure(reason);
  }

  function onDisconnect() {
    socket = null;
    ready = false;
    for (const resolve of closeWaiters) resolve();
    closeWaiters.clear();
    if (released || failed) return;
    const t = now();
    crashes.push(t);
    while (crashes.length && crashes[0] <= t - CRASH_WINDOW_MS) crashes.shift();
    if (crashes.length >= CRASH_LIMIT) {
      fail('crash-loop');
      return;
    }
    void establish({ allowSpawn: true }).then((result) => {
      if (!result.ok) fail(result.reason ?? 'connect-timeout');
    });
  }

  return {
    socketPath,
    tokenPath,
    /** Bundled binary present? (no binary → the Electron pet, as before N3). */
    available: () => Boolean(binaryPath) && fs.existsSync(binaryPath),
    connected: () => ready,
    failed: () => failed,
    /** Pid of the native pet (from `ready`), for update installs. */
    peer: () => peer,

    /** argv the native pet is started with (the login item reuses it). */
    launchArgs: () => nativeArgs(),

    /**
     * Adopt a running pet or spawn one. `allowSpawn: false` = adopt only
     * (refresh mode: never start a pet nobody asked for); `takeOver: false`
     * = connect without driving it. Calling again while connected takes
     * over (a refresh run the user turned into a normal start).
     * @param {{ allowSpawn?: boolean, takeOver?: boolean }} [options]
     * @returns {Promise<{ ok: boolean, reason: string|null }>}
     */
    async start({ allowSpawn = true, takeOver: take = true } = {}) {
      if (ready) {
        released = false;
        failed = false;
        if (take && !takeOver) {
          takeOver = true;
          replay();
        }
        return { ok: true, reason: null };
      }
      takeOver = take;
      failed = false;
      released = false;
      untrusted = false;
      if (!binaryPath || !fs.existsSync(binaryPath)) {
        return { ok: false, reason: 'not-bundled' };
      }
      try {
        writeToken();
      } catch (error) {
        console.warn('[pets] native token:', error);
        return { ok: false, reason: 'token-failed' };
      }
      const result = await establish({ allowSpawn });
      if (!result.ok) failed = true;
      return result;
    },

    // --- petWindow interface (controller.mjs) ---

    isShown: () => shown,
    /** @param {{ size: string, duo?: boolean }} options */
    show(options) {
      if (shown) return;
      shown = true;
      showOptions = { size: options?.size ?? 'm', duo: Boolean(options?.duo) };
      send({ kind: 'show', ...showOptions, position: getPosition() });
    },
    hide() {
      if (!shown) return;
      shown = false;
      lastRender = null;
      send({ kind: 'hide' });
    },
    /** @param {object} payload controller render payload */
    render(payload) {
      const native = toNativeRender(payload, resolvePath);
      if (!native) return;
      lastRender = native;
      if (showOptions) {
        showOptions = { size: native.size, duo: native.second !== null };
      }
      send({ kind: 'render', payload: native });
    },
    /** The native pet already moved its window (no round trip). */
    moveBy() {},
    savePosition() {
      if (!position) return;
      savePosition({
        x: position.x,
        y: position.y,
        displayId: position.displayId
      });
    },
    /** @returns {'left'|'right'} */
    secondSide: () => position?.secondSide ?? 'left',
    /** Both sprites' rect (the ask window's anchor), or null. */
    groupRect() {
      if (!shown || !position || !showOptions) return null;
      const box = spriteSize(showOptions.size);
      return groupRect(
        { x: position.x, y: position.y, ...box },
        showOptions.duo
      );
    },
    /** No BrowserWindow: the native pet shows its own context menu. */
    window: () => null,

    // --- Runtime calls ---

    /** @param {{ tray: object[], pet: object[] }} menu */
    setMenu(menu) {
      lastMenu = { tray: menu.tray, pet: menu.pet };
      send({ kind: 'menu', ...lastMenu });
    },

    /**
     * Hand the pet over before Electron exits: it plays `timelinePath`
     * from now on. Resolves true on `ack` within HANDOFF_ACK_MS.
     * @param {string} timelinePath
     */
    handoff(timelinePath) {
      if (!ready) return Promise.resolve(false);
      return new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          ackWaiters.delete(onAck);
          if (value) released = true;
          resolve(value);
        };
        const onAck = () => finish(true);
        const timer = setTimer(() => finish(false), HANDOFF_ACK_MS);
        ackWaiters.add(onAck);
        if (!send({ kind: 'handoff', timelinePath })) finish(false);
      });
    },

    /**
     * Ask the native pet to exit and wait until its connection closes
     * (≤ QUIT_WAIT_MS): before an update install (Windows locks a running
     * exe) and on Quit.
     */
    quit() {
      released = true;
      if (!ready) return Promise.resolve();
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimer(timer);
          closeWaiters.delete(finish);
          resolve();
        };
        const timer = setTimer(finish, QUIT_WAIT_MS);
        closeWaiters.add(finish);
        if (!send({ kind: 'quit' })) finish();
      });
    },

    /** Drop the connection without telling the pet to exit (refresh mode end). */
    detach() {
      released = true;
      ready = false;
      socket?.end?.();
      socket = null;
    }
  };
}
