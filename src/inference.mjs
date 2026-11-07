/**
 * Inference dispatcher + streaming relay.
 *
 * Owns the `inference.generate` / `inference.stream` / `inference.abort`
 * contract: caller-supplied `requestId`, one abort channel per id, chunked
 * `webContents.send` relay with ~30–60 ms delta coalescing, and an abort map
 * that tears down both in-flight generates and streams.
 */
import {
  inferenceError,
  isAllowedTarget,
  normalizeBaseUrl
} from './protocols/shared.mjs';
import { run as runCompletions } from './protocols/openai-completions.mjs';
import { run as runResponses } from './protocols/openai-responses.mjs';
import { run as runAnthropic } from './protocols/anthropic-messages.mjs';

const DELTA_BATCH_MS = 40;

const PROTOCOL_RUNNERS = {
  'openai-completions': runCompletions,
  'openai-responses': runResponses,
  'anthropic-messages': runAnthropic
};

function modelWantsReasoning(entry, modelId) {
  if (!entry || !modelId) return false;
  for (const m of entry.models ?? []) {
    if (m && typeof m === 'object' && m.id === modelId && m.reasoning) {
      return true;
    }
  }
  return Array.isArray(entry.reasoningModels)
    ? entry.reasoningModels.includes(modelId)
    : false;
}

/**
 * Create the inference controller. `deps`:
 *   - registry        — custom provider registry ({ resolve, get })
 *   - codexInference  — Codex adapter ({ run })
 *   - xaiInference    — xAI adapter ({ run })
 *   - idleTimeoutMs / firstTokenTimeoutMs — timeout tuning
 */
export function createInference(deps = {}) {
  const {
    registry,
    codexInference,
    xaiInference,
    idleTimeoutMs,
    firstTokenTimeoutMs
  } = deps;

  const active = new Map(); // requestId → { controller, timer, done }

  function abortRequest(requestId, reason = 'aborted') {
    const entry = active.get(requestId);
    if (!entry) return;
    entry.controller?.abort(new Error(reason));
    if (entry.timer) clearTimeout(entry.timer);
    active.delete(requestId);
  }

  /** Resolve a `providerId` to a runnable adapter function. */
  function resolveAdapter(providerId) {
    if (providerId === 'codex') {
      return {
        async invoke(input) {
          return codexInference.run(input);
        }
      };
    }
    if (providerId === 'xai-oauth') {
      return {
        async invoke(input) {
          return xaiInference.run(input);
        }
      };
    }
    if (typeof providerId === 'string' && providerId.startsWith('custom:')) {
      const resolved = registry?.resolve(providerId);
      if (!resolved) {
        return {
          async invoke() {
            return inferenceError('invalid_request', {
              providerMessage: `Unknown provider: ${providerId}.`
            });
          }
        };
      }
      const { entry, apiKey } = resolved;
      const runner = PROTOCOL_RUNNERS[entry.protocol];
      if (!runner) {
        return {
          async invoke() {
            return inferenceError('invalid_request', {
              providerMessage: `Unsupported protocol: ${entry.protocol}.`
            });
          }
        };
      }
      return {
        async invoke(input) {
          return runner({
            baseUrl: entry.baseUrl,
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
            model: input.model,
            messages: input.messages,
            jsonSchema: input.jsonSchema,
            reasoning: input.reasoning,
            modelReasoning: modelWantsReasoning(entry, input.model),
            maxOutputTokens: input.maxOutputTokens,
            stream: input.stream,
            onDelta: input.onDelta,
            signal: input.signal,
            fetchImpl: input.fetchImpl,
            idleTimeoutMs,
            firstTokenTimeoutMs
          });
        }
      };
    }
    return {
      async invoke() {
        return inferenceError('invalid_request', {
          providerMessage: `Unknown provider: ${providerId}.`
        });
      }
    };
  }

  function validateProviderId(providerId) {
    return (
      providerId === 'codex' ||
      providerId === 'xai-oauth' ||
      (typeof providerId === 'string' && providerId.startsWith('custom:'))
    );
  }

  async function generate(input) {
    const { requestId } = input;
    if (!validateProviderId(input.providerId)) {
      return inferenceError('invalid_request', {
        providerMessage: `Unknown provider: ${input.providerId}.`
      });
    }
    const controller = new AbortController();
    const entry = { controller, timer: null, done: false };
    active.set(requestId, entry);

    try {
      const result = await resolveAdapter(input.providerId).invoke({
        model: input.model,
        messages: input.messages,
        jsonSchema: input.jsonSchema,
        reasoning: input.reasoning,
        maxOutputTokens: input.maxOutputTokens,
        stream: false,
        signal: controller.signal,
        fetchImpl: input.fetchImpl
      });
      if (!result.ok && controller.signal.aborted) {
        return inferenceError('aborted');
      }
      return result;
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      active.delete(requestId);
    }
  }

  async function stream(input) {
    const { requestId, send } = input;
    if (!validateProviderId(input.providerId)) {
      // Fire an end event so the page-side promise never hangs.
      send?.('inference:end', {
        requestId,
        error: {
          code: 'invalid_request',
          providerMessage: `Unknown provider: ${input.providerId}.`
        }
      });
      return { requestId };
    }

    const controller = new AbortController();
    let pending = '';
    let timer = null;
    let finished = false;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        const delta = pending;
        pending = '';
        send?.('inference:chunk', { requestId, delta });
      }
    };

    const entry = { controller, timer, done: false };
    active.set(requestId, entry);

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      flush();
      send?.('inference:end', { requestId, ...payload });
      if (entry.timer) clearTimeout(entry.timer);
      active.delete(requestId);
    };

    const onDelta = (delta) => {
      if (typeof delta !== 'string' || !delta) return;
      pending += delta;
      if (!timer) {
        timer = setTimeout(flush, DELTA_BATCH_MS);
      }
    };

    // Kick off the adapter asynchronously; the invoke resolves `{ requestId }`
    // immediately so the page can start listening (or abort) without racing.
    Promise.resolve()
      .then(() =>
        resolveAdapter(input.providerId).invoke({
          model: input.model,
          messages: input.messages,
          jsonSchema: input.jsonSchema,
          reasoning: input.reasoning,
          maxOutputTokens: input.maxOutputTokens,
          stream: true,
          onDelta,
          signal: controller.signal,
          fetchImpl: input.fetchImpl
        })
      )
      .then((result) => {
        if (!result.ok) {
          finish({ error: result.error });
          return;
        }
        finish({
          text: result.text,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.finishReason ? { finishReason: result.finishReason } : {})
        });
      })
      .catch((error) => {
        finish({
          error: {
            code: controller.signal.aborted ? 'aborted' : 'network',
            providerMessage:
              error instanceof Error ? error.message : String(error)
          }
        });
      });

    return { requestId };
  }

  function abort(requestId) {
    abortRequest(requestId);
  }

  /** Abort every in-flight request (page navigation / window destroyed). */
  function abortAll() {
    for (const requestId of [...active.keys()]) {
      abortRequest(requestId);
    }
  }

  return { generate, stream, abort, abortAll };
}

export { isAllowedTarget, normalizeBaseUrl };
