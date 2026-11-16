/**
 * Runs the bundled pet page script (src/pet/pet.js) on a minimal fake DOM
 * for the pet-page tests (Electron cannot run here). Shared, so a pet.js
 * change that needs one more DOM call is fixed here once.
 *
 * Elements record CSS custom properties (`props`), classes, attributes,
 * appended children and every `animate` removal (`log: 'stop'` — the first
 * half of a restart). Anything else the script calls on an element, the
 * document, the window or the bridge (listeners, pointer capture, events
 * sent to main …) is a no-op.
 */
import { readFileSync } from 'node:fs';

const PET_JS = readFileSync(
  new URL('../../pet/pet.js', import.meta.url),
  'utf8'
);

/** Unknown keys read as no-op functions. @template {object} T @param {T} target @returns {T} */
const lenient = (target) =>
  new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : () => {})
  });

/**
 * @param {string} [id]
 * @param {{ hidden?: boolean, classes?: string[] }} [options]
 */
export function fakeElement(id = '', { hidden = false, classes = [] } = {}) {
  const props = new Map();
  const classSet = new Set(classes);
  const attributes = new Map();
  /** @type {string[]} */
  const log = [];
  return lenient({
    id,
    hidden,
    textContent: '',
    offsetWidth: 0,
    props,
    classes: classSet,
    attributes,
    /** @type {any[]} */
    children: [],
    log,
    style: {
      backgroundImage: '',
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) ?? '',
      removeProperty: (name) => props.delete(name)
    },
    classList: {
      add: (...names) => names.forEach((n) => classSet.add(n)),
      remove: (...names) =>
        names.forEach((n) => {
          if (n === 'animate' && classSet.has(n)) log.push('stop');
          classSet.delete(n);
        }),
      contains: (name) => classSet.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classSet.has(name) : Boolean(force);
        if (on) classSet.add(name);
        else classSet.delete(name);
        return on;
      }
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    append(...nodes) {
      this.children.push(...nodes);
    }
  });
}

/**
 * Load pet.js once against fresh fake elements. `elements` presets some by
 * id (e.g. `#second` hidden); any other id is created on first use.
 * @param {{ elements?: Record<string, ReturnType<typeof fakeElement>> }} [options]
 */
export function loadPetPage({ elements = {} } = {}) {
  const byIdMap = new Map(Object.entries(elements));
  const byId = (id) => {
    if (!byIdMap.has(id)) byIdMap.set(id, fakeElement(id));
    return byIdMap.get(id);
  };
  const body = fakeElement('body');
  const document = lenient({
    body,
    getElementById: byId,
    createElement: () => fakeElement(),
    querySelector: () => null
  });
  /** @type {null | ((payload: any) => void)} */
  let onRender = null;
  const window = lenient({
    petBridge: lenient({
      onRender: (fn) => {
        onRender = fn;
      }
    }),
    matchMedia: () => ({ matches: false, addEventListener() {} })
  });
  new Function(
    'window',
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    PET_JS
  )(
    window,
    document,
    () => 1,
    () => {}
  );
  if (!onRender) throw new Error('pet.js did not subscribe to renders');
  const render = onRender;
  return { render, byId, body };
}
