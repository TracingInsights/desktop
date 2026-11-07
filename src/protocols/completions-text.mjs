/**
 * OpenAI-compatible chat-completions text extraction.
 *
 * Hosted shims (vLLM, SGLang, Featherless, Together, OpenRouter, …) disagree
 * on where the visible answer lives versus the chain-of-thought: `content`,
 * `reasoning_content`, `reasoning`, array content parts, or `<think>` tags
 * inside the content string. The adapter must return the *answer* to the
 * website (SQL planning JSON-parses it) while still treating reasoning
 * tokens as "first token arrived" so the idle/first-token watchdogs do not
 * fire during a long think phase.
 */
import { mapReasoningEffort } from './shared.mjs';

const THINK_OPEN = /<think(?:ing)?>/i;
const THINK_CLOSE = /<\/think(?:ing)?>/i;
const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const UNCLOSED_THINK = /<think(?:ing)?>[\s\S]*$/i;

/** Concatenate OpenAI-style string-or-parts content, skipping think parts. */
export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type ?? '').toLowerCase();
    if (
      type === 'reasoning' ||
      type === 'thinking' ||
      type === 'reasoning_content'
    ) {
      continue;
    }
    if (typeof part.text === 'string') parts.push(part.text);
    else if (typeof part.content === 'string') parts.push(part.content);
  }
  return parts.join('');
}

function reasoningFromParts(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type ?? '').toLowerCase();
    if (
      type === 'reasoning' ||
      type === 'thinking' ||
      type === 'reasoning_content'
    ) {
      if (typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.content === 'string') parts.push(part.content);
    }
  }
  return parts.join('');
}

function stringField(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string' && value.text) return value.text;
      if (typeof value.content === 'string' && value.content)
        return value.content;
    }
  }
  return '';
}

/** Visible assistant text from a chat-completions message. */
export function textFromMessage(message) {
  if (!message || typeof message !== 'object') return '';
  return textFromContent(message.content);
}

/** Chain-of-thought text from a message (never mixed into the answer). */
export function reasoningFromMessage(message) {
  if (!message || typeof message !== 'object') return '';
  return stringField(
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    reasoningFromParts(message.content)
  );
}

export function textFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  return textFromContent(delta.content);
}

export function reasoningFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  return stringField(
    delta.reasoning_content,
    delta.reasoning,
    delta.thinking,
    reasoningFromParts(delta.content)
  );
}

export function stripThinkBlocks(text) {
  return String(text ?? '')
    .replace(THINK_BLOCK, '')
    .replace(UNCLOSED_THINK, '');
}

/**
 * Incremental filter: hold back `<think>` / `<thinking>` regions so streamed
 * CoT never reaches the page as answer text.
 */
export class VisibleContentFilter {
  #buf = '';
  #hidden = false;

  feed(chunk) {
    if (!chunk) return '';
    this.#buf += chunk;
    let out = '';
    while (this.#buf.length > 0) {
      if (this.#hidden) {
        const close = this.#buf.search(THINK_CLOSE);
        if (close === -1) {
          const lt = this.#buf.lastIndexOf('<');
          if (lt === -1) this.#buf = '';
          else if (lt < this.#buf.length - 16) this.#buf = this.#buf.slice(-16);
          else this.#buf = this.#buf.slice(lt);
          break;
        }
        const rest = this.#buf.slice(close);
        const match = rest.match(/^<\/think(?:ing)?>/i);
        this.#buf = this.#buf.slice(close + (match?.[0].length ?? 8));
        this.#hidden = false;
        continue;
      }
      const open = this.#buf.search(THINK_OPEN);
      if (open === -1) {
        const lt = this.#buf.lastIndexOf('<');
        if (lt !== -1 && this.#buf.length - lt < 16) {
          out += this.#buf.slice(0, lt);
          this.#buf = this.#buf.slice(lt);
        } else {
          out += this.#buf;
          this.#buf = '';
        }
        break;
      }
      out += this.#buf.slice(0, open);
      const rest = this.#buf.slice(open);
      const match = rest.match(/^<think(?:ing)?>/i);
      this.#buf = this.#buf.slice(open + (match?.[0].length ?? 7));
      this.#hidden = true;
    }
    return out;
  }

  flush() {
    if (this.#hidden) {
      this.#buf = '';
      this.#hidden = false;
      return '';
    }
    const rest = this.#buf;
    this.#buf = '';
    return rest;
  }
}

/** Parse one SSE `data` payload, or several JSON values packed into it. */
export function parseCompletionsPayloads(data) {
  const raw = String(data ?? '').trim();
  if (!raw || raw === '[DONE]') return [];
  try {
    return [JSON.parse(raw)];
  } catch {
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t === '[DONE]') continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // ignore keepalives / partials
      }
    }
    return out;
  }
}

/**
 * Portable reasoning → OpenAI-compat request extras, tried in order. Extra
 * fields that a given host rejects are stripped by the adapter's retry ladder
 * — never send a host-specific blob as the only attempt.
 */
export function completionsReasoningAttempts({
  reasoning,
  modelReasoning = false
} = {}) {
  const effort = mapReasoningEffort(reasoning);
  const disable = reasoning === 'none';
  const enable =
    (!disable && effort !== undefined) ||
    ((!reasoning || reasoning === 'provider-default') &&
      Boolean(modelReasoning));

  if (disable) {
    return [
      { reasoning_effort: 'none' },
      { chat_template_kwargs: { enable_thinking: false } },
      { thinking: { type: 'disabled' } },
      {}
    ];
  }
  if (!enable) return [{}];

  const attempts = [];
  if (effort) attempts.push({ reasoning_effort: effort });
  attempts.push({ chat_template_kwargs: { enable_thinking: true } });
  attempts.push({ thinking: { type: 'enabled' } });
  attempts.push({});
  return attempts;
}

export function reasoningFieldsPresent(extras) {
  if (!extras || typeof extras !== 'object') return false;
  return (
    extras.reasoning_effort !== undefined ||
    extras.chat_template_kwargs !== undefined ||
    extras.thinking !== undefined
  );
}

/** Raise max_tokens so thinking models still have room for the answer. */
export function completionsMaxTokens(maxOutputTokens, thinkingRequested) {
  if (!maxOutputTokens) return undefined;
  return thinkingRequested ? Math.max(maxOutputTokens, 8192) : maxOutputTokens;
}
