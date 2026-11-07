import { describe, test, expect } from 'bun:test';
import {
  SseDecoder,
  isAllowedTarget,
  normalizeBaseUrl,
  normalizeFinishReason,
  normalizeUsage,
  mapReasoningEffort,
  fetchWithValidatedRedirects
} from './shared.mjs';
import {
  completionsSse,
  completionsExpected,
  responsesSse,
  responsesExpected,
  anthropicSse,
  anthropicExpected
} from './__fixtures__/sse-traces.mjs';

describe('target validation (D4)', () => {
  test('allows loopback over http', () => {
    expect(isAllowedTarget('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isAllowedTarget('http://localhost:11434/v1')).toBe(true);
    expect(isAllowedTarget('http://[::1]:11434/v1')).toBe(true);
  });

  test('allows remote https only', () => {
    expect(isAllowedTarget('https://api.example.com/v1')).toBe(true);
    expect(isAllowedTarget('http://192.168.1.10:11434')).toBe(false);
    expect(isAllowedTarget('http://api.example.com/v1')).toBe(false);
  });

  test('rejects non-http(s) schemes and garbage', () => {
    expect(isAllowedTarget('ftp://127.0.0.1')).toBe(false);
    expect(isAllowedTarget('not a url')).toBe(false);
  });
});

describe('baseUrl normalization', () => {
  test('appends /v1 once to empty/root paths', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1'
    );
    expect(normalizeBaseUrl('http://127.0.0.1:11434/')).toBe(
      'http://127.0.0.1:11434/v1'
    );
  });

  test('never double-appends /v1', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1'
    );
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1'
    );
  });

  test('keeps non-empty paths verbatim', () => {
    expect(normalizeBaseUrl('https://api.example.com/api')).toBe(
      'https://api.example.com/api'
    );
  });
});

describe('SseDecoder', () => {
  test('parses a chat-completions trace', () => {
    const sse = new SseDecoder();
    const frames = sse.feed(completionsSse).concat(sse.flush());
    const text = frames
      .map((f) => JSON.parse(f.data))
      .filter((p) => p.choices?.[0]?.delta?.content)
      .map((p) => p.choices[0].delta.content)
      .join('');
    expect(text).toBe(completionsExpected.text);
  });

  test('parses a Responses typed-event trace', () => {
    const sse = new SseDecoder();
    const frames = sse.feed(responsesSse).concat(sse.flush());
    const deltas = frames
      .filter((f) => JSON.parse(f.data).type === 'response.output_text.delta')
      .map((f) => JSON.parse(f.data).delta)
      .join('');
    expect(deltas).toBe(responsesExpected.text);
  });

  test('parses an Anthropic trace', () => {
    const sse = new SseDecoder();
    const frames = sse.feed(anthropicSse).concat(sse.flush());
    const deltas = frames
      .filter((f) => JSON.parse(f.data).type === 'content_block_delta')
      .map((f) => JSON.parse(f.data).delta.text)
      .join('');
    expect(deltas).toBe(anthropicExpected.text);
  });

  test('tolerates CRLF and keepalive comments', () => {
    const sse = new SseDecoder();
    const frames = sse.feed(': keepalive\r\ndata: {"a":1}\r\n\r\n');
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].data)).toEqual({ a: 1 });
  });
});

describe('usage / finishReason normalization', () => {
  test('maps Responses usage + status', () => {
    expect(normalizeFinishReason('openai-responses', 'completed')).toBe('stop');
    expect(normalizeFinishReason('openai-responses', 'incomplete')).toBe(
      'length'
    );
    expect(normalizeFinishReason('anthropic-messages', 'end_turn')).toBe(
      'stop'
    );
    expect(normalizeFinishReason('anthropic-messages', 'max_tokens')).toBe(
      'length'
    );
  });

  test('normalizes completions usage into the AI SDK shape', () => {
    const usage = normalizeUsage('openai-completions', {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 }
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: { cacheReadTokens: 3 },
      outputTokenDetails: { reasoningTokens: 2 }
    });
  });
});

describe('reasoning mapping', () => {
  test('maps portable levels to effort strings', () => {
    expect(mapReasoningEffort('provider-default')).toBeUndefined();
    expect(mapReasoningEffort('low')).toBe('low');
    expect(mapReasoningEffort('medium')).toBe('medium');
    expect(mapReasoningEffort('xhigh')).toBe('high');
  });
});

describe('redirect re-validation', () => {
  test('follows an allowed https redirect', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/a')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://api.example.com/b' }
        });
      }
      return new Response('ok', { status: 200 });
    };
    const response = await fetchWithValidatedRedirects(
      fetchImpl,
      'https://api.example.com/a',
      {}
    );
    expect(response.status).toBe(200);
  });

  test('rejects a redirect to a disallowed http target', async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/' }
      });
    await expect(
      fetchWithValidatedRedirects(fetchImpl, 'https://api.example.com/a', {})
    ).rejects.toThrow(/Disallowed redirect target/);
  });
});

describe('SseDecoder line endings split across chunks', () => {
  // Regression: a \r at the end of one chunk and its \n at the start of the
  // next were normalised separately into two line breaks — a spurious blank
  // line that ended the frame early and dropped its `event:` name.
  test('keeps the event name when the CRLF is split', () => {
    const sse = new SseDecoder();
    const frames = [
      ...sse.feed('event: response.output_text.delta\r'),
      ...sse.feed('\ndata: {"x":1}\r\n\r\n'),
      ...sse.flush()
    ];
    expect(frames).toEqual([
      { event: 'response.output_text.delta', data: '{"x":1}' }
    ]);
  });

  test('keeps a multi-line data frame whole and flushes a trailing CR', () => {
    const sse = new SseDecoder();
    const frames = [
      ...sse.feed('data: {"a":\r'),
      ...sse.feed('\ndata: 1}\r'),
      ...sse.flush()
    ];
    expect(frames).toEqual([{ event: 'message', data: '{"a":\n1}' }]);
  });
});
