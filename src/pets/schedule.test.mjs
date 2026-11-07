import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calendarPhase,
  countdownText,
  createSchedule,
  formatCountdown,
  nextSession,
  MAX_PLAN_DELAY_MS,
  nextPlanDelay,
  parseSchedule,
  SCHEDULE_CACHE_FILE,
  sessionBubble
} from './schedule.mjs';
import { SCHEDULE_REFRESH_MS } from './contract.mjs';

const MIN = 60_000;
const session = (kind, startsAt, extra = {}) => ({
  key: `2026_22_${kind}_${startsAt}`,
  kind,
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt,
  ...extra
});
const QUALI = session('qualifying', '2026-11-21T04:00:00Z');
const RACE = session('race', '2026-11-22T04:00:00Z');
const doc = { v: 1, sessions: [RACE, QUALI] };
const at = (iso) => Date.parse(iso);

describe('parseSchedule', () => {
  test('sorts and keeps valid sessions', () => {
    expect(parseSchedule(doc).sessions.map((s) => s.kind)).toEqual([
      'qualifying',
      'race'
    ]);
  });
  test('drops invalid sessions one by one; wrong shape → null', () => {
    const parsed = parseSchedule({
      v: 1,
      sessions: [
        QUALI,
        { ...RACE, kind: 'fp1' },
        { ...RACE, startsAt: 'soon' },
        { ...RACE, startsAt: '2026-11-22T04:00:00' },
        { ...RACE, round: 0 },
        QUALI,
        null
      ]
    });
    expect(parsed.sessions).toEqual([QUALI]);
    expect(parseSchedule({ v: 2, sessions: [] })).toBeNull();
    expect(parseSchedule({ v: 1 })).toBeNull();
    expect(parseSchedule('x')).toBeNull();
  });
});

describe('calendarPhase', () => {
  const sessions = parseSchedule(doc).sessions;
  test('quiet before the lead window, next boundary = lead start', () => {
    expect(calendarPhase(sessions, at('2026-11-21T00:00:00Z'))).toEqual({
      phase: null,
      session: null,
      nextBoundaryAt: at('2026-11-21T03:30:00Z')
    });
  });
  test('lead window', () => {
    const r = calendarPhase(sessions, at('2026-11-21T03:40:00Z'));
    expect(r.phase).toBe('lead');
    expect(r.session).toEqual(QUALI);
    expect(r.nextBoundaryAt).toBe(at('2026-11-21T04:00:00Z'));
  });
  test('live, ends after the nominal duration', () => {
    const live = calendarPhase(sessions, at('2026-11-21T04:59:00Z'));
    expect(live).toMatchObject({
      phase: 'live',
      session: QUALI,
      nextBoundaryAt: at('2026-11-21T05:00:00Z')
    });
    expect(
      calendarPhase(sessions, at('2026-11-21T05:00:00Z')).phase
    ).toBeNull();
    expect(calendarPhase(sessions, at('2026-11-22T05:59:00Z')).phase).toBe(
      'live'
    );
    expect(calendarPhase(sessions, at('2026-11-22T06:00:00Z'))).toEqual({
      phase: null,
      session: null,
      nextBoundaryAt: null
    });
  });
  test('a live session wins over the next lead window', () => {
    const sq = session('sprint-qualifying', '2026-05-01T10:00:00Z');
    const sprint = session('sprint', '2026-05-01T10:30:00Z');
    expect(
      calendarPhase([sq, sprint], at('2026-05-01T10:10:00Z')).session
    ).toBe(sq);
  });
  test('planning delay across sessions is capped at 6 h', () => {
    const sessions2 = parseSchedule(doc).sessions;
    expect(nextPlanDelay(sessions2, at('2026-11-20T00:00:00Z'))).toBe(
      MAX_PLAN_DELAY_MS
    );
    expect(nextPlanDelay(sessions2, at('2026-11-21T03:00:00Z'))).toBe(30 * MIN);
    expect(nextPlanDelay([], 0)).toBe(MAX_PLAN_DELAY_MS);
    // After a sleep that skipped a boundary, re-planning from "now" lands on the next one.
    expect(nextPlanDelay(sessions2, at('2026-11-21T04:30:00Z'))).toBe(30 * MIN);
  });
});

describe('sessionBubble', () => {
  test('texts', () => {
    expect(sessionBubble(QUALI, 'lead', at('2026-11-21T03:30:00Z'))).toBe(
      'Qualifying in 30 min · Las Vegas GP'
    );
    expect(sessionBubble(QUALI, 'lead', at('2026-11-21T03:59:30Z'))).toBe(
      'Qualifying in 1 min · Las Vegas GP'
    );
    expect(sessionBubble(RACE, 'live', 0)).toBe('Lights out! · Las Vegas GP');
    expect(sessionBubble(QUALI, 'live', 0)).toBe('Qualifying is live');
    expect(sessionBubble(session('sprint', RACE.startsAt), 'live', 0)).toBe(
      'Sprint is live'
    );
    expect(
      sessionBubble(session('sprint-qualifying', RACE.startsAt), 'live', 0)
    ).toBe('Sprint qualifying is live');
    expect(sessionBubble(null, 'live', 0)).toBeNull();
    expect(sessionBubble(QUALI, null, 0)).toBeNull();
  });
});

describe('createSchedule', () => {
  let root;
  let calls;
  let respond;
  let timers;
  let clock;

  const make = () =>
    createSchedule({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return respond(url, init);
      },
      userDataDir: root,
      appUrl: 'https://app.tracinginsights.com',
      now: () => clock,
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => {
        timers = timers.filter((x) => x !== t);
      }
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tif1ai-schedule-'));
    calls = [];
    timers = [];
    clock = at('2026-11-20T00:00:00Z');
    respond = () =>
      new Response(JSON.stringify(doc), { headers: { etag: '"s1"' } });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('fetches on start, caches, emits, refreshes every 24 h with If-None-Match', async () => {
    const schedule = make();
    const changes = [];
    schedule.onChange((s) => changes.push(s.length));
    await schedule.start();
    expect(calls[0].url).toBe(
      'https://app.tracinginsights.com/desktop/schedule.json'
    );
    expect(schedule.sessions().map((s) => s.kind)).toEqual([
      'qualifying',
      'race'
    ]);
    expect(changes).toEqual([2]);
    expect(
      JSON.parse(readFileSync(join(root, SCHEDULE_CACHE_FILE), 'utf8')).etag
    ).toBe('"s1"');

    const refresh = timers.find((t) => t.ms === SCHEDULE_REFRESH_MS);
    expect(refresh).toBeTruthy();
    respond = (_url, init) =>
      new Response(null, {
        status: init.headers['If-None-Match'] === '"s1"' ? 304 : 200
      });
    timers = timers.filter((t) => t !== refresh);
    refresh.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls[1].init.headers['If-None-Match']).toBe('"s1"');
    expect(changes).toEqual([2]);
    expect(timers.filter((t) => t.ms === SCHEDULE_REFRESH_MS)).toHaveLength(1);
    schedule.stop();
    expect(timers.filter((t) => t.ms === SCHEDULE_REFRESH_MS)).toHaveLength(0);
  });

  test('works offline from the cache; invalid responses ignored', async () => {
    await make().start();
    respond = () => {
      throw new Error('offline');
    };
    const offline = make();
    await offline.start();
    expect(offline.sessions()).toHaveLength(2);
    respond = () => new Response(JSON.stringify({ v: 9 }));
    await offline.refresh();
    expect(offline.sessions()).toHaveLength(2);
    offline.stop();
  });

  test('invalid cache file is ignored', async () => {
    writeFileSync(
      join(root, SCHEDULE_CACHE_FILE),
      '{"schedule":{"v":1,"sessions":"x"}}'
    );
    respond = () => new Response('down', { status: 503 });
    const schedule = make();
    await schedule.start();
    expect(schedule.sessions()).toEqual([]);
    schedule.stop();
  });

  test('without an ETag, an identical body does not emit again', async () => {
    respond = () => new Response(JSON.stringify(doc));
    const schedule = make();
    let n = 0;
    schedule.onChange(() => n++);
    await schedule.start();
    await schedule.refresh();
    expect(n).toBe(1);
    expect(calls[1].init.headers['If-None-Match']).toBeUndefined();
    schedule.stop();
  });

  test('past sessions are filtered by the clock', async () => {
    const schedule = make();
    await schedule.start();
    clock = at('2026-11-21T09:00:00Z');
    expect(schedule.sessions().map((s) => s.kind)).toEqual(['race']);
    schedule.stop();
  });
});

// --- Round 2: additive companion fields ---

const SP_RACE = {
  key: '2026_20_race_2026-11-08T17:00',
  kind: 'race',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z',
  rateSlug: 'sao-paulo'
};
const FEED = {
  v: 1,
  sessions: [SP_RACE, QUALI, RACE],
  season: 2026,
  latestRace: {
    key: SP_RACE.key,
    year: 2026,
    round: 20,
    gp: 'São Paulo Grand Prix',
    rateSlug: 'sao-paulo',
    grandPrixId: 'sao-paulo',
    startsAt: SP_RACE.startsAt,
    results: [
      {
        driverId: 'max-verstappen',
        name: 'Max Verstappen',
        code: 'VER',
        position: 1,
        status: 'finished'
      },
      {
        driverId: 'fernando-alonso',
        name: 'Fernando Alonso',
        code: 'ALO',
        position: null,
        status: 'dnf'
      }
    ]
  },
  seasonResults: { 'max-verstappen': [1, null, 3], 'lando-norris': [2, 1, 4] },
  drivers: [
    { id: 'lando-norris', name: 'Lando Norris', code: 'NOR' },
    { id: 'max-verstappen', name: 'Max Verstappen', code: 'VER' }
  ],
  petDrivers: { lando: 'lando-norris', 'max-4': 'max-verstappen' }
};

describe('parseSchedule — companion fields', () => {
  test('parses every additive field', () => {
    const feed = parseSchedule(FEED);
    expect(feed.season).toBe(2026);
    expect(feed.latestRace).toEqual(FEED.latestRace);
    expect(feed.seasonResults).toEqual(FEED.seasonResults);
    expect(feed.drivers).toEqual(FEED.drivers);
    expect(feed.petDrivers).toEqual(FEED.petDrivers);
    expect(
      feed.sessions.find((s) => s.kind === 'race' && s.round === 20)
    ).toEqual(SP_RACE);
  });

  test('an old feed (sessions only) gets empty companion fields', () => {
    expect(parseSchedule(doc)).toEqual({
      v: 1,
      sessions: parseSchedule(doc).sessions,
      season: null,
      latestRace: null,
      seasonResults: {},
      drivers: [],
      petDrivers: {}
    });
  });

  test('invalid companion fields are ignored, never the sessions', () => {
    for (const broken of [
      {
        season: '2026',
        latestRace: 'x',
        seasonResults: [],
        drivers: {},
        petDrivers: 7
      },
      {
        season: 1800,
        latestRace: { key: 'k' },
        seasonResults: null,
        drivers: null,
        petDrivers: []
      },
      { latestRace: { ...FEED.latestRace, year: 'x' } },
      { latestRace: { ...FEED.latestRace, gp: '' } }
    ]) {
      const feed = parseSchedule({ ...FEED, ...broken });
      expect(feed.sessions).toHaveLength(3);
      if ('season' in broken) expect(feed.season).toBeNull();
      if ('latestRace' in broken) expect(feed.latestRace).toBeNull();
    }
  });

  test('bad result rows, rounds, drivers and pet links are dropped one by one', () => {
    const feed = parseSchedule({
      ...FEED,
      latestRace: {
        ...FEED.latestRace,
        rateSlug: 'São Paulo',
        grandPrixId: '../x',
        startsAt: 'Sunday',
        results: [
          FEED.latestRace.results[0],
          { ...FEED.latestRace.results[0] }, // duplicate driver
          { driverId: 'Bad Id', name: 'X', position: 2 },
          { driverId: 'no-name', name: '', position: 3 },
          {
            driverId: 'odd',
            name: 'Odd One',
            code: 'TOOLONG',
            position: 0,
            status: 'dnf<script>'
          },
          null
        ]
      },
      seasonResults: {
        'max-verstappen': [1, 'P2', 0, 3.5, null, 100],
        'Bad Key': [1],
        'too-long': Array.from({ length: 41 }, () => 1),
        'not-array': 3
      },
      drivers: [
        FEED.drivers[0],
        FEED.drivers[0],
        { id: 'x', name: '' },
        { id: 'UPPER', name: 'Upper' },
        'str'
      ],
      petDrivers: {
        lando: 'lando-norris',
        'Bad Slug': 'x',
        pia: 'Oscar',
        schumi: 3
      }
    });
    expect(feed.latestRace.rateSlug).toBeNull();
    expect(feed.latestRace.grandPrixId).toBeNull();
    expect(feed.latestRace.startsAt).toBeNull();
    expect(feed.latestRace.results).toEqual([
      FEED.latestRace.results[0],
      {
        driverId: 'odd',
        name: 'Odd One',
        code: null,
        position: null,
        status: null
      }
    ]);
    expect(feed.seasonResults).toEqual({
      'max-verstappen': [1, null, null, null, null, null]
    });
    expect(feed.drivers).toEqual([FEED.drivers[0]]);
    expect(feed.petDrivers).toEqual({ lando: 'lando-norris' });
  });

  test('status is lower-cased; rateSlug only on race sessions', () => {
    const feed = parseSchedule({
      ...FEED,
      sessions: [
        { ...QUALI, rateSlug: 'las-vegas' },
        { ...RACE, rateSlug: 'Las Vegas' },
        SP_RACE
      ],
      latestRace: {
        ...FEED.latestRace,
        results: [{ ...FEED.latestRace.results[1], status: 'DSQ' }]
      }
    });
    expect(
      feed.sessions.find((s) => s.kind === 'qualifying')
    ).not.toHaveProperty('rateSlug');
    expect(feed.sessions.find((s) => s.key === RACE.key)).not.toHaveProperty(
      'rateSlug'
    );
    expect(feed.latestRace.results[0].status).toBe('dsq');
  });

  test('caps hold (60 results, 80 drivers)', () => {
    const results = Array.from({ length: 70 }, (_, i) => ({
      driverId: `d-${i}`,
      name: `Driver ${i}`,
      position: (i % 99) + 1
    }));
    const drivers = Array.from({ length: 90 }, (_, i) => ({
      id: `d-${i}`,
      name: `Driver ${i}`
    }));
    const feed = parseSchedule({
      ...FEED,
      latestRace: { ...FEED.latestRace, results },
      drivers
    });
    expect(feed.latestRace.results).toHaveLength(60);
    expect(feed.drivers).toHaveLength(80);
  });
});

describe('countdown (hover)', () => {
  test('formatCountdown', () => {
    expect(formatCountdown(1)).toBe('1 min');
    expect(formatCountdown(14 * MIN)).toBe('14 min');
    expect(formatCountdown(59 * MIN + 1)).toBe('1 h');
    expect(formatCountdown(134 * MIN)).toBe('2 h 14 min');
    expect(formatCountdown(120 * MIN)).toBe('2 h');
    expect(formatCountdown(24 * 60 * MIN)).toBe('1 d');
    expect(formatCountdown((3 * 24 + 4) * 60 * MIN)).toBe('3 d 4 h');
  });

  test('nextSession: the live one first, else the next to start', () => {
    const sessions = parseSchedule(doc).sessions;
    expect(nextSession(sessions, at('2026-11-20T00:00:00Z'))).toEqual(QUALI);
    expect(nextSession(sessions, at('2026-11-21T04:30:00Z'))).toEqual(QUALI);
    expect(nextSession(sessions, at('2026-11-21T05:00:00Z'))).toEqual(RACE);
    expect(nextSession(sessions, at('2026-11-22T07:00:00Z'))).toBeNull();
  });

  test('countdownText', () => {
    const sessions = parseSchedule(doc).sessions;
    expect(countdownText(sessions, at('2026-11-21T01:46:00Z'))).toBe(
      'Qualifying in 2 h 14 min · Las Vegas GP'
    );
    expect(countdownText(sessions, at('2026-11-21T04:10:00Z'))).toBe(
      'Qualifying is live · Las Vegas GP'
    );
    expect(countdownText(sessions, at('2026-11-21T05:00:00Z'))).toBe(
      'Race in 23 h · Las Vegas GP'
    );
    expect(countdownText(sessions, at('2026-11-22T05:00:00Z'))).toBe(
      'Race is live · Las Vegas GP'
    );
    expect(countdownText(sessions, at('2026-11-22T06:00:00Z'))).toBeNull();
    expect(countdownText([], 0)).toBeNull();
  });
});

describe('createSchedule — companion getters', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tif1ai-schedule-feed-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (body, clock = at('2026-11-09T00:00:00Z')) =>
    createSchedule({
      fetch: async () => {
        if (body instanceof Error) throw body;
        return new Response(JSON.stringify(body));
      },
      userDataDir: root,
      appUrl: 'https://app.tracinginsights.com',
      now: () => clock,
      setTimeout: () => 0,
      clearTimeout: () => {}
    });

  test('empty before the first fetch', () => {
    const schedule = make(FEED);
    expect(schedule.feed()).toBeNull();
    expect(schedule.season()).toBeNull();
    expect(schedule.latestRace()).toBeNull();
    expect(schedule.seasonResults()).toEqual({});
    expect(schedule.drivers()).toEqual([]);
    expect(schedule.petDrivers()).toEqual({});
    expect(schedule.rateSessions()).toEqual([]);
  });

  test('getters read the fetched feed and the cache after a restart', async () => {
    const first = make(FEED);
    await first.start();
    first.stop();
    const offline = make(new Error('offline'));
    await offline.start();
    for (const schedule of [first, offline]) {
      expect(schedule.season()).toBe(2026);
      expect(schedule.latestRace().key).toBe(SP_RACE.key);
      expect(schedule.seasonResults()['lando-norris']).toEqual([2, 1, 4]);
      expect(schedule.drivers()).toHaveLength(2);
      expect(schedule.petDrivers()).toEqual(FEED.petDrivers);
      // Past races stay in the feed (sessions() drops them).
      expect(schedule.rateSessions()).toEqual([SP_RACE]);
      expect(schedule.feed().sessions).toHaveLength(3);
      expect(schedule.sessions().map((s) => s.key)).toEqual([
        QUALI.key,
        RACE.key
      ]);
    }
    offline.stop();
  });

  test('a round-1 cache file (no companion fields) still loads', async () => {
    writeFileSync(
      join(root, SCHEDULE_CACHE_FILE),
      JSON.stringify({ etag: null, fetchedAt: 1, schedule: doc })
    );
    const schedule = make(new Error('offline'));
    await schedule.start();
    expect(schedule.sessions()).toHaveLength(2);
    expect(schedule.latestRace()).toBeNull();
    expect(schedule.petDrivers()).toEqual({});
    schedule.stop();
  });

  test('a companion-only change emits', async () => {
    let body = doc;
    const schedule = createSchedule({
      fetch: async () => new Response(JSON.stringify(body)),
      userDataDir: root,
      appUrl: 'https://app.tracinginsights.com',
      now: () => at('2026-11-09T00:00:00Z'),
      setTimeout: () => 0,
      clearTimeout: () => {}
    });
    let n = 0;
    schedule.onChange(() => n++);
    await schedule.start();
    body = { ...doc, petDrivers: { lando: 'lando-norris' } };
    await schedule.refresh();
    expect(n).toBe(2);
    expect(schedule.petDrivers()).toEqual({ lando: 'lando-norris' });
    schedule.stop();
  });
});
