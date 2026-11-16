/**
 * The hand-off timeline (timeline.mjs runs the real controller on a virtual
 * clock) with a Petdex v2 pet: the look-around one-shots appear only in the
 * first 30 min after the hand-off (no input reaches the virtual controller),
 * so a week stays a handful of entries — ti-pet refuses a timeline over 1 MiB.
 */
import { describe, test, expect } from 'bun:test';
import { compileTimeline, TIMELINE_HORIZON_MS } from './timeline.mjs';
import { NATIVE_CAPS } from './native-protocol.mjs';

/** A round-3 native pet (ti-pet 0.2.0); ti-pet-v0.1.1 lists only the first four. */
const V1_CAPS = ['duo', 'bubble', 'menu', 'timeline'];
const ALL_CAPS = [...V1_CAPS, ...Object.values(NATIVE_CAPS)];

const NOW = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;

const SETTINGS = Object.freeze({
  v: 1,
  enabled: true,
  activePetId: 'petdex-cli:boba',
  secondPetId: null,
  size: 'm',
  chatReactions: true,
  sessionReactions: 'calm',
  quietUntil: null,
  favoriteDriverId: null,
  resultReactions: true,
  rateNudge: true,
  dailyFact: true,
  lastResultKey: null,
  lastRateKey: null,
  lastFactDay: null,
  positions: {}
});

const resolvePath = (url) =>
  url.startsWith('pet-asset://')
    ? `/ud/pet-sprites/${decodeURIComponent(url.split('/')[3])}.webp`
    : null;

/** @param {number} rows @param {readonly string[]} [caps] */
function compile(rows, caps = ALL_CAPS) {
  return compileTimeline({
    settings: { ...SETTINGS },
    store: { get: () => ({ atlas: { rows, scale: 1 } }) },
    feed: null,
    resolvePath,
    nowMs: NOW,
    caps
  });
}

const looks = (timeline) =>
  timeline.entries.filter((e) => e.visible && e.state.startsWith('look-'));

describe('compileTimeline with a v2 (11-row) pet', () => {
  test('seven looks in the first 30 min, rows 9 / 10, then none all week', () => {
    const timeline = compile(11);
    expect(timeline.pets.first).toMatchObject({ rows: 11 });
    expect(
      looks(timeline).map((e) => ({
        min: (Date.parse(e.at) - NOW) / MIN,
        state: e.state,
        row: e.row,
        frames: e.frames,
        durationMs: e.durationMs,
        once: e.once
      }))
    ).toEqual(
      [4, 8, 12, 16, 20, 24, 28].map((min, i) => ({
        min,
        state: i % 2 === 0 ? 'look-a' : 'look-b',
        row: i % 2 === 0 ? 9 : 10,
        frames: 8,
        durationMs: 1120,
        once: true
      }))
    );
    // Each look is followed by the ambient pose again 1120 ms later.
    for (const look of looks(timeline)) {
      const next = timeline.entries[timeline.entries.indexOf(look) + 1];
      expect(Date.parse(next.at) - Date.parse(look.at)).toBe(1120);
      expect(['idle', 'waiting']).toContain(next.state);
    }
    expect(Date.parse(timeline.until) - NOW).toBe(TIMELINE_HORIZON_MS);
  });

  test('a v1 pet gets exactly the entries it got before; v2 adds two per look', () => {
    const v1 = compile(9);
    const v2 = compile(11);
    expect(looks(v1)).toEqual([]);
    expect(v1.entries.every((e) => !e.visible || e.row < 9)).toBe(true);
    expect(v2.entries.length).toBe(v1.entries.length + 2 * 7);
    expect(Buffer.byteLength(JSON.stringify(v2))).toBeLessThan(64 * 1024);
  });

  test('a pet without the v2-rows cap (ti-pet-v0.1.1) gets each look as idle', () => {
    for (const caps of [
      V1_CAPS,
      null,
      ALL_CAPS.filter((c) => c !== 'v2-rows')
    ]) {
      const old = compile(11, caps);
      expect(looks(old)).toEqual([]);
      const capable = compile(11);
      // Same instants, the look entries now idle (row 0, 6 frames).
      expect(old.entries.map((e) => e.at)).toEqual(
        capable.entries.map((e) => e.at)
      );
      for (const look of looks(capable)) {
        const same = old.entries[capable.entries.indexOf(look)];
        expect(same).toMatchObject({
          state: 'idle',
          row: 0,
          frames: 6,
          durationMs: 1100,
          once: false,
          playKey: 'idle'
        });
      }
    }
  });
});
