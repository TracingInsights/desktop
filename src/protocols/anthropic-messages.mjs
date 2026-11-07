/**
 * Anthropic Messages protocol adapter (`/v1/messages`).
 *
 * Speaks the Anthropic Messages API shape. Structured output: JSON outputs
 * (`output_config.format`) on Claude 4.5 and later, else a single tool whose
 * `input_schema` is the plan schema and `tool_choice` forces it; endpoints
 * without either fall back to instruction-only JSON text. Thinking:
 * adaptive + `output_config.effort` on Claude 4.6 and later, `budget_tokens`
 * before (`anthropicModelTraits`), best-effort (swapped or stripped on a 400
 * that rejects it).
 *
 * Streaming events (Anthropic Messages SSE):
 *   message_start        → { message: { usage } }
 *   content_block_start  → { content_block: { type: 'text' | 'tool_use' } }
 *   content_block_delta  → { delta: { type: 'text_delta', text }
 *                                | { type: 'input_json_delta', partial_json } }
 *   message_delta        → { delta: { stop_reason }, usage }
 *   message_stop         → (end)
 */
import {
  SseDecoder,
  fetchWithValidatedRedirects,
  inferenceError,
  isUnsupportedParamError,
  normalizeFinishReason,
  normalizeUsage,
  readErrorMessage
} from './shared.mjs';
import { mapAnthropicThinking } from './shared.mjs';

const PROTOCOL = 'anthropic-messages';
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * `max_tokens` is mandatory on Messages. With no caller cap (decision 8,
 * PROMPT_OPTIMIZATION_PLAN 2026-10) send a large value: 64,000 is the output
 * maximum of the oldest Claude models still served (Haiku 4.5, Opus 4.5;
 * current models allow 128K), it sits far above every thinking budget, and
 * `max_tokens` does not count against Anthropic's output rate limits. A
 * server that allows less says so in a 400: the request is retried once.
 * Keep in sync with src/lib/ai/custom-providers/protocols/anthropic-messages.ts.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 64_000;
/** The pre-decision-8 allowance, for a "too large" 400 that names no maximum. */
const LEGACY_MAX_TOKENS = 4096;

/**
 * A 400 rejecting `max_tokens` as too large, with the maximum it names when
 * it names one (Anthropic: "max_tokens: 64000 > 8192, which is the maximum
 * allowed number of output tokens for …"); undefined for any other error.
 */
export function maxTokensRejection(status, message) {
  if ((status !== 400 && status !== 422) || !/max_tokens/i.test(message)) {
    return undefined;
  }
  const stated = /max_tokens\D{0,4}\d+\s*>\s*(\d+)/i.exec(message);
  const limit = stated ? Number(stated[1]) : NaN;
  return Number.isFinite(limit) && limit > 0 ? { limit } : {};
}

function networkError(message) {
  const err = new Error(message);
  err.code = 'network';
  return err;
}

/** Split a system message out of the OpenAI-style messages list. */
function splitSystem(messages) {
  let system;
  const rest = [];
  for (const message of messages ?? []) {
    if (message?.role === 'system') {
      system = system === undefined ? message.content : system;
      continue;
    }
    if (message?.role === 'user' || message?.role === 'assistant') {
      rest.push({
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content
      });
    }
  }
  return { system, messages: rest };
}

/**
 * Tool input for structured output. Anthropic restricts tool names to
 * `^[a-zA-Z0-9_-]{1,64}$`.
 */
function jsonTool(jsonSchema) {
  const name = 'output_json';
  return {
    name,
    description: 'Emit the result as JSON matching the provided schema.',
    input_schema:
      jsonSchema?.schema && typeof jsonSchema.schema === 'object'
        ? jsonSchema.schema
        : { type: 'object', additionalProperties: true }
  };
}

/** One HTTP round-trip at a given structured-output + thinking config. */
async function callOnce({
  fetchImpl,
  url,
  headers,
  body,
  stream,
  onDelta,
  signal,
  idleTimeoutMs,
  firstTokenTimeoutMs,
  structured
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
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
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

    if (!stream) {
      const payload = await response.json();
      if (payload?.error) {
        const err = new Error(payload.error.message ?? 'Provider error.');
        err.status = response.status;
        throw err;
      }
      const text = extractText(payload, structured);
      return {
        text,
        usage: normalizeUsage(PROTOCOL, payload?.usage),
        finishReason: normalizeFinishReason(PROTOCOL, payload?.stop_reason)
      };
    }

    if (!response.body) {
      throw new Error('Provider returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    let text = '';
    let jsonBuffer = '';
    // message_start carries input_tokens; message_delta carries the
    // (cumulative) output_tokens only. Merge the raw objects — replacing on
    // message_delta reported inputTokens: 0 for every streamed call.
    let rawUsage;
    const mergeUsage = (next) => {
      if (!next || typeof next !== 'object') return;
      rawUsage = { ...(rawUsage ?? {}), ...next };
    };
    let finishReason = 'stop';
    let firstToken = true;
    let activeBlockType = null;

    const emitDelta = (delta) => {
      if (!delta) return;
      if (firstToken) {
        firstToken = false;
        clearFirst();
      }
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
      if (type === 'message_start') {
        mergeUsage(payload.message?.usage);
      } else if (type === 'content_block_start') {
        activeBlockType = payload.content_block?.type ?? null;
        if (activeBlockType === 'tool_use') jsonBuffer = '';
      } else if (type === 'content_block_delta') {
        const delta = payload.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (structured) {
            // Freeform-JSON path (tool rejected): treat text as the JSON stream.
            text += delta.text;
            jsonBuffer += delta.text;
            emitDelta(delta.text);
          } else {
            text += delta.text;
            emitDelta(delta.text);
          }
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          jsonBuffer += delta.partial_json;
          emitDelta(delta.partial_json);
        }
      } else if (type === 'content_block_stop') {
        if (activeBlockType === 'tool_use' && structured) {
          text = jsonBuffer;
        }
        activeBlockType = null;
      } else if (type === 'message_delta') {
        if (payload.delta?.stop_reason) {
          finishReason = normalizeFinishReason(
            PROTOCOL,
            payload.delta.stop_reason
          );
        }
        mergeUsage(payload.usage);
      } else if (type === 'error') {
        throw new Error(payload.error?.message ?? 'Provider stream error.');
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
      if (structured && activeBlockType === 'tool_use') text = jsonBuffer;
      return {
        text,
        usage: normalizeUsage(PROTOCOL, rawUsage),
        finishReason
      };
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(idleTimer);
    clearFirst();
  }
}

/** Extract the assistant text (or tool-use JSON) from a non-streamed response. */
function extractText(payload, structured) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  let toolInput;
  for (const block of payload?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'tool_use' && block.input) {
      toolInput = JSON.stringify(block.input);
    }
  }
  if (structured && toolInput !== undefined) return toolInput;
  return parts.join('');
}

/**
 * What a model id says about its Messages API (checked 2026-10-31 against
 * Anthropic's docs): Claude 4.6 and later take `thinking: {type:
 * "adaptive"}` + `output_config.effort` and reject (5.x, 4.7, 4.8) or
 * deprecate (4.6) `{type: "enabled", budget_tokens}`; older Claude models
 * need the budget form. `xhigh` effort arrived with 4.7; JSON outputs
 * (`output_config.format`) with 4.5 — and 5.5 / Fable 5.1 reject the
 * forced `tool_choice` the tool route needs. Non-Claude ids on an
 * Anthropic-compatible endpoint keep the budget form first.
 */
export function anthropicModelTraits(model) {
  const named =
    /claude[-_.]?(?:opus|sonnet|haiku|fable|mythos)[-_.](\d+)(?:[-_.](\d{1,2})(?!\d))?/i.exec(
      model
    );
  if (named) {
    const major = Number(named[1]);
    const minor = named[2] ? Number(named[2]) : 0;
    const atLeast = (a, b) => major > a || (major === a && minor >= b);
    return {
      generation: atLeast(4, 6) ? 'adaptive' : 'budget',
      xhigh: atLeast(4, 7),
      jsonOutputs: atLeast(4, 5)
    };
  }
  if (/claude[-_.]\d/i.test(model)) {
    return { generation: 'budget', xhigh: false, jsonOutputs: false };
  }
  return { generation: 'other', xhigh: false, jsonOutputs: false };
}

/** `output_config.effort` for a portable level; undefined = model default. */
function anthropicEffort(level, xhigh) {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return xhigh ? 'xhigh' : 'high';
    default:
      return undefined;
  }
}

/**
 * Thinking configurations to try in order; each later one is used only
 * when the server rejects the one before it. The last is always "none".
 */
function thinkingAttempts(reasoning, modelReasoning, traits) {
  const budget = mapAnthropicThinking(reasoning)?.budget_tokens;
  const wanted =
    budget !== undefined || (modelReasoning && reasoning !== 'none');
  if (!wanted) return [{ kind: 'none' }];
  const effort = anthropicEffort(reasoning, traits.xhigh);
  const adaptive = {
    kind: 'adaptive',
    ...(effort ? { effort } : {})
  };
  const enabled = { kind: 'enabled', budget: budget ?? 2048 };
  if (traits.generation === 'adaptive') return [adaptive, { kind: 'none' }];
  if (traits.generation === 'budget') return [enabled, { kind: 'none' }];
  return [enabled, adaptive, { kind: 'none' }];
}

/** Which part of the request a 400 rejects. */
function rejectedPart(message, mode, attempt) {
  const thinking = /thinking|budget_tokens|adaptive|effort/i.test(message);
  // A bare "output_config" rejection holds the format (and any effort):
  // drop the format first, the effort with the thinking after.
  const format =
    /json_schema|format/i.test(message) ||
    (/output_config/i.test(message) && !thinking);
  if (mode === 'format' && format) return 'structured';
  if (
    mode === 'tool' &&
    /tool_choice|tools|tool use/i.test(message) &&
    !/thinking/i.test(message)
  ) {
    return 'structured';
  }
  if (attempt.kind === 'none') return 'unknown';
  if (thinking) return 'thinking';
  if (
    attempt.kind === 'adaptive' &&
    attempt.effort &&
    /output_config/i.test(message)
  ) {
    return 'thinking';
  }
  return 'unknown';
}

/**
 * Run an Anthropic Messages request with the structured-output + thinking
 * strip-and-retry ladder. Same result envelope as the other adapters.
 *
 * Structured output: JSON outputs (`output_config.format`) on Claude 4.5
 * and later, else one forced tool whose `input_schema` is the plan schema;
 * then instruction-only JSON text. Thinking: per `anthropicModelTraits`,
 * stripped (or swapped for the other form) on a 400 that rejects it.
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
  const url = `${baseUrl}/messages`;
  const { system, messages: anthropicMessages } = splitSystem(messages);
  const traits = anthropicModelTraits(model);
  const attempts = thinkingAttempts(reasoning, modelReasoning, traits);

  const structuredModes = jsonSchema
    ? traits.jsonOutputs
      ? ['format', 'tool', 'none']
      : ['tool', 'none']
    : ['none'];
  // Set once by a "max_tokens too large" 400 (no caller cap only).
  let maxTokensOverride;

  for (let level = 0; level < structuredModes.length; level += 1) {
    const mode = structuredModes[level];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const budget = attempt.kind === 'enabled' ? attempt.budget : 0;
      const outputConfig = {
        ...(attempt.kind === 'adaptive' && attempt.effort
          ? { effort: attempt.effort }
          : {}),
        ...(mode === 'format'
          ? {
              format: {
                type: 'json_schema',
                schema: jsonTool(jsonSchema).input_schema
              }
            }
          : {})
      };
      const body = {
        model,
        // Anthropic requires budget_tokens < max_tokens (thinking counts
        // against max_tokens). A caller's cap gets the budget reserved on
        // top; the large default already sits far above any budget.
        max_tokens:
          maxTokensOverride ??
          (maxOutputTokens
            ? maxOutputTokens + budget
            : ANTHROPIC_DEFAULT_MAX_TOKENS),
        ...(system !== undefined ? { system } : {}),
        messages: anthropicMessages,
        ...(stream ? { stream: true } : {}),
        ...(mode === 'tool'
          ? {
              tools: [jsonTool(jsonSchema)],
              tool_choice: { type: 'tool', name: 'output_json' }
            }
          : {}),
        ...(attempt.kind === 'enabled'
          ? { thinking: { type: 'enabled', budget_tokens: attempt.budget } }
          : attempt.kind === 'adaptive'
            ? { thinking: { type: 'adaptive' } }
            : {}),
        ...(Object.keys(outputConfig).length > 0
          ? { output_config: outputConfig }
          : {})
      };
      // Anthropic requires omitting `temperature` when `thinking` is enabled.
      try {
        const result = await callOnce({
          url,
          headers,
          body,
          stream,
          onDelta,
          signal,
          fetchImpl,
          idleTimeoutMs,
          firstTokenTimeoutMs,
          // JSON outputs arrive as plain text; only the tool route needs
          // the tool_use input extracted.
          structured: mode === 'tool'
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

        if (!maxOutputTokens && maxTokensOverride === undefined) {
          const rejected = maxTokensRejection(status, message);
          if (rejected) {
            // Same attempt again at the server's maximum, else the old
            // 4,096 allowance (+ the thinking budget, as before).
            maxTokensOverride = rejected.limit ?? LEGACY_MAX_TOKENS + budget;
            index -= 1;
            continue;
          }
        }
        const isLast = index === attempts.length - 1;
        if (status === 400 || status === 422) {
          const part = rejectedPart(message, mode, attempt);
          if (part === 'thinking' && !isLast) continue; // next thinking form
          if (part === 'structured' && mode !== 'none') break; // next mode
          if (part === 'unknown' && isUnsupportedParamError(status, message)) {
            if (!isLast) continue; // strip thinking first, as before
            if (mode !== 'none') break;
          }
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
