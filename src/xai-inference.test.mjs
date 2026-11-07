import { describe, test, expect } from 'bun:test';
import { createXaiInference, XAI_CONV_ID_HEADER } from './xai-inference.mjs';

const PLAN = '{"sql":"SELECT 1"}';

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: PLAN }] }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

describe('xAI inference x-grok-conv-id', () => {
  test('plan and answer calls share one random id, not the token', async () => {
    const xai = createXaiInference({
      xaiAuth: {
        resolveCredential: async () => ({
          ok: true,
          credential: { accessToken: 'user-token' }
        })
      }
    });
    const calls = [];
    const fetchImpl = fakeFetch(calls);
    await xai.run({
      model: 'grok-build-0.1',
      messages: [{ role: 'user', content: 'plan' }],
      fetchImpl
    });
    await xai.run({
      model: 'grok-composer-2.5-fast',
      messages: [{ role: 'user', content: 'answer' }],
      fetchImpl
    });
    expect(calls.length).toBe(2);
    const first = calls[0].init.headers[XAI_CONV_ID_HEADER];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].init.headers[XAI_CONV_ID_HEADER]).toBe(first);
    expect(first).not.toContain('user-token');
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty(
      'prompt_cache_key'
    );
  });
});
