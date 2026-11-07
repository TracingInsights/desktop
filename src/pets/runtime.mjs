/**
 * Desktop pets — runtime assembly (docs/DESKTOP_PETS_PLAN.md §4).
 *
 * Builds every pets module from the Electron APIs main.mjs passes in and
 * returns the few hooks main.mjs needs (window created/closed, quit,
 * second instance, menu, the quick-ask window). Call `createPetsRuntime`
 * after `app` is ready.
 *
 * Native pet (docs/DESKTOP_PETS_NATIVE_PLAN.md, N1–N4): when the bundled
 * `ti-pet` binary starts, it draws the pet and owns the tray; closing the
 * main window compiles the timeline (timeline.mjs), hands the pet over and
 * quits Electron. Without the binary (or when it fails) the Electron pet
 * window and tray run exactly as before.
 */
import { execFile as nodeExecFile, spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import * as net from 'node:net';
import { join } from 'node:path';
import { PET_WINDOW_CHANNELS } from './contract.mjs';
import { createPetsSettings } from './settings.mjs';
import { createPetStore } from './pet-store.mjs';
import { createPetdexClient } from './petdex-client.mjs';
import { createImporter } from './importer.mjs';
import { createFacts } from './facts.mjs';
import { createPetStoreWindow, isPetStoreUrl } from './store-window.mjs';
import { createAskWindow } from './ask-window.mjs';
import { calendarPhase, createSchedule, sessionBubble } from './schedule.mjs';
import {
  createDecodeImage,
  createMakeThumb,
  createThumbRenderer
} from './images.mjs';
import {
  createPetProtocolHandlers,
  installPetProtocols,
  parsePetAssetUrl,
  PET_PAGE_URL
} from './protocols.mjs';
import { createPetWindowManager, LAST_POSITION_KEY } from './pet-window.mjs';
import { createNativePet, windowsProcessPath } from './native-pet.mjs';
import { createPetRenderer, recordNativeOutcome } from './pet-renderer.mjs';
import { compileTimeline } from './timeline.mjs';
import { createTimelineSpriteResolver } from './timeline-sprites.mjs';
import { mergeNativeState } from './native-state.mjs';
import { menuFromTemplate, TIMELINE_FILE } from './native-protocol.mjs';
import { fetchFactsAhead } from './facts.mjs';
import { createPetController } from './controller.mjs';
import { createPetsService, pageSettings } from './service.mjs';
import { createPetsIpc, isPetWindowSender } from './ipc.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createNotifier } from './notify.mjs';
import { petsSupport, restartApp } from './linux.mjs';
import {
  buildPetMenuTemplate,
  buildTrayMenuTemplate,
  createPetsTray
} from './tray.mjs';
import { isTrustedAppSender } from '../ipc.mjs';

/** In-memory partition for the pet window + thumbnailer (no network). */
export const PET_PARTITION = 'tif1ai-pets';
/** A refresh run (`--pets-refresh`) exits after this long whatever happens. */
export const REFRESH_HARD_EXIT_MS = 30_000;
/** …and waits at most this long for the schedule / facts fetches. */
export const REFRESH_FETCH_MS = 10_000;
/** Days of on-this-day facts the timeline carries (horizon + today). */
const FACT_DAYS_AHEAD = 8;

const settle = (promise, ms) =>
  Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    })
  ]);

/**
 * @param {{
 *   electron: {
 *     app: any, BrowserWindow: any, Menu: any, Notification: any, Tray: any, dialog: any,
 *     ipcMain: any, nativeImage: any, powerMonitor: any, screen: any, session: any,
 *     systemPreferences: any
 *   },
 *   appUrl: string,
 *   appOrigin: string,
 *   getMainWindow: () => any,
 *   createMainWindow: (path?: string) => any,
 *   userDataDir: string,
 *   iconPath: string,
 *   petPageDir: string,
 *   petPreloadPath: string,
 *   mainPreloadPath: string,
 *   openExternal: (url: string) => void,
 *   windowIconPath?: string,
 *   onAskWindowCreated?: (window: any) => void,
 *   platform: string,
 *   env: Record<string, string|undefined>,
 *   argv: readonly string[],
 *   execPath: string,
 *   homeDir: string,
 *   appVersion: string,
 *   nativePetPath?: string|null,
 *   appLaunch?: { execPath: string, args: readonly string[] },
 *   tmpDir?: string,
 *   beforeHandoffQuit?: () => void,
 *   spawnNative?: typeof spawn
 * }} options
 */
export function createPetsRuntime(options) {
  const { electron, appUrl, appOrigin, getMainWindow, createMainWindow } =
    options;
  const {
    userDataDir,
    iconPath,
    petPageDir,
    petPreloadPath,
    platform,
    env,
    argv
  } = options;
  const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain } =
    electron;
  const { nativeImage, powerMonitor, screen, session, systemPreferences } =
    electron;

  const mainWebContents = () => {
    const window = getMainWindow();
    return window && !window.isDestroyed() ? window.webContents : null;
  };

  // --- Data layer ---
  const settings = createPetsSettings({ userDataDir });
  const store = createPetStore({
    userDataDir,
    codexHome: env.CODEX_HOME || join(options.homeDir, '.codex'),
    decodeImage: createDecodeImage(nativeImage),
    makeThumb: createMakeThumb(nativeImage),
    getSettings: settings.get
  });
  const petdex = createPetdexClient({
    fetch: globalThis.fetch,
    userDataDir,
    appVersion: options.appVersion,
    store
  });
  const schedule = createSchedule({
    fetch: globalThis.fetch,
    userDataDir,
    appUrl
  });
  const importer = createImporter({
    showOpenDialog: (dialogOptions) => {
      const window = getMainWindow();
      return window && !window.isDestroyed()
        ? dialog.showOpenDialog(window, dialogOptions)
        : dialog.showOpenDialog(dialogOptions);
    },
    store,
    readFile,
    stat,
    platform
  });

  // --- Pet session: bundled page + sprites only, no network, no permissions ---
  const petSession = session.fromPartition(PET_PARTITION);
  installPetProtocols(
    petSession.protocol,
    createPetProtocolHandlers({ rootDir: petPageDir, store })
  );
  petSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  );
  petSession.setPermissionCheckHandler(() => false);
  petSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );

  const thumbs = createThumbRenderer({
    createWindow: () =>
      new BrowserWindow({
        show: false,
        width: 200,
        height: 220,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          session: petSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          devTools: false
        }
      })
  });

  /** Pets count as "on" for the Linux XWayland decision once a pet is chosen. */
  const support = () => {
    const current = settings.get();
    const where = petsSupport({
      platform,
      env,
      argv,
      enabled: current.enabled && current.activePetId !== null
    });
    // The native pet runs on XWayland by itself (GDK_BACKEND=x11): Electron
    // never needs the relaunch then (only its fallback window does).
    return renderer?.kind() === 'electron'
      ? where
      : { ...where, needsRestartForPets: false };
  };

  // Every OS notification goes through here (`notifications` setting).
  const notify = createNotifier({ Notification, getSettings: settings.get });

  /** @type {ReturnType<typeof createLifecycle>} */
  let lifecycle;
  /** @type {ReturnType<typeof createPetsTray>} */
  let tray;

  const electronPetWindow = createPetWindowManager({
    createWindow: (windowOptions) => new BrowserWindow(windowOptions),
    screen,
    settings,
    pageUrl: PET_PAGE_URL,
    preloadPath: petPreloadPath,
    petSession,
    platform,
    devTools: !app.isPackaged,
    renderChannel: PET_WINDOW_CHANNELS.render,
    onShown: () => tray?.ensure(),
    onClosed: () => tray?.refresh()
  });

  // --- Native pet (bundled ti-pet) or the Electron window above ---
  /** Sprite URL (pet-asset://…) → the validated file in the pet store. */
  const resolveSpritePath = (url) => {
    const id = parsePetAssetUrl(url);
    if (!id) return null;
    try {
      return store.resolveAsset(id)?.path ?? null;
    } catch {
      return null;
    }
  };
  /** The same sprite for the hand-off timeline, copied inside userData when needed. */
  const timelineSpritePath = createTimelineSpriteResolver({
    userDataDir,
    fs: nodeFs,
    resolveSourcePath: resolveSpritePath
  });
  /** @type {Map<string, (item: { checked?: boolean }) => void>} */
  let nativeMenuHandlers = new Map();
  const nativePet = options.nativePetPath
    ? createNativePet({
        binaryPath: options.nativePetPath,
        userDataDir,
        tmpDir: options.tmpDir ?? userDataDir,
        platform,
        env,
        appVersion: options.appVersion,
        appLaunch: options.appLaunch ?? {
          execPath: options.execPath,
          args: []
        },
        resolvePath: resolveSpritePath,
        getPosition: () =>
          settings.get().positions?.[LAST_POSITION_KEY] ?? null,
        savePosition: ({ x, y, displayId }) => {
          const positions = { ...(settings.get().positions ?? {}) };
          if (displayId) positions[`native:${displayId}`] = { x, y };
          positions[LAST_POSITION_KEY] = { x, y };
          settings.update({ positions }, { trusted: true });
        },
        onEvent: (event, dx, dy) =>
          event === 'drag'
            ? controller.petEvent('drag', dx, dy)
            : controller.petEvent(/** @type {any} */ (event)),
        onMenuAction: (id, checked) => {
          const handler = nativeMenuHandlers.get(id);
          handler?.(checked === undefined ? {} : { checked });
        },
        onFailure: (reason) => renderer.fallback(reason),
        spawn: options.spawnNative ?? spawn,
        // Windows pipe-squatting check (another user may own the name).
        getProcessPath: (pid) =>
          windowsProcessPath(pid, { execFile: nodeExecFile, env }),
        net,
        fs: nodeFs
      })
    : null;
  /** The tray was asked for before the renderer was decided. */
  let trayWanted = false;
  /** Set once every module exists (renderer changes before that need nothing). */
  let wired = false;
  const renderer = createPetRenderer({
    native: nativePet,
    electronWindow: electronPetWindow,
    forceElectron: env.TIF1AI_PETS_RENDERER === 'electron',
    onChange: (kind, reason) => {
      if (!wired) return;
      // Next start relaunches under XWayland while this binary keeps failing
      // (main.mjs), so the fallback pet can show on a Wayland session.
      recordNativeOutcome({
        fs: nodeFs,
        userDataDir,
        binaryPath: options.nativePetPath ?? null,
        kind,
        reason
      });
      if (reason && kind === 'electron' && reason !== 'not-bundled') {
        console.warn(
          '[pets] native pet unavailable, using the Electron pet:',
          reason
        );
      }
      if (kind === 'electron' && trayWanted) tray?.ensure();
      if (kind === 'native') pushNativeMenus();
      // The login item follows the renderer (native pet vs app --hidden).
      if (kind !== 'pending' && settings.get().launchAtLogin) {
        try {
          lifecycle?.applyLaunchAtLogin(true);
        } catch (error) {
          console.warn('[pets] launch at login:', error);
        }
      }
      controller.refresh();
      notifyPage();
    }
  });
  const petWindow = renderer;

  // On-this-day bubble source (fetched by day, cached in userData).
  const facts = createFacts({ fetch: globalThis.fetch, userDataDir, appUrl });

  const controller = createPetController({
    settings,
    store,
    getSessions: () => schedule.sessions(),
    getFeed: () => schedule.feed(),
    facts,
    calendarPhase,
    sessionBubble,
    petWindow,
    support,
    openMain: (path) => lifecycle.openMain(path),
    showContextMenu: () => {
      const window = petWindow.window();
      Menu.buildFromTemplate(
        buildPetMenuTemplate(menuState(), menuActions)
      ).popup(window ? { window } : {});
    }
  });

  function setLaunchAtLogin(enabled) {
    const result = settings.update({ launchAtLogin: enabled });
    if (!result.ok) return;
    try {
      lifecycle.applyLaunchAtLogin(enabled);
    } catch (error) {
      console.warn('[pets] launch at login:', error);
      settings.update({ launchAtLogin: !enabled });
    }
  }

  const menuActions = {
    openMain: () => lifecycle.openMain(),
    openAsk: () => {
      askWindow.open();
    },
    togglePet: () => settings.update({ enabled: !settings.get().enabled }),
    choosePet: () => lifecycle.openMain('/settings/pets'),
    quiet: (kind) => controller.quiet(kind),
    setSize: (size) => settings.update({ size }),
    setLaunchAtLogin,
    quit: () => app.quit(),
    installUpdate: () => updateReady?.install()
  };

  /** Downloaded update waiting for a restart (set by main.mjs's updater). */
  let updateReady = null;

  function menuState() {
    const current = settings.get();
    const quietMs = current.quietUntil ? Date.parse(current.quietUntil) : NaN;
    return {
      petEnabled: current.enabled,
      hasPet:
        current.activePetId !== null && store.get(current.activePetId) !== null,
      supported: support().supported,
      size: current.size,
      launchAtLogin: current.launchAtLogin,
      quietActive: Number.isFinite(quietMs) && quietMs > Date.now(),
      sessionQuietAvailable: controller.sessionQuietAvailable(),
      updateReady: updateReady?.version ?? null
    };
  }

  const electronTray = createPetsTray({
    Tray,
    Menu,
    nativeImage,
    iconPath,
    platform,
    getState: menuState,
    actions: menuActions
  });

  /** The native pet's tray + pet menus (it shows both itself, N4). */
  function pushNativeMenus() {
    if (!nativePet || renderer.kind() !== 'native') return;
    const state = menuState();
    const trayMenu = menuFromTemplate(
      buildTrayMenuTemplate(state, menuActions),
      'tray'
    );
    const petMenu = menuFromTemplate(
      buildPetMenuTemplate(state, menuActions),
      'pet'
    );
    nativeMenuHandlers = new Map([...trayMenu.handlers, ...petMenu.handlers]);
    nativePet.setMenu({ tray: trayMenu.items, pet: petMenu.items });
  }

  // Native pet in use → it owns the tray; Electron's tray only as fallback.
  tray = {
    ensure() {
      const kind = renderer.kind();
      if (kind === 'native') pushNativeMenus();
      else if (kind === 'electron') electronTray.ensure();
      else trayWanted = true;
    },
    refresh() {
      if (renderer.kind() === 'native') pushNativeMenus();
      else electronTray.refresh();
    },
    destroy: () => electronTray.destroy?.()
  };

  lifecycle = createLifecycle({
    app,
    platform,
    env,
    argv,
    execPath: options.execPath,
    homeDir: options.homeDir,
    settings,
    createMainWindow,
    getMainWindow,
    navigateMain: (window, path) => window.loadURL(new URL(path, appUrl).href),
    notify: ({ title, body }) => notify({ title, body, silent: true }),
    ensureTray: () => tray.ensure(),
    loginTarget: () =>
      nativePet && renderer.kind() === 'native' && options.nativePetPath
        ? {
            execPath: options.nativePetPath,
            args: [...nativePet.launchArgs(), '--login']
          }
        : null
  });

  let ipc = null;
  const notifyPage = () => ipc?.notifyChanged(mainWebContents());

  const service = createPetsService({
    getPetDrivers: () => schedule.petDrivers(),
    renderer: () => ({ kind: renderer.kind(), reason: renderer.reason() }),
    settings,
    store,
    petdex,
    importer,
    controller,
    thumbs,
    support,
    platform,
    applyLaunchAtLogin: (enabled) => lifecycle.applyLaunchAtLogin(enabled),
    restartApp: () => restartApp({ app, platform, env, argv }),
    petsChanged: notifyPage,
    openAsk: () => askWindow.open()
  });

  // --- Pet-store window: store links from /settings/pets open in-app ---
  const storeWindow = createPetStoreWindow({
    BrowserWindow,
    session,
    Menu,
    openExternal: options.openExternal,
    downloadDir: join(userDataDir, 'pet-downloads'),
    iconPath: options.windowIconPath,
    onPetDownload: (path) => {
      void service
        .importFile(path)
        .then((result) => {
          const onClick = () => lifecycle.openMain('/settings/pets');
          if (result?.ok) {
            notify({
              title: 'Pet imported',
              body: `${result.pet.displayName} is ready. Click to choose it in Pets.`,
              onClick
            });
            return;
          }
          const error = result?.error ?? 'The download is not a pet.';
          // Logged too: with notifications off this is the only trace.
          console.warn('[pets] store download import failed:', error);
          notify({ title: 'Could not import the pet', body: error, onClick });
        })
        .finally(() => rm(path, { force: true }).catch(() => {}));
    }
  });

  // --- Quick-ask window (plan §12 #9): compact chat next to the pet ---
  /** Pet-store links → store window; anything else → default browser. */
  const openOutside = (url) =>
    isPetStoreUrl(url) ? storeWindow.open(url) : options.openExternal(url);
  const askWindow = createAskWindow({
    BrowserWindow,
    screen,
    appUrl,
    appOrigin,
    preloadPath: options.mainPreloadPath,
    getPetRect: () => petWindow.groupRect(),
    openMain: (path) => lifecycle.openMain(path),
    openOutside,
    platform,
    iconPath: options.windowIconPath,
    onCreated: (window) => {
      window.on('focus', () => controller.noteActivity());
      options.onAskWindowCreated?.(window);
    }
  });

  ipc = createPetsIpc({
    ipcMain,
    // The ask window runs the same chat, so its signals animate the pet.
    isTrustedSender: (event) =>
      isTrustedAppSender(event, {
        mainWindow: getMainWindow(),
        windows: [askWindow.window()],
        appOrigin
      }),
    isPetSender: (event) =>
      isPetWindowSender(event, { petWindow: petWindow.window() }),
    service,
    onPetEvent: (kind, ...args) => controller.petEvent(kind, ...args)
  });

  // --- Hand-off to the native pet (N1) ---
  /** @type {Map<string, { text: string|null, path: string }>} */
  let factsAhead = new Map();
  let environment = { onBattery: false, reducedMotion: false };
  /** The native pet carries on alone: quitting must not stop it. */
  let handedOff = false;
  let handingOff = false;
  /** The native pet was told to exit (Quit / update install). */
  let nativeQuitDone = false;
  /** Refresh run turned into a normal start by a second instance. */
  let promoted = false;
  let started = false;

  async function refreshFactsAhead() {
    try {
      factsAhead = await fetchFactsAhead({
        fetch: globalThis.fetch,
        appUrl,
        nowMs: Date.now(),
        days: FACT_DAYS_AHEAD
      });
    } catch {
      // Best effort: no daily facts in the timeline.
    }
  }

  /** Compile + write `pet-timeline.json` (0600, atomic); its path or null. */
  function writeTimeline() {
    try {
      const nowMs = Date.now();
      let today = null;
      try {
        today = facts.today(nowMs);
      } catch {
        today = null;
      }
      const timeline = compileTimeline({
        settings: settings.get(),
        store,
        feed: schedule.feed(),
        factFor: (day) =>
          factsAhead.get(day) ??
          (today && today.day === day
            ? { text: today.text, path: today.path }
            : null),
        resolvePath: timelineSpritePath,
        nowMs,
        environment,
        secondSide: renderer.secondSide()
      });
      const path = join(userDataDir, TIMELINE_FILE);
      const tmp = `${path}.${process.pid}.tmp`;
      nodeFs.writeFileSync(tmp, JSON.stringify(timeline), { mode: 0o600 });
      nodeFs.renameSync(tmp, path);
      return path;
    } catch (error) {
      console.warn('[pets] timeline:', error);
      return null;
    }
  }

  /**
   * Give the pet to the native renderer and quit Electron. Any failure keeps
   * Electron running with its own pet + tray (fallback) instead.
   * @returns {Promise<boolean>}
   */
  async function handOffAndQuit() {
    if (!nativePet || renderer.kind() !== 'native' || handingOff) return false;
    handingOff = true;
    const path = writeTimeline();
    const ok = path ? await nativePet.handoff(path) : false;
    handingOff = false;
    if (!ok) {
      renderer.fallback('handoff-failed');
      tray.ensure();
      return false;
    }
    handedOff = true;
    nativePet.detach();
    options.beforeHandoffQuit?.();
    app.quit();
    return true;
  }

  /** No window of ours is open (main, ask, store): Electron can go. */
  const noAppWindows = () =>
    !getMainWindow() && !askWindow.window() && !storeWindow.window();

  wired = true;

  let pageView = JSON.stringify(pageSettings(settings.get()));
  function onSettingsChanged(next) {
    controller.refresh();
    tray.refresh();
    const view = JSON.stringify(pageSettings(next));
    if (view !== pageView) {
      pageView = view;
      notifyPage();
    }
  }

  return {
    lifecycle,
    controller,

    /** true for a link the pet-store window shows (Petdex and the other stores). */
    isPetStoreUrl,
    /** Open a pet-store link in the in-app store window. */
    openStore: (url) => storeWindow.open(url),

    /** Open (or focus) the quick-ask window. */
    openAsk: () => askWindow.open(),
    /** The quick-ask BrowserWindow while open (harness sender trust), else null. */
    askWindow: () => askWindow.window(),

    /**
     * Show a native notification unless the user turned them off
     * (`notifications` setting) → 'shown' | 'off' | 'unsupported'.
     */
    notify,

    /**
     * An update finished downloading: offer "Restart to update" in the tray
     * (the main window may be closed to the tray, so no window dialog).
     * @param {string} version @param {() => void} install
     */
    setUpdateReady(version, install) {
      updateReady = { version, install };
      tray.refresh();
    },

    /**
     * @param {{ hidden: boolean, handOff?: boolean }} options handOff false =
     *   a hidden start that must keep Electron (update install)
     */
    start({ hidden, handOff = true }) {
      if (started) return;
      started = true;
      // What the native pet changed while Electron was gone (one writer).
      mergeNativeState({ userDataDir, settings });
      ipc.register();
      settings.onChange(onSettingsChanged);
      schedule.onChange(() => {
        controller.refresh();
        tray.refresh();
      });
      facts.onChange(() => controller.refresh());
      for (const event of [
        'lock-screen',
        'unlock-screen',
        'on-battery',
        'on-ac',
        'suspend'
      ]) {
        powerMonitor.on(event, () => {
          if (event === 'on-battery') environment.onBattery = true;
          if (event === 'on-ac') environment.onBattery = false;
          controller.power(event);
        });
      }
      powerMonitor.on('resume', () => {
        controller.power('resume');
        schedule.refresh?.().catch(() => {});
      });
      let reducedMotion;
      try {
        reducedMotion = Boolean(
          systemPreferences.getAnimationSettings?.().prefersReducedMotion
        );
      } catch {
        reducedMotion = false;
      }
      environment = {
        onBattery: Boolean(powerMonitor.isOnBatteryPower?.()),
        reducedMotion
      };
      controller.start();
      controller.setEnvironment(environment);
      const scheduleReady = schedule
        .start()
        .catch((error) => console.warn('[pets] schedule:', error));
      if (hidden) tray.ensure();
      // Keep the Linux autostart entry pointing at the current binary/AppImage.
      if (platform === 'linux' && settings.get().launchAtLogin) {
        try {
          lifecycle.applyLaunchAtLogin(true);
        } catch (error) {
          console.warn('[pets] autostart refresh:', error);
        }
      }
      void renderer
        .start()
        .then(async (kind) => {
          if (kind !== 'native') return;
          void refreshFactsAhead();
          // A hidden start (login item on macOS, or the app started with
          // --hidden) hands straight over: nothing of Electron is needed.
          if (
            hidden &&
            handOff &&
            noAppWindows() &&
            settings.get().closeToTray
          ) {
            await settle(scheduleReady, REFRESH_FETCH_MS);
            await settle(refreshFactsAhead(), REFRESH_FETCH_MS);
            if (noAppWindows()) await handOffAndQuit();
          }
        })
        .catch((error) => console.warn('[pets] renderer:', error));
    },

    /** Which renderer draws the pet ('pending' while the native pet starts). */
    rendererKind: () => renderer.kind(),

    /**
     * `--pets-refresh` (started by the native pet at its timeline's
     * `refreshAt`): no window, no tray, no live pet — fetch the schedule
     * and facts, recompile the timeline, hand it over, exit. Never spawns a
     * pet; gives up after REFRESH_HARD_EXIT_MS. A second instance during
     * the run turns it into a normal start (`promote`).
     * @param {{ exit: () => void }} input
     * @returns {Promise<'handed-off'|'no-pet'|'failed'|'promoted'>}
     */
    async refreshAndExit({ exit }) {
      const hardExit = setTimeout(() => {
        if (!promoted) exit();
      }, REFRESH_HARD_EXIT_MS);
      hardExit.unref?.();
      const done = (result) => {
        clearTimeout(hardExit);
        if (!promoted) exit();
        return result;
      };
      mergeNativeState({ userDataDir, settings });
      if (!nativePet) return done('no-pet');
      const adopted = await nativePet.start({
        allowSpawn: false,
        takeOver: false
      });
      if (promoted) return 'promoted';
      if (!adopted.ok) return done('no-pet');
      await settle(schedule.start(), REFRESH_FETCH_MS);
      schedule.stop();
      await settle(refreshFactsAhead(), REFRESH_FETCH_MS);
      if (promoted) return 'promoted';
      const path = writeTimeline();
      const ok = path ? await nativePet.handoff(path) : false;
      if (promoted) return 'promoted';
      if (ok) {
        handedOff = true;
        nativePet.detach();
      }
      return done(ok ? 'handed-off' : 'failed');
    },

    /** A refresh run became a normal start (second instance / --pets-open). */
    promote() {
      if (promoted) return;
      promoted = true;
      handedOff = false;
      this.start({ hidden: true });
    },

    /**
     * Before `autoUpdater.quitAndInstall()`: stop the native pet first and
     * wait for it (Windows cannot replace a running exe). The new version
     * starts it again. Null when no native pet is running (install now).
     * @returns {Promise<void>|null}
     */
    prepareForUpdate() {
      if (!nativePet?.connected() || nativeQuitDone) return null;
      nativeQuitDone = true;
      handedOff = false;
      return nativePet.quit();
    },

    /** Hook every new main window (focus counts as activity). */
    onMainWindowCreated(window) {
      window.on('focus', () => controller.noteActivity());
    },

    /**
     * The main window has been destroyed: close to tray as before — or, with
     * the native pet drawing, hand it over and quit Electron (N1).
     */
    onMainWindowClosed() {
      const result = lifecycle.onMainWindowClosed();
      if (result === 'tray' && renderer.kind() === 'native' && noAppWindows()) {
        void handOffAndQuit();
      }
      return result;
    },
    shouldQuitOnAllClosed: () => lifecycle.shouldQuitOnAllClosed(),

    /**
     * `before-quit`. A real Quit also stops the native pet (N4: Quit quits
     * both), which needs one async round trip: the first call cancels the
     * quit, waits for the pet, then quits again. A hand-off quit leaves the
     * pet running.
     * @param {{ preventDefault: () => void }} [event]
     */
    beforeQuit(event) {
      lifecycle.markQuitting();
      if (
        nativePet?.connected() &&
        !handedOff &&
        !nativeQuitDone &&
        event?.preventDefault
      ) {
        nativeQuitDone = true;
        event.preventDefault();
        void nativePet.quit().finally(() => app.quit());
        return;
      }
      storeWindow.destroy();
      askWindow.destroy();
      schedule.stop();
      thumbs.dispose();
    }
  };
}
