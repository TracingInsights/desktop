import { describe, test, expect } from 'bun:test';
import {
  bubbleActionsFor,
  MAX_BUBBLE_ACTIONS,
  MUTE_ACTIONS
} from './bubble-actions.mjs';
import { BUBBLE_KINDS } from './behaviour.mjs';
import { BUBBLE_ACTION_IDS, DEFAULT_SETTINGS } from './contract.mjs';
import { validatePagePatch } from './settings.mjs';

const ids = (actions) => actions?.map((a) => a.id) ?? null;

describe('bubbleActionsFor (round 3, 2e)', () => {
  test('hover bubbles and no bubble get no buttons', () => {
    expect(bubbleActionsFor('hover')).toBeNull();
    expect(bubbleActionsFor('hover', { sessionQuiet: true })).toBeNull();
    expect(bubbleActionsFor(null)).toBeNull();
    expect(bubbleActionsFor(undefined)).toBeNull();
    expect(bubbleActionsFor('')).toBeNull();
  });

  test('celebrate: OK · Quiet 1 h (+ Quiet this session), never mute', () => {
    expect(bubbleActionsFor('celebrate')).toEqual([
      { id: 'ok', label: 'OK' },
      { id: 'quiet-1h', label: 'Quiet 1 h' }
    ]);
    expect(bubbleActionsFor('celebrate', { sessionQuiet: true })).toEqual([
      { id: 'ok', label: 'OK' },
      { id: 'quiet-1h', label: 'Quiet 1 h' },
      { id: 'quiet-session', label: 'Quiet this session' }
    ]);
  });

  test('kind-specific mute labels', () => {
    const muteLabel = (kind) =>
      bubbleActionsFor(kind)?.find((a) => a.id === 'mute')?.label ?? null;
    expect(muteLabel('fact')).toBe('No daily facts');
    expect(muteLabel('rate')).toBe('No rate reminders');
    expect(muteLabel('result')).toBe('No result reactions');
    expect(muteLabel('greeting')).toBe('No greetings');
    expect(muteLabel('calendar')).toBe('No session alerts');
    expect(muteLabel('celebrate')).toBeNull();
  });

  test('with a mute button, Quiet this session takes the place of Quiet 1 h (≤ 3)', () => {
    for (const kind of Object.keys(MUTE_ACTIONS)) {
      expect(ids(bubbleActionsFor(kind))).toEqual(['ok', 'quiet-1h', 'mute']);
      expect(ids(bubbleActionsFor(kind, { sessionQuiet: true }))).toEqual([
        'ok',
        'quiet-session',
        'mute'
      ]);
    }
  });

  test('every kind: ≤ 3 known ids, OK first; unknown kinds get OK + quiet only', () => {
    for (const kind of [...BUBBLE_KINDS, 'greeting', 'future-kind']) {
      for (const sessionQuiet of [false, true]) {
        const actions = bubbleActionsFor(kind, { sessionQuiet });
        if (kind === 'hover') continue;
        expect(actions.length).toBeLessThanOrEqual(MAX_BUBBLE_ACTIONS);
        expect(actions[0]).toEqual({ id: 'ok', label: 'OK' });
        for (const action of actions) {
          expect(BUBBLE_ACTION_IDS).toContain(action.id);
          expect(action.label.length).toBeGreaterThan(0);
        }
      }
    }
    expect(ids(bubbleActionsFor('future-kind'))).toEqual(['ok', 'quiet-1h']);
  });

  test('mute writes page-writable settings (the gallery follows them)', () => {
    expect(MUTE_ACTIONS.calendar.patch).toEqual({ sessionReactions: 'off' });
    for (const kind of ['fact', 'rate', 'result', 'calendar']) {
      const { patch } = MUTE_ACTIONS[kind];
      expect({ kind, ok: validatePagePatch(patch).ok }).toEqual({
        kind,
        ok: true
      });
    }
    // `greetings` arrives with the race-weekend greetings (lane L3).
    expect(MUTE_ACTIONS.greeting.patch).toEqual({ greetings: false });
    if (Object.hasOwn(DEFAULT_SETTINGS, 'greetings')) {
      expect(validatePagePatch(MUTE_ACTIONS.greeting.patch).ok).toBe(true);
    }
  });
});
