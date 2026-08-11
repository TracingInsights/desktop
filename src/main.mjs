/**
 * TracingInsights Desktop — Electron browser shell + localhost bridge.
 *
 * The main window loads the production web app (https://app.tracinginsights.com).
 * In the background, a local HTTP bridge (desktop/src/bridge.mjs) mirrors the
 * site's /api/codex/* and /api/xai/* proxy routes so ChatGPT Codex and Grok
 * (SuperGrok) calls run through the user's own machine instead of the
 * TracingInsights server. The preload (preload.cjs) exposes `window.tif1aiDesktop`
 * so the site can auto-connect to the bridge (URL + pairing token) with zero
 * copy-paste.
 *
 * The pairing token is generated on first run, encrypted at rest with the OS
 * keychain via safeStorage (fallback: plaintext file + console warning), and
 * shown in the Bridge menu / Bridge Info window. The token never leaves the
 * machine and is not a cookie, so other websites cannot use the bridge.
 */
import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell
} from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createBridgeServer,
  listenBridgeServer,
  DEFAULT_PORT,
  BRIDGE_PORT_ATTEMPTS,
  BRIDGE_VERSION,
  TOKEN_MIN_LENGTH
} from './bridge.mjs';
// electron-updater is CommonJS; Electron's ESM loader cannot resolve its
// named export statically (SyntaxError at startup), so import the module
// object and destructure instead.
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;

// Delay the first update check so it never competes with app startup.
const UPDATE_CHECK_STARTUP_DELAY_MS = 10_000;

// Loopback connect-src is only granted to requests carrying this marker
// header, and only for the ports the bridge may bind (DEFAULT_PORT ..
// DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1 = 4318–4342). The web app sets
// the same contract in src/lib/server/hooks/handlers/security-headers.ts
// (DESKTOP_SHELL_HEADER + DESKTOP_BRIDGE_ORIGINS). MUST stay identical —
// tests/unit/security-headers.test.ts greps this file to keep the two in
// sync. Regular browsers never set this header, so they never receive
// loopback connect-src from the server.
const DESKTOP_SHELL_HEADER = 'x-tif1ai-desktop-shell';
const DESKTOP_BRIDGE_MIN_PORT = DEFAULT_PORT;
// The last port the CSP allowlist covers. Kept as a single derived constant
// so the retry walk and the env override can never escape the allowlist.
const DESKTOP_BRIDGE_MAX_PORT = DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override in dev with TIF1AI_APP_URL=http://localhost:5173 or
// TIF1AI_APP_URL=http://127.0.0.1:5173.
const APP_URL = process.env.TIF1AI_APP_URL || 'https://app.tracinginsights.com';
const APP_ORIGIN = new URL(APP_URL).origin;
const BRIDGE_INFO_FILE = join(__dirname, 'bridge-info.html');
const BRIDGE_INFO_URL = pathToFileURL(BRIDGE_INFO_FILE).href;
const CONFIG_FILE = 'bridge-config.json';

let mainWindow = null;
let bridgeInfoWindow = null;
let bridgeServer = null;
let bridgeToken = null;
let bridgePort = null;

// ---------------------------------------------------------------------------
// Bridge token persistence (safeStorage-encrypted in userData)
// ---------------------------------------------------------------------------

function configPath() {
  return join(app.getPath('userData'), CONFIG_FILE);
}

function persistToken(token) {
  const file = configPath();
  const encrypted = safeStorage.isEncryptionAvailable();
  const payload = encrypted
    ? {
        token: safeStorage.encryptString(token).toString('base64'),
        encrypted: true
      }
    : { token, encrypted: false };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn('[bridge] could not persist bridge token:', error);
  }
  return encrypted;
}

function loadOrCreateToken() {
  const file = configPath();
  let stored = null;
  try {
    if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Corrupt config — regenerate below.
  }
  if (
    stored &&
    typeof stored.token === 'string' &&
    stored.token.length >= TOKEN_MIN_LENGTH
  ) {
    if (stored.encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.token, 'base64'));
      } catch {
        // Fall through to regeneration.
      }
    } else if (!stored.encrypted) {
      return stored.token;
    }
  }
  const token = randomBytes(32).toString('base64url');
  if (!persistToken(token)) {
    // safeStorage may be unavailable (e.g. no keyring backend on some Linux
    // setups); the plaintext fallback already happened inside persistToken.
    const hint =
      process.platform === 'linux'
        ? ' Consider setting a keyring (gnome-keyring/kwallet).'
        : '';
    console.warn(
      `[bridge] OS keychain unavailable — bridge token stored without encryption on disk.${hint}`
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Bridge server lifecycle
// ---------------------------------------------------------------------------

function bridgeUrl() {
  // Gate on the live server handle, not just the port: `bridgePort` keeps
  // its last value after stopBridge()/stopBridgeAsync(), so a failed start
  // or a failed token-reset restart would otherwise emit an invalid
  // `http://127.0.0.1:null`. When the bridge is down there is no URL to
  // show or copy.
  if (!bridgeServer || typeof bridgePort !== 'number') return null;
  return `http://127.0.0.1:${bridgePort}`;
}

async function startBridge() {
  if (bridgeServer) return;
  bridgeToken = loadOrCreateToken();
  const envPort = Number.parseInt(process.env.TIF1AI_BRIDGE_PORT ?? '', 10);
  // The site's CSP allowlists exactly the ports the bridge may bind
  // (4318–4342, see DESKTOP_BRIDGE_ORIGINS). A port outside that range would
  // be unreachable from the web app (CSP blocks the fetch), so an env
  // override is clamped into the range instead of honoured blindly.
  let requested = DEFAULT_PORT;
  if (Number.isFinite(envPort) && envPort > 0) {
    if (
      envPort >= DESKTOP_BRIDGE_MIN_PORT &&
      envPort <= DESKTOP_BRIDGE_MAX_PORT
    ) {
      requested = envPort;
    } else {
      console.warn(
        `[bridge] TIF1AI_BRIDGE_PORT ${envPort} is outside the CSP-allowlisted ` +
          `range ${DESKTOP_BRIDGE_MIN_PORT}–${DESKTOP_BRIDGE_MAX_PORT}; using ${DEFAULT_PORT}.`
      );
    }
  }
  // The retry walk lives in bridge.mjs (listenBridgeServer) so it is unit
  // testable without Electron. The walk stays within the CSP-allowlisted
  // range because `requested` was clamped above and `maxPort` is the
  // allowlist ceiling. /health reports the actual bound port from the
  // accepted connection's socket, so a walk to a later port never leaves the
  // health endpoint lying about which port the bridge is on.
  const server = createBridgeServer({ token: bridgeToken });
  const port = await listenBridgeServer(server, {
    requestedPort: requested,
    maxPort: DESKTOP_BRIDGE_MAX_PORT
  });
  bridgeServer = server;
  bridgePort = port;
  // The retry loop's per-attempt error listener is gone by now, so a fatal
  // server error after binding would otherwise be an unhandled 'error' that
  // crashes the whole app. Log instead.
  server.on('error', (error) =>
    console.error('[bridge] bridge server error:', error)
  );
  console.log(
    `[bridge] listening on ${bridgeUrl()} (token stored in userData)`
  );
}

function stopBridge() {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
}

/** Close the bridge and wait for the listening socket to be released. */
function stopBridgeAsync() {
  if (!bridgeServer) return Promise.resolve();
  const server = bridgeServer;
  bridgeServer = null;
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function bridgeInfo() {
  const running = Boolean(bridgeServer);
  return {
    // null when the bridge never bound a port (startBridge failed) or was
    // taken down — never a bogus `http://127.0.0.1:null`.
    url: running ? bridgeUrl() : null,
    token: bridgeToken,
    // The port only exists while the bridge is live; after a failed
    // restart `bridgePort` keeps its last value, which must not leak as
    // if the bridge were listening.
    port: running ? bridgePort : null,
    running,
    version: app.getVersion() || BRIDGE_VERSION
  };
}

// ---------------------------------------------------------------------------
// Desktop-shell marker header
// ---------------------------------------------------------------------------

/**
 * Tag every request to the app origin with the desktop-shell marker header
 * so the server knows to include the loopback bridge ports in this window's
 * CSP (see `DESKTOP_BRIDGE_ORIGINS` in
 * src/lib/server/hooks/handlers/security-headers.ts). Without the marker the
 * page served inside Electron would carry the same restrictive CSP as a
 * regular browser and the bridge fetch would be blocked before it started.
 * The header is only added to app-origin requests — third-party calls
 * (analytics, OAuth, provider APIs) stay untouched.
 *
 * DEPLOY ORDER: the web app and this desktop app ship independently. The
 * server only grants loopback connect-src to requests carrying this header,
 * so the web deploy that removes the old `:*` wildcard must land together
 * with (or before) a desktop release that sets it — otherwise already-
 * installed desktop apps (no header) get the restrictive CSP and lose bridge
 * connectivity until they auto-update.
 */
function setupDesktopShellHeader() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Origin comparison, not string prefix: `app.tracinginsights.com` must
    // not match lookalike hosts like `app.tracinginsights.com.evil.com`.
    try {
      if (new URL(details.url).origin === APP_ORIGIN) {
        details.requestHeaders[DESKTOP_SHELL_HEADER] = '1';
      }
    } catch {
      // Unparseable URL — never tag.
    }
    callback({ requestHeaders: details.requestHeaders });
  });
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

function isBridgeInfoUrl(url) {
  try {
    return new URL(url).href === BRIDGE_INFO_URL;
  } catch {
    return false;
  }
}

// OAuth provider origins the shell may navigate to *in-app*. Better Auth
// social sign-in (/login → /api/auth/sign-in/{github,google}) 302-redirects
// the top-level page to the provider; if that redirect were externalized
// like every other off-origin navigation, the OAuth flow would complete in
// the system browser and the session cookie would never land in the
// Electron session — sign-in would silently dead-end. Allowing these
// origins lets the flow run inside the shell; the provider's callback
// returns to the app origin (allowed by sameAppOrigin), which sets the
// session cookie in the Electron session. MUST stay in sync with the
// providers configured in createSocialProviders()
// (src/lib/server/auth/auth.ts). Both providers keep their whole
// authorize/login/consent flow on a single origin, so an origin-level
// allowlist suffices. Device-auth flows (Codex/xAI) are unaffected: they
// open with target="_blank" and are externalized by setWindowOpenHandler
// below, by design.
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

function createWindow() {
  // Dev/unpacked runs on Windows/Linux use the generated icon; packaged apps
  // get their icon from the exe/dmg bundle instead (build/ is not shipped).
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

  mainWindow.loadURL(APP_URL);

  // Open external links (device-auth pages, provider docs) in the system
  // browser so the user's normal sessions are used; same-origin new windows
  // stay in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (sameAppOrigin(url)) {
      return { action: 'allow' };
    }
    openExternalHttps(url);
    return { action: 'deny' };
  });

  // Never let the shell itself navigate away from the app — except to an
  // OAuth provider origin, where the sign-in flow must stay in-app for the
  // session cookie to land in the Electron session (see
  // OAUTH_PROVIDER_ORIGINS above).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!sameAppOrigin(url) && !isOAuthProviderOrigin(url)) {
      event.preventDefault();
      openExternalHttps(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createBridgeInfoWindow() {
  if (bridgeInfoWindow && !bridgeInfoWindow.isDestroyed()) {
    bridgeInfoWindow.focus();
    return;
  }
  bridgeInfoWindow = new BrowserWindow({
    width: 480,
    height: 580,
    resizable: false,
    title: 'TracingInsights Bridge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'bridge-info-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  bridgeInfoWindow.loadFile(BRIDGE_INFO_FILE);
  bridgeInfoWindow.on('closed', () => {
    bridgeInfoWindow = null;
  });
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// IPC (used by preload.cjs and the bridge-info window)
// ---------------------------------------------------------------------------

/**
 * Token-bearing bridge IPC is available only to the app document in the main
 * window and the exact local Bridge Info document. The main preload also runs
 * while in-app OAuth navigates through GitHub/Google, so exposing the API in
 * the renderer is not itself proof that the caller is trusted.
 */
function isTrustedBridgeIpcSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl) return false;

  const fromApp =
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    sameAppOrigin(senderUrl);
  const fromBridgeInfo =
    bridgeInfoWindow &&
    !bridgeInfoWindow.isDestroyed() &&
    event.sender === bridgeInfoWindow.webContents &&
    isBridgeInfoUrl(senderUrl);

  return Boolean(fromApp || fromBridgeInfo);
}

function assertTrustedBridgeIpcSender(event) {
  if (!isTrustedBridgeIpcSender(event)) {
    throw new Error('Bridge IPC is not available from this page');
  }
}

function assertBridgeInfoIpcSender(event) {
  const senderUrl = event.senderFrame?.url;
  const trusted =
    senderUrl &&
    bridgeInfoWindow &&
    !bridgeInfoWindow.isDestroyed() &&
    event.sender === bridgeInfoWindow.webContents &&
    isBridgeInfoUrl(senderUrl);
  if (!trusted) {
    throw new Error('Bridge Info IPC is not available from this page');
  }
}

async function resetBridgeToken() {
  const next = randomBytes(32).toString('base64url');
  persistToken(next);
  bridgeToken = next;
  // Wait for the old socket to fully release the port so the retry loop in
  // startBridge() does not bump to a new port (which would strand the web
  // app's stored bridge URL).
  await stopBridgeAsync();
  await startBridge();
  return bridgeInfo();
}

/**
 * Push the current bridge state to every window that surfaces it: the Bridge
 * Info window (token/URL display) and the main window's web app. The web app
 * uses the push to swap the rotated pairing token into its encrypted config,
 * so Codex/Grok calls keep flowing and the settings panel never shows a
 * false "Active" with a token the bridge now rejects.
 */
function notifyBridgeChanged() {
  const info = bridgeInfo();
  if (
    bridgeInfoWindow &&
    !bridgeInfoWindow.isDestroyed() &&
    isBridgeInfoUrl(bridgeInfoWindow.webContents.getURL())
  ) {
    bridgeInfoWindow.webContents.send('bridge:changed', info);
  }
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    sameAppOrigin(mainWindow.webContents.getURL())
  ) {
    mainWindow.webContents.send('bridge:changed', info);
  }
}

/**
 * Shared failure handling for a bridge token reset. stopBridgeAsync() has
 * already taken the bridge down before the restart failed, so push the real
 * state to every window (they must not keep showing a stale "running" with
 * the old token) and rebuild the menu so "Copy Bridge URL" is disabled
 * while the bridge is down.
 */
function handleBridgeResetFailure(error) {
  console.error('[bridge] token reset failed', error);
  notifyBridgeChanged();
  buildMenu();
}

ipcMain.handle('bridge:info', (event) => {
  assertTrustedBridgeIpcSender(event);
  return bridgeInfo();
});

ipcMain.handle('bridge:reset-token', async (event) => {
  assertTrustedBridgeIpcSender(event);
  try {
    const info = await resetBridgeToken();
    notifyBridgeChanged();
    // A reset can also *recover* a bridge that failed to bind at launch
    // (menu built with Copy Bridge URL disabled) — rebuild so the item
    // reflects the now-running bridge.
    buildMenu();
    return info;
  } catch (error) {
    handleBridgeResetFailure(error);
    // Rethrow so the caller (Bridge Info window, web app) can surface an
    // explicit error instead of silently keeping the stale display.
    throw error;
  }
});

ipcMain.handle('bridge:copy-text', (event, text) => {
  assertBridgeInfoIpcSender(event);
  clipboard.writeText(String(text ?? ''));
});

ipcMain.handle('bridge:open-main', (event) => {
  assertBridgeInfoIpcSender(event);
  focusMainWindow();
});

// ---------------------------------------------------------------------------
// Auto-update (electron-updater → GitHub Releases)
//
// Production builds check for updates ~10 s after launch and on demand via
// the menu. Downloads are user-confirmed; once downloaded, the app installs
// on quit (autoInstallOnAppQuit) or immediately when the user chooses
// "Restart Now".
//
// Requirements / limitations:
//   - macOS auto-update requires a signed + notarized app (CSC_LINK etc. in
//     the release workflow); unsigned builds cannot self-update on macOS.
//   - Linux: AppImage builds auto-update; .deb installs update via apt.
//   - Dev runs (electron .) never check — only app.isPackaged builds do.
// ---------------------------------------------------------------------------

let checkingForUpdates = false;
let lastCheckWasManual = false;

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
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
    console.log('[updater] update available:', info?.version);
    checkingForUpdates = false;
    dialog
      .showMessageBox(mainWindow ?? undefined, {
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `TracingInsights ${info?.version} is available.`,
        detail: 'Download it now? It will install automatically on quit.'
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater
            .downloadUpdate()
            .catch((error) =>
              console.error('[updater] download failed:', error)
            );
        }
      })
      .catch(() => {});
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
    console.log('[updater] update downloaded:', info?.version);
    dialog
      .showMessageBox(mainWindow ?? undefined, {
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `TracingInsights ${info?.version} has been downloaded.`,
        detail: 'Restart the app to finish installing.'
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      })
      .catch(() => {});
  });

  // Don't block startup; the window is already up by this point.
  setTimeout(() => checkForUpdates(false), UPDATE_CHECK_STARTUP_DELAY_MS);
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
      label: 'Bridge',
      submenu: [
        { label: 'Show Bridge Info', click: () => createBridgeInfoWindow() },
        {
          label: 'Copy Bridge URL',
          // Evaluated when the menu is built (after startBridge()), so a
          // bridge that failed to bind a port shows the item disabled. The
          // click also guards, covering a later shutdown (e.g. a token
          // reset that could not restart the bridge).
          enabled: Boolean(bridgeUrl()),
          click: () => {
            const url = bridgeUrl();
            if (url) clipboard.writeText(url);
          }
        },
        { type: 'separator' },
        {
          label: 'Reset Bridge Token',
          click: () => {
            resetBridgeToken()
              .then(() => {
                notifyBridgeChanged();
                // A reset can also *recover* a bridge that failed to bind
                // at launch (menu built with Copy Bridge URL disabled) —
                // rebuild so the item reflects the now-running bridge.
                buildMenu();
              })
              .catch((error) => {
                handleBridgeResetFailure(error);
                dialog.showErrorBox(
                  'Bridge reset failed',
                  'The bridge could not restart because every candidate port ' +
                    'is in use.\n\n' +
                    (error instanceof Error ? error.message : String(error))
                );
              });
          }
        },
        { type: 'separator' },
        { label: 'Open TracingInsights', click: () => focusMainWindow() },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          enabled: app.isPackaged,
          click: () => checkForUpdates(true)
        }
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());

  app.whenReady().then(async () => {
    let bridgeStartError = null;
    try {
      await startBridge();
    } catch (error) {
      console.error('[bridge] failed to start localhost bridge:', error);
      bridgeStartError = error;
    }
    // Must run before any window loads the app so the first document request
    // (and every subsequent app-origin request) carries the marker header.
    setupDesktopShellHeader();
    buildMenu();
    createWindow();
    setupAutoUpdater();

    // Show the failure only once the window exists, so a blocked bridge does
    // not delay app startup (showErrorBox is synchronous on Linux/Windows).
    if (bridgeStartError) {
      dialog.showErrorBox(
        'Bridge unavailable',
        'The localhost bridge could not start, so Codex and Grok calls will ' +
          'use the TracingInsights server proxy instead.\n\n' +
          (bridgeStartError instanceof Error
            ? bridgeStartError.message
            : String(bridgeStartError))
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS keeps the app (and bridge) alive in the dock; other platforms
    // quit and take the bridge down with them.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => stopBridge());
}
