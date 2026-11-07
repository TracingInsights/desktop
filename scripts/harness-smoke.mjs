#!/usr/bin/env bun
/**
 * Harness smoke test — run without Electron or a dev server:
 *
 *   cd desktop && bun run smoke        # or: bun run desktop:harness:smoke from the repo root
 *
 * Spins up a mock inference server on 127.0.0.1, then exercises the same
 * main-process modules the harness wires into IPC — add → /v1/models discovery
 * → stream → abort for each of the three custom-provider protocols — plus the
 * D4 target validation and the https→http redirect re-validation. The SSE
 * bodies are the shared golden fixtures (shared data, not shared code).
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProviderRegistry } from '../src/provider-registry.mjs';
import { createInference } from '../src/inference.mjs';
import { listModels } from '../src/model-discovery.mjs';
import {
  isAllowedTarget,
  MODEL_LOAD_GRACE_MS,
  STREAM_IDLE_TIMEOUT_MS
} from '../src/protocols/shared.mjs';
import {
  completionsSse,
  responsesSse,
  anthropicSse
} from '../src/protocols/__fixtures__/sse-traces.mjs';

const failures = [];

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.error(
      `  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`
    );
  }
}

/** In-memory safeStorage stand-in (encrypt/decrypt are no-ops). */
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8')
};

// ---------------------------------------------------------------------------
// Mock inference server — serves /v1/models + the three protocol SSE streams.
// The completions endpoint drips frames so an abort can land mid-stream.
// ---------------------------------------------------------------------------

const SSE_BODIES = {
  '/v1/chat/completions': completionsSse,
  '/v1/responses': responsesSse,
  '/v1/messages': anthropicSse
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'mock-local-1', max_model_len: 8192 },
          { id: 'mock-local-2', name: 'Mock Local 2' }
        ]
      })
    );
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/v1/redirect')) {
    // A redirect to a non-loopback http host that must be rejected (D4 / §7.3).
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    res.end();
    return;
  }

  // A stream that never ends on its own — for the deterministic abort test.
  if (req.method === 'POST' && url.pathname.startsWith('/v1/abort')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      try {
        res.write(
          `data: {"choices":[{"delta":{"content":"tok${n}"},"finish_reason":null}]}\n\n`
        );
        n += 1;
      } catch {
        clearInterval(timer);
      }
    }, 20);
    req.on('close', () => clearInterval(timer));
    res.on('close', () => clearInterval(timer));
    return;
  }

  const body = SSE_BODIES[url.pathname];
  if (req.method === 'POST' && body) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = body.split('\n\n').filter(Boolean);
    let i = 0;
    const timer = setInterval(() => {
      if (i >= frames.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(`${frames[i]}\n\n`);
      i += 1;
    }, 10);
    req.on('close', () => clearInterval(timer));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/v1`;

console.log(`mock inference server on ${base}`);

const userDataDir = mkdtempSync(join(tmpdir(), 'tif1ai-harness-smoke-'));
const registry = createProviderRegistry({
  userDataDir,
  safeStorage: mockSafeStorage,
  confirm: async () => true
});
const inference = createInference({
  registry,
  idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  firstTokenTimeoutMs: MODEL_LOAD_GRACE_MS
});

const PROTOCOLS = [
  { protocol: 'openai-completions', expected: '{"understanding": "Drivers"' },
  { protocol: 'openai-responses', expected: 'SELECT * FROM drivers' },
  { protocol: 'anthropic-messages', expected: 'Hello F1' }
];

async function runStream(providerId, model, requestId) {
  const chunks = [];
  let resolveEnd;
  const endPromise = new Promise((resolve) => (resolveEnd = resolve));
  await inference.stream({
    providerId,
    model,
    requestId,
    messages: [{ role: 'user', content: 'ping' }],
    send: (channel, payload) => {
      if (channel === 'inference:chunk') chunks.push(payload.delta ?? '');
      else if (channel === 'inference:end') resolveEnd(payload);
    }
  });
  const end = await endPromise;
  return { chunks, end };
}

try {
  // --- D4 target validation ---
  check(
    'loopback http allowed',
    isAllowedTarget('http://127.0.0.1:11434/v1') &&
      isAllowedTarget('http://localhost:11434') &&
      isAllowedTarget('http://[::1]:11434')
  );
  check(
    'remote https allowed, plain-http remote rejected',
    isAllowedTarget('https://api.fireworks.ai/v1') &&
      !isAllowedTarget('http://192.168.1.5:11434/v1')
  );
  const badAdd = await registry.add({
    label: 'LAN',
    protocol: 'openai-completions',
    baseUrl: 'http://192.168.1.5:11434/v1'
  });
  check(
    'registry.add rejects a plain-http remote target',
    badAdd.ok === false && badAdd.error.code === 'invalid_request',
    badAdd
  );

  // --- /v1/models discovery ---
  const discovered = await listModels({
    protocol: 'openai-completions',
    baseUrl: base,
    fetchImpl: fetch
  });
  check(
    'discovery surfaces models + contextWindow hint',
    discovered.ok === true &&
      discovered.models.some((m) => m.id === 'mock-local-1') &&
      discovered.models.find((m) => m.id === 'mock-local-1').contextWindow ===
        8192,
    discovered
  );

  // --- add → stream for each protocol ---
  for (const { protocol, expected } of PROTOCOLS) {
    const added = await registry.add({
      label: `Smoke ${protocol}`,
      protocol,
      baseUrl: base
    });
    check(`${protocol}: add succeeds`, added.ok === true, added);
    if (!added.ok) continue;

    const result = await runStream(added.id, 'mock-model', `smoke-${protocol}`);
    const text = result.end?.text ?? '';
    check(
      `${protocol}: stream end carries the expected text`,
      result.end?.error === undefined && text.includes(expected),
      { error: result.end?.error, text }
    );
    check(
      `${protocol}: stream relays deltas before end`,
      result.chunks.length > 0 && result.chunks.join('').includes(expected),
      result.chunks.join('')
    );
    check(
      `${protocol}: usage normalized to AI SDK shape`,
      result.end?.usage &&
        typeof result.end.usage.inputTokens === 'number' &&
        typeof result.end.usage.outputTokens === 'number',
      result.end?.usage
    );

    await registry.remove(added.id);
  }

  // --- abort mid-stream (deterministic: never-ending stream) ---
  const abortProvider = await registry.add({
    label: 'Smoke abort',
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${port}/v1/abort`
  });
  check(
    'abort provider add succeeds',
    abortProvider.ok === true,
    abortProvider
  );
  if (abortProvider.ok) {
    const abortedChunks = [];
    let abortedEnd = null;
    let resolveAbortedEnd;
    const abortedEndPromise = new Promise(
      (resolve) => (resolveAbortedEnd = resolve)
    );
    await inference.stream({
      providerId: abortProvider.id,
      model: 'mock-model',
      requestId: 'abort-check',
      messages: [{ role: 'user', content: 'ping' }],
      send: (channel, payload) => {
        if (channel === 'inference:chunk') {
          abortedChunks.push(payload.delta ?? '');
          // Abort synchronously on the first relayed chunk so the abort always
          // lands while the stream is still open.
          if (abortedChunks.length === 1) void inference.abort('abort-check');
        } else if (channel === 'inference:end') {
          abortedEnd = payload;
          resolveAbortedEnd(payload);
        }
      }
    });
    await abortedEndPromise;
    check(
      'abort surfaces code aborted on stream end',
      abortedChunks.length > 0 && abortedEnd?.error?.code === 'aborted',
      { chunks: abortedChunks.join(''), error: abortedEnd?.error }
    );
    await registry.remove(abortProvider.id);
  }

  // --- redirect re-validation (reject non-loopback http Location) ---
  const redirected = await listModels({
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${port}/v1/redirect`,
    fetchImpl: fetch
  });
  check(
    'discovery rejects a redirect to a disallowed target',
    redirected.ok === false && redirected.error.code === 'invalid_request',
    redirected
  );
} finally {
  try {
    server.closeAllConnections?.();
  } catch {
    /* ignore */
  }
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll harness smoke checks passed.');
process.exit(0);
