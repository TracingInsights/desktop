/**
 * Desktop pets — tray icon + menus (docs/DESKTOP_PETS_PLAN.md §4.4, §4.7).
 *
 * Tray menu: [Restart to update (vX) — once an update is downloaded] · Open
 * TracingInsights · Ask an F1 question… · Show/Hide pet · Choose pet… · Quiet ▸ ·
 * Launch at login ☐ · Quit. The pet's right-click menu shares the actions:
 * Ask an F1 question… · Quiet until this session ends / Quiet for 1 hour ·
 * Size ▸ · Choose pet… · Hide pet · Open TracingInsights. Templates are pure (tested); Electron's
 * Tray / Menu / nativeImage are injected.
 *
 * Every actionable item carries `offline`: what the native pet does with it
 * while Electron is not running (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.3) —
 *   { do: 'open', path }        start the app on that path (`--pets-open=`)
 *   { do: 'install-update' }    start the app with `--pets-install-update`
 *   { do: 'quit' }              exit the native pet
 *   { do: 'quiet', kind }       'session' | '1h' | 'off', locally
 *   { do: 'toggle-pet' } · { do: 'size', size } · { do: 'launch-at-login' }
 * Electron's Menu ignores the extra key.
 *
 * The icon is pets/tray-icon.png (a 64 px copy of build/icon.png, so it is
 * packaged with src/), resized at runtime. On Linux the tray is a StatusNotifierItem: a click may
 * never reach us, so everything is in the menu.
 */
import { ASK_PATH } from './contract.mjs';

/** Where "Choose pet…" leads. */
export const CHOOSE_PET_PATH = '/settings/pets';

/**
 * @typedef {{
 *   petEnabled: boolean,
 *   hasPet: boolean,
 *   supported: boolean,
 *   size: 's'|'m'|'l',
 *   launchAtLogin: boolean,
 *   quietActive: boolean,
 *   sessionQuietAvailable: boolean,
 *   updateReady?: string | null
 * }} MenuState
 * @typedef {{
 *   openMain: () => void,
 *   openAsk?: () => void,
 *   togglePet: () => void,
 *   choosePet: () => void,
 *   quiet: (kind: 'session'|'1h'|'off') => void,
 *   setSize: (size: 's'|'m'|'l') => void,
 *   setLaunchAtLogin: (enabled: boolean) => void,
 *   quit: () => void,
 *   installUpdate?: () => void
 * }} MenuActions
 */

/** @param {MenuState} state @param {MenuActions} actions */
function quietItems(state, actions) {
  return [
    {
      label: 'Until this session ends',
      enabled: state.sessionQuietAvailable,
      click: () => actions.quiet('session'),
      offline: { do: 'quiet', kind: 'session' }
    },
    {
      label: 'For 1 hour',
      click: () => actions.quiet('1h'),
      offline: { do: 'quiet', kind: '1h' }
    },
    {
      label: 'Off',
      enabled: state.quietActive,
      click: () => actions.quiet('off'),
      offline: { do: 'quiet', kind: 'off' }
    }
  ];
}

export const ASK_LABEL = 'Ask an F1 question…';

/** "Ask an F1 question…" when the quick-ask window is wired. @param {MenuActions} actions */
function askItem(actions) {
  return actions.openAsk
    ? [
        {
          label: ASK_LABEL,
          click: () => actions.openAsk?.(),
          offline: { do: 'open', path: ASK_PATH }
        }
      ]
    : [];
}

/** @param {MenuState} state @param {MenuActions} actions */
export function buildTrayMenuTemplate(state, actions) {
  const update = state.updateReady
    ? [
        {
          label: `Restart to update (${state.updateReady})`,
          click: () => actions.installUpdate?.(),
          offline: { do: 'install-update' }
        },
        { type: 'separator' }
      ]
    : [];
  return [
    ...update,
    {
      label: 'Open TracingInsights',
      click: () => actions.openMain(),
      offline: { do: 'open', path: '/' }
    },
    ...askItem(actions),
    { type: 'separator' },
    {
      label: state.petEnabled ? 'Hide pet' : 'Show pet',
      enabled: state.hasPet && state.supported,
      click: () => actions.togglePet(),
      offline: { do: 'toggle-pet' }
    },
    {
      label: 'Choose pet…',
      click: () => actions.choosePet(),
      offline: { do: 'open', path: CHOOSE_PET_PATH }
    },
    { label: 'Quiet', submenu: quietItems(state, actions) },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: state.launchAtLogin,
      click: (item) =>
        actions.setLaunchAtLogin(
          Boolean(item?.checked ?? !state.launchAtLogin)
        ),
      offline: { do: 'launch-at-login' }
    },
    { type: 'separator' },
    {
      label: 'Quit TracingInsights',
      click: () => actions.quit(),
      offline: { do: 'quit' }
    }
  ];
}

const SIZE_LABELS = Object.freeze({ s: 'Small', m: 'Medium', l: 'Large' });

/** @param {MenuState} state @param {MenuActions} actions */
export function buildPetMenuTemplate(state, actions) {
  const ask = askItem(actions);
  return [
    ...ask,
    ...(ask.length ? [{ type: 'separator' }] : []),
    {
      label: 'Quiet until this session ends',
      enabled: state.sessionQuietAvailable,
      click: () => actions.quiet('session'),
      offline: { do: 'quiet', kind: 'session' }
    },
    {
      label: 'Quiet for 1 hour',
      click: () => actions.quiet('1h'),
      offline: { do: 'quiet', kind: '1h' }
    },
    ...(state.quietActive
      ? [
          {
            label: 'Quiet off',
            click: () => actions.quiet('off'),
            offline: { do: 'quiet', kind: 'off' }
          }
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Size',
      submenu: Object.entries(SIZE_LABELS).map(([size, label]) => ({
        label,
        type: 'radio',
        checked: state.size === size,
        click: () => actions.setSize(/** @type {'s'|'m'|'l'} */ (size)),
        offline: { do: 'size', size }
      }))
    },
    {
      label: 'Choose pet…',
      click: () => actions.choosePet(),
      offline: { do: 'open', path: CHOOSE_PET_PATH }
    },
    {
      label: 'Hide pet',
      click: () => actions.togglePet(),
      offline: { do: 'toggle-pet' }
    },
    { type: 'separator' },
    {
      label: 'Open TracingInsights',
      click: () => actions.openMain(),
      offline: { do: 'open', path: '/' }
    }
  ];
}

/** Tray icon edge per platform (DIP). */
export function trayIconSize(platform) {
  return platform === 'linux' ? 24 : 16;
}

/**
 * @param {{
 *   Tray: new (image: unknown) => any,
 *   Menu: { buildFromTemplate: (template: object[]) => any },
 *   nativeImage: { createFromPath: (path: string) => any, createEmpty: () => any },
 *   iconPath: string,
 *   platform: string,
 *   getState: () => MenuState,
 *   actions: MenuActions
 * }} deps
 */
export function createPetsTray({
  Tray,
  Menu,
  nativeImage,
  iconPath,
  platform,
  getState,
  actions
}) {
  let tray = null;

  function icon() {
    const source = nativeImage.createFromPath(iconPath);
    if (source.isEmpty()) return nativeImage.createEmpty();
    const edge = trayIconSize(platform);
    const image = source.resize({ width: edge, height: edge, quality: 'best' });
    // Crisp on 200 % displays: add a 2× representation from the 64 px source.
    image.addRepresentation?.({
      scaleFactor: 2,
      width: edge * 2,
      height: edge * 2,
      buffer: source
        .resize({ width: edge * 2, height: edge * 2, quality: 'best' })
        .toPNG()
    });
    return image;
  }

  function refresh() {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(
      Menu.buildFromTemplate(buildTrayMenuTemplate(getState(), actions))
    );
  }

  return {
    /** Create the tray once; later calls only refresh the menu. */
    ensure() {
      if (tray && !tray.isDestroyed()) {
        refresh();
        return;
      }
      tray = new Tray(icon());
      tray.setToolTip('TracingInsights');
      // Windows: a left click opens the window (macOS shows the menu; Linux
      // StatusNotifier hosts mostly show the menu and never send a click).
      if (platform === 'win32') tray.on('click', () => actions.openMain());
      refresh();
    },
    refresh,
    exists: () => Boolean(tray && !tray.isDestroyed()),
    destroy() {
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = null;
    }
  };
}
