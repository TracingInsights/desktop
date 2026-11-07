import { describe, test, expect } from 'bun:test';
import {
  VisibleContentFilter,
  completionsReasoningAttempts,
  parseCompletionsPayloads,
  stripThinkBlocks,
  textFromDelta,
  textFromMessage
} from './completions-text.mjs';

describe('completions text extraction', () => {
  test('reads string content and skips reasoning parts', () => {
    expect(textFromMessage({ content: 'pong' })).toBe('pong');
    expect(
      textFromDelta({
        content: [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: 'ok' }
        ]
      })
    ).toBe('ok');
  });

  test('strips think blocks', () => {
    expect(stripThinkBlocks('<think>secret</think>{"sql":"SELECT 1"}')).toBe(
      '{"sql":"SELECT 1"}'
    );
  });

  test('VisibleContentFilter holds back think tags across chunks', () => {
    const f = new VisibleContentFilter();
    expect(f.feed('<thi')).toBe('');
    expect(f.feed('nk>hidden')).toBe('');
    expect(f.feed('</think>visible')).toBe('visible');
    expect(f.flush()).toBe('');
  });

  test('parseCompletionsPayloads splits packed JSON lines', () => {
    const payloads = parseCompletionsPayloads('{"a":1}\n{"b":2}');
    expect(payloads).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('reasoning attempts include enable_thinking without a host name', () => {
    const attempts = completionsReasoningAttempts({
      reasoning: 'provider-default',
      modelReasoning: true
    });
    expect(attempts[0]).toEqual({
      chat_template_kwargs: { enable_thinking: true }
    });
    expect(attempts.at(-1)).toEqual({});
  });
});
