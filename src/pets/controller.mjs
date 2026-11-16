/**
 * Desktop pets — runtime controller (docs/DESKTOP_PETS_PLAN.md §4.4, §4.5, §12).
 *
 * Holds the live inputs (pet-window interaction, chat signal, power state,
 * reduce motion, last activity, celebration, the current once-only moment),
 * decides whether the pet window should exist, feeds `computeBehaviour()`
 * and pushes `pet:render` payloads. Exactly one timer runs, set to the
 * behaviour's `nextChangeAt` (calendar boundary, quiet / signal / once /
 * bubble expiry, ambient idle) or the next rate-nudge / daily-fact time;
 * nothing polls.
 *
 * Companion moments (plan §12): the result reaction, rate nudge and daily
 * fact each show once (per race / race / local day). A moment starts only
 * when `canStartMoment()` says the pet is free, and its marker
 * (`lastResultKey` / `lastRateKey` / `lastFactDay`) is saved as it starts,
 * so a restart never repeats it. Every bubble's click target stays here in
 * main — the pet page only gets the text. Round 3: the race-weekend
 * greeting (greeting.mjs) works the same way, once per local day part
 * (marker `lastGreetingKey`).
 *
 * Round 3 (L4): bubbles carry buttons (`bubbleActions`, bubble-actions.mjs);
 * a click on the pet toggles the click panel (`panel`, panel.mjs) in place
 * of the bubble — never during a drag, and no once-only moment starts while
 * it is open; an Ask-window `done` while that window is in the background
 * sets the "Answer ready" `badge`, and the next click on the pet opens the
 * Ask window instead of the panel. Panel and badge only when the renderer
 * draws them (`petWindow.can`).
 *
 * Electron-free: the pet window, settings, store, schedule feed and facts
 * are injected.
 */
import {
  ANSWER_BADGE,
  BUBBLE_MS,
  CELEBRATE_KINDS,
  CELEBRATE_TEXT_CHARS,
  CHAT_SIGNALS,
  DAILY_FACT_HOUR,
  PANEL_CLOSE_ID,
  PET_SIZES,
  PET_STATES,
  SESSION_DURATION_MS
} from './contract.mjs';
import {
  CALENDAR_TARGET,
  canStartMoment,
  computeBehaviour,
  duoDrivers,
  duoHeadToHead,
  duoResultPoses,
  HOVER_BUBBLE_MS,
  nextRateNudgeAt,
  rateMoment,
  resultMoment
} from './behaviour.mjs';
import { countdownText } from './schedule.mjs';
import { localDayKey, localHour, nextLocalHourAt } from './facts.mjs';
import {
  greetingKey,
  greetingMoment,
  nextGreetingCheckAt
} from './greeting.mjs';
import { petAssetUrl } from './protocols.mjs';
import { bubbleActionsFor, MUTE_ACTIONS } from './bubble-actions.mjs';
import { buildPanel } from './panel.mjs';

/** Longest single timer; the controller re-plans after it. */
export const MAX_TIMER_MS = 6 * 60 * 60 * 1000;
export const QUIET_HOUR_MS = 60 * 60 * 1000;
/** Games may celebrate at most once per this window (plan §12 #6). */
export const CELEBRATE_MIN_INTERVAL_MS = 10_000;
/** Calm gap after one once-only moment before the next may start. */
export const MOMENT_GAP_MS = 2 * 60 * 1000;
const MAX_DISMISSED = 32;

/** Bubble text when a game sends none, and where its bubble leads. */
const CELEBRATIONS = Object.freeze({
  'hot-lap-pb': { text: 'New personal best!', target: '/games/rwanda' },
  'roadster-best': { text: 'New best run!', target: '/games/roadster' }
});

/** Which setting switches a moment kind on, and which marker it saves. */
export const MOMENT_RULES = Object.freeze({
  result: { toggle: 'resultReactions', marker: 'lastResultKey' },
  rate: { toggle: 'rateNudge', marker: 'lastRateKey' },
  fact: { toggle: 'dailyFact', marker: 'lastFactDay' },
  greeting: { toggle: 'greetings', marker: 'lastGreetingKey' }
});

/**
 * Page-sent celebration text → one plain line ≤ CELEBRATE_TEXT_CHARS
 * (the kind's default when empty).
 * @param {string} kind @param {unknown} text
 */
export function celebrationText(kind, text) {
  const clean =
    typeof text === 'string'
      ? text
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, CELEBRATE_TEXT_CHARS)
      : '';
  return clean || CELEBRATIONS[kind]?.text || 'Nice!';
}

const STATE_BY_ID = new Map(PET_STATES.map((s) => [s.id, s]));

/** @param {'click'|'hover'} kind */
const onceDurationMs = (kind) =>
  STATE_BY_ID.get(kind === 'click' ? 'jumping' : 'waving')?.durationMs ?? 0;

/** The idle loop, for a sprite whose atlas lacks the wanted row. */
const IDLE_POSE = Object.freeze({
  state: 'idle',
  once: false,
  playKey: 'idle',
  delayMs: 0
});

/**
 * The duo's second sprite in the render payload (4b): its own pose from the
 * behaviour, or null = it plays the first's animation (as before). A state
 * whose row the second atlas lacks (`row >= rows`, e.g. a v2-only row on a
 * v1 pet) plays `idle` on that sprite instead.
 * @param {{ still: boolean, second?: import('./behaviour.mjs').SecondPose|null }} out
 * @param {{ row: number }} firstAnim the first sprite's PET_STATES entry
 * @param {number} secondRows the second atlas's row count
 * @returns {null | { state: string, row: number, frames: number, durationMs: number, once: boolean, still: boolean, playKey: string, delayMs: number }}
 */
export function secondAnimation(out, firstAnim, secondRows) {
  const fits = (anim) => !Number.isFinite(secondRows) || anim.row < secondRows;
  const own = out.second ? STATE_BY_ID.get(out.second.state) : null;
  if (!own && fits(firstAnim)) return null;
  const pose = own && fits(own) ? out.second : IDLE_POSE;
  const anim = STATE_BY_ID.get(pose.state);
  return {
    state: anim.id,
    row: anim.row,
    frames: anim.frames,
    durationMs: anim.durationMs,
    once: Boolean(pose.once),
    still: Boolean(out.still),
    playKey: String(pose.playKey),
    delayMs: Math.max(0, Number(pose.delayMs) || 0)
  };
}

/**
 * @param {{
 *   settings: {
 *     get: () => { enabled: boolean, activePetId: string|null, size: 's'|'m'|'l', chatReactions: boolean, sessionReactions: 'calm'|'lively'|'off', quietUntil: string|null },
 *     setQuietUntil: (iso: string|null) => { ok: boolean, error?: string },
 *     setMarker?: (name: 'lastResultKey'|'lastRateKey'|'lastFactDay'|'lastGreetingKey', value: string) => { ok: boolean, error?: string },
 *     update?: (patch: Record<string, unknown>) => { ok: boolean, error?: string }
 *   },
 *   store: { get: (id: string) => ({ atlas: { rows: number, scale: number }, imagePath?: string } | null) },
 *   getSessions: () => readonly object[],
 *   calendarPhase: (sessions: readonly object[], nowMs: number) => { phase: 'lead'|'live'|null, session: object|null, nextBoundaryAt: number|null },
 *   sessionBubble: (session: object, phase: 'lead'|'live', nowMs: number) => string,
 *   getFeed?: () => (import('./schedule.mjs').Feed | null),
 *   facts?: { today: (nowMs: number) => ({ day: string, text: string|null, path: string } | null) } | null,
 *   petWindow: {
 *     show: (options: { size: 's'|'m'|'l', duo: boolean }) => void,
 *     hide: () => void,
 *     isShown: () => boolean,
 *     render: (payload: object) => void,
 *     moveBy: (dx: number, dy: number) => void,
 *     savePosition: () => void,
 *     secondSide?: () => 'left'|'right',
 *     can?: (feature: 'panel'|'badge') => boolean
 *   },
 *   support: () => { supported: boolean, needsRestartForPets: boolean },
 *   openMain: (path?: string) => void,
 *   openAsk?: () => void,
 *   askInBackground?: () => boolean,
 *   showContextMenu?: () => void,
 *   now?: () => number,
 *   locale?: string,
 *   timeZone?: string,
 *   setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout,
 *   onError?: (error: unknown) => void
 * }} deps
 */
/**
 * A drag with no movement for this long counts as dropped: moving the window
 * under the pointer can lose the button release on X11/XWayland, which would
 * otherwise leave the pet running in place forever.
 */
export const DRAG_IDLE_MS = 1500;

export function createPetController(deps) {
  const {
    settings,
    store,
    getSessions,
    calendarPhase,
    sessionBubble,
    getFeed = () => null,
    facts = null,
    petWindow,
    support,
    openMain,
    openAsk = () => {},
    askInBackground = () => false,
    showContextMenu = () => {},
    now = Date.now,
    // Greeting times: the runtime's locale / time zone unless given (tests).
    locale = undefined,
    timeZone = undefined,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    onError = (error) => console.warn('[pets] controller:', error)
  } = deps;

  /** @type {null | { kind: 'drag', direction: 'left'|'right' } | { kind: 'click'|'hover', atMs: number }} */
  let interaction = null;
  /** @type {null | { signal: string, atMs: number }} */
  let chat = null;
  let lastActivityAtMs = now();
  /** Last pet-window input (roaming waits ROAM_AFTER_INPUT_MS after it); null = none. */
  let lastInteractionAtMs = null;
  let onBattery = false;
  let locked = false;
  let osReducedMotion = false;
  let pageReducedMotion = false;
  /** Bubbles the user clicked away (newest last, capped). */
  const dismissedBubbleKeys = new Set();
  /** @type {null | { key: string, target: string, kind: string }} */
  let currentBubble = null;
  /** @type {null | { atMs: number, text: string, target: string }} */
  let hoverBubble = null;
  /** @type {null | { atMs: number, text: string, target: string }} */
  let celebration = null;
  /** @type {number|null} */
  let lastCelebrateAt = null;
  /** The once-only moment showing now (result / rate / fact). */
  /** @type {null | import('./behaviour.mjs').Moment} */
  let moment = null;
  /** When the last once-only moment ended (MOMENT_GAP_MS spacing). */
  let lastMomentEndAt = -Infinity;
  /** Markers already used this run (kept even if saving them failed). */
  const usedMarkers = {
    lastResultKey: null,
    lastRateKey: null,
    lastFactDay: null,
    lastGreetingKey: null
  };
  let timer = null;
  /** Ends a drag whose release never arrived (X11 can drop it, see DRAG_IDLE_MS). */
  let dragTimer = null;
  let started = false;
  let refreshing = false;
  let refreshAgain = false;
  /** Last payload sent, as JSON, to skip identical renders. */
  let lastRenderJson = '';
  /** @type {object|null} */
  let lastRender = null;
  /** Sprite URL cache-buster, bumped when installed pets change. */
  let assetVersion = 0;
  /** Click panel (round 3, 3a): open from a click until closed again. */
  let panelOpen = false;
  /** The open panel's action targets (id → app path), kept in main. */
  /** @type {Record<string, string>} */
  let panelTargets = {};
  /** "Answer ready" badge (round 3, 3b), or null. */
  /** @type {null | { kind: string, label: string }} */
  let badge = null;

  /** Does the renderer draw this round-3 feature? (Fakes without `can`: yes.) */
  const petCan = (feature) => petWindow.can?.(feature) ?? true;

  function endDrag() {
    if (dragTimer !== null) {
      clearTimer(dragTimer);
      dragTimer = null;
    }
    if (interaction?.kind !== 'drag') return false;
    interaction = null;
    petWindow.savePosition();
    return true;
  }

  function armDragWatchdog() {
    if (dragTimer !== null) clearTimer(dragTimer);
    dragTimer = setTimer(() => {
      dragTimer = null;
      if (endDrag()) refresh();
    }, DRAG_IDLE_MS);
    dragTimer?.unref?.();
  }

  function clearPlannedTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function plan(atMs) {
    clearPlannedTimer();
    if (!Number.isFinite(atMs)) return;
    const delay = Math.min(Math.max(0, atMs - now()), MAX_TIMER_MS);
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delay);
    timer?.unref?.();
  }

  function quietUntilMs(current) {
    const ms = current.quietUntil ? Date.parse(current.quietUntil) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  /** The pet record to show, or null when the window should not exist. */
  function visiblePet(current) {
    if (!current.enabled || !current.activePetId) return null;
    const where = support();
    if (!where.supported || where.needsRestartForPets) return null;
    try {
      return store.get(current.activePetId);
    } catch {
      return null;
    }
  }

  function calendarInput(nowMs, current) {
    if (current.sessionReactions === 'off') return null;
    let phase;
    try {
      phase = calendarPhase(getSessions() ?? [], nowMs);
    } catch {
      return null;
    }
    if (!phase) return null;
    let bubble = null;
    if (phase.phase && phase.session) {
      try {
        bubble = sessionBubble(phase.session, phase.phase, nowMs);
      } catch {
        bubble = null;
      }
    }
    return { ...phase, bubble };
  }

  function readFeed() {
    try {
      return getFeed() ?? null;
    } catch {
      return null;
    }
  }

  /** The duo's second pet record, or null (unset, same as the first, gone). */
  function secondPet(current) {
    const id = current.secondPetId;
    if (!id || id === current.activePetId) return null;
    try {
      return store.get(id);
    } catch {
      return null;
    }
  }

  /**
   * Duo reactions input (4b): only while a duo shows and both pets map to
   * different drivers (like the head-to-head hover); `result` = the latest
   * race's head-to-head poses, first sprite then second.
   */
  function duoInput(current) {
    const feed = readFeed();
    const drivers = duoDrivers({
      feed,
      firstPetId: current.activePetId,
      secondPetId: current.secondPetId
    });
    if (!drivers || !secondPet(current)) return null;
    return {
      result: duoResultPoses({
        feed,
        firstDriverId: drivers.first,
        secondDriverId: drivers.second
      })
    };
  }

  /**
   * A result bubble adds the duo's season head-to-head (the hover line,
   * names in sprite order) while two mapped pets show (4b).
   * @param {Omit<import('./behaviour.mjs').Moment, 'atMs'>} next @param {any} current
   */
  function withDuoHeadToHead(next, current) {
    if (!secondPet(current)) return next;
    const duo = duoHeadToHead({
      feed: readFeed(),
      firstPetId: current.activePetId,
      secondPetId: current.secondPetId,
      secondSide: petWindow.secondSide?.() ?? 'left'
    });
    return duo ? { ...next, text: `${next.text} · ${duo.text}` } : next;
  }

  const markerUsed = (current, name, value) =>
    current[name] === value || usedMarkers[name] === value;

  /**
   * The race-weekend greeting that may start now (greeting.mjs), if any.
   * @param {number} nowMs @param {any} current @param {import('./behaviour.mjs').Behaviour} out
   */
  function nextGreeting(nowMs, current, out) {
    if (!current.greetings || !canStartMoment('greeting', out)) return null;
    try {
      const key = greetingKey(nowMs, timeZone);
      if (!key || markerUsed(current, 'lastGreetingKey', key)) return null;
      return greetingMoment({
        sessions: getSessions() ?? [],
        nowMs,
        locale,
        timeZone
      });
    } catch {
      return null;
    }
  }

  /**
   * The once-only moment that may start now, if any (result > greeting >
   * rate > fact).
   * @param {number} nowMs @param {any} current @param {import('./behaviour.mjs').Behaviour} out
   */
  function nextMoment(nowMs, current, out) {
    if (nowMs < lastMomentEndAt + MOMENT_GAP_MS) return null;
    const feed = readFeed();
    if (current.resultReactions && canStartMoment('result', out)) {
      const next = resultMoment({
        feed,
        favoriteDriverId: current.favoriteDriverId,
        nowMs
      });
      if (next && !markerUsed(current, 'lastResultKey', next.key)) {
        return withDuoHeadToHead(next, current);
      }
    }
    const greeting = nextGreeting(nowMs, current, out);
    if (greeting) return greeting;
    if (current.rateNudge && canStartMoment('rate', out)) {
      const next = rateMoment({ feed, nowMs });
      if (next && !markerUsed(current, 'lastRateKey', next.key)) return next;
    }
    if (current.dailyFact && localHour(nowMs) >= DAILY_FACT_HOUR) {
      const day = localDayKey(nowMs);
      if (!markerUsed(current, 'lastFactDay', day)) {
        // Asks for today's artifact (fetched once a day) even while busy.
        let fact;
        try {
          fact = facts?.today(nowMs) ?? null;
        } catch {
          fact = null;
        }
        if (fact?.text && fact.day === day && canStartMoment('fact', out)) {
          return {
            kind: 'fact',
            key: day,
            text: fact.text,
            target: fact.path,
            state: null,
            once: false
          };
        }
      }
    }
    return null;
  }

  /** Save a started moment's marker (best effort; memory keeps it anyway). */
  function useMarker(started) {
    const { marker } = MOMENT_RULES[started.kind];
    usedMarkers[marker] = started.key;
    try {
      settings.setMarker?.(marker, started.key);
    } catch {
      // In-memory marker still stops a repeat in this run.
    }
  }

  /** Next wake-up the behaviour itself cannot see (rate nudge / fact hour / greeting day part). */
  function companionWakeAt(nowMs, current) {
    const times = [];
    if (current.rateNudge) {
      const due = nextRateNudgeAt({ feed: readFeed(), nowMs });
      if (due !== null) times.push(due);
    }
    if (current.dailyFact && facts) {
      times.push(nextLocalHourAt(nowMs, DAILY_FACT_HOUR));
    }
    if (current.greetings) {
      try {
        const check = nextGreetingCheckAt({
          sessions: getSessions() ?? [],
          nowMs,
          timeZone
        });
        if (check !== null) times.push(check);
      } catch {
        // No schedule (or a bad time zone): the next refresh looks again.
      }
      // A live session holds the greeting back: look again when it ends
      // (the calendar's own boundaries are gone with sessionReactions off).
      const sessionEnd = currentSessionEndMs();
      if (sessionEnd !== null) times.push(sessionEnd);
    }
    if (moment === null && Number.isFinite(lastMomentEndAt)) {
      const gapEnd = lastMomentEndAt + MOMENT_GAP_MS;
      if (gapEnd > nowMs) times.push(gapEnd);
    }
    return times.length > 0 ? Math.min(...times) : Infinity;
  }

  /** @param {{ atlas: { rows: number } }} pet the first (shown) pet */
  function behaviourInput(nowMs, current, quietMs, pet) {
    return {
      nowMs,
      // v2 sheets (11 rows) unlock the look-around states (behaviour.mjs).
      atlasRows: pet.atlas.rows,
      interaction,
      hoverBubble,
      reducedMotion: osReducedMotion || pageReducedMotion,
      quietUntilMs: quietMs,
      chatReactions: current.chatReactions,
      chat,
      sessionReactions: current.sessionReactions,
      roam: current.roam === true,
      lastInteractionAtMs,
      calendar: calendarInput(nowMs, current),
      celebration,
      moment,
      duo: duoInput(current),
      dismissedBubbleKeys,
      lastActivityAtMs,
      onBattery,
      locked
    };
  }

  function refreshOnce() {
    const nowMs = now();
    const current = settings.get();

    // Quiet clears itself once it has passed.
    const quietMs = quietUntilMs(current);
    if (current.quietUntil && (quietMs === null || quietMs <= nowMs)) {
      settings.setQuietUntil(null);
    }

    const pet = visiblePet(current);
    if (!pet) {
      if (petWindow.isShown()) petWindow.hide();
      lastRenderJson = '';
      lastRender = null;
      interaction = null;
      hoverBubble = null;
      celebration = null;
      currentBubble = null;
      panelOpen = false;
      plan(quietMs !== null && quietMs > nowMs ? quietMs : NaN);
      return;
    }
    if (!petWindow.isShown()) {
      lastRenderJson = '';
      petWindow.show({ size: current.size, duo: secondPet(current) !== null });
    }

    // Expire / switch off the transient bubbles before deciding.
    if (hoverBubble && nowMs >= hoverBubble.atMs + HOVER_BUBBLE_MS) {
      hoverBubble = null;
    }
    if (celebration && nowMs >= celebration.atMs + BUBBLE_MS)
      celebration = null;
    if (
      moment &&
      (nowMs >= moment.atMs + BUBBLE_MS ||
        !current[MOMENT_RULES[moment.kind].toggle])
    ) {
      lastMomentEndAt = Math.min(nowMs, moment.atMs + BUBBLE_MS);
      moment = null;
    }

    const quietNow = quietMs !== null && quietMs > nowMs;
    // A renderer that cannot draw the panel (an older native pet) never keeps one open.
    if (panelOpen && !petCan('panel')) panelOpen = false;
    let out = computeBehaviour(behaviourInput(nowMs, current, quietMs, pet));
    // The open panel hides bubbles: a once-only moment waits until it closes.
    if (!moment && !quietNow && !locked && !panelOpen) {
      const next = nextMoment(nowMs, current, out);
      if (next) {
        moment = { ...next, atMs: nowMs };
        useMarker(moment);
        out = computeBehaviour(behaviourInput(nowMs, current, quietMs, pet));
      }
    }
    // The panel replaces the bubble while it is open.
    currentBubble =
      out.bubble && !panelOpen
        ? {
            key: out.bubble.key,
            target: out.bubble.target,
            kind: out.bubble.kind
          }
        : null;
    const panel = panelOpen ? buildPanelNow(nowMs, current) : null;
    const second = secondPet(current);
    const anim = STATE_BY_ID.get(out.state) ?? STATE_BY_ID.get('idle');
    const payload = {
      state: anim.id,
      row: anim.row,
      frames: anim.frames,
      durationMs: anim.durationMs,
      once: out.once,
      still: out.still,
      sleeping: out.sleeping,
      playKey: out.playKey,
      // Round 3 (2a): the pet window walks while this is set (roam.mjs) —
      // never while the panel is open (3a): it would carry the panel off.
      motion: panelOpen ? null : (out.motion ?? null),
      bubble: currentBubble ? out.bubble.text : null,
      size: Object.hasOwn(PET_SIZES, current.size) ? current.size : 'm',
      atlas: {
        url: petAssetUrl(current.activePetId, assetVersion),
        rows: pet.atlas.rows,
        scale: pet.atlas.scale
      },
      second: second
        ? {
            url: petAssetUrl(current.secondPetId, assetVersion),
            rows: second.atlas.rows,
            scale: second.atlas.scale
          }
        : null,
      secondAnim: second ? secondAnimation(out, anim, second.atlas.rows) : null,
      bubbleActions: currentBubble
        ? bubbleActionsFor(currentBubble.kind, {
            sessionQuiet: currentSessionEndMs() !== null
          })
        : null,
      panel: panel ? { lines: panel.lines, actions: panel.actions } : null,
      badge: badge && petCan('badge') ? { ...badge } : null
    };
    const json = JSON.stringify(payload);
    if (json !== lastRenderJson) {
      lastRenderJson = json;
      lastRender = payload;
      petWindow.render(payload);
    }
    const wakeAt = Math.min(
      out.nextChangeAt ?? Infinity,
      companionWakeAt(nowMs, current),
      panel?.changesAt ?? Infinity
    );
    plan(Number.isFinite(wakeAt) ? wakeAt : NaN);
  }

  function refresh() {
    if (!started) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        try {
          refreshOnce();
        } catch (error) {
          onError(error);
        }
      } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  }

  function touch() {
    lastActivityAtMs = now();
  }

  const api = {
    start() {
      started = true;
      touch();
      refresh();
    },
    stop() {
      started = false;
      clearPlannedTimer();
      if (petWindow.isShown()) petWindow.hide();
    },
    refresh,
    /** Last payload pushed to the pet window (tests, diagnostics). */
    lastRender: () => lastRender,
    /**
     * The bubble showing now: its key, kind (BUBBLE_KINDS), click target
     * and — for a once-only moment — the marker it saved (the native
     * timeline reports which moments the user really saw, and mutes a kind
     * offline, docs/DESKTOP_PETS_NATIVE_PLAN.md §4.2).
     * @returns {null | { key: string, kind: string, target: string, marker: null | { name: string, value: string } }}
     */
    currentBubble() {
      if (!currentBubble) return null;
      const isMoment =
        moment !== null && currentBubble.key === `${moment.kind}:${moment.key}`;
      return {
        key: currentBubble.key,
        kind: currentBubble.kind,
        target: currentBubble.target,
        marker: isMoment
          ? { name: MOMENT_RULES[moment.kind].marker, value: moment.key }
          : null
      };
    },

    /**
     * Pet-window events (already sender-checked and validated by ipc.mjs).
     * `bubbleAction` / `panelAction` take the button id.
     * @param {'ready'|'drag'|'dragEnd'|'click'|'dblclick'|'hover'|'contextMenu'|'bubbleClick'|'bubbleAction'|'panelAction'} kind
     * @param {...any} args
     */
    petEvent(kind, ...args) {
      // Any pet input stops a walk; roaming resumes ROAM_AFTER_INPUT_MS later.
      if (kind !== 'ready') lastInteractionAtMs = now();
      switch (kind) {
        case 'ready': {
          pageReducedMotion = Boolean(args[0]?.reducedMotion);
          lastRenderJson = '';
          break;
        }
        case 'drag': {
          const [dx, dy] = args;
          petWindow.moveBy(dx, dy);
          touch();
          armDragWatchdog();
          const previous =
            interaction?.kind === 'drag' ? interaction.direction : 'right';
          const direction = dx < 0 ? 'left' : dx > 0 ? 'right' : previous;
          if (
            interaction?.kind === 'drag' &&
            interaction.direction === direction
          )
            return;
          interaction = { kind: 'drag', direction };
          break;
        }
        case 'dragEnd': {
          if (!endDrag()) petWindow.savePosition();
          touch();
          break;
        }
        case 'click': {
          const dragging = interaction?.kind === 'drag';
          interaction = { kind: 'click', atMs: now() };
          touch();
          // A drag never opens the panel.
          if (!dragging) clickPanelOrBadge();
          break;
        }
        case 'hover': {
          const t = now();
          touch();
          // Never interrupt a drag or a click/hover that is still playing.
          if (interaction?.kind === 'drag') return;
          if (
            interaction &&
            t < interaction.atMs + onceDurationMs(interaction.kind)
          )
            return;
          interaction = { kind: 'hover', atMs: t };
          const content = hoverContent(t);
          hoverBubble = content ? { atMs: t, ...content } : null;
          break;
        }
        case 'dblclick': {
          touch();
          openMain();
          return;
        }
        case 'bubbleClick': {
          const clicked = currentBubble;
          if (clicked) dismissBubble(clicked.key);
          touch();
          openMain(clicked?.target ?? CALENDAR_TARGET);
          break;
        }
        case 'contextMenu': {
          touch();
          showContextMenu();
          // Re-render: a walking pet stops under the menu.
          break;
        }
        case 'bubbleAction': {
          touch();
          bubbleAction(args[0]);
          break;
        }
        case 'panelAction': {
          touch();
          panelAction(args[0]);
          break;
        }
        default:
          return;
      }
      refresh();
    },

    /**
     * Chat activity from the page (`pets:signal`). `from` = the window that
     * sent it ('ask' = the quick-ask window): its `done` while that window
     * is in the background shows the "Answer ready" badge.
     * @param {string} signal one of CHAT_SIGNALS
     * @param {'ask'|'main'|null} [from]
     */
    signal(signal, from = null) {
      if (!CHAT_SIGNALS.includes(signal))
        return { ok: false, error: 'Unknown signal.' };
      chat = signal === 'idle' ? null : { signal, atMs: now() };
      if (signal === 'done' && from === 'ask') noteAskAnswer();
      touch();
      refresh();
      return { ok: true };
    },

    /**
     * A game's personal best (`pets:celebrate`, plan §12 #6): jumping once +
     * the text in a bubble. At most one per CELEBRATE_MIN_INTERVAL_MS (extra
     * calls are dropped, not queued); dropped while quiet, locked or with no
     * pet showing.
     * @param {string} kind one of CELEBRATE_KINDS
     * @param {string} text ≤ CELEBRATE_TEXT_CHARS
     * @returns {{ ok: true, shown: boolean } | { ok: false, error: string }}
     */
    celebrate(kind, text) {
      if (!CELEBRATE_KINDS.includes(kind)) {
        return { ok: false, error: 'Unknown celebration.' };
      }
      const t = now();
      if (
        lastCelebrateAt !== null &&
        t - lastCelebrateAt < CELEBRATE_MIN_INTERVAL_MS
      ) {
        return { ok: true, shown: false };
      }
      lastCelebrateAt = t;
      const current = settings.get();
      const quietMs = quietUntilMs(current);
      if (
        !started ||
        locked ||
        (quietMs !== null && quietMs > t) ||
        !visiblePet(current)
      ) {
        return { ok: true, shown: false };
      }
      celebration = {
        atMs: t,
        text: celebrationText(kind, text),
        target: CELEBRATIONS[kind].target
      };
      touch();
      refresh();
      return { ok: true, shown: true };
    },

    /**
     * Quiet controls (pet menu, tray, page).
     * @param {'session'|'1h'|'off'} kind
     * @returns {{ ok: true } | { ok: false, error: string }}
     */
    quiet(kind) {
      let until = null;
      if (kind === '1h') {
        until = new Date(now() + QUIET_HOUR_MS).toISOString();
      } else if (kind === 'session') {
        const end = currentSessionEndMs();
        if (end === null)
          return { ok: false, error: 'No session is on right now.' };
        until = new Date(end).toISOString();
      } else if (kind !== 'off') {
        return { ok: false, error: 'Unknown quiet option.' };
      }
      const result = settings.setQuietUntil(until);
      if (!result.ok)
        return { ok: false, error: result.error ?? 'Could not save.' };
      refresh();
      return { ok: true };
    },

    /** The session "Quiet until this session ends" would cover, if any. */
    sessionQuietAvailable() {
      return currentSessionEndMs() !== null;
    },

    /** @param {'lock-screen'|'unlock-screen'|'on-battery'|'on-ac'|'resume'|'suspend'} event */
    power(event) {
      if (event === 'lock-screen') locked = true;
      else if (event === 'unlock-screen') locked = false;
      else if (event === 'on-battery') onBattery = true;
      else if (event === 'on-ac') onBattery = false;
      else if (event === 'resume') locked = false;
      else return;
      refresh();
    },

    /** @param {{ onBattery?: boolean, reducedMotion?: boolean }} state */
    setEnvironment(state) {
      if (typeof state.onBattery === 'boolean') onBattery = state.onBattery;
      if (typeof state.reducedMotion === 'boolean')
        osReducedMotion = state.reducedMotion;
      refresh();
    },

    /** Installed pets changed (install / remove / import): reload the sprite. */
    assetsChanged() {
      assetVersion += 1;
      refresh();
    },

    /** Main-window focus etc. counts as activity for the ambient timer (and wakes a sleeping pet). */
    noteActivity() {
      const wasWaiting =
        (lastRender?.state === 'waiting' && !chat) ||
        lastRender?.sleeping === true;
      touch();
      if (wasWaiting) refresh();
    },

    /** The Ask window was opened or focused: its answer has been seen. */
    clearBadge() {
      if (!badge) return;
      badge = null;
      refresh();
    }
  };
  return api;

  function currentSessionEndMs() {
    const nowMs = now();
    let phase;
    try {
      phase = calendarPhase(getSessions() ?? [], nowMs);
    } catch {
      return null;
    }
    const session = phase?.phase ? phase.session : null;
    if (!session) return null;
    const startsAt = Date.parse(session.startsAt);
    const length = SESSION_DURATION_MS[session.kind];
    if (!Number.isFinite(startsAt) || !length) return null;
    const end = startsAt + length;
    return end > nowMs ? end : null;
  }

  /** @param {string} key */
  function dismissBubble(key) {
    dismissedBubbleKeys.delete(key);
    dismissedBubbleKeys.add(key);
    while (dismissedBubbleKeys.size > MAX_DISMISSED) {
      dismissedBubbleKeys.delete(dismissedBubbleKeys.values().next().value);
    }
    if (moment && `${moment.kind}:${moment.key}` === key) {
      lastMomentEndAt = now();
      moment = null;
    }
  }

  // --- Round 3 (L4): bubble buttons, click panel, answer badge ---

  /** The panel for now (lines, actions, targets kept here). */
  function buildPanelNow(nowMs, current) {
    let sessions;
    try {
      sessions = getSessions() ?? [];
    } catch {
      sessions = [];
    }
    const built = buildPanel({
      sessions,
      feed: readFeed(),
      favoriteDriverId: current.favoriteDriverId ?? null,
      nowMs
    });
    panelTargets = built.targets;
    return built;
  }

  function openAskWindow() {
    try {
      openAsk();
    } catch (error) {
      onError(error);
    }
  }

  /** A click on the pet: the waiting answer first, else toggle the panel. */
  function clickPanelOrBadge() {
    if (badge && petCan('badge')) {
      badge = null;
      panelOpen = false;
      openAskWindow();
      return;
    }
    panelOpen = !panelOpen && petCan('panel');
  }

  /** @param {unknown} id a BUBBLE_ACTION_IDS id (ipc.mjs validated it) */
  function bubbleAction(id) {
    const shown = currentBubble;
    if (!shown) return;
    const offered = bubbleActionsFor(shown.kind, {
      sessionQuiet: currentSessionEndMs() !== null
    });
    if (!offered?.some((action) => action.id === id)) return;
    // Every button puts this bubble away; none opens a window.
    dismissBubble(shown.key);
    if (id === 'quiet-1h') api.quiet('1h');
    else if (id === 'quiet-session') api.quiet('session');
    else if (id === 'mute' && Object.hasOwn(MUTE_ACTIONS, shown.kind)) {
      // The page path: only page-writable keys, so the gallery follows it.
      try {
        settings.update?.({ ...MUTE_ACTIONS[shown.kind].patch });
      } catch (error) {
        onError(error);
      }
    }
  }

  /** @param {unknown} id a PANEL_ACTION_IDS id or PANEL_CLOSE_ID */
  function panelAction(id) {
    if (!panelOpen) return;
    if (id === PANEL_CLOSE_ID) {
      panelOpen = false;
      return;
    }
    if (typeof id !== 'string' || !Object.hasOwn(panelTargets, id)) return;
    panelOpen = false;
    if (id === 'ask') {
      badge = null;
      openAskWindow();
    } else {
      openMain(panelTargets[id]);
    }
  }

  /** An Ask-window answer arrived: badge it unless that window is in front. */
  function noteAskAnswer() {
    if (settings.get().chatReactions === false) return;
    let background;
    try {
      background = Boolean(askInBackground());
    } catch {
      background = false;
    }
    if (background) badge = ANSWER_BADGE;
  }

  /**
   * Hover text (plan §12 #2, #8): the duo's season head-to-head when both
   * pets map to drivers, else the session countdown (sessionReactions ≠ off).
   * @param {number} t
   * @returns {{ text: string, target: string } | null}
   */
  function hoverContent(t) {
    const current = settings.get();
    if (secondPet(current)) {
      const duo = duoHeadToHead({
        feed: readFeed(),
        firstPetId: current.activePetId,
        secondPetId: current.secondPetId,
        secondSide: petWindow.secondSide?.() ?? 'left'
      });
      if (duo) return duo;
    }
    if (current.sessionReactions === 'off') return null;
    let text;
    try {
      text = countdownText(getSessions() ?? [], t);
    } catch {
      text = null;
    }
    return text ? { text, target: CALENDAR_TARGET } : null;
  }
}
