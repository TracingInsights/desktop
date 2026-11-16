import { describe, test, expect } from 'bun:test';
import {
  createPetWalker,
  DASH_MAX_MS,
  DASH_SPEED_PX_S,
  dashPlan,
  legX,
  makeLeg,
  MOTION_TICK_MS,
  pickRoamTarget,
  ROAM_MIN_DISTANCE_PX,
  ROAM_PAUSE_MAX_MS,
  ROAM_PAUSE_MIN_MS,
  ROAM_SPEED_PX_S,
  roamPauseMs,
  roamSpeed,
  sizeScale,
  walkPose,
  walkRange
} from './roam.mjs';

/** Fake clock + timers that fire in order (like the controller tests). */
function fakeClock(start = 1_000_000) {
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
    /** Move the clock without firing timers (a suspended machine). */
    skip(ms) {
      t += ms;
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    }
  };
}

/** A walker over a fake window: x on a 1920-wide work area (sprite m). */
function harness({
  x = 1000,
  range = { minX: 0, maxX: 1776 },
  scale = 0.75,
  randoms = []
} = {}) {
  const clock = fakeClock();
  const queue = [...randoms];
  const env = {
    clock,
    pos: { x, range, scale },
    shown: true,
    moves: /** @type {[number, number][]} */ ([]),
    saves: /** @type {number[]} */ ([]),
    repaints: 0,
    onSave: () => {}
  };
  env.walker = createPetWalker({
    now: clock.now,
    random: () => (queue.length > 0 ? queue.shift() : 0.5),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    position: () => (env.shown ? { ...env.pos } : null),
    moveTo: (nx) => {
      env.moves.push([clock.now(), nx]);
      env.pos.x = nx;
    },
    save: () => {
      env.saves.push(env.pos.x);
      env.onSave();
    },
    repaint: () => {
      env.repaints += 1;
    }
  });
  return env;
}

/** Most window moves inside any one-second window. */
function maxMovesPerSecond(moves) {
  let best = 0;
  for (let i = 0; i < moves.length; i += 1) {
    let n = 0;
    for (let j = i; j < moves.length && moves[j][0] < moves[i][0] + 1000; j++)
      n += 1;
    best = Math.max(best, n);
  }
  return best;
}

describe('roam helpers', () => {
  test('speeds and sizes', () => {
    expect(ROAM_SPEED_PX_S).toBe(80);
    expect(sizeScale('s')).toBe(0.5);
    expect(sizeScale('m')).toBe(0.75);
    expect(sizeScale('l')).toBe(1);
    expect(sizeScale('xl')).toBe(0.75);
    expect(roamSpeed(0.5)).toBe(40);
    expect(roamSpeed(1)).toBe(80);
    // ≤ 30 window moves per second.
    expect(1000 / MOTION_TICK_MS).toBeLessThanOrEqual(30);
  });

  test('pause: 10–40 s, uniform in the random draw', () => {
    expect(roamPauseMs(() => 0)).toBe(ROAM_PAUSE_MIN_MS);
    expect(roamPauseMs(() => 0.5)).toBe(25_000);
    expect(roamPauseMs(() => 0.999999)).toBeLessThanOrEqual(ROAM_PAUSE_MAX_MS);
    expect(roamPauseMs(() => 0.999999)).toBeGreaterThan(39_000);
    // A broken random source never yields a pause outside the range.
    expect(roamPauseMs(() => 7)).toBeLessThanOrEqual(ROAM_PAUSE_MAX_MS);
    expect(roamPauseMs(() => NaN)).toBe(ROAM_PAUSE_MIN_MS);
  });

  test('walkRange keeps the pair in the work area; too narrow → null', () => {
    const area = { x: 1920, y: 0, width: 2560, height: 1400 };
    expect(walkRange({ width: 144 }, 0, area)).toEqual({
      minX: 1920,
      maxX: 1920 + 2560 - 144
    });
    // Duo: the second sprite reaches 151 px left of the first.
    expect(walkRange({ width: 144 }, 151, area)).toEqual({
      minX: 1920 + 151,
      maxX: 1920 + 2560 - 144
    });
    expect(walkRange({ width: 144 }, 151, { x: 0, width: 295 })).toBeNull();
  });

  test('roam target: inside the range, at least 120 px away, both sides', () => {
    const range = { minX: 0, maxX: 1776 };
    for (let i = 0; i < 200; i += 1) {
      const r = i / 200;
      for (const x of [0, 50, 500, 1000, 1700, 1776]) {
        const target = pickRoamTarget(x, range, () => r);
        expect(target).not.toBeNull();
        expect(Math.abs(target - x)).toBeGreaterThanOrEqual(
          ROAM_MIN_DISTANCE_PX
        );
        expect(target).toBeGreaterThanOrEqual(range.minX);
        expect(target).toBeLessThanOrEqual(range.maxX);
      }
    }
    // Uniform over both sides together: left part first, then the right.
    expect(pickRoamTarget(1000, range, () => 0)).toBe(0);
    expect(pickRoamTarget(1000, range, () => 0.999999)).toBe(1776);
    // left = 880 px of choices, right = 656 px: 0.5 × 1536 = 768 → left.
    expect(pickRoamTarget(1000, range, () => 0.5)).toBe(768);
    // 0.75 × 1536 = 1152 → 272 px into the right side.
    expect(pickRoamTarget(1000, range, () => 0.75)).toBe(1000 + 120 + 272);
  });

  test('roam target: null when nothing is 120 px away', () => {
    expect(pickRoamTarget(100, { minX: 0, maxX: 200 }, () => 0.3)).toBeNull();
    // Only one side has room.
    expect(pickRoamTarget(30, { minX: 0, maxX: 400 }, () => 0)).toBe(150);
  });

  test('dash: to the farther end and back, fast, at most DASH_MAX_MS', () => {
    const range = { minX: 0, maxX: 1776 };
    // Near the right edge → out to the left end first.
    const right = dashPlan(1500, range, 1);
    expect(right.path).toEqual([0, 1500]);
    // 3000 px / 8 s = 375 px/s < 480 → the size speed wins.
    expect(right.speed).toBe(DASH_SPEED_PX_S);
    const left = dashPlan(100, range, 0.5);
    expect(left.path).toEqual([1776, 100]);
    // 2 × 1676 px at 240 px/s would take 14 s: raised to fit 8 s.
    expect(left.speed).toBeCloseTo((2 * 1676) / (DASH_MAX_MS / 1000), 6);
    expect(dashPlan(0, { minX: 0, maxX: 0 }, 1)).toBeNull();
  });

  test('legs follow the clock, in whole DIP, clamped to the ends', () => {
    const leg = makeLeg(100, 400, 1000, 60);
    expect(leg.durationMs).toBe(5000);
    expect(legX(leg, 0)).toBe(100);
    expect(legX(leg, 1000)).toBe(100);
    expect(legX(leg, 1500)).toBe(130);
    expect(legX(leg, 3500)).toBe(250);
    expect(legX(leg, 99_999)).toBe(400);
    expect(legX(makeLeg(400, 100, 0, 60), 2500)).toBe(250);
  });

  test('walkPose: the running rows, looping, both sprites', () => {
    expect(walkPose('left')).toEqual({
      state: 'running-left',
      row: 2,
      frames: 8,
      durationMs: 1060,
      once: false,
      still: false,
      playKey: 'walk:left',
      secondAnim: null
    });
    expect(walkPose('right')).toMatchObject({ state: 'running-right', row: 1 });
  });
});

describe('createPetWalker — roam', () => {
  test('no motion: no timers, no pose', () => {
    const env = harness();
    expect(env.walker.state()).toEqual({
      mode: null,
      phase: 'idle',
      timer: false
    });
    env.walker.setMotion(null);
    env.walker.setMotion('nonsense');
    expect(env.clock.pending()).toEqual([]);
    expect(env.walker.pose()).toBeNull();
  });

  test('pause first, then a walk at 80 px/s × scale to the target, then save + pause', () => {
    // Pause draw 0 → 10 s; target draw 0.75; next pause draw 0 → 10 s.
    const env = harness({ x: 1000, randoms: [0, 0.75, 0] });
    const start = env.clock.now();
    env.walker.setMotion('roam');
    expect(env.walker.state()).toMatchObject({ mode: 'roam', phase: 'pause' });
    expect(env.clock.pending()).toEqual([start + 10_000]);
    expect(env.walker.pose()).toBeNull();

    env.clock.advance(10_000);
    // left 880 + right 656 = 1536; 0.75 × 1536 = 1152 → right side 1392.
    const target = 1000 + 120 + (1152 - 880);
    expect(env.walker.state().phase).toBe('walk');
    expect(env.walker.pose()).toMatchObject({ state: 'running-right' });
    expect(env.repaints).toBe(1);
    expect(env.moves).toEqual([]);

    // 392 px at 60 px/s (size m) → 6533 ms.
    const walkMs = Math.round((392 / 60) * 1000);
    env.clock.advance(walkMs - 1);
    expect(env.saves).toEqual([]);
    expect(env.walker.state().phase).toBe('walk');
    expect(env.pos.x).toBeLessThanOrEqual(target);
    env.clock.advance(MOTION_TICK_MS);
    expect(env.pos.x).toBe(target);
    expect(env.saves).toEqual([target]);
    expect(env.walker.state()).toMatchObject({ phase: 'pause', timer: true });
    expect(env.walker.pose()).toBeNull();
    expect(env.repaints).toBe(2);
    // Moves only ever go toward the target, one tick apart at least.
    for (let i = 1; i < env.moves.length; i += 1) {
      expect(env.moves[i][1]).toBeGreaterThan(env.moves[i - 1][1]);
      expect(env.moves[i][0] - env.moves[i - 1][0]).toBeGreaterThanOrEqual(
        MOTION_TICK_MS
      );
    }
    expect(maxMovesPerSecond(env.moves)).toBeLessThanOrEqual(30);
  });

  test('keeps roaming: pause, walk, pause … one save per walk', () => {
    const env = harness({ x: 900, scale: 1 });
    env.walker.setMotion('roam');
    env.clock.advance(10 * 60 * 1000);
    expect(env.saves.length).toBeGreaterThan(5);
    // Every save = a finished walk at least 120 px from the one before.
    let previous = 900;
    for (const x of env.saves) {
      expect(Math.abs(x - previous)).toBeGreaterThanOrEqual(120);
      previous = x;
    }
    expect(maxMovesPerSecond(env.moves)).toBeLessThanOrEqual(30);
  });

  test('the same motion again does not restart the pause', () => {
    const env = harness({ randoms: [0] });
    env.walker.setMotion('roam');
    const due = env.clock.pending();
    env.clock.advance(5000);
    env.walker.setMotion('roam');
    expect(env.clock.pending()).toEqual(due);
  });

  test('motion → null mid-walk: stops where it is, saves once, no timers left', () => {
    const env = harness({ x: 1000, randoms: [0, 0.75] });
    env.walker.setMotion('roam');
    env.clock.advance(10_000 + 2000);
    const here = env.pos.x;
    expect(here).toBeGreaterThan(1000);
    env.walker.setMotion(null);
    expect(env.saves).toEqual([here]);
    expect(env.clock.pending()).toEqual([]);
    expect(env.walker.pose()).toBeNull();
    env.clock.advance(60_000);
    expect(env.pos.x).toBe(here);
    expect(env.saves).toEqual([here]);
  });

  test('motion → null while pausing: nothing to save, no timers', () => {
    const env = harness();
    env.walker.setMotion('roam');
    env.walker.setMotion(null);
    expect(env.saves).toEqual([]);
    expect(env.clock.pending()).toEqual([]);
  });

  test('interrupt (display change, drag): saves the walk, pauses, then walks again', () => {
    const env = harness({ x: 1000, randoms: [0, 0.75, 0.5] });
    env.walker.setMotion('roam');
    env.clock.advance(10_000 + 1000);
    const here = env.pos.x;
    env.walker.interrupt();
    expect(env.saves).toEqual([here]);
    expect(env.walker.state()).toMatchObject({ phase: 'pause', timer: true });
    expect(env.clock.pending()).toEqual([env.clock.now() + 25_000]);
    // An interrupt while pausing changes nothing.
    env.walker.interrupt();
    expect(env.clock.pending()).toEqual([env.clock.now() + 25_000]);
    expect(env.saves).toEqual([here]);
    env.clock.advance(25_000);
    expect(env.walker.state().phase).toBe('walk');
  });

  test('a narrow screen: no walk, keeps pausing', () => {
    const env = harness({ x: 100, range: { minX: 0, maxX: 200 } });
    env.walker.setMotion('roam');
    env.clock.advance(5 * 60 * 1000);
    expect(env.moves).toEqual([]);
    expect(env.walker.state()).toMatchObject({ phase: 'pause', timer: true });
  });

  test('window gone: the walker forgets the motion, no timers', () => {
    const env = harness({ randoms: [0] });
    env.walker.setMotion('roam');
    env.shown = false;
    env.clock.advance(10_000);
    expect(env.walker.state()).toEqual({
      mode: null,
      phase: 'idle',
      timer: false
    });
    // Shown again: the next payload starts it afresh.
    env.shown = true;
    env.walker.setMotion('roam');
    expect(env.walker.state().phase).toBe('pause');
  });

  test('stop() mid-walk saves once and forgets everything', () => {
    const env = harness({ randoms: [0, 0.75] });
    env.walker.setMotion('roam');
    env.clock.advance(11_000);
    env.walker.stop();
    expect(env.saves).toHaveLength(1);
    expect(env.walker.state()).toEqual({
      mode: null,
      phase: 'idle',
      timer: false
    });
  });

  test('a save that renders straight back (motion → null) leaves no timers', () => {
    const env = harness({ x: 1000, randoms: [0, 0.75] });
    env.onSave = () => env.walker.setMotion(null);
    env.walker.setMotion('roam');
    env.clock.advance(60_000);
    expect(env.saves).toHaveLength(1);
    expect(env.walker.state()).toEqual({
      mode: null,
      phase: 'idle',
      timer: false
    });
    expect(env.clock.pending()).toEqual([]);
  });
});

describe('createPetWalker — dash', () => {
  test('runs to the far end and back at once, faces the way it runs, no save', () => {
    const env = harness({ x: 1500, scale: 0.75 });
    const start = env.clock.now();
    env.walker.setMotion('dash');
    // Starts right away (the caller sends the pose with the payload).
    expect(env.walker.pose()).toMatchObject({ state: 'running-left' });
    expect(env.repaints).toBe(0);
    env.clock.advance(DASH_MAX_MS / 2 - 100);
    expect(env.pos.x).toBeLessThan(200);
    env.clock.advance(200);
    expect(env.walker.pose()).toMatchObject({ state: 'running-right' });
    expect(env.repaints).toBe(1);
    env.clock.advance(DASH_MAX_MS);
    expect(env.pos.x).toBe(1500);
    expect(Math.min(...env.moves.map((m) => m[1]))).toBe(0);
    // Back where it started: nothing to save; done, no timers.
    expect(env.saves).toEqual([]);
    expect(env.walker.state()).toEqual({
      mode: 'dash',
      phase: 'done',
      timer: false
    });
    expect(env.walker.pose()).toBeNull();
    // 2 × 1500 px at max(360, 375) px/s = 8000 ms.
    expect(env.moves.at(-1)[0] - start).toBeLessThanOrEqual(
      DASH_MAX_MS + MOTION_TICK_MS
    );
    expect(maxMovesPerSecond(env.moves)).toBeLessThanOrEqual(30);
  });

  test('a dash runs once per motion change; stopped dashes are saved and stay over', () => {
    const env = harness({ x: 1500 });
    env.walker.setMotion('dash');
    env.clock.advance(1000);
    env.walker.interrupt();
    const here = env.pos.x;
    expect(env.saves).toEqual([here]);
    expect(env.walker.state()).toEqual({
      mode: 'dash',
      phase: 'done',
      timer: false
    });
    env.walker.setMotion('dash');
    env.clock.advance(10_000);
    expect(env.pos.x).toBe(here);
  });

  test('roam → dash mid-walk: saves the walk, dashes from where it stopped', () => {
    const env = harness({ x: 1000, randoms: [0, 0.75] });
    env.walker.setMotion('roam');
    env.clock.advance(12_000);
    const here = env.pos.x;
    env.walker.setMotion('dash');
    expect(env.saves).toEqual([here]);
    expect(env.walker.state()).toMatchObject({ mode: 'dash', phase: 'walk' });
    env.clock.advance(DASH_MAX_MS + 100);
    expect(env.pos.x).toBe(here);
    // dash → roam: pauses before the first walk.
    env.walker.setMotion('roam');
    expect(env.walker.state()).toMatchObject({ phase: 'pause', timer: true });
  });

  test('a late tick (suspend) jumps to the end of the path', () => {
    const env = harness({ x: 1500 });
    env.walker.setMotion('dash');
    env.clock.advance(MOTION_TICK_MS);
    expect(env.pos.x).toBeLessThan(1500);
    // The next tick fires a minute late: both legs are over by then.
    env.clock.skip(60_000);
    env.clock.advance(0);
    expect(env.pos.x).toBe(1500);
    expect(env.walker.state()).toEqual({
      mode: 'dash',
      phase: 'done',
      timer: false
    });
    expect(env.saves).toEqual([]);
  });
});
