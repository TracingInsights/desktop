/**
 * Desktop pets — behaviour state machine (docs/DESKTOP_PETS_PLAN.md §4.5).
 *
 * Pure: `computeBehaviour(input)` turns the controller's inputs into what the
 * pet shows, plus `nextChangeAt` — the earliest moment the answer can change
 * without a new input — so the controller needs one timer only. Highest
 * priority wins:
 *
 *   1. user interaction (drag → running-left/right, click → jumping once,
 *      hover → waving once)
 *   2. reduce motion → idle, still frame (bubbles still shown)
 *   3. quiet (quietUntil in the future) → idle, no bubbles
 *   4. celebration (games, plan §12 #6) → jumping once
 *   5. chat activity (chatReactions) — expires CHAT_SIGNAL_TTL_MS after the
 *      last refresh, so a destroyed window can't leave the pet running
 *   6. result moment (plan §12 #1) → its pose (jumping / waving / failed
 *      once, or idle for the bubble's life)
 *   7. calendar (sessionReactions ≠ off) — lead → waiting once + bubble,
 *      start → jumping once + bubble, during the session Calm → idle /
 *      Lively → running loop; bubbles hide after BUBBLE_MS
 *   8. ambient → idle; `waiting` loop after AMBIENT_WAITING_MS without input;
 *      asleep after AMBIENT_SLEEP_MS (idle still frame + `sleeping`, the
 *      renderers' "z z" mark; a bubble showing keeps it awake). While awake:
 *      a mapped duo waves every DUO_WAVE_EVERY_MS (`duoWaveFirst`); with no
 *      bubble, a Petdex v2 sheet (`atlasRows` ≥ 11) plays a `look-a` /
 *      `look-b` one-shot every AMBIENT_LOOK_EVERY_MS (`ambientLook`)
 *
 * One bubble at a most, by BUBBLE_KINDS priority: hover (countdown / duo
 * head-to-head) > celebration > result > calendar moment > race-weekend
 * greeting > rate nudge > daily fact. Each bubble carries its click target.
 * The controller decides when a once-only moment (result / greeting / rate /
 * fact) starts — see `canStartMoment()` — and feeds it back in as `moment`.
 *
 * On battery Lively is treated as Calm and the ambient pose is a still frame;
 * a locked screen stills everything.
 *
 * `motion` (round 3, 2a — `pickMotion()`) says whether the renderer may walk
 * the window: 'roam' while ambient-idle (never asleep), 'dash' once at a
 * session start, else null. The walking itself is the renderer's (roam.mjs).
 * `second` (4b — `pickSecond()`) is a mapped duo's second sprite's own pose.
 */
import {
  BUBBLE_MS,
  CHAT_SIGNAL_TTL_MS,
  PET_STATES,
  RATE_NUDGE_AFTER_END_MS,
  RATE_NUDGE_WINDOW_MS,
  RESULT_REACTION_WINDOW_MS,
  SESSION_DURATION_MS,
  SESSION_LEAD_MS
} from './contract.mjs';

/** Ambient: no pet / chat / window input for this long → `waiting` loop. */
export const AMBIENT_WAITING_MS = 10 * 60 * 1000;
/** Ambient: no input for this long → asleep (still frame + "z z"). */
export const AMBIENT_SLEEP_MS = 30 * 60 * 1000;
/** v2 sheets: a look-around one-shot this long after the last input, and every … */
export const AMBIENT_LOOK_EVERY_MS = 4 * 60 * 1000;
/** … again until the pet falls asleep (the last look starts at 28 min). */
export const AMBIENT_LOOK_WINDOW_MS = AMBIENT_SLEEP_MS;
/** The look-around states, alternating (rows 9 / 10 of an 8×11 sheet). */
export const LOOK_STATES = Object.freeze(['look-a', 'look-b']);
/** A hover bubble (countdown / duo head-to-head) stays this long. */
export const HOVER_BUBBLE_MS = 6000;
/** Bubble kinds, highest priority first (plan §12). */
export const BUBBLE_KINDS = Object.freeze([
  'hover',
  'celebrate',
  'result',
  'calendar',
  'greeting',
  'rate',
  'fact'
]);
/** Where a calendar-moment bubble leads (the home dashboard's schedule). */
export const CALENDAR_TARGET = '/';
/** Roaming (2a): no pet input for this long before the pet may wander. */
export const ROAM_AFTER_INPUT_MS = 30 * 1000;
/**
 * The lights-out dash (2a) may run from the end of the start jump until the
 * start bubble ends (this long after the session start).
 */
export const DASH_WINDOW_MS = BUBBLE_MS;

const STATE_BY_ID = new Map(PET_STATES.map((s) => [s.id, s]));

/** Loop length of a state (one play of a `once` animation). */
export function stateDurationMs(state) {
  return STATE_BY_ID.get(state)?.durationMs ?? 0;
}

/** Chat signal → { state, once } (plan §4.5 row 4); `idle` → nothing. */
const CHAT_STATES = Object.freeze({
  planning: { state: 'running', once: false },
  streaming: { state: 'running', once: false },
  'needs-choice': { state: 'waiting', once: false },
  'review-open': { state: 'review', once: false },
  done: { state: 'jumping', once: true },
  error: { state: 'failed', once: true }
});

/**
 * @typedef {{ text: string, target: string }} BubbleContent
 * @typedef {{ kind: 'drag', direction: 'left'|'right' }
 *   | { kind: 'click'|'hover', atMs: number }} Interaction
 * @typedef {{ atMs: number, text: string, target: string }} HoverBubble
 *   The hover's countdown / duo text, shown HOVER_BUBBLE_MS from `atMs`
 *   (kept apart from `interaction`, so a click does not cut it short).
 * @typedef {{ atMs: number, text: string, target: string }} Celebration
 * @typedef {{
 *   kind: 'result'|'greeting'|'rate'|'fact',
 *   key: string,
 *   text: string,
 *   target: string,
 *   atMs: number,
 *   state?: string|null,
 *   once?: boolean
 * }} Moment  A once-only bubble the controller started at `atMs`; it shows
 *   for BUBBLE_MS. `state` (results only) is its pose: `once` plays it once,
 *   otherwise it holds for the bubble's life.
 * @typedef {{ signal: string, atMs: number }} ChatActivity
 * @typedef {{
 *   phase: 'lead'|'live'|null,
 *   session: { key: string, kind: string, startsAt: string } | null,
 *   nextBoundaryAt: number|null,
 *   bubble?: string|null
 * }} CalendarPhase  `calendarPhase()` from schedule.mjs + the bubble text for
 *   the phase (`sessionBubble()`), filled in by the controller.
 *
 * @typedef {{
 *   nowMs: number,
 *   interaction?: Interaction|null,
 *   hoverBubble?: HoverBubble|null,
 *   reducedMotion?: boolean,
 *   quietUntilMs?: number|null,
 *   chatReactions?: boolean,
 *   chat?: ChatActivity|null,
 *   sessionReactions?: 'calm'|'lively'|'off',
 *   calendar?: CalendarPhase|null,
 *   celebration?: Celebration|null,
 *   moment?: Moment|null,
 *   duo?: DuoInput|null,
 *   dismissedBubbleKey?: string|null,
 *   dismissedBubbleKeys?: Iterable<string>|null,
 *   lastActivityAtMs?: number|null,
 *   roam?: boolean,
 *   lastInteractionAtMs?: number|null,
 *   onBattery?: boolean,
 *   locked?: boolean,
 *   atlasRows?: number|null
 * }} BehaviourInput
 *   `atlasRows` = the (first) pet's sheet rows: 11 enables the v2 states.
 *   `roam` = the setting (2a); `lastInteractionAtMs` = the
 *   last pet-window input (hover, click, drag, menu …), null = none yet.
 *
 * @typedef {'interaction'|'quiet'|'celebrate'|'chat'|'moment'|'calendar'|'ambient'} Layer
 *
 * @typedef {{
 *   state: string,
 *   once: boolean,
 *   still: boolean,
 *   bubble: { key: string, kind: string, text: string, target: string } | null,
 *   playKey: string,
 *   second: SecondPose|null,
 *   layer: Layer,
 *   motion: null|'roam'|'dash',
 *   sleeping: boolean,
 *   nextChangeAt: number|null
 * }} Behaviour
 *   `playKey` changes whenever a `once` animation must restart (two clicks in
 *   a row); `still` = show frame 0 without animating; `layer` = the rule
 *   that picked the pose (reduce motion keeps the underlying layer, so the
 *   controller can still tell an idle pet from a busy one). `second` = the
 *   duo's second sprite's own pose (4b, see pickSecond), null = it plays the
 *   first's; `sleeping` = the ambient layer's sleep (always with `still`).
 */

/**
 * @param {BehaviourInput} input
 * @returns {Behaviour}
 */
export function computeBehaviour(input) {
  const now = input.nowMs;
  /** Future instants at which the result may change. */
  const boundaries = [];
  const at = (ms) => {
    if (Number.isFinite(ms) && ms > now) boundaries.push(ms);
  };

  const quiet = Number.isFinite(input.quietUntilMs) && input.quietUntilMs > now;
  if (quiet) at(input.quietUntilMs);

  // --- Calendar (needed for both the state and the bubble) ---
  const calendar =
    input.sessionReactions && input.sessionReactions !== 'off'
      ? activeCalendar(input.calendar, now)
      : null;
  if (input.sessionReactions !== 'off' && input.calendar) {
    at(input.calendar.nextBoundaryAt);
  }

  // --- Bubble: one at a time, by priority; never while quiet ---
  const bubble = quiet ? null : pickBubble(input, { now, calendar, at });

  const base = pickState(input, { now, quiet, calendar, at, bubble });
  const pick =
    (base.layer === 'ambient' &&
      !bubble &&
      !base.sleeping &&
      ambientLook(input, now, at)) ||
    base;
  const motion = pickMotion(input, { now, quiet, calendar, bubble, pick, at });
  // Reduce motion keeps an interaction's pose but never animates it; every
  // other pose becomes the idle frame (the layer stays for the controller).
  const reduced = Boolean(input.reducedMotion) && pick.layer !== 'interaction';
  const still = Boolean(input.locked || input.reducedMotion || pick.still);
  const second = reduced ? null : pickSecond(input, { now, at }, pick);
  return {
    state: reduced ? 'idle' : pick.state,
    once: reduced ? false : pick.once,
    still,
    bubble,
    motion,
    playKey: reduced ? 'idle' : pick.playKey,
    second,
    layer: pick.layer,
    sleeping: pick.sleeping === true,
    nextChangeAt: boundaries.length > 0 ? Math.min(...boundaries) : null
  };
}

/** @param {string} kind → 0 (highest) … */
export const bubbleRank = (kind) => {
  const i = BUBBLE_KINDS.indexOf(kind);
  return i === -1 ? BUBBLE_KINDS.length : i;
};

/**
 * Highest-priority bubble that is showing at `now` and not dismissed.
 * @param {BehaviourInput} input
 * @param {{ now: number, calendar: ReturnType<typeof activeCalendar>, at: (ms: number) => void }} ctx
 */
function pickBubble(input, { now, calendar, at }) {
  const dismissed = new Set(input.dismissedBubbleKeys ?? []);
  if (input.dismissedBubbleKey) dismissed.add(input.dismissedBubbleKey);
  /** @type {{ key: string, kind: string, text: string, target: string }[]} */
  const showing = [];
  /** @param {string} kind @param {string} key @param {unknown} text @param {unknown} target @param {number} from @param {number} until */
  const offer = (kind, key, text, target, from, until) => {
    if (typeof text !== 'string' || !text || !(from <= now)) return;
    at(until);
    if (now >= until || dismissed.has(key)) return;
    showing.push({
      key,
      kind,
      text,
      target: typeof target === 'string' && target ? target : CALENDAR_TARGET
    });
  };

  const hover = input.hoverBubble;
  if (hover && Number.isFinite(hover.atMs)) {
    offer(
      'hover',
      `hover:${hover.atMs}`,
      hover.text,
      hover.target,
      hover.atMs,
      hover.atMs + HOVER_BUBBLE_MS
    );
  }
  const party = input.celebration;
  if (party && Number.isFinite(party.atMs)) {
    offer(
      'celebrate',
      `celebrate:${party.atMs}`,
      party.text,
      party.target,
      party.atMs,
      party.atMs + BUBBLE_MS
    );
  }
  const moment = input.moment;
  if (moment && Number.isFinite(moment.atMs)) {
    offer(
      moment.kind,
      `${moment.kind}:${moment.key}`,
      moment.text,
      moment.target,
      moment.atMs,
      moment.atMs + BUBBLE_MS
    );
  }
  if (calendar?.bubble) {
    offer(
      'calendar',
      calendar.bubbleKey,
      calendar.bubble,
      CALENDAR_TARGET,
      calendar.phaseStartMs,
      calendar.phaseStartMs + BUBBLE_MS
    );
  }
  if (showing.length === 0) return null;
  showing.sort((a, b) => bubbleRank(a.kind) - bubbleRank(b.kind));
  return showing[0];
}

/**
 * The calendar phase if it applies, with its start time and bubble key.
 * @param {CalendarPhase|null|undefined} calendar
 * @param {number} now
 */
function activeCalendar(calendar, now) {
  if (!calendar?.phase || !calendar.session) return null;
  const startsAt = Date.parse(calendar.session.startsAt);
  if (!Number.isFinite(startsAt)) return null;
  const phaseStartMs =
    calendar.phase === 'lead' ? startsAt - SESSION_LEAD_MS : startsAt;
  if (phaseStartMs > now) return null;
  return {
    phase: calendar.phase,
    phaseStartMs,
    bubble: typeof calendar.bubble === 'string' ? calendar.bubble : null,
    bubbleKey: `${calendar.session.key}:${calendar.phase}`
  };
}

/**
 * @param {BehaviourInput} input
 * @param {{ now: number, quiet: boolean, calendar: ReturnType<typeof activeCalendar>, at: (ms: number) => void, bubble?: object|null }} ctx
 * @returns {{ state: string, once: boolean, still: boolean, playKey: string, layer: Layer, sleeping?: boolean }}
 */
function pickState(input, { now, quiet, calendar, at, bubble = null }) {
  // 1. Interaction.
  const interaction = input.interaction;
  if (interaction?.kind === 'drag') {
    const state =
      interaction.direction === 'left' ? 'running-left' : 'running-right';
    return {
      state,
      once: false,
      still: false,
      playKey: state,
      layer: 'interaction'
    };
  }
  if (interaction?.kind === 'click' || interaction?.kind === 'hover') {
    const state = interaction.kind === 'click' ? 'jumping' : 'waving';
    const until = interaction.atMs + stateDurationMs(state);
    if (now < until) {
      at(until);
      return {
        state,
        once: true,
        still: false,
        playKey: `${interaction.kind}:${interaction.atMs}`,
        layer: 'interaction'
      };
    }
  }

  // 2. Reduce motion: applied by the caller (keeps the layer).

  // 3. Quiet.
  if (quiet) {
    return {
      state: 'idle',
      once: false,
      still: false,
      playKey: 'idle',
      layer: 'quiet'
    };
  }

  // 4. Celebration (games).
  const party = input.celebration;
  if (party && Number.isFinite(party.atMs)) {
    const until = party.atMs + stateDurationMs('jumping');
    if (now >= party.atMs && now < until) {
      at(until);
      return {
        state: 'jumping',
        once: true,
        still: false,
        playKey: `celebrate:${party.atMs}`,
        layer: 'celebrate'
      };
    }
  }

  // 5. Chat activity.
  const chat = input.chat;
  if (input.chatReactions !== false && chat && CHAT_STATES[chat.signal]) {
    const mapped = CHAT_STATES[chat.signal];
    const until = mapped.once
      ? chat.atMs + stateDurationMs(mapped.state)
      : chat.atMs + CHAT_SIGNAL_TTL_MS;
    if (now >= chat.atMs && now < until) {
      at(until);
      return {
        state: mapped.state,
        once: mapped.once,
        still: false,
        playKey: mapped.once
          ? `chat:${chat.signal}:${chat.atMs}`
          : mapped.state,
        layer: 'chat'
      };
    }
  }

  // 6. Result moment's pose (a duo's head-to-head pose replaces it, 4b).
  const moment = momentWithDuoPose(input);
  if (moment?.state && STATE_BY_ID.has(moment.state) && now >= moment.atMs) {
    const until = moment.once
      ? moment.atMs + stateDurationMs(moment.state)
      : moment.atMs + BUBBLE_MS;
    if (now < until) {
      at(until);
      return {
        state: moment.state,
        once: Boolean(moment.once),
        still: false,
        playKey: moment.once
          ? `${moment.kind}:${moment.key}:${moment.atMs}`
          : moment.state,
        layer: 'moment'
      };
    }
  }

  // 7. Calendar.
  if (calendar) {
    const onceState = calendar.phase === 'lead' ? 'waiting' : 'jumping';
    const until = calendar.phaseStartMs + stateDurationMs(onceState);
    if (now < until) {
      at(until);
      return {
        state: onceState,
        once: true,
        still: false,
        playKey: `calendar:${calendar.bubbleKey}`,
        layer: 'calendar'
      };
    }
    if (
      calendar.phase === 'live' &&
      input.sessionReactions === 'lively' &&
      !input.onBattery
    ) {
      return {
        state: 'running',
        once: false,
        still: false,
        playKey: 'running',
        layer: 'calendar'
      };
    }
  }

  // 8. Ambient.
  const lastActivity = Number.isFinite(input.lastActivityAtMs)
    ? input.lastActivityAtMs
    : now;
  const waitingAt = lastActivity + AMBIENT_WAITING_MS;
  const sleepAt = lastActivity + AMBIENT_SLEEP_MS;
  const still = Boolean(input.onBattery);
  // Asleep: the idle row's still frame. A bubble (a moment, a calendar
  // line) keeps the pet awake in `waiting` until it ends.
  if (now >= sleepAt && !bubble) {
    return {
      state: 'idle',
      once: false,
      still: true,
      playKey: 'sleeping',
      layer: 'ambient',
      sleeping: true
    };
  }
  const wave = duoWaveFirst(input, now, lastActivity, at);
  if (wave) return wave;
  if (now >= waitingAt) {
    at(sleepAt);
    return {
      state: 'waiting',
      once: false,
      still,
      playKey: 'waiting',
      layer: 'ambient'
    };
  }
  at(waitingAt);
  return {
    state: 'idle',
    once: false,
    still,
    playKey: 'idle',
    layer: 'ambient'
  };
}

/**
 * The round-3 ambient extras (1b look-around, 2a roaming, 4b duo waves)
 * need a pet that may move: not on battery, not locked, no reduce motion.
 * @param {BehaviourInput} input
 */
const extrasAllowed = (input) =>
  !input.onBattery && !input.locked && !input.reducedMotion;

/**
 * Ambient look-around on a Petdex v2 sheet (rows 9–10, SPEC 1b). The k-th
 * look (k ≥ 1) starts k × AMBIENT_LOOK_EVERY_MS after the last input — the
 * odd ones `look-a`, the even ones `look-b` — and plays once, while that is
 * under AMBIENT_LOOK_WINDOW_MS after it. Deterministic from the clock, so a
 * look a higher layer covered is simply skipped. Only over the ambient pose
 * with no bubble (the caller checks both), with an 11-row atlas, and never
 * on battery, locked or with reduce motion. Null = no look now; the next
 * start / this look's end goes to `at`.
 * @param {BehaviourInput} input
 * @param {number} now
 * @param {(ms: number) => void} at
 * @returns {{ state: string, once: true, still: false, playKey: string, layer: 'ambient' } | null}
 */
function ambientLook(input, now, at) {
  if (!extrasAllowed(input)) return null;
  const states = LOOK_STATES.map((id) => STATE_BY_ID.get(id));
  if (!states.every((s) => s && input.atlasRows >= s.minRows)) return null;
  const last = Number.isFinite(input.lastActivityAtMs)
    ? input.lastActivityAtMs
    : now;
  const stop = last + AMBIENT_LOOK_WINDOW_MS;
  const k = Math.floor((now - last) / AMBIENT_LOOK_EVERY_MS);
  if (k >= 1) {
    const look = states[(k - 1) % 2];
    const startMs = last + k * AMBIENT_LOOK_EVERY_MS;
    const until = startMs + look.durationMs;
    if (startMs < stop && now < until) {
      at(until);
      return {
        state: look.id,
        once: true,
        still: false,
        playKey: `look:${startMs}`,
        layer: 'ambient'
      };
    }
  }
  const next = last + (k + 1) * AMBIENT_LOOK_EVERY_MS;
  if (next < stop) at(next);
  return null;
}

/**
 * Window motion (round 3, 2a). Never with `roam` off, quiet, on battery,
 * with reduced motion, locked or asleep. Else:
 *   'dash' — at a session start (calendar `live`, sessionReactions ≠ off):
 *     from the end of the start jump until DASH_WINDOW_MS after the start,
 *     while the pet is calendar / ambient and nobody touched it since the
 *     start (an interaction ends the dash for good: it never runs twice);
 *   'roam' — ambient layer, no bubble, no pet input for ROAM_AFTER_INPUT_MS.
 * @param {BehaviourInput} input
 * @param {{
 *   now: number, quiet: boolean,
 *   calendar: ReturnType<typeof activeCalendar>,
 *   bubble: object|null,
 *   pick: { layer: Layer, sleeping?: boolean },
 *   at: (ms: number) => void
 * }} ctx
 * @returns {null|'roam'|'dash'}
 */
function pickMotion(input, { now, quiet, calendar, bubble, pick, at }) {
  if (input.roam !== true || quiet) return null;
  if (!extrasAllowed(input)) return null;
  // Sleep (2b) marks the ambient pick `sleeping`: a sleeping pet stays put.
  if (pick.sleeping) return null;
  const lastInput = Number.isFinite(input.lastInteractionAtMs)
    ? /** @type {number} */ (input.lastInteractionAtMs)
    : null;
  if (
    calendar?.phase === 'live' &&
    (pick.layer === 'calendar' || pick.layer === 'ambient') &&
    (lastInput === null || lastInput <= calendar.phaseStartMs)
  ) {
    const from = calendar.phaseStartMs + stateDurationMs('jumping');
    const until = calendar.phaseStartMs + DASH_WINDOW_MS;
    if (now < from) at(from);
    else if (now < until) {
      at(until);
      return 'dash';
    }
  }
  if (pick.layer !== 'ambient' || bubble) return null;
  if (lastInput !== null && now < lastInput + ROAM_AFTER_INPUT_MS) {
    at(lastInput + ROAM_AFTER_INPUT_MS);
    return null;
  }
  return 'roam';
}

// --- Once-only companion moments (plan §12 #1, #4) and hover texts (#8) ---

/**
 * May a once-only moment of `kind` start now? Never over a user action, a
 * celebration or chat; a result may push aside a calendar bubble (it ranks
 * higher), a greeting / rate nudge / daily fact waits for an idle pet with
 * no bubble (a sleeping pet is idle: the bubble wakes it).
 * @param {'result'|'greeting'|'rate'|'fact'} kind
 * @param {Behaviour} out the behaviour computed without the new moment
 */
export function canStartMoment(kind, out) {
  if (kind === 'result') {
    if (out.layer !== 'ambient' && out.layer !== 'calendar') return false;
    return !out.bubble || bubbleRank(out.bubble.kind) > bubbleRank('result');
  }
  return out.layer === 'ambient' && out.bubble === null;
}

/** "Max Verstappen" → "Max" (result bubbles). @param {string} name */
export function driverFirstName(name) {
  const words = String(name).trim().split(/\s+/);
  return words[0] ?? '';
}

/** "Max Verstappen" → "Verstappen", "Carlos Sainz Jr." → "Sainz Jr.". @param {string} name */
export function driverSurname(name) {
  const words = String(name).trim().split(/\s+/);
  return words.length > 1 ? words.slice(1).join(' ') : (words[0] ?? '');
}

/** "São Paulo Grand Prix" → "São Paulo GP". @param {string} gp */
const shortGp = (gp) => gp.replace(/\bGrand Prix\b/g, 'GP').trim();

/**
 * Nominal start of the feed's latest race: its `sessions[]` entry (same key,
 * else same year + round), else `latestRace.startsAt`; null when unknown.
 * @param {{ sessions?: readonly any[], latestRace?: any } | null | undefined} feed
 */
export function latestRaceStartMs(feed) {
  const race = feed?.latestRace;
  if (!race) return null;
  const sessions = feed.sessions ?? [];
  const session =
    sessions.find((s) => s.kind === 'race' && s.key === race.key) ??
    sessions.find(
      (s) => s.kind === 'race' && s.year === race.year && s.round === race.round
    );
  const start = Date.parse(session?.startsAt ?? race.startsAt ?? '');
  return Number.isFinite(start) ? start : null;
}

/** Not-classified statuses the bubble names (feed: finished|nc|dnf|dsq|dns|dnq). */
const STATUS_LABELS = Object.freeze({
  dnf: 'DNF',
  dsq: 'DSQ',
  dns: 'DNS',
  nc: 'NC',
  dnq: 'DNQ'
});

/**
 * Result reaction for the favourite driver (plan §12 #1), or null: the
 * latest race's result while the race ended under RESULT_REACTION_WINDOW_MS
 * ago. P1 jumps, P2–3 wave, P4–10 hold idle, other finishes are bubble
 * only, DNF / DSQ play `failed`.
 * @param {{ feed: any, favoriteDriverId: string|null, nowMs: number }} input
 * @returns {Omit<Moment, 'atMs'> | null}
 */
export function resultMoment({ feed, favoriteDriverId, nowMs }) {
  const race = feed?.latestRace;
  if (!race || !favoriteDriverId) return null;
  const entry = race.results?.find((r) => r.driverId === favoriteDriverId);
  if (!entry) return null;
  const start = latestRaceStartMs(feed);
  if (start === null || nowMs < start) return null;
  const end = start + SESSION_DURATION_MS.race;
  if (nowMs >= end + RESULT_REACTION_WINDOW_MS) return null;

  const who = driverFirstName(entry.name) || entry.code || entry.driverId;
  const gp = shortGp(race.gp);
  const target = race.grandPrixId
    ? `/stats/races/${race.year}/${race.round}/${race.grandPrixId}`
    : `/stats/races/${race.year}`;
  const base = { kind: /** @type {const} */ ('result'), key: race.key, target };
  const position = entry.position;
  if (Number.isSafeInteger(position) && position > 0) {
    if (position === 1) {
      return {
        ...base,
        text: `${who} wins the ${gp}!`,
        state: 'jumping',
        once: true
      };
    }
    const text = `P${position} for ${who} · ${gp}`;
    if (position <= 3) return { ...base, text, state: 'waving', once: true };
    if (position <= 10) return { ...base, text, state: 'idle', once: false };
    return { ...base, text, state: null, once: false };
  }
  const label = STATUS_LABELS[entry.status];
  if (!label) return null;
  const failed = entry.status === 'dnf' || entry.status === 'dsq';
  return {
    ...base,
    text: `${label} for ${who} · ${gp}`,
    state: failed ? 'failed' : null,
    once: failed
  };
}

/** @param {any} session */
const raceEndMs = (session) =>
  Date.parse(session.startsAt) + SESSION_DURATION_MS.race;

/**
 * "Rate the São Paulo GP" (plan §12 #4): the most recent race with a /rate
 * slug whose nominal end was RATE_NUDGE_AFTER_END_MS … RATE_NUDGE_WINDOW_MS
 * ago; null otherwise.
 * @param {{ feed: any, nowMs: number }} input
 * @returns {Omit<Moment, 'atMs'> | null}
 */
export function rateMoment({ feed, nowMs }) {
  let best = null;
  for (const s of feed?.sessions ?? []) {
    if (s.kind !== 'race' || !s.rateSlug) continue;
    const end = raceEndMs(s);
    if (!Number.isFinite(end)) continue;
    if (nowMs < end + RATE_NUDGE_AFTER_END_MS) continue;
    if (nowMs >= end + RATE_NUDGE_WINDOW_MS) continue;
    if (!best || end > raceEndMs(best)) best = s;
  }
  if (!best) return null;
  return {
    kind: 'rate',
    key: best.key,
    text: `Rate the ${shortGp(best.gp)}`,
    target: `/rate/${best.year}/${best.rateSlug}/race`,
    state: null,
    once: false
  };
}

/**
 * When the next rate nudge becomes due (a race's nominal end + 1 h), so the
 * controller can wake for it; null when none is ahead.
 * @param {{ feed: any, nowMs: number }} input
 */
export function nextRateNudgeAt({ feed, nowMs }) {
  let next = null;
  for (const s of feed?.sessions ?? []) {
    if (s.kind !== 'race' || !s.rateSlug) continue;
    const due = raceEndMs(s) + RATE_NUDGE_AFTER_END_MS;
    if (Number.isFinite(due) && due > nowMs && (next === null || due < next)) {
      next = due;
    }
  }
  return next;
}

/** "petdex:max-4" → "max-4"; other sources → null. @param {string|null} id */
const petdexSlugOf = (id) =>
  typeof id === 'string' && id.startsWith('petdex:') ? id.slice(7) : null;

/**
 * Duo hover (plan §12 #8): "2026 · Verstappen 14–6 Norris (races)" — the
 * season's races where both drivers were classified, whoever finished
 * ahead. Names read left → right like the sprites on screen (`secondSide`
 * = where the pet window draws the second pet, `duoSecondSide`), each with
 * its own wins. Null unless both pets map to (different) drivers with results.
 * @param {{ feed: any, firstPetId: string|null, secondPetId: string|null, secondSide?: 'left'|'right' }} input
 * @returns {BubbleContent|null}
 */
export function duoHeadToHead({
  feed,
  firstPetId,
  secondPetId,
  secondSide = 'left'
}) {
  const petDrivers = feed?.petDrivers ?? {};
  const slugA = petdexSlugOf(firstPetId);
  const slugB = petdexSlugOf(secondPetId);
  const a = slugA ? petDrivers[slugA] : null;
  const b = slugB ? petDrivers[slugB] : null;
  if (!a || !b || a === b) return null;
  const [left, right] = secondSide === 'right' ? [a, b] : [b, a];
  const rowsLeft = feed?.seasonResults?.[left];
  const rowsRight = feed?.seasonResults?.[right];
  if (!Array.isArray(rowsLeft) || !Array.isArray(rowsRight)) return null;
  let winsLeft = 0;
  let winsRight = 0;
  for (let i = 0; i < Math.min(rowsLeft.length, rowsRight.length); i += 1) {
    const pl = rowsLeft[i];
    const pr = rowsRight[i];
    if (!Number.isFinite(pl) || !Number.isFinite(pr)) continue;
    if (pl < pr) winsLeft += 1;
    else if (pr < pl) winsRight += 1;
  }
  if (winsLeft + winsRight === 0) return null;
  const label = (id) => {
    const driver =
      feed?.drivers?.find((d) => d.id === id) ??
      feed?.latestRace?.results?.find((r) => r.driverId === id);
    return driver?.name ? driverSurname(driver.name) : (driver?.code ?? id);
  };
  const season = Number.isSafeInteger(feed?.season) ? `${feed.season} · ` : '';
  const range = Number.isSafeInteger(feed?.season)
    ? `&from=${feed.season}&to=${feed.season}`
    : '';
  return {
    text: `${season}${label(left)} ${winsLeft}–${winsRight} ${label(right)} (races)`,
    target: `/stats/compare/drivers?ids=${left},${right}${range}`
  };
}

// --- Duo reactions (4b): the second sprite's own pose ---

/** Ambient duo wave: the first one this long after the last input… */
export const DUO_WAVE_FIRST_MS = 5 * 60 * 1000;
/** …then one every DUO_WAVE_EVERY_MS… */
export const DUO_WAVE_EVERY_MS = 10 * 60 * 1000;
/**
 * …while the pet is awake (it sleeps at AMBIENT_SLEEP_MS, 2b): waves at 5,
 * 15 and 25 min, never on the 10-min `waiting` switch nor on a look-around
 * (those start on even minutes).
 */
export const DUO_WAVE_UNTIL_MS = AMBIENT_SLEEP_MS;
/** The second pet waves back this long after the first (one `waving` play). */
export const DUO_WAVE_DELAY_MS = 700;

/**
 * @typedef {{ key: string, first: string, second: string }} DuoResultPoses
 *   Head-to-head poses of the latest race (`key` = its race key) for the
 *   first and the second sprite (`duoResultPoses`).
 * @typedef {{ result: DuoResultPoses|null }} DuoInput
 *   Set by the controller only while a duo shows and both pets map to
 *   (different) drivers via `petDrivers`, like the head-to-head hover.
 * @typedef {{ state: string, once: boolean, playKey: string, delayMs: number }} SecondPose
 *   The duo's second sprite plays this instead of the first's animation;
 *   `delayMs` holds the row's first frame that long before it plays.
 */

/** Layers that move both sprites alike: the second mirrors the first. */
const SHARED_LAYERS = new Set(['interaction', 'quiet', 'celebrate', 'chat']);

/** "petdex:max-4" → its driver id via `petDrivers`, or null. */
const petDriver = (feed, petId) => {
  const slug = petdexSlugOf(petId);
  const driver = slug ? feed?.petDrivers?.[slug] : null;
  return typeof driver === 'string' && driver ? driver : null;
};

/**
 * The duo's drivers (first sprite, second sprite), or null unless both pets
 * map to different drivers — the condition for every duo reaction.
 * @param {{ feed: any, firstPetId: string|null, secondPetId: string|null }} input
 * @returns {{ first: string, second: string } | null}
 */
export function duoDrivers({ feed, firstPetId, secondPetId }) {
  const first = petDriver(feed, firstPetId);
  const second = petDriver(feed, secondPetId);
  return first && second && first !== second ? { first, second } : null;
}

/** A classified finish (position > 0), else null (nc / dnf / dsq / dns / dnq). */
const finishPosition = (entry) =>
  Number.isSafeInteger(entry.position) && entry.position > 0
    ? entry.position
    : null;

/**
 * Head-to-head poses of the feed's latest race: the better finisher
 * `jumping`, the other `failed`; any unclassified result counts as worse
 * than a finish; both unclassified → both `failed`; equal → both `waving`.
 * Null when the race or either driver's result is missing.
 * @param {{ feed: any, firstDriverId: string, secondDriverId: string }} input
 * @returns {DuoResultPoses|null}
 */
export function duoResultPoses({ feed, firstDriverId, secondDriverId }) {
  const race = feed?.latestRace;
  if (!race?.key || !Array.isArray(race.results)) return null;
  const a = race.results.find((r) => r.driverId === firstDriverId);
  const b = race.results.find((r) => r.driverId === secondDriverId);
  if (!a || !b) return null;
  const pa = finishPosition(a);
  const pb = finishPosition(b);
  const poses = (first, second) => ({ key: race.key, first, second });
  if (pa === null && pb === null) return poses('failed', 'failed');
  if (pa === pb) return poses('waving', 'waving');
  return pb === null || (pa !== null && pa < pb)
    ? poses('jumping', 'failed')
    : poses('failed', 'jumping');
}

/**
 * The input's duo poses when they belong to the result moment showing.
 * @param {BehaviourInput} input
 */
function duoMomentPoses(input) {
  const moment = input.moment;
  const poses = input.duo?.result;
  if (moment?.kind !== 'result' || !poses || poses.key !== moment.key) {
    return null;
  }
  if (!Number.isFinite(moment.atMs)) return null;
  return STATE_BY_ID.has(poses.first) && STATE_BY_ID.has(poses.second)
    ? poses
    : null;
}

/**
 * The moment, with the duo's head-to-head pose (played once) for the first
 * sprite in place of the favourite's own pose.
 * @param {BehaviourInput} input
 */
function momentWithDuoPose(input) {
  const poses = duoMomentPoses(input);
  return poses
    ? { ...input.moment, state: poses.first, once: true }
    : input.moment;
}

/**
 * Wave start times from the last input: the latest one at or before `now`
 * (null before the first / after DUO_WAVE_UNTIL_MS) and the next one.
 * @param {number} lastActivityAtMs @param {number} now
 * @returns {{ current: number|null, next: number|null }}
 */
export function duoWaveTimes(lastActivityAtMs, now) {
  const first = lastActivityAtMs + DUO_WAVE_FIRST_MS;
  const end = lastActivityAtMs + DUO_WAVE_UNTIL_MS;
  const within = (ms) => (ms < end ? ms : null);
  if (now < first) return { current: null, next: within(first) };
  const current =
    first + Math.floor((now - first) / DUO_WAVE_EVERY_MS) * DUO_WAVE_EVERY_MS;
  return {
    current: within(current),
    next: within(current + DUO_WAVE_EVERY_MS)
  };
}

/**
 * Ambient waves need a mapped duo and a pet that may move (`extrasAllowed`).
 * @param {BehaviourInput} input
 */
const duoWaves = (input) => Boolean(input.duo) && extrasAllowed(input);

/**
 * Ambient layer: the first sprite's wave while one is due, else null (the
 * next wave start becomes a boundary either way).
 * @param {BehaviourInput} input @param {number} now @param {number} lastActivity
 * @param {(ms: number) => void} at
 */
function duoWaveFirst(input, now, lastActivity, at) {
  if (!duoWaves(input)) return null;
  const { current, next } = duoWaveTimes(lastActivity, now);
  if (next !== null) at(next);
  if (current === null) return null;
  const until = current + stateDurationMs('waving');
  if (now >= until) return null;
  at(until);
  return {
    state: 'waving',
    once: true,
    still: false,
    playKey: `duo-wave:${current}`,
    layer: /** @type {Layer} */ ('ambient')
  };
}

/**
 * The duo's second sprite (4b), or null = it plays the first's animation.
 * Interaction, quiet, celebration and chat move both alike; under them the
 * second's own pose waits. A result moment's head-to-head pose runs its own
 * length (it may outlast the first's); an ambient wave answers the first's
 * DUO_WAVE_DELAY_MS later. A sleeping first sprite stills both.
 * @param {BehaviourInput} input
 * @param {{ now: number, at: (ms: number) => void }} ctx
 * @param {{ layer: Layer, sleeping?: boolean }} pick the first sprite's pick
 * @returns {SecondPose|null}
 */
function pickSecond(input, { now, at }, pick) {
  if (!input.duo || pick.sleeping || SHARED_LAYERS.has(pick.layer)) {
    return null;
  }
  const poses = duoMomentPoses(input);
  if (poses && now >= input.moment.atMs) {
    const until = input.moment.atMs + stateDurationMs(poses.second);
    if (now < until) {
      at(until);
      const { kind, key, atMs } = input.moment;
      return {
        state: poses.second,
        once: true,
        playKey: `${kind}:${key}:${atMs}:second`,
        delayMs: 0
      };
    }
  }
  if (pick.layer === 'ambient' && duoWaves(input)) {
    const lastActivity = Number.isFinite(input.lastActivityAtMs)
      ? input.lastActivityAtMs
      : now;
    const { current } = duoWaveTimes(lastActivity, now);
    const until =
      current === null
        ? -Infinity
        : current + DUO_WAVE_DELAY_MS + stateDurationMs('waving');
    if (now < until) {
      at(until);
      return {
        state: 'waving',
        once: true,
        playKey: `duo-wave:${current}:second`,
        delayMs: DUO_WAVE_DELAY_MS
      };
    }
  }
  return null;
}
