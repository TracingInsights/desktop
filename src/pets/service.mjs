/**
 * Desktop pets — the page-facing service behind `pets:*` (docs/DESKTOP_PETS_PLAN.md §4.8).
 *
 * Composes settings, store, Petdex client, importer, controller and the
 * Linux/lifecycle helpers into the methods of `DesktopPetsSurface`
 * (src/lib/desktop-pets/contract.ts). Arguments arrive validated by ipc.mjs;
 * every method resolves an envelope.
 */
import { DEFAULT_SETTINGS } from './contract.mjs';
import { MARKER_SETTINGS } from './settings.mjs';
import { isPetdexSlug } from './pet-store.mjs';

/** Keys of `PetsSettings` the page sees (positions, markers etc. stay in main). */
const PAGE_SETTINGS_KEYS = Object.freeze(
  Object.keys(DEFAULT_SETTINGS).filter(
    (k) =>
      k !== 'positions' &&
      k !== 'firstTrayNoticeShown' &&
      !MARKER_SETTINGS.includes(k)
  )
);

const NOT_AVAILABLE = Object.freeze({ ok: false, error: 'Not available.' });

export const SIGNALS_PER_SECOND = 4;

/** @param {Record<string, unknown>} settings */
export function pageSettings(settings) {
  return Object.fromEntries(PAGE_SETTINGS_KEYS.map((k) => [k, settings[k]]));
}

/**
 * @param {{
 *   settings: ReturnType<typeof import('./settings.mjs').createPetsSettings>,
 *   store: { list: () => object[], get: (id: string) => object|null, getListed: (id: string) => object|null, remove: (id: string) => { ok: boolean, error?: string } },
 *   petdex: { search: (i: object) => Promise<object>, shelf: (i: object) => Promise<object>, thumbs: (slugs: string[]) => Promise<object>, install: (slug: string) => Promise<object> },
 *   importer: { importPet: () => Promise<object>, importPath: (path: string) => Promise<object> },
 *   controller: { quiet: (kind: string) => object, signal: (s: string) => object, celebrate: (kind: string, text: string) => object, assetsChanged: () => void },
 *   thumbs: { thumbFor: (record: object|null) => Promise<string> },
 *   support: () => { supported: boolean, unsupportedReason: string|null, needsRestartForPets: boolean },
 *   platform: string,
 *   applyLaunchAtLogin: (enabled: boolean) => void,
 *   restartApp: () => void,
 *   petsChanged: () => void,
 *   getPetDrivers?: () => Record<string, string>,
 *   renderer?: () => ({ kind: 'pending'|'native'|'electron', reason: string|null }),
 *   openAsk?: () => Promise<object|void>|object|void,
 *   now?: () => number,
 *   setTimeout?: typeof globalThis.setTimeout
 * }} deps
 */
export function createPetsService(deps) {
  const {
    settings,
    store,
    petdex,
    importer,
    controller,
    thumbs,
    support,
    platform,
    applyLaunchAtLogin,
    restartApp,
    petsChanged,
    getPetDrivers = () => ({}),
    renderer = () => ({ kind: 'electron', reason: 'not-bundled' }),
    openAsk = () => NOT_AVAILABLE,
    now = Date.now,
    setTimeout: setTimer = globalThis.setTimeout
  } = deps;

  /** @param {any} pet */
  async function withThumb(pet) {
    if (!pet || pet.thumb) return pet;
    const thumb = await thumbs.thumbFor(store.get(pet.id)).catch(() => '');
    return { ...pet, thumb };
  }

  function buildStatus() {
    const current = settings.get();
    const where = support();
    const listed = current.activePetId
      ? store.getListed(current.activePetId)
      : null;
    return {
      supported: where.supported,
      unsupportedReason: where.unsupportedReason ?? null,
      platform,
      needsRestartForPets: where.needsRestartForPets,
      settings: pageSettings(current),
      activePet: listed,
      // Native pet (docs/DESKTOP_PETS_NATIVE_PLAN.md N3): which renderer
      // draws the pet and, for the Electron fallback, why.
      renderer: renderer().kind,
      rendererReason: renderer().reason
    };
  }

  async function status() {
    const value = buildStatus();
    value.activePet = await withThumb(value.activePet);
    return { ok: true, status: value };
  }

  async function afterInstall(result) {
    if (!result?.ok) return result;
    controller.assetsChanged();
    petsChanged();
    return { ok: true, pet: await withThumb(result.pet) };
  }

  // Chat signals: ≤ SIGNALS_PER_SECOND; over the limit the latest one is
  // applied when the window frees up, so a final `done` is never lost.
  let windowStart = 0;
  let inWindow = 0;
  let pendingSignal = null;
  let pendingTimer = null;

  function applySignal(state) {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      inWindow = 0;
    }
    if (inWindow < SIGNALS_PER_SECOND) {
      inWindow += 1;
      return controller.signal(state);
    }
    pendingSignal = state;
    if (!pendingTimer) {
      pendingTimer = setTimer(
        () => {
          pendingTimer = null;
          const next = pendingSignal;
          pendingSignal = null;
          if (next) applySignal(next);
        },
        Math.max(0, windowStart + 1000 - t)
      );
      pendingTimer?.unref?.();
    }
    return { ok: true };
  }

  /**
   * Petdex slugs curated for a driver (the feed's petDrivers map), in feed
   * order.
   * @param {string} driverId
   */
  function slugsForDriver(driverId) {
    let map;
    try {
      map = getPetDrivers() ?? {};
    } catch {
      map = {};
    }
    return Object.entries(map)
      .filter(([slug, id]) => id === driverId && isPetdexSlug(slug))
      .map(([slug]) => slug);
  }

  /**
   * followFavorite: show the driver's Petdex pet — an installed one first,
   * else install the first curated slug. The first pet ever also turns
   * pets on; a user who switched pets off keeps them off.
   * @param {string} driverId
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function followDriver(driverId) {
    const slugs = slugsForDriver(driverId);
    if (slugs.length === 0) return { ok: true };
    const current = settings.get();
    if (slugs.some((slug) => current.activePetId === `petdex:${slug}`)) {
      return { ok: true };
    }
    let slug = slugs.find((s) => store.get(`petdex:${s}`)) ?? null;
    if (!slug) {
      slug = slugs[0];
      let installed;
      try {
        installed = await petdex.install(slug);
      } catch (error) {
        installed = { ok: false, error: error?.message ?? String(error) };
      }
      if (!installed?.ok) {
        return {
          ok: false,
          error: installed?.error ?? 'Could not install the pet.'
        };
      }
      controller.assetsChanged();
      petsChanged();
    }
    const id = `petdex:${slug}`;
    const latest = settings.get();
    /** @type {Record<string, unknown>} */
    const patch = { activePetId: id };
    if (latest.activePetId === null) patch.enabled = true;
    if (latest.secondPetId === id) patch.secondPetId = latest.activePetId;
    const saved = settings.update(patch, { trusted: true });
    return saved.ok ? { ok: true } : saved;
  }

  return {
    status,
    search: (input) => petdex.search(input),
    shelf: (input) => petdex.shelf(input),
    thumbs: (slugs) => petdex.thumbs(slugs),

    async list() {
      const pets = await Promise.all(store.list().map(withThumb));
      return { ok: true, pets };
    },

    install: async (slug) => afterInstall(await petdex.install(slug)),
    importPet: async () => {
      const result = await importer.importPet();
      if (result?.ok && result.pet === null) return result;
      return afterInstall(result);
    },

    /** A pet .zip downloaded in the pet-store window (same checks as Import pet…). */
    importFile: async (path) => afterInstall(await importer.importPath(path)),

    remove(id) {
      const result = store.remove(id);
      if (!result.ok) return result;
      if (settings.get().activePetId === id) settings.setActivePetId(null);
      if (settings.get().secondPetId === id) settings.setSecondPetId(null);
      controller.assetsChanged();
      petsChanged();
      return { ok: true };
    },

    async setActive(id) {
      if (id !== null && !store.get(id))
        return { ok: false, error: 'Unknown pet.' };
      const current = settings.get();
      // Picking the duo's second pet swaps the pair instead of doubling it.
      const swap =
        id !== null && current.secondPetId === id
          ? { secondPetId: current.activePetId }
          : {};
      const result =
        id === null
          ? settings.setActivePetId(null)
          : settings.update(
              { activePetId: id, enabled: true, ...swap },
              { trusted: true }
            );
      if (!result.ok) return result;
      return status();
    },

    /**
     * Favourite driver (f1db id) or null (plan §12 #1). With followFavorite
     * a new favourite (or the first one, with no pet yet) also switches to
     * that driver's curated Petdex pet, installing it when missing. A failed
     * install is not an error: the favourite stays saved and the reply
     * carries `followError`.
     * @param {string|null} driverId
     */
    async setFavorite(driverId) {
      const before = settings.get();
      const saved = settings.setFavoriteDriverId(driverId);
      if (!saved.ok) return saved;
      let followError = null;
      if (
        driverId !== null &&
        before.followFavorite &&
        (before.favoriteDriverId !== driverId || before.activePetId === null)
      ) {
        const followed = await followDriver(driverId);
        if (!followed.ok) followError = followed.error;
      }
      const result = await status();
      return followError ? { ...result, followError } : result;
    },

    /**
     * Duo (plan §12 #8): a second installed pet beside the first, or null.
     * @param {string|null} id
     */
    async setSecondPet(id) {
      if (id !== null) {
        if (!store.get(id)) return { ok: false, error: 'Unknown pet.' };
        if (settings.get().activePetId === id) {
          return {
            ok: false,
            error: 'That pet is already out. Pick a different one.'
          };
        }
      }
      const result = settings.setSecondPetId(id);
      if (!result.ok) return result;
      return status();
    },

    /**
     * Games (plan §12 #6): jumping + the text in a bubble, ≤ 1 per 10 s.
     * @param {{ kind: string, text: string }} input
     */
    celebrate(input) {
      const result = controller.celebrate(input.kind, input.text);
      return result.ok ? { ok: true } : result;
    },

    /** The first-run "Pick your driver" step was shown (plan §12 #12). */
    onboardingDone() {
      const result = settings.markOnboardingShown();
      return result.ok ? { ok: true } : result;
    },

    /** Open the quick-ask window (plan §12 #9; runtime injects `openAsk`). */
    async openAsk() {
      let result;
      try {
        result = await openAsk();
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
      if (result && typeof result === 'object' && result.ok === false) {
        return { ok: false, error: String(result.error ?? 'Not available.') };
      }
      return { ok: true };
    },

    async updateSettings(patch) {
      const result = settings.update(patch);
      if (!result.ok) return result;
      if (Object.hasOwn(patch, 'launchAtLogin')) {
        try {
          applyLaunchAtLogin(patch.launchAtLogin);
        } catch (error) {
          settings.update(
            { launchAtLogin: !patch.launchAtLogin },
            { trusted: true }
          );
          return {
            ok: false,
            error: `Could not change launch at login: ${error?.message ?? error}`
          };
        }
      }
      return status();
    },

    async quiet(kind) {
      const result = controller.quiet(kind);
      if (!result.ok) return result;
      return status();
    },

    signal: (state) => applySignal(state),

    restartApp() {
      restartApp();
      return { ok: true };
    }
  };
}
