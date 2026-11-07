/**
 * Golden-trace fixtures — captured SSE byte streams + expected parsed deltas
 * for the three wire protocols, plus Codex/xAI device-auth token-endpoint
 * responses. Shared DATA (not code) consumed by both the desktop `bun test`
 * suite and the website's Vitest suite, so SSE parsing and OAuth refresh /
 * expiresAt logic are exercised against the same recordings
 * (docs/custom-providers-desktop.md §3).
 */

/** OpenAI chat-completions streaming trace (two deltas + usage + finish). */
export const completionsSse = [
  'data: {"choices":[{"delta":{"content":"{\\"under"},"finish_reason":null}],"usage":null}\n\n',
  'data: {"choices":[{"delta":{"content":"standing\\": \\"Drivers\\""},"finish_reason":null}],"usage":null}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
  'data: [DONE]\n\n'
].join('');

export const completionsExpected = {
  text: '{"understanding": "Drivers"',
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
};

/** OpenAI Responses streaming trace (typed events). */
export const responsesSse = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"SELECT "}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"* FROM drivers"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n'
].join('');

export const responsesExpected = {
  text: 'SELECT * FROM drivers',
  finishReason: 'stop',
  usage: {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    outputTokenDetails: { reasoningTokens: 0 }
  }
};

/** Anthropic Messages streaming trace (text deltas + message_delta). */
export const anthropicSse = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" F1"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
].join('');

export const anthropicExpected = {
  text: 'Hello F1',
  finishReason: 'stop'
};

/**
 * Recorded device-auth token-endpoint responses (success / 400 revoked /
 * slow_down). Shape matches what both the website TS and the `.mjs` auth
 * modules parse.
 */
export const oauthTokenResponses = {
  success: {
    status: 200,
    body: {
      access_token: 'at-123',
      refresh_token: 'rt-123',
      id_token: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.sig',
      account_id: 'act-123',
      expires_in: 900
    }
  },
  revoked: {
    status: 400,
    body: { error: 'invalid_grant', error_description: 'refresh token revoked' }
  },
  slowDown: {
    status: 429,
    body: { error: 'slow_down', error_description: 'slow down' }
  }
};

/**
 * Captured `inference:chunk` delta sequences for a streamed SQL plan — the
 * structured `understanding`/`sql` partials, so the website's incremental-JSON
 * plan parser is exercised against recorded real-model output.
 */
export const planChunkDeltas = [
  '{"understanding":"',
  'List the drivers',
  ' with the most wins","answer":"',
  '","sql":"SELECT ',
  'driver, COUNT(*) FROM results WHERE position=1 GROUP BY driver',
  ' ORDER BY COUNT(*) DESC","',
  'tables_used":["results"]}'
];

export const planChunkExpectedText = planChunkDeltas.join('');
