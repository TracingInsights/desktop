import { describe, test, expect } from 'bun:test';
import {
  buildPanel,
  clipText,
  PANEL_LINE_CHARS,
  panelActions,
  panelChangesAt,
  panelLines,
  winnerLine
} from './panel.mjs';
import { ASK_PATH, PANEL_ACTION_IDS } from './contract.mjs';
import { parseSchedule } from './schedule.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// São Paulo GP 2026: race 17:00Z, nominal end 19:00Z; Las Vegas quali later.
const SP_RACE = {
  key: '2026_20_race_2026-11-08T17:00',
  kind: 'race',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z',
  rateSlug: 'sao-paulo'
};
const SP_START = Date.parse(SP_RACE.startsAt);
const SP_END = SP_START + 2 * HOUR;
const LV_QUALI = {
  key: '2026_22_qualifying',
  kind: 'qualifying',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-21T04:00:00Z'
};
const LV_START = Date.parse(LV_QUALI.startsAt);

function feed({ gp = 'São Paulo Grand Prix', sessions } = {}) {
  return parseSchedule({
    v: 1,
    sessions: sessions ?? [{ ...SP_RACE, gp }, LV_QUALI],
    season: 2026,
    latestRace: {
      key: SP_RACE.key,
      year: 2026,
      round: 20,
      gp,
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
          driverId: 'lando-norris',
          name: 'Lando Norris',
          code: 'NOR',
          position: 3,
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
    seasonResults: {},
    drivers: [],
    petDrivers: {}
  });
}
const FEED = feed();
/** The morning after the race: countdown to Las Vegas, rate window open. */
const AFTER = SP_END + 17 * HOUR;

describe('panel lines (round 3, 3a)', () => {
  test('countdown, then the favourite driver’s recent result', () => {
    expect(
      panelLines({
        sessions: FEED.sessions,
        feed: FEED,
        favoriteDriverId: 'max-verstappen',
        nowMs: AFTER
      })
    ).toEqual([
      'Qualifying in 11 d 16 h · Las Vegas GP',
      'Max wins the São Paulo GP!'
    ]);
    const line = (favoriteDriverId) =>
      panelLines({ feed: FEED, favoriteDriverId, nowMs: AFTER });
    expect(line('lando-norris')).toEqual(['P3 for Lando · São Paulo GP']);
    expect(line('fernando-alonso')).toEqual([
      'DNF for Fernando · São Paulo GP'
    ]);
  });

  test('no favourite, a favourite without a result or an old race → the winner', () => {
    const winner = 'Max Verstappen won the São Paulo GP';
    expect(
      panelLines({ feed: FEED, favoriteDriverId: null, nowMs: AFTER })
    ).toEqual([winner]);
    expect(
      panelLines({
        feed: FEED,
        favoriteDriverId: 'oscar-piastri',
        nowMs: AFTER
      })
    ).toEqual([winner]);
    // Lando's P3 is only news for 3 days after the race.
    expect(
      panelLines({
        feed: FEED,
        favoriteDriverId: 'lando-norris',
        nowMs: SP_END + 4 * DAY
      })
    ).toEqual([winner]);
  });

  test('a live session says so; nothing at all → no lines', () => {
    expect(
      panelLines({
        sessions: FEED.sessions,
        feed: null,
        nowMs: LV_START + 10 * MIN
      })
    ).toEqual(['Qualifying is live · Las Vegas GP']);
    expect(panelLines({ sessions: [], feed: null, nowMs: AFTER })).toEqual([]);
    expect(panelLines({ nowMs: AFTER })).toEqual([]);
  });

  test('every line ≤ 60 characters', () => {
    const long = feed({
      gp: 'Extraordinarily Long And Sponsored Name Of The Grand Prix Of Somewhere'
    });
    const lines = panelLines({
      sessions: long.sessions,
      feed: long,
      favoriteDriverId: null,
      nowMs: SP_START - 3 * HOUR
    });
    expect(lines.length).toBe(1);
    for (const line of [
      ...lines,
      ...panelLines({ feed: long, nowMs: AFTER })
    ]) {
      expect(line.length).toBeLessThanOrEqual(PANEL_LINE_CHARS);
    }
    expect(panelLines({ feed: long, nowMs: AFTER })[0]).toEndWith('…');
  });

  test('winnerLine: none before the race starts or without a P1', () => {
    expect(winnerLine(FEED, SP_START - 1)).toBeNull();
    expect(winnerLine(FEED, SP_START)).toBe(
      'Max Verstappen won the São Paulo GP'
    );
    expect(winnerLine(null, AFTER)).toBeNull();
    const noWinner = {
      ...FEED,
      latestRace: { ...FEED.latestRace, results: [] }
    };
    expect(winnerLine(noWinner, AFTER)).toBeNull();
  });

  test('clipText cuts with an ellipsis and folds whitespace', () => {
    expect(clipText('a  b\n c')).toBe('a b c');
    expect(clipText('x'.repeat(61))).toBe(`${'x'.repeat(59)}…`);
    expect(clipText('x'.repeat(60))).toBe('x'.repeat(60));
  });
});

describe('panel actions', () => {
  test('outside the rate window: Ask F1 · On this day · Hot lap · Pets', () => {
    expect(panelActions({ feed: FEED, nowMs: SP_END + 30 * MIN })).toEqual([
      { id: 'ask', label: 'Ask F1', target: ASK_PATH },
      { id: 'stats', label: 'On this day', target: '/stats/on-this-day' },
      { id: 'hot-lap', label: 'Hot lap', target: '/games/rwanda' },
      { id: 'pets', label: 'Pets', target: '/settings/pets' }
    ]);
    expect(panelActions({ feed: FEED, nowMs: SP_END + 3 * DAY }).length).toBe(
      4
    );
    expect(panelActions({ feed: null, nowMs: AFTER }).length).toBe(4);
  });

  test('inside the rate-nudge window: "Rate <short GP>" after Ask F1', () => {
    const actions = panelActions({ feed: FEED, nowMs: AFTER });
    expect(actions.map((a) => a.id)).toEqual([
      'ask',
      'rate',
      'stats',
      'hot-lap',
      'pets'
    ]);
    expect(actions[1]).toEqual({
      id: 'rate',
      label: 'Rate São Paulo GP',
      target: '/rate/2026/sao-paulo/race'
    });
  });

  test('ids come from PANEL_ACTION_IDS, in its order; ask can be left out', () => {
    const all = panelActions({ feed: FEED, nowMs: AFTER }).map((a) => a.id);
    expect(all).toEqual([...PANEL_ACTION_IDS]);
    expect(
      panelActions({ feed: FEED, nowMs: AFTER, ask: false }).map((a) => a.id)
    ).toEqual(['rate', 'stats', 'hot-lap', 'pets']);
  });
});

describe('panelChangesAt / buildPanel', () => {
  test('the countdown changes on whole minutes; a live line when it ends', () => {
    const sessions = [LV_QUALI];
    expect(panelChangesAt({ sessions, nowMs: LV_START - 90_000 })).toBe(
      LV_START - MIN
    );
    expect(panelChangesAt({ sessions, nowMs: LV_START - 2 * MIN })).toBe(
      LV_START - MIN
    );
    expect(panelChangesAt({ sessions, nowMs: LV_START - 30_000 })).toBe(
      LV_START
    );
    expect(panelChangesAt({ sessions, nowMs: LV_START + 10 * MIN })).toBe(
      LV_START + HOUR
    );
    expect(panelChangesAt({ sessions: [], nowMs: AFTER })).toBeNull();
  });

  test('buildPanel: lines + {id, label} actions for the pet, targets kept apart', () => {
    const panel = buildPanel({
      sessions: FEED.sessions,
      feed: FEED,
      favoriteDriverId: 'lando-norris',
      nowMs: AFTER
    });
    expect(panel.lines).toEqual([
      'Qualifying in 11 d 16 h · Las Vegas GP',
      'P3 for Lando · São Paulo GP'
    ]);
    expect(panel.actions).toEqual([
      { id: 'ask', label: 'Ask F1' },
      { id: 'rate', label: 'Rate São Paulo GP' },
      { id: 'stats', label: 'On this day' },
      { id: 'hot-lap', label: 'Hot lap' },
      { id: 'pets', label: 'Pets' }
    ]);
    expect(panel.targets).toEqual({
      ask: '/desktop/ask',
      rate: '/rate/2026/sao-paulo/race',
      stats: '/stats/on-this-day',
      'hot-lap': '/games/rwanda',
      pets: '/settings/pets'
    });
    expect(panel.changesAt).toBe(AFTER + MIN);
  });
});
