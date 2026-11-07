import { describe, test, expect } from 'bun:test';
import {
  createLineDecoder,
  encodeLine,
  MAX_LINE_BYTES,
  menuFromTemplate,
  nativeBinaryName,
  nativeSocketPath,
  parsePetsOpenArg,
  toNativeRender,
  validateFromNative
} from './native-protocol.mjs';
import { buildPetMenuTemplate, buildTrayMenuTemplate } from './tray.mjs';

describe('framing', () => {
  test('one JSON object per line; unknown kinds and huge lines throw', () => {
    expect(encodeLine({ kind: 'hide' })).toBe('{"kind":"hide"}\n');
    expect(() => encodeLine({ kind: 'nope' })).toThrow();
    expect(() =>
      encodeLine({ kind: 'render', payload: 'x'.repeat(MAX_LINE_BYTES) })
    ).toThrow();
  });

  test('the decoder joins chunks, skips blank lines, validates', () => {
    const decoder = createLineDecoder();
    expect(decoder.push('{"kind":"ack","of":"hand')).toEqual({
      messages: [],
      error: null
    });
    expect(decoder.push('off"}\n\n{"kind":"event","event":"click"}\n')).toEqual(
      {
        messages: [
          { kind: 'ack', of: 'handoff' },
          { kind: 'event', event: 'click' }
        ],
        error: null
      }
    );
    expect(createLineDecoder().push('{bad\n').error).toBe('bad-json');
    expect(createLineDecoder().push('{"kind":"render"}\n').error).toBe(
      'bad-message'
    );
    expect(createLineDecoder().push('x'.repeat(MAX_LINE_BYTES + 1)).error).toBe(
      'line-too-long'
    );
  });
});

describe('validateFromNative', () => {
  test('keeps only known fields with sane values', () => {
    expect(
      validateFromNative({
        kind: 'ready',
        protocol: 1,
        version: '0.1.0',
        caps: ['duo', 7],
        pid: 42,
        extra: 1
      })
    ).toEqual({
      kind: 'ready',
      protocol: 1,
      version: '0.1.0',
      caps: ['duo'],
      pid: 42
    });
    expect(
      validateFromNative({ kind: 'event', event: 'drag', dx: 3, dy: -2 })
    ).toEqual({ kind: 'event', event: 'drag', dx: 3, dy: -2 });
    expect(
      validateFromNative({ kind: 'event', event: 'drag', dx: 1e9, dy: 0 })
    ).toBeNull();
    expect(
      validateFromNative({ kind: 'event', event: 'contextMenu' })
    ).toBeNull();
    expect(
      validateFromNative({ kind: 'position', x: 10.4, y: 20.6, displayId: 5 })
    ).toEqual({
      kind: 'position',
      x: 10,
      y: 21,
      displayId: null,
      secondSide: 'left'
    });
    expect(validateFromNative({ kind: 'menuAction', id: 'tray.quit' })).toEqual(
      { kind: 'menuAction', id: 'tray.quit' }
    );
    expect(validateFromNative({ kind: 'menuAction', id: '../x' })).toBeNull();
    expect(validateFromNative({ kind: 'ack', of: 'other' })).toBeNull();
    expect(validateFromNative({ kind: 'hello' })).toBeNull();
  });
});

describe('toNativeRender', () => {
  const payload = {
    state: 'waving',
    row: 3,
    frames: 4,
    durationMs: 700,
    once: true,
    still: false,
    playKey: 'hover:1',
    bubble: null,
    size: 'l',
    atlas: { url: 'pet-asset://pet/a/sprite', rows: 9, scale: 1 },
    second: { url: 'pet-asset://pet/b/sprite', rows: 11, scale: 1 }
  };
  test('sprite URLs → file paths, null when a sprite is gone', () => {
    const paths = {
      'pet-asset://pet/a/sprite': '/p/a.webp',
      'pet-asset://pet/b/sprite': '/p/b.webp'
    };
    expect(toNativeRender(payload, (u) => paths[u] ?? null)).toEqual({
      state: 'waving',
      row: 3,
      frames: 4,
      durationMs: 700,
      once: true,
      still: false,
      playKey: 'hover:1',
      bubble: null,
      size: 'l',
      atlas: { path: '/p/a.webp', rows: 9, scale: 1 },
      second: { path: '/p/b.webp', rows: 11, scale: 1 }
    });
    expect(toNativeRender(payload, () => null)).toBeNull();
    expect(
      toNativeRender({ ...payload, state: 'dance' }, () => '/x')
    ).toBeNull();
  });
});

describe('menuFromTemplate', () => {
  const state = {
    petEnabled: true,
    hasPet: true,
    supported: true,
    size: 'm',
    launchAtLogin: false,
    quietActive: true,
    sessionQuietAvailable: false,
    updateReady: '0.2.1'
  };
  const log = [];
  const actions = {
    openMain: () => log.push('openMain'),
    openAsk: () => log.push('openAsk'),
    togglePet: () => log.push('togglePet'),
    choosePet: () => log.push('choosePet'),
    quiet: (k) => log.push(`quiet:${k}`),
    setSize: (s) => log.push(`size:${s}`),
    setLaunchAtLogin: (on) => log.push(`login:${on}`),
    quit: () => log.push('quit'),
    installUpdate: () => log.push('installUpdate')
  };

  test('stable prefixed ids, offline hints, clicks by id', () => {
    const tray = menuFromTemplate(
      buildTrayMenuTemplate(state, actions),
      'tray'
    );
    const ids = tray.items.map((i) => i.id);
    expect(ids).toContain('tray.open-tracinginsights');
    expect(ids).toContain('tray.quit-tracinginsights');
    expect(tray.items[0]).toEqual({
      id: 'tray.restart-to-update-0-2-1',
      label: 'Restart to update (0.2.1)',
      offline: { do: 'install-update' }
    });
    const quiet = tray.items.find((i) => i.id === 'tray.quiet');
    expect(quiet.submenu.map((i) => [i.id, i.offline])).toEqual([
      ['tray.quiet.until-this-session-ends', { do: 'quiet', kind: 'session' }],
      ['tray.quiet.for-1-hour', { do: 'quiet', kind: '1h' }],
      ['tray.quiet.off', { do: 'quiet', kind: 'off' }]
    ]);
    expect(quiet.submenu[0].enabled).toBe(false);
    const login = tray.items.find((i) => i.id === 'tray.launch-at-login');
    expect(login).toMatchObject({ type: 'checkbox', checked: false });
    tray.handlers.get('tray.launch-at-login')({ checked: true });
    tray.handlers.get('tray.quiet.for-1-hour')({});
    expect(log).toEqual(['login:true', 'quiet:1h']);
    for (const item of tray.items) {
      expect(item.id).toMatch(/^[a-z0-9.-]{1,64}$/);
    }

    const pet = menuFromTemplate(buildPetMenuTemplate(state, actions), 'pet');
    const size = pet.items.find((i) => i.id === 'pet.size');
    expect(size.submenu.map((i) => [i.id, i.checked, i.offline])).toEqual([
      ['pet.size.small', false, { do: 'size', size: 's' }],
      ['pet.size.medium', true, { do: 'size', size: 'm' }],
      ['pet.size.large', false, { do: 'size', size: 'l' }]
    ]);
    expect(pet.items[0].offline).toEqual({ do: 'open', path: '/desktop/ask' });
  });
});

describe('paths and args', () => {
  test('socket path: userData, temp fallback when too long, pipe on Windows', () => {
    expect(
      nativeSocketPath({
        platform: 'linux',
        userDataDir: '/home/u/.config/TracingInsights',
        tmpDir: '/tmp'
      })
    ).toBe('/home/u/.config/TracingInsights/pet.sock');
    const long = `/home/${'x'.repeat(120)}`;
    expect(
      nativeSocketPath({ platform: 'linux', userDataDir: long, tmpDir: '/tmp' })
    ).toMatch(/^\/tmp\/tracinginsights-pet-[0-9a-f]{16}\.sock$/);
    expect(
      nativeSocketPath({
        platform: 'win32',
        userDataDir: 'C:\\Users\\u',
        tmpDir: 'C:\\t'
      })
    ).toMatch(/^\\\\\.\\pipe\\tracinginsights-pet-[0-9a-f]{16}$/);
    expect(nativeBinaryName('win32', 'x64')).toBe('ti-pet-win32-x64.exe');
    expect(nativeBinaryName('darwin', 'arm64')).toBe('ti-pet-darwin-arm64');
  });

  test('--pets-open takes same-origin paths only', () => {
    expect(parsePetsOpenArg(['app', '--pets-open=/settings/pets'])).toBe(
      '/settings/pets'
    );
    expect(parsePetsOpenArg(['--pets-open=/rate/2026/sao-paulo?x=1'])).toBe(
      '/rate/2026/sao-paulo?x=1'
    );
    for (const bad of [
      '--pets-open=//evil.example/',
      '--pets-open=https://evil.example/',
      '--pets-open=/a\\b',
      '--pets-open=/a\nb',
      '--pets-open='
    ]) {
      expect(parsePetsOpenArg([bad])).toBeNull();
    }
    expect(parsePetsOpenArg(['--hidden'])).toBeNull();
  });
});
