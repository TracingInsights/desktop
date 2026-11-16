/**
 * Controller × duo reactions (SPEC 4b): `secondAnim` in the render payload —
 * the result head-to-head poses, the result bubble's head-to-head line, the
 * ambient staggered waves on a fake clock, the rows fallback (a state the
 * second atlas lacks → idle) and the timeline run of the same controller.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetController, secondAnimation } from './controller.mjs';
import {
  AMBIENT_WAITING_MS,
  DUO_WAVE_DELAY_MS,
  stateDurationMs
} from './behaviour.mjs';
import { PET_STATES } from './contract.mjs';
import { createPetsSettings } from './settings.mjs';
import { calendarPhase, parseSchedule, sessionBubble } from './schedule.mjs';
import { compileTimeline } from './timeline.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STATE = Object.fromEntries(PET_STATES.map((s) => [s.id, s]));

function fakeClock(start) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((x) => x.at),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    }
  };
}

function fakePetWindow() {
  const renders = [];
  let shown = false;
  return {
    renders,
    side: 'left',
    secondSide() {
      return this.side;
    },
    show() {
      shown = true;
    },
    hide() {
      shown = false;
    },
    isShown: () => shown,
    render: (payload) => renders.push(payload),
    moveBy: () => {},
    savePosition: () => {}
  };
}

// São Paulo GP 2026: race 17:00Z, nominal end 19:00Z.
const SP_RACE = {
  key: '2026_20_race_2026-11-08T17:00',
  kind: 'race',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z',
  rateSlug: 'sao-paulo'
};
const SP_END = Date.parse(SP_RACE.startsAt) + 2 * HOUR;
const result = (driverId, name, position, status = 'finished') => ({
  driverId,
  name,
  code: null,
  position,
  status
});
const RESULTS = [
  result('max-verstappen', 'Max Verstappen', 1),
  result('lando-norris', 'Lando Norris', 3),
  result('fernando-alonso', 'Fernando Alonso', null, 'dnf'),
  result('oscar-piastri', 'Oscar Piastri', null, 'dsq')
];

/** @param {any[]} results */
function feedWith(results = RESULTS) {
  return parseSchedule({
    v: 1,
    sessions: [SP_RACE],
    season: 2026,
    latestRace: {
      key: SP_RACE.key,
      year: 2026,
      round: 20,
      gp: 'São Paulo Grand Prix',
      rateSlug: 'sao-paulo',
      grandPrixId: 'sao-paulo',
      startsAt: SP_RACE.startsAt,
      results
    },
    seasonResults: {
      'max-verstappen': [1, 1, 2, 1],
      'lando-norris': [2, 3, 1, 4]
    },
    drivers: [
      { id: 'lando-norris', name: 'Lando Norris', code: 'NOR' },
      { id: 'max-verstappen', name: 'Max Verstappen', code: 'VER' }
    ],
    petDrivers: {
      'max-4': 'max-verstappen',
      lando: 'lando-norris',
      alonso: 'fernando-alonso',
      pia: 'oscar-piastri',
      yuki: 'yuki-tsunoda'
    }
  });
}
const FEED = feedWith();

const PETS = new Set([
  'petdex:max-4',
  'petdex:lando',
  'petdex:alonso',
  'petdex:pia',
  'petdex:yuki',
  'petdex:ghost'
]);

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-duo-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {{ at?: number, settings?: Record<string, unknown>, feed?: any, rows?: Record<string, number> }} [options]
 */
function setup({
  at = SP_END + 17 * HOUR,
  settings: overrides = {},
  feed = FEED,
  rows = {}
} = {}) {
  const clock = fakeClock(at);
  const settings = createPetsSettings({ userDataDir: dir });
  const r = settings.update(
    {
      enabled: true,
      activePetId: 'petdex:max-4',
      secondPetId: 'petdex:lando',
      favoriteDriverId: 'max-verstappen',
      resultReactions: true,
      rateNudge: false,
      dailyFact: false,
      ...overrides
    },
    { trusted: true }
  );
  if (!r.ok) throw new Error(r.error);
  const petWindow = fakePetWindow();
  const controller = createPetController({
    settings,
    store: {
      get: (id) =>
        PETS.has(id) ? { atlas: { rows: rows[id] ?? 9, scale: 1 } } : null
    },
    getSessions: () => feed?.sessions ?? [],
    calendarPhase,
    sessionBubble,
    getFeed: () => feed,
    petWindow,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const last = () => petWindow.renders.at(-1);
  return { clock, petWindow, controller, last };
}

/** The payload's `secondAnim` for a PET_STATES state. */
const anim = (state, extra) => {
  const s = STATE[state];
  return {
    state,
    row: s.row,
    frames: s.frames,
    durationMs: s.durationMs,
    once: false,
    still: false,
    playKey: state,
    delayMs: 0,
    ...extra
  };
};

describe('secondAnim is null unless the duo reacts', () => {
  test('a single pet: secondAnim null', () => {
    const { controller, last } = setup({ settings: { secondPetId: null } });
    controller.start();
    expect(last().second).toBeNull();
    expect(last()).toHaveProperty('secondAnim', null);
    expect(last().state).toBe('jumping');
  });

  test('a duo with an unmapped pet: as before (mirrors), no wave', () => {
    const { controller, last, clock } = setup({
      settings: { secondPetId: 'petdex:ghost', resultReactions: false }
    });
    controller.start();
    expect(last().second).not.toBeNull();
    expect(last().secondAnim).toBeNull();
    clock.advance(25 * MIN);
    expect(last().state).toBe('waiting');
    expect(last().secondAnim).toBeNull();
  });
});

describe('result moment: head-to-head poses', () => {
  test('Max P1 (first) vs Norris P3 (second): jump / fail, each once, own length', () => {
    const { controller, last, clock, petWindow } = setup();
    const t0 = clock.now();
    controller.start();
    expect(last()).toMatchObject({
      state: 'jumping',
      once: true,
      playKey: `result:${SP_RACE.key}:${t0}`,
      // The result text, plus the pair's season head-to-head (sprite order:
      // the second pet, Norris, is drawn on the left).
      bubble:
        'Max wins the São Paulo GP! · 2026 · Norris 1–3 Verstappen (races)'
    });
    const failing = anim('failed', {
      once: true,
      playKey: `result:${SP_RACE.key}:${t0}:second`
    });
    expect(last().secondAnim).toEqual(failing);

    clock.advance(stateDurationMs('jumping'));
    expect(last()).toMatchObject({ state: 'idle', once: false });
    // Same playKey: the renderer keeps the second's one-shot running.
    expect(last().secondAnim).toEqual(failing);

    clock.advance(stateDurationMs('failed') - stateDurationMs('jumping'));
    expect(last().secondAnim).toBeNull();
    expect(last().bubble).toContain('Max wins');
    expect(petWindow.renders).toHaveLength(3);
  });

  test('sprites swapped: the first (Norris) fails, the second (Max) jumps; names follow the layout', () => {
    const { controller, last, clock, petWindow } = setup({
      settings: { activePetId: 'petdex:lando', secondPetId: 'petdex:max-4' }
    });
    petWindow.side = 'right';
    const t0 = clock.now();
    controller.start();
    expect(last()).toMatchObject({
      state: 'failed',
      once: true,
      bubble:
        'Max wins the São Paulo GP! · 2026 · Norris 1–3 Verstappen (races)'
    });
    expect(last().secondAnim).toEqual(
      anim('jumping', {
        once: true,
        playKey: `result:${SP_RACE.key}:${t0}:second`
      })
    );
  });

  test('one DNF: the finisher jumps; no season head-to-head → result text only', () => {
    const { controller, last } = setup({
      settings: {
        favoriteDriverId: 'fernando-alonso',
        activePetId: 'petdex:alonso',
        secondPetId: 'petdex:max-4'
      }
    });
    controller.start();
    expect(last()).toMatchObject({
      state: 'failed',
      bubble: 'DNF for Fernando · São Paulo GP'
    });
    expect(last().secondAnim).toMatchObject({ state: 'jumping', once: true });
  });

  test('both unclassified (DNF + DSQ): both fail', () => {
    const { controller, last } = setup({
      settings: {
        favoriteDriverId: 'fernando-alonso',
        activePetId: 'petdex:alonso',
        secondPetId: 'petdex:pia'
      }
    });
    controller.start();
    expect(last()).toMatchObject({ state: 'failed', once: true });
    expect(last().secondAnim).toMatchObject({ state: 'failed', once: true });
  });

  test('equal positions (impossible, handled): both wave', () => {
    const { controller, last } = setup({
      feed: feedWith([
        result('max-verstappen', 'Max Verstappen', 2),
        result('lando-norris', 'Lando Norris', 2)
      ])
    });
    controller.start();
    expect(last()).toMatchObject({ state: 'waving', once: true });
    expect(last().secondAnim).toMatchObject({ state: 'waving', once: true });
  });

  test('a P4–10 favourite: the duo pose replaces the held idle pose', () => {
    const { controller, last } = setup({
      feed: feedWith([
        result('lando-norris', 'Lando Norris', 4),
        result('max-verstappen', 'Max Verstappen', 7)
      ])
    });
    controller.start();
    expect(last()).toMatchObject({
      state: 'failed',
      once: true,
      bubble: 'P7 for Max · São Paulo GP · 2026 · Norris 1–3 Verstappen (races)'
    });
    expect(last().secondAnim).toMatchObject({ state: 'jumping' });
  });

  test('partner without a result in that race: the favourite’s own pose, mirrored', () => {
    const { controller, last } = setup({
      settings: { secondPetId: 'petdex:yuki' }
    });
    controller.start();
    expect(last()).toMatchObject({
      state: 'jumping',
      bubble: 'Max wins the São Paulo GP!'
    });
    expect(last().secondAnim).toBeNull();
  });

  test('a hover during the poses: both wave alike; the second’s pose resumes after', () => {
    const { controller, last, clock } = setup();
    const t0 = clock.now();
    controller.start();
    clock.advance(100);
    controller.petEvent('hover');
    expect(last()).toMatchObject({ state: 'waving' });
    expect(last().secondAnim).toBeNull();
    // Hover over at t0 + 800: both poses resume until their own ends (the
    // first's pose resumes like it does without a duo).
    clock.advance(stateDurationMs('waving'));
    expect(last().state).toBe('jumping');
    expect(last().secondAnim).toMatchObject({
      state: 'failed',
      playKey: `result:${SP_RACE.key}:${t0}:second`
    });
    clock.advance(t0 + stateDurationMs('jumping') - clock.now());
    expect(last().state).toBe('idle');
    expect(last().secondAnim).toMatchObject({ state: 'failed' });
    clock.advance(t0 + stateDurationMs('failed') - clock.now());
    expect(last().secondAnim).toBeNull();
  });
});

describe('ambient: staggered waves', () => {
  test('5 min after the last input the first waves, the second ~0.7 s later', () => {
    const { controller, last, clock, petWindow } = setup({
      settings: { resultReactions: false }
    });
    const t0 = clock.now();
    controller.start();
    expect(last()).toMatchObject({ state: 'idle', secondAnim: null });
    expect(clock.pending()).toEqual([t0 + 5 * MIN]);

    clock.advance(5 * MIN);
    const w = t0 + 5 * MIN;
    const answer = anim('waving', {
      once: true,
      playKey: `duo-wave:${w}:second`,
      delayMs: DUO_WAVE_DELAY_MS
    });
    expect(last()).toMatchObject({
      state: 'waving',
      once: true,
      playKey: `duo-wave:${w}`
    });
    expect(last().secondAnim).toEqual(answer);
    expect(answer.delayMs).toBe(700);
    expect(clock.pending()).toEqual([w + 700]);

    clock.advance(700);
    expect(last()).toMatchObject({ state: 'idle', playKey: 'idle' });
    expect(last().secondAnim).toEqual(answer);
    expect(clock.pending()).toEqual([w + 1400]);

    clock.advance(700);
    expect(last()).toMatchObject({ state: 'idle', secondAnim: null });
    expect(clock.pending()).toEqual([t0 + AMBIENT_WAITING_MS]);

    // 15 and 25 min: once more each, over the waiting loop; then the pair
    // sleeps at 30 min (2b): one still frame, no timer left.
    clock.advance(30 * MIN);
    const waves = petWindow.renders.filter((p) => p.state === 'waving');
    expect(waves.map((p) => p.playKey)).toEqual([
      `duo-wave:${w}`,
      `duo-wave:${t0 + 15 * MIN}`,
      `duo-wave:${t0 + 25 * MIN}`
    ]);
    expect(last()).toMatchObject({
      state: 'idle',
      still: true,
      sleeping: true,
      secondAnim: null
    });
    expect(clock.pending()).toEqual([]);
  });

  test('a hover restarts the schedule; battery stops the waves', () => {
    const { controller, last, clock } = setup({
      settings: { resultReactions: false }
    });
    const t0 = clock.now();
    controller.start();
    clock.advance(4 * MIN);
    controller.petEvent('hover');
    clock.advance(2 * MIN);
    expect(last().state).toBe('idle');
    expect(last().secondAnim).toBeNull();
    clock.advance(3 * MIN);
    expect(last()).toMatchObject({
      state: 'waving',
      playKey: `duo-wave:${t0 + 9 * MIN}`
    });
    controller.setEnvironment({ onBattery: true });
    expect(last()).toMatchObject({ state: 'idle', still: true });
    expect(last().secondAnim).toBeNull();
  });
});

describe('rows fallback: a state the second atlas lacks → idle there', () => {
  test('the first’s state (waiting, row 6) on a 6-row second atlas', () => {
    const { controller, last, clock } = setup({
      settings: { secondPetId: 'petdex:ghost', resultReactions: false },
      rows: { 'petdex:ghost': 6 }
    });
    controller.start();
    expect(last().secondAnim).toBeNull();
    clock.advance(AMBIENT_WAITING_MS);
    expect(last()).toMatchObject({ state: 'waiting', row: 6 });
    expect(last().secondAnim).toEqual(anim('idle'));
  });

  test('the second’s own pose (failed, row 5) on a 5-row atlas', () => {
    const { controller, last } = setup({ rows: { 'petdex:lando': 5 } });
    controller.start();
    expect(last().state).toBe('jumping');
    expect(last().secondAnim).toEqual(anim('idle'));
  });

  test('still applies to the fallback too (locked screen)', () => {
    const { controller, last, clock } = setup({
      settings: { secondPetId: 'petdex:ghost', resultReactions: false },
      rows: { 'petdex:ghost': 6 }
    });
    controller.start();
    clock.advance(AMBIENT_WAITING_MS);
    controller.power('lock-screen');
    expect(last().secondAnim).toEqual(anim('idle', { still: true }));
  });

  // 1b (L1) adds `look-a` (row 9) / `look-b` (row 10) for 8×11 atlases: a v2
  // first pet looking around beside a v1 (9-row) partner.
  const lookA = { id: 'look-a', row: 9, frames: 8, durationMs: 1120 };
  const lookB = { id: 'look-b', row: 10, frames: 8, durationMs: 1120 };

  test('v2 first pet playing look-a / look-b, v1 partner → partner idle', () => {
    for (const look of [lookA, lookB]) {
      expect(
        secondAnimation(
          { still: false, second: null },
          look,
          9 // v1: 8×9
        )
      ).toEqual(anim('idle'));
    }
  });

  test('v2 partner plays the same look (null = mirror)', () => {
    for (const look of [lookA, lookB]) {
      expect(
        secondAnimation({ still: false, second: null }, look, 11)
      ).toBeNull();
    }
  });

  test('own pose that fits passes through; delayMs stays', () => {
    expect(
      secondAnimation(
        {
          still: false,
          second: {
            state: 'waving',
            once: true,
            playKey: 'k',
            delayMs: 700
          }
        },
        STATE.idle,
        9
      )
    ).toEqual(anim('waving', { once: true, playKey: 'k', delayMs: 700 }));
  });
});

describe('timeline: the same controller on a virtual clock', () => {
  test('a mapped duo waves at 5, 15 and 25 min, then never again in the week', () => {
    const now = SP_END + 4 * DAY;
    const timeline = compileTimeline({
      settings: {
        v: 1,
        enabled: true,
        activePetId: 'petdex:max-4',
        secondPetId: 'petdex:lando',
        size: 'm',
        chatReactions: true,
        sessionReactions: 'calm',
        quietUntil: null,
        favoriteDriverId: 'max-verstappen',
        resultReactions: true,
        rateNudge: false,
        dailyFact: false,
        lastResultKey: null,
        lastRateKey: null,
        lastFactDay: null,
        positions: {}
      },
      store: {
        get: (id) =>
          id.startsWith('petdex:') ? { atlas: { rows: 9, scale: 1 } } : null
      },
      feed: FEED,
      resolvePath: (url) => (url.startsWith('pet-asset://') ? '/x.webp' : null),
      nowMs: now
    });
    const waves = timeline.entries
      .filter((e) => e.visible && e.state === 'waving')
      .map((e) => Date.parse(e.at) - now);
    expect(waves).toEqual([5 * MIN, 15 * MIN, 25 * MIN]);
    expect(timeline.entries.length).toBeLessThan(20);
  });
});
