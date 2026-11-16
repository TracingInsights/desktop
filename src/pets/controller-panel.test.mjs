/**
 * Controller × round 3 (L4): bubble buttons (2e), the click panel (3a) and
 * the "Answer ready" badge (3b) — fake clock, real settings on disk, the
 * real schedule helpers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetController, QUIET_HOUR_MS } from './controller.mjs';
import { stateDurationMs } from './behaviour.mjs';
import {
  ANSWER_BADGE,
  BUBBLE_MS,
  SESSION_DURATION_MS,
  SESSION_LEAD_MS
} from './contract.mjs';
import { createPetsSettings } from './settings.mjs';
import { calendarPhase, parseSchedule, sessionBubble } from './schedule.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

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

function fakePetWindow(can) {
  const renders = [];
  let shown = false;
  return {
    renders,
    show: () => (shown = true),
    hide: () => (shown = false),
    isShown: () => shown,
    render: (payload) => renders.push(payload),
    moveBy: () => {},
    savePosition: () => {},
    ...(can ? { can } : {})
  };
}

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
const LV_START = Date.parse(LV_QUALI.startsAt);
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
      }
    ]
  },
  seasonResults: {},
  drivers: [],
  petDrivers: {}
});
/** Three hours before Las Vegas qualifying: no bubble, a countdown. */
const QUIET_MORNING = LV_START - 3 * HOUR;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-panel-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {{ at?: number, settings?: Record<string, unknown>, can?: (f: string) => boolean, background?: boolean }} [options]
 */
function setup({
  at = QUIET_MORNING,
  settings: overrides = {},
  can,
  background = true
} = {}) {
  const clock = fakeClock(at);
  // Own settings file per pet (a test may set up several).
  const settings = createPetsSettings({
    userDataDir: mkdtempSync(join(dir, 'pet-'))
  });
  const saved = settings.update(
    {
      enabled: true,
      activePetId: 'petdex:lando',
      favoriteDriverId: 'lando-norris',
      resultReactions: false,
      rateNudge: false,
      dailyFact: false,
      // Greetings depend on the local clock (controller-greeting.test.mjs
      // covers them with the panel and their "No greetings" button).
      greetings: false,
      ...overrides
    },
    { trusted: true }
  );
  if (!saved.ok) throw new Error(saved.error);
  const changes = [];
  settings.onChange((next) => changes.push(next));
  const petWindow = fakePetWindow(can);
  const opened = [];
  const asks = [];
  const ask = { background };
  const controller = createPetController({
    settings,
    store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
    getSessions: () => FEED.sessions,
    getFeed: () => FEED,
    calendarPhase,
    sessionBubble,
    petWindow,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: (path) => opened.push(path ?? null),
    openAsk: () => asks.push('ask'),
    askInBackground: () => ask.background,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const last = () => petWindow.renders.at(-1);
  return {
    clock,
    controller,
    settings,
    changes,
    petWindow,
    opened,
    asks,
    ask,
    last
  };
}

const ids = (actions) => actions?.map((a) => a.id) ?? null;

describe('payload defaults', () => {
  test('a plain idle pet sends the round-3 fields as null', () => {
    const { controller, last } = setup();
    controller.start();
    expect(last()).toMatchObject({
      state: 'idle',
      bubble: null,
      bubbleActions: null,
      panel: null,
      badge: null
    });
  });
});

describe('click panel (3a)', () => {
  test('a click jumps once and opens the panel; a second click closes it', () => {
    const { controller, last, clock } = setup();
    controller.start();
    controller.petEvent('click');
    expect(last()).toMatchObject({
      state: 'jumping',
      once: true,
      bubble: null
    });
    expect(last().panel).toEqual({
      lines: [
        'Qualifying in 3 h · Las Vegas GP',
        'Max Verstappen won the São Paulo GP'
      ],
      actions: [
        { id: 'ask', label: 'Ask F1' },
        { id: 'stats', label: 'On this day' },
        { id: 'hot-lap', label: 'Hot lap' },
        { id: 'pets', label: 'Pets' }
      ]
    });
    // The jump ends; the panel stays.
    clock.advance(stateDurationMs('jumping'));
    expect(last()).toMatchObject({ state: 'idle' });
    expect(last().panel).not.toBeNull();
    controller.petEvent('click');
    expect(last()).toMatchObject({ state: 'jumping', panel: null });
  });

  test('a drag never opens it', () => {
    const { controller, last } = setup();
    controller.start();
    controller.petEvent('drag', 8, 0);
    // A click that arrives mid-drag (a renderer that sends both) is no toggle.
    controller.petEvent('click');
    expect(last().panel).toBeNull();
    controller.petEvent('drag', 4, 0);
    controller.petEvent('dragEnd');
    expect(last().panel).toBeNull();
    // A drag with the panel open leaves it open (it moves with the pet).
    controller.petEvent('click');
    expect(last().panel).not.toBeNull();
    controller.petEvent('drag', 5, 0);
    controller.petEvent('dragEnd');
    expect(last().panel).not.toBeNull();
  });

  test('the renderer closes it (Escape / blur / idle → close); stray ids are ignored', () => {
    const { controller, last, opened, asks } = setup();
    controller.start();
    controller.petEvent('panelAction', 'pets');
    expect(opened).toEqual([]);
    controller.petEvent('click');
    controller.petEvent('panelAction', 'rate');
    controller.petEvent('panelAction', 'nope');
    controller.petEvent('panelAction', undefined);
    expect(last().panel).not.toBeNull();
    expect(opened).toEqual([]);
    controller.petEvent('panelAction', 'close');
    expect(last().panel).toBeNull();
    controller.petEvent('panelAction', 'close');
    expect(opened).toEqual([]);
    expect(asks).toEqual([]);
  });

  test('actions open their path in the main window and close the panel; Ask F1 opens the Ask window', () => {
    const { controller, last, opened, asks } = setup();
    controller.start();
    for (const [id, path] of [
      ['stats', '/stats/on-this-day'],
      ['hot-lap', '/games/rwanda'],
      ['pets', '/settings/pets']
    ]) {
      controller.petEvent('click');
      controller.petEvent('panelAction', id);
      expect(opened.at(-1)).toBe(path);
      expect(last().panel).toBeNull();
    }
    controller.petEvent('click');
    controller.petEvent('panelAction', 'ask');
    expect(asks).toEqual(['ask']);
    expect(opened).not.toContain('/desktop/ask');
    expect(last().panel).toBeNull();
  });

  test('inside the rate window the panel offers "Rate <GP>" with its /rate target', () => {
    const { controller, last, opened } = setup({ at: SP_END + 17 * HOUR });
    controller.start();
    controller.petEvent('click');
    expect(last().panel.actions[1]).toEqual({
      id: 'rate',
      label: 'Rate São Paulo GP'
    });
    controller.petEvent('panelAction', 'rate');
    expect(opened).toEqual(['/rate/2026/sao-paulo/race']);
  });

  test('it replaces the bubble while open; the bubble comes back after', () => {
    const lead = LV_START - SESSION_LEAD_MS;
    const { controller, last, clock } = setup({ at: lead });
    controller.start();
    expect(last().bubble).toBe('Qualifying in 30 min · Las Vegas GP');
    controller.petEvent('click');
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
    expect(last().panel).not.toBeNull();
    // A bubble click can't reach a hidden bubble.
    expect(controller.currentBubble()).toBeNull();
    clock.advance(1000);
    controller.petEvent('click');
    expect(last().panel).toBeNull();
    expect(last().bubble).toBe('Qualifying in 30 min · Las Vegas GP');
  });

  test('a moment due while the panel is open waits until it closes', () => {
    const at = SP_END + 17 * HOUR;
    const { controller, last, settings, clock } = setup({ at });
    controller.start();
    controller.petEvent('click');
    clock.advance(stateDurationMs('jumping'));
    expect(last()).toMatchObject({ state: 'idle' });
    expect(last().panel).not.toBeNull();
    // Rate nudges switched on while the panel is open: nothing starts.
    expect(settings.update({ rateNudge: true }).ok).toBe(true);
    controller.refresh();
    expect(last().bubble).toBeNull();
    expect(settings.get().lastRateKey).toBeNull();
    controller.petEvent('panelAction', 'close');
    expect(last().bubble).toBe('Rate the São Paulo GP');
    expect(settings.get().lastRateKey).toBe(SP_RACE.key);
  });

  test('the countdown line follows the clock while the panel is open', () => {
    const at = LV_START - 2 * MIN - 30_000;
    const { controller, last, clock } = setup({ at });
    controller.start();
    controller.petEvent('click');
    expect(last().panel.lines[0]).toBe('Qualifying in 3 min · Las Vegas GP');
    clock.advance(stateDurationMs('jumping'));
    // One timer: the minute the countdown changes.
    expect(clock.pending()).toEqual([LV_START - 2 * MIN]);
    clock.advance(LV_START - 2 * MIN - clock.now());
    expect(last().panel.lines[0]).toBe('Qualifying in 2 min · Las Vegas GP');
    controller.petEvent('panelAction', 'close');
    expect(clock.pending()).not.toContain(LV_START - MIN);
  });

  test('a renderer that cannot draw it never opens it (older native pet)', () => {
    const { controller, last } = setup({ can: () => false });
    controller.start();
    controller.petEvent('click');
    expect(last()).toMatchObject({ state: 'jumping', panel: null });
  });

  test('hiding the pet closes the panel', () => {
    const { controller, last, settings } = setup();
    controller.start();
    controller.petEvent('click');
    settings.update({ enabled: false });
    controller.refresh();
    settings.update({ enabled: true });
    controller.refresh();
    expect(last().panel).toBeNull();
  });
});

describe('bubble buttons (2e)', () => {
  const lead = LV_START - SESSION_LEAD_MS;

  test('a calendar bubble: OK · Quiet this session · No session alerts', () => {
    const { controller, last } = setup({ at: lead });
    controller.start();
    expect(last().bubbleActions).toEqual([
      { id: 'ok', label: 'OK' },
      { id: 'quiet-session', label: 'Quiet this session' },
      { id: 'mute', label: 'No session alerts' }
    ]);
  });

  test('OK dismisses the bubble and opens nothing', () => {
    const { controller, last, opened, settings } = setup({ at: lead });
    controller.start();
    controller.petEvent('bubbleAction', 'ok');
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
    expect(opened).toEqual([]);
    expect(settings.get().quietUntil).toBeNull();
  });

  test('Quiet 1 h and Quiet this session use the quiet helpers', () => {
    // The session's start bubble ("Qualifying is live").
    const start = setup({ at: LV_START });
    start.controller.start();
    expect(ids(start.last().bubbleActions)).toEqual([
      'ok',
      'quiet-session',
      'mute'
    ]);
    start.controller.petEvent('bubbleAction', 'quiet-session');
    expect(start.settings.get().quietUntil).toBe(
      new Date(LV_START + SESSION_DURATION_MS.qualifying).toISOString()
    );
    expect(start.last().bubble).toBeNull();
    expect(start.opened).toEqual([]);

    // A celebration (no session around) offers Quiet 1 h.
    const party = setup();
    party.controller.start();
    party.controller.celebrate('hot-lap-pb', 'New PB!');
    expect(party.last().bubbleActions).toEqual([
      { id: 'ok', label: 'OK' },
      { id: 'quiet-1h', label: 'Quiet 1 h' }
    ]);
    party.controller.petEvent('bubbleAction', 'quiet-1h');
    expect(party.settings.get().quietUntil).toBe(
      new Date(QUIET_MORNING + QUIET_HOUR_MS).toISOString()
    );
    expect(party.last().bubble).toBeNull();
  });

  test('mute writes the setting through the page path (the gallery hears it)', () => {
    const { controller, last, settings, changes, opened } = setup({ at: lead });
    controller.start();
    const before = changes.length;
    controller.petEvent('bubbleAction', 'mute');
    expect(settings.get().sessionReactions).toBe('off');
    expect(changes.length).toBe(before + 1);
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
    expect(opened).toEqual([]);
  });

  test('mute on a result bubble switches result reactions off', () => {
    const at = SP_END + 17 * HOUR;
    const { controller, last, settings } = setup({
      at,
      settings: { resultReactions: true }
    });
    controller.start();
    expect(last().bubble).toBe('P3 for Lando · São Paulo GP');
    expect(last().bubbleActions.at(-1)).toEqual({
      id: 'mute',
      label: 'No result reactions'
    });
    controller.petEvent('bubbleAction', 'mute');
    expect(settings.get().resultReactions).toBe(false);
    expect(last().bubble).toBeNull();
  });

  test('a button the bubble does not offer, or no bubble, does nothing', () => {
    const party = setup();
    party.controller.start();
    party.controller.petEvent('bubbleAction', 'ok');
    expect(party.settings.get().quietUntil).toBeNull();
    party.controller.celebrate('hot-lap-pb', 'New PB!');
    party.controller.petEvent('bubbleAction', 'mute');
    party.controller.petEvent('bubbleAction', 'quiet-session');
    party.controller.petEvent('bubbleAction', 'bogus');
    expect(party.last().bubble).toBe('New PB!');
    expect(party.settings.get().quietUntil).toBeNull();
  });

  test('hover bubbles get no buttons and ignore them', () => {
    const { controller, last } = setup();
    controller.start();
    controller.petEvent('hover');
    expect(last().bubble).toBe('Qualifying in 3 h · Las Vegas GP');
    expect(last().bubbleActions).toBeNull();
    controller.petEvent('bubbleAction', 'ok');
    expect(last().bubble).toBe('Qualifying in 3 h · Las Vegas GP');
  });

  test('the bubble text still opens its target', () => {
    const { controller, opened } = setup({ at: lead });
    controller.start();
    controller.petEvent('bubbleClick');
    expect(opened).toEqual(['/']);
  });

  test('buttons go with the bubble when it expires', () => {
    const { controller, last, clock } = setup({ at: lead });
    controller.start();
    clock.advance(BUBBLE_MS);
    expect(last()).toMatchObject({ bubble: null, bubbleActions: null });
  });
});

describe('answer-ready badge (3b)', () => {
  test('an Ask-window done while it is in the background badges the pet', () => {
    const { controller, last } = setup();
    controller.start();
    controller.signal('done', 'ask');
    expect(last().badge).toEqual({ kind: 'answer', label: 'Answer ready' });
    expect(last().badge).toEqual({ ...ANSWER_BADGE });
    // It does not replace a bubble.
    controller.petEvent('hover');
    expect(last().bubble).not.toBeNull();
    expect(last().badge).not.toBeNull();
  });

  test('no badge: Ask window in front, main-window done, other signals, chat reactions off', () => {
    const front = setup({ background: false });
    front.controller.start();
    front.controller.signal('done', 'ask');
    expect(front.last().badge).toBeNull();

    const main = setup();
    main.controller.start();
    main.controller.signal('done', 'main');
    main.controller.signal('done');
    for (const signal of ['planning', 'streaming', 'error', 'needs-choice'])
      main.controller.signal(signal, 'ask');
    expect(main.last().badge).toBeNull();

    const off = setup({ settings: { chatReactions: false } });
    off.controller.start();
    off.controller.signal('done', 'ask');
    expect(off.last().badge).toBeNull();
  });

  test('a click with the badge opens the Ask window and clears it — no panel', () => {
    const { controller, last, asks, opened } = setup();
    controller.start();
    controller.signal('done', 'ask');
    controller.petEvent('click');
    expect(asks).toEqual(['ask']);
    expect(opened).toEqual([]);
    expect(last()).toMatchObject({
      state: 'jumping',
      badge: null,
      panel: null
    });
    // The next click is a normal one again.
    controller.petEvent('click');
    expect(last().panel).not.toBeNull();
  });

  test('opening the Ask window any other way clears it (clearBadge)', () => {
    const { controller, last, petWindow } = setup();
    controller.start();
    controller.signal('done', 'ask');
    expect(last().badge).not.toBeNull();
    controller.clearBadge();
    expect(last().badge).toBeNull();
    const renders = petWindow.renders.length;
    controller.clearBadge();
    expect(petWindow.renders.length).toBe(renders);
  });

  test('Ask F1 in an open panel clears a badge that arrived meanwhile', () => {
    const { controller, last, asks } = setup();
    controller.start();
    controller.petEvent('click');
    controller.signal('done', 'ask');
    expect(last().badge).not.toBeNull();
    controller.petEvent('panelAction', 'ask');
    expect(asks).toEqual(['ask']);
    expect(last()).toMatchObject({ badge: null, panel: null });
  });

  test('the badge stays through quiet (the user asked), and with no badge renderer it is never shown', () => {
    const quiet = setup();
    quiet.controller.start();
    quiet.controller.quiet('1h');
    quiet.controller.signal('done', 'ask');
    expect(quiet.last().badge).not.toBeNull();

    const panelOnly = setup({ can: (feature) => feature === 'panel' });
    panelOnly.controller.start();
    panelOnly.controller.signal('done', 'ask');
    expect(panelOnly.last().badge).toBeNull();
    panelOnly.controller.petEvent('click');
    expect(panelOnly.asks).toEqual([]);
    expect(panelOnly.last().panel).not.toBeNull();
  });

  test('an openAsk that throws is reported, the pet carries on', () => {
    const errors = [];
    const clock = fakeClock(QUIET_MORNING);
    const settings = createPetsSettings({
      userDataDir: mkdtempSync(join(dir, 'pet-'))
    });
    settings.update(
      { enabled: true, activePetId: 'petdex:lando' },
      { trusted: true }
    );
    const petWindow = fakePetWindow();
    const controller = createPetController({
      settings,
      store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
      getSessions: () => [],
      calendarPhase,
      sessionBubble,
      petWindow,
      support: () => ({ supported: true, needsRestartForPets: false }),
      openMain: () => {},
      openAsk: () => {
        throw new Error('no window');
      },
      askInBackground: () => true,
      onError: (error) => errors.push(error.message),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    controller.start();
    controller.signal('done', 'ask');
    controller.petEvent('click');
    expect(errors).toEqual(['no window']);
    expect(petWindow.renders.at(-1)).toMatchObject({
      state: 'jumping',
      badge: null
    });
  });
});
