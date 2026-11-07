import { describe, test, expect } from 'bun:test';
import { createHarnessIpc, isTrustedAppSender } from './ipc.mjs';

const appOrigin = 'https://app.tracinginsights.com';

function senderEvent({ url, sender }) {
  return {
    senderFrame: { url },
    sender
  };
}

describe('isTrustedAppSender', () => {
  const window = { webContents: { id: 'main' }, isDestroyed: () => false };

  test('accepts the app-origin document in the main window', () => {
    expect(
      isTrustedAppSender(
        senderEvent({
          url: 'https://app.tracinginsights.com/chat',
          sender: window.webContents,
          window
        }),
        { mainWindow: window, appOrigin }
      )
    ).toBe(true);
  });

  test('rejects a lookalike origin', () => {
    expect(
      isTrustedAppSender(
        senderEvent({
          url: 'https://app.tracinginsights.com.evil.com',
          sender: window.webContents,
          window
        }),
        { mainWindow: window, appOrigin }
      )
    ).toBe(false);
  });

  test('rejects a different webContents', () => {
    expect(
      isTrustedAppSender(
        senderEvent({
          url: 'https://app.tracinginsights.com/chat',
          sender: { id: 'other' },
          window
        }),
        { mainWindow: window, appOrigin }
      )
    ).toBe(false);
  });

  test('rejects a missing sender frame URL', () => {
    expect(
      isTrustedAppSender(
        { senderFrame: undefined, sender: window.webContents },
        { mainWindow: window, appOrigin }
      )
    ).toBe(false);
  });

  test('rejects a destroyed window', () => {
    const destroyed = { webContents: { id: 'main' }, isDestroyed: () => true };
    expect(
      isTrustedAppSender(
        senderEvent({
          url: 'https://app.tracinginsights.com/chat',
          sender: destroyed.webContents,
          window: destroyed
        }),
        { mainWindow: destroyed, appOrigin }
      )
    ).toBe(false);
  });
});

describe('isTrustedAppSender — further app windows (quick-ask)', () => {
  const main = { webContents: { id: 'main' }, isDestroyed: () => false };
  const ask = { webContents: { id: 'ask' }, isDestroyed: () => false };
  const url = 'https://app.tracinginsights.com/desktop/ask';

  test('accepts an app-origin document in a listed window', () => {
    expect(
      isTrustedAppSender(senderEvent({ url, sender: ask.webContents }), {
        mainWindow: main,
        windows: [ask],
        appOrigin
      })
    ).toBe(true);
    // Main window closed to the tray: the ask window still works.
    expect(
      isTrustedAppSender(senderEvent({ url, sender: ask.webContents }), {
        mainWindow: null,
        windows: [null, ask],
        appOrigin
      })
    ).toBe(true);
  });

  test('keeps the origin check and ignores unlisted / destroyed windows', () => {
    expect(
      isTrustedAppSender(
        senderEvent({
          url: 'https://petdex.dev/',
          sender: ask.webContents
        }),
        { mainWindow: main, windows: [ask], appOrigin }
      )
    ).toBe(false);
    expect(
      isTrustedAppSender(senderEvent({ url, sender: ask.webContents }), {
        mainWindow: main,
        appOrigin
      })
    ).toBe(false);
    const gone = { webContents: { id: 'ask' }, isDestroyed: () => true };
    expect(
      isTrustedAppSender(senderEvent({ url, sender: gone.webContents }), {
        mainWindow: main,
        windows: [gone],
        appOrigin
      })
    ).toBe(false);
  });
});

describe('createHarnessIpc abortSender', () => {
  function setup() {
    const handlers = new Map();
    const aborted = [];
    const ends = new Map();
    const inference = {
      stream: (input) => {
        ends.set(input.requestId, () =>
          input.send('inference:end', { requestId: input.requestId })
        );
        return { requestId: input.requestId };
      },
      generate: async () => ({ ok: true, text: '' }),
      abort: (id) => aborted.push(id),
      abortAll: () => aborted.push('*')
    };
    const ipc = createHarnessIpc({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      isTrustedSender: () => true,
      registry: {},
      codex: {},
      xai: {},
      inference,
      listModels: async () => []
    });
    ipc.register();
    const sender = (id) => ({ id, isDestroyed: () => false, send() {} });
    const stream = (s, requestId) =>
      handlers.get('inference:stream')(
        { sender: s, senderFrame: { url: appOrigin } },
        { requestId, providerId: 'codex' }
      );
    return { ipc, aborted, ends, sender, stream };
  }

  test("aborts only that window's in-flight streams", async () => {
    const { ipc, aborted, ends, sender, stream } = setup();
    const main = sender('main');
    const ask = sender('ask');
    await stream(main, 'm1');
    await stream(ask, 'a1');
    await stream(ask, 'a2');
    ends.get('a2')();
    ipc.abortSender(ask);
    expect(aborted).toEqual(['a1']);
    ipc.abortSender(ask);
    expect(aborted).toEqual(['a1']);
    ipc.abortSender(main);
    expect(aborted).toEqual(['a1', 'm1']);
  });
});
