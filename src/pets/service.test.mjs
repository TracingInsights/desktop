import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPetsService,
  pageSettings,
  SIGNALS_PER_SECOND
} from './service.mjs';
import { DEFAULT_SETTINGS } from './contract.mjs';
import { createPetsSettings } from './settings.mjs';

const lando = {
  id: 'petdex:lando',
  source: 'petdex',
  displayName: 'Lando',
  description: null,
  creator: 'someone',
  slug: 'lando',
  pageUrl: 'https://petdex.dev/pets/lando',
  thumb: '',
  removable: true
};

function setup({ settingsOverrides = {}, applyLaunchAtLogin } = {}) {
  let current = {
    ...DEFAULT_SETTINGS,
    positions: { 1: { x: 1, y: 2 } },
    ...settingsOverrides
  };
  const log = [];
  let clock = 0;
  const timers = [];
  const settings = {
    get: () => ({ ...current }),
    update(patch, { trusted = false } = {}) {
      log.push(['update', patch, trusted]);
      if (!trusted && Object.keys(patch).some((k) => k === 'activePetId')) {
        return { ok: false, error: 'nope' };
      }
      current = { ...current, ...patch };
      return { ok: true, settings: current };
    },
    setActivePetId(id) {
      current = { ...current, activePetId: id };
      return { ok: true };
    }
  };
  const service = createPetsService({
    settings,
    store: {
      list: () => [lando],
      get: (id) =>
        id === 'petdex:lando'
          ? { imagePath: '/x.webp', atlas: { scale: 1 } }
          : null,
      getListed: (id) => (id === 'petdex:lando' ? lando : null),
      remove: (id) =>
        id === 'petdex:lando'
          ? { ok: true }
          : { ok: false, error: 'Unknown pet.' }
    },
    petdex: {
      search: async (i) => ({ ok: true, pets: [], nextCursor: null, i }),
      shelf: async () => ({ ok: true, pets: [] }),
      install: async (slug) =>
        slug === 'lando' ? { ok: true, pet: lando } : { ok: false, error: 'x' }
    },
    importer: { importPet: async () => ({ ok: true, pet: null }) },
    controller: {
      quiet: (kind) =>
        kind === 'session' ? { ok: false, error: 'No session' } : { ok: true },
      signal: (s) => {
        log.push(['signal', s]);
        return { ok: true };
      },
      assetsChanged: () => log.push(['assetsChanged'])
    },
    thumbs: {
      thumbFor: async (record) => (record ? 'data:image/png;base64,QQ==' : '')
    },
    support: () => ({
      supported: true,
      unsupportedReason: null,
      needsRestartForPets: false
    }),
    platform: 'linux',
    applyLaunchAtLogin: applyLaunchAtLogin ?? ((on) => log.push(['login', on])),
    restartApp: () => log.push(['restart']),
    petsChanged: () => log.push(['changed']),
    now: () => clock,
    setTimeout: (fn, ms) => timers.push({ fn, at: clock + ms })
  });
  return {
    service,
    log,
    current: () => current,
    tick(ms) {
      clock += ms;
      for (const t of timers.splice(0)) if (t.at <= clock) t.fn();
    }
  };
}

describe('pets service', () => {
  test('pageSettings hides positions, the tray notice flag and the once-only markers', () => {
    const view = pageSettings({
      ...DEFAULT_SETTINGS,
      positions: { a: 1 },
      lastResultKey: 'k',
      lastRateKey: 'k',
      lastFactDay: '2026-11-06'
    });
    expect(view).not.toHaveProperty('positions');
    expect(view).not.toHaveProperty('firstTrayNoticeShown');
    expect(view).not.toHaveProperty('lastResultKey');
    expect(Object.keys(view).sort()).toEqual(
      [
        'v',
        'enabled',
        'activePetId',
        'size',
        'chatReactions',
        'sessionReactions',
        'quietUntil',
        'closeToTray',
        'launchAtLogin',
        'scanCodexDir',
        'notifications',
        'favoriteDriverId',
        'followFavorite',
        'resultReactions',
        'dailyFact',
        'rateNudge',
        'secondPetId',
        'onboardingShown'
      ].sort()
    );
  });

  test('status carries support, platform and the active pet with a thumb', async () => {
    const { service } = setup({
      settingsOverrides: { activePetId: 'petdex:lando' }
    });
    const result = await service.status();
    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({
      supported: true,
      unsupportedReason: null,
      platform: 'linux',
      needsRestartForPets: false,
      activePet: { id: 'petdex:lando', thumb: 'data:image/png;base64,QQ==' }
    });
  });

  test('list fills empty (WebP) thumbs', async () => {
    const { service } = setup();
    expect((await service.list()).pets[0].thumb).toBe(
      'data:image/png;base64,QQ=='
    );
  });

  test('setActive enables pets; unknown ids are refused; null hides', async () => {
    const { service, current } = setup();
    expect((await service.setActive('petdex:nope')).ok).toBe(false);
    const on = await service.setActive('petdex:lando');
    expect(on.ok).toBe(true);
    expect(current()).toMatchObject({
      activePetId: 'petdex:lando',
      enabled: true
    });
    await service.setActive(null);
    expect(current().activePetId).toBeNull();
  });

  test('install and remove notify the page and reload the sprite', async () => {
    const { service, log, current } = setup({
      settingsOverrides: { activePetId: 'petdex:lando' }
    });
    expect((await service.install('lando')).ok).toBe(true);
    expect(log).toContainEqual(['assetsChanged']);
    expect(log).toContainEqual(['changed']);
    expect(service.remove('petdex:lando')).toEqual({ ok: true });
    expect(current().activePetId).toBeNull();
    expect((await service.install('gone')).ok).toBe(false);
  });

  test('a cancelled import passes through untouched', async () => {
    const { service, log } = setup();
    expect(await service.importPet()).toEqual({ ok: true, pet: null });
    expect(log).toEqual([]);
  });

  test('updateSettings applies launch at login and reverts on failure', async () => {
    const { service, log } = setup();
    expect((await service.updateSettings({ launchAtLogin: true })).ok).toBe(
      true
    );
    expect(log).toContainEqual(['login', true]);
    const failing = setup({
      applyLaunchAtLogin: () => {
        throw new Error('denied');
      }
    });
    expect(
      (await failing.service.updateSettings({ launchAtLogin: true })).ok
    ).toBe(false);
    expect(failing.current().launchAtLogin).toBe(false);
  });

  test('quiet returns the controller error or the new status', async () => {
    const { service } = setup();
    expect((await service.quiet('session')).ok).toBe(false);
    expect((await service.quiet('1h')).status).toBeDefined();
  });

  test(`signals: ≤ ${SIGNALS_PER_SECOND}/s, the latest extra one applied after`, () => {
    const { service, log, tick } = setup();
    for (const s of [
      'planning',
      'streaming',
      'streaming',
      'streaming',
      'streaming',
      'done'
    ]) {
      service.signal(s);
    }
    expect(log.filter(([k]) => k === 'signal').length).toBe(SIGNALS_PER_SECOND);
    tick(1000);
    expect(log.filter(([k]) => k === 'signal').at(-1)).toEqual([
      'signal',
      'done'
    ]);
  });
});

// --- Round 2: favourite, duo, celebrate, onboarding, ask ---

describe('companion methods (round 2)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-service-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const listed = (id) => ({ ...lando, id, slug: id.slice(7) });

  function companion({
    initial = {},
    installed = ['petdex:lando'],
    petDrivers = { lando: 'lando-norris', 'max-4': 'max-verstappen' },
    install,
    openAsk,
    celebrate
  } = {}) {
    const settings = createPetsSettings({ userDataDir: dir });
    if (Object.keys(initial).length > 0) {
      const r = settings.update(initial, { trusted: true });
      if (!r.ok) throw new Error(r.error);
    }
    const have = new Set(installed);
    const log = [];
    const deps = {
      settings,
      store: {
        list: () => [...have].map(listed),
        get: (id) => (have.has(id) ? { atlas: { rows: 9, scale: 1 } } : null),
        getListed: (id) => (have.has(id) ? listed(id) : null),
        remove: (id) => {
          if (!have.delete(id)) return { ok: false, error: 'Unknown pet.' };
          return { ok: true };
        }
      },
      petdex: {
        install:
          install ??
          (async (slug) => {
            log.push(['install', slug]);
            have.add(`petdex:${slug}`);
            return { ok: true, pet: listed(`petdex:${slug}`) };
          })
      },
      importer: {},
      controller: {
        quiet: () => ({ ok: true }),
        signal: () => ({ ok: true }),
        celebrate:
          celebrate ??
          ((kind, text) => {
            log.push(['celebrate', kind, text]);
            return { ok: true, shown: true };
          }),
        assetsChanged: () => log.push(['assetsChanged'])
      },
      thumbs: { thumbFor: async () => '' },
      support: () => ({
        supported: true,
        unsupportedReason: null,
        needsRestartForPets: false
      }),
      platform: 'linux',
      applyLaunchAtLogin: () => {},
      restartApp: () => {},
      petsChanged: () => log.push(['changed']),
      getPetDrivers: () => petDrivers
    };
    if (openAsk) deps.openAsk = openAsk;
    return { service: createPetsService(deps), settings, log, have };
  }

  describe('setFavorite', () => {
    test('installs and shows the driver pet; the first pet turns pets on', async () => {
      const { service, settings, log } = companion();
      const result = await service.setFavorite('max-verstappen');
      expect(result.ok).toBe(true);
      expect(result.status.settings).toMatchObject({
        favoriteDriverId: 'max-verstappen',
        activePetId: 'petdex:max-4',
        enabled: true
      });
      expect(result.status.activePet.id).toBe('petdex:max-4');
      expect(result).not.toHaveProperty('followError');
      expect(log).toEqual([
        ['install', 'max-4'],
        ['assetsChanged'],
        ['changed']
      ]);
      expect(settings.get().activePetId).toBe('petdex:max-4');
    });

    test('an installed driver pet is reused (no download)', async () => {
      const { service, log } = companion({
        initial: { activePetId: 'petdex:pia', enabled: true }
      });
      const result = await service.setFavorite('lando-norris');
      expect(result.status.settings.activePetId).toBe('petdex:lando');
      expect(log).toEqual([]);
    });

    test('pets switched off stay off when the pet changes', async () => {
      const { service } = companion({
        initial: { activePetId: 'petdex:lando', enabled: false }
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.status.settings).toMatchObject({
        activePetId: 'petdex:max-4',
        enabled: false
      });
    });

    test('a failed install keeps the favourite and reports followError', async () => {
      const { service, settings } = companion({
        install: async () => ({ ok: false, error: 'Petdex is unreachable.' })
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.ok).toBe(true);
      expect(result.followError).toBe('Petdex is unreachable.');
      expect(settings.get()).toMatchObject({
        favoriteDriverId: 'max-verstappen',
        activePetId: null,
        enabled: false
      });
      const thrown = companion({
        install: async () => {
          throw new Error('boom');
        }
      });
      expect(
        (await thrown.service.setFavorite('max-verstappen')).followError
      ).toBe('boom');
    });

    test('followFavorite off: saved, no switch', async () => {
      const { service, log } = companion({
        initial: { followFavorite: false }
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.status.settings).toMatchObject({
        favoriteDriverId: 'max-verstappen',
        activePetId: null
      });
      expect(log).toEqual([]);
    });

    test('the same favourite again does not undo a pet the user picked', async () => {
      const { service } = companion({
        initial: {
          favoriteDriverId: 'max-verstappen',
          activePetId: 'petdex:lando',
          enabled: true
        }
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.status.settings.activePetId).toBe('petdex:lando');
    });

    test('a driver without a curated pet, or null, only saves the favourite', async () => {
      const { service, log } = companion({
        initial: { activePetId: 'petdex:lando', enabled: true }
      });
      let result = await service.setFavorite('oscar-piastri');
      expect(result.status.settings).toMatchObject({
        favoriteDriverId: 'oscar-piastri',
        activePetId: 'petdex:lando'
      });
      result = await service.setFavorite(null);
      expect(result.status.settings.favoriteDriverId).toBeNull();
      expect(log).toEqual([]);
    });

    test('following onto the duo partner swaps the pair', async () => {
      const { service } = companion({
        installed: ['petdex:lando', 'petdex:max-4'],
        initial: {
          activePetId: 'petdex:lando',
          secondPetId: 'petdex:max-4',
          enabled: true
        }
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.status.settings).toMatchObject({
        activePetId: 'petdex:max-4',
        secondPetId: 'petdex:lando'
      });
    });

    test('a broken petDrivers source is treated as empty', async () => {
      const settings = createPetsSettings({ userDataDir: dir });
      const service = createPetsService({
        settings,
        store: { get: () => null, getListed: () => null },
        petdex: {},
        controller: {},
        thumbs: { thumbFor: async () => '' },
        support: () => ({ supported: true, needsRestartForPets: false }),
        getPetDrivers: () => {
          throw new Error('no feed');
        }
      });
      const result = await service.setFavorite('max-verstappen');
      expect(result.ok).toBe(true);
      expect(result.status.settings.favoriteDriverId).toBe('max-verstappen');
    });
  });

  describe('setSecondPet / setActive / remove', () => {
    test('sets and clears the duo partner', async () => {
      const { service } = companion({
        installed: ['petdex:lando', 'petdex:max-4'],
        initial: { activePetId: 'petdex:max-4', enabled: true }
      });
      let result = await service.setSecondPet('petdex:lando');
      expect(result.status.settings.secondPetId).toBe('petdex:lando');
      result = await service.setSecondPet(null);
      expect(result.status.settings.secondPetId).toBeNull();
    });

    test('refuses an unknown pet or the pet already out', async () => {
      const { service, settings } = companion({
        initial: { activePetId: 'petdex:lando', enabled: true }
      });
      expect(await service.setSecondPet('petdex:max-4')).toEqual({
        ok: false,
        error: 'Unknown pet.'
      });
      expect((await service.setSecondPet('petdex:lando')).ok).toBe(false);
      expect(settings.get().secondPetId).toBeNull();
    });

    test('choosing the second pet as the main one swaps the pair', async () => {
      const { service } = companion({
        installed: ['petdex:lando', 'petdex:max-4'],
        initial: {
          activePetId: 'petdex:max-4',
          secondPetId: 'petdex:lando',
          enabled: true
        }
      });
      const result = await service.setActive('petdex:lando');
      expect(result.status.settings).toMatchObject({
        activePetId: 'petdex:lando',
        secondPetId: 'petdex:max-4'
      });
    });

    test('removing the second pet clears it', async () => {
      const { service, settings } = companion({
        installed: ['petdex:lando', 'petdex:max-4'],
        initial: {
          activePetId: 'petdex:max-4',
          secondPetId: 'petdex:lando',
          enabled: true
        }
      });
      expect(service.remove('petdex:lando').ok).toBe(true);
      expect(settings.get()).toMatchObject({
        activePetId: 'petdex:max-4',
        secondPetId: null
      });
    });
  });

  test('celebrate hands kind + text to the controller; envelope only', () => {
    const { service, log } = companion();
    expect(service.celebrate({ kind: 'hot-lap-pb', text: 'PB!' })).toEqual({
      ok: true
    });
    expect(log).toEqual([['celebrate', 'hot-lap-pb', 'PB!']]);
    const refused = companion({
      celebrate: () => ({ ok: false, error: 'Unknown celebration.' })
    });
    expect(refused.service.celebrate({ kind: 'x', text: '' })).toEqual({
      ok: false,
      error: 'Unknown celebration.'
    });
  });

  test('onboardingDone saves the flag (visible to the page)', async () => {
    const { service, settings } = companion();
    expect(service.onboardingDone()).toEqual({ ok: true });
    expect(settings.get().onboardingShown).toBe(true);
    expect((await service.status()).status.settings.onboardingShown).toBe(true);
  });

  test('openAsk: not available by default; the injected opener otherwise', async () => {
    expect(await companion().service.openAsk()).toEqual({
      ok: false,
      error: 'Not available.'
    });
    let opened = 0;
    const ok = companion({
      openAsk: () => {
        opened += 1;
        return { ok: true };
      }
    });
    expect(await ok.service.openAsk()).toEqual({ ok: true });
    expect(opened).toBe(1);
    expect(
      await companion({ openAsk: async () => undefined }).service.openAsk()
    ).toEqual({ ok: true });
    expect(
      await companion({
        openAsk: () => ({ ok: false, error: 'No window.' })
      }).service.openAsk()
    ).toEqual({ ok: false, error: 'No window.' });
    expect(
      await companion({
        openAsk: () => {
          throw new Error('crashed');
        }
      }).service.openAsk()
    ).toEqual({ ok: false, error: 'crashed' });
  });

  test('status never shows the once-only markers', async () => {
    const { service, settings } = companion();
    settings.setMarker('lastResultKey', 'race-1');
    settings.setMarker('lastFactDay', '2026-11-06');
    const { status } = await service.status();
    expect(status.settings).not.toHaveProperty('lastResultKey');
    expect(status.settings).not.toHaveProperty('lastRateKey');
    expect(status.settings).not.toHaveProperty('lastFactDay');
  });
});
