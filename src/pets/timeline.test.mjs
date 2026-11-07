/**
 * timeline.mjs — the native pet's timeline is the real controller run on a
 * virtual clock. Checked here: the moments of a race weekend land where the
 * live controller puts them, a live controller driven by an independent
 * fake clock produces the same renders, markers stay in the copy, and
 * `refreshAt` picks the earliest recompile point.
 */
import { describe, test, expect } from 'bun:test';
import { createPetController } from './controller.mjs';
import { BUBBLE_MS, SESSION_DURATION_MS } from './contract.mjs';
import {
  calendarPhase,
  parseSchedule,
  sessionBubble,
  upcomingSessions
} from './schedule.mjs';
import { localDayKey, nextLocalHourAt } from './facts.mjs';
import { petAssetUrl } from './protocols.mjs';
import {
  compileTimeline,
  createVirtualClock,
  MIN_REFRESH_MS,
  RACE_REFRESH_AFTER_MS,
  refreshAtFor,
  TIMELINE_HORIZON_MS
} from './timeline.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SP_QUALI = {
  key: '2026_20_qualifying',
  kind: 'qualifying',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-07T18:00:00Z'
};
const SP_RACE = {
  key: '2026_20_race',
  kind: 'race',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z',
  rateSlug: 'sao-paulo'
};
const FEED = parseSchedule({
  v: 1,
  sessions: [SP_QUALI, SP_RACE],
  season: 2026,
  latestRace: null,
  seasonResults: {
    'max-verstappen': [1, 1, 2, 1],
    'lando-norris': [2, 3, 1, 4]
  },
  drivers: [
    { id: 'lando-norris', name: 'Lando Norris', code: 'NOR' },
    { id: 'max-verstappen', name: 'Max Verstappen', code: 'VER' }
  ],
  petDrivers: { 'max-4': 'max-verstappen', lando: 'lando-norris' }
});
const NOW = Date.parse('2026-11-07T12:00:00Z');

const SETTINGS = Object.freeze({
  v: 1,
  enabled: true,
  activePetId: 'petdex:max-4',
  secondPetId: null,
  size: 'm',
  chatReactions: true,
  sessionReactions: 'calm',
  quietUntil: null,
  favoriteDriverId: 'max-verstappen',
  resultReactions: true,
  rateNudge: true,
  dailyFact: true,
  lastResultKey: null,
  lastRateKey: null,
  lastFactDay: null,
  positions: {}
});

const store = {
  get: (id) =>
    id.startsWith('petdex:') ? { atlas: { rows: 9, scale: 1 } } : null
};
const resolvePath = (url) =>
  url.startsWith('pet-asset://')
    ? `/pets/${decodeURIComponent(url.split('/')[3])}.webp`
    : null;
const factFor = (day) => ({
  text: `On this day · ${day}`,
  path: `/stats/on-this-day/${day}`
});

/** The entry in effect at `ms`. */
function entryAt(timeline, ms) {
  let current = null;
  for (const entry of timeline.entries) {
    if (Date.parse(entry.at) <= ms) current = entry;
    else break;
  }
  return current;
}

describe('compileTimeline: a São Paulo weekend', () => {
  const timeline = compileTimeline({
    settings: { ...SETTINGS },
    store,
    feed: FEED,
    factFor,
    resolvePath,
    nowMs: NOW
  });

  test('header, sprites, ascending entries', () => {
    expect(timeline.v).toBe(1);
    expect(timeline.generatedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(Date.parse(timeline.until) - NOW).toBe(TIMELINE_HORIZON_MS);
    expect(timeline.pets).toEqual({
      first: {
        id: 'petdex:max-4',
        path: '/pets/petdex:max-4.webp',
        rows: 9,
        scale: 1
      },
      second: null
    });
    expect(timeline.entries[0]).toMatchObject({
      at: '2026-11-07T12:00:00.000Z',
      visible: true,
      state: 'idle'
    });
    const times = timeline.entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(timeline.sessions).toEqual([
      {
        key: SP_QUALI.key,
        kind: 'qualifying',
        label: 'Qualifying',
        gp: 'São Paulo GP',
        start: '2026-11-07T18:00:00.000Z',
        end: '2026-11-07T19:00:00.000Z'
      },
      {
        key: SP_RACE.key,
        kind: 'race',
        label: 'Race',
        gp: 'São Paulo GP',
        start: '2026-11-08T17:00:00.000Z',
        end: '2026-11-08T19:00:00.000Z'
      }
    ]);
    expect(timeline.duo).toBeNull();
  });

  test('ambient waiting after 10 min with nobody around', () => {
    expect(entryAt(timeline, NOW + 11 * MIN).state).toBe('waiting');
  });

  test('session bubbles at T−30 and at the start (click target: the dashboard)', () => {
    const lead = entryAt(timeline, Date.parse('2026-11-07T17:30:00Z') + 1000);
    expect(lead.bubble).toBe('Qualifying in 30 min · São Paulo GP');
    expect(lead.bubbleTarget).toBe('/');
    expect(lead.moment).toBeNull();
    const lights = entryAt(timeline, Date.parse(SP_RACE.startsAt) + 1000);
    expect(lights.bubble).toBe('Lights out! · São Paulo GP');
  });

  test('rate nudge once, an hour after the race, with its marker', () => {
    const rate = timeline.entries.filter(
      (e) => e.moment?.name === 'lastRateKey'
    );
    expect(rate).toHaveLength(1);
    expect(rate[0].moment.value).toBe(SP_RACE.key);
    expect(rate[0].bubbleTarget).toBe('/rate/2026/sao-paulo/race');
    expect(Date.parse(rate[0].at)).toBeGreaterThanOrEqual(
      Date.parse(SP_RACE.startsAt) + SESSION_DURATION_MS.race + HOUR
    );
  });

  test('one daily fact per local day, each with its day marker', () => {
    const facts = timeline.entries.filter(
      (e) => e.moment?.name === 'lastFactDay'
    );
    const days = facts.map((e) => e.moment.value);
    expect(new Set(days).size).toBe(days.length);
    expect(days.length).toBeGreaterThanOrEqual(6);
    for (const entry of facts) {
      expect(entry.bubble).toBe(`On this day · ${entry.moment.value}`);
      expect(localDayKey(Date.parse(entry.at))).toBe(entry.moment.value);
    }
    // A bubble lasts BUBBLE_MS: the next entry ends it.
    const i = timeline.entries.indexOf(facts[0]);
    expect(
      Date.parse(timeline.entries[i + 1].at) - Date.parse(facts[0].at)
    ).toBeLessThanOrEqual(BUBBLE_MS);
  });

  test('the caller’s settings are never changed (markers live in the copy)', () => {
    const settings = { ...SETTINGS };
    compileTimeline({
      settings,
      store,
      feed: FEED,
      factFor,
      resolvePath,
      nowMs: NOW
    });
    expect(settings).toEqual({ ...SETTINGS });
  });
});

describe('the timeline equals a live controller run', () => {
  test('same renders, same times, three days', () => {
    const horizonMs = 3 * DAY;
    const timeline = compileTimeline({
      settings: { ...SETTINGS },
      store,
      feed: FEED,
      factFor,
      resolvePath,
      nowMs: NOW,
      horizonMs
    });

    // Independent driver: a sorted timer list advanced in one-hour hops.
    let t = NOW;
    const timers = [];
    let seq = 0;
    const copy = { ...SETTINGS };
    const renders = [];
    let shown = false;
    const live = createPetController({
      settings: {
        get: () => ({ ...copy }),
        setQuietUntil: (v) => ((copy.quietUntil = v), { ok: true }),
        setMarker: (n, v) => ((copy[n] = v), { ok: true })
      },
      store,
      getSessions: () => upcomingSessions(FEED, t),
      getFeed: () => FEED,
      facts: {
        today: (ms) => ({ day: localDayKey(ms), ...factFor(localDayKey(ms)) })
      },
      calendarPhase,
      sessionBubble,
      petWindow: {
        isShown: () => shown,
        show: () => (shown = true),
        hide: () => (shown = false),
        render: (p) =>
          renders.push({ at: t, state: p.state, bubble: p.bubble }),
        moveBy: () => {},
        savePosition: () => {}
      },
      support: () => ({ supported: true, needsRestartForPets: false }),
      openMain: () => {},
      now: () => t,
      setTimeout: (fn, ms) => {
        seq += 1;
        timers.push({ id: seq, at: t + ms, fn });
        return seq;
      },
      clearTimeout: (id) => {
        const i = timers.findIndex((x) => x.id === id);
        if (i !== -1) timers.splice(i, 1);
      }
    });
    live.start();
    live.setEnvironment({ onBattery: false, reducedMotion: false });
    for (let hop = NOW + HOUR; hop <= NOW + horizonMs; hop += HOUR) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > hop) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = hop;
    }

    expect(
      timeline.entries.map((e) => ({
        at: Date.parse(e.at),
        state: e.state,
        bubble: e.bubble
      }))
    ).toEqual(renders);
  });
});

describe('refreshAtFor', () => {
  test('earliest of the fact hour, race end + 2 h and the horizon − 1 day', () => {
    const now = Date.parse(SP_RACE.startsAt);
    const until = now + TIMELINE_HORIZON_MS;
    const raceRefresh = now + SESSION_DURATION_MS.race + RACE_REFRESH_AFTER_MS;
    expect(
      refreshAtFor({ nowMs: now, untilMs: until, sessions: [SP_RACE] })
    ).toBe(Math.min(nextLocalHourAt(now, 9), raceRefresh));
    // Past races do not count; never sooner than MIN_REFRESH_MS.
    expect(
      refreshAtFor({
        nowMs: raceRefresh + 1,
        untilMs: raceRefresh + 1 + MIN,
        sessions: [SP_RACE]
      })
    ).toBe(raceRefresh + 1 + MIN_REFRESH_MS);
  });
});

describe('createVirtualClock', () => {
  test('fires in time order, ties in creation order, clears, stops at the horizon', () => {
    const clock = createVirtualClock(0);
    const order = [];
    clock.setTimeout(() => order.push(['b', clock.now()]), 20);
    clock.setTimeout(() => order.push(['a', clock.now()]), 10);
    clock.setTimeout(() => order.push(['a2', clock.now()]), 10);
    const gone = clock.setTimeout(() => order.push(['x']), 5);
    clock.clearTimeout(gone);
    clock.setTimeout(() => order.push(['late']), 1000);
    clock.run(100);
    expect(order).toEqual([
      ['a', 10],
      ['a2', 10],
      ['b', 20]
    ]);
    expect(clock.now()).toBe(100);
  });

  test('a controller that never settles is cut off', () => {
    const clock = createVirtualClock(0);
    const loop = () => clock.setTimeout(loop, 0);
    loop();
    expect(() => clock.run(10, 100)).toThrow('Timeline did not settle.');
  });
});

test('the duo carries its head-to-head line and both sprites', () => {
  const timeline = compileTimeline({
    settings: { ...SETTINGS, secondPetId: 'petdex:lando' },
    store,
    feed: FEED,
    resolvePath,
    nowMs: NOW,
    horizonMs: HOUR,
    secondSide: 'left'
  });
  expect(timeline.pets.second).toEqual({
    id: 'petdex:lando',
    path: '/pets/petdex:lando.webp',
    rows: 9,
    scale: 1
  });
  expect(timeline.entries[0].duo).toBe(true);
  expect(timeline.duo.text).toBe('2026 · Norris 1–3 Verstappen (races)');
  // Sprite URLs are the controller's own (pet-asset://…): resolved, never leaked.
  expect(JSON.stringify(timeline)).not.toContain(
    petAssetUrl('petdex:max-4', 0)
  );
});
