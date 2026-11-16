/**
 * Ambient look-around on Petdex v2 sheets (SPEC 1b): `look-a` / `look-b`
 * one-shots from rows 9–10, only with an 11-row atlas.
 */
import { describe, test, expect } from 'bun:test';
import {
  AMBIENT_LOOK_EVERY_MS,
  AMBIENT_LOOK_WINDOW_MS,
  AMBIENT_SLEEP_MS,
  AMBIENT_WAITING_MS,
  computeBehaviour,
  LOOK_STATES
} from './behaviour.mjs';
import { BUBBLE_MS, PET_STATES } from './contract.mjs';

const T0 = Date.parse('2026-11-22T04:00:00Z');
const MIN = 60 * 1000;
const LOOK_MS = 1120;

/** Base input: ambient, nothing going on, last input at T0. */
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
    lastActivityAtMs: T0,
    onBattery: false,
    locked: false,
    ...overrides
  };
}

/**
 * Follow `nextChangeAt` like the controller's single timer from T0 to
 * `untilMs`; every pose the pet would show, with when it started.
 */
function run(overrides, untilMs) {
  const shown = [];
  let now = T0;
  for (let steps = 0; steps < 1000; steps++) {
    const out = computeBehaviour(input({ ...overrides, nowMs: now }));
    const prev = shown.at(-1);
    if (!prev || prev.state !== out.state || prev.playKey !== out.playKey) {
      shown.push({ at: now - T0, state: out.state, playKey: out.playKey });
    }
    if (out.nextChangeAt === null || out.nextChangeAt > untilMs) break;
    expect(out.nextChangeAt).toBeGreaterThan(now);
    now = out.nextChangeAt;
  }
  return shown;
}

describe('contract: v2-only look states', () => {
  test('rows 9 and 10, 8 frames, 1120 ms, need 11 rows', () => {
    expect(PET_STATES.filter((s) => s.minRows !== undefined)).toEqual([
      { id: 'look-a', row: 9, frames: 8, durationMs: 1120, minRows: 11 },
      { id: 'look-b', row: 10, frames: 8, durationMs: 1120, minRows: 11 }
    ]);
    expect(LOOK_STATES).toEqual(['look-a', 'look-b']);
  });
});

describe('computeBehaviour — ambient look-around (v2 sheets)', () => {
  test('a v1 pet (or no atlasRows) behaves exactly as before', () => {
    for (let t = 0; t <= 45 * MIN; t += 7_919) {
      const today = computeBehaviour(input({ nowMs: T0 + t }));
      expect(computeBehaviour(input({ nowMs: T0 + t, atlasRows: 9 }))).toEqual(
        today
      );
      expect(today.state === 'idle' || today.state === 'waiting').toBe(true);
    }
    expect(run({ atlasRows: 9 }, T0 + 2 * 60 * MIN)).toEqual([
      { at: 0, state: 'idle', playKey: 'idle' },
      { at: AMBIENT_WAITING_MS, state: 'waiting', playKey: 'waiting' },
      { at: AMBIENT_SLEEP_MS, state: 'idle', playKey: 'sleeping' }
    ]);
  });

  test('11 rows: a / b alternate every 4 min after the last input, for 30 min', () => {
    expect(AMBIENT_LOOK_EVERY_MS).toBe(4 * MIN);
    expect(AMBIENT_LOOK_WINDOW_MS).toBe(30 * MIN);
    expect(AMBIENT_LOOK_WINDOW_MS).toBe(AMBIENT_SLEEP_MS);
    const shown = run({ atlasRows: 11 }, T0 + 3 * 60 * MIN);
    const looks = shown.filter((s) => s.state.startsWith('look-'));
    expect(looks).toEqual(
      [4, 8, 12, 16, 20, 24, 28].map((m, i) => ({
        at: m * MIN,
        state: i % 2 === 0 ? 'look-a' : 'look-b',
        playKey: `look:${T0 + m * MIN}`
      }))
    );
    // Each look plays once and hands back to the ambient pose underneath.
    expect(shown.slice(0, 6)).toEqual([
      { at: 0, state: 'idle', playKey: 'idle' },
      { at: 4 * MIN, state: 'look-a', playKey: `look:${T0 + 4 * MIN}` },
      { at: 4 * MIN + LOOK_MS, state: 'idle', playKey: 'idle' },
      { at: 8 * MIN, state: 'look-b', playKey: `look:${T0 + 8 * MIN}` },
      { at: 8 * MIN + LOOK_MS, state: 'idle', playKey: 'idle' },
      { at: AMBIENT_WAITING_MS, state: 'waiting', playKey: 'waiting' }
    ]);
    // The last look hands back to `waiting`; the pet sleeps at 30 min (2b).
    expect(shown.slice(-2)).toEqual([
      { at: 28 * MIN + LOOK_MS, state: 'waiting', playKey: 'waiting' },
      { at: AMBIENT_SLEEP_MS, state: 'idle', playKey: 'sleeping' }
    ]);
  });

  test('a look is a one-shot over the ambient layer, with its end as the next change', () => {
    const out = computeBehaviour(
      input({ atlasRows: 11, nowMs: T0 + 4 * MIN + 500 })
    );
    expect(out).toEqual({
      state: 'look-a',
      once: true,
      still: false,
      bubble: null,
      playKey: `look:${T0 + 4 * MIN}`,
      layer: 'ambient',
      nextChangeAt: T0 + 4 * MIN + LOOK_MS,
      second: null,
      motion: null,
      sleeping: false
    });
    // Between looks the timer aims at the next one.
    expect(
      computeBehaviour(input({ atlasRows: 11, nowMs: T0 + 13 * MIN }))
        .nextChangeAt
    ).toBe(T0 + 16 * MIN);
    // After the last look no other is planned: only the sleep (2b).
    expect(
      computeBehaviour(input({ atlasRows: 11, nowMs: T0 + 29 * MIN }))
        .nextChangeAt
    ).toBe(T0 + AMBIENT_SLEEP_MS);
  });

  test('counts from the latest input', () => {
    const later = T0 + 7 * MIN;
    expect(
      computeBehaviour(
        input({ atlasRows: 11, nowMs: T0 + 8 * MIN, lastActivityAtMs: later })
      )
    ).toMatchObject({ state: 'idle', nextChangeAt: later + 4 * MIN });
    expect(
      computeBehaviour(
        input({
          atlasRows: 11,
          nowMs: later + 4 * MIN,
          lastActivityAtMs: later
        })
      ).state
    ).toBe('look-a');
  });

  test('never on battery, locked, with reduce motion or while quiet', () => {
    const at = T0 + 4 * MIN + 100;
    for (const gate of [
      { onBattery: true },
      { locked: true },
      { reducedMotion: true },
      { quietUntilMs: T0 + 60 * MIN }
    ]) {
      const out = computeBehaviour(
        input({ atlasRows: 11, nowMs: at, ...gate })
      );
      expect(out.state).toBe('idle');
      expect(out.playKey).toBe('idle');
      // …and no wake-ups planned for looks.
      expect(
        run({ atlasRows: 11, ...gate }, T0 + 60 * MIN).some((s) =>
          s.state.startsWith('look-')
        )
      ).toBe(false);
    }
  });

  test('never over a higher layer or while a bubble shows', () => {
    const at = T0 + 4 * MIN + 100;
    // Chat activity.
    expect(
      computeBehaviour(
        input({
          atlasRows: 11,
          nowMs: at,
          lastActivityAtMs: T0,
          chat: { signal: 'streaming', atMs: at - 1000 }
        })
      ).state
    ).toBe('running');
    // A rate nudge bubble (ambient layer, but something is happening).
    const moment = {
      kind: 'rate',
      key: 'k',
      text: 'Rate the Las Vegas GP',
      target: '/rate',
      atMs: at - 1000,
      state: null,
      once: false
    };
    const busy = computeBehaviour(input({ atlasRows: 11, nowMs: at, moment }));
    expect(busy).toMatchObject({ state: 'idle', layer: 'ambient' });
    expect(busy.bubble?.kind).toBe('rate');
    // The bubble's end is the next change; the covered look is skipped.
    expect(busy.nextChangeAt).toBe(at - 1000 + BUBBLE_MS);
    expect(
      computeBehaviour(
        input({ atlasRows: 11, nowMs: at - 1000 + BUBBLE_MS, moment })
      )
    ).toMatchObject({ state: 'idle', nextChangeAt: T0 + 8 * MIN });
  });

  test('an interaction still wins over a look', () => {
    const at = T0 + 4 * MIN + 100;
    expect(
      computeBehaviour(
        input({
          atlasRows: 11,
          nowMs: at,
          interaction: { kind: 'click', atMs: at - 50 }
        })
      ).state
    ).toBe('jumping');
  });
});
