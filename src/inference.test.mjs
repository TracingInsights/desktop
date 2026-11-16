import { describe, test, expect } from 'bun:test';
import { createInference } from './inference.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeInference(overrides = {}) {
  return createInference({
    registry: {
      resolve: (id) =>
        id === 'custom:ok'
          ? {
              entry: {
                id,
                protocol: 'openai-completions',
                baseUrl: 'http://127.0.0.1:11434/v1'
              },
              apiKey: 'sk-test'
            }
          : null
    },
    codexInference: {
      run: async ({ stream, onDelta, signal }) => {
        if (stream) {
          onDelta?.('a');
          onDelta?.('b');
          return {
            ok: true,
            text: 'ab',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
          };
        }
        if (signal?.aborted) return { ok: false, error: { code: 'aborted' } };
        return { ok: true, text: 'done' };
      }
    },
    xaiInference: {
      run: async () => ({ ok: true, text: 'xai' })
    },
    ...overrides
  });
}

describe('inference dispatcher', () => {
  test('generates through the codex adapter and returns the envelope', async () => {
    const inference = makeInference();
    const result = await inference.generate({
      providerId: 'codex',
      model: 'gpt-5.5',
      messages: [],
      requestId: 'req-1'
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('done');
  });

  test('streams deltas through the relay and ends with text + usage', async () => {
    const inference = makeInference();
    const events = [];
    await inference.stream({
      providerId: 'codex',
      model: 'gpt-5.5',
      messages: [],
      requestId: 'req-2',
      send: (channel, payload) => events.push({ channel, payload })
    });
    // The relay batches deltas on a timer; flush synchronously is not
    // guaranteed, so at minimum the end event must arrive.
    await delay(100);
    const end = events.find((e) => e.channel === 'inference:end');
    expect(end).toBeTruthy();
    expect(end.payload.text).toBe('ab');
    expect(end.payload.usage.outputTokens).toBe(2);
    const chunks = events.filter((e) => e.channel === 'inference:chunk');
    expect(chunks.map((c) => c.payload.delta).join('')).toBe('ab');
  });

  test('abort marks a generate as aborted', async () => {
    let signalSeen;
    const inference = makeInference({
      codexInference: {
        run: async ({ signal }) => {
          signalSeen = signal;
          return new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ ok: false, error: { code: 'aborted' } }),
              { once: true }
            );
          });
        }
      }
    });
    const promise = inference.generate({
      providerId: 'codex',
      model: 'm',
      messages: [],
      requestId: 'req-3'
    });
    // Wait a tick for the adapter to start, then abort.
    await delay(10);
    inference.abort('req-3');
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('aborted');
    expect(signalSeen).toBeInstanceOf(AbortSignal);
    expect(signalSeen.aborted).toBe(true);
  });

  test('request ids are scoped per sender (main and ask windows)', async () => {
    const signals = [];
    const inference = makeInference({
      codexInference: {
        run: async ({ signal }) => {
          signals.push(signal);
          return new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ ok: false, error: { code: 'aborted' } }),
              { once: true }
            );
          });
        }
      }
    });
    const main = { id: 1 };
    const ask = { id: 2 };
    const start = (scope) =>
      inference.generate({
        providerId: 'codex',
        model: 'm',
        messages: [],
        requestId: 'same-id',
        scope
      });
    const fromMain = start(main);
    const fromAsk = start(ask);
    await delay(10);
    inference.abort('same-id', ask);
    expect((await fromAsk).error.code).toBe('aborted');
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
    // The main window's request still runs and can still be aborted.
    inference.abort('same-id', main);
    expect((await fromMain).error.code).toBe('aborted');
  });

  test('rejects an unknown custom provider', async () => {
    const inference = makeInference();
    const result = await inference.generate({
      providerId: 'custom:missing',
      model: 'm',
      messages: [],
      requestId: 'req-4'
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_request');
  });
});
