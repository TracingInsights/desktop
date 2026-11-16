/**
 * behaviour.mjs × duo reactions (SPEC 4b): the second sprite's own pose —
 * the latest race's head-to-head (every result combination), the ambient
 * staggered waves, and every layer that makes the second mirror the first.
 */
import { describe, test, expect } from 'bun:test';
import {
  AMBIENT_SLEEP_MS,
  AMBIENT_WAITING_MS,
  computeBehaviour,
  DUO_WAVE_DELAY_MS,
  DUO_WAVE_EVERY_MS,
  DUO_WAVE_FIRST_MS,
  DUO_WAVE_UNTIL_MS,
  duoDrivers,
  duoResultPoses,
  duoWaveTimes,
  stateDurationMs
} from './behaviour.mjs';
import { BUBBLE_MS } from './contract.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-09T12:00:00Z');
const RACE_KEY = '2026_20_race_2026-11-08T17:00';

/** Base input: ambient, nothing going on, last input just now. */
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
    onBattery: false,
    locked: false,
    ...overrides
  };
}

/** A result moment that started at T0 (the favourite's own pose by default). */
const resultMoment = (extra = {}) => ({
  kind: 'result',
  key: RACE_KEY,
  text: 'Max wins the São Paulo GP!',
  target: '/stats/races/2026/20/sao-paulo',
  atMs: T0,
  state: 'jumping',
  once: true,
  ...extra
});

const duoOf = (first, second, key = RACE_KEY) => ({
  result: { key, first, second }
});

/** A latest-race feed with these results (driverId → position | status). */
function feedWith(entries, extra = {}) {
  return {
    latestRace: {
      key: RACE_KEY,
      year: 2026,
      round: 20,
      gp: 'São Paulo Grand Prix',
      results: Object.entries(entries).map(([driverId, r]) => ({
        driverId,
        name: driverId,
        code: null,
        position: typeof r === 'number' ? r : null,
        status: typeof r === 'number' ? 'finished' : r
      }))
    },
    petDrivers: {
      'max-4': 'max-verstappen',
      lando: 'lando-norris',
      senna: 'ayrton-senna',
      'senna-sprint': 'ayrton-senna'
    },
    ...extra
  };
}

describe('duoDrivers', () => {
  const feed = feedWith({});

  test('both Petdex pets mapped to different drivers → first, second', () => {
    expect(
      duoDrivers({
        feed,
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando'
      })
    ).toEqual({ first: 'max-verstappen', second: 'lando-norris' });
    expect(
      duoDrivers({
        feed,
        firstPetId: 'petdex:lando',
        secondPetId: 'petdex:max-4'
      })
    ).toEqual({ first: 'lando-norris', second: 'max-verstappen' });
  });

  test('null when a pet is unmapped, not from Petdex, missing, or the same driver', () => {
    for (const [a, b] of [
      ['petdex:max-4', 'petdex:pia'],
      ['petdex:max-4', 'codex:lando'],
      ['import:x', 'petdex:lando'],
      ['petdex:senna', 'petdex:senna-sprint'],
      ['petdex:max-4', 'petdex:max-4'],
      ['petdex:max-4', null],
      [null, 'petdex:lando']
    ]) {
      expect(duoDrivers({ feed, firstPetId: a, secondPetId: b })).toBeNull();
    }
    expect(
      duoDrivers({
        feed: null,
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando'
      })
    ).toBeNull();
  });
});

describe('duoResultPoses — every result combination', () => {
  const poses = (a, b) =>
    duoResultPoses({
      feed: feedWith({ 'max-verstappen': a, 'lando-norris': b }),
      firstDriverId: 'max-verstappen',
      secondDriverId: 'lando-norris'
    });
  const UNCLASSIFIED = ['nc', 'dnf', 'dsq', 'dns', 'dnq'];

  test('both finished: the better one jumps, the other fails', () => {
    expect(poses(1, 3)).toEqual({
      key: RACE_KEY,
      first: 'jumping',
      second: 'failed'
    });
    expect(poses(3, 1)).toMatchObject({ first: 'failed', second: 'jumping' });
    expect(poses(19, 20)).toMatchObject({ first: 'jumping', second: 'failed' });
  });

  test('one unclassified (any status): worse than any finish', () => {
    for (const status of UNCLASSIFIED) {
      expect(poses(20, status)).toMatchObject({
        first: 'jumping',
        second: 'failed'
      });
      expect(poses(status, 20)).toMatchObject({
        first: 'failed',
        second: 'jumping'
      });
    }
  });

  test('both unclassified: both fail', () => {
    for (const a of UNCLASSIFIED) {
      for (const b of UNCLASSIFIED) {
        expect(poses(a, b)).toMatchObject({
          first: 'failed',
          second: 'failed'
        });
      }
    }
  });

  test('equal positions (impossible, handled): both wave', () => {
    expect(poses(4, 4)).toMatchObject({ first: 'waving', second: 'waving' });
  });

  test('null when the race or either driver is missing', () => {
    const feed = feedWith({ 'max-verstappen': 1 });
    expect(
      duoResultPoses({
        feed,
        firstDriverId: 'max-verstappen',
        secondDriverId: 'lando-norris'
      })
    ).toBeNull();
    expect(
      duoResultPoses({
        feed,
        firstDriverId: 'lando-norris',
        secondDriverId: 'max-verstappen'
      })
    ).toBeNull();
    for (const bad of [
      null,
      {},
      { latestRace: null },
      { latestRace: { key: RACE_KEY } },
      { latestRace: { results: [] } }
    ]) {
      expect(
        duoResultPoses({
          feed: bad,
          firstDriverId: 'max-verstappen',
          secondDriverId: 'lando-norris'
        })
      ).toBeNull();
    }
  });
});

describe('computeBehaviour — duo result head-to-head', () => {
  const JUMP = stateDurationMs('jumping');
  const FAIL = stateDurationMs('failed');

  test('better finisher jumps once, the other fails once, each for its own length', () => {
    const o = { moment: resultMoment(), duo: duoOf('jumping', 'failed') };
    const start = computeBehaviour(input(o));
    expect(start).toMatchObject({
      state: 'jumping',
      once: true,
      layer: 'moment',
      playKey: `result:${RACE_KEY}:${T0}`,
      second: {
        state: 'failed',
        once: true,
        playKey: `result:${RACE_KEY}:${T0}:second`,
        delayMs: 0
      }
    });
    expect(start.bubble?.text).toBe('Max wins the São Paulo GP!');
    expect(start.nextChangeAt).toBe(T0 + JUMP);

    // The first's jump is over; the second keeps failing (same playKey).
    const mid = computeBehaviour(input({ ...o, nowMs: T0 + JUMP }));
    expect(mid).toMatchObject({ state: 'idle', layer: 'ambient' });
    expect(mid.second).toEqual(start.second);
    expect(mid.nextChangeAt).toBe(T0 + FAIL);

    const end = computeBehaviour(input({ ...o, nowMs: T0 + FAIL }));
    expect(end.second).toBeNull();
    expect(end.bubble?.kind).toBe('result');
  });

  test('the duo pose replaces the favourite’s own pose (held idle, none)', () => {
    for (const own of [
      { state: 'idle', once: false },
      { state: null, once: false },
      { state: 'waving', once: true }
    ]) {
      const out = computeBehaviour(
        input({
          moment: resultMoment(own),
          duo: duoOf('failed', 'jumping')
        })
      );
      expect(out).toMatchObject({
        state: 'failed',
        once: true,
        layer: 'moment'
      });
      expect(out.second).toMatchObject({ state: 'jumping', once: true });
      expect(out.nextChangeAt).toBe(T0 + JUMP);
    }
  });

  test('both unclassified: both fail; equal: both wave', () => {
    const failed = computeBehaviour(
      input({ moment: resultMoment(), duo: duoOf('failed', 'failed') })
    );
    expect(failed).toMatchObject({
      state: 'failed',
      second: { state: 'failed' }
    });
    expect(failed.nextChangeAt).toBe(T0 + FAIL);
    const waving = computeBehaviour(
      input({ moment: resultMoment(), duo: duoOf('waving', 'waving') })
    );
    expect(waving).toMatchObject({
      state: 'waving',
      second: { state: 'waving', delayMs: 0 }
    });
    expect(waving.nextChangeAt).toBe(T0 + stateDurationMs('waving'));
  });

  test('poses of another race, another moment kind or no duo: as before', () => {
    const own = resultMoment({ state: 'waving', once: true });
    for (const o of [
      { moment: own, duo: duoOf('jumping', 'failed', 'other-race') },
      { moment: own, duo: { result: null } },
      { moment: own, duo: null },
      { moment: own }
    ]) {
      const out = computeBehaviour(input(o));
      expect(out).toMatchObject({ state: 'waving', layer: 'moment' });
      expect(out.second).toBeNull();
    }
    const fact = computeBehaviour(
      input({
        moment: { ...own, kind: 'fact', state: null, once: false },
        duo: duoOf('jumping', 'failed')
      })
    );
    expect(fact).toMatchObject({ state: 'idle', layer: 'ambient' });
    expect(fact.second).toBeNull();
  });

  test('a user action, chat or quiet moves both alike (second = null)', () => {
    const o = { moment: resultMoment(), duo: duoOf('jumping', 'failed') };
    const hover = computeBehaviour(
      input({ ...o, interaction: { kind: 'hover', atMs: T0 } })
    );
    expect(hover).toMatchObject({ state: 'waving', layer: 'interaction' });
    expect(hover.second).toBeNull();
    const chat = computeBehaviour(
      input({ ...o, chat: { signal: 'streaming', atMs: T0 } })
    );
    expect(chat).toMatchObject({ state: 'running', layer: 'chat' });
    expect(chat.second).toBeNull();
    const quiet = computeBehaviour(input({ ...o, quietUntilMs: T0 + MIN }));
    expect(quiet).toMatchObject({ state: 'idle', layer: 'quiet' });
    expect(quiet.second).toBeNull();
  });

  test('reduce motion: both on the idle frame (second = null)', () => {
    const out = computeBehaviour(
      input({
        moment: resultMoment(),
        duo: duoOf('jumping', 'failed'),
        reducedMotion: true
      })
    );
    expect(out).toMatchObject({ state: 'idle', still: true, second: null });
  });

  test('the poses end with the moment (dismissed / expired)', () => {
    const out = computeBehaviour(
      input({
        moment: resultMoment(),
        duo: duoOf('jumping', 'failed'),
        nowMs: T0 + BUBBLE_MS
      })
    );
    expect(out.second).toBeNull();
    expect(
      computeBehaviour(input({ duo: duoOf('jumping', 'failed') })).second
    ).toBeNull();
  });
});

describe('duoWaveTimes', () => {
  test('5, 15 and 25 min after the last input; none from 30 min', () => {
    expect(DUO_WAVE_FIRST_MS).toBe(5 * MIN);
    expect(DUO_WAVE_EVERY_MS).toBe(10 * MIN);
    expect(DUO_WAVE_UNTIL_MS).toBe(30 * MIN);
    expect(duoWaveTimes(T0, T0)).toEqual({ current: null, next: T0 + 5 * MIN });
    expect(duoWaveTimes(T0, T0 + 5 * MIN)).toEqual({
      current: T0 + 5 * MIN,
      next: T0 + 15 * MIN
    });
    expect(duoWaveTimes(T0, T0 + 14 * MIN)).toEqual({
      current: T0 + 5 * MIN,
      next: T0 + 15 * MIN
    });
    expect(duoWaveTimes(T0, T0 + 25 * MIN + 1)).toEqual({
      current: T0 + 25 * MIN,
      next: null
    });
    expect(duoWaveTimes(T0, T0 + 35 * MIN)).toEqual({
      current: null,
      next: null
    });
  });
});

describe('computeBehaviour — ambient duo waves (staggered)', () => {
  const duo = duoOf('jumping', 'failed');
  const WAVE = stateDurationMs('waving');
  const at = (ms, extra = {}) =>
    computeBehaviour(input({ duo, nowMs: T0 + ms, ...extra }));

  test('the stagger is one wave: the second answers as the first ends', () => {
    expect(DUO_WAVE_DELAY_MS).toBe(WAVE);
  });

  test('before the first wave: idle, the wave start is a boundary', () => {
    const out = at(0);
    expect(out).toMatchObject({ state: 'idle', second: null });
    expect(out.nextChangeAt).toBe(T0 + 5 * MIN);
  });

  test('first waves, then the second ~0.7 s later (delayMs), then both rest', () => {
    const w = 5 * MIN;
    const start = at(w);
    expect(start).toMatchObject({
      state: 'waving',
      once: true,
      still: false,
      layer: 'ambient',
      playKey: `duo-wave:${T0 + w}`,
      second: {
        state: 'waving',
        once: true,
        playKey: `duo-wave:${T0 + w}:second`,
        delayMs: DUO_WAVE_DELAY_MS
      }
    });
    expect(start.nextChangeAt).toBe(T0 + w + WAVE);

    // The first is back to idle; the second's wave keeps its playKey.
    const mid = at(w + WAVE);
    expect(mid).toMatchObject({ state: 'idle', playKey: 'idle' });
    expect(mid.second).toEqual(start.second);
    expect(mid.nextChangeAt).toBe(T0 + w + DUO_WAVE_DELAY_MS + WAVE);

    const end = at(w + DUO_WAVE_DELAY_MS + WAVE);
    expect(end).toMatchObject({ state: 'idle', second: null });
    // Next: the 10-min waiting switch, then the 15-min wave.
    expect(end.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
    expect(at(AMBIENT_WAITING_MS)).toMatchObject({
      state: 'waiting',
      second: null,
      nextChangeAt: T0 + 15 * MIN
    });
  });

  test('later waves interrupt the waiting loop once, then it resumes', () => {
    for (const w of [15 * MIN, 25 * MIN]) {
      expect(at(w)).toMatchObject({
        state: 'waving',
        second: { state: 'waving', delayMs: DUO_WAVE_DELAY_MS }
      });
      expect(at(w + WAVE)).toMatchObject({
        state: 'waiting',
        second: { state: 'waving' }
      });
      expect(at(w + DUO_WAVE_DELAY_MS + WAVE)).toMatchObject({
        state: 'waiting',
        second: null
      });
    }
    // No more waves: the next change is the sleep (2b), and asleep the
    // pair stays still with no timer left.
    expect(DUO_WAVE_UNTIL_MS).toBe(AMBIENT_SLEEP_MS);
    expect(at(25 * MIN + DUO_WAVE_DELAY_MS + WAVE).nextChangeAt).toBe(
      T0 + AMBIENT_SLEEP_MS
    );
    expect(at(35 * MIN)).toMatchObject({
      state: 'idle',
      sleeping: true,
      second: null,
      nextChangeAt: null
    });
  });

  test('the schedule restarts from the last input', () => {
    const out = at(8 * MIN, { lastActivityAtMs: T0 + 3 * MIN });
    expect(out).toMatchObject({ state: 'waving', second: { delayMs: 700 } });
    expect(at(5 * MIN, { lastActivityAtMs: T0 + 3 * MIN }).second).toBeNull();
  });

  test('no waves (and no wave timers) without a mapped duo, on battery, locked, with reduced motion', () => {
    for (const extra of [
      { duo: null },
      { onBattery: true },
      { locked: true },
      { reducedMotion: true }
    ]) {
      const before = at(0, extra);
      expect(before.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
      const out = at(5 * MIN, extra);
      expect(out.state).toBe('idle');
      expect(out.second).toBeNull();
    }
  });

  test('no waves while quiet or while a higher layer drives the pet', () => {
    expect(at(5 * MIN, { quietUntilMs: T0 + HOUR })).toMatchObject({
      state: 'idle',
      layer: 'quiet',
      second: null
    });
    expect(
      at(5 * MIN, { chat: { signal: 'planning', atMs: T0 + 5 * MIN } })
    ).toMatchObject({ state: 'running', layer: 'chat', second: null });
  });
});

describe('computeBehaviour — not a duo', () => {
  test('second is null in every layer', () => {
    for (const extra of [
      {},
      { nowMs: T0 + 5 * MIN },
      { moment: resultMoment() },
      { interaction: { kind: 'click', atMs: T0 } },
      { chat: { signal: 'done', atMs: T0 } }
    ]) {
      expect(computeBehaviour(input(extra)).second).toBeNull();
    }
  });
});
