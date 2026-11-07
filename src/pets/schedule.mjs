/**
 * Desktop pets — F1 session schedule (docs/DESKTOP_PETS_PLAN.md §4.6, D10–D11).
 *
 * Fetches `${appUrl}/desktop/schedule.json` on start and every 24 h
 * (If-None-Match when the origin sent an ETag, otherwise unchanged content is
 * detected by comparing the JSON), caches it in `userData/schedule.json` and
 * works offline from that cache. The JSON is wall-clock-free; past sessions
 * are filtered here. `calendarPhase` / `sessionBubble` are pure helpers for
 * the behaviour machine; bubble times are relative, so no timezone
 * formatting happens anywhere.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEDULE_PATH,
  SCHEDULE_REFRESH_MS,
  SESSION_DURATION_MS,
  SESSION_KINDS,
  SESSION_LEAD_MS
} from './contract.mjs';

export const SCHEDULE_CACHE_FILE = 'schedule.json';
export const SCHEDULE_TIMEOUT_MS = 10_000;
/** Longest single wait before the calendar is re-planned (plan §4.6). */
export const MAX_PLAN_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const MAX_SESSIONS = 1000;
/** Keep sessions that ended within this window (a live one stays visible). */
const KEEP_PAST_MS = 3 * 60 * 60 * 1000;

export const SESSION_LABELS = Object.freeze({
  qualifying: 'Qualifying',
  'sprint-qualifying': 'Sprint qualifying',
  sprint: 'Sprint',
  race: 'Race'
});

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
/** f1db ids (drivers, Grands Prix) and /rate slugs. */
const ID_RE = /^[a-z0-9-]{1,64}$/;
/** Petdex slug (pet-store.mjs isPetdexSlug). */
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const MAX_RESULTS = 60;
const MAX_DRIVERS = 80;
const MAX_ROUNDS = 40;
const MAX_PET_DRIVERS = 200;
const MAX_NAME_CHARS = 80;

/**
 * @typedef {{ key: string, kind: string, year: number, round: number, gp: string, startsAt: string, rateSlug?: string }} FeedSession
 * @typedef {{ driverId: string, name: string, code: string|null, position: number|null, status: string|null }} RaceResult
 * @typedef {{ key: string, year: number, round: number, gp: string, rateSlug: string|null, grandPrixId: string|null, startsAt: string|null, results: RaceResult[] }} LatestRace
 * @typedef {{
 *   v: 1,
 *   sessions: FeedSession[],
 *   season: number|null,
 *   latestRace: LatestRace|null,
 *   seasonResults: Record<string, (number|null)[]>,
 *   drivers: { id: string, name: string, code: string|null }[],
 *   petDrivers: Record<string, string>
 * }} Feed
 */

const isObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isYear = (v) => Number.isSafeInteger(v) && v >= 1950 && v <= 2200;
const isRound = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99;
const isPosition = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99;
const isIsoUtc = (v) =>
  typeof v === 'string' && ISO_UTC_RE.test(v) && Number.isFinite(Date.parse(v));
const cleanText = (v, max = MAX_NAME_CHARS) =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
const cleanCode = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9]{1,4}$/.test(v) ? v : null;
const cleanStatus = (v) =>
  typeof v === 'string' && /^[A-Za-z][A-Za-z -]{0,39}$/.test(v)
    ? v.trim().toLowerCase()
    : null;

/** @param {unknown} raw @returns {LatestRace|null} */
function parseLatestRace(raw) {
  if (!isObject(raw)) return null;
  const key = cleanText(raw.key, 120);
  const gp = cleanText(raw.gp, 120);
  if (!key || !gp || !isYear(raw.year) || !isRound(raw.round)) return null;
  const results = [];
  const seen = new Set();
  for (const r of Array.isArray(raw.results) ? raw.results : []) {
    if (results.length >= MAX_RESULTS) break;
    if (!isObject(r) || typeof r.driverId !== 'string') continue;
    if (!ID_RE.test(r.driverId) || seen.has(r.driverId)) continue;
    const name = cleanText(r.name);
    if (!name) continue;
    seen.add(r.driverId);
    results.push({
      driverId: r.driverId,
      name,
      code: cleanCode(r.code),
      position: isPosition(r.position) ? r.position : null,
      status: cleanStatus(r.status)
    });
  }
  return {
    key,
    year: raw.year,
    round: raw.round,
    gp,
    rateSlug:
      typeof raw.rateSlug === 'string' && ID_RE.test(raw.rateSlug)
        ? raw.rateSlug
        : null,
    grandPrixId:
      typeof raw.grandPrixId === 'string' && ID_RE.test(raw.grandPrixId)
        ? raw.grandPrixId
        : null,
    startsAt: isIsoUtc(raw.startsAt) ? raw.startsAt : null,
    results
  };
}

/** @param {unknown} raw @returns {Record<string, (number|null)[]>} */
function parseSeasonResults(raw) {
  /** @type {Record<string, (number|null)[]>} */
  const out = {};
  if (!isObject(raw)) return out;
  let count = 0;
  for (const [driverId, rounds] of Object.entries(raw)) {
    if (count >= MAX_DRIVERS) break;
    if (!ID_RE.test(driverId) || !Array.isArray(rounds)) continue;
    if (rounds.length > MAX_ROUNDS) continue;
    out[driverId] = rounds.map((p) => (isPosition(p) ? p : null));
    count += 1;
  }
  return out;
}

/** @param {unknown} raw */
function parseDrivers(raw) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_DRIVERS) break;
    if (!isObject(d) || typeof d.id !== 'string' || !ID_RE.test(d.id)) continue;
    const name = cleanText(d.name);
    if (!name || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ id: d.id, name, code: cleanCode(d.code) });
  }
  return out;
}

/** @param {unknown} raw @returns {Record<string, string>} */
function parsePetDrivers(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isObject(raw)) return out;
  let count = 0;
  for (const [slug, driverId] of Object.entries(raw)) {
    if (count >= MAX_PET_DRIVERS) break;
    if (!SLUG_RE.test(slug) || typeof driverId !== 'string') continue;
    if (!ID_RE.test(driverId)) continue;
    out[slug] = driverId;
    count += 1;
  }
  return out;
}

/**
 * Validate a schedule document. Invalid sessions are dropped one by one;
 * a wrong top-level shape returns null. The round-2 companion fields
 * (`season`, `latestRace`, `seasonResults`, `drivers`, `petDrivers`,
 * `sessions[].rateSlug`) are additive: missing or invalid ones become
 * null / empty and never reject the sessions.
 * @param {unknown} raw
 * @returns {Feed | null}
 */
export function parseSchedule(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.v !== 1 ||
    !Array.isArray(raw.sessions)
  ) {
    return null;
  }
  const sessions = [];
  const keys = new Set();
  for (const s of raw.sessions) {
    if (sessions.length >= MAX_SESSIONS) break;
    if (!s || typeof s !== 'object') continue;
    const { key, kind, year, round, gp, startsAt } = s;
    if (typeof key !== 'string' || !key || key.length > 120 || keys.has(key))
      continue;
    if (!SESSION_KINDS.includes(kind)) continue;
    if (!Number.isSafeInteger(year) || year < 1950 || year > 2200) continue;
    if (!Number.isSafeInteger(round) || round < 1 || round > 99) continue;
    if (typeof gp !== 'string' || !gp.trim() || gp.length > 120) continue;
    if (typeof startsAt !== 'string' || !ISO_UTC_RE.test(startsAt)) continue;
    if (!Number.isFinite(Date.parse(startsAt))) continue;
    keys.add(key);
    /** @type {FeedSession} */
    const session = { key, kind, year, round, gp: gp.trim(), startsAt };
    if (
      kind === 'race' &&
      typeof s.rateSlug === 'string' &&
      ID_RE.test(s.rateSlug)
    ) {
      session.rateSlug = s.rateSlug;
    }
    sessions.push(session);
  }
  sessions.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return {
    v: 1,
    sessions,
    season: isYear(raw.season) ? raw.season : null,
    latestRace: parseLatestRace(raw.latestRace),
    seasonResults: parseSeasonResults(raw.seasonResults),
    drivers: parseDrivers(raw.drivers),
    petDrivers: parsePetDrivers(raw.petDrivers)
  };
}

/**
 * Where the calendar stands at `nowMs`. A live session wins over another
 * session's lead window.
 * @param {readonly { kind: string, startsAt: string }[]} sessions
 * @param {number} nowMs
 * @returns {{ phase: 'lead'|'live'|null, session: object|null, nextBoundaryAt: number|null }}
 */
export function calendarPhase(sessions, nowMs) {
  let live = null;
  let liveStart = -Infinity;
  let lead = null;
  let leadStart = Infinity;
  let nextBoundaryAt = null;
  for (const session of sessions) {
    const start = Date.parse(session.startsAt);
    const duration = SESSION_DURATION_MS[session.kind];
    if (!Number.isFinite(start) || !duration) continue;
    const end = start + duration;
    const leadAt = start - SESSION_LEAD_MS;
    for (const boundary of [leadAt, start, end]) {
      if (
        boundary > nowMs &&
        (nextBoundaryAt === null || boundary < nextBoundaryAt)
      ) {
        nextBoundaryAt = boundary;
      }
    }
    if (start <= nowMs && nowMs < end && start > liveStart) {
      live = session;
      liveStart = start;
    } else if (leadAt <= nowMs && nowMs < start && start < leadStart) {
      lead = session;
      leadStart = start;
    }
  }
  if (live) return { phase: 'live', session: live, nextBoundaryAt };
  if (lead) return { phase: 'lead', session: lead, nextBoundaryAt };
  return { phase: null, session: null, nextBoundaryAt };
}

/**
 * Delay until the calendar needs re-planning: the next boundary, capped at
 * MAX_PLAN_DELAY_MS (and never below 1 s).
 * @param {readonly { kind: string, startsAt: string }[]} sessions
 * @param {number} nowMs
 */
export function nextPlanDelay(sessions, nowMs) {
  const { nextBoundaryAt } = calendarPhase(sessions, nowMs);
  if (nextBoundaryAt === null) return MAX_PLAN_DELAY_MS;
  return Math.max(1000, Math.min(MAX_PLAN_DELAY_MS, nextBoundaryAt - nowMs));
}

/** "Las Vegas Grand Prix" → "Las Vegas GP". @param {string} gp */
export function shortGpName(gp) {
  return gp.replace(/\bGrand Prix\b/g, 'GP').trim();
}

/**
 * Bubble text for a calendar moment.
 * @param {{ kind: string, gp: string, startsAt: string } | null} session
 * @param {'lead'|'live'|null} phase
 * @param {number} nowMs
 * @returns {string|null}
 */
export function sessionBubble(session, phase, nowMs) {
  if (!session || !phase) return null;
  const label = SESSION_LABELS[session.kind];
  if (!label) return null;
  const gp = shortGpName(session.gp);
  if (phase === 'lead') {
    const minutes = Math.max(
      1,
      Math.ceil((Date.parse(session.startsAt) - nowMs) / 60_000)
    );
    return `${label} in ${minutes} min · ${gp}`;
  }
  if (session.kind === 'race') return `Lights out! · ${gp}`;
  return `${label} is live`;
}

/** "2 h 14 min", "45 min", "3 d 4 h" (minutes rounded up). @param {number} ms */
export function formatCountdown(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/**
 * The session the hover countdown talks about: the live one, else the next
 * to start.
 * @param {readonly { kind: string, startsAt: string }[]} sessions
 * @param {number} nowMs
 */
export function nextSession(sessions, nowMs) {
  let best = null;
  let bestStart = Infinity;
  for (const session of sessions) {
    const start = Date.parse(session.startsAt);
    const duration = SESSION_DURATION_MS[session.kind];
    if (!Number.isFinite(start) || !duration) continue;
    if (start <= nowMs && nowMs < start + duration) return session;
    if (start > nowMs && start < bestStart) {
      best = session;
      bestStart = start;
    }
  }
  return best;
}

/**
 * Hover countdown (plan §12 #2): "Qualifying in 2 h 14 min · São Paulo GP",
 * "Race is live · São Paulo GP"; null when nothing is scheduled.
 * @param {readonly { kind: string, gp: string, startsAt: string }[]} sessions
 * @param {number} nowMs
 * @returns {string|null}
 */
export function countdownText(sessions, nowMs) {
  const session = nextSession(sessions, nowMs);
  if (!session) return null;
  const label = SESSION_LABELS[session.kind];
  if (!label) return null;
  const gp = shortGpName(session.gp);
  const start = Date.parse(session.startsAt);
  if (start <= nowMs) return `${label} is live · ${gp}`;
  return `${label} in ${formatCountdown(start - nowMs)} · ${gp}`;
}

/**
 * A feed's sessions that have not ended by `nowMs` (plus a short tail), in
 * start order — what `schedule.sessions()` returns, for any clock (the
 * native timeline compiles on a virtual one).
 * @param {{ sessions: readonly FeedSession[] } | null} feed
 * @param {number} nowMs
 */
export function upcomingSessions(feed, nowMs) {
  if (!feed) return [];
  const cutoff = nowMs - KEEP_PAST_MS;
  return feed.sessions.filter(
    (s) => Date.parse(s.startsAt) + SESSION_DURATION_MS[s.kind] > cutoff
  );
}

/**
 * @param {{
 *   fetch: typeof fetch,
 *   userDataDir: string,
 *   appUrl: string,
 *   now?: () => number,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 *   timeoutMs?: number
 * }} options
 */
export function createSchedule({
  fetch: fetchImpl,
  userDataDir,
  appUrl,
  now = Date.now,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
  timeoutMs = SCHEDULE_TIMEOUT_MS
}) {
  const url = new URL(SCHEDULE_PATH, appUrl).href;
  const cachePath = join(userDataDir, SCHEDULE_CACHE_FILE);
  /** @type {{ etag: string|null, fetchedAt: number, schedule: NonNullable<ReturnType<typeof parseSchedule>> } | null} */
  let cache = null;
  let timer = null;
  let running = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  const listeners = new Set();

  function loadCache() {
    try {
      const file = JSON.parse(readFileSync(cachePath, 'utf8'));
      const schedule = parseSchedule(file?.schedule);
      if (schedule) {
        cache = {
          etag: typeof file.etag === 'string' ? file.etag : null,
          fetchedAt: Number.isFinite(file.fetchedAt) ? file.fetchedAt : 0,
          schedule
        };
      }
    } catch {
      cache = null;
    }
  }

  function saveCache() {
    const tmp = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(cache));
      renameSync(tmp, cachePath);
    } catch {
      rmSync(tmp, { force: true });
    }
  }

  function emit() {
    const list = sessions();
    for (const listener of listeners) {
      try {
        listener(list);
      } catch {
        // A listener error must not stop the schedule.
      }
    }
  }

  async function readCapped(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
    const text = await response.text();
    return text.length > MAX_BYTES ? null : text;
  }

  async function fetchOnce() {
    const controller = new AbortController();
    const abortTimer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (cache?.etag) headers['If-None-Match'] = cache.etag;
      const response = await fetchImpl(url, {
        headers,
        signal: controller.signal
      });
      if (response.status === 304 && cache) {
        cache = { ...cache, fetchedAt: now() };
        saveCache();
        return;
      }
      if (!response.ok) return;
      const text = await readCapped(response);
      if (text === null) return;
      let schedule;
      try {
        schedule = parseSchedule(JSON.parse(text));
      } catch {
        return;
      }
      if (!schedule) return;
      const changed =
        !cache || JSON.stringify(cache.schedule) !== JSON.stringify(schedule);
      cache = {
        etag: response.headers.get('etag'),
        fetchedAt: now(),
        schedule
      };
      saveCache();
      if (changed) emit();
    } catch {
      // Offline or slow: keep the cached schedule.
    } finally {
      clearTimer(abortTimer);
    }
  }

  function refresh() {
    if (!inFlight) {
      inFlight = fetchOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      refresh().finally(scheduleNext);
    }, SCHEDULE_REFRESH_MS);
  }

  /** The whole parsed feed (all sessions, companion fields), or null. */
  function feed() {
    return cache ? cache.schedule : null;
  }

  /** Sessions that have not ended yet (plus a short tail), sorted by start. */
  function sessions() {
    return cache ? upcomingSessions(cache.schedule, now()) : [];
  }

  return {
    /** Load the cache, fetch now, then every 24 h. Resolves after the first fetch. */
    start() {
      if (running) return inFlight ?? Promise.resolve();
      running = true;
      loadCache();
      if (cache) emit();
      const first = refresh();
      scheduleNext();
      return first;
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** Fetch now (e.g. after resume). */
    refresh,
    sessions,
    feed,
    /** Season of `latestRace` (null on an old feed). */
    season: () => feed()?.season ?? null,
    latestRace: () => feed()?.latestRace ?? null,
    seasonResults: () => feed()?.seasonResults ?? {},
    drivers: () => feed()?.drivers ?? [],
    /** Curated Petdex slug → f1db driver id. */
    petDrivers: () => feed()?.petDrivers ?? {},
    /** Race sessions carrying a /rate slug (all of them, past ones too). */
    rateSessions: () =>
      (feed()?.sessions ?? []).filter((s) => s.kind === 'race' && s.rateSlug),
    /** @param {(sessions: object[]) => void} callback */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
