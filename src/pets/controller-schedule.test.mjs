/**
 * Controller × the real schedule.mjs (calendarPhase + sessionBubble):
 * a sprint weekend walked with a fake clock.
 */
import { describe, test, expect } from 'bun:test';
import { createPetController } from './controller.mjs';
import { calendarPhase, sessionBubble } from './schedule.mjs';
import { DEFAULT_SETTINGS, SESSION_LEAD_MS } from './contract.mjs';

const sprintQuali = {
  key: '2026_21_sprint-qualifying_2026-11-07T18:30:00',
  kind: 'sprint-qualifying',
  year: 2026,
  round: 21,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-07T18:30:00Z'
};
const race = {
  key: '2026_21_race_2026-11-08T17:00:00',
  kind: 'race',
  year: 2026,
  round: 21,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z'
};

function clockAt(iso) {
  let t = Date.parse(iso);
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    advanceTo(iso2) {
      const end = Date.parse(iso2);
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

describe('controller with schedule.mjs', () => {
  test('lead bubble, start bubble, Lively loop, then back to ambient', () => {
    const clock = clockAt('2026-11-07T17:00:00Z');
    const renders = [];
    let shown = false;
    let current = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      activePetId: 'petdex:lando',
      sessionReactions: 'lively'
    };
    const controller = createPetController({
      settings: {
        get: () => current,
        setQuietUntil: (iso) => {
          current = { ...current, quietUntil: iso };
          return { ok: true };
        }
      },
      store: { get: () => ({ atlas: { rows: 9, scale: 1 } }) },
      getSessions: () => [sprintQuali, race],
      calendarPhase,
      sessionBubble,
      petWindow: {
        show: () => (shown = true),
        hide: () => (shown = false),
        isShown: () => shown,
        render: (p) => renders.push(p),
        moveBy: () => {},
        savePosition: () => {}
      },
      support: () => ({ supported: true, needsRestartForPets: false }),
      openMain: () => {},
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    controller.start();
    const leadAt = new Date(
      Date.parse(sprintQuali.startsAt) - SESSION_LEAD_MS
    ).toISOString();
    clock.advanceTo(leadAt);
    const lead = renders.at(-1);
    expect(lead.state).toBe('waiting');
    expect(lead.bubble).toMatch(/Sprint qualifying in 30 min/);

    clock.advanceTo(sprintQuali.startsAt);
    const start = renders.at(-1);
    expect(start.state).toBe('jumping');
    expect(start.bubble).toBeTruthy();

    clock.advanceTo('2026-11-07T18:40:00Z');
    expect(renders.at(-1)).toMatchObject({ state: 'running', bubble: null });

    expect(controller.sessionQuietAvailable()).toBe(true);
    expect(controller.quiet('session')).toEqual({ ok: true });
    expect(current.quietUntil).toBe('2026-11-07T19:15:00.000Z');
    expect(renders.at(-1).state).toBe('idle');

    // Quiet expires at the session's nominal end and clears itself.
    clock.advanceTo('2026-11-07T19:15:00Z');
    expect(current.quietUntil).toBeNull();
  });
});
