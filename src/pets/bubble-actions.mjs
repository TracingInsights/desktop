/**
 * Desktop pets — bubble buttons (round 3, 2e).
 *
 * Pure: which buttons a bubble of a given kind shows under its text, and
 * what `mute` switches off. The controller puts them in the render payload
 * (`bubbleActions`) and carries out a click (`pet:bubbleAction`): `ok`
 * dismisses the bubble, `quiet-1h` / `quiet-session` use the tray's Quiet ▸
 * helpers, `mute` writes the kind's setting through the page path. A
 * button never opens a window; the bubble text keeps opening its target.
 */

/** Most buttons under one bubble. */
export const MAX_BUBBLE_ACTIONS = 3;

/**
 * `mute` per bubble kind: its label and the settings patch it writes (page-
 * writable keys, so the gallery shows the change). Kinds without an entry
 * (hover, celebrate) get no mute button.
 */
export const MUTE_ACTIONS = Object.freeze({
  fact: Object.freeze({
    label: 'No daily facts',
    patch: Object.freeze({ dailyFact: false })
  }),
  rate: Object.freeze({
    label: 'No rate reminders',
    patch: Object.freeze({ rateNudge: false })
  }),
  result: Object.freeze({
    label: 'No result reactions',
    patch: Object.freeze({ resultReactions: false })
  }),
  greeting: Object.freeze({
    label: 'No greetings',
    patch: Object.freeze({ greetings: false })
  }),
  calendar: Object.freeze({
    label: 'No session alerts',
    patch: Object.freeze({ sessionReactions: 'off' })
  })
});

const LABELS = Object.freeze({
  ok: 'OK',
  'quiet-1h': 'Quiet 1 h',
  'quiet-session': 'Quiet this session'
});

/**
 * The buttons under a bubble of `kind`, or null (hover bubbles vanish on
 * their own). `sessionQuiet` = "Quiet until this session ends" is on offer
 * (the controller's `sessionQuietAvailable()`, as in the tray).
 * @param {string|null|undefined} kind
 * @param {{ sessionQuiet?: boolean }} [options]
 * @returns {null | { id: string, label: string }[]}
 */
export function bubbleActionsFor(kind, { sessionQuiet = false } = {}) {
  if (typeof kind !== 'string' || !kind || kind === 'hover') return null;
  const mute = Object.hasOwn(MUTE_ACTIONS, kind) ? MUTE_ACTIONS[kind] : null;
  const ids = ['ok'];
  // ≤ 3 buttons: next to a mute button "Quiet this session" takes the
  // place of "Quiet 1 h" (it covers the session the user is in).
  if (!sessionQuiet || !mute) ids.push('quiet-1h');
  if (sessionQuiet) ids.push('quiet-session');
  const actions = ids.map((id) => ({ id, label: LABELS[id] }));
  if (mute) actions.push({ id: 'mute', label: mute.label });
  return actions;
}
