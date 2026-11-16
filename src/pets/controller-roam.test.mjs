import { describe, test, expect } from 'bun:test';
import { createPetController } from './controller.mjs';
import {
  AMBIENT_SLEEP_MS,
  DASH_WINDOW_MS,
  ROAM_AFTER_INPUT_MS,
  stateDurationMs
} from './behaviour.mjs';
import {
  DEFAULT_SETTINGS,
  SESSION_DURATION_MS,
  SESSION_LEAD_MS
} from './contract.mjs';

const T0 = Date.parse('2026-11-22T03:00:00Z');

/** Fake clock + single-queue timers (as in controller.test.mjs). */
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
    roam: true,
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

const race = {
  key: '2026_22_race',
  kind: 'race',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-22T04:00:00Z'
};
const RACE_START = Date.parse(race.startsAt);

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

/** App use (main-window focus) this long before the start keeps it awake (2b). */
const AWAKE_BEFORE_START_MS = 5 * 60 * 1000;

function setup({ settings = fakeSettings(), sessions = [] } = {}) {
  const clock = fakeClock();
  const petWindow = fakePetWindow();
  const controller = createPetController({
    settings,
    store: {
      get: (id) =>
        id === 'petdex:lando' ? { atlas: { rows: 9, scale: 1 } } : null
    },
    getSessions: () => sessions,
    calendarPhase,
    sessionBubble,
    petWindow,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const motion = () => petWindow.renders.at(-1)?.motion;
  return { clock, petWindow, controller, settings, motion };
}

describe('controller — motion in the render payload (2a)', () => {
  test('off by default: the payload says motion null', () => {
    const { controller, petWindow } = setup({
      settings: fakeSettings({ roam: DEFAULT_SETTINGS.roam })
    });
    expect(DEFAULT_SETTINGS.roam).toBe(false);
    controller.start();
    expect(petWindow.renders.at(-1)).toHaveProperty('motion', null);
  });

  test('roam on: an idle pet roams; switching it off stops it', () => {
    const { controller, settings, motion } = setup();
    controller.start();
    expect(motion()).toBe('roam');
    settings.patch({ roam: false });
    controller.refresh();
    expect(motion()).toBeNull();
  });

  for (const [kind, args] of [
    ['hover', []],
    ['click', []],
    ['contextMenu', []],
    ['bubbleClick', []],
    ['drag', [5, 0]]
  ]) {
    test(`pet input (${kind}) stops it; it roams again ROAM_AFTER_INPUT_MS later`, () => {
      const { controller, clock, motion, petWindow } = setup();
      // The input alone: no click panel here (it holds roaming, see below).
      petWindow.can = () => false;
      controller.start();
      expect(motion()).toBe('roam');
      clock.advance(1000);
      controller.petEvent(kind, ...args);
      if (kind === 'drag') controller.petEvent('dragEnd');
      expect(motion()).toBeNull();
      clock.advance(ROAM_AFTER_INPUT_MS - 1);
      expect(motion()).toBeNull();
      // The controller's own timer wakes for the 30 s gate.
      clock.advance(1);
      expect(motion()).toBe('roam');
    });
  }

  test('the open click panel (3a) holds it; 30 s after the panel closes it roams again', () => {
    const { controller, clock, motion, petWindow } = setup();
    controller.start();
    controller.petEvent('click');
    expect(petWindow.renders.at(-1).panel).not.toBeNull();
    expect(motion()).toBeNull();
    // Long past the 30 s gate, but the panel is still open.
    clock.advance(10 * 60 * 1000);
    expect(petWindow.renders.at(-1).panel).not.toBeNull();
    expect(motion()).toBeNull();
    // Closing it is pet input too (L4's panelAction counts).
    controller.petEvent('panelAction', 'close');
    expect(petWindow.renders.at(-1).panel).toBeNull();
    expect(motion()).toBeNull();
    clock.advance(ROAM_AFTER_INPUT_MS - 1);
    expect(motion()).toBeNull();
    clock.advance(1);
    expect(motion()).toBe('roam');
  });

  test('a panel action (3a) is pet input: 30 s without roaming after it', () => {
    const { controller, clock, motion } = setup();
    controller.start();
    controller.petEvent('click');
    clock.advance(ROAM_AFTER_INPUT_MS + 1000);
    // "On this day" opens the main window and closes the panel.
    controller.petEvent('panelAction', 'stats');
    expect(motion()).toBeNull();
    clock.advance(ROAM_AFTER_INPUT_MS - 1);
    expect(motion()).toBeNull();
    clock.advance(1);
    expect(motion()).toBe('roam');
  });

  test('a bubble button (2e) is pet input: 30 s without roaming after it', () => {
    const { controller, clock, motion, petWindow } = setup({
      sessions: [race]
    });
    controller.start();
    // The lead bubble ("Race in 30 min") with its buttons; no roaming under it.
    clock.advance(RACE_START - SESSION_LEAD_MS - T0);
    expect(petWindow.renders.at(-1)).toMatchObject({
      bubble: 'Race in 30 min · Las Vegas Grand Prix',
      motion: null
    });
    expect(petWindow.renders.at(-1).bubbleActions?.[0]).toMatchObject({
      id: 'ok'
    });
    clock.advance(1000);
    controller.petEvent('bubbleAction', 'ok');
    expect(petWindow.renders.at(-1)).toMatchObject({
      bubble: null,
      motion: null
    });
    clock.advance(ROAM_AFTER_INPUT_MS - 1);
    expect(motion()).toBeNull();
    clock.advance(1);
    expect(motion()).toBe('roam');
  });

  test('the pet page loading is not input', () => {
    const { controller, motion } = setup();
    controller.start();
    controller.petEvent('ready', { reducedMotion: false });
    expect(motion()).toBe('roam');
    controller.petEvent('ready', { reducedMotion: true });
    expect(motion()).toBeNull();
  });

  test('main-window activity does not stop it', () => {
    const { controller, clock, motion } = setup();
    controller.start();
    clock.advance(5000);
    controller.noteActivity();
    controller.signal('idle');
    expect(motion()).toBe('roam');
  });

  test('lock, battery, reduced motion and quiet stop it; it resumes after', () => {
    const { controller, motion } = setup();
    controller.start();
    for (const [stop, resume] of [
      ['lock-screen', 'unlock-screen'],
      ['on-battery', 'on-ac']
    ]) {
      controller.power(stop);
      expect(motion()).toBeNull();
      controller.power(resume);
      expect(motion()).toBe('roam');
    }
    controller.setEnvironment({ reducedMotion: true });
    expect(motion()).toBeNull();
    controller.setEnvironment({ reducedMotion: false });
    expect(motion()).toBe('roam');
    controller.quiet('1h');
    expect(motion()).toBeNull();
    controller.quiet('off');
    expect(motion()).toBe('roam');
  });

  test('lights out: jump, dash until the start bubble ends, then roam', () => {
    const { controller, clock, motion, petWindow } = setup({
      sessions: [race]
    });
    controller.start();
    clock.advance(RACE_START - T0 - AWAKE_BEFORE_START_MS);
    controller.noteActivity();
    clock.advance(AWAKE_BEFORE_START_MS);
    expect(petWindow.renders.at(-1)).toMatchObject({
      state: 'jumping',
      bubble: 'Lights out! · Las Vegas Grand Prix',
      motion: null
    });
    clock.advance(stateDurationMs('jumping'));
    expect(motion()).toBe('dash');
    expect(petWindow.renders.at(-1).bubble).toBe(
      'Lights out! · Las Vegas Grand Prix'
    );
    clock.advance(DASH_WINDOW_MS - stateDurationMs('jumping') - 1);
    expect(motion()).toBe('dash');
    clock.advance(1);
    expect(motion()).toBe('roam');
    expect(petWindow.renders.at(-1).bubble).toBeNull();
    // Asleep 30 min after the last input: it stops roaming.
    clock.advance(
      RACE_START - AWAKE_BEFORE_START_MS + AMBIENT_SLEEP_MS - clock.now()
    );
    expect(petWindow.renders.at(-1)).toMatchObject({
      sleeping: true,
      motion: null
    });
  });

  test('hovering the pet during the dash ends it for good', () => {
    const { controller, clock, motion } = setup({ sessions: [race] });
    controller.start();
    clock.advance(RACE_START - T0 + 2000);
    expect(motion()).toBe('dash');
    controller.petEvent('hover');
    expect(motion()).toBeNull();
    clock.advance(5000);
    expect(motion()).toBeNull();
  });

  test('no dash with session reactions off', () => {
    const { controller, clock, motion } = setup({
      settings: fakeSettings({ sessionReactions: 'off' }),
      sessions: [race]
    });
    controller.start();
    clock.advance(RACE_START - T0 - AWAKE_BEFORE_START_MS);
    controller.noteActivity();
    clock.advance(AWAKE_BEFORE_START_MS + 2000);
    expect(motion()).toBe('roam');
  });
});
