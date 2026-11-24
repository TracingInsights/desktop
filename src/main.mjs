/**
 * TracingInsights Desktop — Electron shell + inference harness.
 *
 * The main window loads the production web app (https://tracinginsights.com).
 * The Electron main process is the inference harness: it owns custom-provider
 * credentials (safeStorage), the Codex/xAI device-auth + credential stores,
 * the protocol adapters (anthropic-messages / openai-completions /
 * openai-responses), and streaming. The website keeps product orchestration
 * (prompts, SQL planning, DuckDB, resilience) and drives inference through the
 * typed `window.tif1aiDesktop` surface (preload.cjs).
 *
 * There is no localhost HTTP bridge and no pairing token — the old
 * desktop/src/bridge.mjs was removed with this change (see
 * docs/custom-providers-desktop.md).
 *
 * Desktop pets (docs/DESKTOP_PETS_PLAN.md) live in ./pets/: a floating pet
 * window, tray, close-to-tray lifecycle, the quick-ask window and the
 * `pets:*` IPC, assembled by pets/runtime.mjs once the app is ready. The
 * quick-ask window loads the app with this preload, so the harness trusts it
 * like the main window.
 *
 * Native pet (docs/DESKTOP_PETS_NATIVE_PLAN.md): a bundled `ti-pet` binary
 * (resources/ti-pet/) draws the pet and owns the tray; closing the window
 * hands the pet over and quits. The pet starts the app again with
 * `--pets-refresh` (windowless timeline recompile), `--pets-open=<path>`
 * (Open / Choose pet… / bubble clicks) or `--pets-install-update`.
 */
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences
} from 'electron';
import * as nodeFs from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appOriginsFor, isAppOrigin } from './app-origin.mjs';
import { createProviderRegistry } from './provider-registry.mjs';
import { createCredentialStore } from './credential-store.mjs';
import { createCodexAuth } from './codex-auth.mjs';
import { createXaiAuth } from './xai-auth.mjs';
import { createCodexInference } from './codex-inference.mjs';
import { createXaiInference } from './xai-inference.mjs';
import { createInference } from './inference.mjs';
import {
  abortOnNavigation,
  createHarnessIpc,
  isTrustedAppSender
} from './ipc.mjs';
import { listModels } from './model-discovery.mjs';
import {
  MODEL_LOAD_GRACE_MS,
  STREAM_IDLE_TIMEOUT_MS
} from './protocols/shared.mjs';
import { readSettingsSync } from './pets/settings.mjs';
import { PET_PRIVILEGED_SCHEMES } from './pets/protocols.mjs';
import { relaunchUnderXWaylandIfNeeded } from './pets/linux.mjs';
import { appLaunchArgs } from './pets/lifecycle.mjs';
import { createPetsRuntime } from './pets/runtime.mjs';
import { lastNativeStartFailed } from './pets/pet-renderer.mjs';
import {
  INSTALL_UPDATE_ARG,
  nativeBinaryName,
  parsePetsOpenArg,
  REFRESH_ARG
} from './pets/native-protocol.mjs';
import { isAskPath } from './pets/ask-window.mjs';
import { createNotifier } from './pets/notify.mjs';
import { attachZoomKeys } from './zoom-keys.mjs';
import { selfUpdateSupport } from './update-support.mjs';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;

// Deliberately kept in sync with the `harnessVersion` string exposed by
// preload.cjs (sandboxed preloads cannot read local files). Bump both when the
// harness surface changes. The web app keys the legacy-credential migration
// decision (docs/custom-providers-desktop.md §8/OQ1) off this value.
export const HARNESS_VERSION = '1.1.0';

// Delay the first update check so it never competes with app startup.
const UPDATE_CHECK_STARTUP_DELAY_MS = 10_000;
// Closing the window keeps the app in the tray, so it can run for days:
// check again periodically, not only at launch.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override in dev with TIF1AI_APP_URL=http://localhost:5173 or
// TIF1AI_APP_URL=http://127.0.0.1:5173. Builds before the host switch
// (0.2.2 and older) load app.tracinginsights.com, which Cloudflare leaves
// unredirected for Electron (docs/HOST_SWITCH_PLAN.md step 10).
const APP_URL = process.env.TIF1AI_APP_URL || 'https://tracinginsights.com';
/** Origins that are the app (both production hosts around the host switch). */
const APP_ORIGINS = appOriginsFor(APP_URL);

// On-device model (WebGPU): Chromium on Linux runs WebGPU on Vulkan and ships
// with both off, so the model reports "Not supported". A Chrome user sets them
// in chrome://flags (the site's help: linux-vulkan, linux-webgpu-flag); the app
// has no flags page, so it sets them itself. Switches must be set before
// `ready`. TIF1AI_NO_WEBGPU_FLAGS=1 leaves them off (e.g. if Vulkan breaks
// video playback with some driver, as it can in Chrome).
if (process.platform === 'linux' && !process.env.TIF1AI_NO_WEBGPU_FLAGS) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
}

let mainWindow = null;
/** Desktop pets runtime (built after `ready`). */
let pets = null;

// ---------------------------------------------------------------------------
// Harness wiring
// ---------------------------------------------------------------------------

let harness = null;

/**
 * Build the harness (registry, credential stores, auth + inference adapters,
 * IPC). Constructed once `app` is ready (safeStorage is unusable before then).
 */
function buildHarness() {
  const userDataDir = app.getPath('userData');

  const registry = createProviderRegistry({
    userDataDir,
    safeStorage,
    // Native confirmation on any write that reroutes traffic (add, or
    // baseUrl/protocol change). Metadata-only edits apply silently.
    confirm: (baseUrl) =>
      dialog
        .showMessageBox(mainWindow ?? undefined, {
          type: 'warning',
          buttons: ['Route traffic', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Route chat traffic',
          message: `Route chat traffic to ${baseUrl}?`,
          detail:
            'Prompts, SQL, and results for this provider will be sent to this endpoint.'
        })
        .then(({ response }) => response === 0)
        .catch(() => false)
  });

  const credentialStore = createCredentialStore({ userDataDir, safeStorage });
  const codexAuth = createCodexAuth({ credentialStore });
  const xaiAuth = createXaiAuth({ credentialStore });

  const codexInference = createCodexInference({
    codexAuth,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: MODEL_LOAD_GRACE_MS
  });
  const xaiInference = createXaiInference({
    xaiAuth,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: MODEL_LOAD_GRACE_MS
  });

  const inference = createInference({
    registry,
    codexInference,
    xaiInference,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: MODEL_LOAD_GRACE_MS
  });

  const ipc = createHarnessIpc({
    ipcMain,
    isTrustedSender: (event) =>
      isTrustedAppSender(event, {
        mainWindow,
        windows: [pets?.askWindow() ?? null],
        appOrigin: APP_ORIGINS
      }),
    registry,
    codex: codexAuth,
    xai: xaiAuth,
    inference,
    listModels
  });
  ipc.register();

  return { registry, codexAuth, xaiAuth, inference, ipc };
}

/**
 * Abort a window's in-flight inference on navigation and on destruction so
 * a page-side stream promise can never hang after a reload (§7.5) — only
 * that window's requests (the quick-ask window streams alongside).
 */
function abortInferenceWith(webContents) {
  abortOnNavigation(webContents, () => harness?.ipc.abortSender(webContents));
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WINDOW_WEB_PREFERENCES = {
  preload: join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
};

function sameAppOrigin(url) {
  try {
    return isAppOrigin(new URL(url).origin, APP_ORIGINS);
  } catch {
    return false;
  }
}

function openExternalHttps(url) {
  try {
    const externalUrl = new URL(url);
    if (externalUrl.protocol !== 'https:') {
      console.warn(
        `[shell] blocked external URL protocol: ${externalUrl.protocol}`
      );
      return;
    }
    void shell.openExternal(externalUrl.href).catch((error) => {
      console.warn('[shell] could not open external URL:', error);
    });
  } catch {
    console.warn('[shell] blocked malformed external URL');
  }
}

/** Pet-store links (Petdex, codex-pet.org, …) open in the in-app store window. */
function openOutside(url) {
  if (pets?.isPetStoreUrl(url)) pets.openStore(url);
  else openExternalHttps(url);
}

// OAuth provider origins the shell may navigate to *in-app* (Better Auth
// social sign-in). MUST stay in sync with createSocialProviders() in
// src/lib/server/auth/auth.ts.
const OAUTH_PROVIDER_ORIGINS = new Set([
  'https://github.com',
  'https://accounts.google.com'
]);
// OpenRouter's PKCE sign-in (src/lib/ai/openrouter/oauth.ts) is not a social
// provider but must also stay in the window: the verifier lives in this
// window's sessionStorage, so a callback in the system browser cannot finish.
// /auth redirects to /sign-up, whose Clerk frontend API is clerk.openrouter.ai.
const OPENROUTER_SIGN_IN_ORIGINS = new Set([
  'https://openrouter.ai',
  'https://clerk.openrouter.ai'
]);

function isOAuthProviderOrigin(url) {
  try {
    const { origin } = new URL(url);
    return (
      OAUTH_PROVIDER_ORIGINS.has(origin) ||
      OPENROUTER_SIGN_IN_ORIGINS.has(origin)
    );
  } catch {
    return false;
  }
}

/** @param {string} [path] app path to open instead of `/` (e.g. '/settings/pets') */
function createWindow(path) {
  // Opened during a hidden install start: a cancel no longer shows one.
  hiddenForInstall = false;
  // The logo as the window / taskbar icon on Windows and Linux: packaged
  // builds read src/app-icon.png from the asar (build/ is not shipped), so
  // an AppImage or tar.gz window no longer shows Electron's default icon.
  const windowIconPath = [
    join(__dirname, 'app-icon.png'),
    join(__dirname, '..', 'build', 'icon.png')
  ].find((path) => existsSync(path));
  const windowIcon =
    process.platform !== 'darwin' && windowIconPath
      ? { icon: windowIconPath }
      : {};

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'TracingInsights',
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0f',
    webPreferences: WINDOW_WEB_PREFERENCES,
    ...windowIcon
  });

  // Only app-origin paths: the main window is the trusted IPC sender.
  const target = path ? new URL(path, APP_URL) : null;
  mainWindow.loadURL(
    target && isAppOrigin(target.origin, APP_ORIGINS) ? target.href : APP_URL
  );

  attachZoomKeys(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (sameAppOrigin(url)) {
      return { action: 'allow' };
    }
    openOutside(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!sameAppOrigin(url) && !isOAuthProviderOrigin(url)) {
      event.preventDefault();
      openOutside(url);
    }
  });

  abortInferenceWith(mainWindow.webContents);

  pets?.onMainWindowCreated(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close to tray (pets lifecycle): the window is destroyed, the app stays.
    pets?.onMainWindowClosed();
  });
  return mainWindow;
}

/**
 * Show the main window, recreating it when it was closed to the tray.
 * @param {string} [path]
 */
function focusMainWindow(path) {
  if (pets && isAskPath(path)) {
    // The native pet's "Ask an F1 question…" / panel "Ask F1" while the app
    // was closed (`--pets-open=/desktop/ask`): the Ask window, not a main
    // window on that path.
    void pets.openAsk();
    return;
  }
  if (pets) {
    pets.lifecycle.openMain(path);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(path);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater → GitHub Releases)
// ---------------------------------------------------------------------------

let checkingForUpdates = false;
let lastCheckWasManual = false;
/** Version downloaded and waiting for a restart, if any. */
let updateReadyVersion = null;
/** Started by the native pet's "Restart to update": install once downloaded. */
let installWhenDownloaded = process.argv.includes(INSTALL_UPDATE_ARG);
/** This start kept the main window closed only for that install. */
let hiddenForInstall = false;
/** `window-all-closed` came while the install was armed. */
let allClosedHeld = false;
let updaterSetUp = false;
/**
 * The portable Windows exe, the Linux .tar.gz and the Flatpak cannot update
 * in place (src/update-support.mjs): no updater, and the menu links the
 * download page instead of "Check for Updates…".
 */
const SELF_UPDATE = selfUpdateSupport({
  isPackaged: app.isPackaged,
  platform: process.platform,
  env: process.env,
  resourcesPath: process.resourcesPath,
  exists: existsSync
});

/**
 * "Restart to update" found nothing to install (no update, or the check or
 * download failed): disarm it, so a later background download never
 * restarts the app silently, and show a start that stayed hidden for it.
 * A window closed while it was armed closes now, as it would have then
 * (tray, hand-off to the native pet, or quit).
 */
function cancelInstallWhenDownloaded() {
  if (!installWhenDownloaded) return;
  installWhenDownloaded = false;
  if (hiddenForInstall) {
    hiddenForInstall = false;
    focusMainWindow();
  }
  pets?.installCancelled();
  if (allClosedHeld) {
    allClosedHeld = false;
    if (
      BrowserWindow.getAllWindows().length === 0 &&
      !pets?.lifecycle.isQuitting()
    ) {
      onAllWindowsClosed();
    }
  }
}

/** Restart into the downloaded update — a running native pet exits first. */
function installUpdate() {
  const petGone = pets?.prepareForUpdate() ?? null;
  if (!petGone) {
    autoUpdater.quitAndInstall();
    return;
  }
  petGone
    .catch((error) => console.warn('[updater] native pet:', error))
    .then(() => autoUpdater.quitAndInstall());
}

function setupAutoUpdater() {
  if (!SELF_UPDATE) {
    cancelInstallWhenDownloaded();
    return;
  }
  if (updaterSetUp) return;
  updaterSetUp = true;

  // Download in the background; install on quit or from "Restart to update".
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('error', (error) => {
    console.error('[updater] check failed:', error);
    checkingForUpdates = false;
    cancelInstallWhenDownloaded();
    if (lastCheckWasManual) {
      dialog.showErrorBox(
        'Update check failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available, downloading:', info?.version);
    checkingForUpdates = false;
    if (lastCheckWasManual) {
      dialog
        .showMessageBox(mainWindow ?? undefined, {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Update available',
          message: `TracingInsights ${info?.version} is downloading.`,
          detail: "You'll be asked to restart when it is ready."
        })
        .catch(() => {});
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] no update available (current:', info?.version, ')');
    checkingForUpdates = false;
    cancelInstallWhenDownloaded();
    if (lastCheckWasManual) {
      dialog
        .showMessageBox(mainWindow ?? undefined, {
          type: 'info',
          buttons: ['OK'],
          defaultId: 0,
          title: 'No update available',
          message: `You're running the latest version of TracingInsights (${app.getVersion()}).`
        })
        .catch(() => {});
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version ?? '';
    console.log('[updater] update downloaded:', version);
    if (updateReadyVersion === version) return;
    updateReadyVersion = version;
    const install = () => installUpdate();
    if (installWhenDownloaded) {
      installWhenDownloaded = false;
      install();
      return;
    }
    // The main window may be closed to the tray: offer the restart from the
    // tray menu, the app menu and a notification instead of a window dialog.
    pets?.setUpdateReady(version, install);
    buildMenu();
    // Off in the pets settings → only the tray + app menu offer it.
    const notify = pets?.notify ?? createNotifier({ Notification });
    notify({
      title: 'Update ready',
      body: `TracingInsights ${version} is ready. Click to restart now, or it installs when you quit.`,
      onClick: install
    });
  });

  setTimeout(
    () => checkForUpdates(false),
    installWhenDownloaded ? 0 : UPDATE_CHECK_STARTUP_DELAY_MS
  );
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

function checkForUpdates(manual = false) {
  if (!SELF_UPDATE) {
    cancelInstallWhenDownloaded();
    return;
  }
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  lastCheckWasManual = manual;
  autoUpdater.checkForUpdates().catch((error) => {
    checkingForUpdates = false;
    console.error('[updater] check failed:', error);
    cancelInstallWhenDownloaded();
    if (manual) {
      dialog.showErrorBox(
        'Update check failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'TracingInsights',
      submenu: [
        { label: 'Open TracingInsights', click: () => focusMainWindow() },
        { label: 'Pets…', click: () => focusMainWindow('/settings/pets') },
        { type: 'separator' },
        {
          label: 'Copy App URL',
          click: () => clipboard.writeText(APP_URL)
        },
        { type: 'separator' },
        updateReadyVersion
          ? {
              label: `Restart to Update (${updateReadyVersion})`,
              click: () => installUpdate()
            }
          : SELF_UPDATE || !app.isPackaged
            ? {
                label: 'Check for Updates…',
                enabled: app.isPackaged,
                click: () => checkForUpdates(true)
              }
            : {
                label: 'Download the Latest Version…',
                click: () => {
                  void shell
                    .openExternal(`${APP_URL}/download`)
                    .catch((error) =>
                      console.warn(
                        '[shell] could not open external URL:',
                        error
                      )
                    );
                }
              },
        // Closing the window keeps the app in the tray, so Windows/Linux
        // need an explicit Quit here (macOS has it in the app menu).
        ...(process.platform === 'darwin'
          ? []
          : [
              { type: 'separator' },
              { role: 'quit', label: 'Quit TracingInsights' }
            ])
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Pets: read before `ready` — the Linux XWayland decision and the privileged
// schemes (registerSchemesAsPrivileged may be called once, before ready).
const earlyPetSettings = readSettingsSync(app.getPath('userData'));
protocol.registerSchemesAsPrivileged([...PET_PRIVILEGED_SCHEMES]);

/**
 * The bundled native pet for this platform/arch, else null (→ the Electron
 * pet). Dev runs can point TIF1AI_NATIVE_PET at a local build.
 */
function nativePetBinaryPath() {
  const override = process.env.TIF1AI_NATIVE_PET;
  if (override) return existsSync(override) ? override : null;
  if (!app.isPackaged || !process.resourcesPath) return null;
  const path = join(
    process.resourcesPath,
    'ti-pet',
    nativeBinaryName(process.platform, process.arch)
  );
  return existsSync(path) ? path : null;
}
const NATIVE_PET_PATH = nativePetBinaryPath();
/**
 * The native pet runs on XWayland itself: no Electron relaunch for it —
 * unless this binary failed to start last time (it is still tried, but the
 * fallback pet must be able to show on a Wayland session).
 */
const nativePetExpected =
  NATIVE_PET_PATH !== null &&
  process.env.TIF1AI_PETS_RENDERER !== 'electron' &&
  !lastNativeStartFailed({
    fs: nodeFs,
    userDataDir: app.getPath('userData'),
    binaryPath: NATIVE_PET_PATH
  });
/** `--pets-refresh`: windowless timeline recompile, then exit. */
let refreshRun = process.argv.includes(REFRESH_ARG);
const startOpenPath = parsePetsOpenArg(process.argv);

/** A second start (or --pets-open) during a refresh run: become a normal app. */
function promoteRefreshRun() {
  if (!refreshRun) return;
  refreshRun = false;
  pets?.promote();
  buildMenu();
  setupAutoUpdater();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else if (
  relaunchUnderXWaylandIfNeeded({
    app,
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    enabled:
      earlyPetSettings.enabled &&
      earlyPetSettings.activePetId !== null &&
      !nativePetExpected
  })
) {
  // Relaunching with --ozone-platform=x11 (pets on in a Wayland session).
} else {
  app.on('second-instance', (_event, argv) => {
    // Another refresh run (the pet's timer) needs nothing from this one —
    // neither a promotion nor a window.
    if (Array.isArray(argv) && argv.includes(REFRESH_ARG)) return;
    promoteRefreshRun();
    if (Array.isArray(argv) && argv.includes(INSTALL_UPDATE_ARG)) {
      if (updateReadyVersion) installUpdate();
      else {
        installWhenDownloaded = true;
        checkForUpdates(false);
      }
      return;
    }
    focusMainWindow(
      (Array.isArray(argv) ? parsePetsOpenArg(argv) : null) ?? undefined
    );
  });

  app.whenReady().then(async () => {
    harness = buildHarness();
    pets = buildPets();
    // Registered before a refresh run's early return: a promoted run is a
    // normal app from then on.
    app.on('activate', () => {
      if (refreshRun) return;
      if (!mainWindow || mainWindow.isDestroyed()) focusMainWindow();
    });
    if (refreshRun && pets) {
      // No window, menu or updater: recompile, hand over, exit.
      void pets.refreshAndExit({ exit: () => app.exit(0) });
      return;
    }
    refreshRun = false;
    buildMenu();
    // Started at login (`--hidden`): tray + pet only, no main window.
    // Otherwise the first start with no pet opens the welcome step once.
    // `--pets-install-update`: no window either, the update installs.
    const startedHidden = pets?.lifecycle.startedHidden() ?? false;
    hiddenForInstall = installWhenDownloaded && !startedHidden;
    const hidden = startedHidden || installWhenDownloaded;
    if (!hidden) {
      if (startOpenPath) focusMainWindow(startOpenPath);
      else if (pets) pets.lifecycle.startMain();
      else createWindow();
    }
    try {
      pets?.start({ hidden });
    } catch (error) {
      console.error('[pets] could not start:', error);
    }
    setupAutoUpdater();
  });

  app.on('before-quit', (event) => pets?.beforeQuit(event));

  app.on('window-all-closed', onAllWindowsClosed);
}

/** `window-all-closed`. */
function onAllWindowsClosed() {
  // An armed update install keeps the app until the download lands (or the
  // install is cancelled, which replays this).
  if (installWhenDownloaded) {
    allClosedHeld = true;
    return;
  }
  // Close to tray (default) keeps the app running with the tray (+ pet);
  // with it off: macOS stays in the dock, other platforms quit and take
  // the harness down with them.
  const quit = pets
    ? pets.shouldQuitOnAllClosed()
    : process.platform !== 'darwin';
  if (quit) app.quit();
}

/** The pets runtime, or null if it failed (the app itself must still open). */
function buildPets() {
  try {
    return createPetsRuntime({
      electron: {
        app,
        BrowserWindow,
        Menu,
        Notification,
        Tray,
        dialog,
        ipcMain,
        nativeImage,
        powerMonitor,
        screen,
        session,
        systemPreferences
      },
      appUrl: APP_URL,
      appOrigin: APP_ORIGINS,
      getMainWindow: () => mainWindow,
      createMainWindow: (path) => createWindow(path),
      userDataDir: app.getPath('userData'),
      // 64 px copy of build/icon.png inside src/ (packaged with the app).
      iconPath: join(__dirname, 'pets', 'tray-icon.png'),
      windowIconPath:
        process.platform !== 'darwin' &&
        existsSync(join(__dirname, '..', 'build', 'icon.png'))
          ? join(__dirname, '..', 'build', 'icon.png')
          : undefined,
      openExternal: openExternalHttps,
      petPageDir: join(__dirname, 'pet'),
      petPreloadPath: join(__dirname, 'pet-preload.cjs'),
      mainPreloadPath: WINDOW_WEB_PREFERENCES.preload,
      onAskWindowCreated: (window) => abortInferenceWith(window.webContents),
      platform: process.platform,
      env: process.env,
      argv: process.argv,
      execPath: process.execPath,
      homeDir: homedir(),
      appVersion: app.getVersion(),
      nativePetPath: NATIVE_PET_PATH,
      // How the native pet starts this app again (dev: electron + app dir).
      appLaunch: {
        execPath: process.env.APPIMAGE || process.execPath,
        args: appLaunchArgs(process.argv, {
          isPackaged: app.isPackaged,
          appPath: app.getAppPath()
        })
      },
      tmpDir: tmpdir(),
      // A hand-off quit leaves the native pet running: a pending update must
      // not install now (Windows cannot replace the running pet).
      beforeHandoffQuit: () => {
        autoUpdater.autoInstallOnAppQuit = false;
      },
      // A window closing meanwhile must not hand off or quit (drops it).
      installArmed: () => installWhenDownloaded
    });
  } catch (error) {
    console.error('[pets] disabled:', error);
    return null;
  }
}
