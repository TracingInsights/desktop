/**
 * Desktop pets — the click panel's content (round 3, 3a).
 *
 * Pure: `buildPanel()` turns the schedule feed + settings into the small
 * panel a click on the pet opens — up to three short lines (the next / live
 * session countdown, the favourite driver's latest result or else the latest
 * race winner) and the quick actions that apply now, each with the app path
 * it opens. The controller sends `{ lines, actions }` to the pet window and
 * keeps the targets in main (like bubble targets); the native timeline can
 * store the same panel for the pet's offline mode (`--pets-open=<target>`,
 * ASK_PATH opens the Ask window).
 */
import {
  ASK_PATH,
  PANEL_ACTION_IDS,
  SESSION_DURATION_MS
} from './contract.mjs';
import { latestRaceStartMs, rateMoment, resultMoment } from './behaviour.mjs';
import { countdownText, nextSession, shortGpName } from './schedule.mjs';

/** Longest panel line (characters). */
export const PANEL_LINE_CHARS = 60;
export const PANEL_MAX_LINES = 3;
/** Longest action label ("Rate Emilia-Romagna GP"). */
export const PANEL_ACTION_LABEL_CHARS = 28;

/** The fixed actions (the rate action is built per race). */
export const PANEL_ACTIONS = Object.freeze({
  ask: Object.freeze({ label: 'Ask F1', target: ASK_PATH }),
  stats: Object.freeze({ label: 'On this day', target: '/stats/on-this-day' }),
  'hot-lap': Object.freeze({ label: 'Hot lap', target: '/games/rwanda' }),
  pets: Object.freeze({ label: 'Pets', target: '/settings/pets' })
});

/** One plain line ≤ `max` characters ("…" when cut). @param {string} text @param {number} [max] */
export function clipText(text, max = PANEL_LINE_CHARS) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * "Max Verstappen won the São Paulo GP" for the feed's latest race, or null
 * (no race, no winner, or a race that has not started at `nowMs`).
 * @param {any} feed @param {number} nowMs
 */
export function winnerLine(feed, nowMs) {
  const race = feed?.latestRace;
  if (!race || typeof race.gp !== 'string') return null;
  const start = latestRaceStartMs(feed);
  if (start !== null && nowMs < start) return null;
  const winner = race.results?.find((r) => r.position === 1);
  if (typeof winner?.name !== 'string' || !winner.name.trim()) return null;
  return `${winner.name.trim()} won the ${shortGpName(race.gp)}`;
}

/**
 * The panel's lines: the session countdown (the hover text), then the
 * favourite driver's result while the race is recent (the result bubble's
 * text), else the latest race winner. Nothing else.
 * @param {{ sessions?: readonly any[], feed?: any, favoriteDriverId?: string|null, nowMs: number }} input
 * @returns {string[]}
 */
export function panelLines({ sessions, feed, favoriteDriverId, nowMs }) {
  const lines = [];
  let countdown;
  try {
    countdown = countdownText(sessions ?? [], nowMs);
  } catch {
    countdown = null;
  }
  if (countdown) lines.push(clipText(countdown));
  const own = favoriteDriverId
    ? resultMoment({ feed, favoriteDriverId, nowMs })
    : null;
  const result = own?.text ?? winnerLine(feed, nowMs);
  if (result) lines.push(clipText(result));
  return lines.slice(0, PANEL_MAX_LINES);
}

/**
 * The quick actions that apply now, in PANEL_ACTION_IDS order: Ask F1, the
 * rate action only inside the rate-nudge window, On this day, Hot lap, Pets.
 * @param {{ feed?: any, nowMs: number, ask?: boolean }} input
 * @returns {{ id: string, label: string, target: string }[]}
 */
export function panelActions({ feed, nowMs, ask = true }) {
  /** @type {{ id: string, label: string, target: string }[]} */
  const actions = [];
  for (const id of PANEL_ACTION_IDS) {
    if (id === 'ask' && !ask) continue;
    if (id === 'rate') {
      const rate = rateMoment({ feed, nowMs });
      if (!rate) continue;
      const race = feed?.sessions?.find(
        (s) => s.kind === 'race' && s.key === rate.key
      );
      const gp = typeof race?.gp === 'string' ? shortGpName(race.gp) : '';
      actions.push({
        id,
        label: clipText(
          gp ? `Rate ${gp}` : 'Rate the race',
          PANEL_ACTION_LABEL_CHARS
        ),
        target: rate.target
      });
      continue;
    }
    const fixed = PANEL_ACTIONS[id];
    if (fixed) actions.push({ id, label: fixed.label, target: fixed.target });
  }
  return actions;
}

/**
 * When the countdown line next changes (it counts whole minutes; a live
 * session's line changes when it ends), or null with no session.
 * @param {{ sessions?: readonly any[], nowMs: number }} input
 */
export function panelChangesAt({ sessions, nowMs }) {
  let session;
  try {
    session = nextSession(sessions ?? [], nowMs);
  } catch {
    return null;
  }
  if (!session) return null;
  const start = Date.parse(session.startsAt);
  if (!Number.isFinite(start)) return null;
  if (start <= nowMs) {
    const end = start + (SESSION_DURATION_MS[session.kind] ?? 0);
    return end > nowMs ? end : null;
  }
  const minutes = Math.ceil((start - nowMs) / 60_000);
  return start - (minutes - 1) * 60_000;
}

/**
 * The whole panel: what the pet window shows plus each action's target.
 * @param {{ sessions?: readonly any[], feed?: any, favoriteDriverId?: string|null, nowMs: number, ask?: boolean }} input
 * @returns {{
 *   lines: string[],
 *   actions: { id: string, label: string }[],
 *   targets: Record<string, string>,
 *   changesAt: number|null
 * }}
 */
export function buildPanel(input) {
  const actions = panelActions(input);
  return {
    lines: panelLines(input),
    actions: actions.map(({ id, label }) => ({ id, label })),
    targets: Object.fromEntries(actions.map(({ id, target }) => [id, target])),
    changesAt: panelChangesAt(input)
  };
}
