/**
 * Desktop pets — roaming (round 3, 2a): the renderer side of `motion`.
 *
 * The behaviour (behaviour.mjs `pickMotion`) only says whether the pet may
 * move — render payload `motion: 'roam' | 'dash' | null`. The walking is the
 * renderer's: pet-window.mjs drives `createPetWalker()` below, and the
 * native pet (ti-pet) follows the same rules:
 *
 *   - walk horizontally at the current y, inside the work area of the
 *     display the pet is on (for a duo the pair, clamped like a drag);
 *   - roam: pause ROAM_PAUSE_MIN_MS…ROAM_PAUSE_MAX_MS (uniform random, the
 *     payload's own row), then walk to a random x at least
 *     ROAM_MIN_DISTANCE_PX away at ROAM_SPEED_PX_S × size scale; repeat;
 *   - dash: run to the farther end of that range and back to where it
 *     started, at max(DASH_SPEED_PX_S × size scale, path / DASH_MAX_MS); once
 *     per `motion` change to 'dash';
 *   - while walking the pet shows running-left / running-right (`walkPose`);
 *   - x follows the clock (from + (to − from) × elapsed / duration), and the
 *     window moves at most once per MOTION_TICK_MS (≤ 30 moves per second);
 *   - a walk that ends or is stopped saves the position like a drop — once
 *     per walk, and only when the pet moved;
 *   - no timers at all while `motion` is null.
 *
 * Electron-free and clock-free: time, randomness and timers are injected.
 */
import { PET_SIZES, PET_STATES } from './contract.mjs';

/** Walking speed at size l (scale 1), in DIP per second; × size scale. */
export const ROAM_SPEED_PX_S = 80;
/** A roam target is at least this far from where the walk starts (DIP). */
export const ROAM_MIN_DISTANCE_PX = 120;
/** Pause before each roam walk (uniform random in this range). */
export const ROAM_PAUSE_MIN_MS = 10_000;
export const ROAM_PAUSE_MAX_MS = 40_000;
/** One window move per tick at most: 34 ms ≈ 29.4 moves per second. */
export const MOTION_TICK_MS = 34;
/** Dash speed at size l; × size scale, raised so the dash fits DASH_MAX_MS. */
export const DASH_SPEED_PX_S = 480;
/** The whole dash (out and back) takes at most this long. */
export const DASH_MAX_MS = 8000;

const STATE_BY_ID = new Map(PET_STATES.map((s) => [s.id, s]));

/** Size preset → scale (unknown → m). @param {string} size */
export const sizeScale = (size) => PET_SIZES[size] ?? PET_SIZES.m;

/**
 * x range the first sprite may walk in: the pair stays inside `area`
 * (`duoOffset` = how far the duo's second sprite reaches left of the first,
 * pet-window.mjs). Null when the area is too narrow to walk at all.
 * @param {{ width: number }} sprite
 * @param {number} duoOffset
 * @param {{ x: number, width: number }} area
 * @returns {{ minX: number, maxX: number } | null}
 */
export function walkRange(sprite, duoOffset, area) {
  const minX = Math.round(area.x + duoOffset);
  const maxX = Math.round(area.x + area.width - sprite.width);
  return maxX > minX ? { minX, maxX } : null;
}

/** @param {() => number} random → [0, 1) */
const unit = (random) => {
  const r = Number(random());
  return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - 1e-9) : 0;
};

/** Pause before the next roam walk. @param {() => number} random */
export function roamPauseMs(random) {
  return Math.round(
    ROAM_PAUSE_MIN_MS + unit(random) * (ROAM_PAUSE_MAX_MS - ROAM_PAUSE_MIN_MS)
  );
}

/**
 * A random target x in `range`, at least ROAM_MIN_DISTANCE_PX from `x`
 * (uniform over both sides together); null when no such x exists.
 * @param {number} x @param {{ minX: number, maxX: number }} range
 * @param {() => number} random
 */
export function pickRoamTarget(x, range, random) {
  const left = Math.max(0, x - ROAM_MIN_DISTANCE_PX - range.minX);
  const right = Math.max(0, range.maxX - (x + ROAM_MIN_DISTANCE_PX));
  const total = left + right;
  if (total <= 0) return null;
  const r = unit(random) * total;
  return Math.round(
    r < left ? range.minX + r : x + ROAM_MIN_DISTANCE_PX + (r - left)
  );
}

/** Roam speed in DIP per second. @param {number} scale */
export const roamSpeed = (scale) => ROAM_SPEED_PX_S * scale;

/**
 * The dash: out to the farther end of `range`, then back to `x`. Null when
 * there is nowhere to go.
 * @param {number} x @param {{ minX: number, maxX: number }} range
 * @param {number} scale
 * @returns {{ path: number[], speed: number } | null}
 */
export function dashPlan(x, range, scale) {
  const far = x - range.minX >= range.maxX - x ? range.minX : range.maxX;
  const distance = Math.abs(far - x);
  if (distance === 0) return null;
  const speed = Math.max(
    DASH_SPEED_PX_S * scale,
    (2 * distance) / (DASH_MAX_MS / 1000)
  );
  return { path: [far, x], speed };
}

/**
 * @typedef {{ fromX: number, toX: number, startMs: number, durationMs: number }} Leg
 */

/** @param {number} fromX @param {number} toX @param {number} startMs @param {number} speed px/s */
export function makeLeg(fromX, toX, startMs, speed) {
  return {
    fromX,
    toX,
    startMs,
    durationMs: Math.max(1, Math.round((Math.abs(toX - fromX) / speed) * 1000))
  };
}

/** x on a leg at time t (whole DIP). @param {Leg} leg @param {number} t */
export function legX(leg, t) {
  const p = Math.min(Math.max((t - leg.startMs) / leg.durationMs, 0), 1);
  return Math.round(leg.fromX + (leg.toX - leg.fromX) * p);
}

/**
 * Payload fields that replace the row while walking (both sprites of a duo
 * run, so the duo's own second animation is dropped).
 * @param {'left'|'right'} direction
 */
export function walkPose(direction) {
  const anim = STATE_BY_ID.get(
    direction === 'left' ? 'running-left' : 'running-right'
  );
  return {
    state: anim.id,
    row: anim.row,
    frames: anim.frames,
    durationMs: anim.durationMs,
    once: false,
    still: false,
    playKey: `walk:${direction}`,
    secondAnim: null
  };
}

/**
 * The walking loop for one pet window.
 *
 * `setMotion()` follows the payload; `interrupt()` stops the current walk
 * (display change, drag, resize) and — while roaming — pauses before the
 * next one; `stop()` forgets everything (window hidden / re-shown). Pose
 * changes caused by those calls are the caller's to send (it re-renders
 * anyway); changes made by the walker's own timers call `repaint()`.
 *
 * @param {{
 *   now: () => number,
 *   random: () => number,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 *   position: () => ({ x: number, scale: number, range: { minX: number, maxX: number } | null } | null),
 *   moveTo: (x: number) => void,
 *   save: () => void,
 *   repaint: () => void
 * }} deps  `position()` = the first sprite's x, the size scale and the
 *   range it may walk in now (null while there is no window).
 */
export function createPetWalker(deps) {
  const {
    now,
    random,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    position,
    moveTo,
    save,
    repaint
  } = deps;

  /** @type {null|'roam'|'dash'} the payload's motion */
  let mode = null;
  /** @type {'idle'|'pause'|'walk'|'done'} */
  let phase = 'idle';
  /** @type {Leg|null} */
  let leg = null;
  /** Targets after the current leg (the dash's way back). @type {number[]} */
  let rest = [];
  let speed = 0;
  /** x when the walk started (save only when it moved). */
  let startX = 0;
  let timer = null;

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function arm(fn, ms) {
    clear();
    timer = setTimer(() => {
      timer = null;
      fn();
    }, ms);
    timer?.unref?.();
  }

  /** Nothing to walk on (no window): drop all state, no timers. */
  function reset() {
    clear();
    mode = null;
    phase = 'idle';
    leg = null;
    rest = [];
  }

  /**
   * Stop a walk in progress where it is. Returns whether it moved (the
   * caller saves then, last, once the state is settled: saving notifies the
   * controller, which may render — and so call back in — right away).
   */
  function stopWalking() {
    if (phase !== 'walk') return false;
    clear();
    phase = 'idle';
    leg = null;
    rest = [];
    const here = position();
    return Boolean(here && here.x !== startX);
  }

  function schedulePause() {
    phase = 'pause';
    arm(startRoamWalk, roamPauseMs(random));
  }

  /** @param {{ x: number }} here @param {number[]} path @param {number} pxPerS */
  function beginWalk(here, path, pxPerS) {
    speed = pxPerS;
    startX = here.x;
    leg = makeLeg(here.x, path[0], now(), speed);
    rest = path.slice(1);
    phase = 'walk';
    arm(tick, MOTION_TICK_MS);
  }

  function startRoamWalk() {
    const here = position();
    if (!here) return reset();
    const target = here.range
      ? pickRoamTarget(here.x, here.range, random)
      : null;
    if (target === null) return schedulePause();
    beginWalk(here, [target], roamSpeed(here.scale));
    repaint();
  }

  function startDash() {
    const here = position();
    const plan = here?.range ? dashPlan(here.x, here.range, here.scale) : null;
    if (!here || !plan) {
      phase = 'done';
      return;
    }
    beginWalk(here, plan.path, plan.speed);
  }

  function tick() {
    if (phase !== 'walk' || !leg) return;
    const here = position();
    if (!here) return reset();
    const t = now();
    let turned = false;
    while (t >= leg.startMs + leg.durationMs && rest.length > 0) {
      const end = leg.startMs + leg.durationMs;
      leg = makeLeg(leg.toX, /** @type {number} */ (rest.shift()), end, speed);
      turned = true;
    }
    const arrived = t >= leg.startMs + leg.durationMs;
    // A turn shows the far end itself (a tick rarely lands on it); the next
    // leg's timing still runs from the exact turn time.
    const x = arrived ? leg.toX : turned ? leg.fromX : legX(leg, t);
    if (x !== here.x) moveTo(x);
    if (arrived) {
      // Arrived: pause (roam) or rest (dash), then save like a drop.
      const moved = stopWalking();
      if (mode === 'roam') schedulePause();
      else phase = 'done';
      repaint();
      if (moved) save();
      return;
    }
    if (turned) repaint();
    arm(tick, MOTION_TICK_MS);
  }

  return {
    /** @param {unknown} next the payload's `motion` */
    setMotion(next) {
      const motion = next === 'roam' || next === 'dash' ? next : null;
      if (motion === mode) return;
      const moved = stopWalking();
      clear();
      mode = motion;
      phase = 'idle';
      if (mode === 'roam') schedulePause();
      else if (mode === 'dash') startDash();
      if (moved) save();
    },

    /** Stop the current walk (saved); roaming pauses, a dash is over. */
    interrupt() {
      const walking = phase === 'walk';
      const moved = stopWalking();
      if (!walking) return;
      if (mode === 'roam') schedulePause();
      else phase = 'done';
      if (moved) save();
    },

    /** Window hidden / re-shown: stop (saving a walk in progress), forget the motion. */
    stop() {
      const moved = stopWalking();
      reset();
      if (moved) save();
    },

    /** Row override while walking, else null. */
    pose() {
      if (phase !== 'walk' || !leg) return null;
      return walkPose(leg.toX < leg.fromX ? 'left' : 'right');
    },

    /** Diagnostics / tests: the motion followed, the phase, a timer pending. */
    state: () => ({ mode, phase, timer: timer !== null })
  };
}
