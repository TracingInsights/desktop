/**
 * Codex inference adapter — reuses the openai-responses SSE parser with the
 * Codex-specific upstream (chatgpt.com/backend-api/codex/responses) input
 * shape and headers. Keep the `input`/header mapping in sync with
 * `src/lib/ai/run/clients/codex-client.ts`.
 */
import { CODEX_RESPONSES_URL } from './codex-auth.mjs';
import { runResponses } from './protocols/openai-responses.mjs';
import { inferenceError } from './protocols/shared.mjs';

let promptCacheKey = null;

function contentString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }
  return '';
}

/** Map OpenAI-style `{ role, content }[]` to Codex's `input` shape. */
function codexInput(messages) {
  return [
    { type: 'additional_tools', role: 'developer', tools: [] },
    ...(Array.isArray(messages) ? messages : []).map((message) => ({
      type: 'message',
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'input_text', text: contentString(message.content) }]
    }))
  ];
}

/** Stable per-install prompt-cache key (mirrors the website's thread-id). */
function cacheKey() {
  if (promptCacheKey) return promptCacheKey;
  try {
    promptCacheKey = crypto.randomUUID();
  } catch {
    promptCacheKey = 'tif1ai-desktop-session';
  }
  return promptCacheKey;
}

/**
 * Create the Codex inference controller. `deps.codexAuth` supplies credential
 * resolution (lazy refresh + auth_expired mapping).
 */
export function createCodexInference(deps = {}) {
  const { codexAuth, idleTimeoutMs, firstTokenTimeoutMs } = deps;

  return {
    async run({
      model,
      messages,
      jsonSchema,
      reasoning,
      maxOutputTokens,
      stream = false,
      onDelta,
      signal,
      fetchImpl = globalThis.fetch
    }) {
      const resolved = await codexAuth.resolveCredential();
      if (!resolved.ok) return resolved;

      const credential = resolved.credential;
      const headers = {
        authorization: `Bearer ${credential.accessToken}`,
        ...(credential.accountId
          ? { 'ChatGPT-Account-ID': credential.accountId }
          : {}),
        ...(credential.isFedrampAccount ? { 'X-OpenAI-Fedramp': 'true' } : {})
      };

      try {
        return await runResponses({
          url: CODEX_RESPONSES_URL,
          headers,
          model,
          input: codexInput(messages),
          jsonSchema,
          reasoning,
          maxOutputTokens,
          stream,
          onDelta,
          signal,
          fetchImpl,
          idleTimeoutMs,
          firstTokenTimeoutMs,
          bodyExtra: {
            store: false,
            include: [],
            prompt_cache_key: cacheKey(),
            client_metadata: { source: 'tif1ai-desktop' }
          }
        });
      } catch (error) {
        return inferenceError('network', {
          providerMessage:
            error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}
