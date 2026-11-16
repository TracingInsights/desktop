/**
 * Controller + v2 look-around (SPEC 1b): the first pet's atlas rows reach
 * the behaviour, and a look's payload carries rows 9 / 10.
 */
import { describe, test, expect } from 'bun:test';
import { createPetController } from './controller.mjs';
import { AMBIENT_WAITING_MS } from './behaviour.mjs';
import { DEFAULT_SETTINGS } from './contract.mjs';

const T0 = Date.parse('2026-11-22T03:00:00Z');
const MIN = 60 * 1000;

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

/** @param {Record<string, number>} rowsById pet id → atlas rows */
function setup(rowsById, overrides = {}) {
  const clock = fakeClock();
  let current = {
    ...DEFAULT_SETTINGS,
    enabled: true,
    activePetId: 'petdex-cli:boba',
    ...overrides
  };
  const renders = [];
  let shown = false;
  const controller = createPetController({
    settings: {
      get: () => ({ ...current }),
      setQuietUntil(iso) {
        current = { ...current, quietUntil: iso };
        return { ok: true };
      }
    },
    store: {
      get: (id) =>
        rowsById[id] ? { atlas: { rows: rowsById[id], scale: 1 } } : null
    },
    getSessions: () => [],
    calendarPhase: () => ({ phase: null, session: null, nextBoundaryAt: null }),
    sessionBubble: () => '',
    petWindow: {
      show: () => (shown = true),
      hide: () => (shown = false),
      isShown: () => shown,
      render: (payload) => renders.push({ at: clock.now() - T0, payload }),
      moveBy: () => {},
      savePosition: () => {}
    },
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const patch = (p) => {
    current = { ...current, ...p };
    controller.refresh();
  };
  return { clock, controller, renders, patch };
}

describe('controller — v2 look-around', () => {
  test('an 11-row pet plays look-a (row 9) then look-b (row 10), then idles again', () => {
    const { clock, controller, renders } = setup({ 'petdex-cli:boba': 11 });
    controller.start();
    expect(clock.pending()).toEqual([T0 + 4 * MIN]);
    clock.advance(4 * MIN);
    expect(renders.at(-1)).toEqual({
      at: 4 * MIN,
      payload: expect.objectContaining({
        state: 'look-a',
        row: 9,
        frames: 8,
        durationMs: 1120,
        once: true,
        still: false,
        playKey: `look:${T0 + 4 * MIN}`,
        atlas: expect.objectContaining({ rows: 11 })
      })
    });
    clock.advance(1120);
    expect(renders.at(-1).payload).toMatchObject({ state: 'idle', row: 0 });
    clock.advance(4 * MIN - 1120);
    expect(renders.at(-1).payload).toMatchObject({
      state: 'look-b',
      row: 10,
      frames: 8
    });
    // 30 min on: 7 looks, then asleep (2b) with no timer left.
    clock.advance(30 * MIN);
    const looks = renders.filter((r) => r.payload.state.startsWith('look-'));
    expect(looks.map((r) => r.at / MIN)).toEqual([4, 8, 12, 16, 20, 24, 28]);
    expect(renders.at(-2).payload.state).toBe('waiting');
    expect(renders.at(-1)).toMatchObject({
      at: 30 * MIN,
      payload: { state: 'idle', row: 0, still: true, sleeping: true }
    });
    expect(clock.pending()).toEqual([]);
  });

  test('pet input restarts the count', () => {
    const { clock, controller, renders } = setup({ 'petdex-cli:boba': 11 });
    controller.start();
    clock.advance(3 * MIN);
    controller.petEvent('hover');
    clock.advance(2 * MIN);
    expect(renders.some((r) => r.payload.state.startsWith('look-'))).toBe(
      false
    );
    clock.advance(2 * MIN);
    expect(renders.at(-1)).toMatchObject({
      at: 7 * MIN,
      payload: { state: 'look-a' }
    });
  });

  test('a 9-row pet never gets a v2 row and keeps its one ambient timer', () => {
    const { clock, controller, renders } = setup(
      { 'codex:boba': 9 },
      {
        activePetId: 'codex:boba'
      }
    );
    controller.start();
    expect(clock.pending()).toEqual([T0 + AMBIENT_WAITING_MS]);
    clock.advance(60 * MIN);
    expect(
      renders.map((r) => `${r.payload.state}${r.payload.sleeping ? ' z' : ''}`)
    ).toEqual(['idle', 'waiting', 'idle z']);
    expect(renders.every((r) => r.payload.row < 9)).toBe(true);
  });

  test('the first pet decides: a v1 first pet with a v2 duo partner never looks', () => {
    const { clock, controller, renders } = setup(
      { 'codex:one': 9, 'petdex-cli:boba': 11 },
      { activePetId: 'codex:one', secondPetId: 'petdex-cli:boba' }
    );
    controller.start();
    clock.advance(40 * MIN);
    expect(renders.every((r) => r.payload.row < 9)).toBe(true);
    expect(renders.at(-1).payload.second).toMatchObject({ rows: 11 });
  });

  test('switching to a v2 pet starts the looks', () => {
    const { clock, controller, renders, patch } = setup(
      { 'codex:one': 9, 'petdex-cli:boba': 11 },
      { activePetId: 'codex:one' }
    );
    controller.start();
    clock.advance(2 * MIN);
    patch({ activePetId: 'petdex-cli:boba' });
    clock.advance(2 * MIN);
    expect(renders.at(-1).payload).toMatchObject({
      state: 'look-a',
      row: 9,
      atlas: { rows: 11 }
    });
  });
});
