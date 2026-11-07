/**
 * Desktop pets — what the native pet changed while Electron was gone
 * (docs/DESKTOP_PETS_NATIVE_PLAN.md §3 "One writer per file").
 *
 * Electron owns `pets-settings.json`. While it is not running, the native pet
 * writes its own changes — tray / pet-menu choices, the drop point, and the
 * timeline moments it really showed — to `userData/pet-native-state.json`
 * (atomic write, mirrored by packages/ti-pet/src/state.zig):
 *
 *   {
 *     v: 1, updatedAt: ISO,
 *     enabled?: boolean,              // Show / Hide pet
 *     size?: 's'|'m'|'l',
 *     quietUntil?: ISO|null,          // Quiet ▸ (null = Quiet off)
 *     launchAtLogin?: boolean,
 *     position?: { x, y },            // last drop point → positions.last
 *     shownMoments?: { name: 'lastResultKey'|'lastRateKey'|'lastFactDay', value }[]
 *   }
 *
 * On start Electron merges every valid field into its settings (invalid
 * ones are skipped one by one, never the whole file) and deletes the file:
 * from then on Electron is the writer again.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PET_SIZES } from './contract.mjs';
import { NATIVE_STATE_FILE, NATIVE_STATE_VERSION } from './native-protocol.mjs';
import { LAST_POSITION_KEY } from './pet-window.mjs';
import { MARKER_SETTINGS } from './settings.mjs';

const MAX_BYTES = 64 * 1024;
const MAX_MOMENTS = 32;

const isIso = (v) =>
  typeof v === 'string' &&
  v.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(v) &&
  Number.isFinite(Date.parse(v));

/**
 * The settings patch + markers a native-state document asks for (pure).
 * @param {unknown} raw
 * @returns {{ patch: Record<string, unknown>, markers: { name: string, value: string }[], position: { x: number, y: number } | null }}
 */
export function parseNativeState(raw) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  const markers = [];
  let position = null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.v !== NATIVE_STATE_VERSION
  ) {
    return { patch, markers, position };
  }
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
  if (typeof raw.size === 'string' && Object.hasOwn(PET_SIZES, raw.size)) {
    patch.size = raw.size;
  }
  if (raw.quietUntil === null || isIso(raw.quietUntil)) {
    patch.quietUntil = raw.quietUntil;
  }
  if (typeof raw.launchAtLogin === 'boolean') {
    patch.launchAtLogin = raw.launchAtLogin;
  }
  const p = raw.position;
  if (
    p &&
    typeof p === 'object' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.abs(p.x) < 1e6 &&
    Math.abs(p.y) < 1e6
  ) {
    position = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  if (Array.isArray(raw.shownMoments)) {
    for (const moment of raw.shownMoments.slice(-MAX_MOMENTS)) {
      if (
        moment &&
        MARKER_SETTINGS.includes(moment.name) &&
        typeof moment.value === 'string'
      ) {
        markers.push({ name: moment.name, value: moment.value });
      }
    }
  }
  return { patch, markers, position };
}

/**
 * Merge `pet-native-state.json` into the settings and delete it.
 * Never throws; returns what was applied (tests, logs).
 * @param {{
 *   userDataDir: string,
 *   settings: {
 *     get: () => { positions?: Record<string, { x: number, y: number }> },
 *     update: (patch: Record<string, unknown>, options?: { trusted?: boolean }) => { ok: boolean },
 *     setMarker: (name: any, value: string) => { ok: boolean }
 *   },
 *   fs?: { readFileSync: typeof readFileSync, rmSync: typeof rmSync }
 * }} deps
 */
export function mergeNativeState({
  userDataDir,
  settings,
  fs = { readFileSync, rmSync }
}) {
  const path = join(userDataDir, NATIVE_STATE_FILE);
  let raw;
  try {
    const text = fs.readFileSync(path, 'utf8');
    if (text.length > MAX_BYTES) throw new Error('too large');
    raw = JSON.parse(text);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fs.rmSync(path, { force: true });
    }
    return { applied: [], markers: 0 };
  }
  const { patch, markers, position } = parseNativeState(raw);
  const applied = [];
  for (const [key, value] of Object.entries(patch)) {
    // One field at a time: an invalid one never blocks the rest.
    if (settings.update({ [key]: value }, { trusted: true }).ok) {
      applied.push(key);
    }
  }
  if (position) {
    const positions = {
      ...(settings.get().positions ?? {}),
      [LAST_POSITION_KEY]: position
    };
    if (settings.update({ positions }, { trusted: true }).ok) {
      applied.push('position');
    }
  }
  let saved = 0;
  for (const { name, value } of markers) {
    if (settings.setMarker(name, value).ok) saved += 1;
  }
  fs.rmSync(path, { force: true });
  return { applied, markers: saved };
}
