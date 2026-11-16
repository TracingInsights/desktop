import { describe, test, expect } from 'bun:test';
import {
  createLineDecoder,
  encodeLine,
  MAX_LINE_BYTES,
  menuFromTemplate,
  NATIVE_CAPS,
  nativeAnim,
  nativeBinaryName,
  nativeSocketPath,
  parsePetsOpenArg,
  toNativeRender,
  validateFromNative
} from './native-protocol.mjs';
import { PANEL_ACTION_IDS } from './contract.mjs';
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

describe('round 3: caps-gated native renders (L6)', () => {
  /** ti-pet-v0.1.1's `ready.caps`. */
  const V1_CAPS = ['duo', 'bubble', 'menu', 'timeline'];
  const ALL_CAPS = [...V1_CAPS, ...Object.values(NATIVE_CAPS)];
  const paths = (u) =>
    u.startsWith('pet-asset://') ? `/p/${u.at(-1)}.webp` : null;
  const ROUND3 = {
    state: 'look-a',
    row: 9,
    frames: 8,
    durationMs: 1120,
    once: true,
    still: false,
    playKey: 'look:1',
    bubble: 'On this day · 2026-11-07',
    size: 'm',
    atlas: { url: 'pet-asset://pet/a', rows: 11, scale: 1 },
    second: { url: 'pet-asset://pet/b', rows: 9, scale: 1 },
    motion: 'roam',
    sleeping: true,
    bubbleActions: [
      { id: 'ok', label: 'OK' },
      { id: 'quiet-1h', label: 'Quiet 1 h' },
      { id: 'mute', label: 'No daily facts' }
    ],
    panel: {
      lines: ['Race in 2 h · Abu Dhabi GP', 'Norris P1'],
      actions: [{ id: 'ask', label: 'Ask F1' }]
    },
    badge: { kind: 'answer', label: 'Answer ready' },
    secondAnim: {
      state: 'look-b',
      row: 10,
      frames: 8,
      durationMs: 1120,
      once: true,
      still: false,
      playKey: 'look:1:second',
      delayMs: 700
    }
  };
  const V1_KEYS = [
    'state',
    'row',
    'frames',
    'durationMs',
    'once',
    'still',
    'playKey',
    'bubble',
    'size',
    'atlas',
    'second'
  ];

  test('a ti-pet-v0.1.1 pet (or no caps): today’s shape, a look sent as idle', () => {
    for (const caps of [V1_CAPS, null, undefined, ['duo', 7]]) {
      const out = toNativeRender(ROUND3, paths, caps);
      expect(Object.keys(out).sort()).toEqual([...V1_KEYS].sort());
      expect(out).toMatchObject({
        state: 'idle',
        row: 0,
        frames: 6,
        durationMs: 1100,
        once: false,
        still: false,
        playKey: 'idle',
        bubble: ROUND3.bubble,
        atlas: { path: '/p/a.webp', rows: 11, scale: 1 }
      });
    }
  });

  test('a round-3 pet gets every field, the look rows kept', () => {
    expect(toNativeRender(ROUND3, paths, ALL_CAPS)).toEqual({
      state: 'look-a',
      row: 9,
      frames: 8,
      durationMs: 1120,
      once: true,
      still: false,
      playKey: 'look:1',
      bubble: ROUND3.bubble,
      size: 'm',
      atlas: { path: '/p/a.webp', rows: 11, scale: 1 },
      second: { path: '/p/b.webp', rows: 9, scale: 1 },
      motion: 'roam',
      sleeping: true,
      bubbleActions: ROUND3.bubbleActions,
      panel: ROUND3.panel,
      badge: { kind: 'answer', label: 'Answer ready' },
      secondAnim: ROUND3.secondAnim
    });
  });

  test('each field rides only on its own cap; v2 rows only with v2-rows', () => {
    const only = (cap) => toNativeRender(ROUND3, paths, [...V1_CAPS, cap]);
    expect(only('motion')).toMatchObject({ motion: 'roam', state: 'idle' });
    expect(only('motion')).not.toHaveProperty('sleeping');
    expect(only('sleep').sleeping).toBe(true);
    expect(only('bubble-actions').bubbleActions).toHaveLength(3);
    expect(only('panel').panel.lines).toHaveLength(2);
    expect(only('badge').badge.label).toBe('Answer ready');
    // The partner's own look needs v2-rows too: idle without it.
    expect(only('second-anim').secondAnim).toMatchObject({
      state: 'idle',
      row: 0,
      frames: 6,
      delayMs: 700
    });
    expect(only('v2-rows')).toMatchObject({ state: 'look-a', row: 9 });
    for (const cap of Object.values(NATIVE_CAPS)) {
      if (cap === 'timeline-v2' || cap === 'v2-rows') continue;
      expect(Object.keys(only(cap))).toHaveLength(V1_KEYS.length + 1);
    }
  });

  test('nothing new is sent as the “nothing new” value; junk is dropped', () => {
    const plain = {
      ...ROUND3,
      state: 'idle',
      row: 0,
      frames: 6,
      durationMs: 1100,
      bubble: null,
      motion: 'fly',
      sleeping: undefined,
      bubbleActions: [{ id: 'ok', label: 'OK' }],
      panel: 'open',
      badge: { kind: 'mail', label: 'x' },
      secondAnim: { state: 'dance' },
      second: null
    };
    expect(toNativeRender(plain, paths, ALL_CAPS)).toMatchObject({
      motion: null,
      sleeping: false,
      // Buttons only with a bubble.
      bubbleActions: null,
      panel: null,
      badge: null,
      secondAnim: null
    });
    const many = toNativeRender(
      {
        ...ROUND3,
        bubbleActions: [...ROUND3.bubbleActions, { id: 'x', label: 'X' }, 7],
        panel: { lines: ['a', '', 1, 'b', 'c', 'd'], actions: 'none' }
      },
      paths,
      ALL_CAPS
    );
    expect(many.bubbleActions.map((a) => a.id)).toEqual([
      'ok',
      'quiet-1h',
      'mute'
    ]);
    expect(many.panel).toEqual({ lines: ['a', 'b', 'c'], actions: [] });
  });

  test('nativeAnim: only v2 states change, and only without v2-rows', () => {
    const wave = {
      state: 'waving',
      row: 3,
      frames: 4,
      durationMs: 700,
      once: true
    };
    expect(nativeAnim(wave, false)).toBe(wave);
    const look = {
      state: 'look-b',
      row: 10,
      frames: 8,
      durationMs: 1120,
      once: true,
      still: true,
      playKey: 'k'
    };
    expect(nativeAnim(look, true)).toBe(look);
    expect(nativeAnim(look, false)).toEqual({
      state: 'idle',
      row: 0,
      frames: 6,
      durationMs: 1100,
      once: false,
      still: true,
      playKey: 'idle'
    });
  });
});

describe('round 3: events from the native pet (L6)', () => {
  test('bubbleAction / panelAction carry a known id; anything else drops the line', () => {
    expect(
      validateFromNative({ kind: 'event', event: 'bubbleAction', id: 'mute' })
    ).toEqual({ kind: 'event', event: 'bubbleAction', id: 'mute' });
    expect(
      validateFromNative({ kind: 'event', event: 'panelAction', id: 'close' })
    ).toEqual({ kind: 'event', event: 'panelAction', id: 'close' });
    for (const id of PANEL_ACTION_IDS) {
      expect(
        validateFromNative({ kind: 'event', event: 'panelAction', id })?.id
      ).toBe(id);
    }
    for (const bad of [
      { event: 'bubbleAction' },
      { event: 'bubbleAction', id: 'ask' },
      { event: 'bubbleAction', id: 'close' },
      { event: 'panelAction', id: 'mute' },
      { event: 'panelAction', id: 7 },
      { event: 'panelClose' }
    ]) {
      expect(validateFromNative({ kind: 'event', ...bad })).toBeNull();
    }
    // An id on a plain event is not kept.
    expect(
      validateFromNative({ kind: 'event', event: 'click', id: 'ok' })
    ).toEqual({ kind: 'event', event: 'click' });
  });

  test('position keeps walk: true (a walk ended there), nothing else', () => {
    expect(
      validateFromNative({ kind: 'position', x: 5, y: 6, walk: true })
    ).toEqual({
      kind: 'position',
      x: 5,
      y: 6,
      displayId: null,
      secondSide: 'left',
      walk: true
    });
    expect(
      validateFromNative({ kind: 'position', x: 5, y: 6, walk: 'yes' })
    ).not.toHaveProperty('walk');
  });
});
