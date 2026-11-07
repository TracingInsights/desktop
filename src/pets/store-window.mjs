/**
 * Desktop pets — in-app pet-store window (Petdex, codex-pet.org,
 * codexpets.net, petscodex.com).
 *
 * Store links from /settings/pets open here instead of the default browser.
 * The window is a plain sandboxed browser for those sites only: no preload
 * (no `window.tif1aiDesktop`), its own persistent session (store cookies stay
 * out of the app's session), every permission denied. Links to any other
 * site open in the default browser. A pet `.zip` downloaded here is saved to
 * a temp file and handed to `onPetDownload` (the importer validates it like
 * "Import pet…"); other downloads keep Electron's save dialog.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from './contract.mjs';
import { attachZoomKeys } from '../zoom-keys.mjs';

/** Sites the store window may show (https only; `www.` variants allowed). */
export const PET_STORE_HOSTS = Object.freeze([
  'petdex.dev',
  'codex-pet.org',
  'codexpets.net',
  'petscodex.com'
]);

export const PET_STORE_PARTITION = 'persist:pet-stores';

/** true for an https URL on one of the pet stores. */
export function isPetStoreUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') return false;
  const host = parsed.hostname.replace(/^www\./, '');
  return PET_STORE_HOSTS.includes(host);
}

/** A download the store window imports as a pet instead of saving. */
export function isPetZipDownload(filename, totalBytes) {
  return (
    /\.zip$/i.test(filename) && (!totalBytes || totalBytes <= LIMITS.zipBytes)
  );
}

/**
 * @param {{
 *   BrowserWindow: new (options: object) => any,
 *   session: { fromPartition: (partition: string) => any },
 *   Menu: { buildFromTemplate: (template: object[]) => { popup: (options?: object) => void } },
 *   openExternal: (url: string) => void,
 *   downloadDir: string,
 *   onPetDownload: (path: string) => void,
 *   iconPath?: string
 * }} deps
 */
export function createPetStoreWindow({
  BrowserWindow,
  session,
  Menu,
  openExternal,
  downloadDir,
  onPetDownload,
  iconPath
}) {
  let win = null;
  let storeSession = null;

  const live = () => Boolean(win && !win.isDestroyed());

  function setupSession() {
    if (storeSession) return storeSession;
    storeSession = session.fromPartition(PET_STORE_PARTITION);
    storeSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    );
    storeSession.setPermissionCheckHandler(() => false);
    storeSession.on('will-download', (_event, item) => {
      if (!isPetZipDownload(item.getFilename(), item.getTotalBytes())) return;
      mkdirSync(downloadDir, { recursive: true });
      const path = join(downloadDir, `${randomUUID()}.zip`);
      item.setSavePath(path);
      item.once('done', (_e, state) => {
        if (state === 'completed') onPetDownload(path);
      });
    });
    return storeSession;
  }

  function contextMenu(params) {
    const history = win.webContents.navigationHistory;
    const template = [
      {
        label: 'Back',
        enabled: history.canGoBack(),
        click: () => history.goBack()
      },
      {
        label: 'Forward',
        enabled: history.canGoForward(),
        click: () => history.goForward()
      },
      { label: 'Reload', click: () => win.webContents.reload() },
      { type: 'separator' },
      ...(params?.linkURL
        ? [
            {
              label: 'Open Link in Browser',
              click: () => openExternal(params.linkURL)
            }
          ]
        : []),
      {
        label: 'Open Page in Browser',
        click: () => openExternal(win.webContents.getURL())
      }
    ];
    Menu.buildFromTemplate(template).popup({ window: win });
  }

  function create() {
    win = new BrowserWindow({
      width: 1200,
      height: 820,
      minWidth: 480,
      minHeight: 400,
      title: 'Pet stores — TracingInsights',
      autoHideMenuBar: true,
      backgroundColor: '#0b0b0f',
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        session: setupSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });
    const wc = win.webContents;
    attachZoomKeys(wc);
    // Store links stay in this window; anything else goes to the browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (isPetStoreUrl(url)) wc.loadURL(url);
      else openExternal(url);
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      if (isPetStoreUrl(url)) return;
      event.preventDefault();
      openExternal(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('context-menu', (_event, params) => contextMenu(params));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const history = wc.navigationHistory;
      if (input.alt && input.key === 'ArrowLeft' && history.canGoBack()) {
        history.goBack();
        event.preventDefault();
      } else if (
        input.alt &&
        input.key === 'ArrowRight' &&
        history.canGoForward()
      ) {
        history.goForward();
        event.preventDefault();
      } else if (
        input.key === 'F5' ||
        ((input.control || input.meta) && input.key.toLowerCase() === 'r')
      ) {
        wc.reload();
        event.preventDefault();
      }
    });
    // Windows mouse back/forward buttons.
    win.on('app-command', (_event, command) => {
      const history = wc.navigationHistory;
      if (command === 'browser-backward' && history.canGoBack())
        history.goBack();
      if (command === 'browser-forward' && history.canGoForward())
        history.goForward();
    });
    win.on('closed', () => {
      win = null;
    });
  }

  return {
    isPetStoreUrl,
    /** Open (or reuse) the store window on `url`; non-store URLs go to the browser. */
    open(url) {
      if (!isPetStoreUrl(url)) {
        openExternal(url);
        return;
      }
      if (!live()) create();
      void win.loadURL(url).catch(() => {});
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    /** The store window while open, else null. */
    window: () => (live() ? win : null),
    destroy() {
      if (live()) win.destroy();
      win = null;
    }
  };
}
