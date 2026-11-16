/**
 * Sleep (round 3, 2b): after AMBIENT_SLEEP_MS without pet / chat / window
 * input the ambient pet sleeps — idle still frame + `sleeping` — between
 * the 10-min `waiting` loop and any input; higher layers and bubbles win.
 * Pure behaviour first, then the controller on a fake clock.
 */
import { describe, test, expect } from 'bun:test';
import {
  AMBIENT_SLEEP_MS,
  AMBIENT_WAITING_MS,
  computeBehaviour,
  stateDurationMs
} from './behaviour.mjs';
import { createPetController } from './controller.mjs';
import { BUBBLE_MS, DEFAULT_SETTINGS, SESSION_LEAD_MS } from './contract.mjs';
import { calendarPhase, sessionBubble } from './schedule.mjs';

const T0 = Date.parse('2026-11-12T10:00:00Z');
const MIN = 60_000;

/** @param {Partial<import('./behaviour.mjs').BehaviourInput>} [over] */
const input = (over = {}) => ({
  nowMs: T0 + AMBIENT_SLEEP_MS,
  lastActivityAtMs: T0,
  sessionReactions: 'calm',
  ...over
});

describe('computeBehaviour — sleep', () => {
  test('idle → waiting at 10 min → asleep at 30 min', () => {
    expect(AMBIENT_SLEEP_MS).toBe(30 * MIN);
    const idle = computeBehaviour(input({ nowMs: T0 }));
    expect(idle).toMatchObject({
      state: 'idle',
      still: false,
      sleeping: false
    });
    expect(idle.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);

    const waiting = computeBehaviour(
      input({ nowMs: T0 + AMBIENT_SLEEP_MS - 1 })
    );
    expect(waiting).toMatchObject({
      state: 'waiting',
      still: false,
      sleeping: false,
      layer: 'ambient'
    });
    // waiting → sleep is the next change point
    expect(waiting.nextChangeAt).toBe(T0 + AMBIENT_SLEEP_MS);

    const asleep = computeBehaviour(input());
    expect(asleep).toEqual({
      state: 'idle',
      once: false,
      still: true,
      bubble: null,
      playKey: 'sleeping',
      layer: 'ambient',
      sleeping: true,
      motion: null,
      second: null,
      nextChangeAt: null
    });
  });

  test('asleep: no roaming (2a), no look-around (1b), no duo waves (4b)', () => {
    const awake = { roam: true, atlasRows: 11, duo: { result: null } };
    // Awake, the same input walks, and the looks and waves are planned.
    expect(computeBehaviour(input({ ...awake, nowMs: T0 }))).toMatchObject({
      motion: 'roam',
      sleeping: false,
      nextChangeAt: T0 + 4 * MIN
    });
    for (let t = AMBIENT_SLEEP_MS; t <= 3 * AMBIENT_SLEEP_MS; t += 7_919) {
      expect(computeBehaviour(input({ ...awake, nowMs: T0 + t }))).toEqual({
        state: 'idle',
        once: false,
        still: true,
        bubble: null,
        playKey: 'sleeping',
        layer: 'ambient',
        sleeping: true,
        motion: null,
        second: null,
        nextChangeAt: null
      });
    }
  });

  test('input moves the clock: awake again, asleep 30 min after it', () => {
    const now = T0 + 2 * AMBIENT_SLEEP_MS;
    const out = computeBehaviour(input({ nowMs: now, lastActivityAtMs: now }));
    expect(out).toMatchObject({ state: 'idle', still: false, sleeping: false });
    expect(out.nextChangeAt).toBe(now + AMBIENT_WAITING_MS);
  });

  test('reduce motion, battery, a locked screen: still asleep (all still)', () => {
    for (const over of [
      { reducedMotion: true },
      { onBattery: true },
      { locked: true }
    ]) {
      expect(computeBehaviour(input(over))).toMatchObject({
        state: 'idle',
        still: true,
        sleeping: true
      });
    }
  });

  test('a hover wakes it (waving once)', () => {
    const now = T0 + AMBIENT_SLEEP_MS + MIN;
    const out = computeBehaviour(
      input({ nowMs: now, interaction: { kind: 'hover', atMs: now } })
    );
    expect(out).toMatchObject({
      state: 'waving',
      once: true,
      sleeping: false,
      layer: 'interaction'
    });
  });

  test('higher layers win over sleep', () => {
    const now = T0 + AMBIENT_SLEEP_MS + MIN;
    const cases = [
      [{ chat: { signal: 'streaming', atMs: now } }, 'running', 'chat'],
      [
        { celebration: { atMs: now, text: 'PB!', target: '/games/rwanda' } },
        'jumping',
        'celebrate'
      ],
      [{ quietUntilMs: now + MIN }, 'idle', 'quiet'],
      [
        {
          moment: {
            kind: 'result',
            key: 'r',
            text: 'Max wins!',
            target: '/x',
            atMs: now,
            state: 'jumping',
            once: true
          }
        },
        'jumping',
        'moment'
      ]
    ];
    for (const [over, state, layer] of cases) {
      expect(computeBehaviour(input({ nowMs: now, ...over }))).toMatchObject({
        state,
        layer,
        sleeping: false
      });
    }
    // Lively during a live session: the running loop.
    const race = {
      key: 'race',
      kind: 'race',
      gp: 'Test GP',
      startsAt: new Date(now - 5 * MIN).toISOString()
    };
    expect(
      computeBehaviour(
        input({
          nowMs: now,
          sessionReactions: 'lively',
          calendar: { phase: 'live', session: race, nextBoundaryAt: null }
        })
      )
    ).toMatchObject({ state: 'running', layer: 'calendar', sleeping: false });
  });

  test('a bubble keeps it awake (waiting) until the bubble ends', () => {
    const now = T0 + AMBIENT_SLEEP_MS + MIN;
    const fact = {
      kind: 'fact',
      key: '2026-11-12',
      text: 'On this day · …',
      target: '/stats/on-this-day/nov-12',
      atMs: now,
      state: null,
      once: false
    };
    const during = computeBehaviour(input({ nowMs: now, moment: fact }));
    expect(during).toMatchObject({
      state: 'waiting',
      still: false,
      sleeping: false,
      bubble: { kind: 'fact', text: 'On this day · …' }
    });
    expect(during.nextChangeAt).toBe(now + BUBBLE_MS);
    const after = computeBehaviour(
      input({ nowMs: now + BUBBLE_MS, moment: fact })
    );
    expect(after).toMatchObject({ bubble: null, sleeping: true, still: true });
    // A dismissed bubble no longer keeps it awake.
    expect(
      computeBehaviour(
        input({
          nowMs: now,
          moment: fact,
          dismissedBubbleKey: 'fact:2026-11-12'
        })
      )
    ).toMatchObject({ bubble: null, sleeping: true });
  });
});

// --- Controller ---

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

function setup({ sessions = [], settings: over = {} } = {}) {
  const clock = fakeClock(T0);
  const current = {
    ...DEFAULT_SETTINGS,
    enabled: true,
    activePetId: 'petdex:lando',
    greetings: false,
    ...over
  };
  const renders = [];
  let shown = false;
  const controller = createPetController({
    settings: {
      get: () => ({ ...current }),
      setQuietUntil: (iso) => {
        current.quietUntil = iso;
        return { ok: true };
      }
    },
    store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
    getSessions: () => sessions,
    calendarPhase,
    sessionBubble,
    petWindow: {
      show: () => {
        shown = true;
      },
      hide: () => {
        shown = false;
      },
      isShown: () => shown,
      render: (payload) => renders.push(payload),
      moveBy: () => {},
      savePosition: () => {}
    },
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  return { clock, controller, renders, last: () => renders.at(-1) };
}

describe('controller — sleep', () => {
  test('payload: sleeping false while awake, true + still when asleep; no timer while asleep', () => {
    const { clock, controller, last } = setup();
    controller.start();
    expect(last()).toMatchObject({
      state: 'idle',
      still: false,
      sleeping: false
    });
    clock.advance(AMBIENT_WAITING_MS);
    expect(last()).toMatchObject({ state: 'waiting', sleeping: false });
    expect(clock.pending()).toEqual([T0 + AMBIENT_SLEEP_MS]);
    clock.advance(AMBIENT_SLEEP_MS - AMBIENT_WAITING_MS);
    expect(last()).toMatchObject({
      state: 'idle',
      row: 0,
      still: true,
      sleeping: true
    });
    expect(clock.pending()).toEqual([]);
  });

  test('hover wakes it: wave, then awake idle; asleep again 30 min later', () => {
    const { clock, controller, last } = setup();
    controller.start();
    clock.advance(AMBIENT_SLEEP_MS + 5 * MIN);
    expect(last().sleeping).toBe(true);
    const hoverAt = clock.now();
    controller.petEvent('hover');
    expect(last()).toMatchObject({
      state: 'waving',
      once: true,
      sleeping: false
    });
    clock.advance(stateDurationMs('waving'));
    expect(last()).toMatchObject({
      state: 'idle',
      still: false,
      sleeping: false
    });
    clock.advance(hoverAt + AMBIENT_SLEEP_MS - clock.now() - 1);
    expect(last()).toMatchObject({ state: 'waiting', sleeping: false });
    clock.advance(1);
    expect(last().sleeping).toBe(true);
  });

  test('main-window activity wakes a sleeping pet at once', () => {
    const { clock, controller, last, renders } = setup();
    controller.start();
    clock.advance(AMBIENT_SLEEP_MS);
    expect(last().sleeping).toBe(true);
    controller.noteActivity();
    expect(last()).toMatchObject({
      state: 'idle',
      still: false,
      sleeping: false
    });
    // An awake idle pet is not re-rendered by activity.
    const count = renders.length;
    controller.noteActivity();
    expect(renders.length).toBe(count);
  });

  test('chat wins; after it the sleep timer counts from the last signal', () => {
    const { clock, controller, last } = setup();
    controller.start();
    clock.advance(AMBIENT_SLEEP_MS);
    controller.signal('streaming');
    expect(last()).toMatchObject({ state: 'running', sleeping: false });
    clock.advance(MIN);
    controller.signal('done');
    const lastSignal = clock.now();
    clock.advance(stateDurationMs('jumping'));
    expect(last()).toMatchObject({ state: 'idle', sleeping: false });
    clock.advance(lastSignal + AMBIENT_SLEEP_MS - clock.now());
    expect(last().sleeping).toBe(true);
  });

  test('a calendar moment wakes it for its bubble, then it sleeps again', () => {
    const start = T0 + AMBIENT_SLEEP_MS + SESSION_LEAD_MS + 10 * MIN;
    const race = {
      key: 'race',
      kind: 'race',
      gp: 'Las Vegas Grand Prix',
      startsAt: new Date(start).toISOString()
    };
    const { clock, controller, last } = setup({ sessions: [race] });
    controller.start();
    clock.advance(AMBIENT_SLEEP_MS);
    expect(last().sleeping).toBe(true);
    clock.advance(start - SESSION_LEAD_MS - clock.now());
    expect(last()).toMatchObject({
      state: 'waiting',
      once: true,
      sleeping: false,
      bubble: 'Race in 30 min · Las Vegas GP'
    });
    clock.advance(BUBBLE_MS - 1);
    expect(last()).toMatchObject({ sleeping: false });
    clock.advance(1);
    expect(last()).toMatchObject({ bubble: null, sleeping: true, still: true });
  });
});
