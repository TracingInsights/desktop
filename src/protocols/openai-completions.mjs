/**
 * OpenAI chat-completions protocol adapter (`/v1/chat/completions`).
 *
 * Speaks the OpenAI-compatible chat-completions shape used by Ollama's `/v1`
 * shim, LM Studio, vLLM, llama.cpp, and hosted OpenAI-compatible endpoints
 * (Fireworks, Together, DeepInfra, Featherless, …).
 *
 * Structured output: `response_format: { type: 'json_schema', json_schema }`
 * with a strip-and-retry ladder (json_schema → json_object → no
 * response_format) before surfacing `structured_output_unsupported`. Reasoning
 * extras (`reasoning_effort`, `chat_template_kwargs.enable_thinking`,
 * `thinking`) are tried in order and stripped on a 400/422 that rejects them.
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
import {
  VisibleContentFilter,
  completionsMaxTokens,
  completionsReasoningAttempts,
  parseCompletionsPayloads,
  reasoningFieldsPresent,
  reasoningFromDelta,
  reasoningFromMessage,
  stripThinkBlocks,
  textFromDelta,
  textFromMessage
} from './completions-text.mjs';

const PROTOCOL = 'openai-completions';

function networkError(message) {
  const err = new Error(message);
  err.code = 'network';
  return err;
}

function resultFromMessage(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message ?? {};
  const visible = stripThinkBlocks(textFromMessage(message));
  // Some hosts put the entire completion in reasoning_content and leave
  // content empty. Prefer visible content; fall back only when there is none.
  const text = visible || stripThinkBlocks(reasoningFromMessage(message));
  return {
    text,
    usage: normalizeUsage(PROTOCOL, payload?.usage),
    finishReason: normalizeFinishReason(PROTOCOL, choice?.finish_reason)
  };
}

function consumePayload(
  payload,
  { onDelta, onReasoning, filter, firstToken, clearFirst }
) {
  if (payload?.error) {
    throw new Error(payload.error.message ?? 'Provider stream error.');
  }
  const choice = payload?.choices?.[0];
  const delta = choice?.delta ?? {};
  const reasoning = reasoningFromDelta(delta);
  const raw = textFromDelta(delta);
  if ((reasoning || raw) && firstToken.current) {
    firstToken.current = false;
    clearFirst();
  }
  if (reasoning) onReasoning?.(reasoning);
  if (raw) {
    const visible = filter.feed(raw);
    if (visible) onDelta?.(visible);
  }
  return {
    finishReason: choice?.finish_reason
      ? normalizeFinishReason(PROTOCOL, choice.finish_reason)
      : undefined,
    usage: payload?.usage ? normalizeUsage(PROTOCOL, payload.usage) : undefined
  };
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
  // Timeouts live in a private controller combined with the caller's signal,
  // so either an explicit abort(requestId) or an internal expiry tears the
  // fetch down. A timeout aborts with a sentinel Error to distinguish it from
  // a user abort (the caller's signal may carry its own abort reason).
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
      headers: {
        'content-type': 'application/json',
        accept: stream
          ? 'text/event-stream, application/json'
          : 'application/json',
        ...headers
      },
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

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const looksLikeSse = contentType.includes('text/event-stream');

    if (
      !stream ||
      (!looksLikeSse && contentType.includes('application/json'))
    ) {
      const payload = await response.json();
      if (payload?.error) {
        const err = new Error(payload.error.message ?? 'Provider error.');
        err.status = response.status;
        throw err;
      }
      const result = resultFromMessage(payload);
      if (stream && result.text) onDelta?.(result.text);
      return result;
    }

    const filter = new VisibleContentFilter();
    const firstToken = { current: true };
    let usage;
    let finishReason = 'stop';
    let text = '';
    // Reasoning deltas are tracked separately so that hosts which put the
    // entire completion in reasoning_content (see resultFromMessage) get the
    // same fallback in the streaming path instead of an empty answer.
    let reasoningText = '';
    const trackedOnDelta = (delta) => {
      text += delta;
      onDelta?.(delta);
    };
    const trackedConsume = {
      onDelta: trackedOnDelta,
      onReasoning: (delta) => {
        reasoningText += delta;
      },
      filter,
      firstToken,
      clearFirst
    };

    const flushingTail = () => {
      const tail = filter.flush();
      if (tail) {
        text += tail;
        onDelta?.(tail);
      }
      // Board-level fallback, mirroring resultFromMessage: only when no
      // visible content streamed at all, fall back to the reasoning text.
      if (!text && reasoningText) {
        const fallback = stripThinkBlocks(reasoningText);
        if (fallback) {
          text += fallback;
          onDelta?.(fallback);
        }
      }
      return { text, usage, finishReason };
    };

    const applyFramesTracked = (frames) => {
      for (const frame of frames) {
        for (const payload of parseCompletionsPayloads(frame.data)) {
          const next = consumePayload(payload, trackedConsume);
          if (next.finishReason) finishReason = next.finishReason;
          if (next.usage) usage = next.usage;
        }
        armIdle();
      }
    };

    if (!looksLikeSse) {
      // Missing/odd Content-Type: the body may still be SSE bytes.
      const raw = await response.text();
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let payload;
        try {
          payload = JSON.parse(trimmed);
        } catch {
          payload = null;
        }
        if (payload && (payload.choices || payload.error)) {
          if (payload.error) {
            throw new Error(payload.error.message ?? 'Provider error.');
          }
          const result = resultFromMessage(payload);
          if (result.text) onDelta?.(result.text);
          return result;
        }
      }
      const sse = new SseDecoder();
      applyFramesTracked(sse.feed(raw).concat(sse.flush()));
      return flushingTail();
    }

    if (!response.body) {
      throw new Error('Provider returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        applyFramesTracked(sse.feed(decoder.decode(value, { stream: true })));
      }
      applyFramesTracked(sse.flush());
      return flushingTail();
    } catch (error) {
      // A timeout abort surfaces as a network error; a user abort stays aborted.
      if (error?.code === 'network') throw error;
      throw error;
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(idleTimer);
    clearFirst();
  }
}

/**
 * Run a chat-completions request with the structured-output + reasoning
 * strip-and-retry ladder. Returns `{ ok: true, text, usage, finishReason, model }`
 * or `{ ok: false, error }`.
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
  const url = `${baseUrl}/chat/completions`;

  const formatLevels = jsonSchema
    ? [
        { type: 'json_schema', json_schema: jsonSchema },
        { type: 'json_object' },
        undefined
      ]
    : [undefined];

  const reasoningAttempts = completionsReasoningAttempts({
    reasoning,
    modelReasoning
  });
  const thinkingRequested = reasoningAttempts.some(reasoningFieldsPresent);
  const maxTokens = completionsMaxTokens(maxOutputTokens, thinkingRequested);

  for (let level = 0; level < formatLevels.length; level += 1) {
    const format = formatLevels[level];
    for (let r = 0; r < reasoningAttempts.length; r += 1) {
      const extras = reasoningAttempts[r];
      const body = {
        model,
        messages,
        stream,
        ...(format ? { response_format: format } : {}),
        ...extras,
        ...(maxTokens ? { max_tokens: maxTokens } : {})
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
          return inferenceError('network', {
            providerMessage: error.message
          });
        }
        if (error?.code === 'invalid_request') {
          return inferenceError('invalid_request', {
            providerMessage: error.message
          });
        }
        const status = error?.status;
        const message = error instanceof Error ? error.message : String(error);

        // Reasoning extras rejected → try the next extras shape.
        if (
          reasoningFieldsPresent(extras) &&
          isReasoningParamError(status, message)
        ) {
          continue;
        }

        // Structured-output rejection → step down the format ladder.
        if (format && isStructuredOutputError(status, message)) {
          break; // advance to the next format level
        }

        // Last format rung already tried → surface the capability error.
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

  // Unreachable in practice (the loop always returns), kept for clarity.
  return inferenceError('invalid_request', {
    providerMessage: 'No response from provider.'
  });
}
