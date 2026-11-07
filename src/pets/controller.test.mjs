import { describe, test, expect } from 'bun:test';
import {
  createPetController,
  DRAG_IDLE_MS,
  MAX_TIMER_MS,
  QUIET_HOUR_MS
} from './controller.mjs';
import { AMBIENT_WAITING_MS } from './behaviour.mjs';
import {
  BUBBLE_MS,
  CHAT_SIGNAL_TTL_MS,
  DEFAULT_SETTINGS,
  SESSION_DURATION_MS,
  SESSION_LEAD_MS
} from './contract.mjs';

const T0 = Date.parse('2026-11-22T03:00:00Z');

/** Fake clock + single-queue timers. */
function fakeClock(start = T0) {
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

function fakeSettings(overrides = {}) {
  let current = {
    ...DEFAULT_SETTINGS,
    enabled: true,
    activePetId: 'petdex:lando',
    ...overrides
  };
  return {
    get: () => ({ ...current }),
    setQuietUntil(iso) {
      current = { ...current, quietUntil: iso };
      return { ok: true };
    },
    patch(p) {
      current = { ...current, ...p };
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
    moveBy: (dx, dy) => calls.push(['moveBy', dx, dy]),
    savePosition: () => calls.push(['savePosition'])
  };
}

const race = {
  key: '2026_22_race',
  kind: 'race',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-22T04:00:00Z'
};

/** Minimal stand-in for schedule.mjs calendarPhase (one session). */
function calendarPhase(sessions, nowMs) {
  for (const s of sessions) {
    const start = Date.parse(s.startsAt);
    const end = start + SESSION_DURATION_MS[s.kind];
    const leadAt = start - SESSION_LEAD_MS;
    if (nowMs < leadAt)
      return { phase: null, session: null, nextBoundaryAt: leadAt };
    if (nowMs < start)
      return { phase: 'lead', session: s, nextBoundaryAt: start };
    if (nowMs < end) return { phase: 'live', session: s, nextBoundaryAt: end };
  }
  return { phase: null, session: null, nextBoundaryAt: null };
}
const sessionBubble = (s, phase) =>
  phase === 'lead' ? `Race in 30 min · ${s.gp}` : `Lights out! · ${s.gp}`;

function setup({
  settings = fakeSettings(),
  sessions = [],
  support,
  store
} = {}) {
  const clock = fakeClock();
  const petWindow = fakePetWindow();
  const opened = [];
  const controller = createPetController({
    settings,
    store: store ?? {
      get: (id) =>
        id === 'petdex:lando' ? { atlas: { rows: 9, scale: 1 } } : null
    },
    getSessions: () => sessions,
    calendarPhase,
    sessionBubble,
    petWindow,
    support:
      support ?? (() => ({ supported: true, needsRestartForPets: false })),
    openMain: (path) => opened.push(path ?? null),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const last = () => petWindow.renders.at(-1);
  return { clock, petWindow, opened, controller, settings, last };
}

describe('visibility', () => {
  test('shows the window and renders idle on start', () => {
    const { controller, petWindow, last } = setup();
    controller.start();
    expect(petWindow.calls[0]).toEqual(['show', { size: 'm', duo: false }]);
    expect(last()).toMatchObject({
      state: 'idle',
      row: 0,
      frames: 6,
      size: 'm',
      bubble: null,
      atlas: {
        url: 'pet-asset://pet/petdex%3Alando/sprite?v=0',
        rows: 9,
        scale: 1
      }
    });
  });

  test('no window when disabled, without a pet, unknown pet or unsupported', () => {
    const cases = [
      { settings: fakeSettings({ enabled: false }) },
      { settings: fakeSettings({ activePetId: null }) },
      { settings: fakeSettings({ activePetId: 'petdex:gone' }) },
      { support: () => ({ supported: false, needsRestartForPets: false }) },
      { support: () => ({ supported: true, needsRestartForPets: true }) }
    ];
    for (const options of cases) {
      const { controller, petWindow } = setup(options);
      controller.start();
      expect(petWindow.isShown()).toBe(false);
      expect(petWindow.renders).toEqual([]);
    }
  });

  test('turning pets off hides the window; on shows it again', () => {
    const { controller, petWindow, settings } = setup();
    controller.start();
    settings.patch({ enabled: false });
    controller.refresh();
    expect(petWindow.isShown()).toBe(false);
    settings.patch({ enabled: true });
    controller.refresh();
    expect(petWindow.isShown()).toBe(true);
  });

  test('identical renders are not re-sent', () => {
    const { controller, petWindow } = setup();
    controller.start();
    controller.refresh();
    controller.refresh();
    expect(petWindow.renders.length).toBe(1);
  });

  test('assetsChanged bumps the sprite cache-buster', () => {
    const { controller, last } = setup();
    controller.start();
    controller.assetsChanged();
    expect(last().atlas.url).toEndWith('?v=1');
  });
});

describe('timers (fake clock)', () => {
  test('exactly one timer, set to the ambient threshold', () => {
    const { controller, clock, last } = setup();
    controller.start();
    expect(clock.pending()).toEqual([T0 + AMBIENT_WAITING_MS]);
    clock.advance(AMBIENT_WAITING_MS);
    expect(last().state).toBe('waiting');
    expect(clock.pending()).toEqual([]);
  });

  test('click plays jumping once and the timer returns it to idle', () => {
    const { controller, clock, last } = setup();
    controller.start();
    controller.petEvent('click');
    expect(last()).toMatchObject({ state: 'jumping', once: true });
    expect(clock.pending().length).toBe(1);
    clock.advance(1000);
    expect(last().state).toBe('idle');
  });

  test('a chat loop signal expires after the TTL without refresh', () => {
    const { controller, clock, last } = setup();
    controller.start();
    controller.signal('streaming');
    expect(last().state).toBe('running');
    clock.advance(CHAT_SIGNAL_TTL_MS - 1);
    expect(last().state).toBe('running');
    clock.advance(1);
    expect(last().state).toBe('idle');
  });

  test('refreshing a signal pushes its expiry out', () => {
    const { controller, clock, last } = setup();
    controller.start();
    controller.signal('streaming');
    clock.advance(CHAT_SIGNAL_TTL_MS - 1000);
    controller.signal('streaming');
    clock.advance(2000);
    expect(last().state).toBe('running');
  });

  test('calendar: lead bubble, start jump, bubble hides after BUBBLE_MS', () => {
    const { controller, clock, last } = setup({ sessions: [race] });
    controller.start();
    const leadAt = Date.parse(race.startsAt) - SESSION_LEAD_MS;
    // One timer: the earliest change (ambient idle at T+10 min) comes first.
    expect(clock.pending()).toEqual([T0 + AMBIENT_WAITING_MS]);
    clock.advance(AMBIENT_WAITING_MS);
    expect(clock.pending()).toEqual([leadAt]);
    clock.advance(leadAt - clock.now());
    expect(last()).toMatchObject({
      state: 'waiting',
      once: true,
      bubble: 'Race in 30 min · Las Vegas Grand Prix'
    });
    clock.advance(BUBBLE_MS);
    expect(last().bubble).toBeNull();
    clock.advance(SESSION_LEAD_MS - BUBBLE_MS);
    expect(last()).toMatchObject({
      state: 'jumping',
      bubble: 'Lights out! · Las Vegas Grand Prix'
    });
  });

  test('timers are capped and re-planned', () => {
    const far = { ...race, startsAt: '2026-12-31T00:00:00Z' };
    const { controller, clock } = setup({ sessions: [far] });
    controller.start();
    controller.signal('idle');
    // ambient threshold first, then the capped calendar timer
    clock.advance(AMBIENT_WAITING_MS);
    expect(clock.pending()).toEqual([clock.now() + MAX_TIMER_MS]);
  });

  test('no timer while hidden unless quiet must clear itself', () => {
    const settings = fakeSettings({ enabled: false });
    const { controller, clock } = setup({ settings });
    controller.start();
    expect(clock.pending()).toEqual([]);
    controller.quiet('1h');
    expect(clock.pending()).toEqual([T0 + QUIET_HOUR_MS]);
    clock.advance(QUIET_HOUR_MS);
    expect(settings.get().quietUntil).toBeNull();
  });
});

describe('quiet', () => {
  test('1h stores now + 1 h and silences chat', () => {
    const { controller, settings, last } = setup();
    controller.start();
    expect(controller.quiet('1h')).toEqual({ ok: true });
    expect(settings.get().quietUntil).toBe(
      new Date(T0 + QUIET_HOUR_MS).toISOString()
    );
    controller.signal('streaming');
    expect(last().state).toBe('idle');
  });

  test('session stores the live session nominal end', () => {
    const { controller, settings, clock } = setup({ sessions: [race] });
    controller.start();
    expect(controller.sessionQuietAvailable()).toBe(false);
    expect(controller.quiet('session').ok).toBe(false);
    clock.advance(Date.parse(race.startsAt) - T0 + 60_000);
    expect(controller.sessionQuietAvailable()).toBe(true);
    expect(controller.quiet('session')).toEqual({ ok: true });
    expect(settings.get().quietUntil).toBe(
      new Date(
        Date.parse(race.startsAt) + SESSION_DURATION_MS.race
      ).toISOString()
    );
  });

  test('quiet clears itself at expiry', () => {
    const { controller, settings, clock, last } = setup();
    controller.start();
    controller.quiet('1h');
    clock.advance(QUIET_HOUR_MS);
    expect(settings.get().quietUntil).toBeNull();
    controller.signal('planning');
    expect(last().state).toBe('running');
  });

  test('off clears it; unknown kinds are refused', () => {
    const { controller, settings } = setup();
    controller.start();
    controller.quiet('1h');
    controller.quiet('off');
    expect(settings.get().quietUntil).toBeNull();
    expect(controller.quiet('forever').ok).toBe(false);
  });
});

describe('pet events', () => {
  test('drag moves the window, runs in the drag direction, saves on drop', () => {
    const { controller, petWindow, last } = setup();
    controller.start();
    controller.petEvent('drag', -5, 2);
    expect(petWindow.calls).toContainEqual(['moveBy', -5, 2]);
    expect(last().state).toBe('running-left');
    const renders = petWindow.renders.length;
    controller.petEvent('drag', -3, 0);
    expect(petWindow.renders.length).toBe(renders);
    controller.petEvent('drag', 4, 0);
    expect(last().state).toBe('running-right');
    controller.petEvent('dragEnd');
    expect(petWindow.calls.at(-1)).toEqual(['savePosition']);
    expect(last().state).toBe('idle');
  });

  test('a drag whose release never arrives ends after DRAG_IDLE_MS', () => {
    const { controller, petWindow, last, clock } = setup();
    controller.start();
    controller.petEvent('drag', 6, 0);
    expect(last().state).toBe('running-right');
    clock.advance(DRAG_IDLE_MS - 1);
    controller.petEvent('drag', 2, 0);
    clock.advance(DRAG_IDLE_MS - 1);
    expect(last().state).toBe('running-right');
    clock.advance(1);
    expect(last().state).toBe('idle');
    expect(petWindow.calls.at(-1)).toEqual(['savePosition']);
  });

  test('hover waves once but never interrupts a click', () => {
    const { controller, last, clock } = setup();
    controller.start();
    controller.petEvent('click');
    controller.petEvent('hover');
    expect(last().state).toBe('jumping');
    clock.advance(2000);
    controller.petEvent('hover');
    expect(last()).toMatchObject({ state: 'waving', once: true });
  });

  test('dblclick opens the main window; bubble click opens / and dismisses', () => {
    const { controller, opened, clock, last } = setup({ sessions: [race] });
    controller.start();
    controller.petEvent('dblclick');
    expect(opened).toEqual([null]);
    clock.advance(Date.parse(race.startsAt) - T0);
    expect(last().bubble).not.toBeNull();
    controller.petEvent('bubbleClick');
    expect(opened).toEqual([null, '/']);
    expect(last().bubble).toBeNull();
  });

  test('ready forces a re-render and picks up reduce motion', () => {
    const { controller, petWindow, last } = setup();
    controller.start();
    const before = petWindow.renders.length;
    controller.petEvent('ready', { reducedMotion: true });
    expect(petWindow.renders.length).toBe(before + 1);
    expect(last().still).toBe(true);
  });

  test('unknown chat signals are refused', () => {
    const { controller } = setup();
    controller.start();
    expect(controller.signal('dancing').ok).toBe(false);
  });
});

describe('power', () => {
  test('lock stills, unlock resumes; battery forces Calm and a still ambient', () => {
    const { controller, last, clock } = setup({ sessions: [race] });
    controller.start();
    controller.power('lock-screen');
    expect(last().still).toBe(true);
    controller.power('unlock-screen');
    expect(last().still).toBe(false);
    controller.power('on-battery');
    expect(last().still).toBe(true);
    controller.power('on-ac');
    expect(last().still).toBe(false);
    // Lively during a session runs on AC, idles on battery.
    clock.advance(Date.parse(race.startsAt) - T0 + 10 * 60_000);
    controller.noteActivity();
    controller.refresh();
    expect(last().state).toBe('idle');
  });

  test('Lively loops during the session on AC only', () => {
    const settings = fakeSettings({ sessionReactions: 'lively' });
    const { controller, last, clock } = setup({ settings, sessions: [race] });
    controller.start();
    clock.advance(Date.parse(race.startsAt) - T0 + 60_000);
    controller.noteActivity();
    controller.refresh();
    expect(last().state).toBe('running');
    controller.power('on-battery');
    expect(last().state).toBe('idle');
  });
});
