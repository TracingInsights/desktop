/**
 * TracingInsights Desktop — Electron shell + inference harness.
 *
 * The main window loads the production web app (https://app.tracinginsights.com).
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
import { createProviderRegistry } from './provider-registry.mjs';
import { createCredentialStore } from './credential-store.mjs';
import { createCodexAuth } from './codex-auth.mjs';
import { createXaiAuth } from './xai-auth.mjs';
import { createCodexInference } from './codex-inference.mjs';
import { createXaiInference } from './xai-inference.mjs';
import { createInference } from './inference.mjs';
import { createHarnessIpc, isTrustedAppSender } from './ipc.mjs';
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
import { ASK_PATH } from './pets/contract.mjs';
import { createNotifier } from './pets/notify.mjs';
import { attachZoomKeys } from './zoom-keys.mjs';
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
// TIF1AI_APP_URL=http://127.0.0.1:5173.
const APP_URL = process.env.TIF1AI_APP_URL || 'https://app.tracinginsights.com';
const APP_ORIGIN = new URL(APP_URL).origin;

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
        appOrigin: APP_ORIGIN
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
  const abort = () => harness?.ipc.abortSender(webContents);
  webContents.on('did-navigate', abort);
  webContents.on('did-navigate-in-page', abort);
  webContents.on('destroyed', abort);
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
    return new URL(url).origin === APP_ORIGIN;
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

function isOAuthProviderOrigin(url) {
  try {
    return OAUTH_PROVIDER_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** @param {string} [path] app path to open instead of `/` (e.g. '/settings/pets') */
function createWindow(path) {
  const devIconPath = join(__dirname, '..', 'build', 'icon.png');
  const windowIcon =
    process.platform !== 'darwin' && existsSync(devIconPath)
      ? { icon: devIconPath }
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
    target && target.origin === APP_ORIGIN ? target.href : APP_URL
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
  if (pets && path === ASK_PATH) {
    // The native pet's "Ask an F1 question…" while the app was closed.
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
let updaterSetUp = false;

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
  if (!app.isPackaged || updaterSetUp) return;
  updaterSetUp = true;

  // Download in the background; install on quit or from "Restart to update".
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('error', (error) => {
    console.error('[updater] check failed:', error);
    checkingForUpdates = false;
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
  if (!app.isPackaged || checkingForUpdates) return;
  checkingForUpdates = true;
  lastCheckWasManual = manual;
  autoUpdater.checkForUpdates().catch((error) => {
    checkingForUpdates = false;
    console.error('[updater] check failed:', error);
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
          : {
              label: 'Check for Updates…',
              enabled: app.isPackaged,
              click: () => checkForUpdates(true)
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
    const hidden =
      (pets?.lifecycle.startedHidden() ?? false) || installWhenDownloaded;
    if (!hidden) {
      if (startOpenPath) focusMainWindow(startOpenPath);
      else if (pets) pets.lifecycle.startMain();
      else createWindow();
    }
    try {
      pets?.start({ hidden, handOff: !installWhenDownloaded });
    } catch (error) {
      console.error('[pets] could not start:', error);
    }
    setupAutoUpdater();

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) focusMainWindow();
    });
  });

  app.on('before-quit', (event) => pets?.beforeQuit(event));

  app.on('window-all-closed', () => {
    // Close to tray (default) keeps the app running with the tray (+ pet);
    // with it off: macOS stays in the dock, other platforms quit and take
    // the harness down with them.
    const quit = pets
      ? pets.shouldQuitOnAllClosed()
      : process.platform !== 'darwin';
    if (quit) app.quit();
  });
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
      appOrigin: APP_ORIGIN,
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
      }
    });
  } catch (error) {
    console.error('[pets] disabled:', error);
    return null;
  }
}
