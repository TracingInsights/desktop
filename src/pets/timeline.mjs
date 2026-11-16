/**
 * Desktop pets — timeline compiler (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.2, N1).
 *
 * Before Electron exits, the native pet gets the next TIMELINE_HORIZON_MS of
 * what the pet would do with nobody touching it. Nothing here decides
 * behaviour: a second `createPetController` runs on a virtual clock (its
 * one timer fires instantly at the time it asked for) with copies of the
 * settings and markers and a recording `petWindow`, and every render it
 * pushes becomes a timeline entry. Same code, same decisions — the native
 * pet only plays the result.
 *
 * Besides the entries the timeline carries what the native pet needs for
 * its local interactions while Electron is gone: upcoming `sessions` (hover
 * countdown, "Quiet until this session ends"), the duo's head-to-head line,
 * and `refreshAt` — when it should start Electron with `--pets-refresh` to
 * recompile (tomorrow's fact hour, each race end + RACE_REFRESH_AFTER_MS for
 * the result and rate nudge, and a day before the horizon runs out).
 *
 * Timeline file (`userData/pet-timeline.json`, mirrored by
 * packages/ti-pet/src/timeline.zig). v1, what every native pet plays:
 *   {
 *     v: 1, generatedAt, until, refreshAt,              // ISO UTC
 *     pets: { first: Sprite|null, second: Sprite|null }, // Sprite = { id, path, rows, scale }
 *     size: 's'|'m'|'l',
 *     quietUntil: ISO|null,
 *     sessionReactions: 'calm'|'lively'|'off',
 *     entries: (
 *       { at, visible: false } |
 *       { at, visible: true, state, row, frames, durationMs, once, still,
 *         playKey, bubble: string|null, bubbleTarget: string|null,
 *         duo: boolean, moment: { name, value } | null }
 *     )[],                                              // at = ISO, ascending; each holds until the next
 *     sessions: { key, kind, label, gp, start, end }[], // ISO; label "Qualifying", gp "São Paulo GP"
 *     duo: { text, target } | null,                      // hover line while two pets show
 *     calendarTarget: '/',                               // hover-countdown click target
 *     countdown: { format: 'v1' }                         // "<label> in <formatCountdown> · <gp>",
 *                                                         // "<label> is live · <gp>" (schedule.mjs)
 *   }
 *
 * v2 (round 3) goes only to a pet whose `ready.caps` has `timeline-v2`
 * (`caps` input; an older pet rejects the file): `v: 2`, and each visible
 * entry may add, each behind its own render cap (toNativeRender):
 *   motion: 'roam'|'dash'|null, sleeping: boolean,
 *   bubbleActions: { id, label }[]|null, bubbleKind: string|null (BUBBLE_KINDS,
 *   what an offline `mute` silences), secondAnim: { state, row, frames,
 *   durationMs, once, still, playKey, delayMs }|null,
 *   moment.name may be 'lastGreetingKey';
 * plus a top-level static click panel (offline, `staticPanel`):
 *   panel: { lines: string[], countdown: true, actions: { id, label,
 *     target, from?: ISO, until?: ISO }[] } | null
 * A v1 file keeps only the v1 moment names (TIMELINE_V1_MOMENTS). Without
 * the `v2-rows` cap a look-around entry is written as idle (either version).
 *
 * The native pet reports back, in pet-native-state.json, the `moment`
 * markers whose entries it actually showed (native-state.mjs), so a moment
 * is never lost (pet hidden, quiet) or repeated.
 */
import {
  SESSION_DURATION_MS,
  DAILY_FACT_HOUR,
  PET_SIZES,
  RATE_NUDGE_AFTER_END_MS,
  RATE_NUDGE_WINDOW_MS
} from './contract.mjs';
import { createPetController } from './controller.mjs';
import { duoHeadToHead, CALENDAR_TARGET } from './behaviour.mjs';
import { panelActions, panelLines } from './panel.mjs';
import {
  calendarPhase,
  SESSION_LABELS,
  sessionBubble,
  shortGpName,
  upcomingSessions
} from './schedule.mjs';
import { localDayKey, nextLocalHourAt } from './facts.mjs';
import {
  capSet,
  NATIVE_CAPS,
  TIMELINE_VERSION,
  TIMELINE_VERSION_V1,
  toNativeRender
} from './native-protocol.mjs';

export const TIMELINE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** Recompile this long after a race's nominal end (result + rate nudge). */
export const RACE_REFRESH_AFTER_MS = 2 * 60 * 60 * 1000;
/** Never ask for a refresh sooner than this (no spawn loops). */
export const MIN_REFRESH_MS = 5 * 60 * 1000;
/** A runaway guard: no real week needs anywhere near this many wake-ups. */
export const MAX_STEPS = 50_000;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Moment markers a v1 timeline may carry. The pinned native pet
 * (ti-pet-v0.1.1, timeline.zig `MomentName`) rejects the whole file on any
 * other name, so in a v1 file a round-3 greeting entry keeps its bubble and
 * target but no `moment` (its `lastGreetingKey` stays Electron-side). A v2
 * pet knows the name.
 */
const TIMELINE_V1_MOMENTS = new Set([
  'lastResultKey',
  'lastRateKey',
  'lastFactDay'
]);

/**
 * A virtual clock: `setTimeout` stores the callback at now + delay; `run`
 * fires them in time order (ties in creation order) until `untilMs`.
 * @param {number} startMs
 */
export function createVirtualClock(startMs) {
  let t = startMs;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => t,
    /** @param {() => void} fn @param {number} delay */
    setTimeout(fn, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: t + Math.max(0, Number(delay) || 0), fn });
      return id;
    },
    /** @param {number} id */
    clearTimeout(id) {
      timers.delete(id);
    },
    /**
     * @param {number} untilMs
     * @param {number} [maxSteps]
     * @returns {number} steps run
     */
    run(untilMs, maxSteps = MAX_STEPS) {
      let steps = 0;
      for (;;) {
        let nextKey = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (!next || timer.at < next.at) {
            next = timer;
            nextKey = id;
          }
        }
        if (!next || next.at > untilMs) break;
        if (steps >= maxSteps) throw new Error('Timeline did not settle.');
        timers.delete(nextKey);
        t = Math.max(t, next.at);
        next.fn();
        steps += 1;
      }
      t = Math.max(t, untilMs);
      return steps;
    }
  };
}

/**
 * Settings copy the simulated controller may change (quiet expiry, markers)
 * without touching the real file.
 * @param {Record<string, any>} snapshot
 */
function settingsCopy(snapshot) {
  const current = { ...snapshot, positions: { ...(snapshot.positions ?? {}) } };
  return {
    get: () => ({ ...current }),
    setQuietUntil(value) {
      current.quietUntil = value;
      return { ok: true };
    },
    setMarker(name, value) {
      current[name] = value;
      return { ok: true };
    }
  };
}

/** Rate buttons a static panel carries at most (one per race window). */
const MAX_PANEL_RATES = 2;

/**
 * The click panel the native pet shows while Electron is gone (timeline v2
 * `panel`): panel.mjs's lines and actions as of `nowMs`, minus the
 * countdown line (the pet computes it like the hover text: `countdown:
 * true`), each action with the app path it opens. The rate action exists
 * only inside a race's rate window, so each race whose window overlaps the
 * timeline gets one with `from` / `until` (ISO), cut at the next race's.
 * @param {{ feed: any, favoriteDriverId?: string|null, nowMs: number, untilMs: number }} input
 * @returns {{ lines: string[], countdown: true, actions: { id: string, label: string, target: string, from?: string, until?: string }[] }}
 */
export function staticPanel({ feed, favoriteDriverId = null, nowMs, untilMs }) {
  const lines = panelLines({ sessions: [], feed, favoriteDriverId, nowMs });
  /** @type {{ id: string, label: string, target: string, from: number, until: number }[]} */
  const rates = [];
  for (const s of feed?.sessions ?? []) {
    if (s.kind !== 'race' || !s.rateSlug) continue;
    const end = Date.parse(s.startsAt) + SESSION_DURATION_MS.race;
    if (!Number.isFinite(end)) continue;
    const from = end + RATE_NUDGE_AFTER_END_MS;
    const until = end + RATE_NUDGE_WINDOW_MS;
    if (until <= nowMs || from >= untilMs) continue;
    const at = Math.max(nowMs, from);
    const rate = panelActions({ feed, nowMs: at }).find((a) => a.id === 'rate');
    if (rate) rates.push({ ...rate, from, until });
  }
  rates.sort((a, b) => a.from - b.from);
  // A later race's button replaces the earlier one (panel.mjs shows one).
  for (let i = 0; i + 1 < rates.length; i += 1) {
    rates[i].until = Math.min(rates[i].until, rates[i + 1].from);
  }
  const actions = [];
  for (const action of panelActions({ feed: null, nowMs })) {
    if (action.id === 'stats') {
      for (const rate of rates.slice(-MAX_PANEL_RATES)) {
        actions.push({
          id: rate.id,
          label: rate.label,
          target: rate.target,
          from: iso(rate.from),
          until: iso(rate.until)
        });
      }
    }
    actions.push({ id: action.id, label: action.label, target: action.target });
  }
  return { lines, countdown: true, actions };
}

/**
 * When the native pet should start Electron to recompile.
 * @param {{ nowMs: number, untilMs: number, sessions: readonly { kind: string, startsAt: string }[] }} input
 */
export function refreshAtFor({ nowMs, untilMs, sessions }) {
  const times = [
    nextLocalHourAt(nowMs, DAILY_FACT_HOUR),
    untilMs - 24 * 60 * 60 * 1000
  ];
  for (const session of sessions) {
    if (session.kind !== 'race') continue;
    const start = Date.parse(session.startsAt);
    if (!Number.isFinite(start)) continue;
    const at = start + SESSION_DURATION_MS.race + RACE_REFRESH_AFTER_MS;
    if (at > nowMs) times.push(at);
  }
  return Math.max(nowMs + MIN_REFRESH_MS, Math.min(...times));
}

/**
 * @param {{
 *   settings: Record<string, any>,
 *   store: { get: (id: string) => any },
 *   feed: import('./schedule.mjs').Feed | null,
 *   factFor?: (dayKey: string) => ({ text: string|null, path: string } | null),
 *   resolvePath: (spriteUrl: string) => string|null,
 *   nowMs: number,
 *   horizonMs?: number,
 *   environment?: { reducedMotion?: boolean, onBattery?: boolean },
 *   secondSide?: 'left'|'right',
 *   caps?: readonly string[]|null
 * }} input  `caps` = the native pet's `ready.caps` (none = ti-pet-v0.1.1:
 *   a v1 file without look-around states)
 */
export function compileTimeline(input) {
  const {
    settings,
    store,
    feed,
    factFor = () => null,
    resolvePath,
    nowMs,
    horizonMs = TIMELINE_HORIZON_MS,
    environment = {},
    secondSide = 'left',
    caps = null
  } = input;
  const v2 = capSet(caps).has(NATIVE_CAPS.timelineV2);
  const untilMs = nowMs + horizonMs;
  const clock = createVirtualClock(nowMs);
  const copy = settingsCopy(settings);

  /** @type {object[]} */
  const entries = [];
  /** @type {{ first: object|null, second: object|null }} */
  const pets = { first: null, second: null };
  let shown = false;
  /** @type {any} */
  let controller = null;

  /** @param {{ url: string, rows: number, scale: number }} atlas @param {string} id */
  const sprite = (atlas, id) => {
    const path = resolvePath(atlas.url);
    return path ? { id, path, rows: atlas.rows, scale: atlas.scale } : null;
  };

  const recorder = {
    isShown: () => shown,
    show() {
      shown = true;
    },
    hide() {
      shown = false;
      entries.push({ at: clock.now(), visible: false });
    },
    /** @param {any} payload */
    render(payload) {
      const current = copy.get();
      if (!pets.first) pets.first = sprite(payload.atlas, current.activePetId);
      if (payload.second && !pets.second) {
        pets.second = sprite(payload.second, current.secondPetId);
      }
      const bubble = controller?.currentBubble() ?? null;
      const marker = payload.bubble ? (bubble?.marker ?? null) : null;
      // What this pet can take (look states → idle without `v2-rows`, the
      // round-3 fields behind their caps): the live render's own rules.
      const native = toNativeRender(payload, () => '-', caps);
      if (!native) return;
      const entry = {
        at: clock.now(),
        visible: true,
        state: native.state,
        row: native.row,
        frames: native.frames,
        durationMs: native.durationMs,
        once: native.once,
        still: native.still,
        playKey: native.playKey,
        bubble: payload.bubble ?? null,
        bubbleTarget: payload.bubble ? (bubble?.target ?? null) : null,
        duo: Boolean(payload.second),
        moment:
          marker && (v2 || TIMELINE_V1_MOMENTS.has(marker.name)) ? marker : null
      };
      if (v2) {
        for (const key of [
          'motion',
          'sleeping',
          'bubbleActions',
          'secondAnim'
        ]) {
          if (Object.hasOwn(native, key)) entry[key] = native[key];
        }
        entry.bubbleKind = payload.bubble ? (bubble?.kind ?? null) : null;
      }
      entries.push(entry);
    },
    moveBy() {},
    savePosition() {},
    secondSide: () => secondSide
  };

  controller = createPetController({
    settings: copy,
    store,
    getSessions: () => upcomingSessions(feed, clock.now()),
    getFeed: () => feed,
    facts: {
      today(ms) {
        const day = localDayKey(ms);
        const fact = factFor(day);
        return fact ? { day, text: fact.text, path: fact.path } : null;
      }
    },
    calendarPhase,
    sessionBubble,
    petWindow: recorder,
    support: () => ({ supported: true, needsRestartForPets: false }),
    openMain: () => {},
    now: clock.now,
    setTimeout: /** @type {any} */ (clock.setTimeout),
    clearTimeout: /** @type {any} */ (clock.clearTimeout),
    onError: (error) => console.warn('[pets] timeline:', error)
  });
  // Electron is gone for the whole run: no interaction, no chat.
  controller.start();
  controller.setEnvironment({
    onBattery: Boolean(environment.onBattery),
    reducedMotion: Boolean(environment.reducedMotion)
  });
  clock.run(untilMs);
  // The run ends at the horizon; stopping must not record a "hide".
  shown = false;
  controller.stop();

  const sessions = upcomingSessions(feed, nowMs)
    .filter((s) => Date.parse(s.startsAt) < untilMs)
    .map((s) => {
      const start = Date.parse(s.startsAt);
      return {
        key: s.key,
        kind: s.kind,
        label: SESSION_LABELS[s.kind],
        gp: shortGpName(s.gp),
        start: iso(start),
        end: iso(start + SESSION_DURATION_MS[s.kind])
      };
    });

  const current = settings;
  const duo =
    current.secondPetId && current.secondPetId !== current.activePetId
      ? duoHeadToHead({
          feed,
          firstPetId: current.activePetId,
          secondPetId: current.secondPetId,
          secondSide
        })
      : null;

  return {
    v: v2 ? TIMELINE_VERSION : TIMELINE_VERSION_V1,
    generatedAt: iso(nowMs),
    until: iso(untilMs),
    refreshAt: iso(
      refreshAtFor({
        nowMs,
        untilMs,
        sessions: upcomingSessions(feed, nowMs)
      })
    ),
    pets,
    size: Object.hasOwn(PET_SIZES, current.size) ? current.size : 'm',
    quietUntil: current.quietUntil ?? null,
    sessionReactions: current.sessionReactions,
    entries: entries.map((entry) => ({ ...entry, at: iso(entry.at) })),
    sessions,
    duo: duo ? { text: duo.text, target: duo.target } : null,
    calendarTarget: CALENDAR_TARGET,
    countdown: { format: 'v1' },
    ...(v2
      ? {
          panel: staticPanel({
            feed,
            favoriteDriverId: current.favoriteDriverId ?? null,
            nowMs,
            untilMs
          })
        }
      : {})
  };
}
