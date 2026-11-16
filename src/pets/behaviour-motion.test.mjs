import { describe, test, expect } from 'bun:test';
import {
  AMBIENT_WAITING_MS,
  computeBehaviour,
  DASH_WINDOW_MS,
  HOVER_BUBBLE_MS,
  ROAM_AFTER_INPUT_MS,
  stateDurationMs
} from './behaviour.mjs';
import { BUBBLE_MS, CHAT_SIGNAL_TTL_MS, SESSION_LEAD_MS } from './contract.mjs';

const T0 = Date.parse('2026-11-22T04:00:00Z');
const JUMP_MS = stateDurationMs('jumping');
const race = {
  key: '2026_22_race_2026-11-22T04:00:00',
  kind: 'race',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-22T04:00:00Z'
};

/** Ambient, nothing going on, roaming on, no pet input yet. */
function input(overrides = {}) {
  return {
    nowMs: T0,
    interaction: null,
    reducedMotion: false,
    quietUntilMs: null,
    chatReactions: true,
    chat: null,
    sessionReactions: 'calm',
    calendar: null,
    dismissedBubbleKey: null,
    lastActivityAtMs: T0,
    roam: true,
    lastInteractionAtMs: null,
    onBattery: false,
    locked: false,
    ...overrides
  };
}

const live = () => ({
  phase: 'live',
  session: race,
  nextBoundaryAt: T0 + 2 * 60 * 60 * 1000,
  bubble: 'Lights out! · Las Vegas Grand Prix'
});
const lead = () => ({
  phase: 'lead',
  session: race,
  nextBoundaryAt: T0,
  bubble: 'Race in 30 min · Las Vegas Grand Prix'
});

describe('motion — roam (2a)', () => {
  test('off by default: no motion, no extra change point', () => {
    const out = computeBehaviour(
      input({ roam: undefined, lastInteractionAtMs: T0 - 1000 })
    );
    expect(out.motion).toBeNull();
    expect(out.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
    expect(computeBehaviour(input({ roam: false })).motion).toBeNull();
  });

  test('ambient + roam on → roam (no pet input yet)', () => {
    const out = computeBehaviour(input());
    expect(out).toMatchObject({
      state: 'idle',
      layer: 'ambient',
      motion: 'roam',
      bubble: null
    });
    // Roaming adds no wake-up of its own.
    expect(out.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
  });

  test('waits ROAM_AFTER_INPUT_MS after the last pet input; that is the next change', () => {
    const before = computeBehaviour(
      input({ lastInteractionAtMs: T0 - 10_000 })
    );
    expect(before.motion).toBeNull();
    expect(before.nextChangeAt).toBe(T0 - 10_000 + ROAM_AFTER_INPUT_MS);
    const after = computeBehaviour(
      input({
        nowMs: T0 - 10_000 + ROAM_AFTER_INPUT_MS,
        lastInteractionAtMs: T0 - 10_000
      })
    );
    expect(after.motion).toBe('roam');
  });

  test('main-window / chat activity alone does not hold roaming back', () => {
    const out = computeBehaviour(
      input({ nowMs: T0 + 5000, lastActivityAtMs: T0 + 4000 })
    );
    expect(out.motion).toBe('roam');
  });

  test('also while the ambient pose is the waiting loop', () => {
    const out = computeBehaviour(
      input({ nowMs: T0 + AMBIENT_WAITING_MS + 1, lastActivityAtMs: T0 })
    );
    expect(out).toMatchObject({ state: 'waiting', motion: 'roam' });
  });

  test('never on battery, with reduced motion, locked or quiet', () => {
    for (const over of [
      { onBattery: true },
      { reducedMotion: true },
      { locked: true },
      { quietUntilMs: T0 + 60_000 }
    ]) {
      expect(computeBehaviour(input(over)).motion).toBeNull();
    }
    // A passed quiet does not count.
    expect(computeBehaviour(input({ quietUntilMs: T0 - 1 })).motion).toBe(
      'roam'
    );
  });

  test('never during an interaction, chat, a celebration or a moment pose', () => {
    expect(
      computeBehaviour(
        input({ interaction: { kind: 'drag', direction: 'left' } })
      ).motion
    ).toBeNull();
    expect(
      computeBehaviour(input({ chat: { signal: 'streaming', atMs: T0 } }))
        .motion
    ).toBeNull();
    // A chat loop that expired falls back to ambient → roam again.
    expect(
      computeBehaviour(
        input({
          nowMs: T0 + CHAT_SIGNAL_TTL_MS,
          chat: { signal: 'streaming', atMs: T0 }
        })
      ).motion
    ).toBe('roam');
    expect(
      computeBehaviour(
        input({ celebration: { atMs: T0, text: 'PB!', target: '/x' } })
      ).motion
    ).toBeNull();
  });

  test('never while a bubble shows; roams again once it is gone', () => {
    const moment = {
      kind: 'fact',
      key: '2026-11-22',
      text: 'On this day …',
      target: '/stats/on-this-day',
      atMs: T0,
      state: null,
      once: false
    };
    const during = computeBehaviour(input({ moment }));
    expect(during.layer).toBe('ambient');
    expect(during.bubble?.kind).toBe('fact');
    expect(during.motion).toBeNull();
    expect(during.nextChangeAt).toBe(T0 + BUBBLE_MS);
    expect(
      computeBehaviour(input({ moment, nowMs: T0 + BUBBLE_MS })).motion
    ).toBe('roam');
    // A hover bubble holds it back too (and the hover is pet input).
    const hover = computeBehaviour(
      input({
        nowMs: T0 + 1000,
        hoverBubble: { atMs: T0, text: 'Race in 2 h', target: '/' },
        lastInteractionAtMs: T0
      })
    );
    expect(hover.motion).toBeNull();
    expect(hover.nextChangeAt).toBe(T0 + HOVER_BUBBLE_MS);
  });

  test('during a live session: Calm roams after the start bubble, Lively runs in place', () => {
    const later = T0 + 60 * 60 * 1000;
    // Some input a few minutes ago keeps the pet awake (2b).
    const awake = { nowMs: later, lastActivityAtMs: later - 5 * 60 * 1000 };
    expect(computeBehaviour(input({ ...awake, calendar: live() })).motion).toBe(
      'roam'
    );
    expect(
      computeBehaviour(
        input({ ...awake, calendar: live(), sessionReactions: 'lively' })
      )
    ).toMatchObject({ state: 'running', layer: 'calendar', motion: null });
    // An hour without input: Calm sleeps through it, and stays put.
    expect(
      computeBehaviour(input({ nowMs: later, calendar: live() }))
    ).toMatchObject({ sleeping: true, motion: null });
  });
});

describe('motion — lights-out dash (2a)', () => {
  test('jump first, then dash until the start bubble ends', () => {
    const atStart = computeBehaviour(input({ calendar: live() }));
    expect(atStart).toMatchObject({ state: 'jumping', motion: null });
    expect(atStart.nextChangeAt).toBe(T0 + JUMP_MS);

    const dash = computeBehaviour(
      input({ nowMs: T0 + JUMP_MS, calendar: live() })
    );
    expect(dash.motion).toBe('dash');
    // The "Lights out!" bubble stays up through the dash.
    expect(dash.bubble?.kind).toBe('calendar');
    expect(dash.nextChangeAt).toBe(T0 + DASH_WINDOW_MS);

    expect(
      computeBehaviour(
        input({ nowMs: T0 + DASH_WINDOW_MS - 1, calendar: live() })
      ).motion
    ).toBe('dash');
    // Window over and bubble gone: plain roaming again.
    expect(
      computeBehaviour(input({ nowMs: T0 + DASH_WINDOW_MS, calendar: live() }))
        .motion
    ).toBe('roam');
  });

  test('Lively dashes too (over its running loop)', () => {
    const out = computeBehaviour(
      input({ nowMs: T0 + 5000, calendar: live(), sessionReactions: 'lively' })
    );
    expect(out).toMatchObject({ state: 'running', motion: 'dash' });
  });

  test('roam off, sessionReactions off, battery, reduced motion, locked → no dash', () => {
    const at = { nowMs: T0 + 2000, calendar: live() };
    expect(computeBehaviour(input({ ...at, roam: false })).motion).toBeNull();
    expect(
      computeBehaviour(input({ ...at, sessionReactions: 'off' })).motion
    ).toBe('roam');
    for (const over of [
      { onBattery: true },
      { reducedMotion: true },
      { locked: true },
      { quietUntilMs: T0 + 60_000 }
    ]) {
      expect(computeBehaviour(input({ ...at, ...over })).motion).toBeNull();
    }
  });

  test('pet input before the start does not matter; after it the dash is over for good', () => {
    expect(
      computeBehaviour(
        input({
          nowMs: T0 + 2000,
          calendar: live(),
          lastInteractionAtMs: T0 - 5000
        })
      ).motion
    ).toBe('dash');
    const touched = { calendar: live(), lastInteractionAtMs: T0 + 3000 };
    expect(
      computeBehaviour(input({ ...touched, nowMs: T0 + 3000 })).motion
    ).toBeNull();
    // Interaction over, window still open: no second dash.
    for (const nowMs of [T0 + 5000, T0 + DASH_WINDOW_MS - 1]) {
      expect(computeBehaviour(input({ ...touched, nowMs })).motion).toBeNull();
    }
  });

  test('a chat or an interaction at the start wins over the dash', () => {
    const at = { nowMs: T0 + 2000, calendar: live() };
    expect(
      computeBehaviour(
        input({ ...at, chat: { signal: 'planning', atMs: T0 + 1000 } })
      ).motion
    ).toBeNull();
    expect(
      computeBehaviour(
        input({ ...at, interaction: { kind: 'drag', direction: 'right' } })
      ).motion
    ).toBeNull();
  });

  test('the lead bubble (T−30) never dashes', () => {
    const out = computeBehaviour(
      input({ nowMs: T0 - SESSION_LEAD_MS + 2000, calendar: lead() })
    );
    expect(out).toMatchObject({ layer: 'ambient', motion: null });
    expect(out.bubble?.kind).toBe('calendar');
  });

  test('pure: the same input gives the same answer', () => {
    const one = input({ nowMs: T0 + 2000, calendar: live() });
    expect(computeBehaviour(one)).toEqual(computeBehaviour({ ...one }));
  });
});
