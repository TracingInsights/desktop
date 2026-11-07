/**
 * OpenAI Responses protocol adapter (`/v1/responses`).
 *
 * Speaks the Responses API shape used by ChatGPT Codex and Grok/xAI (both are
 * Responses API upstreams) and by hosted OpenAI-compatible Responses
 * endpoints. `codex-inference.mjs` and `xai-inference.mjs` reuse this module
 * rather than carrying their own SSE parser.
 *
 * Structured output: `text: { format: { type: 'json_schema', name, strict,
 * schema } }` with a strip-and-retry ladder (json_schema → json_object → no
 * `text.format`) before surfacing `structured_output_unsupported`. The
 * reasoning param (`reasoning.effort`) is stripped and retried once on a 400
 * that rejects it.
 *
 * Streaming events (verified against the OpenAI reference):
 *   response.output_text.delta → { delta }
 *   response.output_text.done  → { text }
 *   response.completed         → { response: { status, usage, output } }
 *   response.incomplete        → { response: { incomplete_details } }
 *   response.failed            → { response: { error } }
 */
import {
  SseDecoder,
  fetchWithValidatedRedirects,
  inferenceError,
  isReasoningParamError,
  isStructuredOutputError,
  normalizeFinishReason,
  normalizeUsage,
  readErrorMessage
} from './shared.mjs';

const PROTOCOL = 'openai-responses';

function networkError(message) {
  const err = new Error(message);
  err.code = 'network';
  return err;
}

/** Map the portable ReasoningLevel to a Responses `reasoning.effort`. */
function mapResponsesEffort(level) {
  if (!level || level === 'provider-default' || level === 'none') {
    return undefined;
  }
  switch (level) {
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

/** Concatenate text from a Responses `output` array (message items). */
function textFromOutput(output) {
  if (!Array.isArray(output)) return '';
  const parts = [];
  for (const item of output) {
    if (typeof item?.content === 'string') {
      parts.push(item.content);
      continue;
    }
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

/** One HTTP round-trip at a given format + reasoning configuration. */
async function callOnce({
  fetchImpl,
  url,
  headers,
  body,
  stream,
  onDelta,
  signal,
  idleTimeoutMs,
  firstTokenTimeoutMs
}) {
  const timeoutController = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  let idleTimer;
  let firstTokenTimer;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    // The first-token grace governs until the first token arrives.
    if (firstTokenTimer) return;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(
      () =>
        timeoutController.abort(
          networkError('Provider stream was idle for too long.')
        ),
      idleTimeoutMs
    );
  };
  const armFirstToken = () => {
    if (!Number.isFinite(firstTokenTimeoutMs) || firstTokenTimeoutMs <= 0)
      return;
    firstTokenTimer = setTimeout(
      () =>
        timeoutController.abort(
          networkError('Timed out waiting for the first token.')
        ),
      firstTokenTimeoutMs
    );
  };
  const clearFirst = () => {
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    firstTokenTimer = null;
  };

  // Watchdogs: the first-token grace (model cold-load) is armed BEFORE the
  // request, so a hung connect / header wait / blocking (non-stream) call is
  // bounded too. The idle watchdog only takes over once the first token has
  // arrived — arming both at stream start let the shorter idle timeout fire
  // during a legitimate cold load and pre-empt the grace period.
  armFirstToken();
  try {
    const response = await fetchWithValidatedRedirects(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combined
    });

    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        'Provider request failed.'
      );
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }

    if (!stream) {
      const payload = await response.json();
      if (payload?.error) {
        const err = new Error(
          payload.error.message ?? 'Provider stream error.'
        );
        err.status = response.status;
        throw err;
      }
      const text =
        typeof payload?.output_text === 'string'
          ? payload.output_text
          : textFromOutput(payload?.output);
      const finishReason = normalizeFinishReason(PROTOCOL, payload?.status);
      return {
        text,
        usage: normalizeUsage(PROTOCOL, payload?.usage),
        finishReason
      };
    }

    if (!response.body) {
      throw new Error('Provider returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    let text = '';
    let usage;
    let finishReason = 'stop';
    let firstToken = true;

    // Text streamed so far per content part (output_index:content_index).
    // `.done` must be reconciled against its own part — comparing it with the
    // whole accumulated text replaced every earlier part with the last one.
    const partText = new Map();
    const partKey = (payload) =>
      `${String(payload?.output_index ?? 0)}:${String(payload?.content_index ?? 0)}`;
    const emit = (delta) => {
      if (!delta) return;
      if (firstToken) {
        firstToken = false;
        clearFirst();
      }
      text += delta;
      onDelta?.(delta);
    };

    const handleFrame = (frame) => {
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        return;
      }
      const type = payload?.type;
      if (type === 'response.output_text.delta') {
        const delta = payload.delta;
        if (typeof delta === 'string' && delta) {
          const key = partKey(payload);
          partText.set(key, (partText.get(key) ?? '') + delta);
          emit(delta);
        }
      } else if (type === 'response.output_text.done') {
        // `.done` is the authoritative full text for the part; deltas should
        // have reconstructed it, but reconcile when they diverge (e.g. a
        // provider that only emits `.done`, or dropped trailing deltas).
        if (typeof payload.text === 'string') {
          const key = partKey(payload);
          const seen = partText.get(key) ?? '';
          if (payload.text !== seen && payload.text.startsWith(seen)) {
            emit(payload.text.slice(seen.length));
          }
          partText.set(key, payload.text);
        }
      } else if (
        type === 'response.completed' ||
        type === 'response.incomplete'
      ) {
        const resp = payload.response ?? {};
        if (resp.usage) usage = normalizeUsage(PROTOCOL, resp.usage);
        if (resp.status) {
          finishReason = normalizeFinishReason(PROTOCOL, resp.status);
        } else if (resp.incomplete_details) {
          finishReason = 'length';
        }
        // Non-incremental gateways: nothing streamed, final output only here.
        if (!text) emit(textFromOutput(resp.output));
      } else if (type === 'response.failed') {
        const message =
          payload.response?.error?.message ?? 'Provider stream error.';
        throw new Error(message);
      } else if (type === 'error') {
        // Top-level stream error event ({type:'error', code, message}) — was
        // ignored, so the run "succeeded" with an empty/truncated answer.
        const message =
          (typeof payload.message === 'string' && payload.message) ||
          payload.error?.message ||
          'Provider stream error.';
        throw new Error(message);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const frames = sse.feed(decoder.decode(value, { stream: true }));
        for (const frame of frames) handleFrame(frame);
        armIdle();
      }
      for (const frame of sse.flush()) handleFrame(frame);
      return { text, usage, finishReason };
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(idleTimer);
    clearFirst();
  }
}

/**
 * Run a Responses request against an already-resolved `input` array with the
 * structured-output + reasoning strip-and-retry ladder. Exported separately
 * so the Codex/xAI inference adapters can reuse the SSE parser with their own
 * provider-specific `input` shape and headers.
 */
export async function runResponses({
  url,
  headers = {},
  model,
  input,
  jsonSchema,
  reasoning,
  modelReasoning = false,
  maxOutputTokens,
  stream = false,
  onDelta,
  signal,
  fetchImpl = globalThis.fetch,
  idleTimeoutMs,
  firstTokenTimeoutMs,
  bodyExtra = {}
}) {
  const formatLevels = jsonSchema
    ? [
        {
          type: 'json_schema',
          name: jsonSchema.name,
          strict: jsonSchema.strict,
          schema: jsonSchema.schema
        },
        { type: 'json_object' },
        undefined
      ]
    : [undefined];

  const effort =
    mapResponsesEffort(reasoning) ??
    (modelReasoning && reasoning !== 'none' ? 'medium' : undefined);

  for (let level = 0; level < formatLevels.length; level += 1) {
    const format = formatLevels[level];
    for (
      let reasoningAttempt = 0;
      reasoningAttempt < 2;
      reasoningAttempt += 1
    ) {
      const includeReasoning = effort !== undefined && reasoningAttempt === 0;
      const body = {
        model,
        input,
        stream,
        ...(format ? { text: { format } } : {}),
        ...(includeReasoning ? { reasoning: { effort } } : {}),
        // Optional on Responses: omitted, the model's own maximum applies.
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
        ...bodyExtra
      };
      try {
        const result = await callOnce({
          fetchImpl,
          url,
          headers,
          body,
          stream,
          onDelta,
          signal,
          idleTimeoutMs,
          firstTokenTimeoutMs
        });
        return { ok: true, ...result, model };
      } catch (error) {
        if (signal?.aborted) {
          return inferenceError('aborted');
        }
        if (error?.code === 'network') {
          return inferenceError('network', { providerMessage: error.message });
        }
        if (error?.code === 'invalid_request') {
          return inferenceError('invalid_request', {
            providerMessage: error.message
          });
        }
        const status = error?.status;
        const message = error instanceof Error ? error.message : String(error);

        if (includeReasoning && isReasoningParamError(status, message)) {
          continue;
        }
        if (format && isStructuredOutputError(status, message)) {
          break; // advance to the next format level
        }
        if (level === formatLevels.length - 1 && format) {
          return inferenceError('structured_output_unsupported', {
            status,
            providerMessage: message
          });
        }
        return inferenceError('http_error', {
          status,
          providerMessage: message
        });
      }
    }
  }

  return inferenceError('invalid_request', {
    providerMessage: 'No response from provider.'
  });
}

/**
 * Run a Responses request from an OpenAI-style `messages[]` payload.
 * `messages` → `input` mapping is the plain `{ role, content }` passthrough.
 */
export async function run({
  baseUrl,
  headers = {},
  model,
  messages,
  jsonSchema,
  reasoning,
  modelReasoning = false,
  maxOutputTokens,
  stream = false,
  onDelta,
  signal,
  fetchImpl = globalThis.fetch,
  idleTimeoutMs,
  firstTokenTimeoutMs
}) {
  return runResponses({
    url: `${baseUrl}/responses`,
    headers,
    model,
    input: Array.isArray(messages) ? messages : [],
    jsonSchema,
    reasoning,
    modelReasoning,
    maxOutputTokens,
    stream,
    onDelta,
    signal,
    fetchImpl,
    idleTimeoutMs,
    firstTokenTimeoutMs
  });
}
