/**
 * `/v1/models` auto-discovery for custom providers (§7.6).
 *
 * OpenAI-compatible chat-completions and Responses servers both expose
 * `GET {base}/models`; Anthropic exposes it too (with `anthropic-version`).
 * The probe normalizes every response to `ModelInfo[]`, surfacing a context
 * window when the server advertises one (`max_model_len` on vLLM,
 * `context_length` on llama.cpp / Ollama).
 */
import {
  fetchWithValidatedRedirects,
  inferenceError,
  normalizeBaseUrl,
  isAllowedTarget
} from './protocols/shared.mjs';

const PROTOCOL_HEADERS = {
  'anthropic-messages': { 'anthropic-version': '2023-06-01' },
  'openai-completions': {},
  'openai-responses': {}
};

function contextWindowFrom(data) {
  const model = data ?? {};
  const candidates = [
    model.max_model_len,
    model.context_length,
    model.context_window,
    model.contextWindow,
    model.context_window_size,
    model.num_ctx
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  const details = model.details ?? model.model_info ?? {};
  for (const value of [
    details.context_length,
    details.context_window,
    details.max_model_len
  ]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Probe `GET {base}/models` and return normalized ModelInfo[].
 * Accepts a page-supplied key if any (never a stored credential).
 */
export async function listModels({
  protocol,
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch
}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !isAllowedTarget(base)) {
    return inferenceError('invalid_request', {
      providerMessage: 'Invalid or disallowed base URL.'
    });
  }

  let response;
  try {
    response = await fetchWithValidatedRedirects(fetchImpl, `${base}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(PROTOCOL_HEADERS[protocol] ?? {})
      }
    });
  } catch (error) {
    if (error?.code === 'invalid_request') {
      return inferenceError('invalid_request', {
        providerMessage: error instanceof Error ? error.message : String(error)
      });
    }
    return inferenceError('network', {
      providerMessage: error instanceof Error ? error.message : String(error)
    });
  }

  if (!response.ok) {
    const status = response.status;
    let providerMessage = '';
    try {
      providerMessage = (await response.text()).slice(0, 500);
    } catch {
      // ignore
    }
    return inferenceError('http_error', { status, providerMessage });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return inferenceError('invalid_request', {
      providerMessage:
        'The endpoint did not return a valid /v1/models response.'
    });
  }

  const data = payload?.data ?? payload?.models;
  if (!Array.isArray(data)) {
    return inferenceError('invalid_request', {
      providerMessage: 'The endpoint did not return a model list.'
    });
  }

  const MAX_DISCOVERED_MODELS = 250;
  const usable = data.filter((entry) => entry && typeof entry.id === 'string');
  // Hard cap keeps the settings UI cheap to render (model chips). Report the
  // truncation so the panel can say "showing 250 of N" instead of silently
  // dropping entries past the cap.
  const truncated = usable.length > MAX_DISCOVERED_MODELS;
  const models = usable.slice(0, MAX_DISCOVERED_MODELS).map((entry) => {
    const contextWindow = contextWindowFrom(entry);
    return {
      id: entry.id,
      name: entry.name ?? entry.display_name ?? entry.id,
      ...(typeof entry.description === 'string' && entry.description
        ? { description: entry.description }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {})
    };
  });

  return { ok: true, models, truncated, total: usable.length };
}
