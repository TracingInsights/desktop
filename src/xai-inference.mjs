/**
 * xAI inference adapter — reuses the openai-responses SSE parser with the
 * Grok upstream (cli-chat-proxy.grok.com/v1/responses). Keep the header/input
 * mapping in sync with `src/lib/ai/run/clients/xai-oauth-client.ts` and the
 * user-agent in `src/lib/ai/providers/xai-user-agent.ts`.
 */
import { XAI_OAUTH_RESPONSES_URL } from './xai-auth.mjs';
import { runResponses } from './protocols/openai-responses.mjs';
import { inferenceError } from './protocols/shared.mjs';

/**
 * Sticky-routing id for xAI's per-server prompt cache (`x-grok-conv-id`,
 * https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
 * A random id per app run (like Codex's per-install `prompt_cache_key`),
 * never a user or account id. Mirrors `XAI_CONV_ID_HEADER` in
 * `src/lib/ai/run/clients/xai-oauth-client.ts`.
 */
export const XAI_CONV_ID_HEADER = 'x-grok-conv-id';
let convId = null;

function xaiConvId() {
  if (convId) return convId;
  try {
    convId = crypto.randomUUID();
  } catch {
    convId = `tif1ai-desktop-${Date.now().toString(36)}`;
  }
  return convId;
}

function contentString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }
  return '';
}

export function createXaiInference(deps = {}) {
  const { xaiAuth, idleTimeoutMs, firstTokenTimeoutMs } = deps;

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
      const resolved = await xaiAuth.resolveCredential();
      if (!resolved.ok) return resolved;

      const credential = resolved.credential;
      const headers = {
        authorization: `Bearer ${credential.accessToken}`,
        'user-agent': 'tif1ai-desktop',
        [XAI_CONV_ID_HEADER]: xaiConvId()
      };

      const input = (Array.isArray(messages) ? messages : []).map(
        (message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: contentString(message.content)
        })
      );

      try {
        return await runResponses({
          url: XAI_OAUTH_RESPONSES_URL,
          headers,
          model,
          input,
          jsonSchema,
          reasoning,
          maxOutputTokens,
          stream,
          onDelta,
          signal,
          fetchImpl,
          idleTimeoutMs,
          firstTokenTimeoutMs,
          bodyExtra: { store: false }
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
