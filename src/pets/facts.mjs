/**
 * Desktop pets — "On this day" fact (docs/DESKTOP_PETS_PLAN.md §12 #3).
 *
 * Fetches the static stats artifact `${appUrl}/stats/data/on-this-day/<mmm-dd>.json`
 * for the user's local day — at most once per day (a failed fetch retries
 * after FACT_RETRY_MS) and only when the controller asks — and caches the
 * bubble text in `userData/pets-fact.json`, so a restart on the same day
 * needs no network. The controller decides when the bubble shows (first
 * idle moment after DAILY_FACT_HOUR, once per local day).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ON_THIS_DAY_PATH } from './contract.mjs';

export const FACT_CACHE_FILE = 'pets-fact.json';
export const FACT_TIMEOUT_MS = 10_000;
/** A failed fetch (offline, 5xx) is retried after this long, same day. */
export const FACT_RETRY_MS = 60 * 60 * 1000;
/** Bubble text cap (headlines are ~30–90 chars). */
export const FACT_TEXT_CHARS = 140;
const MAX_BYTES = 256 * 1024;
const PREFIX = 'On this day · ';
/** The generator's headline for a day with no events (scripts/build-on-this-day.ts). */
const EMPTY_HEADLINE = 'No events on this date in F1 history';

const MONTHS = Object.freeze([
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
]);

const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day "2026-11-06". @param {number} ms */
export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local day as the on-this-day slug "nov-06" (src/lib/stats/utils.ts). @param {number} ms */
export function onThisDaySlug(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]}-${pad2(d.getDate())}`;
}

/** Local hour 0–23. @param {number} ms */
export function localHour(ms) {
  return new Date(ms).getHours();
}

/**
 * The next instant (strictly after `ms`) when the local clock reads
 * `hour`:00 — today's if still ahead, else tomorrow's (DST-safe).
 * @param {number} ms @param {number} hour
 */
export function nextLocalHourAt(ms, hour) {
  const d = new Date(ms);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
  if (today.getTime() > ms) return today.getTime();
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    hour
  ).getTime();
}

function clip(text) {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > FACT_TEXT_CHARS
    ? `${clean.slice(0, FACT_TEXT_CHARS - 1).trimEnd()}…`
    : clean;
}

/**
 * Bubble text from a day artifact: the day's `headline`, else the first
 * race's winner; null on a quiet day.
 * "On this day · 1994: Japan — winner Damon Hill"
 * @param {unknown} day
 * @returns {string|null}
 */
export function factText(day) {
  if (!day || typeof day !== 'object' || Array.isArray(day)) return null;
  const headline = typeof day.headline === 'string' ? clip(day.headline) : '';
  if (headline && headline !== EMPTY_HEADLINE) return clip(PREFIX + headline);
  const race = Array.isArray(day.races) ? day.races[0] : null;
  const year = race?.year;
  const gp = race?.grandPrixName;
  const winner = race?.winner?.name;
  if (
    Number.isSafeInteger(year) &&
    typeof gp === 'string' &&
    gp.trim() &&
    typeof winner === 'string' &&
    winner.trim()
  ) {
    return clip(`${PREFIX}${year}: ${gp.trim()} — winner ${winner.trim()}`);
  }
  return null;
}

/** Page the bubble opens: the day's on-this-day page. @param {string} slug */
export const factPath = (slug) => `/stats/on-this-day/${slug}`;

/**
 * The next `days` local days' facts (today included) for the native pet's
 * timeline (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.2): fetched in parallel,
 * best effort — a failed day is left out (no bubble that day), a quiet day
 * maps to `text: null`.
 * @param {{ fetch: typeof fetch, appUrl: string, nowMs: number, days: number, timeoutMs?: number }} input
 * @returns {Promise<Map<string, { text: string|null, path: string }>>}
 */
export async function fetchFactsAhead({
  fetch: fetchImpl,
  appUrl,
  nowMs,
  days,
  timeoutMs = FACT_TIMEOUT_MS
}) {
  const out = new Map();
  const start = new Date(nowMs);
  const wanted = Array.from({ length: days }, (_, i) =>
    new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i,
      12
    ).getTime()
  );
  await Promise.all(
    wanted.map(async (ms) => {
      const slug = onThisDaySlug(ms);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = new URL(`${ON_THIS_DAY_PATH}${slug}.json`, appUrl).href;
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        if (response.status === 404) {
          out.set(localDayKey(ms), { text: null, path: factPath(slug) });
          return;
        }
        if (!response.ok) return;
        const body = await response.text();
        if (body.length > MAX_BYTES) return;
        out.set(localDayKey(ms), {
          text: factText(JSON.parse(body)),
          path: factPath(slug)
        });
      } catch {
        // Offline / bad JSON: no fact that day.
      } finally {
        clearTimeout(timer);
      }
    })
  );
  return out;
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
export function createFacts({
  fetch: fetchImpl,
  userDataDir,
  appUrl,
  now = Date.now,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
  timeoutMs = FACT_TIMEOUT_MS
}) {
  const cachePath = join(userDataDir, FACT_CACHE_FILE);
  /** @type {{ day: string, slug: string, text: string|null } | null} */
  let cache = null;
  let loaded = false;
  /** @type {{ day: string, at: number } | null} */
  let lastFailure = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  const listeners = new Set();

  function loadCache() {
    loaded = true;
    try {
      const file = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (
        file &&
        typeof file.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(file.day) &&
        typeof file.slug === 'string' &&
        /^[a-z]{3}-\d{2}$/.test(file.slug) &&
        (file.text === null ||
          (typeof file.text === 'string' &&
            file.text.length <= FACT_TEXT_CHARS))
      ) {
        cache = { day: file.day, slug: file.slug, text: file.text };
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
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener error must not break the fetch.
      }
    }
  }

  async function fetchDay(day, slug) {
    const controller = new AbortController();
    const abortTimer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(`${ON_THIS_DAY_PATH}${slug}.json`, appUrl).href;
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (response.status === 404) {
        // No artifact for this day: a quiet day, not an outage.
        cache = { day, slug, text: null };
        saveCache();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        throw new Error('Too large.');
      }
      const body = await response.text();
      if (body.length > MAX_BYTES) throw new Error('Too large.');
      cache = { day, slug, text: factText(JSON.parse(body)) };
      saveCache();
      lastFailure = null;
      emit();
    } catch {
      lastFailure = { day, at: now() };
    } finally {
      clearTimer(abortTimer);
    }
  }

  return {
    /**
     * Today's fact `{ day, slug, text, path }` once fetched (text null = a
     * quiet day), else null — and, when today's artifact has not been
     * fetched yet, starts that fetch (listeners fire when it lands).
     * @param {number} [nowMs]
     */
    today(nowMs = now()) {
      if (!loaded) loadCache();
      const day = localDayKey(nowMs);
      if (cache?.day === day) {
        return { ...cache, path: factPath(cache.slug) };
      }
      const retryBlocked =
        lastFailure?.day === day && nowMs - lastFailure.at < FACT_RETRY_MS;
      if (!inFlight && !retryBlocked) {
        inFlight = fetchDay(day, onThisDaySlug(nowMs)).finally(() => {
          inFlight = null;
        });
      }
      return null;
    },
    /** Resolves when the current fetch (if any) settles — tests, shutdown. */
    settled: () => inFlight ?? Promise.resolve(),
    /** @param {() => void} callback */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
