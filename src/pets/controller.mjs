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
 * main — the pet page only gets the text.
 *
 * Electron-free: the pet window, settings, store, schedule feed and facts
 * are injected.
 */
import {
  BUBBLE_MS,
  CELEBRATE_KINDS,
  CELEBRATE_TEXT_CHARS,
  CHAT_SIGNALS,
  DAILY_FACT_HOUR,
  PET_SIZES,
  PET_STATES,
  SESSION_DURATION_MS
} from './contract.mjs';
import {
  CALENDAR_TARGET,
  canStartMoment,
  computeBehaviour,
  duoHeadToHead,
  HOVER_BUBBLE_MS,
  nextRateNudgeAt,
  rateMoment,
  resultMoment
} from './behaviour.mjs';
import { countdownText } from './schedule.mjs';
import { localDayKey, localHour, nextLocalHourAt } from './facts.mjs';
import { petAssetUrl } from './protocols.mjs';

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
  fact: { toggle: 'dailyFact', marker: 'lastFactDay' }
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

/**
 * @param {{
 *   settings: {
 *     get: () => { enabled: boolean, activePetId: string|null, size: 's'|'m'|'l', chatReactions: boolean, sessionReactions: 'calm'|'lively'|'off', quietUntil: string|null },
 *     setQuietUntil: (iso: string|null) => { ok: boolean, error?: string },
 *     setMarker?: (name: 'lastResultKey'|'lastRateKey'|'lastFactDay', value: string) => { ok: boolean, error?: string }
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
 *     secondSide?: () => 'left'|'right'
 *   },
 *   support: () => { supported: boolean, needsRestartForPets: boolean },
 *   openMain: (path?: string) => void,
 *   showContextMenu?: () => void,
 *   now?: () => number,
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
    showContextMenu = () => {},
    now = Date.now,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    onError = (error) => console.warn('[pets] controller:', error)
  } = deps;

  /** @type {null | { kind: 'drag', direction: 'left'|'right' } | { kind: 'click'|'hover', atMs: number }} */
  let interaction = null;
  /** @type {null | { signal: string, atMs: number }} */
  let chat = null;
  let lastActivityAtMs = now();
  let onBattery = false;
  let locked = false;
  let osReducedMotion = false;
  let pageReducedMotion = false;
  /** Bubbles the user clicked away (newest last, capped). */
  const dismissedBubbleKeys = new Set();
  /** @type {null | { key: string, target: string }} */
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
    lastFactDay: null
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

  const markerUsed = (current, name, value) =>
    current[name] === value || usedMarkers[name] === value;

  /**
   * The once-only moment that may start now, if any (result > rate > fact).
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
      if (next && !markerUsed(current, 'lastResultKey', next.key)) return next;
    }
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

  /** Next wake-up the behaviour itself cannot see (rate nudge / fact hour). */
  function companionWakeAt(nowMs, current) {
    const times = [];
    if (current.rateNudge) {
      const due = nextRateNudgeAt({ feed: readFeed(), nowMs });
      if (due !== null) times.push(due);
    }
    if (current.dailyFact && facts) {
      times.push(nextLocalHourAt(nowMs, DAILY_FACT_HOUR));
    }
    if (moment === null && Number.isFinite(lastMomentEndAt)) {
      const gapEnd = lastMomentEndAt + MOMENT_GAP_MS;
      if (gapEnd > nowMs) times.push(gapEnd);
    }
    return times.length > 0 ? Math.min(...times) : Infinity;
  }

  function behaviourInput(nowMs, current, quietMs) {
    return {
      nowMs,
      interaction,
      hoverBubble,
      reducedMotion: osReducedMotion || pageReducedMotion,
      quietUntilMs: quietMs,
      chatReactions: current.chatReactions,
      chat,
      sessionReactions: current.sessionReactions,
      calendar: calendarInput(nowMs, current),
      celebration,
      moment,
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
    let out = computeBehaviour(behaviourInput(nowMs, current, quietMs));
    if (!moment && !quietNow && !locked) {
      const next = nextMoment(nowMs, current, out);
      if (next) {
        moment = { ...next, atMs: nowMs };
        useMarker(moment);
        out = computeBehaviour(behaviourInput(nowMs, current, quietMs));
      }
    }
    currentBubble = out.bubble
      ? { key: out.bubble.key, target: out.bubble.target }
      : null;
    const second = secondPet(current);
    const anim = STATE_BY_ID.get(out.state) ?? STATE_BY_ID.get('idle');
    const payload = {
      state: anim.id,
      row: anim.row,
      frames: anim.frames,
      durationMs: anim.durationMs,
      once: out.once,
      still: out.still,
      playKey: out.playKey,
      bubble: out.bubble?.text ?? null,
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
        : null
    };
    const json = JSON.stringify(payload);
    if (json !== lastRenderJson) {
      lastRenderJson = json;
      lastRender = payload;
      petWindow.render(payload);
    }
    const wakeAt = Math.min(
      out.nextChangeAt ?? Infinity,
      companionWakeAt(nowMs, current)
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

  return {
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
     * The bubble showing now: its key, click target and — for a once-only
     * moment — the marker it saved (the native timeline reports which
     * moments the user really saw, docs/DESKTOP_PETS_NATIVE_PLAN.md §4.2).
     * @returns {null | { key: string, target: string, marker: null | { name: string, value: string } }}
     */
    currentBubble() {
      if (!currentBubble) return null;
      const isMoment =
        moment !== null && currentBubble.key === `${moment.kind}:${moment.key}`;
      return {
        key: currentBubble.key,
        target: currentBubble.target,
        marker: isMoment
          ? { name: MOMENT_RULES[moment.kind].marker, value: moment.key }
          : null
      };
    },

    /**
     * Pet-window events (already sender-checked and validated by ipc.mjs).
     * @param {'ready'|'drag'|'dragEnd'|'click'|'dblclick'|'hover'|'contextMenu'|'bubbleClick'} kind
     * @param {...any} args
     */
    petEvent(kind, ...args) {
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
          interaction = { kind: 'click', atMs: now() };
          touch();
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
          return;
        }
        default:
          return;
      }
      refresh();
    },

    /**
     * Chat activity from the page (`pets:signal`).
     * @param {string} signal one of CHAT_SIGNALS
     */
    signal(signal) {
      if (!CHAT_SIGNALS.includes(signal))
        return { ok: false, error: 'Unknown signal.' };
      chat = signal === 'idle' ? null : { signal, atMs: now() };
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

    /** Main-window focus etc. counts as activity for the ambient timer. */
    noteActivity() {
      const wasWaiting = lastRender?.state === 'waiting' && !chat;
      touch();
      if (wasWaiting) refresh();
    }
  };

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
