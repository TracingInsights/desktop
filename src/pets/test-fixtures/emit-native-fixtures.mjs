/**
 * Emits the JSON fixtures the native pet's Zig tests read
 * (TracingInsights/petdex `packages/ti-pet/tests/fixtures/`), so both sides
 * agree on the timeline file and the hover countdown byte for byte:
 *
 *   bun src/pets/test-fixtures/emit-native-fixtures.mjs <out-dir>
 *
 * - timeline-weekend.json — compileTimeline() over a São Paulo weekend with
 *   a duo (synthetic pet ids, sprite paths under FIXTURE_USER_DATA; no art)
 * - timeline-quiet.json   — the same weekend compiled while Quiet runs
 * - countdown-cases.json  — formatCountdown / countdownText outputs for a
 *   grid of instants over the timeline's own `sessions`
 *
 * Runs in UTC (the daily-fact hour is local time) so reruns are identical.
 */
process.env.TZ = 'UTC';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSchedule, countdownText, formatCountdown } from '../schedule.mjs';
import { compileTimeline } from '../timeline.mjs';

export const FIXTURE_USER_DATA = '/tmp/ti-pet-fixture/ud';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-07T12:00:00Z');

const FEED = parseSchedule({
  v: 1,
  sessions: [
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
      startsAt: '2026-11-08T17:00:00Z',
      rateSlug: 'sao-paulo'
    }
  ],
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
    ? // Real store folders are `<source>-<key>` (pet-store.mjs): no ':', which
      // a Windows path could not hold anyway.
      `${FIXTURE_USER_DATA}/pets/${decodeURIComponent(url.split('/')[3]).replace(':', '-')}/spritesheet.webp`
    : null;
const factFor = (day) => ({
  text: `On this day · ${day}`,
  path: `/stats/on-this-day/${day}`
});

const compile = (settings) =>
  compileTimeline({
    settings,
    store,
    feed: FEED,
    factFor,
    resolvePath,
    nowMs: NOW,
    secondSide: 'right'
  });

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: bun emit-native-fixtures.mjs <out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const write = (name, value) =>
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);

const weekend = compile({ ...SETTINGS });
write('timeline-weekend.json', weekend);
write(
  'timeline-quiet.json',
  compile({ ...SETTINGS, quietUntil: '2026-11-07T19:30:00.000Z' })
);

// The hover countdown over the compiled sessions (start/end → startsAt).
const sessions = weekend.sessions.map((s) => ({
  kind: s.kind,
  gp: s.gp.replace(/ GP$/, ' Grand Prix'),
  startsAt: s.start
}));
const instants = [];
for (let t = NOW - HOUR; t <= Date.parse(weekend.until); t += 37 * MIN) {
  instants.push(t);
}
instants.push(
  Date.parse('2026-11-07T18:00:00Z'),
  Date.parse('2026-11-07T18:59:59.999Z'),
  Date.parse('2026-11-07T19:00:00Z'),
  Date.parse('2026-11-08T16:59:00.001Z'),
  Date.parse('2026-11-08T19:00:00Z')
);
const durations = [
  -5,
  0,
  1,
  59_999,
  60_000,
  60_001,
  14 * MIN,
  59 * MIN + 1,
  60 * MIN,
  134 * MIN,
  120 * MIN,
  24 * 60 * MIN,
  (3 * 24 + 4) * 60 * MIN,
  (6 * 24 + 23) * 60 * MIN + 30_000
];
write('countdown-cases.json', {
  format: durations.map((ms) => ({ ms, text: formatCountdown(ms) })),
  hover: instants.map((now) => ({
    now: new Date(now).toISOString(),
    text: countdownText(sessions, now)
  }))
});
console.log(`wrote 3 fixtures to ${outDir}`);
