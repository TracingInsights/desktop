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
 *   8. ambient → idle; `waiting` loop after AMBIENT_WAITING_MS without input
 *
 * One bubble at a most, by BUBBLE_KINDS priority: hover (countdown / duo
 * head-to-head) > celebration > result > calendar moment > rate nudge >
 * daily fact. Each bubble carries its click target. The controller decides
 * when a once-only moment (result / rate / fact) starts — see
 * `canStartMoment()` — and feeds it back in as `moment`.
 *
 * On battery Lively is treated as Calm and the ambient pose is a still frame;
 * a locked screen stills everything.
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
/** A hover bubble (countdown / duo head-to-head) stays this long. */
export const HOVER_BUBBLE_MS = 6000;
/** Bubble kinds, highest priority first (plan §12). */
export const BUBBLE_KINDS = Object.freeze([
  'hover',
  'celebrate',
  'result',
  'calendar',
  'rate',
  'fact'
]);
/** Where a calendar-moment bubble leads (the home dashboard's schedule). */
export const CALENDAR_TARGET = '/';

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
 *   kind: 'result'|'rate'|'fact',
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
 *   dismissedBubbleKey?: string|null,
 *   dismissedBubbleKeys?: Iterable<string>|null,
 *   lastActivityAtMs?: number|null,
 *   onBattery?: boolean,
 *   locked?: boolean
 * }} BehaviourInput
 *
 * @typedef {'interaction'|'quiet'|'celebrate'|'chat'|'moment'|'calendar'|'ambient'} Layer
 *
 * @typedef {{
 *   state: string,
 *   once: boolean,
 *   still: boolean,
 *   bubble: { key: string, kind: string, text: string, target: string } | null,
 *   playKey: string,
 *   layer: Layer,
 *   nextChangeAt: number|null
 * }} Behaviour
 *   `playKey` changes whenever a `once` animation must restart (two clicks in
 *   a row); `still` = show frame 0 without animating; `layer` = the rule
 *   that picked the pose (reduce motion keeps the underlying layer, so the
 *   controller can still tell an idle pet from a busy one).
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

  const pick = pickState(input, { now, quiet, calendar, at });
  // Reduce motion keeps an interaction's pose but never animates it; every
  // other pose becomes the idle frame (the layer stays for the controller).
  const reduced = Boolean(input.reducedMotion) && pick.layer !== 'interaction';
  const still = Boolean(input.locked || input.reducedMotion || pick.still);
  return {
    state: reduced ? 'idle' : pick.state,
    once: reduced ? false : pick.once,
    still,
    bubble,
    playKey: reduced ? 'idle' : pick.playKey,
    layer: pick.layer,
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
 * @param {{ now: number, quiet: boolean, calendar: ReturnType<typeof activeCalendar>, at: (ms: number) => void }} ctx
 * @returns {{ state: string, once: boolean, still: boolean, playKey: string, layer: Layer }}
 */
function pickState(input, { now, quiet, calendar, at }) {
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

  // 6. Result moment's pose.
  const moment = input.moment;
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
  const still = Boolean(input.onBattery);
  if (now >= waitingAt) {
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

// --- Once-only companion moments (plan §12 #1, #4) and hover texts (#8) ---

/**
 * May a once-only moment of `kind` start now? Never over a user action, a
 * celebration or chat; a result may push aside a calendar bubble (it ranks
 * higher), a rate nudge / daily fact waits for an idle pet with no bubble.
 * @param {'result'|'rate'|'fact'} kind
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
