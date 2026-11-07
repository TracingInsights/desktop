/**
 * Desktop pets — Linux display-server handling (docs/DESKTOP_PETS_PLAN.md §4.9,
 * decision D13).
 *
 * Native Wayland forbids always-on-top and self-positioning, so a pet needs
 * the app to run under XWayland. Electron 38+ defaults to
 * `--ozone-platform=auto`, i.e. native Wayland whenever XDG_SESSION_TYPE is
 * `wayland` (Electron 44 inherits this).
 *
 * The platform has to be in the real argv: Chromium picks it before the main
 * script runs, so `app.commandLine.appendSwitch('ozone-platform', 'x11')`
 * from here would only reach the child processes (browser on Wayland, GPU and
 * renderers on X11 — OpenPets #108: no windows drawn). With pets on in a
 * Wayland session the app therefore relaunches itself once with
 * `--ozone-platform=x11` appended; the relaunched process sees the switch in
 * its argv and starts normally (no loop). Pets off → today's default.
 */

const OZONE = '--ozone-platform';

/** @param {Record<string, string|undefined>} env */
export function isWaylandSession(env) {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
}

/** XWayland (or plain X) is reachable. @param {Record<string, string|undefined>} env */
export function hasX11Display(env) {
  return Boolean(env.DISPLAY);
}

/**
 * The value of `--ozone-platform` in argv (`=value` or split form), else null.
 * @param {readonly string[]} argv
 */
export function ozonePlatformArg(argv) {
  let value = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith(`${OZONE}=`)) value = arg.slice(OZONE.length + 1);
    else if (
      arg === OZONE &&
      i + 1 < argv.length &&
      !argv[i + 1].startsWith('--')
    ) {
      value = argv[i + 1];
      i += 1;
    }
  }
  return value;
}

/**
 * argv without any `--ozone-platform` switch.
 * @param {readonly string[]} args
 */
export function stripOzoneArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith(`${OZONE}=`)) continue;
    if (arg === OZONE) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Where pets stand on this machine/session.
 * @param {{ platform: string, env: Record<string, string|undefined>, argv: readonly string[], enabled: boolean }} input
 * @returns {{
 *   supported: boolean,
 *   unsupportedReason: 'wayland-no-xwayland' | null,
 *   nativeWayland: boolean,
 *   needsRestartForPets: boolean
 * }}
 */
export function petsSupport({ platform, env, argv, enabled }) {
  if (platform !== 'linux' || !isWaylandSession(env)) {
    return {
      supported: true,
      unsupportedReason: null,
      nativeWayland: false,
      needsRestartForPets: false
    };
  }
  if (!hasX11Display(env)) {
    return {
      supported: false,
      unsupportedReason: 'wayland-no-xwayland',
      nativeWayland: true,
      needsRestartForPets: false
    };
  }
  const nativeWayland = ozonePlatformArg(argv) !== 'x11';
  return {
    supported: true,
    unsupportedReason: null,
    nativeWayland,
    needsRestartForPets: Boolean(enabled) && nativeWayland
  };
}

/**
 * Relaunch options that put the app on XWayland.
 * @param {{ argv: readonly string[], env: Record<string, string|undefined> }} input
 * @returns {{ args: string[], execPath?: string }}
 */
export function x11RelaunchOptions({ argv, env }) {
  const args = [...stripOzoneArgs(argv.slice(1)), `${OZONE}=x11`];
  // An AppImage runs from a temporary mount that disappears when this
  // process exits: relaunch the AppImage file itself.
  return env.APPIMAGE ? { args, execPath: env.APPIMAGE } : { args };
}

/**
 * Before `app.whenReady()`: relaunch under XWayland when pets are on in a
 * native-Wayland run. Call after the single-instance lock was won; the lock
 * is released first so the relaunched process can take it.
 * @param {{
 *   app: { relaunch: (options?: object) => void, exit: (code?: number) => void, releaseSingleInstanceLock?: () => void },
 *   platform: string,
 *   env: Record<string, string|undefined>,
 *   argv: readonly string[],
 *   enabled: boolean
 * }} input
 * @returns {boolean} true when this process is on its way out
 */
export function relaunchUnderXWaylandIfNeeded({
  app,
  platform,
  env,
  argv,
  enabled
}) {
  if (env.TIF1AI_PETS_NATIVE_WAYLAND === '1') return false;
  const support = petsSupport({ platform, env, argv, enabled });
  if (!support.needsRestartForPets) return false;
  app.releaseSingleInstanceLock?.();
  app.relaunch(x11RelaunchOptions({ argv, env }));
  app.exit(0);
  return true;
}

/**
 * `pets.restartApp()` — relaunch now (under XWayland when this is a Linux
 * Wayland session with an X display), then exit.
 * @param {{ app: { relaunch: (options?: object) => void, exit: (code?: number) => void }, platform: string, env: Record<string, string|undefined>, argv: readonly string[] }} input
 */
export function restartApp({ app, platform, env, argv }) {
  const toX11 =
    platform === 'linux' && isWaylandSession(env) && hasX11Display(env);
  if (toX11) app.relaunch(x11RelaunchOptions({ argv, env }));
  else if (env.APPIMAGE)
    app.relaunch({ execPath: env.APPIMAGE, args: argv.slice(1) });
  else app.relaunch();
  app.exit(0);
}
