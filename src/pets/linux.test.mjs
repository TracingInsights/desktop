import { describe, test, expect } from 'bun:test';
import {
  ozonePlatformArg,
  petsSupport,
  relaunchUnderXWaylandIfNeeded,
  restartApp,
  stripOzoneArgs,
  x11RelaunchOptions
} from './linux.mjs';

const wayland = {
  XDG_SESSION_TYPE: 'wayland',
  WAYLAND_DISPLAY: 'wayland-0',
  DISPLAY: ':0'
};

function fakeApp() {
  const calls = [];
  return {
    calls,
    relaunch: (options) => calls.push(['relaunch', options]),
    exit: (code) => calls.push(['exit', code]),
    releaseSingleInstanceLock: () => calls.push(['release'])
  };
}

describe('argv helpers', () => {
  test('reads both switch forms', () => {
    expect(ozonePlatformArg(['electron', '--ozone-platform=x11'])).toBe('x11');
    expect(ozonePlatformArg(['electron', '--ozone-platform', 'wayland'])).toBe(
      'wayland'
    );
    expect(ozonePlatformArg(['electron', '.'])).toBeNull();
  });

  test('strips every ozone switch and keeps the rest', () => {
    expect(
      stripOzoneArgs([
        '.',
        '--ozone-platform',
        'wayland',
        '--hidden',
        '--ozone-platform=x11'
      ])
    ).toEqual(['.', '--hidden']);
  });

  test('relaunch options append x11 and use APPIMAGE as execPath', () => {
    expect(
      x11RelaunchOptions({ argv: ['/x/electron', '.', '--hidden'], env: {} })
    ).toEqual({
      args: ['.', '--hidden', '--ozone-platform=x11']
    });
    expect(
      x11RelaunchOptions({
        argv: ['/tmp/.mount_x/app'],
        env: { APPIMAGE: '/home/u/TI.AppImage' }
      })
    ).toEqual({
      args: ['--ozone-platform=x11'],
      execPath: '/home/u/TI.AppImage'
    });
  });
});

describe('petsSupport', () => {
  test('non-Linux and X11 sessions are always supported', () => {
    for (const [platform, env] of [
      ['win32', {}],
      ['darwin', {}],
      ['linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }]
    ]) {
      expect(petsSupport({ platform, env, argv: [], enabled: true })).toEqual({
        supported: true,
        unsupportedReason: null,
        nativeWayland: false,
        needsRestartForPets: false
      });
    }
  });

  test('native Wayland with pets on needs a restart', () => {
    expect(
      petsSupport({
        platform: 'linux',
        env: wayland,
        argv: ['e'],
        enabled: true
      })
    ).toMatchObject({
      supported: true,
      nativeWayland: true,
      needsRestartForPets: true
    });
    expect(
      petsSupport({
        platform: 'linux',
        env: wayland,
        argv: ['e'],
        enabled: false
      }).needsRestartForPets
    ).toBe(false);
  });

  test('already on XWayland → no restart', () => {
    expect(
      petsSupport({
        platform: 'linux',
        env: wayland,
        argv: ['e', '--ozone-platform=x11'],
        enabled: true
      })
    ).toMatchObject({ nativeWayland: false, needsRestartForPets: false });
  });

  test('Wayland without XWayland is unsupported', () => {
    expect(
      petsSupport({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        argv: ['e'],
        enabled: true
      })
    ).toEqual({
      supported: false,
      unsupportedReason: 'wayland-no-xwayland',
      nativeWayland: true,
      needsRestartForPets: false
    });
  });
});

describe('relaunchUnderXWaylandIfNeeded', () => {
  test('relaunches once with x11 in argv, releasing the lock first', () => {
    const app = fakeApp();
    expect(
      relaunchUnderXWaylandIfNeeded({
        app,
        platform: 'linux',
        env: wayland,
        argv: ['/x/electron', '.'],
        enabled: true
      })
    ).toBe(true);
    expect(app.calls).toEqual([
      ['release'],
      ['relaunch', { args: ['.', '--ozone-platform=x11'] }],
      ['exit', 0]
    ]);
  });

  test('the relaunched process does not loop', () => {
    const app = fakeApp();
    expect(
      relaunchUnderXWaylandIfNeeded({
        app,
        platform: 'linux',
        env: wayland,
        argv: ['/x/electron', '.', '--ozone-platform=x11'],
        enabled: true
      })
    ).toBe(false);
    expect(app.calls).toEqual([]);
  });

  test('pets off, X11, no XWayland or the opt-out → no relaunch', () => {
    const cases = [
      { env: wayland, enabled: false },
      { env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, enabled: true },
      { env: { WAYLAND_DISPLAY: 'w' }, enabled: true },
      { env: { ...wayland, TIF1AI_PETS_NATIVE_WAYLAND: '1' }, enabled: true }
    ];
    for (const { env, enabled } of cases) {
      const app = fakeApp();
      expect(
        relaunchUnderXWaylandIfNeeded({
          app,
          platform: 'linux',
          env,
          argv: ['e'],
          enabled
        })
      ).toBe(false);
      expect(app.calls).toEqual([]);
    }
  });
});

describe('restartApp', () => {
  test('Wayland → relaunch under XWayland', () => {
    const app = fakeApp();
    restartApp({ app, platform: 'linux', env: wayland, argv: ['e', '.'] });
    expect(app.calls).toEqual([
      ['relaunch', { args: ['.', '--ozone-platform=x11'] }],
      ['exit', 0]
    ]);
  });

  test('elsewhere → plain relaunch', () => {
    const app = fakeApp();
    restartApp({ app, platform: 'darwin', env: {}, argv: ['e'] });
    expect(app.calls).toEqual([
      ['relaunch', undefined],
      ['exit', 0]
    ]);
  });
});
