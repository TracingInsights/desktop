/**
 * Controller × companion features (docs/DESKTOP_PETS_PLAN.md §12): duo
 * payload, hover countdown / head-to-head, result reaction, rate nudge,
 * daily fact, celebrations — with a fake clock, the real schedule helpers
 * and real settings on disk (so the once-only markers survive a restart).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CELEBRATE_MIN_INTERVAL_MS,
  createPetController,
  MOMENT_GAP_MS
} from './controller.mjs';
import {
  AMBIENT_WAITING_MS,
  HOVER_BUBBLE_MS,
  stateDurationMs
} from './behaviour.mjs';
import { BUBBLE_MS, CHAT_SIGNAL_TTL_MS } from './contract.mjs';
import { createPetsSettings } from './settings.mjs';
import { calendarPhase, parseSchedule, sessionBubble } from './schedule.mjs';
import { localDayKey, onThisDaySlug } from './facts.mjs';
import { petAssetUrl } from './protocols.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

function fakeClock(start) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
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
  const calls = [];
  let shown = false;
  return {
    renders,
    calls,
    /** Where the window draws the second sprite (the real one: left). */
    side: 'left',
    secondSide() {
      return this.side;
    },
    show(options) {
      shown = true;
      calls.push(['show', options]);
    },
    hide() {
      shown = false;
      calls.push(['hide']);
    },
    isShown: () => shown,
    render: (payload) => renders.push(payload),
    moveBy: () => {},
    savePosition: () => {}
  };
}

/** Facts stand-in: `undefined` text = still fetching (today() → null). */
function fakeFacts(...args) {
  const calls = [];
  let current =
    args.length > 0 ? args[0] : 'On this day · 1994: Japan — winner Damon Hill';
  return {
    calls,
    set(next) {
      current = next;
    },
    today(nowMs) {
      calls.push(nowMs);
      if (current === undefined) return null;
      const slug = onThisDaySlug(nowMs);
      return {
        day: localDayKey(nowMs),
        slug,
        text: current,
        path: `/stats/on-this-day/${slug}`
      };
    }
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
const LV_QUALI = {
  key: '2026_22_qualifying',
  kind: 'qualifying',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-21T04:00:00Z'
};
const results = [
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
];
const FEED = parseSchedule({
  v: 1,
  sessions: [SP_RACE, LV_QUALI],
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
  petDrivers: { 'max-4': 'max-verstappen', lando: 'lando-norris' }
});

const PETS = new Set(['petdex:max-4', 'petdex:lando', 'petdex:pia']);

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-companion-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {{ at?: number, settings?: Record<string, unknown>, feed?: any, facts?: any, keepSettings?: boolean }} [options]
 */
function setup({
  at = SP_END + 17 * HOUR,
  settings: overrides = {},
  feed = FEED,
  facts = null,
  keepSettings = false
} = {}) {
  const clock = fakeClock(at);
  const settings = createPetsSettings({ userDataDir: dir });
  if (!keepSettings) {
    const r = settings.update(
      {
        enabled: true,
        activePetId: 'petdex:max-4',
        favoriteDriverId: 'max-verstappen',
        resultReactions: true,
        rateNudge: false,
        dailyFact: false,
        ...overrides
      },
      { trusted: true }
    );
    if (!r.ok) throw new Error(r.error);
  }
  const petWindow = fakePetWindow();
  const opened = [];
  const state = { feed };
  const controller = createPetController({
    settings,
    store: {
      get: (id) => (PETS.has(id) ? { atlas: { rows: 9, scale: 1 } } : null)
    },
    getSessions: () => state.feed?.sessions ?? [],
    calendarPhase,
    sessionBubble,
    getFeed: () => state.feed,
    facts,
    petWindow,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: (path) => opened.push(path ?? null),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const last = () => petWindow.renders.at(-1);
  return { clock, petWindow, opened, controller, settings, last, state };
}

describe('duo render payload (#8)', () => {
  test('second pet = { url, rows, scale }; the window is shown as a duo', () => {
    const { controller, last, petWindow } = setup({
      settings: { secondPetId: 'petdex:lando' }
    });
    controller.start();
    expect(petWindow.calls[0]).toEqual(['show', { size: 'm', duo: true }]);
    expect(last().second).toEqual({
      url: petAssetUrl('petdex:lando', 0),
      rows: 9,
      scale: 1
    });
    controller.assetsChanged();
    expect(last().second.url).toBe(petAssetUrl('petdex:lando', 1));
    expect(last().atlas.url).toBe(petAssetUrl('petdex:max-4', 1));
  });

  test('no second pet when unset, the same as the first, or not installed', () => {
    for (const secondPetId of [null, 'petdex:max-4', 'petdex:gone']) {
      const { controller, last, petWindow } = setup({
        settings: { secondPetId }
      });
      controller.start();
      expect(last().second).toBeNull();
      expect(petWindow.calls[0][1].duo).toBe(false);
      controller.stop();
    }
  });
});

describe('hover (#2 countdown, #8 head-to-head)', () => {
  const beforeQuali = Date.parse(LV_QUALI.startsAt) - (2 * HOUR + 14 * MIN);

  test('waving + countdown bubble for HOVER_BUBBLE_MS; click opens /', () => {
    const { controller, last, clock, opened } = setup({
      at: beforeQuali,
      settings: { resultReactions: false }
    });
    controller.start();
    controller.petEvent('hover');
    expect(last()).toMatchObject({
      state: 'waving',
      bubble: 'Qualifying in 2 h 14 min · Las Vegas GP'
    });
    clock.advance(HOVER_BUBBLE_MS - 1);
    expect(last().bubble).not.toBeNull();
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/']);
    expect(last().bubble).toBeNull();
  });

  test('the bubble expires on its own timer; a click does not cut it short', () => {
    const { controller, last, clock } = setup({
      at: beforeQuali,
      settings: { resultReactions: false }
    });
    controller.start();
    controller.petEvent('hover');
    clock.advance(1000);
    controller.petEvent('click');
    expect(last()).toMatchObject({ state: 'jumping' });
    expect(last().bubble).toContain('Qualifying in');
    clock.advance(HOVER_BUBBLE_MS);
    expect(last().bubble).toBeNull();
  });

  test('sessionReactions off: waves, no countdown', () => {
    const { controller, last } = setup({
      at: beforeQuali,
      settings: { resultReactions: false, sessionReactions: 'off' }
    });
    controller.start();
    controller.petEvent('hover');
    expect(last()).toMatchObject({ state: 'waving', bubble: null });
  });

  test('quiet: waves, no bubble', () => {
    const { controller, last } = setup({
      at: beforeQuali,
      settings: { resultReactions: false }
    });
    controller.start();
    controller.quiet('1h');
    controller.petEvent('hover');
    expect(last()).toMatchObject({ state: 'waving', bubble: null });
  });

  test('nothing scheduled: waves, no bubble', () => {
    const { controller, last } = setup({
      at: Date.parse('2027-06-01T00:00:00Z'),
      settings: { resultReactions: false }
    });
    controller.start();
    controller.petEvent('hover');
    expect(last()).toMatchObject({ state: 'waving', bubble: null });
  });

  test('duo with both pets mapped: season head-to-head, click opens the comparison', () => {
    const { controller, last, opened } = setup({
      at: beforeQuali,
      settings: { resultReactions: false, secondPetId: 'petdex:lando' }
    });
    controller.start();
    controller.petEvent('hover');
    // The second pet (Norris) is drawn left of the first (Verstappen).
    expect(last().bubble).toBe('2026 · Norris 1–3 Verstappen (races)');
    controller.petEvent('bubbleClick');
    expect(opened).toEqual([
      '/stats/compare/drivers?ids=lando-norris,max-verstappen&from=2026&to=2026'
    ]);
  });

  test('duo head-to-head names follow the window layout side', () => {
    const { controller, last, petWindow, clock } = setup({
      at: beforeQuali,
      settings: { resultReactions: false, secondPetId: 'petdex:lando' }
    });
    petWindow.side = 'right';
    controller.start();
    controller.petEvent('hover');
    expect(last().bubble).toBe('2026 · Verstappen 3–1 Norris (races)');
    clock.advance(HOVER_BUBBLE_MS);
    petWindow.side = 'left';
    controller.petEvent('hover');
    expect(last().bubble).toBe('2026 · Norris 1–3 Verstappen (races)');
  });

  test('duo with an unmapped pet falls back to the countdown', () => {
    const { controller, last } = setup({
      at: beforeQuali,
      settings: { resultReactions: false, secondPetId: 'petdex:pia' }
    });
    controller.start();
    controller.petEvent('hover');
    expect(last().bubble).toBe('Qualifying in 2 h 14 min · Las Vegas GP');
  });
});

describe('result reaction (#1)', () => {
  test('P1: jumping + bubble once; marker saved; click opens the race page', () => {
    const { controller, last, settings, clock, opened } = setup();
    controller.start();
    expect(last()).toMatchObject({
      state: 'jumping',
      once: true,
      bubble: 'Max wins the São Paulo GP!'
    });
    expect(settings.get().lastResultKey).toBe(SP_RACE.key);
    clock.advance(stateDurationMs('jumping'));
    expect(last()).toMatchObject({
      state: 'idle',
      bubble: 'Max wins the São Paulo GP!'
    });
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/stats/races/2026/20/sao-paulo']);
    expect(last().bubble).toBeNull();
  });

  test('never twice: not after it expires, not after a restart', () => {
    const first = setup();
    first.controller.start();
    first.clock.advance(BUBBLE_MS);
    expect(first.last().bubble).toBeNull();
    first.clock.advance(MOMENT_GAP_MS + HOUR);
    first.controller.refresh();
    expect(first.last().bubble).toBeNull();
    first.controller.stop();

    const restarted = setup({ keepSettings: true });
    restarted.controller.start();
    expect(restarted.last().bubble).toBeNull();
    expect(restarted.last().state).toBe('idle');
  });

  test('podium waves (with the driver short name), DNF plays failed', () => {
    const p3 = setup({ settings: { favoriteDriverId: 'lando-norris' } });
    p3.controller.start();
    expect(p3.last()).toMatchObject({
      state: 'waving',
      bubble: 'P3 for Lando · São Paulo GP'
    });
    rmSync(dir, { recursive: true, force: true });
    const dnf = setup({ settings: { favoriteDriverId: 'fernando-alonso' } });
    dnf.controller.start();
    expect(dnf.last()).toMatchObject({
      state: 'failed',
      bubble: 'DNF for Fernando · São Paulo GP'
    });
  });

  test('switched off, no favourite, or the favourite not in the race → nothing, no marker', () => {
    for (const settings of [
      { resultReactions: false },
      { favoriteDriverId: null },
      { favoriteDriverId: 'oscar-piastri' }
    ]) {
      rmSync(dir, { recursive: true, force: true });
      const run = setup({ settings });
      run.controller.start();
      expect(run.last().bubble).toBeNull();
      expect(run.settings.get().lastResultKey).toBeNull();
      run.controller.stop();
    }
  });

  test('too old a race → nothing', () => {
    const { controller, last } = setup({ at: SP_END + 3 * 24 * HOUR });
    controller.start();
    expect(last().bubble).toBeNull();
  });

  test('quiet holds it back (no marker); it shows when quiet ends', () => {
    const { controller, last, settings, clock } = setup();
    settings.setQuietUntil(new Date(clock.now() + HOUR).toISOString());
    controller.start();
    expect(last().bubble).toBeNull();
    expect(settings.get().lastResultKey).toBeNull();
    clock.advance(HOUR);
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
  });

  test('locked screen holds it back; unlock shows it', () => {
    const { controller, last, settings } = setup();
    controller.power('lock-screen');
    controller.start();
    expect(last().bubble).toBeNull();
    expect(settings.get().lastResultKey).toBeNull();
    controller.power('unlock-screen');
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
  });

  test('waits for chat activity to end (signal TTL expiry)', () => {
    const { controller, last, clock, settings } = setup();
    controller.signal('streaming');
    controller.start();
    expect(last()).toMatchObject({ state: 'running', bubble: null });
    expect(settings.get().lastResultKey).toBeNull();
    clock.advance(CHAT_SIGNAL_TTL_MS);
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
  });

  test('a feed arriving later triggers it on the next refresh', () => {
    const { controller, last, state } = setup({ feed: null });
    controller.start();
    expect(last().bubble).toBeNull();
    controller.signal('streaming');
    state.feed = FEED;
    controller.refresh();
    expect(last()).toMatchObject({ state: 'running', bubble: null });
    controller.signal('idle');
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
  });

  test('switching resultReactions off hides the showing bubble', () => {
    const { controller, last, settings } = setup();
    controller.start();
    expect(last().bubble).not.toBeNull();
    settings.update({ resultReactions: false });
    controller.refresh();
    expect(last().bubble).toBeNull();
  });

  test('a hidden pet never consumes the moment', () => {
    const { controller, settings, petWindow } = setup({
      settings: { enabled: false }
    });
    controller.start();
    expect(petWindow.renders).toHaveLength(0);
    expect(settings.get().lastResultKey).toBeNull();
  });
});

describe('rate nudge (#4)', () => {
  test('wakes at nominal end + 1 h, once; click opens /rate', () => {
    const { controller, last, clock, settings, opened } = setup({
      at: SP_END,
      settings: { resultReactions: false, rateNudge: true }
    });
    controller.start();
    expect(last().bubble).toBeNull();
    // One timer: the ambient threshold first, then exactly end + 1 h.
    clock.advance(AMBIENT_WAITING_MS);
    expect(last().state).toBe('waiting');
    expect(clock.pending()).toEqual([SP_END + HOUR]);
    clock.advance(HOUR - AMBIENT_WAITING_MS - 1);
    expect(last().bubble).toBeNull();
    clock.advance(1);
    expect(last().bubble).toBe('Rate the São Paulo GP');
    expect(settings.get().lastRateKey).toBe(SP_RACE.key);
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/rate/2026/sao-paulo/race']);
  });

  test('not after a restart; not when switched off', () => {
    const first = setup({
      at: SP_END + 2 * HOUR,
      settings: { resultReactions: false, rateNudge: true }
    });
    first.controller.start();
    expect(first.last().bubble).toBe('Rate the São Paulo GP');
    first.controller.stop();
    const again = setup({ at: SP_END + 3 * HOUR, keepSettings: true });
    again.controller.start();
    expect(again.last().bubble).toBeNull();
    again.controller.stop();

    rmSync(dir, { recursive: true, force: true });
    const off = setup({
      at: SP_END,
      settings: { resultReactions: false, rateNudge: false }
    });
    off.controller.start();
    off.clock.advance(AMBIENT_WAITING_MS);
    // Only the (capped) calendar wake remains, no end + 1 h nudge timer.
    expect(off.clock.pending()).not.toContain(SP_END + HOUR);
    expect(off.clock.pending()).toHaveLength(1);
    off.clock.advance(2 * HOUR);
    off.controller.refresh();
    expect(off.last().bubble).toBeNull();
  });

  test('a calendar bubble showing makes it wait', () => {
    const lead = {
      ...LV_QUALI,
      key: 'soon',
      startsAt: new Date(SP_END + HOUR + 20 * MIN).toISOString()
    };
    const feed = { ...FEED, sessions: [...FEED.sessions, lead] };
    const { controller, last, clock } = setup({
      at: SP_END + HOUR - 10 * MIN,
      feed,
      settings: { resultReactions: false, rateNudge: true }
    });
    controller.start();
    // T−30 lead bubble for "soon" starts 10 min before the nudge is due.
    expect(last().bubble).toBe('Qualifying in 30 min · Las Vegas GP');
    clock.advance(10 * MIN);
    // Lead bubble has expired (BUBBLE_MS) → the nudge is free to show.
    expect(last().bubble).toBe('Rate the São Paulo GP');
  });
});

describe('moment order: result first, then the rate nudge after a calm gap', () => {
  test('never two bubbles at once', () => {
    const { controller, last, clock } = setup({
      settings: { rateNudge: true }
    });
    controller.start();
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBeNull();
    clock.advance(MOMENT_GAP_MS - 1);
    expect(last().bubble).toBeNull();
    clock.advance(1);
    expect(last().bubble).toBe('Rate the São Paulo GP');
  });
});

describe('daily fact (#3)', () => {
  const local = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime();
  const factSettings = { resultReactions: false, dailyFact: true };

  test('nothing before 09:00 local; a timer for 09:00; then the fact once', () => {
    const facts = fakeFacts();
    const { controller, last, clock, settings, opened } = setup({
      at: local(12, 8, 30),
      facts,
      settings: factSettings
    });
    controller.start();
    expect(last().bubble).toBeNull();
    expect(facts.calls).toHaveLength(0);
    clock.advance(AMBIENT_WAITING_MS);
    expect(clock.pending()).toEqual([local(12, 9)]);
    clock.advance(30 * MIN - AMBIENT_WAITING_MS);
    expect(last().bubble).toBe('On this day · 1994: Japan — winner Damon Hill');
    expect(settings.get().lastFactDay).toBe('2026-11-12');
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/stats/on-this-day/nov-12']);
  });

  test('a fetch still in flight: shows once the facts module reports in', () => {
    const facts = fakeFacts(undefined);
    const { controller, last } = setup({
      at: local(12, 10),
      facts,
      settings: factSettings
    });
    controller.start();
    expect(last().bubble).toBeNull();
    facts.set('On this day · 1999: Something');
    controller.refresh();
    expect(last().bubble).toBe('On this day · 1999: Something');
  });

  test('waits for an idle pet', () => {
    const facts = fakeFacts();
    const { controller, last } = setup({
      at: local(12, 10),
      facts,
      settings: factSettings
    });
    controller.signal('planning');
    controller.start();
    expect(last()).toMatchObject({ state: 'running', bubble: null });
    controller.signal('idle');
    expect(last().bubble).toContain('On this day');
  });

  test('once per local day, across restarts; the next day again', () => {
    const facts = fakeFacts();
    const first = setup({ at: local(12, 10), facts, settings: factSettings });
    first.controller.start();
    expect(first.last().bubble).toContain('On this day');
    first.controller.stop();

    const again = setup({ at: local(12, 15), facts, keepSettings: true });
    again.controller.start();
    expect(again.last().bubble).toBeNull();
    again.clock.set(local(13, 8));
    again.controller.refresh();
    expect(again.last().bubble).toBeNull();
    again.clock.advance(HOUR);
    expect(again.last().bubble).toContain('On this day');
    expect(again.settings.get().lastFactDay).toBe('2026-11-13');
  });

  test('switched off: the facts module is never asked', () => {
    const facts = fakeFacts();
    const { controller, last } = setup({
      at: local(12, 10),
      facts,
      settings: { resultReactions: false, dailyFact: false }
    });
    controller.start();
    expect(last().bubble).toBeNull();
    expect(facts.calls).toHaveLength(0);
  });

  test('a quiet day (no text): no bubble, no marker', () => {
    const facts = fakeFacts(null);
    const { controller, last, settings } = setup({
      at: local(12, 10),
      facts,
      settings: factSettings
    });
    controller.start();
    expect(last().bubble).toBeNull();
    expect(settings.get().lastFactDay).toBeNull();
  });
});

describe('celebrate (#6)', () => {
  test('jumping + the game text; click opens the game', () => {
    const { controller, last, opened } = setup({
      settings: { resultReactions: false }
    });
    controller.start();
    expect(controller.celebrate('hot-lap-pb', 'New PB · 1:31.204')).toEqual({
      ok: true,
      shown: true
    });
    expect(last()).toMatchObject({
      state: 'jumping',
      once: true,
      bubble: 'New PB · 1:31.204'
    });
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/games/rwanda']);
  });

  test('at most one per 10 s; extra calls are dropped', () => {
    const { controller, last, clock } = setup({
      settings: { resultReactions: false }
    });
    controller.start();
    controller.celebrate('roadster-best', 'First');
    clock.advance(CELEBRATE_MIN_INTERVAL_MS - 1);
    expect(controller.celebrate('roadster-best', 'Second')).toEqual({
      ok: true,
      shown: false
    });
    expect(last().bubble).toBe('First');
    clock.advance(1);
    expect(controller.celebrate('roadster-best', 'Third').shown).toBe(true);
    expect(last().bubble).toBe('Third');
  });

  test('dropped while quiet, locked or with no pet; unknown kinds refused', () => {
    const quiet = setup({ settings: { resultReactions: false } });
    quiet.controller.start();
    quiet.controller.quiet('1h');
    expect(quiet.controller.celebrate('hot-lap-pb', 'PB').shown).toBe(false);
    expect(quiet.last().bubble).toBeNull();
    quiet.controller.stop();

    const locked = setup({ settings: { resultReactions: false } });
    locked.controller.start();
    locked.controller.power('lock-screen');
    expect(locked.controller.celebrate('hot-lap-pb', 'PB').shown).toBe(false);
    locked.controller.stop();

    const hidden = setup({ settings: { enabled: false } });
    hidden.controller.start();
    expect(hidden.controller.celebrate('hot-lap-pb', 'PB').shown).toBe(false);
    expect(hidden.controller.celebrate('confetti', 'x')).toEqual({
      ok: false,
      error: 'Unknown celebration.'
    });
  });

  test('text is one clean line; empty → the kind default', () => {
    const { controller, last, clock } = setup({
      settings: { resultReactions: false }
    });
    controller.start();
    controller.celebrate('hot-lap-pb', '  New\nPB\u0000   ok ');
    expect(last().bubble).toBe('New PB ok');
    clock.advance(CELEBRATE_MIN_INTERVAL_MS);
    controller.celebrate('hot-lap-pb', '   ');
    expect(last().bubble).toBe('New personal best!');
    clock.advance(CELEBRATE_MIN_INTERVAL_MS);
    controller.celebrate('roadster-best', '');
    expect(last().bubble).toBe('New best run!');
  });

  test('a hover bubble outranks it; it returns after the hover', () => {
    const { controller, last, clock } = setup({
      at: Date.parse(LV_QUALI.startsAt) - 3 * HOUR,
      settings: { resultReactions: false }
    });
    controller.start();
    controller.celebrate('hot-lap-pb', 'PB!');
    clock.advance(stateDurationMs('jumping'));
    controller.petEvent('hover');
    expect(last().bubble).toBe('Qualifying in 3 h · Las Vegas GP');
    clock.advance(HOVER_BUBBLE_MS);
    expect(last().bubble).toBe('PB!');
  });

  test('a celebration showing holds a result back until it ends', () => {
    const { controller, last, clock, state } = setup({ feed: null });
    controller.start();
    controller.celebrate('hot-lap-pb', 'PB!');
    state.feed = FEED;
    controller.refresh();
    expect(last().bubble).toBe('PB!');
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBe('Max wins the São Paulo GP!');
  });
});

describe('bubble click with no bubble', () => {
  test('opens the home page', () => {
    const { controller, opened } = setup({
      settings: { resultReactions: false }
    });
    controller.start();
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/']);
  });
});
