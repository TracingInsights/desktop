import { describe, test, expect } from 'bun:test';
import {
  createPetsIpc,
  isPetWindowSender,
  validateActionId,
  validateCelebrateInput,
  validateSearchInput,
  validateShelfInput
} from './ipc.mjs';
import { isTrustedAppSender } from '../ipc.mjs';
import {
  BUBBLE_ACTION_IDS,
  PANEL_ACTION_IDS,
  PET_WINDOW_CHANNELS,
  PETS_CHANNELS
} from './contract.mjs';

const APP_ORIGIN = 'https://tracinginsights.com';

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    invoke: (channel, event, ...args) => handlers.get(channel)(event, ...args),
    emit: (channel, event, ...args) => listeners.get(channel)(event, ...args),
    handlers,
    listeners
  };
}

const makeWindow = (id) => ({
  webContents: { id },
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  }
});

/** The harness-style wiring main.mjs uses: windows are read per call. */
function setup() {
  const state = {
    mainWindow: makeWindow('main-1'),
    petWindow: makeWindow('pet-1')
  };
  const ipcMain = fakeIpcMain();
  const calls = [];
  const petEvents = [];
  const service = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args) => {
          calls.push([name, ...args]);
          return { ok: true, method: name };
        }
    }
  );
  const ipc = createPetsIpc({
    ipcMain,
    isTrustedSender: (event) =>
      isTrustedAppSender(event, {
        mainWindow: state.mainWindow,
        appOrigin: APP_ORIGIN
      }),
    isPetSender: (event) =>
      isPetWindowSender(event, { petWindow: state.petWindow }),
    service,
    onPetEvent: (...args) => petEvents.push(args),
    log: () => {}
  });
  ipc.register();
  const fromMain = (url = `${APP_ORIGIN}/settings/pets`) => ({
    sender: state.mainWindow.webContents,
    senderFrame: { url }
  });
  const fromPet = (url = 'app://pet/index.html') => ({
    sender: state.petWindow.webContents,
    senderFrame: { url }
  });
  return { state, ipcMain, calls, petEvents, fromMain, fromPet, ipc };
}

describe('pets:* sender checks', () => {
  test('every PETS channel is registered', () => {
    const { ipcMain } = setup();
    for (const [key, channel] of Object.entries(PETS_CHANNELS)) {
      if (key === 'changed') continue;
      expect(ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  test('the main window on the app origin is trusted', async () => {
    const { ipcMain, fromMain, calls } = setup();
    expect(await ipcMain.invoke(PETS_CHANNELS.status, fromMain())).toEqual({
      ok: true,
      method: 'status'
    });
    expect(calls).toEqual([['status']]);
  });

  test('the pet window, other origins and other webContents are refused', async () => {
    const { ipcMain, fromPet, fromMain, state, calls } = setup();
    for (const event of [
      fromPet(),
      fromPet(`${APP_ORIGIN}/`),
      fromMain('https://tracinginsights.com.evil.com/'),
      { sender: { id: 'other' }, senderFrame: { url: `${APP_ORIGIN}/` } },
      { sender: state.mainWindow.webContents, senderFrame: null }
    ]) {
      const result = await ipcMain.invoke(PETS_CHANNELS.status, event);
      expect(result.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test('a recreated main window is trusted; the destroyed one is not', async () => {
    const { ipcMain, state, calls } = setup();
    const old = state.mainWindow;
    old.destroyed = true;
    state.mainWindow = makeWindow('main-2');
    const oldEvent = {
      sender: old.webContents,
      senderFrame: { url: `${APP_ORIGIN}/` }
    };
    expect((await ipcMain.invoke(PETS_CHANNELS.list, oldEvent)).ok).toBe(false);
    const newEvent = {
      sender: state.mainWindow.webContents,
      senderFrame: { url: `${APP_ORIGIN}/` }
    };
    expect((await ipcMain.invoke(PETS_CHANNELS.list, newEvent)).ok).toBe(true);
    expect(calls).toEqual([['list']]);
  });

  test('no main window (closed to tray) → refused', async () => {
    const { ipcMain, state, fromMain } = setup();
    const event = fromMain();
    state.mainWindow = null;
    expect((await ipcMain.invoke(PETS_CHANNELS.status, event)).ok).toBe(false);
  });

  test('a throwing service resolves an envelope', async () => {
    const ipcMain = fakeIpcMain();
    createPetsIpc({
      ipcMain,
      isTrustedSender: () => true,
      isPetSender: () => false,
      service: {
        status: () => {
          throw new Error('disk full');
        }
      },
      onPetEvent: () => {},
      log: () => {}
    }).register();
    expect(await ipcMain.invoke(PETS_CHANNELS.status, {})).toEqual({
      ok: false,
      error: 'disk full'
    });
  });
});

describe('pets:* argument validation', () => {
  const cases = [
    [PETS_CHANNELS.install, ['../etc'], false],
    [PETS_CHANNELS.install, [42], false],
    [PETS_CHANNELS.install, ['lando'], true],
    [PETS_CHANNELS.remove, ['petdex:lando'], true],
    [PETS_CHANNELS.remove, ['file:/etc/passwd'], false],
    [PETS_CHANNELS.setActive, [null], true],
    [PETS_CHANNELS.setActive, ['codex:my%20pet'], true],
    [PETS_CHANNELS.setActive, [{}], false],
    [PETS_CHANNELS.updateSettings, [{ size: 'l' }], true],
    [PETS_CHANNELS.updateSettings, [['size']], false],
    [PETS_CHANNELS.updateSettings, ['size=l'], false],
    [PETS_CHANNELS.quiet, ['1h'], true],
    [PETS_CHANNELS.quiet, [{ kind: '1h' }], false],
    [PETS_CHANNELS.quiet, ['forever'], false],
    [PETS_CHANNELS.signal, ['streaming'], true],
    [PETS_CHANNELS.signal, ['dance'], false],
    [PETS_CHANNELS.search, [{ q: 'f1', limit: 24 }], true],
    [PETS_CHANNELS.search, [{ limit: 500 }], false],
    [
      PETS_CHANNELS.shelf,
      [{ terms: ['f1'], curated: ['lando'], deny: [] }],
      true
    ],
    [
      PETS_CHANNELS.shelf,
      [{ terms: ['f1'], curated: ['../x'], deny: [] }],
      false
    ]
  ];
  for (const [channel, args, accepted] of cases) {
    test(`${channel}(${JSON.stringify(args)}) → ${accepted ? 'service' : 'refused'}`, async () => {
      const { ipcMain, fromMain, calls } = setup();
      const result = await ipcMain.invoke(channel, fromMain(), ...args);
      expect(result.ok).toBe(accepted);
      expect(calls.length).toBe(accepted ? 1 : 0);
    });
  }

  test('search input is copied to an allowlisted shape', () => {
    expect(
      validateSearchInput({
        q: 'f1',
        sort: 'recent',
        cursor: 24,
        limit: 12,
        extra: 1
      })
    ).toEqual({
      ok: true,
      value: { q: 'f1', sort: 'recent', cursor: 24, limit: 12 }
    });
    expect(validateSearchInput(undefined)).toEqual({ ok: true, value: {} });
    expect(validateSearchInput({ cursor: -1 }).ok).toBe(false);
    expect(validateSearchInput({ q: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateSearchInput({ sort: 'random' }).ok).toBe(false);
  });

  test('shelf input caps lists', () => {
    expect(validateShelfInput({ terms: Array(11).fill('f1') }).ok).toBe(false);
    expect(validateShelfInput({ terms: [''] }).ok).toBe(false);
    expect(validateShelfInput(null).ok).toBe(false);
    expect(validateShelfInput({}).ok).toBe(true);
  });
});

describe('pet:* channels', () => {
  test('events from the pet window reach the controller', () => {
    const { ipcMain, fromPet, petEvents } = setup();
    ipcMain.emit(PET_WINDOW_CHANNELS.ready, fromPet(), { reducedMotion: true });
    ipcMain.emit(PET_WINDOW_CHANNELS.drag, fromPet(), 3.4, -2);
    ipcMain.emit(PET_WINDOW_CHANNELS.click, fromPet());
    ipcMain.emit(PET_WINDOW_CHANNELS.bubbleClick, fromPet());
    expect(petEvents).toEqual([
      ['ready', { reducedMotion: true }],
      ['drag', 3, -2],
      ['click'],
      ['bubbleClick']
    ]);
  });

  test('the main window, other pages and a destroyed pet window are ignored', () => {
    const { ipcMain, fromMain, fromPet, state, petEvents } = setup();
    ipcMain.emit(PET_WINDOW_CHANNELS.click, fromMain());
    ipcMain.emit(PET_WINDOW_CHANNELS.click, fromPet('https://evil.example/'));
    ipcMain.emit(
      PET_WINDOW_CHANNELS.click,
      fromPet('pet-asset://pet/x/sprite')
    );
    const event = fromPet();
    state.petWindow.destroyed = true;
    ipcMain.emit(PET_WINDOW_CHANNELS.click, event);
    state.petWindow = null;
    ipcMain.emit(PET_WINDOW_CHANNELS.click, event);
    expect(petEvents).toEqual([]);
  });

  test('bad drag deltas and ready payloads are sanitised', () => {
    const { ipcMain, fromPet, petEvents } = setup();
    ipcMain.emit(PET_WINDOW_CHANNELS.drag, fromPet(), NaN, 1);
    ipcMain.emit(PET_WINDOW_CHANNELS.drag, fromPet(), '5', 1);
    ipcMain.emit(PET_WINDOW_CHANNELS.drag, fromPet(), 1e9, 1);
    ipcMain.emit(PET_WINDOW_CHANNELS.ready, fromPet(), 'yes');
    expect(petEvents).toEqual([['ready', { reducedMotion: false }]]);
  });
});

describe('notifyChanged', () => {
  test('sends pets:changed to a live main window only', () => {
    const { ipc } = setup();
    const sent = [];
    ipc.notifyChanged({ isDestroyed: () => false, send: (c) => sent.push(c) });
    ipc.notifyChanged({ isDestroyed: () => true, send: (c) => sent.push(c) });
    ipc.notifyChanged(null);
    expect(sent).toEqual([PETS_CHANNELS.changed]);
  });
});

describe('companion channels (round 2)', () => {
  test('setFavorite takes an f1db driver id or null', async () => {
    const { ipcMain, fromMain, calls } = setup();
    for (const ok of [null, 'max-verstappen', 'carlos-sainz-jr']) {
      expect(
        (await ipcMain.invoke(PETS_CHANNELS.setFavorite, fromMain(), ok)).ok
      ).toBe(true);
    }
    for (const bad of [
      undefined,
      '',
      'Max',
      'max verstappen',
      '../etc',
      'a'.repeat(65),
      42,
      { id: 'max-verstappen' }
    ]) {
      expect(
        await ipcMain.invoke(PETS_CHANNELS.setFavorite, fromMain(), bad)
      ).toEqual({ ok: false, error: 'Unknown driver.' });
    }
    expect(calls).toEqual([
      ['setFavorite', null],
      ['setFavorite', 'max-verstappen'],
      ['setFavorite', 'carlos-sainz-jr']
    ]);
  });

  test('setSecondPet takes a pet id or null', async () => {
    const { ipcMain, fromMain, calls } = setup();
    expect(
      (await ipcMain.invoke(PETS_CHANNELS.setSecondPet, fromMain(), null)).ok
    ).toBe(true);
    expect(
      (
        await ipcMain.invoke(
          PETS_CHANNELS.setSecondPet,
          fromMain(),
          'petdex:lando'
        )
      ).ok
    ).toBe(true);
    for (const bad of ['lando', 'petdex:../x', 'web:x', 1, undefined]) {
      expect(
        (await ipcMain.invoke(PETS_CHANNELS.setSecondPet, fromMain(), bad)).ok
      ).toBe(false);
    }
    expect(calls).toEqual([
      ['setSecondPet', null],
      ['setSecondPet', 'petdex:lando']
    ]);
  });

  test('celebrate accepts exactly { kind, text } with a known kind and ≤ 120 chars', async () => {
    const { ipcMain, fromMain, calls } = setup();
    const ok = { kind: 'hot-lap-pb', text: 'x'.repeat(120) };
    expect(
      (await ipcMain.invoke(PETS_CHANNELS.celebrate, fromMain(), ok)).ok
    ).toBe(true);
    expect(calls).toEqual([['celebrate', ok]]);
    for (const bad of [
      null,
      'hot-lap-pb',
      [],
      { kind: 'confetti', text: 'x' },
      { kind: 'roadster-best' },
      { kind: 'roadster-best', text: 7 },
      { kind: 'roadster-best', text: 'x'.repeat(121) },
      { kind: 'roadster-best', text: 'x', url: 'https://evil' }
    ]) {
      expect(
        (await ipcMain.invoke(PETS_CHANNELS.celebrate, fromMain(), bad)).ok
      ).toBe(false);
    }
    expect(calls.length).toBe(1);
  });

  test('validateCelebrateInput copies only kind and text', () => {
    const input = Object.assign(Object.create(null), {
      kind: 'roadster-best',
      text: 'Best!'
    });
    // Not a plain object (null prototype) → refused.
    expect(validateCelebrateInput(input).ok).toBe(false);
    expect(validateCelebrateInput({ kind: 'roadster-best', text: '' })).toEqual(
      { ok: true, value: { kind: 'roadster-best', text: '' } }
    );
  });

  test('onboardingDone and openAsk take no arguments and reach the service', async () => {
    const { ipcMain, fromMain, calls } = setup();
    await ipcMain.invoke(PETS_CHANNELS.onboardingDone, fromMain(), 'ignored');
    await ipcMain.invoke(PETS_CHANNELS.openAsk, fromMain(), { x: 1 });
    expect(calls).toEqual([['onboardingDone'], ['openAsk']]);
  });

  test('the new channels refuse untrusted senders', async () => {
    const { ipcMain, fromPet, calls } = setup();
    for (const [channel, arg] of [
      [PETS_CHANNELS.setFavorite, 'max-verstappen'],
      [PETS_CHANNELS.setSecondPet, null],
      [PETS_CHANNELS.celebrate, { kind: 'hot-lap-pb', text: 'PB' }],
      [PETS_CHANNELS.onboardingDone, undefined],
      [PETS_CHANNELS.openAsk, undefined]
    ]) {
      expect((await ipcMain.invoke(channel, fromPet(), arg)).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe('round 3: bubble / panel buttons and the signal sender', () => {
  test('every bubble and panel button id reaches the controller', () => {
    const { ipcMain, fromPet, petEvents } = setup();
    for (const id of BUBBLE_ACTION_IDS) {
      ipcMain.emit(PET_WINDOW_CHANNELS.bubbleAction, fromPet(), { id });
    }
    for (const id of [...PANEL_ACTION_IDS, 'close']) {
      ipcMain.emit(PET_WINDOW_CHANNELS.panelAction, fromPet(), { id });
    }
    expect(petEvents).toEqual([
      ['bubbleAction', 'ok'],
      ['bubbleAction', 'quiet-1h'],
      ['bubbleAction', 'quiet-session'],
      ['bubbleAction', 'mute'],
      ['panelAction', 'ask'],
      ['panelAction', 'rate'],
      ['panelAction', 'stats'],
      ['panelAction', 'hot-lap'],
      ['panelAction', 'pets'],
      ['panelAction', 'close']
    ]);
  });

  test('unknown ids and anything but exactly { id } are dropped', () => {
    const { ipcMain, fromPet, petEvents } = setup();
    const bad = [
      undefined,
      null,
      'ok',
      ['ok'],
      {},
      { id: 1 },
      { id: 'OK' },
      { id: 'ok ' },
      { id: 'quiet-forever' },
      { id: 'ok', extra: true },
      { id: '__proto__' },
      Object.assign(Object.create(null), { id: 'ok' }),
      // The other channel's ids.
      { id: 'close' },
      { id: 'ask' }
    ];
    for (const input of bad) {
      ipcMain.emit(PET_WINDOW_CHANNELS.bubbleAction, fromPet(), input);
    }
    for (const input of [
      ...bad.slice(0, 12),
      { id: 'ok' },
      { id: 'mute' },
      { id: 'settings' }
    ]) {
      ipcMain.emit(PET_WINDOW_CHANNELS.panelAction, fromPet(), input);
    }
    expect(petEvents).toEqual([]);
  });

  test('button events from the main window or another page are ignored', () => {
    const { ipcMain, fromMain, fromPet, petEvents } = setup();
    ipcMain.emit(PET_WINDOW_CHANNELS.bubbleAction, fromMain(), { id: 'ok' });
    ipcMain.emit(PET_WINDOW_CHANNELS.panelAction, fromMain(), { id: 'ask' });
    ipcMain.emit(
      PET_WINDOW_CHANNELS.panelAction,
      fromPet('https://evil.example/'),
      { id: 'pets' }
    );
    expect(petEvents).toEqual([]);
  });

  test('validateActionId', () => {
    expect(validateActionId({ id: 'ok' }, BUBBLE_ACTION_IDS)).toBe('ok');
    expect(validateActionId({ id: 'ok' }, PANEL_ACTION_IDS)).toBeNull();
    expect(validateActionId({ id: 'pets' }, PANEL_ACTION_IDS)).toBe('pets');
    expect(validateActionId({ id: 'pets', x: 1 }, PANEL_ACTION_IDS)).toBeNull();
    expect(validateActionId('pets', PANEL_ACTION_IDS)).toBeNull();
  });

  test('pets:signal tells the service which window sent it', async () => {
    const ipcMain = fakeIpcMain();
    const calls = [];
    const main = makeWindow('main-1');
    const ask = makeWindow('ask-1');
    createPetsIpc({
      ipcMain,
      isTrustedSender: (event) =>
        isTrustedAppSender(event, {
          mainWindow: main,
          windows: [ask],
          appOrigin: APP_ORIGIN
        }),
      isPetSender: () => false,
      service: {
        signal: (...args) => {
          calls.push(args);
          return { ok: true };
        }
      },
      onPetEvent: () => {},
      signalSource: (event) =>
        event.sender === ask.webContents ? 'ask' : 'main',
      log: () => {}
    }).register();
    const from = (win, url = `${APP_ORIGIN}/desktop/ask`) => ({
      sender: win.webContents,
      senderFrame: { url }
    });
    expect(
      (await ipcMain.invoke(PETS_CHANNELS.signal, from(ask), 'done')).ok
    ).toBe(true);
    await ipcMain.invoke(
      PETS_CHANNELS.signal,
      from(main, `${APP_ORIGIN}/chat`),
      'done'
    );
    // Untrusted pages never reach the service.
    await ipcMain.invoke(
      PETS_CHANNELS.signal,
      from(ask, 'https://evil.example/'),
      'done'
    );
    await ipcMain.invoke(PETS_CHANNELS.signal, from(ask), 'dance');
    expect(calls).toEqual([
      ['done', 'ask'],
      ['done', 'main']
    ]);
  });
});
