/**
 * Controller × race-weekend greetings (round 3, 4c): the once-per-day-part
 * moment, its marker, quiet / busy / live-session hold-backs, wake-ups, the
 * bubble order, locale formatting through the controller, and the native
 * timeline carrying it — with a fake clock, the real schedule helpers and
 * real settings on disk. Time zone / locale are injected (São Paulo, UTC−3).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetController, MOMENT_GAP_MS } from './controller.mjs';
import { AMBIENT_SLEEP_MS } from './behaviour.mjs';
import { BUBBLE_MS, DEFAULT_SETTINGS } from './contract.mjs';
import { createPetsSettings } from './settings.mjs';
import {
  calendarPhase,
  parseSchedule,
  sessionBubble,
  upcomingSessions
} from './schedule.mjs';
import { greetingKey, greetingMoment } from './greeting.mjs';
import { compileTimeline } from './timeline.mjs';

const SP = 'America/Sao_Paulo';
/** "2026-11-08T09:00" São Paulo wall clock → ms. */
const sp = (local) => Date.parse(`${local}:00-03:00`);

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
    },
    /** Advance to an absolute instant. */
    to(ms) {
      this.advance(ms - t);
    }
  };
}

function fakePetWindow() {
  const renders = [];
  let shown = false;
  return {
    renders,
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

const session = (key, kind, startsAt, extra = {}) => ({
  key,
  kind,
  year: 2026,
  round: 21,
  gp: 'São Paulo Grand Prix',
  startsAt,
  ...extra
});
/** Sprint weekend, São Paulo local: SQ Fri 15:30, sprint Sat 11:00, quali Sat 15:00, race Sun 14:00. */
const WEEKEND = [
  session('sq', 'sprint-qualifying', '2026-11-06T18:30:00Z'),
  session('sprint', 'sprint', '2026-11-07T14:00:00Z'),
  session('quali', 'qualifying', '2026-11-07T18:00:00Z'),
  session('race', 'race', '2026-11-08T17:00:00Z', { rateSlug: 'sao-paulo' })
];
const feedOf = (sessions) => parseSchedule({ v: 1, sessions });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-greeting-ctl-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {{ at: number, sessions?: any[], settings?: Record<string, unknown>, locale?: string, keepSettings?: boolean }} options
 */
function setup({
  at,
  sessions = WEEKEND,
  settings: overrides = {},
  locale = 'en-GB',
  keepSettings = false
}) {
  const clock = fakeClock(at);
  const settings = createPetsSettings({ userDataDir: dir });
  if (!keepSettings) {
    const r = settings.update(
      {
        enabled: true,
        activePetId: 'petdex:max-4',
        resultReactions: false,
        rateNudge: false,
        dailyFact: false,
        greetings: true,
        ...overrides
      },
      { trusted: true }
    );
    if (!r.ok) throw new Error(r.error);
  }
  const petWindow = fakePetWindow();
  const opened = [];
  const state = { feed: feedOf(sessions) };
  const controller = createPetController({
    settings,
    store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
    getSessions: () => upcomingSessions(state.feed, clock.now()),
    getFeed: () => state.feed,
    calendarPhase,
    sessionBubble,
    petWindow,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: (path) => opened.push(path ?? null),
    now: clock.now,
    locale,
    timeZone: SP,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const last = () => petWindow.renders.at(-1);
  /** Bubble texts rendered since `from` (render index), consecutive repeats folded. */
  const bubblesSince = (from) => {
    const out = [];
    for (const r of petWindow.renders.slice(from)) {
      if (r.bubble && out.at(-1) !== r.bubble) out.push(r.bubble);
    }
    return out;
  };
  return {
    clock,
    controller,
    settings,
    last,
    opened,
    petWindow,
    bubblesSince,
    state
  };
}

describe('greeting moment', () => {
  test('wakes at 06:00 on race day, once; marker saved; click opens the schedule', () => {
    const { clock, controller, settings, last, opened } = setup({
      at: sp('2026-11-08T05:00')
    });
    controller.start();
    expect(last().bubble).toBeNull();
    // Asleep by 05:30; the 06:00 day-part start is the next timer.
    clock.to(sp('2026-11-08T05:30'));
    expect(last()).toMatchObject({ state: 'idle', sleeping: true });
    expect(clock.pending()).toEqual([sp('2026-11-08T06:00')]);
    clock.to(sp('2026-11-08T06:00'));
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
    // The bubble wakes the pet while it shows.
    expect(last()).toMatchObject({ state: 'waiting', sleeping: false });
    expect(settings.get().lastGreetingKey).toBe('2026-11-08:morning');
    expect(controller.currentBubble()).toEqual({
      key: 'greeting:2026-11-08:morning',
      kind: 'greeting',
      target: '/',
      marker: { name: 'lastGreetingKey', value: '2026-11-08:morning' }
    });
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/']);
    expect(last().bubble).toBeNull();
  });

  test('once per day part: not again this morning, again in the evening', () => {
    const { clock, controller, settings, last, petWindow, bubblesSince } =
      setup({ at: sp('2026-11-07T06:30') });
    controller.start();
    expect(last().bubble).toBe('Sprint today at 11:00 · São Paulo GP');
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBeNull();
    const from = petWindow.renders.length;
    clock.to(sp('2026-11-07T11:59'));
    // Only the calendar's own bubbles this morning.
    expect(bubblesSince(from)).toEqual([
      'Sprint in 30 min · São Paulo GP',
      'Sprint is live'
    ]);
    clock.to(sp('2026-11-07T17:00'));
    expect(last().bubble).toBe('Tomorrow: Race at 14:00 · São Paulo GP');
    expect(settings.get().lastGreetingKey).toBe('2026-11-07:evening');
  });

  test('a restart in the same day part does not repeat it', () => {
    const first = setup({ at: sp('2026-11-08T07:00') });
    first.controller.start();
    expect(first.last().bubble).toMatch(/^Race day!/);
    first.controller.stop();
    const again = setup({ at: sp('2026-11-08T09:00'), keepSettings: true });
    again.controller.start();
    expect(again.last().bubble).toBeNull();
    again.clock.to(sp('2026-11-08T11:59'));
    expect(again.bubblesSince(0)).toEqual([]);
  });

  test('never during quiet (no marker); shows when quiet ends in the day part', () => {
    const { clock, controller, settings, last } = setup({
      at: sp('2026-11-08T06:00')
    });
    settings.setQuietUntil(new Date(sp('2026-11-08T07:00')).toISOString());
    controller.start();
    expect(last().bubble).toBeNull();
    expect(settings.get().lastGreetingKey).toBeNull();
    clock.to(sp('2026-11-08T07:00'));
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
    expect(settings.get().lastGreetingKey).toBe('2026-11-08:morning');
  });

  test('waits for a busy pet (chat), then shows', () => {
    const { clock, controller, last, settings } = setup({
      at: sp('2026-11-08T08:00')
    });
    controller.signal('streaming');
    controller.start();
    expect(last()).toMatchObject({ state: 'running', bubble: null });
    expect(settings.get().lastGreetingKey).toBeNull();
    controller.signal('done');
    expect(last()).toMatchObject({ state: 'jumping', bubble: null });
    clock.advance(1000);
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
  });

  test('a live session holds it back; it shows when the session ends (sessions off too)', () => {
    const sessions = [
      session('early', 'qualifying', '2026-11-08T09:30:00Z'), // 06:30–07:30
      WEEKEND[3]
    ];
    const { clock, controller, last, settings } = setup({
      at: sp('2026-11-08T06:45'),
      sessions,
      settings: { sessionReactions: 'off' }
    });
    controller.start();
    expect(last().bubble).toBeNull();
    clock.to(sp('2026-11-08T07:15'));
    expect(last()).toMatchObject({ sleeping: true, bubble: null });
    expect(settings.get().lastGreetingKey).toBeNull();
    // No calendar timers with sessions off: the session end is the wake-up.
    expect(clock.pending()).toEqual([sp('2026-11-08T07:30')]);
    clock.to(sp('2026-11-08T07:30'));
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
  });

  test('switched off: nothing, no marker; switching off hides a showing one', () => {
    const off = setup({
      at: sp('2026-11-08T06:30'),
      settings: { greetings: false }
    });
    off.controller.start();
    off.clock.to(sp('2026-11-08T11:59'));
    expect(off.bubblesSince(0)).toEqual([]);
    expect(off.settings.get().lastGreetingKey).toBeNull();
    off.controller.stop();

    rmSync(dir, { recursive: true, force: true });
    const on = setup({ at: sp('2026-11-08T06:30') });
    on.controller.start();
    expect(on.last().bubble).toMatch(/^Race day!/);
    on.settings.update({ greetings: false });
    on.controller.refresh();
    expect(on.last().bubble).toBeNull();
  });

  test('no greeting wake-ups with nothing scheduled', () => {
    const { clock, controller, last } = setup({
      at: sp('2026-11-08T05:00'),
      sessions: []
    });
    controller.start();
    clock.advance(AMBIENT_SLEEP_MS);
    expect(last().sleeping).toBe(true);
    expect(clock.pending()).toEqual([]);
  });

  test('a bad time zone never breaks rendering (no greeting)', () => {
    const { clock, controller, last } = setup({ at: sp('2026-11-08T07:00') });
    const errors = [];
    const win = fakePetWindow();
    const broken = createPetController({
      settings: {
        get: () => ({
          ...DEFAULT_SETTINGS,
          enabled: true,
          activePetId: 'petdex:max-4'
        }),
        setQuietUntil: () => ({ ok: true })
      },
      store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
      getSessions: () => WEEKEND,
      calendarPhase,
      sessionBubble,
      petWindow: win,
      support: () => ({ supported: true, needsRestartForPets: false }),
      openMain: () => {},
      now: clock.now,
      timeZone: 'Mars/Olympus_Mons',
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onError: (error) => errors.push(error)
    });
    broken.start();
    expect(errors).toEqual([]);
    expect(win.renders.at(-1)).toMatchObject({
      state: 'idle',
      bubble: null
    });
    // The real controller next to it still greets.
    controller.start();
    expect(last().bubble).toMatch(/^Race day!/);
  });

  test('en-US gets 12 h times, en-GB 24 h', () => {
    const us = setup({ at: sp('2026-11-06T17:30'), locale: 'en-US' });
    us.controller.start();
    expect(us.last().bubble).toMatch(
      /^Tomorrow: Sprint at 11:00\sAM · São Paulo GP$/
    );
    us.controller.stop();
    rmSync(dir, { recursive: true, force: true });
    const gb = setup({ at: sp('2026-11-06T17:30'), locale: 'en-GB' });
    gb.controller.start();
    expect(gb.last().bubble).toBe('Tomorrow: Sprint at 11:00 · São Paulo GP');
  });
});

describe('greeting × other bubbles', () => {
  test('a calendar bubble showing makes it wait', () => {
    const sessions = [
      session('early', 'qualifying', '2026-11-08T09:30:00Z'), // 06:30 local
      WEEKEND[3]
    ];
    const { clock, controller, last } = setup({
      at: sp('2026-11-08T05:50'),
      sessions
    });
    controller.start();
    clock.to(sp('2026-11-08T06:00'));
    expect(last().bubble).toBe('Qualifying in 30 min · São Paulo GP');
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
  });

  test('due together with a rate nudge: the greeting first, the nudge after the calm gap', () => {
    // Saturday race (ends 16:00, nudge due 17:00) and a Sunday race.
    const sessions = [
      session('sat', 'race', '2026-11-07T17:00:00Z', {
        gp: 'Saturday Grand Prix',
        rateSlug: 'saturday'
      }),
      WEEKEND[3]
    ];
    const { clock, controller, last } = setup({
      at: sp('2026-11-07T16:50'),
      sessions,
      settings: { rateNudge: true }
    });
    controller.start();
    clock.to(sp('2026-11-07T17:00'));
    expect(last().bubble).toBe('Tomorrow: Race at 14:00 · São Paulo GP');
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBeNull();
    clock.advance(MOMENT_GAP_MS);
    expect(last().bubble).toBe('Rate the Saturday GP');
  });
});

describe('greeting × click panel and bubble buttons (3a / 2e)', () => {
  test('an open panel holds it back (no marker); it shows once the panel closes', () => {
    const { clock, controller, settings, last } = setup({
      at: sp('2026-11-08T05:59')
    });
    controller.start();
    controller.petEvent('click');
    expect(last().panel).not.toBeNull();
    clock.to(sp('2026-11-08T06:00'));
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
    expect(last().panel).not.toBeNull();
    expect(settings.get().lastGreetingKey).toBeNull();
    controller.petEvent('panelAction', 'close');
    expect(last()).toMatchObject({
      panel: null,
      bubble: 'Race day! Lights out at 14:00 · São Paulo GP'
    });
    expect(settings.get().lastGreetingKey).toBe('2026-11-08:morning');
  });

  test('"No greetings" switches greetings off through the page path', () => {
    const { controller, settings, last, opened } = setup({
      at: sp('2026-11-08T06:30')
    });
    controller.start();
    expect(last().bubble).toBe('Race day! Lights out at 14:00 · São Paulo GP');
    expect(last().bubbleActions).toEqual([
      { id: 'ok', label: 'OK' },
      { id: 'quiet-1h', label: 'Quiet 1 h' },
      { id: 'mute', label: 'No greetings' }
    ]);
    controller.petEvent('bubbleAction', 'mute');
    // `greetings` is page-writable, so the page path takes it.
    expect(settings.get().greetings).toBe(false);
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
    expect(opened).toEqual([]);
  });
});

describe('native timeline', () => {
  const base = {
    v: 1,
    enabled: true,
    activePetId: 'petdex:max-4',
    secondPetId: null,
    size: 'm',
    chatReactions: true,
    sessionReactions: 'calm',
    quietUntil: null,
    favoriteDriverId: null,
    resultReactions: false,
    rateNudge: false,
    dailyFact: false,
    lastResultKey: null,
    lastRateKey: null,
    lastFactDay: null,
    lastGreetingKey: null,
    positions: {}
  };
  const compile = (settings) =>
    compileTimeline({
      settings,
      store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
      feed: feedOf(WEEKEND),
      resolvePath: () => '/pets/max-4/spritesheet.webp',
      nowMs: Date.parse('2026-11-03T12:00:00Z')
    });

  const GREETING_RE = /^(Race day! |Tomorrow: |\S.* today at )/;
  const V1_MOMENTS = ['lastResultKey', 'lastRateKey', 'lastFactDay'];

  // The timeline's controller runs on the system clock's zone: compare
  // against the pure helpers in that zone instead of fixed strings.
  test('carries each greeting bubble once per day part, without a marker the pinned native pet rejects', () => {
    const timeline = compile({ ...base, greetings: true });
    const feed = feedOf(WEEKEND);
    const isGreeting = (entry) => {
      if (!entry.bubble) return false;
      const at = Date.parse(entry.at);
      const expected = greetingMoment({
        sessions: upcomingSessions(feed, at),
        nowMs: at
      });
      return expected !== null && entry.bubble === expected.text;
    };
    const greetings = timeline.entries.filter(isGreeting);
    expect(greetings.length).toBeGreaterThan(0);
    for (const entry of greetings) {
      expect(entry.bubbleTarget).toBe('/');
      // ti-pet-v0.1.1 only knows the three round-2 marker names.
      expect(entry.moment).toBeNull();
    }
    for (const entry of timeline.entries) {
      if (entry.moment) expect(V1_MOMENTS).toContain(entry.moment.name);
    }
    // Each day part's greeting shows in one unbroken run (never repeated).
    const runs = [];
    for (const entry of timeline.entries) {
      const key = isGreeting(entry) ? greetingKey(Date.parse(entry.at)) : null;
      if (key === null || runs.at(-1) !== key) runs.push(key);
    }
    const shown = runs.filter((k) => k !== null);
    expect(new Set(shown).size).toBe(shown.length);
    // Asleep between moments: the ambient still frame.
    expect(timeline.entries.some((e) => e.state === 'idle' && e.still)).toBe(
      true
    );
  });

  test('none when switched off (or on an old settings file without the key)', () => {
    expect(
      GREETING_RE.test('Race day! Lights out at 14:00 · São Paulo GP')
    ).toBe(true);
    for (const settings of [{ ...base, greetings: false }, { ...base }]) {
      const timeline = compile(settings);
      expect(
        timeline.entries.some((e) => GREETING_RE.test(e.bubble ?? ''))
      ).toBe(false);
    }
  });
});
