/**
 * Desktop pets — app lifecycle (docs/DESKTOP_PETS_PLAN.md §4.7, decisions D7/D8).
 *
 * - Close to tray (default on): closing the main window destroys it (frees
 *   the web app's memory; a streaming answer is aborted by the harness) and
 *   the app keeps running with the tray (+ pet). First time: one native
 *   notification. `closeToTray` off → today's behaviour (quit on
 *   Windows/Linux, stay in the dock on macOS).
 * - Reopen paths (tray, pet double-click, bubble click, second instance,
 *   macOS activate) recreate the window when it was destroyed.
 * - Launch at login: `app.setLoginItemSettings` on Windows/macOS; on Linux an
 *   XDG autostart entry. A login start passes `--hidden` → no main window.
 *   With the native pet in use (`loginTarget`, docs/DESKTOP_PETS_NATIVE_PLAN.md
 *   N4) Windows and Linux start the native pet itself instead; macOS keeps
 *   the app's own login item (a hidden start hands straight off to the pet).
 * - First-run onboarding (plan §12 #12): the first normal start with no pet
 *   opens the main window on `/settings/pets?welcome=1` instead of `/` — once:
 *   `onboardingShown` is set right after the window is created (the page
 *   also calls `pets.onboardingDone()`), so a crash never loops.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HIDDEN_ARG = '--hidden';
export const AUTOSTART_FILE = 'tracinginsights.desktop';
export const ONBOARDING_PATH = '/settings/pets?welcome=1';

/** Quote one Exec argument (XDG Desktop Entry spec). @param {string} arg */
export function quoteExecArg(arg) {
  const escaped = arg.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%');
  return /[\s"'\\`$<>|;&*?#()~]/.test(arg) || arg.length === 0
    ? `"${escaped}"`
    : escaped;
}

/**
 * The Linux autostart entry.
 * @param {{ execPath: string, appPath?: string|null, args?: readonly string[] }} input
 *   appPath only when unpackaged; args default to `--hidden`
 */
export function linuxAutostartEntry({
  execPath,
  appPath = null,
  args = [HIDDEN_ARG]
}) {
  const exec = [execPath, ...(appPath ? [appPath] : []), ...args]
    .map(quoteExecArg)
    .join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=TracingInsights',
    'Comment=TracingInsights desktop app (tray and desktop pet)',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

/**
 * Arguments the native pet passes when it starts this app again
 * (`--pets-open`, `--pets-refresh`, …). Dev runs need the app directory, and a
 * `--user-data-dir` profile must carry over, or the relaunch opens the
 * default profile and never finds this pet's socket.
 * @param {readonly string[]} argv
 * @param {{ isPackaged: boolean, appPath: string }} app
 * @returns {string[]}
 */
export function appLaunchArgs(argv, { isPackaged, appPath }) {
  const args = isPackaged ? [] : [appPath];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--user-data-dir=')) args.push(arg);
    else if (arg === '--user-data-dir' && argv[i + 1]) {
      args.push(`--user-data-dir=${argv[i + 1]}`);
    }
  }
  return args;
}

/** @param {{ env: Record<string, string|undefined>, homeDir: string }} input */
export function linuxAutostartPath({ env, homeDir }) {
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
      ? env.XDG_CONFIG_HOME
      : join(homeDir, '.config');
  return join(configHome, 'autostart', AUTOSTART_FILE);
}

/**
 * @param {{
 *   app: {
 *     quit: () => void,
 *     isPackaged?: boolean,
 *     getAppPath?: () => string,
 *     setLoginItemSettings?: (settings: object) => void,
 *     getLoginItemSettings?: () => { wasOpenedAtLogin?: boolean }
 *   },
 *   platform: string,
 *   env: Record<string, string|undefined>,
 *   argv: readonly string[],
 *   execPath: string,
 *   homeDir: string,
 *   settings: {
 *     get: () => { closeToTray: boolean, firstTrayNoticeShown: boolean, notifications?: boolean, onboardingShown?: boolean, activePetId?: string|null },
 *     markTrayNoticeShown: () => unknown,
 *     markOnboardingShown?: () => unknown
 *   },
 *   createMainWindow: (path?: string) => unknown,
 *   getMainWindow: () => ({ isDestroyed: () => boolean, isMinimized: () => boolean, restore: () => void, show: () => void, focus: () => void } | null),
 *   navigateMain: (window: object, path: string) => void,
 *   notify: (notice: { title: string, body: string }) => void,
 *   ensureTray: () => void,
 *   loginTarget?: () => ({ execPath: string, args: readonly string[] } | null),
 *   fs?: { mkdirSync: typeof mkdirSync, writeFileSync: typeof writeFileSync, rmSync: typeof rmSync }
 * }} deps
 */
export function createLifecycle(deps) {
  const {
    app,
    platform,
    env,
    argv,
    execPath,
    homeDir,
    settings,
    createMainWindow,
    getMainWindow,
    navigateMain,
    notify,
    ensureTray,
    loginTarget = () => null,
    fs = { mkdirSync, writeFileSync, rmSync }
  } = deps;
  let quitting = false;

  function liveMainWindow() {
    const window = getMainWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  /**
   * Show the main window, recreating it if it was closed to the tray.
   * @param {string} [path] app path to open (e.g. '/', '/settings/pets')
   */
  function openMain(path) {
    const window = liveMainWindow();
    if (!window) {
      createMainWindow(path);
      return;
    }
    if (path) navigateMain(window, path);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** The path the first main window opens on: the welcome step once, else none ('/'). */
  function startPath() {
    const current = settings.get();
    return current.onboardingShown === false &&
      (current.activePetId ?? null) === null
      ? ONBOARDING_PATH
      : undefined;
  }

  /**
   * App start, not hidden: create the main window — on the welcome step
   * when it is due, then mark it shown.
   * @returns {string} the path opened
   */
  function startMain() {
    const path = startPath();
    createMainWindow(path);
    if (path) {
      try {
        settings.markOnboardingShown?.();
      } catch (error) {
        console.warn('[pets] onboarding marker:', error);
      }
    }
    return path ?? '/';
  }

  return {
    /** Started by the OS at login → tray (+ pet) only. */
    startedHidden() {
      if (argv.includes(HIDDEN_ARG)) return true;
      if (platform === 'darwin') {
        try {
          return Boolean(app.getLoginItemSettings?.().wasOpenedAtLogin);
        } catch {
          return false;
        }
      }
      return false;
    },

    /** `before-quit`: from here on a closing window is a real quit. */
    markQuitting() {
      quitting = true;
    },
    isQuitting: () => quitting,

    openMain,

    startPath,
    startMain,

    /** `second-instance` / macOS `activate`. */
    focusMainWindow: () => openMain(),

    /**
     * The main window has been destroyed.
     * @returns {'tray'|'quit'|'stay'} what happened (for tests / logs)
     */
    onMainWindowClosed() {
      if (quitting) return 'quit';
      const current = settings.get();
      if (!current.closeToTray) {
        // Today's behaviour; the pet window must not keep the app alive.
        if (platform !== 'darwin') {
          app.quit();
          return 'quit';
        }
        return 'stay';
      }
      ensureTray();
      // Notifications off: leave the marker unset so turning them back on
      // shows the notice once.
      if (!current.firstTrayNoticeShown && current.notifications !== false) {
        settings.markTrayNoticeShown();
        try {
          notify({
            title: 'TracingInsights is still running',
            body: 'Open or quit it from the tray icon — or start TracingInsights again to reopen the window.'
          });
        } catch {
          // Notifications unavailable (no daemon): the tray still works.
        }
      }
      return 'tray';
    },

    /** `window-all-closed`: quit only when close-to-tray is off (not macOS). */
    shouldQuitOnAllClosed() {
      return !settings.get().closeToTray && platform !== 'darwin';
    },

    /** @param {boolean} enabled */
    applyLaunchAtLogin(enabled) {
      const target = platform === 'darwin' ? null : loginTarget();
      if (platform === 'linux') {
        const path = linuxAutostartPath({ env, homeDir });
        if (!enabled) {
          fs.rmSync(path, { force: true });
          return;
        }
        const exe = env.APPIMAGE || execPath;
        const appPath =
          app.isPackaged === false && !env.APPIMAGE
            ? (app.getAppPath?.() ?? null)
            : null;
        fs.mkdirSync(join(path, '..'), { recursive: true });
        fs.writeFileSync(
          path,
          target
            ? linuxAutostartEntry({
                execPath: target.execPath,
                args: target.args
              })
            : linuxAutostartEntry({ execPath: exe, appPath }),
          { mode: 0o644 }
        );
        return;
      }
      if (platform === 'win32') {
        // Same Run-key value either way, so switching target replaces it.
        app.setLoginItemSettings?.(
          target
            ? {
                openAtLogin: enabled,
                path: target.execPath,
                args: [...target.args]
              }
            : { openAtLogin: enabled, args: [HIDDEN_ARG] }
        );
        return;
      }
      app.setLoginItemSettings?.({ openAtLogin: enabled });
    }
  };
}
