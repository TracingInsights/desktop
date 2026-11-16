/**
 * Desktop pets — race-weekend greetings (round 3, feature 4c).
 *
 * Pure helpers for the once-only `greeting` moment: at most once per local
 * day part — morning 06:00–11:59 and evening 17:00–22:59 — when a session
 * from the cached schedule starts within GREETING_WINDOW_MS:
 *
 *   "Race day! Lights out at 15:00 · São Paulo GP"   (race later today)
 *   "Qualifying today at 19:00 · Las Vegas GP"       (another session today)
 *   "Tomorrow: Race at 14:00 · Abu Dhabi GP"          (evening part only)
 *
 * Nothing while a session is live (the calendar bubble speaks then). Times
 * are local, in the runtime's default locale and time zone (12 h / 24 h as
 * that locale writes them); tests inject `locale` / `timeZone`. The
 * controller decides when the moment starts (first idle moment, never while
 * quiet) and saves the `lastGreetingKey` marker "<local date>:<day part>".
 */
import { SESSION_DURATION_MS } from './contract.mjs';
import { CALENDAR_TARGET } from './behaviour.mjs';
import { SESSION_LABELS, shortGpName } from './schedule.mjs';

/** A greeting needs a session starting within this window. */
export const GREETING_WINDOW_MS = 36 * 60 * 60 * 1000;
/** Bubble text cap. */
export const GREETING_TEXT_CHARS = 80;
/** Local day parts a greeting may show in: [fromHour, toHour). */
export const DAY_PARTS = Object.freeze([
  Object.freeze({ id: 'morning', fromHour: 6, toHour: 12 }),
  Object.freeze({ id: 'evening', fromHour: 17, toHour: 23 })
]);

/**
 * @typedef {{ locale?: string, timeZone?: string }} GreetingFormat
 *   Both optional: undefined = the runtime's default (the system's).
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number }} LocalParts
 */

/** Intl formatters are slow to build; keep one per locale / time zone. */
const formatters = new Map();
/** @param {string} key @param {() => Intl.DateTimeFormat} make */
function cached(key, make) {
  let f = formatters.get(key);
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

/** @param {string|undefined} timeZone */
const partsFormatter = (timeZone) =>
  cached(
    `parts|${timeZone ?? ''}`,
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
  );

/**
 * Wall-clock fields of `ms` in `timeZone` (default: the system's).
 * @param {number} ms @param {string} [timeZone] @returns {LocalParts}
 */
export function localParts(ms, timeZone) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const part of partsFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24,
    minute: out.minute
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-11-08" for a (possibly overflowing) calendar date. */
function dateKey(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Local calendar day of `ms`, "2026-11-08". @param {number} ms @param {string} [timeZone] */
export function localDateKey(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return dateKey(p.year, p.month, p.day);
}

/**
 * The day part `ms` falls in, or null between them.
 * @param {number} ms @param {string} [timeZone]
 * @returns {'morning'|'evening'|null}
 */
export function dayPartAt(ms, timeZone) {
  const { hour } = localParts(ms, timeZone);
  const part = DAY_PARTS.find((p) => hour >= p.fromHour && hour < p.toHour);
  return part ? /** @type {'morning'|'evening'} */ (part.id) : null;
}

/**
 * The once-per-day-part marker for `ms` ("2026-11-08:morning"), or null
 * outside the day parts.
 * @param {number} ms @param {string} [timeZone]
 */
export function greetingKey(ms, timeZone) {
  const part = dayPartAt(ms, timeZone);
  return part ? `${localDateKey(ms, timeZone)}:${part}` : null;
}

/**
 * The instant the local clock in `timeZone` reads year-month-day hour:00
 * (two offset probes cover a DST change between the guess and the answer).
 */
function zonedWallClockMs(year, month, day, hour, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const offsetAt = (ms) => {
    const p = localParts(ms, timeZone);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return wall - Math.floor(ms / 60_000) * 60_000;
  };
  const first = guess - offsetAt(guess);
  const offset = offsetAt(first);
  return guess - offset;
}

/**
 * The next day-part start (local 06:00 or 17:00) strictly after `ms`, so
 * the controller can wake for it.
 * @param {number} ms @param {string} [timeZone]
 */
export function nextDayPartStartAt(ms, timeZone) {
  const p = localParts(ms, timeZone);
  for (let days = 0; days <= 2; days += 1) {
    for (const part of DAY_PARTS) {
      const at = zonedWallClockMs(
        p.year,
        p.month,
        p.day + days,
        part.fromHour,
        timeZone
      );
      if (at > ms) return at;
    }
  }
  return ms + 24 * 60 * 60 * 1000;
}

/**
 * When the controller should next look for a greeting: the first day-part
 * start from which the next session to start is within GREETING_WINDOW_MS
 * (no wake-ups between race weekends); null when no session is ahead.
 * @param {{ sessions: readonly { startsAt: string }[], nowMs: number, timeZone?: string }} input
 */
export function nextGreetingCheckAt({ sessions, nowMs, timeZone }) {
  let first = Infinity;
  for (const session of sessions ?? []) {
    const start = Date.parse(session.startsAt);
    if (Number.isFinite(start) && start > nowMs && start < first) first = start;
  }
  if (!Number.isFinite(first)) return null;
  return nextDayPartStartAt(
    Math.max(nowMs, first - GREETING_WINDOW_MS - 1),
    timeZone
  );
}

/**
 * "15:00" / "3:00 PM": the locale's own clock (12 h or 24 h); 24-hour
 * locales get a two-digit hour ("09:00").
 * @param {number} ms @param {GreetingFormat} [format]
 */
export function formatLocalTime(ms, { locale, timeZone } = {}) {
  const numeric = cached(`time|${locale ?? ''}|${timeZone ?? ''}`, () => {
    const base = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit'
    });
    const cycle = base.resolvedOptions().hourCycle;
    return cycle === 'h23' || cycle === 'h24'
      ? new Intl.DateTimeFormat(locale, {
          timeZone,
          hour: '2-digit',
          minute: '2-digit'
        })
      : base;
  });
  return numeric.format(ms);
}

/** One plain line ≤ GREETING_TEXT_CHARS. @param {string} text */
function clip(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > GREETING_TEXT_CHARS
    ? `${clean.slice(0, GREETING_TEXT_CHARS - 1).trimEnd()}…`
    : clean;
}

/** The race among `sessions` if any, else the first (they are in start order). */
const headline = (sessions) =>
  sessions.find((s) => s.kind === 'race') ?? sessions[0];

/**
 * The greeting for `nowMs`, or null: outside the day parts, while a session
 * is live, with no session in the next GREETING_WINDOW_MS, or when nothing
 * fits the day part (a session tomorrow is only mentioned in the evening).
 * `key` is the day-part marker.
 * @param {{ sessions: readonly { kind: string, gp: string, startsAt: string }[], nowMs: number } & GreetingFormat} input
 * @returns {{ kind: 'greeting', key: string, text: string, target: string, state: null, once: false } | null}
 */
export function greetingMoment({ sessions, nowMs, locale, timeZone }) {
  const part = dayPartAt(nowMs, timeZone);
  if (!part) return null;
  /** @type {{ kind: string, gp: string, startsAt: string, start: number }[]} */
  const ahead = [];
  for (const session of sessions ?? []) {
    const start = Date.parse(session.startsAt);
    const duration = SESSION_DURATION_MS[session.kind];
    if (!Number.isFinite(start) || !duration || !SESSION_LABELS[session.kind])
      continue;
    if (start <= nowMs && nowMs < start + duration) return null;
    if (start > nowMs && start <= nowMs + GREETING_WINDOW_MS) {
      ahead.push({ ...session, start });
    }
  }
  if (ahead.length === 0) return null;
  ahead.sort((a, b) => a.start - b.start);

  const local = localParts(nowMs, timeZone);
  const today = dateKey(local.year, local.month, local.day);
  const tomorrow = dateKey(local.year, local.month, local.day + 1);
  const on = (key) =>
    ahead.filter((s) => localDateKey(s.start, timeZone) === key);
  const time = (s) => formatLocalTime(s.start, { locale, timeZone });
  const gp = (s) => shortGpName(s.gp);

  let text = null;
  const todays = on(today);
  if (todays.length > 0) {
    const s = headline(todays);
    text =
      s.kind === 'race'
        ? `Race day! Lights out at ${time(s)} · ${gp(s)}`
        : `${SESSION_LABELS[s.kind]} today at ${time(s)} · ${gp(s)}`;
  } else if (part === 'evening') {
    const tomorrows = on(tomorrow);
    if (tomorrows.length > 0) {
      const s = headline(tomorrows);
      text = `Tomorrow: ${SESSION_LABELS[s.kind]} at ${time(s)} · ${gp(s)}`;
    }
  }
  if (!text) return null;
  return {
    kind: 'greeting',
    key: `${today}:${part}`,
    text: clip(text),
    target: CALENDAR_TARGET,
    state: null,
    once: false
  };
}
