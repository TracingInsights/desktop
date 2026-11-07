import { describe, test, expect } from 'bun:test';
import { run as runCompletions } from './openai-completions.mjs';
import { run as runResponses } from './openai-responses.mjs';
import {
  run as runAnthropic,
  ANTHROPIC_DEFAULT_MAX_TOKENS
} from './anthropic-messages.mjs';
import { responsesSse, anthropicSse } from './__fixtures__/sse-traces.mjs';

const JSON_SCHEMA = {
  name: 'sql_plan',
  strict: true,
  schema: { type: 'object', properties: {}, required: [] }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function sseResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

describe('openai-completions adapter', () => {
  test('embeds json_schema and streams deltas', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push({ url: _url, body: JSON.parse(init.body) });
      return sseResponse(
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
          'data: [DONE]\n\n'
      );
    };
    const result = await runCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3',
      messages: [{ role: 'user', content: 'hello' }],
      jsonSchema: JSON_SCHEMA,
      stream: true,
      onDelta: () => {},
      fetchImpl,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('hi');
    expect(seen[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(seen[0].body.response_format).toEqual({
      type: 'json_schema',
      json_schema: JSON_SCHEMA
    });
  });

  test('strips and retries on a structured-output 400', async () => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls += 1;
      if (body.response_format?.type === 'json_schema') {
        return jsonResponse(
          { error: { message: 'response_format is not supported' } },
          400
        );
      }
      return jsonResponse({
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    };
    const result = await runCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [],
      jsonSchema: JSON_SCHEMA,
      fetchImpl
    });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
    // Final call stepped down to json_object (no json_schema).
    expect(calls).toBe(2);
  });

  test('streams answer text after reasoning_content and think tags', async () => {
    const deltas = [];
    const fetchImpl = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"reasoning_content":"plan"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"<think>hid</think>pong"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
      );
    const result = await runCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'thinker',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onDelta: (d) => deltas.push(d),
      fetchImpl,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(deltas.join('')).toBe('pong');
  });

  test('retries unknown reasoning_effort then enable_thinking', async () => {
    const bodies = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.reasoning_effort) {
        return jsonResponse(
          { error: { message: 'Unknown parameter: reasoning_effort' } },
          400
        );
      }
      return jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
      });
    };
    const result = await runCompletions({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      messages: [],
      reasoning: 'high',
      fetchImpl
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok');
    expect(bodies[0].reasoning_effort).toBe('high');
    expect(bodies[1].chat_template_kwargs).toEqual({
      enable_thinking: true
    });
  });
});

describe('openai-responses adapter', () => {
  test('parses typed streaming events into text + usage', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return sseResponse(responsesSse);
    };
    const result = await runResponses({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'grok',
      messages: [{ role: 'user', content: 'q' }],
      jsonSchema: JSON_SCHEMA,
      stream: true,
      onDelta: () => {},
      fetchImpl,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('SELECT * FROM drivers');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(12);
    expect(seen[0].text.format).toEqual({
      type: 'json_schema',
      name: 'sql_plan',
      strict: true,
      schema: JSON_SCHEMA.schema
    });
  });
});

describe('anthropic-messages adapter', () => {
  test('requests tool-use JSON and parses the stream', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push({ headers: init.headers, body: JSON.parse(init.body) });
      return sseResponse(anthropicSse);
    };
    const result = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': 'sk-test' },
      model: 'claude',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' }
      ],
      stream: true,
      onDelta: () => {},
      fetchImpl,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hello F1');
    expect(seen[0].body.system).toBe('sys');
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0].headers['x-api-key']).toBe('sk-test');
  });

  test('streams tool_use partial_json as the JSON plan text', async () => {
    const trace = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"output_json"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"sql\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SELECT 1\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('');
    const fetchImpl = async () => sseResponse(trace);
    const result = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      headers: { 'x-api-key': 'sk-test' },
      model: 'claude',
      messages: [{ role: 'user', content: 'q' }],
      jsonSchema: JSON_SCHEMA,
      stream: true,
      onDelta: () => {},
      fetchImpl,
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 5000
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"sql":"SELECT 1"}');
  });
});

// ---------------------------------------------------------------------------
// Regressions (2026-10 audit, M7) — mirror of the browser adapter fixes in
// src/lib/ai/custom-providers/protocols/*.ts.
// ---------------------------------------------------------------------------

function sseTrace(events, named = true) {
  return events
    .map(
      (e) =>
        `${named && e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`
    )
    .join('');
}

/** fetch mock whose body errors on abort, like a real fetch. */
function delayedSse(delayMs, frame) {
  return async (_url, init) => {
    const body = new ReadableStream({
      start(c) {
        const t = setTimeout(() => {
          c.enqueue(new TextEncoder().encode(frame));
          c.close();
        }, delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          c.error(init.signal.reason);
        });
      }
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };
}

describe('watchdogs', () => {
  test('the idle watchdog does not pre-empt the first-token grace', async () => {
    const r = await runCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      onDelta: () => {},
      fetchImpl: delayedSse(
        80,
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
      ),
      idleTimeoutMs: 20,
      firstTokenTimeoutMs: 1000
    });
    expect(r).toMatchObject({ ok: true, text: 'hi' });
    const resp = await runResponses({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      onDelta: () => {},
      fetchImpl: delayedSse(
        80,
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
      ),
      idleTimeoutMs: 20,
      firstTokenTimeoutMs: 1000
    });
    expect(resp).toMatchObject({ ok: true, text: 'hi' });
    const a = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'c',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      onDelta: () => {},
      fetchImpl: delayedSse(
        80,
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
      ),
      idleTimeoutMs: 20,
      firstTokenTimeoutMs: 1000
    });
    expect(a).toMatchObject({ ok: true, text: 'hi' });
  });

  test('a blocking request that never answers is bounded by the first-token grace', async () => {
    const hang = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal.reason)
        );
      });
    const started = Date.now();
    const r = await runCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
      fetchImpl: hang,
      idleTimeoutMs: 20,
      firstTokenTimeoutMs: 60
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 3000);
});

describe('openai-responses regressions', () => {
  test('keeps every content part when .done events are reconciled', async () => {
    const evs = [
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Part one. '
      },
      {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: 'Part one. '
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: 'Part two.'
      },
      {
        type: 'response.output_text.done',
        output_index: 1,
        content_index: 0,
        text: 'Part two.'
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1 } }
      }
    ];
    const deltas = [];
    const r = await runResponses({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      onDelta: (d) => deltas.push(d),
      fetchImpl: async () => sseResponse(sseTrace(evs, false))
    });
    expect(deltas.join('')).toBe('Part one. Part two.');
    expect(r).toMatchObject({ ok: true, text: 'Part one. Part two.' });
  });

  test('fails the run on a top-level {type:"error"} event', async () => {
    const r = await runResponses({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      onDelta: () => {},
      fetchImpl: async () =>
        sseResponse(
          sseTrace([
            {
              type: 'error',
              code: 'server_error',
              message: 'Upstream exploded'
            }
          ])
        )
    });
    expect(r).toMatchObject({
      ok: false,
      error: { providerMessage: 'Upstream exploded' }
    });
  });
});

describe('anthropic-messages regressions', () => {
  test('reserves the thinking budget on top of max_tokens and keeps input usage', async () => {
    let sent;
    const events = [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 1200, output_tokens: 1 } }
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 15 }
      },
      { type: 'message_stop' }
    ];
    const r = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude',
      messages: [{ role: 'user', content: 'x' }],
      reasoning: 'high',
      maxOutputTokens: 4096,
      stream: true,
      onDelta: () => {},
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return sseResponse(sseTrace(events));
      }
    });
    expect(sent.thinking?.budget_tokens).toBe(4096);
    expect(sent.max_tokens).toBe(8192);
    expect(r).toMatchObject({
      ok: true,
      usage: { inputTokens: 1200, outputTokens: 15, totalTokens: 1215 }
    });
  });
});

// Decision 8 (docs/PROMPT_OPTIMIZATION_PLAN_2026-10.md): no output cap where
// the API makes it optional; Messages requires one, so a large value.
describe('output caps (decision 8)', () => {
  const messages = [{ role: 'user', content: 'x' }];
  const anthropicOk = {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 }
  };

  test('responses sends no max_output_tokens unless the caller set one', async () => {
    const sent = [];
    const fetchImpl = async (_u, init) => {
      sent.push(JSON.parse(init.body));
      return jsonResponse({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] }
        ],
        usage: { input_tokens: 3, output_tokens: 1 }
      });
    };
    const r = await runResponses({
      baseUrl: 'https://x/v1',
      model: 'm',
      messages,
      reasoning: 'high',
      fetchImpl
    });
    expect(r.ok).toBe(true);
    expect('max_output_tokens' in sent[0]).toBe(false);
    await runResponses({
      baseUrl: 'https://x/v1',
      model: 'm',
      messages,
      maxOutputTokens: 900,
      fetchImpl
    });
    expect(sent[1].max_output_tokens).toBe(900);
  });

  test('anthropic sends a large max_tokens above the thinking budget', async () => {
    let sent;
    const r = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude',
      messages,
      reasoning: 'high',
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return jsonResponse(anthropicOk);
      }
    });
    expect(r.ok).toBe(true);
    expect(sent.thinking.budget_tokens).toBe(4096);
    expect(sent.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
    expect(sent.max_tokens).toBeGreaterThan(sent.thinking.budget_tokens);
  });

  test('anthropic retries once at the maximum a "max_tokens too large" 400 names', async () => {
    const sent = [];
    const replies = [
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022'
          }
        },
        400
      ),
      jsonResponse(anthropicOk)
    ];
    const r = await runAnthropic({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3-5-haiku-20241022',
      messages,
      reasoning: 'high',
      fetchImpl: async (_u, init) => {
        sent.push(JSON.parse(init.body));
        return replies.shift();
      }
    });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].max_tokens).toBe(8192);
    expect(sent[1].thinking.budget_tokens).toBe(4096);
  });
});

// WP C3 (C1 follow-up): Claude 4.6+ take adaptive thinking + effort, reject
// the budget_tokens form (5.x / 4.7 / 4.8) and, on 5.5, a forced tool_choice
// — structured plans use JSON outputs. Mirror of
// tests/unit/anthropic-adaptive-thinking.test.ts.
describe('anthropic adaptive thinking (WP C3)', () => {
  const okBody = {
    content: [{ type: 'text', text: '{"sql":"SELECT 1"}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 }
  };
  const messages = [{ role: 'user', content: 'q' }];

  test('Claude 5.5: adaptive + effort + JSON outputs, no forced tool', async () => {
    const sent = [];
    const r = await runAnthropic({
      baseUrl: 'https://x/v1',
      model: 'claude-opus-5-5',
      messages,
      reasoning: 'high',
      jsonSchema: JSON_SCHEMA,
      fetchImpl: async (_u, init) => {
        sent.push(JSON.parse(init.body));
        return jsonResponse(okBody);
      }
    });
    expect(r).toMatchObject({ ok: true, text: '{"sql":"SELECT 1"}' });
    expect(sent[0].thinking).toEqual({ type: 'adaptive' });
    expect(sent[0].output_config.effort).toBe('high');
    expect(sent[0].output_config.format.type).toBe('json_schema');
    expect(sent[0].tool_choice).toBeUndefined();
  });

  test('Haiku 4.5 keeps budget_tokens', async () => {
    let sent;
    await runAnthropic({
      baseUrl: 'https://x/v1',
      model: 'claude-haiku-4-5',
      messages,
      reasoning: 'high',
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return jsonResponse(okBody);
      }
    });
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(sent.output_config).toBeUndefined();
  });

  test('an unknown model asked for adaptive thinking gets it on the retry', async () => {
    const sent = [];
    const replies = [
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort.'
          }
        },
        400
      ),
      jsonResponse(okBody)
    ];
    const r = await runAnthropic({
      baseUrl: 'https://x/v1',
      model: 'proxy-model',
      messages,
      reasoning: 'medium',
      fetchImpl: async (_u, init) => {
        sent.push(JSON.parse(init.body));
        return replies.shift();
      }
    });
    expect(r.ok).toBe(true);
    expect(sent[1].thinking).toEqual({ type: 'adaptive' });
    expect(sent[1].output_config).toEqual({ effort: 'medium' });
  });
});
