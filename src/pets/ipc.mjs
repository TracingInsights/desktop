/**
 * Desktop pets — IPC (docs/DESKTOP_PETS_PLAN.md §4.8).
 *
 * - `pets:*` (PETS_CHANNELS): invoked by the remote site in the main window.
 *   Same trust check as the harness (app origin in the *current* main
 *   window, read per call — so it keeps working after the window is
 *   recreated). Every handler validates its arguments and resolves an
 *   envelope `{ ok: true, … } | { ok: false, error }`, never rejects.
 * - `pet:*` (PET_WINDOW_CHANNELS): one-way events from the bundled pet page.
 *   Accepted only from the pet window's webContents on `app://pet/`;
 *   anything else is dropped silently.
 */
import {
  CELEBRATE_KINDS,
  CELEBRATE_TEXT_CHARS,
  CHAT_SIGNALS,
  PET_PAGE_SCHEME,
  PET_WINDOW_CHANNELS,
  PETDEX_SEARCH_MAX_LIMIT,
  PETS_CHANNELS
} from './contract.mjs';
import { isDriverId, isPetId } from './settings.mjs';
import { isPetdexSlug } from './pet-store.mjs';
import { PET_PAGE_HOST } from './protocols.mjs';

const SORTS = ['popular', 'recent', 'alpha', 'curated'];
const QUIET_KINDS = ['session', '1h', 'off'];
const MAX_QUERY_CHARS = 200;
const MAX_LIST_ITEMS = 100;
const MAX_LIST_ITEM_CHARS = 100;
const MAX_DRAG_DELTA = 4000;

const fail = (error) => ({ ok: false, error });
const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

/**
 * The pet window's page, and nothing else.
 * @param {{ sender?: unknown, senderFrame?: { url?: string } | null }} event
 * @param {{ petWindow: { webContents: unknown, isDestroyed?: () => boolean } | null }} context
 */
export function isPetWindowSender(event, context) {
  const window = context.petWindow;
  if (!window || window.isDestroyed?.() || event?.sender !== window.webContents)
    return false;
  const url = event?.senderFrame?.url;
  if (typeof url !== 'string') return false;
  try {
    // Node's URL gives custom schemes an opaque ("null") origin: compare parts.
    const parsed = new URL(url);
    return (
      parsed.protocol === `${PET_PAGE_SCHEME}:` && parsed.host === PET_PAGE_HOST
    );
  } catch {
    return false;
  }
}

// --- Argument validation (exported for tests) ---

/** @returns {{ ok: true, value: object } | { ok: false, error: string }} */
export function validateSearchInput(input) {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return fail('Search input must be an object.');
  const value = {};
  if (input.q !== undefined && input.q !== null) {
    if (typeof input.q !== 'string' || input.q.length > MAX_QUERY_CHARS)
      return fail('Invalid search text.');
    value.q = input.q;
  }
  if (input.sort !== undefined && input.sort !== null) {
    if (!SORTS.includes(input.sort)) return fail('Invalid sort.');
    value.sort = input.sort;
  }
  if (input.cursor !== undefined && input.cursor !== null) {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0)
      return fail('Invalid cursor.');
    value.cursor = input.cursor;
  }
  if (input.limit !== undefined && input.limit !== null) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > PETDEX_SEARCH_MAX_LIMIT
    ) {
      return fail('Invalid limit.');
    }
    value.limit = input.limit;
  }
  return { ok: true, value };
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS)
    return fail(`Invalid ${name}.`);
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_LIST_ITEM_CHARS
    ) {
      return fail(`Invalid ${name}.`);
    }
  }
  return { ok: true, value: [...value] };
}

export function validateShelfInput(input) {
  if (!isPlainObject(input)) return fail('Shelf input must be an object.');
  const terms = stringList(input.terms ?? [], 'terms');
  if (!terms.ok) return terms;
  if (terms.value.length > 10) return fail('Too many terms.');
  const curated = stringList(input.curated ?? [], 'curated slugs');
  if (!curated.ok) return curated;
  const deny = stringList(input.deny ?? [], 'denylist');
  if (!deny.ok) return deny;
  if (![...curated.value, ...deny.value].every(isPetdexSlug))
    return fail('Invalid slug.');
  return {
    ok: true,
    value: { terms: terms.value, curated: curated.value, deny: deny.value }
  };
}

/** `pets:celebrate` input: exactly `{ kind, text }`. */
export function validateCelebrateInput(input) {
  if (!isPlainObject(input)) return fail('Celebration must be an object.');
  for (const key of Object.keys(input)) {
    if (key !== 'kind' && key !== 'text') return fail('Invalid celebration.');
  }
  if (!CELEBRATE_KINDS.includes(input.kind)) {
    return fail('Unknown celebration.');
  }
  if (
    typeof input.text !== 'string' ||
    input.text.length > CELEBRATE_TEXT_CHARS
  ) {
    return fail('Invalid celebration text.');
  }
  return { ok: true, value: { kind: input.kind, text: input.text } };
}

/**
 * @param {{
 *   ipcMain: { handle: Function, on: Function },
 *   isTrustedSender: (event: object) => boolean,
 *   isPetSender: (event: object) => boolean,
 *   service: {
 *     status: () => Promise<object>|object, search: (input: object) => Promise<object>,
 *     shelf: (input: object) => Promise<object>, thumbs: (slugs: string[]) => Promise<object>, list: () => Promise<object>|object,
 *     install: (slug: string) => Promise<object>, importPet: () => Promise<object>,
 *     remove: (id: string) => Promise<object>|object, setActive: (id: string|null) => Promise<object>|object,
 *     updateSettings: (patch: object) => Promise<object>|object, quiet: (kind: string) => Promise<object>|object,
 *     signal: (state: string) => object, restartApp: () => object,
 *     setFavorite: (driverId: string|null) => Promise<object>, setSecondPet: (id: string|null) => Promise<object>,
 *     celebrate: (input: { kind: string, text: string }) => object, onboardingDone: () => object,
 *     openAsk: () => Promise<object>
 *   },
 *   onPetEvent: (kind: string, ...args: unknown[]) => void,
 *   log?: (message: string, error?: unknown) => void
 * }} deps
 */
export function createPetsIpc({
  ipcMain,
  isTrustedSender,
  isPetSender,
  service,
  onPetEvent,
  log = console.warn
}) {
  function handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event))
        return fail('Pets are not available from this page.');
      try {
        return await handler(...args);
      } catch (error) {
        log(`[pets] ${channel} failed:`, error);
        return fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  function on(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      if (!isPetSender(event)) return;
      try {
        handler(...args);
      } catch (error) {
        log(`[pets] ${channel} failed:`, error);
      }
    });
  }

  return {
    register() {
      handle(PETS_CHANNELS.status, () => service.status());
      handle(PETS_CHANNELS.search, (input) => {
        const checked = validateSearchInput(input);
        return checked.ok ? service.search(checked.value) : checked;
      });
      handle(PETS_CHANNELS.shelf, (input) => {
        const checked = validateShelfInput(input);
        return checked.ok ? service.shelf(checked.value) : checked;
      });
      handle(PETS_CHANNELS.thumbs, (slugs) =>
        Array.isArray(slugs) && slugs.length <= 48 && slugs.every(isPetdexSlug)
          ? service.thumbs(slugs)
          : fail('Invalid Petdex slugs.')
      );
      handle(PETS_CHANNELS.list, () => service.list());
      handle(PETS_CHANNELS.install, (slug) =>
        isPetdexSlug(slug)
          ? service.install(slug)
          : fail('Invalid Petdex slug.')
      );
      handle(PETS_CHANNELS.importPet, () => service.importPet());
      handle(PETS_CHANNELS.remove, (id) =>
        isPetId(id) ? service.remove(id) : fail('Unknown pet.')
      );
      handle(PETS_CHANNELS.setActive, (id) =>
        id === null || isPetId(id)
          ? service.setActive(id)
          : fail('Unknown pet.')
      );
      handle(PETS_CHANNELS.updateSettings, (patch) =>
        isPlainObject(patch) && Object.keys(patch).length <= 16
          ? service.updateSettings(patch)
          : fail('Settings patch must be an object.')
      );
      handle(PETS_CHANNELS.quiet, (kind) =>
        QUIET_KINDS.includes(kind)
          ? service.quiet(kind)
          : fail('Unknown quiet option.')
      );
      handle(PETS_CHANNELS.signal, (state) =>
        CHAT_SIGNALS.includes(state)
          ? service.signal(state)
          : fail('Unknown signal.')
      );
      handle(PETS_CHANNELS.restartApp, () => service.restartApp());
      handle(PETS_CHANNELS.setFavorite, (driverId) =>
        driverId === null || isDriverId(driverId)
          ? service.setFavorite(driverId)
          : fail('Unknown driver.')
      );
      handle(PETS_CHANNELS.setSecondPet, (id) =>
        id === null || isPetId(id)
          ? service.setSecondPet(id)
          : fail('Unknown pet.')
      );
      handle(PETS_CHANNELS.celebrate, (input) => {
        const checked = validateCelebrateInput(input);
        return checked.ok ? service.celebrate(checked.value) : checked;
      });
      handle(PETS_CHANNELS.onboardingDone, () => service.onboardingDone());
      handle(PETS_CHANNELS.openAsk, () => service.openAsk());

      on(PET_WINDOW_CHANNELS.ready, (info) => {
        onPetEvent('ready', {
          reducedMotion: isPlainObject(info) && info.reducedMotion === true
        });
      });
      on(PET_WINDOW_CHANNELS.drag, (dx, dy) => {
        const ok = (v) => Number.isFinite(v) && Math.abs(v) <= MAX_DRAG_DELTA;
        if (ok(dx) && ok(dy))
          onPetEvent('drag', Math.round(dx), Math.round(dy));
      });
      for (const kind of [
        'dragEnd',
        'click',
        'dblclick',
        'hover',
        'contextMenu',
        'bubbleClick'
      ]) {
        on(PET_WINDOW_CHANNELS[kind], () => onPetEvent(kind));
      }
    },

    /**
     * Tell the page that settings / the installed list changed.
     * @param {{ isDestroyed: () => boolean, send: (channel: string) => void } | null | undefined} webContents
     */
    notifyChanged(webContents) {
      if (webContents && !webContents.isDestroyed())
        webContents.send(PETS_CHANNELS.changed);
    }
  };
}
