import { describe, test, expect } from 'bun:test';
import {
  ONBOARDING_PATH,
  appLaunchArgs,
  createLifecycle,
  linuxAutostartEntry,
  linuxAutostartPath,
  quoteExecArg
} from './lifecycle.mjs';

function fakeWindow() {
  const calls = [];
  const win = {
    calls,
    destroyed: false,
    minimized: false,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
  return win;
}

function setup({
  platform = 'linux',
  closeToTray = true,
  argv = ['app'],
  env = {},
  isPackaged = true,
  extra = {},
  loginTarget = undefined
} = {}) {
  const log = [];
  let current = {
    closeToTray,
    firstTrayNoticeShown: false,
    onboardingShown: false,
    activePetId: null,
    ...extra
  };
  let mainWindow = fakeWindow();
  const files = new Map();
  const lifecycle = createLifecycle({
    app: {
      quit: () => log.push(['quit']),
      isPackaged,
      getAppPath: () => '/src/desktop',
      setLoginItemSettings: (s) => log.push(['login', s]),
      getLoginItemSettings: () => ({ wasOpenedAtLogin: false })
    },
    platform,
    env,
    argv,
    execPath: '/opt/TracingInsights/tracinginsights',
    homeDir: '/home/u',
    settings: {
      get: () => ({ ...current }),
      markTrayNoticeShown: () => {
        current = { ...current, firstTrayNoticeShown: true };
      },
      markOnboardingShown: () => {
        log.push(['onboardingShown']);
        current = { ...current, onboardingShown: true };
      }
    },
    createMainWindow: (path) => {
      log.push(['create', path ?? null]);
      mainWindow = fakeWindow();
      return mainWindow;
    },
    getMainWindow: () => mainWindow,
    navigateMain: (_w, path) => log.push(['navigate', path]),
    notify: (n) => log.push(['notify', n.title]),
    ensureTray: () => log.push(['tray']),
    loginTarget,
    fs: {
      mkdirSync: (p) => log.push(['mkdir', p]),
      writeFileSync: (p, text) => files.set(p, text),
      rmSync: (p) => files.delete(p)
    }
  });
  return {
    lifecycle,
    log,
    settings: () => current,
    files,
    closeMain() {
      mainWindow.destroyed = true;
      mainWindow = null;
    },
    mainWindow: () => mainWindow,
    setMain: (w) => {
      mainWindow = w;
    }
  };
}

describe('close to tray', () => {
  test('on: tray + one-time notice, app keeps running', () => {
    const { lifecycle, log, closeMain } = setup();
    closeMain();
    expect(lifecycle.onMainWindowClosed()).toBe('tray');
    expect(lifecycle.onMainWindowClosed()).toBe('tray');
    expect(log).toEqual([
      ['tray'],
      ['notify', 'TracingInsights is still running'],
      ['tray']
    ]);
    expect(lifecycle.shouldQuitOnAllClosed()).toBe(false);
  });

  test('notifications off: no notice and the marker stays unset; back on → shown once', () => {
    const { lifecycle, log, closeMain, settings, setMain } = setup({
      extra: { notifications: false }
    });
    closeMain();
    expect(lifecycle.onMainWindowClosed()).toBe('tray');
    expect(log).toEqual([['tray']]);
    expect(settings().firstTrayNoticeShown).toBe(false);

    settings().notifications = true;
    setMain(fakeWindow());
    closeMain();
    lifecycle.onMainWindowClosed();
    lifecycle.onMainWindowClosed();
    expect(log.filter(([kind]) => kind === 'notify')).toEqual([
      ['notify', 'TracingInsights is still running']
    ]);
    expect(settings().firstTrayNoticeShown).toBe(true);
  });

  test('off: quits on Windows/Linux even with a pet window open', () => {
    for (const platform of ['linux', 'win32']) {
      const { lifecycle, log, closeMain } = setup({
        platform,
        closeToTray: false
      });
      closeMain();
      expect(lifecycle.onMainWindowClosed()).toBe('quit');
      expect(log).toEqual([['quit']]);
      expect(lifecycle.shouldQuitOnAllClosed()).toBe(true);
    }
  });

  test('off on macOS: stays in the dock like today', () => {
    const { lifecycle, log } = setup({
      platform: 'darwin',
      closeToTray: false
    });
    expect(lifecycle.onMainWindowClosed()).toBe('stay');
    expect(log).toEqual([]);
    expect(lifecycle.shouldQuitOnAllClosed()).toBe(false);
  });

  test('while quitting no notice and no tray', () => {
    const { lifecycle, log } = setup();
    lifecycle.markQuitting();
    expect(lifecycle.onMainWindowClosed()).toBe('quit');
    expect(log).toEqual([]);
  });
});

describe('reopen', () => {
  test('second instance recreates a destroyed main window', () => {
    const { lifecycle, log, closeMain, mainWindow } = setup();
    closeMain();
    lifecycle.focusMainWindow();
    expect(log).toEqual([['create', null]]);
    expect(mainWindow()).not.toBeNull();
  });

  test('a destroyed-but-still-referenced window is recreated too', () => {
    const { lifecycle, log, mainWindow } = setup();
    mainWindow().destroyed = true;
    lifecycle.openMain('/');
    expect(log).toEqual([['create', '/']]);
  });

  test('a live window is restored, navigated and focused', () => {
    const { lifecycle, log, mainWindow } = setup();
    const win = mainWindow();
    win.minimized = true;
    lifecycle.openMain('/settings/pets');
    expect(log).toEqual([['navigate', '/settings/pets']]);
    expect(win.calls).toEqual(['restore', 'show', 'focus']);
  });

  test('--hidden marks a login start', () => {
    expect(setup({ argv: ['app', '--hidden'] }).lifecycle.startedHidden()).toBe(
      true
    );
    expect(setup().lifecycle.startedHidden()).toBe(false);
  });
});

describe('launch at login', () => {
  test('Windows passes --hidden; macOS openAtLogin only', () => {
    const win = setup({ platform: 'win32' });
    win.lifecycle.applyLaunchAtLogin(true);
    expect(win.log).toEqual([
      ['login', { openAtLogin: true, args: ['--hidden'] }]
    ]);
    const mac = setup({ platform: 'darwin' });
    mac.lifecycle.applyLaunchAtLogin(false);
    expect(mac.log).toEqual([['login', { openAtLogin: false }]]);
  });

  test('Linux writes and removes the autostart entry (AppImage path)', () => {
    const { lifecycle, files } = setup({
      env: { APPIMAGE: '/home/u/Apps/TracingInsights.AppImage' }
    });
    lifecycle.applyLaunchAtLogin(true);
    const path = '/home/u/.config/autostart/tracinginsights.desktop';
    expect(files.get(path)).toContain(
      'Exec=/home/u/Apps/TracingInsights.AppImage --hidden'
    );
    lifecycle.applyLaunchAtLogin(false);
    expect(files.has(path)).toBe(false);
  });

  test('Linux dev run includes the app path; XDG_CONFIG_HOME is honoured', () => {
    const { lifecycle, files } = setup({
      isPackaged: false,
      env: { XDG_CONFIG_HOME: '/cfg' }
    });
    lifecycle.applyLaunchAtLogin(true);
    expect(files.get('/cfg/autostart/tracinginsights.desktop')).toContain(
      'Exec=/opt/TracingInsights/tracinginsights /src/desktop --hidden'
    );
  });

  test('native pet in use: Windows and Linux start the pet itself, macOS the app', () => {
    const target = () => ({
      execPath: '/opt/TracingInsights/resources/ti-pet/ti-pet-linux-x64',
      args: ['--socket', '/u/pet.sock', '--login']
    });
    const linux = setup({ loginTarget: target });
    linux.lifecycle.applyLaunchAtLogin(true);
    expect(
      linux.files.get('/home/u/.config/autostart/tracinginsights.desktop')
    ).toContain(
      'Exec=/opt/TracingInsights/resources/ti-pet/ti-pet-linux-x64 --socket /u/pet.sock --login'
    );
    const win = setup({ platform: 'win32', loginTarget: target });
    win.lifecycle.applyLaunchAtLogin(true);
    expect(win.log).toEqual([
      [
        'login',
        {
          openAtLogin: true,
          path: '/opt/TracingInsights/resources/ti-pet/ti-pet-linux-x64',
          args: ['--socket', '/u/pet.sock', '--login']
        }
      ]
    ]);
    const mac = setup({ platform: 'darwin', loginTarget: target });
    mac.lifecycle.applyLaunchAtLogin(true);
    expect(mac.log).toEqual([['login', { openAtLogin: true }]]);
    // No native pet (fallback) → the app with --hidden, as before.
    const fallback = setup({ platform: 'win32', loginTarget: () => null });
    fallback.lifecycle.applyLaunchAtLogin(true);
    expect(fallback.log).toEqual([
      ['login', { openAtLogin: true, args: ['--hidden'] }]
    ]);
  });

  test('autostart helpers', () => {
    expect(quoteExecArg('/opt/My Apps/ti')).toBe('"/opt/My Apps/ti"');
    expect(quoteExecArg('/a/$x%')).toBe('"/a/\\$x%%"');
    expect(
      linuxAutostartPath({
        env: { XDG_CONFIG_HOME: 'relative' },
        homeDir: '/h'
      })
    ).toBe('/h/.config/autostart/tracinginsights.desktop');
    expect(linuxAutostartEntry({ execPath: '/x' })).toStartWith(
      '[Desktop Entry]\nType=Application'
    );
  });
});

describe('first-run onboarding', () => {
  test('first start with no pet opens the welcome step once, marked after the window', () => {
    const { lifecycle, log, settings } = setup();
    expect(lifecycle.startPath()).toBe(ONBOARDING_PATH);
    expect(lifecycle.startMain()).toBe('/settings/pets?welcome=1');
    expect(log).toEqual([
      ['create', '/settings/pets?welcome=1'],
      ['onboardingShown']
    ]);
    expect(settings().onboardingShown).toBe(true);
    // Next start (or a crash + restart): plain '/'.
    log.length = 0;
    expect(lifecycle.startMain()).toBe('/');
    expect(log).toEqual([['create', null]]);
  });

  test('never with a pet chosen, or once shown', () => {
    const withPet = setup({ extra: { activePetId: 'petdex:boba' } });
    expect(withPet.lifecycle.startPath()).toBeUndefined();
    expect(withPet.lifecycle.startMain()).toBe('/');
    expect(withPet.log).toEqual([['create', null]]);
    const shown = setup({ extra: { onboardingShown: true } });
    expect(shown.lifecycle.startPath()).toBeUndefined();
  });

  test('settings from an older app (field missing) do not trigger it', () => {
    const { lifecycle } = setup({ extra: { onboardingShown: undefined } });
    expect(lifecycle.startPath()).toBeUndefined();
  });
});

describe('appLaunchArgs (native pet relaunches the app)', () => {
  test('packaged: no args unless a profile was chosen', () => {
    expect(
      appLaunchArgs(['/opt/TI/tracinginsights'], {
        isPackaged: true,
        appPath: '/x'
      })
    ).toEqual([]);
  });

  test('dev: app dir, and the --user-data-dir profile carries over', () => {
    expect(
      appLaunchArgs(
        ['electron', '--user-data-dir=/tmp/p', '--inspect=9334', '.'],
        { isPackaged: false, appPath: '/repo/desktop' }
      )
    ).toEqual(['/repo/desktop', '--user-data-dir=/tmp/p']);
    expect(
      appLaunchArgs(['electron', '--user-data-dir', '/tmp/q'], {
        isPackaged: true,
        appPath: '/x'
      })
    ).toEqual(['--user-data-dir=/tmp/q']);
  });
});
