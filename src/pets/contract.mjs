/**
 * Desktop pets — shared contract (docs/DESKTOP_PETS_PLAN.md §4).
 *
 * Constants every pets module imports: atlas geometry, animation states,
 * settings schema + defaults, IPC channel names and the Petdex host
 * allowlist. The website mirrors the page-facing parts in
 * src/lib/desktop-pets/contract.ts — keep the two in sync.
 *
 * No pet art ships with the app (plan D1): tests use generated atlases only.
 */

// --- Atlas geometry (Codex pet contract; Petdex src/lib/sprite-atlas.ts) ---

export const SPRITE_COLUMNS = 8;
export const SPRITE_FRAME_WIDTH = 192;
export const SPRITE_FRAME_HEIGHT = 208;
/** Atlas rows per sprite version: v1 = 8×9, v2 = 8×11 (rows 9–10 unused). */
export const ATLAS_ROWS = Object.freeze({ 1: 9, 2: 11 });

/** Animation rows (Petdex src/lib/pet-states.ts, MIT). */
export const PET_STATES = Object.freeze([
  { id: 'idle', row: 0, frames: 6, durationMs: 1100 },
  { id: 'running-right', row: 1, frames: 8, durationMs: 1060 },
  { id: 'running-left', row: 2, frames: 8, durationMs: 1060 },
  { id: 'waving', row: 3, frames: 4, durationMs: 700 },
  { id: 'jumping', row: 4, frames: 5, durationMs: 840 },
  { id: 'failed', row: 5, frames: 8, durationMs: 1220 },
  { id: 'waiting', row: 6, frames: 6, durationMs: 1010 },
  { id: 'running', row: 7, frames: 6, durationMs: 820 },
  { id: 'review', row: 8, frames: 6, durationMs: 1030 }
]);
export const PET_STATE_IDS = Object.freeze(PET_STATES.map((s) => s.id));

/** Size presets → scale of the 192×208 frame. */
export const PET_SIZES = Object.freeze({ s: 0.5, m: 0.75, l: 1 });

// --- Validation limits (plan §4.2) ---

export const LIMITS = Object.freeze({
  petJsonBytes: 16 * 1024,
  imageBytes: 8 * 1024 * 1024,
  zipBytes: 12 * 1024 * 1024,
  zipUncompressedBytes: 20 * 1024 * 1024,
  zipEntries: 8,
  displayNameChars: 80,
  descriptionChars: 300
});

// --- Pet ids ---
// "petdex:<slug>" | "codex:<folder>" | "import:<uuid>"
export const PET_SOURCES = Object.freeze(['petdex', 'codex', 'import']);

// --- Settings (plan §4.1) ---

export const SESSION_REACTIONS = Object.freeze(['calm', 'lively', 'off']);

export const DEFAULT_SETTINGS = Object.freeze({
  v: 1,
  enabled: false,
  activePetId: null,
  size: 'm',
  chatReactions: true,
  sessionReactions: 'calm',
  quietUntil: null,
  closeToTray: true,
  launchAtLogin: false,
  scanCodexDir: true,
  positions: {},
  firstTrayNoticeShown: false,
  /** Native OS notifications (tray notice, update ready, pet imported). */
  notifications: true,
  // --- Companion features (round 2, docs/DESKTOP_PETS_PLAN.md §12) ---
  /** f1db driver id ("max-verstappen"); mirrors the account favourite when signed in. */
  favoriteDriverId: null,
  /** Switch the pet to the favourite driver's Petdex pet when one exists. */
  followFavorite: true,
  /** React to the favourite driver's latest race result (once per race). */
  resultReactions: true,
  /** Once-a-day "On this day" bubble. */
  dailyFact: true,
  /** "Rate the … GP" bubble after a race. */
  rateNudge: true,
  /** Duo: a second pet shown beside the first ("petdex:lando" …), or null. */
  secondPetId: null,
  /** First-run "Pick your driver" step was shown (never shown again). */
  onboardingShown: false,
  /** Internal once-only markers (not page-writable). */
  lastResultKey: null,
  lastRateKey: null,
  lastFactDay: null
});

/** Keys the page may change through `pets:updateSettings`. */
export const PAGE_WRITABLE_SETTINGS = Object.freeze([
  'enabled',
  'size',
  'chatReactions',
  'sessionReactions',
  'closeToTray',
  'launchAtLogin',
  'scanCodexDir',
  'notifications',
  'followFavorite',
  'resultReactions',
  'dailyFact',
  'rateNudge'
]);

// --- Chat activity signals (plan §4.5 row 4) ---

export const CHAT_SIGNALS = Object.freeze([
  'planning',
  'streaming',
  'needs-choice',
  'review-open',
  'done',
  'error',
  'idle'
]);
/** A signal not refreshed within this window expires (destroyed window). */
export const CHAT_SIGNAL_TTL_MS = 2 * 60 * 1000;

// --- Calendar (plan §4.5 row 5, §4.6) ---

export const SESSION_KINDS = Object.freeze([
  'qualifying',
  'sprint-qualifying',
  'sprint',
  'race'
]);
/** Nominal session lengths (no live timing). */
export const SESSION_DURATION_MS = Object.freeze({
  qualifying: 60 * 60 * 1000,
  'sprint-qualifying': 45 * 60 * 1000,
  sprint: 60 * 60 * 1000,
  race: 2 * 60 * 60 * 1000
});
export const SESSION_LEAD_MS = 30 * 60 * 1000;
export const BUBBLE_MS = 15 * 1000;
export const SCHEDULE_PATH = '/desktop/schedule.json';
export const SCHEDULE_REFRESH_MS = 24 * 60 * 60 * 1000;

// --- Companion features (round 2) ---

/**
 * `/desktop/schedule.json` v1 gains ADDITIVE fields (old apps ignore them):
 *   season: number                       — season of `latestRace`
 *   latestRace: null | {
 *     key: string, year, round, gp, rateSlug: string,   // /rate/<year>/<rateSlug>
 *     grandPrixId: string,                               // /stats/races/<year>/<round>/<grandPrixId>
 *     startsAt: string|null,                             // ISO UTC; key === its sessions[] key
 *     results: [{ driverId, name, code, position: number|null, status: string }]
 *       // status: finished | nc | dnf | dsq | dns | dnq (position only when finished)
 *   }
 *   seasonResults: { [driverId]: (number|null)[] }      // race finish position per round, null = not classified / not started
 *   drivers: [{ id, name, code }]                       // drivers with a result this season
 *   petDrivers: { [petdexSlug]: driverId }              // curated pet → driver map (website curation.ts)
 *   sessions[].rateSlug: string                         // on race sessions
 */
export const FEED_PATH = SCHEDULE_PATH;
/** Result bubble only while the race is this recent. */
export const RESULT_REACTION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** "Rate the … GP" once the race has been over this long (nominal end + 1 h). */
export const RATE_NUDGE_AFTER_END_MS = 60 * 60 * 1000;
/** …and only within this window after the race. */
export const RATE_NUDGE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** Daily fact: first idle moment after this local hour, once per local day. */
export const DAILY_FACT_HOUR = 9;
/** `${appUrl}${ON_THIS_DAY_PATH}<mmm-dd>.json` (static stats artifact). */
export const ON_THIS_DAY_PATH = '/stats/data/on-this-day/';
/** Celebration kinds the page may send (games). */
export const CELEBRATE_KINDS = Object.freeze(['hot-lap-pb', 'roadster-best']);
export const CELEBRATE_TEXT_CHARS = 120;
/** Quick-ask window: a small app-origin page next to the pet. */
export const ASK_PATH = '/desktop/ask';

// --- Petdex (plan §4.3) ---

export const PETDEX_ORIGIN = 'https://petdex.dev';
export const PETDEX_ASSET_ORIGIN = 'https://assets.petdex.dev';
export const PETDEX_MANIFEST_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const PETDEX_TIMEOUT_MS = 10_000;
export const PETDEX_SEARCH_MAX_LIMIT = 48;

// --- IPC channels (plan §4.8) ---

/** Main window (remote site) → main. Every handler resolves an envelope. */
export const PETS_CHANNELS = Object.freeze({
  status: 'pets:status',
  search: 'pets:search',
  shelf: 'pets:shelf',
  thumbs: 'pets:thumbs',
  list: 'pets:list',
  install: 'pets:install',
  importPet: 'pets:import',
  remove: 'pets:remove',
  setActive: 'pets:setActive',
  updateSettings: 'pets:updateSettings',
  quiet: 'pets:quiet',
  signal: 'pets:signal',
  restartApp: 'pets:restartApp',
  /**
   * (driverId: string|null) → status (+ followError when the driver's pet
   * could not be installed); also switches pet when followFavorite.
   */
  setFavorite: 'pets:setFavorite',
  /** (id: string|null) → status; the duo's second pet. */
  setSecondPet: 'pets:setSecondPet',
  /** ({ kind: CELEBRATE_KINDS, text }) → envelope; games. */
  celebrate: 'pets:celebrate',
  /** () → envelope; first-run step was shown. */
  onboardingDone: 'pets:onboardingDone',
  /** () → envelope; open the quick-ask window. */
  openAsk: 'pets:openAsk',
  /** main → page event: settings / installed list changed. */
  changed: 'pets:changed'
});

/** Pet window (bundled app://pet page) ↔ main. */
export const PET_WINDOW_CHANNELS = Object.freeze({
  ready: 'pet:ready',
  drag: 'pet:drag',
  dragEnd: 'pet:dragEnd',
  click: 'pet:click',
  dblclick: 'pet:dblclick',
  hover: 'pet:hover',
  contextMenu: 'pet:contextMenu',
  bubbleClick: 'pet:bubbleClick',
  /**
   * main → pet: { state, row, frames, durationMs, once, still, playKey,
   * bubble, size, atlas: { url, rows, scale }, box: { width, height,
   * spriteLeft, spriteTop, spriteWidth, spriteHeight, bubble: 'above'|'below'|null },
   * second: null | { url, rows, scale } } — duo: the second sprite plays the
   * same state beside the first (pet-window.mjs widens the box) }
   * (`still` = frame 0 without animating; a new `playKey` restarts a
   * one-shot; `box` = layout inside the window, from pet-window.mjs).
   */
  render: 'pet:render'
});

export const PET_PAGE_SCHEME = 'app';
export const PET_ASSET_SCHEME = 'pet-asset';
