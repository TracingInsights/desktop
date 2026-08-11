/**
 * TracingInsights Desktop Bridge — localhost proxy server.
 *
 * Mirrors the site's server-side provider proxies so the web app can route
 * ChatGPT Codex and Grok (SuperGrok) calls through the user's own desktop
 * app instead of the TracingInsights server. Browsers cannot fetch
 * chatgpt.com / auth.x.ai / cli-chat-proxy.grok.com directly (CORS), but a
 * local Node process can — with none of the user's tokens leaving the
 * machine.
 *
 * Endpoints (paths intentionally match the site routes):
 *   GET  /health                 — liveness (no token required); the version
 *                                  is only included with a valid token
 *   GET  /api/codex/models       — static model catalog
 *   POST /api/codex/responses    — SSE passthrough to chatgpt.com
 *   GET  /api/xai/models         — static model catalog
 *   POST /api/xai/responses      — SSE passthrough to cli-chat-proxy.grok.com
 *   POST /api/xai/oauth          — auth.x.ai passthrough (x-xai-oauth-target)
 *
 * Security model:
 *   - Binds 127.0.0.1 only (enforced by the caller; see main.mjs).
 *   - Rejects requests whose Host header is not a loopback hostname
 *     (DNS-rebinding guard).
 *   - Every endpoint except /health requires the pairing token in the
 *     `x-bridge-token` header (timing-safe compare).
 *   - CORS is wide open (`*`) so the site can call it from any origin — the
 *     pairing token is the gate, and the token is never a cookie.
 *   - /health stays unauthenticated so the web app can distinguish a dead
 *     bridge from a rejected token. Accepted trade-off: any website can
 *     probe the enumerable port range (4318–4342) and detect the bridge's
 *     presence and bound port — that is inherent to a localhost agent with a
 *     CSP-pinned port range (the prober already knows the port it reached us
 *     on). The version string, however, is withheld unless the caller
 *     presents a valid pairing token, so unauthenticated probes cannot
 *     fingerprint the exact build for known-vulnerability targeting.
 *
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { STATIC_CODEX_MODELS, STATIC_XAI_MODELS } from './model-catalogs.mjs';

export const BRIDGE_VERSION = '0.1.0';
export const DEFAULT_PORT = 4318;

// How many consecutive ports the bridge may try when the requested one is
// taken (see main.mjs). Also the width of the site's CSP allowlist: the web
// app enumerates DEFAULT_PORT .. DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1
// (4318–4342) in src/lib/server/hooks/handlers/security-headers.ts, and
// tests/unit/security-headers.test.ts verifies the two stay in sync. Moving
// the retry count here (instead of main.mjs) makes that sync test possible —
// main.mjs imports Electron, bridge.mjs does not.
export const BRIDGE_PORT_ATTEMPTS = 25;
// Minimum pairing-token length both sides accept: main.mjs refuses to load a
// shorter stored token, and the web app's connect form rejects shorter input
// (DESKTOP_BRIDGE_TOKEN_MIN_LENGTH in src/lib/ai/desktop-bridge.ts). Lives
// here — not in main.mjs — so the sync test can import it (main.mjs imports
// Electron, bridge.mjs does not). tests/unit/desktop-bridge.test.ts keeps the
// two copies in sync.
export const TOKEN_MIN_LENGTH = 16;
// Idle watchdog for the streaming passthroughs: aborts the upstream when no
// chunk has arrived for this long. Deliberately generous — reasoning models
// (Codex, Grok reasoning) can legitimately pause minutes between SSE deltas
// on hard prompts, and neither the site's server proxies nor the client SSE
// reader (readSseStream in src/lib/ai/run/sse.ts) impose any idle/read
// deadline, so a short timeout would be a bridge-only regression. This only
// needs to reap truly-dead streams.
export const STREAM_IDLE_TIMEOUT_MS = 300_000;
// Overall cap for the non-streaming auth.x.ai passthrough. Unlike the
// streaming endpoints there is no incremental progress to watch, so a hung
// upstream would otherwise hold the request and socket open indefinitely.
export const OAUTH_UPSTREAM_TIMEOUT_MS = 30_000;

const UPSTREAM_CODEX_RESPONSES =
  'https://chatgpt.com/backend-api/codex/responses';
const UPSTREAM_XAI_RESPONSES = 'https://cli-chat-proxy.grok.com/v1/responses';
const XAI_OAUTH_BASE = 'https://auth.x.ai';
const ALLOWED_XAI_OAUTH_PATHS = new Set([
  '/oauth2/device/code',
  '/oauth2/token'
]);

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '0:0:0:0:0:0:0:1'
]);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, chatgpt-account-id, x-openai-fedramp, x-xai-oauth-target, x-bridge-token',
  'access-control-max-age': '86400'
};

function hostIsLoopback(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host : host.slice(1, end);
  } else {
    host = host.split(':')[0];
  }
  return LOOPBACK_HOSTS.has(host);
}

function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function pickHeaders(req, names) {
  const out = {};
  for (const name of names) {
    const value = req.headers[name];
    if (value !== undefined) {
      out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return out;
}

/**
 * Short, user-safe detail for an SSE error frame (dropped when long, so a
 * chatty upstream can never balloon the frame).
 */
function sseErrorDetail(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (!raw || raw.length > 160) return '';
  return `: ${raw}`;
}

/**
 * Deliver a parseable SSE error to a client whose response has already
 * started (headers sent). The site's SSE reader (readSseStream in
 * src/lib/ai/run/sse.ts) turns a `data:` frame whose JSON payload has an
 * `error` object into a thrown Error with a useful message — a bare
 * res.destroy() would instead surface as a raw network error or a silently
 * truncated stream with no provider-level message. No-op when the response
 * already ended or the client is gone.
 */
function writeSseErrorFrame(res, message) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
    res.end();
  } catch {
    res.destroy();
  }
}

/**
 * Handle a single bridge request. Exported separately from
 * `createBridgeServer` so unit tests can drive it (or the full server on an
 * ephemeral port) without Electron.
 */
export async function handleBridgeRequest(req, res, deps) {
  const {
    token,
    fetchImpl = globalThis.fetch,
    log,
    version = BRIDGE_VERSION,
    streamIdleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
    oauthUpstreamTimeoutMs = OAUTH_UPSTREAM_TIMEOUT_MS
  } = deps;

  const logError = (...args) => {
    if (log && typeof log.error === 'function') log.error(...args);
  };

  const sendJson = (status, body, extraHeaders = {}) => {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(name, value);
    }
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      ...extraHeaders
    });
    res.end(JSON.stringify(body));
  };

  // DNS-rebinding guard: only accept loopback Host headers.
  if (!hostIsLoopback(req.headers.host)) {
    return sendJson(403, { error: 'Forbidden.' });
  }

  if (req.method === 'OPTIONS') {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(name, value);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? '127.0.0.1'}`
  );
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    // Report the port this request actually arrived on — the bound listen
    // port — never a "requested" port the caller hoped to bind. main.mjs
    // walks to the next free port when the default is taken (EADDRINUSE),
    // so a frozen deps.port would make /health lie. `req.socket.localPort`
    // is the OS-level local port of the accepted connection, i.e. always
    // the truth. deps.port remains only as a fallback for direct
    // handleBridgeRequest() calls whose mock request has no real socket.
    const socketPort = req.socket?.localPort;
    const port =
      typeof socketPort === 'number'
        ? socketPort
        : typeof deps.port === 'number'
          ? deps.port
          : undefined;
    // Withhold the version from unauthenticated callers: /health answers any
    // origin (CORS `*`) and the port range is enumerable, so a public version
    // string would let any website fingerprint the exact bridge build for
    // known-vulnerability targeting. Presence and port stay — the prober
    // already knows the port it reached us on.
    const authenticated = tokensEqual(req.headers['x-bridge-token'], token);
    return sendJson(200, {
      ok: true,
      app: 'tif1ai-desktop-bridge',
      ...(authenticated ? { version } : {}),
      ...(port !== undefined ? { port } : {})
    });
  }

  if (!tokensEqual(req.headers['x-bridge-token'], token)) {
    return sendJson(401, { error: 'Unauthorized.' });
  }

  if (req.method === 'GET' && path === '/api/codex/models') {
    return sendJson(200, STATIC_CODEX_MODELS);
  }

  if (req.method === 'GET' && path === '/api/xai/models') {
    return sendJson(200, STATIC_XAI_MODELS);
  }

  if (req.method === 'POST' && path === '/api/xai/oauth') {
    const target = req.headers['x-xai-oauth-target'];
    if (!target || !ALLOWED_XAI_OAUTH_PATHS.has(target)) {
      return sendJson(400, {
        error: 'Missing or invalid x-xai-oauth-target header.'
      });
    }
    // Same upstream hygiene as the streaming branch: abort the auth.x.ai
    // fetch when the *client* disconnects (res 'close', not req — see the
    // streaming branch for why), plus an overall timeout so a hung upstream
    // cannot hold the request and socket open indefinitely.
    const controller = new AbortController();
    let oauthTimedOut = false;
    const oauthTimeout = setTimeout(() => {
      oauthTimedOut = true;
      controller.abort();
    }, oauthUpstreamTimeoutMs);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const upstream = await fetchImpl(`${XAI_OAUTH_BASE}${target}`, {
        method: 'POST',
        headers: pickHeaders(req, ['content-type', 'accept']),
        body: Readable.toWeb(req),
        duplex: 'half',
        signal: controller.signal
      });
      const body = await upstream.text();
      clearTimeout(oauthTimeout);
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        res.setHeader(name, value);
      }
      res.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache'
      });
      res.end(body);
    } catch (error) {
      clearTimeout(oauthTimeout);
      logError(
        oauthTimedOut
          ? '[bridge] xai oauth upstream timed out'
          : '[bridge] xai oauth upstream failed',
        error
      );
      // Client already gone (or response otherwise finished) — nothing to
      // answer, and writing to a destroyed socket must not throw here.
      if (res.destroyed || res.writableEnded) return;
      return sendJson(502, {
        error: 'The upstream provider is temporarily unavailable.'
      });
    }
    return;
  }

  const streamingTarget =
    req.method === 'POST' && path === '/api/codex/responses'
      ? {
          upstream: UPSTREAM_CODEX_RESPONSES,
          headers: pickHeaders(req, [
            'authorization',
            'content-type',
            'accept',
            'chatgpt-account-id',
            'x-openai-fedramp'
          ])
        }
      : req.method === 'POST' && path === '/api/xai/responses'
        ? {
            upstream: UPSTREAM_XAI_RESPONSES,
            headers: pickHeaders(req, [
              'authorization',
              'content-type',
              'accept'
            ])
          }
        : null;

  if (streamingTarget) {
    const controller = new AbortController();
    let streamIdleTimer;
    let streamTimedOut = false;
    const resetStreamIdleTimer = () => {
      if (streamIdleTimer) clearTimeout(streamIdleTimer);
      streamIdleTimer = setTimeout(() => {
        streamTimedOut = true;
        controller.abort();
      }, streamIdleTimeoutMs);
    };
    // Abort the upstream only when the *client* disconnects (the response
    // socket closes before the response finished). Node's IncomingMessage
    // 'close' fires as soon as the request body has been fully consumed,
    // which would abort every streaming upstream right after the POST body
    // is forwarded (returning 502 for every real request).
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    resetStreamIdleTimer();
    try {
      const upstream = await fetchImpl(streamingTarget.upstream, {
        method: 'POST',
        headers: streamingTarget.headers,
        body: Readable.toWeb(req),
        duplex: 'half',
        signal: controller.signal
      });
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        res.setHeader(name, value);
      }
      res.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') || 'text/event-stream',
        'cache-control': 'no-cache'
      });
      if (!upstream.body) {
        clearTimeout(streamIdleTimer);
        res.end();
        return;
      }
      // Pump with backpressure via for-await (requests the next upstream
      // chunk only after the current one is written, and waits for 'drain'
      // when the client socket is slow). A pipe() would work too, but its
      // internal error handler destroys `res` on an upstream error BEFORE
      // our listener could write an SSE error frame — this pump keeps the
      // error path fully ours.
      const upstreamStream = Readable.fromWeb(upstream.body);
      const pump = async () => {
        for await (const chunk of upstreamStream) {
          if (res.destroyed || res.writableEnded) break;
          resetStreamIdleTimer();
          if (!res.write(chunk)) {
            clearTimeout(streamIdleTimer);
            // Backpressure: wait for the socket to drain. A disconnected
            // client never drains, so race the wait against 'close' — a
            // bare 'drain'-only wait would suspend the pump forever (the
            // old pipe() cleaned up via its own dest-close handling).
            await new Promise((resolve) => {
              const done = () => {
                res.removeListener('drain', done);
                res.removeListener('close', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
            });
            if (res.destroyed || res.writableEnded) break;
            resetStreamIdleTimer();
          }
        }
        clearTimeout(streamIdleTimer);
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      pump().catch((pumpError) => {
        clearTimeout(streamIdleTimer);
        logError('[bridge] upstream stream interrupted', pumpError);
        // Headers are already sent by now (writeHead ran before the pump), so
        // a JSON 502 is impossible — the SSE error frame is the last chance
        // to tell the client why the stream ended.
        writeSseErrorFrame(
          res,
          streamTimedOut
            ? 'The upstream provider stream was idle for too long and was aborted.'
            : `The upstream provider stream was interrupted mid-response${sseErrorDetail(pumpError)}.`
        );
      });
    } catch (error) {
      clearTimeout(streamIdleTimer);
      logError('[bridge] upstream request failed', error);
      if (!res.headersSent) {
        return sendJson(502, {
          error: 'The upstream provider is temporarily unavailable.'
        });
      }
      writeSseErrorFrame(res, 'The upstream provider stream was interrupted.');
    }
    return;
  }

  return sendJson(404, { error: 'Not found.' });
}

/**
 * Create the bridge http.Server. Caller is responsible for
 * `server.listen(port, '127.0.0.1')` (and for choosing a free port).
 */
/** @typedef {{ token?: string, fetchImpl?: typeof fetch, log?: object,
 * version?: string, port?: number, streamIdleTimeoutMs?: number,
 * oauthUpstreamTimeoutMs?: number }} BridgeServerOptions */
/** @param {BridgeServerOptions} options */
export function createBridgeServer(options = {}) {
  const deps = {
    token: options.token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log: options.log ?? console,
    version: options.version ?? BRIDGE_VERSION,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    oauthUpstreamTimeoutMs:
      options.oauthUpstreamTimeoutMs ?? OAUTH_UPSTREAM_TIMEOUT_MS,
    ...(typeof options.port === 'number' ? { port: options.port } : {})
  };

  const server = http.createServer((req, res) => {
    handleBridgeRequest(req, res, deps).catch((error) => {
      const logError =
        deps.log && typeof deps.log.error === 'function'
          ? deps.log.error.bind(deps.log)
          : () => {};
      logError('[bridge] unhandled request error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal bridge error.' }));
      } else {
        res.destroy();
      }
    });
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * Bind a bridge server, retrying on consecutive ports when the requested one
 * is taken (EADDRINUSE). This is the retry walk used by the Electron shell
 * (desktop/src/main.mjs); it lives here — not in main.mjs — so it is unit
 * testable without Electron (main.mjs imports Electron, this module does
 * not).
 *
 * The walk covers `requestedPort..maxPort`. Callers must keep both inside the
 * site's CSP-allowlisted bridge range (DEFAULT_PORT ..
 * DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1, see
 * src/lib/server/hooks/handlers/security-headers.ts): a bridge bound outside
 * it is unreachable from the web app. main.mjs clamps its env override into
 * that range before calling, and /health reports the actually-bound port from
 * the accepted connection's socket, so a walk to a later port never leaves
 * the health endpoint lying about which port the bridge is on.
 *
 * Listener hygiene: the per-attempt 'error' listener is removed on both the
 * success and failure paths, so a long walk cannot accumulate one listener
 * per attempt.
 *
 * Returns the bound port. On failure the server is closed (never left in a
 * half-bound state) and an Error is thrown — EADDRINUSE exhaustion throws a
 * descriptive "no free port" error, any other listen error rethrows
 * unchanged.
 */
export async function listenBridgeServer(server, options = {}) {
  const {
    requestedPort = DEFAULT_PORT,
    maxPort = DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1,
    host = '127.0.0.1'
  } = options;
  for (let port = requestedPort; port <= maxPort; port += 1) {
    try {
      await new Promise((resolve, reject) => {
        // Named handler so it is removed on both paths; `server.once('error',
        // reject)` in a loop would accumulate one listener per attempt.
        const onError = (error) => {
          server.removeListener('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      return port;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        server.close(() => {});
        throw error;
      }
    }
  }
  // Every candidate port was taken. Never report "listening" — throw so the
  // caller can alert the user instead of leaving a dead bridge wired up with
  // a bogus port.
  server.close(() => {});
  throw new Error(
    `no free port between ${requestedPort} and ${maxPort} in the CSP-allowlisted range ` +
      `${DEFAULT_PORT}–${DEFAULT_PORT + BRIDGE_PORT_ATTEMPTS - 1}: they are all in use. ` +
      'Close the conflicting process or relaunch with TIF1AI_BRIDGE_PORT set to a free port in that range.'
  );
}
