/**
 * IPC surface for the harness (§7.2).
 *
 * Registers `providers:*`, `codex:*`, `xai:*`, and `inference:*` handlers and
 * validates that every sender is the app-origin document in the main window
 * (or another trusted app window — the pets quick-ask window).
 * No generic invoke passthrough; every fallible method resolves a
 * discriminated envelope (`{ ok: true, … } | { ok: false, error }`) instead of
 * rejecting (ipcRenderer.invoke rejections drop custom fields).
 */
import { STATIC_CODEX_MODELS, STATIC_XAI_MODELS } from './model-catalogs.mjs';

/**
 * Sender validation — the same trust check as today's
 * `assertTrustedBridgeIpcSender`, minus the removed Bridge Info window.
 * Pure and unit-testable: `context.mainWindow` is the BrowserWindow (or null),
 * `context.windows` optional further app windows trusted the same way (the
 * pets quick-ask window; null entries ignored) and `context.appOrigin` the
 * app URL origin. Every window still needs an app-origin document.
 * @param {any} event
 * @param {{ mainWindow: any, windows?: any[], appOrigin: string }} context
 */
export function isTrustedAppSender(event, context) {
  const senderUrl = event?.senderFrame?.url;
  if (!senderUrl) return false;
  try {
    if (new URL(senderUrl).origin !== context.appOrigin) return false;
  } catch {
    return false;
  }
  return [context.mainWindow, ...(context.windows ?? [])].some(
    (window) =>
      Boolean(window) &&
      !window.isDestroyed?.() &&
      event.sender === window.webContents
  );
}

export function createHarnessIpc(deps) {
  const {
    ipcMain,
    isTrustedSender,
    registry,
    codex,
    xai,
    inference,
    listModels
  } = deps;

  function assertTrusted(event) {
    if (!isTrustedSender(event)) {
      throw new Error('Harness IPC is not available from this page');
    }
  }

  /** In-flight inference request ids per sender webContents. */
  const requestsBySender = new Map();

  function track(sender, requestId) {
    if (
      !sender ||
      (typeof requestId !== 'string' && typeof requestId !== 'number')
    )
      return () => {};
    let ids = requestsBySender.get(sender);
    if (!ids) requestsBySender.set(sender, (ids = new Set()));
    ids.add(requestId);
    return () => {
      ids.delete(requestId);
      if (ids.size === 0 && requestsBySender.get(sender) === ids)
        requestsBySender.delete(sender);
    };
  }

  function register(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrusted(event);
      return handler(event, ...args);
    });
  }

  return {
    register() {
      // -- providers.* --
      register('providers:list', () => registry.list());

      register('providers:add', (_event, input) => registry.add(input ?? {}));

      register('providers:update', (_event, id, patch) =>
        registry.update(id, patch ?? {})
      );

      register('providers:remove', (_event, id) => registry.remove(id));

      register('providers:test', async (_event, id) => {
        const resolved = registry.resolve(id);
        if (!resolved) {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              providerMessage: 'Unknown provider.'
            }
          };
        }
        return listModels({
          protocol: resolved.entry.protocol,
          baseUrl: resolved.entry.baseUrl,
          apiKey: resolved.apiKey
        });
      });

      register('providers:listModels', (_event, input) =>
        listModels(input ?? {})
      );

      register('providers:keysStoredUnencrypted', () =>
        registry.keysStoredUnencrypted()
      );

      // -- codex.* --
      register('codex:status', () => codex.status());
      register('codex:startDeviceAuth', () => codex.startDeviceAuth());
      register('codex:pollDeviceAuth', () => codex.pollDeviceAuth());
      register('codex:connect', (_event, credential) =>
        codex.connect(credential)
      );
      register('codex:disconnect', () => codex.disconnect());
      register('codex:listModels', () => STATIC_CODEX_MODELS);

      // -- xai.* --
      register('xai:startDeviceAuth', () => xai.startDeviceAuth());
      register('xai:pollDeviceAuth', () => xai.pollDeviceAuth());
      register('xai:status', () => xai.status());
      register('xai:connect', (_event, credential) => xai.connect(credential));
      register('xai:disconnect', () => xai.disconnect());
      register('xai:listModels', () => STATIC_XAI_MODELS);

      // -- inference.* --
      register('inference:generate', async (event, input) => {
        const untrack = track(event.sender, input?.requestId);
        try {
          return await inference.generate({
            ...(input ?? {}),
            fetchImpl: globalThis.fetch
          });
        } finally {
          untrack();
        }
      });

      register('inference:stream', (event, input) => {
        const untrack = track(event.sender, input?.requestId);
        return inference.stream({
          ...(input ?? {}),
          send: (channel, payload) => {
            if (channel === 'inference:end') untrack();
            if (!event.sender.isDestroyed()) {
              event.sender.send(channel, payload);
            }
          }
        });
      });

      register('inference:abort', (_event, requestId) =>
        inference.abort(requestId)
      );
    },

    /**
     * Abort the requests one window started (its page navigated or it was
     * destroyed), leaving other windows' streams running.
     * @param {unknown} sender webContents
     */
    abortSender(sender) {
      const ids = requestsBySender.get(sender);
      if (!ids) return;
      requestsBySender.delete(sender);
      for (const requestId of ids) inference.abort(requestId);
    }
  };
}
