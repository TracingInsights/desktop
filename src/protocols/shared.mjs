/**
 * Shared helpers for the desktop inference protocol adapters
 * (openai-completions / openai-responses / anthropic-messages).
 *
 * Owns the pieces every adapter needs:
 *  - target validation (loopback http allowed; remote https only) + manual
 *    redirect re-validation (D4 / §7.3 redirect handling)
 *  - baseUrl normalization (strip trailing slashes; append /v1 once)
 *  - the strip-and-retry ladder helpers (structured-output + reasoning params)
 *  - timeout constants + usage/finishReason normalization into the AI SDK shape
 *  - error → InferenceError envelope mapping
 */

// ---------------------------------------------------------------------------
// Timeouts (configurable via env for Ollama cold model loads etc.)
// ---------------------------------------------------------------------------

/** Generous connect/first-token timeout — Ollama cold loads can take minutes. */
export const MODEL_LOAD_GRACE_MS = readPositiveInt(
  process.env.TIF1AI_MODEL_LOAD_GRACE_MS,
  600_000
);

/** Idle watchdog: no bytes since the last chunk → abort the stream. */
export const STREAM_IDLE_TIMEOUT_MS = readPositiveInt(
  process.env.TIF1AI_STREAM_IDLE_TIMEOUT_MS,
  300_000
);

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Target validation (D4)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function bareHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(bareHost(hostname));
}

/**
 * A target host is allowed when it is loopback over http, or remote over https
 * only (plain-http LAN hosts are excluded by design — D4 scope note).
 */
export function isAllowedTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return isLoopbackHost(parsed.hostname);
}

/**
 * Normalize a user-entered base URL: strip trailing slashes, and if the
 * resulting path is empty or `/`, append `/v1` once. A non-empty path is used
 * verbatim (never a second `/v1`).
 */
export function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname;
  if (path === '' || path === '/') {
    url = `${parsed.origin}/v1`;
  }
  return url.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Strip-and-retry detection helpers
// ---------------------------------------------------------------------------

function errorText(body) {
  if (typeof body === 'string') return body.toLowerCase();
  try {
    return JSON.stringify(body).toLowerCase();
  } catch {
    return String(body ?? '').toLowerCase();
  }
}

/** 400/422 whose body complains about an unknown/unsupported parameter. */
export function isUnsupportedParamError(status, body) {
  if (status !== 400 && status !== 422) return false;
  const text = errorText(body);
  return /unknown|unsupported|not supported|invalid.*parameter|unexpected.*(?:argument|keyword)|extra.*(?:keyword|field)|additional properties|does not support|not accept/i.test(
    text
  );
}

/** 400/422 whose body rejects a reasoning/thinking-related param. */
export function isReasoningParamError(status, body) {
  if (status !== 400 && status !== 422) return false;
  const text = errorText(body);
  return (
    /reasoning|thinking|chat_template_kwargs|enable_thinking|do_reasoning/.test(
      text
    ) && isUnsupportedParamError(status, body)
  );
}

/** Structured-output (response_format / json_schema / tools) rejection. */
export function isStructuredOutputError(status, body) {
  if (status === 422) return true;
  if (status !== 400) return false;
  const text = errorText(body);
  return (
    /response_format|json_schema|structured.?output|json_object|tool_choice|tools/.test(
      text
    ) || text.includes('strict')
  );
}

// ---------------------------------------------------------------------------
// InferenceError envelope helpers
// ---------------------------------------------------------------------------

export function inferenceError(code, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.providerMessage
        ? { providerMessage: String(extra.providerMessage).slice(0, 500) }
        : {})
    }
  };
}

export function okResult(value) {
  return { ok: true, ...value };
}

/** Extract a short, sanitized upstream message from an HTTP error response. */
export async function readErrorMessage(response, fallback) {
  try {
    const text = await response.text();
    if (!text) return fallback;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.slice(0, 500) || fallback;
    }
    const message =
      parsed?.error?.message ??
      parsed?.message ??
      (typeof parsed?.error === 'string' ? parsed.error : undefined);
    return (message ? String(message) : text).slice(0, 500) || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Reasoning level mapping
// ---------------------------------------------------------------------------

/**
 * Map the portable ReasoningLevel to `reasoning_effort` / `reasoning.effort`.
 * 'provider-default' → undefined (omit the param).
 */
export function mapReasoningEffort(level) {
  if (!level || level === 'provider-default') return undefined;
  switch (level) {
    case 'none':
      return 'none';
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    default:
      return undefined;
  }
}

/**
 * Anthropic `thinking` budget from the portable level. Returns undefined when
 * no thinking should be requested (provider-default → omit; none → disabled
 * is expressed by the adapter omitting the field).
 */
export function mapAnthropicThinking(level) {
  if (!level || level === 'provider-default' || level === 'none') {
    return undefined;
  }
  switch (level) {
    case 'minimal':
    case 'low':
      return { type: 'enabled', budget_tokens: 1024 };
    case 'medium':
      return { type: 'enabled', budget_tokens: 2048 };
    case 'high':
    case 'xhigh':
      return { type: 'enabled', budget_tokens: 4096 };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// finishReason / usage normalization (AI SDK shape)
// ---------------------------------------------------------------------------

function normalizeFinish(protocol, raw) {
  if (protocol === 'anthropic-messages') {
    switch (raw) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool-calls';
      default:
        return 'stop';
    }
  }
  if (protocol === 'openai-responses') {
    switch (raw) {
      case 'completed':
        return 'stop';
      case 'incomplete':
        return 'length';
      case 'failed':
        return 'error';
      default:
        return 'stop';
    }
  }
  // openai-completions
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'stop';
  }
}

function usageFromCompletions(usage) {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const details = usage.prompt_tokens_details ?? {};
  const outDetails = usage.completion_tokens_details ?? {};
  const normalized = {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens
  };
  const inputDetails = {};
  if (typeof details.cached_tokens === 'number')
    inputDetails.cacheReadTokens = details.cached_tokens;
  if (Object.keys(inputDetails).length > 0) {
    normalized.inputTokenDetails = inputDetails;
  }
  const outputDetails = {};
  if (typeof outDetails.reasoning_tokens === 'number')
    outputDetails.reasoningTokens = outDetails.reasoning_tokens;
  if (typeof outDetails.text_tokens === 'number')
    outputDetails.textTokens = outDetails.text_tokens;
  if (Object.keys(outputDetails).length > 0) {
    normalized.outputTokenDetails = outputDetails;
  }
  return normalized;
}

function usageFromResponses(usage) {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const normalized = {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens
  };
  const inDetails = usage.input_tokens_details;
  if (inDetails && typeof inDetails === 'object') {
    const d = {};
    if (typeof inDetails.cache_read_tokens === 'number')
      d.cacheReadTokens = inDetails.cache_read_tokens;
    if (typeof inDetails.cache_write_tokens === 'number')
      d.cacheWriteTokens = inDetails.cache_write_tokens;
    if (typeof inDetails.no_cache_tokens === 'number')
      d.noCacheTokens = inDetails.no_cache_tokens;
    if (Object.keys(d).length > 0) normalized.inputTokenDetails = d;
  }
  const outDetails = usage.output_tokens_details;
  if (outDetails && typeof outDetails === 'object') {
    const d = {};
    if (typeof outDetails.reasoning_tokens === 'number')
      d.reasoningTokens = outDetails.reasoning_tokens;
    if (typeof outDetails.text_tokens === 'number')
      d.textTokens = outDetails.text_tokens;
    if (Object.keys(d).length > 0) normalized.outputTokenDetails = d;
  }
  return normalized;
}

function usageFromAnthropic(usage) {
  if (!usage) return undefined;
  // Messages' input_tokens leaves out cache reads and writes; the AI SDK's
  // inputTokens is the whole prompt (the website's context check compares
  // it with what was sent).
  const uncached = usage.input_tokens ?? 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : undefined;
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === 'number'
      ? usage.cache_creation_input_tokens
      : undefined;
  const inputTokens = uncached + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  const normalized = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
  const inputDetails = {};
  if (cacheRead !== undefined) inputDetails.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) inputDetails.cacheWriteTokens = cacheWrite;
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    inputDetails.noCacheTokens = uncached;
  }
  if (Object.keys(inputDetails).length > 0) {
    normalized.inputTokenDetails = inputDetails;
  }
  return normalized;
}

/** Normalize a provider usage object into the AI SDK shape. */
export function normalizeUsage(protocol, usage) {
  if (protocol === 'anthropic-messages') return usageFromAnthropic(usage);
  if (protocol === 'openai-responses') return usageFromResponses(usage);
  return usageFromCompletions(usage);
}

/** Normalize a provider finish signal into the AI SDK finish-reason string. */
export function normalizeFinishReason(protocol, raw) {
  return normalizeFinish(protocol, raw);
}

// ---------------------------------------------------------------------------
// Redirect re-validation (§7.3)
// ---------------------------------------------------------------------------

/**
 * Build fetch init for an adapter request with `redirect: 'manual'`. A helper
 * so every adapter re-validates any redirect Location against the loopback /
 * https rule before following it (native fetch would otherwise follow a
 * `https → http://169.254.169.254` hop and moot D4 validation).
 */
export async function fetchWithValidatedRedirects(
  fetchImpl,
  url,
  init,
  redirectsRemaining = 3
) {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (
    (response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308) &&
    redirectsRemaining > 0
  ) {
    const location = response.headers.get('location');
    if (location) {
      let target;
      try {
        target = new URL(location, url).href;
      } catch {
        throw redirectError(location);
      }
      if (!isAllowedTarget(target)) {
        throw redirectError(target);
      }
      return fetchWithValidatedRedirects(
        fetchImpl,
        target,
        init,
        redirectsRemaining - 1
      );
    }
  }
  return response;
}

function redirectError(target) {
  const err = new Error(`Disallowed redirect target: ${target}`);
  err.code = 'invalid_request';
  return err;
}

// ---------------------------------------------------------------------------
// SSE frame decoding (shared by all three streaming adapters)
// ---------------------------------------------------------------------------

/**
 * Incremental Server-Sent-Events frame splitter. Feed raw bytes/chunks; each
 * call returns the completed `{ event, data }` frames found so far (a trailing
 * partial frame stays buffered). Tolerant of `\r\n` / lone `\r` and keepalive
 * comments.
 */
export class SseDecoder {
  #buffer = '';

  feed(chunk) {
    const frames = [];
    let text = this.#buffer + String(chunk);
    // A trailing \r may be the first half of a \r\n split across chunks;
    // normalising it now would yield two line breaks (a spurious blank line
    // that ends the frame early and drops its `event:` name). Hold it back.
    const heldCr = text.endsWith('\r');
    if (heldCr) text = text.slice(0, -1);
    this.#buffer = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = this.#buffer.split('\n\n');
    this.#buffer = (blocks.pop() ?? '') + (heldCr ? '\r' : '');
    for (const block of blocks) {
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:'))
          dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      const data = dataLines.join('\n');
      if (data && data !== '[DONE]') frames.push({ event, data });
    }
    return frames;
  }

  /** Flush any trailing (terminator-less) frame — used at stream end. */
  flush() {
    const rest = this.#buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.#buffer = '';
    if (!rest.trim()) return [];
    let event = 'message';
    const dataLines = [];
    for (const line of rest.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:'))
        dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    return data && data !== '[DONE]' ? [{ event, data }] : [];
  }
}
