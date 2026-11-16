/**
 * The hand-off timeline per native pet (L6 round 3): a ti-pet-v0.1.1 pet
 * gets a v1 file it can play (no look-around states, no round-3 keys, only
 * the three v1 moment names), a round-3 pet gets v2 (motion, sleep, bubble
 * buttons + kind, the duo partner's own animation, greetings, the static
 * click panel). Each round-3 entry field rides on its own `ready.caps`.
 */
import { describe, test, expect } from 'bun:test';
import { compileTimeline, staticPanel } from './timeline.mjs';
import { NATIVE_CAPS } from './native-protocol.mjs';
import { parseSchedule } from './schedule.mjs';
import { BUBBLE_KINDS } from './behaviour.mjs';
import {
  RATE_NUDGE_AFTER_END_MS,
  RATE_NUDGE_WINDOW_MS,
  SESSION_DURATION_MS
} from './contract.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const RACE = '2026-11-08T17:00:00Z';
const raceEnd = Date.parse(RACE) + SESSION_DURATION_MS.race;
const iso = (ms) => new Date(ms).toISOString();

/** ti-pet-v0.1.1's `ready.caps`, and a round-3 pet's. */
const V1_CAPS = ['duo', 'bubble', 'menu', 'timeline'];
const ALL_CAPS = [...V1_CAPS, ...Object.values(NATIVE_CAPS)];

const FEED = parseSchedule({
  v: 1,
  sessions: [
    {
      key: '2026_19_race',
      kind: 'race',
      year: 2026,
      round: 19,
      gp: 'Mexico City Grand Prix',
      startsAt: '2026-10-25T20:00:00Z',
      rateSlug: 'mexico-city'
    },
    {
      key: '2026_20_qualifying',
      kind: 'qualifying',
      year: 2026,
      round: 20,
      gp: 'São Paulo Grand Prix',
      startsAt: '2026-11-07T18:00:00Z'
    },
    {
      key: '2026_20_race',
      kind: 'race',
      year: 2026,
      round: 20,
      gp: 'São Paulo Grand Prix',
      startsAt: RACE,
      rateSlug: 'sao-paulo'
    }
  ],
  season: 2026,
  latestRace: {
    key: '2026_19_race',
    year: 2026,
    round: 19,
    gp: 'Mexico City Grand Prix',
    results: [
      {
        driverId: 'lando-norris',
        name: 'Lando Norris',
        code: 'NOR',
        position: 1
      },
      {
        driverId: 'max-verstappen',
        name: 'Max Verstappen',
        code: 'VER',
        position: 2
      }
    ]
  },
  seasonResults: {
    'max-verstappen': [1, 1, 2, 1, 2],
    'lando-norris': [2, 3, 1, 4, 1]
  },
  drivers: [
    { id: 'lando-norris', name: 'Lando Norris', code: 'NOR' },
    { id: 'max-verstappen', name: 'Max Verstappen', code: 'VER' }
  ],
  petDrivers: { 'max-4': 'max-verstappen', lando: 'lando-norris' }
});

const SETTINGS = Object.freeze({
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
  rateNudge: true,
  dailyFact: true,
  greetings: true,
  roam: true,
  lastResultKey: null,
  lastRateKey: null,
  lastFactDay: null,
  lastGreetingKey: null,
  positions: {}
});

/** @param {readonly string[]|null} caps */
function compile(caps) {
  return compileTimeline({
    settings: { ...SETTINGS },
    // The first pet is a Petdex v2 sheet (11 rows), its partner v1.
    store: {
      get: (id) =>
        id === 'petdex:max-4'
          ? { atlas: { rows: 11, scale: 1 } }
          : { atlas: { rows: 9, scale: 1 } }
    },
    feed: FEED,
    factFor: (day) => ({
      text: `On this day · ${day}`,
      path: `/stats/on-this-day/${day}`
    }),
    resolvePath: (url) => `/ud/pets/${url.split('/')[3]}.webp`,
    nowMs: NOW,
    secondSide: 'right',
    caps
  });
}

const V1_ENTRY_KEYS = [
  'at',
  'visible',
  'state',
  'row',
  'frames',
  'durationMs',
  'once',
  'still',
  'playKey',
  'bubble',
  'bubbleTarget',
  'duo',
  'moment'
].sort();
const V2_ENTRY_KEYS = [
  'motion',
  'sleeping',
  'bubbleActions',
  'secondAnim',
  'bubbleKind'
];
const V1_MOMENTS = ['lastResultKey', 'lastRateKey', 'lastFactDay'];
const visible = (t) => t.entries.filter((e) => e.visible);

describe('timeline for a ti-pet-v0.1.1 pet', () => {
  test('v1: no look-around state, no round-3 key, only v1 moment names', () => {
    for (const caps of [V1_CAPS, null]) {
      const t = compile(caps);
      expect(t.v).toBe(1);
      expect(t).not.toHaveProperty('panel');
      expect(t.pets.first).toMatchObject({ rows: 11 });
      for (const e of visible(t)) {
        expect(Object.keys(e).sort()).toEqual(V1_ENTRY_KEYS);
        expect(e.state.startsWith('look-')).toBe(false);
        expect(e.row).toBeLessThan(9);
        if (e.moment) expect(V1_MOMENTS).toContain(e.moment.name);
      }
      // The greeting bubbles are there, without their (v2) marker.
      expect(
        visible(t).some(
          (e) =>
            /^(Race day|Qualifying today|Tomorrow)/.test(e.bubble ?? '') &&
            !e.moment
        )
      ).toBe(true);
    }
  });

  test('it gets the same instants as a round-3 pet (looks played as idle)', () => {
    const old = compile(V1_CAPS);
    const capable = compile(ALL_CAPS);
    expect(old.entries.map((e) => e.at)).toEqual(
      capable.entries.map((e) => e.at)
    );
    const looks = visible(capable).filter((e) => e.state.startsWith('look-'));
    expect(looks.length).toBeGreaterThan(0);
    for (const look of looks) {
      expect(old.entries[capable.entries.indexOf(look)]).toMatchObject({
        state: 'idle',
        row: 0,
        frames: 6
      });
    }
  });
});

describe('timeline for a round-3 pet', () => {
  const t = compile(ALL_CAPS);

  test('v2 with every round-3 key on every visible entry', () => {
    expect(t.v).toBe(2);
    for (const e of visible(t)) {
      expect(Object.keys(e).sort()).toEqual(
        [...V1_ENTRY_KEYS, ...V2_ENTRY_KEYS].sort()
      );
      expect([null, 'roam', 'dash']).toContain(e.motion);
      expect(typeof e.sleeping).toBe('boolean');
    }
  });

  test('looks, roaming, a dash at the session start, sleep', () => {
    const states = new Set(visible(t).map((e) => e.state));
    expect(states.has('look-a') && states.has('look-b')).toBe(true);
    expect(visible(t).some((e) => e.motion === 'roam')).toBe(true);
    // The dash runs after the start jump (840 ms), inside the 15 s bubble.
    const dash = visible(t).filter((e) => e.motion === 'dash');
    expect(dash.map((e) => e.at)).toEqual([
      '2026-11-07T18:00:00.840Z',
      '2026-11-08T17:00:00.840Z'
    ]);
    const asleep = visible(t).filter((e) => e.sleeping);
    expect(asleep.length).toBeGreaterThan(0);
    for (const e of asleep) {
      expect(e).toMatchObject({ state: 'idle', still: true, motion: null });
      expect(e.secondAnim).toBeNull();
    }
  });

  test('bubbles carry their kind and buttons; greetings keep their marker', () => {
    for (const e of visible(t)) {
      if (!e.bubble) {
        expect(e.bubbleKind).toBeNull();
        expect(e.bubbleActions).toBeNull();
        continue;
      }
      expect(BUBBLE_KINDS).toContain(e.bubbleKind);
      expect(e.bubbleActions?.[0]).toEqual({ id: 'ok', label: 'OK' });
    }
    const greetings = visible(t).filter(
      (e) => e.moment?.name === 'lastGreetingKey'
    );
    expect(greetings.length).toBeGreaterThan(0);
    for (const e of greetings) {
      expect(e.bubbleKind).toBe('greeting');
      expect(e.moment.value).toMatch(/^\d{4}-\d{2}-\d{2}:(morning|evening)$/);
      expect(e.bubbleActions.at(-1)).toEqual({
        id: 'mute',
        label: 'No greetings'
      });
    }
    const facts = visible(t).filter((e) => e.bubbleKind === 'fact');
    expect(facts[0].bubbleActions.at(-1)).toEqual({
      id: 'mute',
      label: 'No daily facts'
    });
  });

  test('the duo partner’s own animation: delayed waves, idle beside a look', () => {
    const own = visible(t).filter((e) => e.secondAnim);
    for (const e of own) expect(e.duo).toBe(true);
    const waves = own.filter((e) => e.secondAnim.state === 'waving');
    expect(waves.length).toBeGreaterThan(0);
    expect(waves[0].secondAnim).toMatchObject({ row: 3, delayMs: 700 });
    // The 9-row partner cannot play rows 9 / 10: idle while the first looks.
    for (const look of own.filter((e) => e.state.startsWith('look-'))) {
      expect(look.secondAnim).toMatchObject({ state: 'idle', row: 0 });
    }
  });

  test('the static panel: no countdown line (the pet adds it), rate inside its window', () => {
    expect(t.panel).toEqual({
      lines: ['Lando Norris won the Mexico City GP'],
      countdown: true,
      actions: [
        { id: 'ask', label: 'Ask F1', target: '/desktop/ask' },
        {
          id: 'rate',
          label: 'Rate São Paulo GP',
          target: '/rate/2026/sao-paulo/race',
          from: iso(raceEnd + RATE_NUDGE_AFTER_END_MS),
          until: iso(raceEnd + RATE_NUDGE_WINDOW_MS)
        },
        { id: 'stats', label: 'On this day', target: '/stats/on-this-day' },
        { id: 'hot-lap', label: 'Hot lap', target: '/games/rwanda' },
        { id: 'pets', label: 'Pets', target: '/settings/pets' }
      ]
    });
  });

  test('each round-3 entry field rides on its own cap', () => {
    const bare = compile([...V1_CAPS, 'timeline-v2']);
    expect(bare.v).toBe(2);
    expect(bare.panel).toBeDefined();
    for (const e of visible(bare)) {
      expect(Object.keys(e).sort()).toEqual(
        [...V1_ENTRY_KEYS, 'bubbleKind'].sort()
      );
      expect(e.state.startsWith('look-')).toBe(false);
    }
    const motionOnly = compile([...V1_CAPS, 'timeline-v2', 'motion']);
    for (const e of visible(motionOnly)) {
      expect(e).toHaveProperty('motion');
      expect(e).not.toHaveProperty('sleeping');
    }
    // A v2 pet that knows greetings keeps their marker even without other caps.
    expect(
      visible(bare).some((e) => e.moment?.name === 'lastGreetingKey')
    ).toBe(true);
  });
});

describe('staticPanel', () => {
  const race = (key, startsAt, rateSlug) => ({
    key,
    kind: 'race',
    year: 2026,
    round: 1,
    gp: `${key} Grand Prix`,
    startsAt,
    rateSlug
  });

  test('no race window → the fixed actions only', () => {
    const panel = staticPanel({
      feed: { sessions: [] },
      nowMs: NOW,
      untilMs: NOW + 7 * 86_400_000
    });
    expect(panel.lines).toEqual([]);
    expect(panel.actions.map((a) => a.id)).toEqual([
      'ask',
      'stats',
      'hot-lap',
      'pets'
    ]);
  });

  test('a later race’s window cuts the earlier one; at most two rate buttons', () => {
    const day = 86_400_000;
    const sessions = [
      race('A', iso(NOW - day), 'a'),
      race('B', iso(NOW + day), 'b'),
      race('C', iso(NOW + 2 * day), 'c'),
      race('D', iso(NOW + 30 * day), 'd')
    ];
    const panel = staticPanel({
      feed: { sessions },
      nowMs: NOW,
      untilMs: NOW + 7 * day
    });
    const rates = panel.actions.filter((a) => a.id === 'rate');
    // A, B and C overlap the week; the last two are kept, B cut at C's start.
    expect(rates.map((a) => a.target)).toEqual([
      '/rate/2026/b/race',
      '/rate/2026/c/race'
    ]);
    const end = (ms) => ms + SESSION_DURATION_MS.race;
    expect(rates[0].until).toBe(
      iso(end(NOW + 2 * day) + RATE_NUDGE_AFTER_END_MS)
    );
    expect(panel.actions.length).toBeLessThanOrEqual(6);
  });
});
