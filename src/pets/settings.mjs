/**
 * Desktop pets — settings (docs/DESKTOP_PETS_PLAN.md §4.1).
 *
 * `userData/pets-settings.json` is the source of truth. Reads never throw:
 * a missing, corrupt or partly invalid file falls back to DEFAULT_SETTINGS
 * field by field. Writes are atomic (tmp file + rename).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  PAGE_WRITABLE_SETTINGS,
  PET_SIZES,
  SESSION_REACTIONS
} from './contract.mjs';

export const SETTINGS_FILE = 'pets-settings.json';

const PET_ID_RE = /^(petdex|codex|import):[A-Za-z0-9._%-]{1,200}$/;
/** f1db driver id ("max-verstappen"). */
const DRIVER_ID_RE = /^[a-z0-9-]{1,64}$/;
/** Local calendar day "2026-11-06" (daily-fact marker). */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POSITIONS = 32;
const MAX_MARKER_CHARS = 120;

const isBool = (v) => typeof v === 'boolean';
/** Once-only marker: a feed key (race / session) or null. */
const isMarker = (v) =>
  v === null ||
  (typeof v === 'string' && v.length > 0 && v.length <= MAX_MARKER_CHARS);

/** Per-field validators: value → valid? */
const FIELD_VALIDATORS = {
  enabled: isBool,
  activePetId: (v) => v === null || (typeof v === 'string' && isPetId(v)),
  size: (v) => typeof v === 'string' && Object.hasOwn(PET_SIZES, v),
  chatReactions: isBool,
  sessionReactions: (v) => SESSION_REACTIONS.includes(v),
  quietUntil: (v) => v === null || isIsoTimestamp(v),
  closeToTray: isBool,
  launchAtLogin: isBool,
  scanCodexDir: isBool,
  firstTrayNoticeShown: isBool,
  notifications: isBool,
  favoriteDriverId: (v) => v === null || isDriverId(v),
  followFavorite: isBool,
  resultReactions: isBool,
  dailyFact: isBool,
  rateNudge: isBool,
  secondPetId: (v) => v === null || isPetId(v),
  onboardingShown: isBool,
  lastResultKey: isMarker,
  lastRateKey: isMarker,
  lastFactDay: (v) => v === null || (typeof v === 'string' && DAY_RE.test(v))
};

/** Internal once-only markers: main-process writes only, never shown to the page. */
export const MARKER_SETTINGS = Object.freeze([
  'lastResultKey',
  'lastRateKey',
  'lastFactDay'
]);

/** @param {unknown} id f1db driver id */
export function isDriverId(id) {
  return typeof id === 'string' && DRIVER_ID_RE.test(id);
}

/** @param {unknown} id */
export function isPetId(id) {
  return typeof id === 'string' && PET_ID_RE.test(id);
}

function isIsoTimestamp(v) {
  return (
    typeof v === 'string' &&
    v.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(v) &&
    Number.isFinite(Date.parse(v))
  );
}

function isPosition(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Math.abs(v.x) < 1e6 &&
    Math.abs(v.y) < 1e6
  );
}

function normalisePositions(raw) {
  /** @type {Record<string, { x: number, y: number }>} */
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_POSITIONS) break;
    if (key.length > 64 || !isPosition(value)) continue;
    out[key] = { x: Math.round(value.x), y: Math.round(value.y) };
  }
  return out;
}

/**
 * Merge a parsed file over the defaults, keeping only valid known fields.
 * @param {unknown} raw
 */
export function normaliseSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, positions: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return settings;
  }
  for (const [key, valid] of Object.entries(FIELD_VALIDATORS)) {
    if (Object.hasOwn(raw, key) && valid(raw[key])) settings[key] = raw[key];
  }
  settings.positions = normalisePositions(raw.positions);
  return settings;
}

/**
 * Read the settings synchronously (before `app.whenReady()`). Never throws.
 * @param {string} userDataDir
 */
export function readSettingsSync(userDataDir) {
  try {
    const text = readFileSync(join(userDataDir, SETTINGS_FILE), 'utf8');
    return normaliseSettings(JSON.parse(text));
  } catch {
    return normaliseSettings(null);
  }
}

/**
 * Validate a page patch: only PAGE_WRITABLE_SETTINGS keys with valid values.
 * @param {unknown} patch
 * @returns {{ ok: true, patch: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validatePagePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Settings patch must be an object.' };
  }
  /** @type {Record<string, unknown>} */
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PAGE_WRITABLE_SETTINGS.includes(key)) {
      return { ok: false, error: `Setting "${key}" cannot be changed here.` };
    }
    if (!FIELD_VALIDATORS[key](value)) {
      return { ok: false, error: `Invalid value for "${key}".` };
    }
    clean[key] = value;
  }
  return { ok: true, patch: clean };
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * @param {{ userDataDir: string }} options
 */
export function createPetsSettings({ userDataDir }) {
  const path = join(userDataDir, SETTINGS_FILE);
  let current = readSettingsSync(userDataDir);
  /** @type {Set<(settings: typeof current) => void>} */
  const listeners = new Set();

  const snapshot = () => ({
    ...current,
    positions: Object.fromEntries(
      Object.entries(current.positions).map(([k, v]) => [k, { ...v }])
    )
  });

  function commit(next) {
    const normalised = normaliseSettings(next);
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    writeAtomic(path, `${JSON.stringify(normalised, null, 2)}\n`);
    current = normalised;
    const view = snapshot();
    for (const listener of listeners) {
      try {
        listener(view);
      } catch {
        // A failing listener must not break the write path.
      }
    }
    return view;
  }

  function guarded(fn) {
    try {
      return { ok: true, settings: fn() };
    } catch (error) {
      return {
        ok: false,
        error: `Could not save pet settings: ${error?.message ?? error}`
      };
    }
  }

  return {
    get: snapshot,
    /**
     * @param {Record<string, unknown>} patch
     * @param {{ trusted?: boolean }} [options] trusted = main-process caller
     *   (tray, lifecycle) — any known field; otherwise page rules apply.
     */
    update(patch, { trusted = false } = {}) {
      if (trusted) {
        if (patch === null || typeof patch !== 'object') {
          return { ok: false, error: 'Settings patch must be an object.' };
        }
        for (const [key, value] of Object.entries(patch)) {
          const valid =
            key === 'positions'
              ? value !== null && typeof value === 'object'
              : FIELD_VALIDATORS[key]?.(value);
          if (!valid) {
            return { ok: false, error: `Invalid value for "${key}".` };
          }
        }
        return guarded(() => commit({ ...current, ...patch }));
      }
      const checked = validatePagePatch(patch);
      if (!checked.ok) return checked;
      return guarded(() => commit({ ...current, ...checked.patch }));
    },
    /** @param {string|number} displayId @param {{ x: number, y: number }} point */
    setPosition(displayId, point) {
      const key = String(displayId);
      if (key.length > 64 || !isPosition(point)) {
        return { ok: false, error: 'Invalid pet position.' };
      }
      const positions = { ...current.positions, [key]: point };
      // Keep the newest entries when the cap is hit.
      const keys = Object.keys(positions);
      while (keys.length > MAX_POSITIONS) delete positions[keys.shift()];
      return guarded(() => commit({ ...current, positions }));
    },
    /** @param {string|null} iso */
    setQuietUntil(iso) {
      if (!FIELD_VALIDATORS.quietUntil(iso)) {
        return { ok: false, error: 'Invalid quiet time.' };
      }
      return guarded(() => commit({ ...current, quietUntil: iso }));
    },
    /** @param {string|null} id */
    setActivePetId(id) {
      if (!FIELD_VALIDATORS.activePetId(id)) {
        return { ok: false, error: 'Invalid pet id.' };
      }
      return guarded(() => commit({ ...current, activePetId: id }));
    },
    markTrayNoticeShown() {
      return guarded(() => commit({ ...current, firstTrayNoticeShown: true }));
    },
    /** @param {string|null} driverId f1db id (the page's favourite driver) */
    setFavoriteDriverId(driverId) {
      if (!FIELD_VALIDATORS.favoriteDriverId(driverId)) {
        return { ok: false, error: 'Invalid driver.' };
      }
      return guarded(() => commit({ ...current, favoriteDriverId: driverId }));
    },
    /** @param {string|null} id the duo's second pet */
    setSecondPetId(id) {
      if (!FIELD_VALIDATORS.secondPetId(id)) {
        return { ok: false, error: 'Invalid pet id.' };
      }
      return guarded(() => commit({ ...current, secondPetId: id }));
    },
    markOnboardingShown() {
      return guarded(() => commit({ ...current, onboardingShown: true }));
    },
    /**
     * Record a once-only moment (result reaction / rate nudge / daily fact)
     * so it never shows again, across restarts too.
     * @param {'lastResultKey'|'lastRateKey'|'lastFactDay'} name
     * @param {string} value
     */
    setMarker(name, value) {
      if (!MARKER_SETTINGS.includes(name) || !FIELD_VALIDATORS[name](value)) {
        return { ok: false, error: 'Invalid marker.' };
      }
      return guarded(() => commit({ ...current, [name]: value }));
    },
    /** @param {(settings: ReturnType<typeof snapshot>) => void} callback */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
