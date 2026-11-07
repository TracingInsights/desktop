import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetsSettings,
  isDriverId,
  readSettingsSync,
  SETTINGS_FILE,
  validatePagePatch
} from './settings.mjs';
import { DEFAULT_SETTINGS } from './contract.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeRaw = (text) => writeFileSync(join(dir, SETTINGS_FILE), text);
const readRaw = () =>
  JSON.parse(readFileSync(join(dir, SETTINGS_FILE), 'utf8'));

describe('readSettingsSync', () => {
  test('missing file → defaults', () => {
    expect(readSettingsSync(dir)).toEqual({
      ...DEFAULT_SETTINGS,
      positions: {}
    });
    expect(readSettingsSync(join(dir, 'nope'))).toEqual({
      ...DEFAULT_SETTINGS,
      positions: {}
    });
  });

  test('corrupt file → defaults, never throws', () => {
    writeRaw('{not json');
    expect(readSettingsSync(dir)).toEqual({
      ...DEFAULT_SETTINGS,
      positions: {}
    });
    writeRaw('[1,2]');
    expect(readSettingsSync(dir).enabled).toBe(false);
    writeRaw('null');
    expect(readSettingsSync(dir).size).toBe('m');
  });

  test('merges valid fields one by one, drops unknown + invalid', () => {
    writeRaw(
      JSON.stringify({
        enabled: true,
        size: 'xl',
        sessionReactions: 'lively',
        activePetId: '../../etc',
        quietUntil: 'tomorrow',
        evil: 1,
        positions: { 1: { x: 10.4, y: 20 }, 2: { x: 'a', y: 1 }, 3: null }
      })
    );
    const s = readSettingsSync(dir);
    expect(s.enabled).toBe(true);
    expect(s.size).toBe('m');
    expect(s.sessionReactions).toBe('lively');
    expect(s.activePetId).toBeNull();
    expect(s.quietUntil).toBeNull();
    expect(s).not.toHaveProperty('evil');
    expect(s.positions).toEqual({ 1: { x: 10, y: 20 } });
  });
});

describe('createPetsSettings', () => {
  test('page update accepts only writable keys with valid values', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    expect(settings.update({ size: 'l', enabled: true }).ok).toBe(true);
    expect(readRaw()).toMatchObject({ size: 'l', enabled: true });
    expect(settings.update({ activePetId: 'petdex:lando' })).toMatchObject({
      ok: false
    });
    expect(settings.update({ quietUntil: null })).toMatchObject({ ok: false });
    expect(settings.update({ size: 'huge' })).toMatchObject({ ok: false });
    expect(settings.update({ enabled: 'yes' })).toMatchObject({ ok: false });
    expect(settings.update(null)).toMatchObject({ ok: false });
    expect(settings.get().size).toBe('l');
  });

  test('trusted update can set any known field', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    expect(
      settings.update({ firstTrayNoticeShown: true }, { trusted: true }).ok
    ).toBe(true);
    expect(settings.update({ nope: 1 }, { trusted: true }).ok).toBe(false);
    expect(settings.get().firstTrayNoticeShown).toBe(true);
  });

  test('setters, onChange, atomic write leaves no temp files', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    const seen = [];
    const off = settings.onChange((s) => seen.push(s));
    expect(settings.setActivePetId('codex:my%20pet').ok).toBe(true);
    expect(settings.setActivePetId('bogus').ok).toBe(false);
    expect(settings.setQuietUntil('2026-11-06T12:00:00.000Z').ok).toBe(true);
    expect(settings.setQuietUntil('soon').ok).toBe(false);
    expect(settings.setPosition(42, { x: 5, y: 6 }).ok).toBe(true);
    expect(settings.setPosition(42, { x: NaN, y: 6 }).ok).toBe(false);
    expect(settings.markTrayNoticeShown().ok).toBe(true);
    off();
    settings.update({ size: 's' });
    expect(seen).toHaveLength(4);
    expect(seen[3]).toMatchObject({
      firstTrayNoticeShown: true,
      positions: { 42: { x: 5, y: 6 } }
    });
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE]);
    expect(readSettingsSync(dir)).toMatchObject({
      activePetId: 'codex:my%20pet',
      quietUntil: '2026-11-06T12:00:00.000Z',
      size: 's'
    });
  });

  test('get returns a copy', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    settings.setPosition('a', { x: 1, y: 1 });
    settings.get().positions.a.x = 99;
    expect(settings.get().positions.a.x).toBe(1);
  });

  test('a failed write keeps the old state and reports an envelope', () => {
    const settings = createPetsSettings({ userDataDir: join(dir, 'file') });
    writeFileSync(join(dir, 'file'), 'x'); // userDataDir is a file → write fails
    const r = settings.update({ size: 's' });
    expect(r.ok).toBe(false);
    expect(settings.get().size).toBe('m');
  });

  test('validatePagePatch', () => {
    expect(validatePagePatch({ scanCodexDir: false })).toEqual({
      ok: true,
      patch: { scanCodexDir: false }
    });
    expect(validatePagePatch({ positions: {} }).ok).toBe(false);
  });
});

describe('notifications setting', () => {
  test('defaults to on; an old file without the field reads as on', () => {
    expect(readSettingsSync(dir).notifications).toBe(true);
    writeRaw(JSON.stringify({ v: 1, enabled: true, closeToTray: true }));
    expect(readSettingsSync(dir).notifications).toBe(true);
  });

  test('a stored false survives; an invalid value falls back to on', () => {
    writeRaw(JSON.stringify({ notifications: false }));
    expect(readSettingsSync(dir).notifications).toBe(false);
    writeRaw(JSON.stringify({ notifications: 'off' }));
    expect(readSettingsSync(dir).notifications).toBe(true);
  });

  test('the page may change it (booleans only)', () => {
    expect(validatePagePatch({ notifications: false })).toEqual({
      ok: true,
      patch: { notifications: false }
    });
    expect(validatePagePatch({ notifications: 0 }).ok).toBe(false);
  });
});

describe('companion settings (round 2)', () => {
  test('defaults include the new fields', () => {
    expect(readSettingsSync(dir)).toMatchObject({
      favoriteDriverId: null,
      followFavorite: true,
      resultReactions: true,
      dailyFact: true,
      rateNudge: true,
      secondPetId: null,
      onboardingShown: false,
      lastResultKey: null,
      lastRateKey: null,
      lastFactDay: null
    });
  });

  test('valid values survive a read; invalid ones fall back field by field', () => {
    writeRaw(
      JSON.stringify({
        favoriteDriverId: 'max-verstappen',
        followFavorite: false,
        resultReactions: false,
        dailyFact: false,
        rateNudge: false,
        secondPetId: 'petdex:lando',
        onboardingShown: true,
        lastResultKey: '2026_19_race_2026-11-01T20:00',
        lastRateKey: '2026_19_race_2026-11-01T20:00',
        lastFactDay: '2026-11-06'
      })
    );
    expect(readSettingsSync(dir)).toMatchObject({
      favoriteDriverId: 'max-verstappen',
      followFavorite: false,
      resultReactions: false,
      dailyFact: false,
      rateNudge: false,
      secondPetId: 'petdex:lando',
      onboardingShown: true,
      lastResultKey: '2026_19_race_2026-11-01T20:00',
      lastRateKey: '2026_19_race_2026-11-01T20:00',
      lastFactDay: '2026-11-06'
    });
    writeRaw(
      JSON.stringify({
        favoriteDriverId: 'Max Verstappen',
        followFavorite: 'yes',
        dailyFact: 1,
        secondPetId: '../x',
        onboardingShown: 'true',
        lastResultKey: 'k'.repeat(121),
        lastRateKey: '',
        lastFactDay: '6 Nov'
      })
    );
    expect(readSettingsSync(dir)).toMatchObject({
      favoriteDriverId: null,
      followFavorite: true,
      dailyFact: true,
      secondPetId: null,
      onboardingShown: false,
      lastResultKey: null,
      lastRateKey: null,
      lastFactDay: null
    });
  });

  test('the page may change the feature toggles only', () => {
    for (const key of [
      'followFavorite',
      'resultReactions',
      'dailyFact',
      'rateNudge'
    ]) {
      expect(validatePagePatch({ [key]: false })).toEqual({
        ok: true,
        patch: { [key]: false }
      });
      expect(validatePagePatch({ [key]: 'no' }).ok).toBe(false);
    }
    for (const patch of [
      { favoriteDriverId: 'max-verstappen' },
      { secondPetId: 'petdex:lando' },
      { onboardingShown: true },
      { lastResultKey: 'x' },
      { lastRateKey: 'x' },
      { lastFactDay: '2026-11-06' }
    ]) {
      expect(validatePagePatch(patch).ok).toBe(false);
    }
  });

  test('internal setters validate, save and survive a restart', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    expect(settings.setFavoriteDriverId('kimi-antonelli').ok).toBe(true);
    expect(settings.setFavoriteDriverId('Kimi').ok).toBe(false);
    expect(settings.setFavoriteDriverId('a'.repeat(65)).ok).toBe(false);
    expect(settings.setSecondPetId('petdex:pia').ok).toBe(true);
    expect(settings.setSecondPetId('pia').ok).toBe(false);
    expect(settings.markOnboardingShown().ok).toBe(true);
    expect(settings.setMarker('lastResultKey', 'race-1').ok).toBe(true);
    expect(settings.setMarker('lastRateKey', 'race-1').ok).toBe(true);
    expect(settings.setMarker('lastFactDay', '2026-11-06').ok).toBe(true);
    expect(settings.setMarker('lastFactDay', 'today').ok).toBe(false);
    expect(settings.setMarker('enabled', true).ok).toBe(false);
    expect(settings.setMarker('activePetId', 'petdex:x').ok).toBe(false);

    const again = createPetsSettings({ userDataDir: dir }).get();
    expect(again).toMatchObject({
      favoriteDriverId: 'kimi-antonelli',
      secondPetId: 'petdex:pia',
      onboardingShown: true,
      lastResultKey: 'race-1',
      lastRateKey: 'race-1',
      lastFactDay: '2026-11-06'
    });
    expect(readRaw().favoriteDriverId).toBe('kimi-antonelli');
    settings.setFavoriteDriverId(null);
    settings.setSecondPetId(null);
    expect(readSettingsSync(dir)).toMatchObject({
      favoriteDriverId: null,
      secondPetId: null
    });
  });

  test('setters notify listeners', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    const seen = [];
    settings.onChange((s) => seen.push(s.favoriteDriverId));
    settings.setFavoriteDriverId('lando-norris');
    expect(seen).toEqual(['lando-norris']);
  });

  test('isDriverId', () => {
    expect(isDriverId('max-verstappen')).toBe(true);
    expect(isDriverId('carlos-sainz-jr')).toBe(true);
    for (const bad of ['', 'Max', 'a b', '../x', 'a'.repeat(65), 7, null]) {
      expect(isDriverId(bad)).toBe(false);
    }
  });
});
