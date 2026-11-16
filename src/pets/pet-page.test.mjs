/**
 * The bundled pet page (desktop/src/pet/) in a jsdom window, round 3 (L4):
 * bubble buttons, the click panel (buttons, Escape / blur / pointer-idle
 * close) and the badge. `window.petBridge` is faked; nothing Electron.
 * jsdom comes from the website's dependencies: skipped where it is missing
 * (a desktop-only checkout).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const jsdom = await import('jsdom').catch(() => null);

const html = readFileSync(
  new URL('../pet/index.html', import.meta.url),
  'utf8'
);
const script = readFileSync(new URL('../pet/pet.js', import.meta.url), 'utf8');

/** Pet page with a fake bridge and fake timers. */
function page() {
  const dom = new jsdom.JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  let onRender = null;
  window.petBridge = new Proxy(
    {},
    {
      get: (_t, name) =>
        name === 'onRender'
          ? (cb) => {
              onRender = cb;
            }
          : (...args) => sent.push([name, ...args])
    }
  );
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  let now = 0;
  let seq = 0;
  const timers = new Map();
  window.setTimeout = (fn, ms) => {
    timers.set(++seq, { at: now + ms, fn });
    return seq;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.eval(script);
  const $ = (id) => window.document.getElementById(id);
  return {
    window,
    $,
    sent,
    /** Sent events other than the start-up `ready`. */
    events: () => sent.filter(([name]) => name !== 'ready'),
    render: (payload) => onRender(payload),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    timers: () => timers.size
  };
}

const BOX = {
  width: 300,
  height: 296,
  spriteLeft: 78,
  spriteTop: 140,
  spriteWidth: 144,
  spriteHeight: 156,
  bubble: null,
  panel: null,
  second: null
};
const base = (over = {}, box = {}) => ({
  state: 'idle',
  row: 0,
  frames: 6,
  durationMs: 1100,
  once: false,
  still: false,
  playKey: 'idle',
  bubble: null,
  size: 'm',
  atlas: { url: 'pet-asset://pet/codex%3Alando/sprite?v=0', rows: 9, scale: 1 },
  second: null,
  ...over,
  box: { ...BOX, ...box }
});
const ACTIONS = [
  { id: 'ok', label: 'OK' },
  { id: 'quiet-1h', label: 'Quiet 1 h' },
  { id: 'mute', label: 'No daily facts' }
];
const PANEL = {
  lines: ['Race in 2 h · Las Vegas GP', 'Max Verstappen won the São Paulo GP'],
  actions: [
    { id: 'ask', label: 'Ask F1' },
    { id: 'pets', label: 'Pets' }
  ]
};

describe.skipIf(!jsdom)('pet page (round 3)', () => {
  test('a payload without the round-3 fields renders as before', () => {
    const p = page();
    p.render(base());
    expect(p.$('bubble').hidden).toBe(true);
    expect(p.$('panel').hidden).toBe(true);
    expect(p.$('badge').hidden).toBe(true);
    expect(p.sent[0]).toEqual(['ready', { reducedMotion: false }]);
  });

  test('bubble buttons: real <button>s under the text; a button never clicks the bubble', () => {
    const p = page();
    p.render(
      base(
        { bubble: 'On this day · 1994', bubbleActions: ACTIONS },
        { bubble: 'above' }
      )
    );
    expect(p.$('bubble').hidden).toBe(false);
    expect(p.$('bubble-text').textContent).toBe('On this day · 1994');
    const buttons = [...p.$('bubble-actions').querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      'OK',
      'Quiet 1 h',
      'No daily facts'
    ]);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    buttons[2].click();
    expect(p.events()).toEqual([['bubbleAction', 'mute']]);
    // The row's gaps are not the bubble text either.
    p.$('bubble-actions').click();
    expect(p.events()).toEqual([['bubbleAction', 'mute']]);
    p.$('bubble-text').click();
    expect(p.events().at(-1)).toEqual(['bubbleClick']);
    // Same buttons again: the elements (and focus) stay.
    p.render(
      base(
        { bubble: 'On this day · 1994', bubbleActions: ACTIONS },
        { bubble: 'above' }
      )
    );
    expect(p.$('bubble-actions').querySelector('button')).toBe(buttons[0]);
  });

  test('a bubble without buttons hides the row; malformed actions are skipped', () => {
    const p = page();
    p.render(
      base(
        {
          bubble: 'Qualifying in 2 h',
          bubbleActions: [{ id: 'ok' }, null, { id: 'ok', label: 'OK' }]
        },
        { bubble: 'above' }
      )
    );
    expect(
      [...p.$('bubble-actions').querySelectorAll('button')].map(
        (b) => b.textContent
      )
    ).toEqual(['OK']);
    p.render(base({ bubble: 'Qualifying in 2 h' }, { bubble: 'above' }));
    expect(p.$('bubble-actions').hidden).toBe(true);
    expect(p.$('bubble-actions').children.length).toBe(0);
  });

  test('the panel: lines, buttons, anchored to the sprite side', () => {
    const p = page();
    p.render(base({ panel: PANEL }, { panel: 'above' }));
    const panel = p.$('panel');
    expect(panel.hidden).toBe(false);
    expect(panel.classList.contains('above')).toBe(true);
    expect(
      [...p.$('panel-lines').querySelectorAll('p')].map((l) => l.textContent)
    ).toEqual(PANEL.lines);
    // above: bottom = window height − sprite top + 4 px gap
    expect(panel.style.getPropertyValue('--panel-edge')).toBe(
      `${296 - 140 + 4}px`
    );
    const [ask, pets] = p.$('panel-actions').querySelectorAll('button');
    pets.click();
    ask.click();
    expect(p.events()).toEqual([
      ['panelAction', 'pets'],
      ['panelAction', 'ask']
    ]);
    // below: top = sprite bottom + 4 px
    p.render(
      base({ panel: PANEL }, { panel: 'below', spriteTop: 0, height: 296 })
    );
    expect(panel.classList.contains('below')).toBe(true);
    expect(panel.style.getPropertyValue('--panel-edge')).toBe('160px');
    // No lines: the lines block hides.
    p.render(
      base({ panel: { lines: [], actions: PANEL.actions } }, { panel: 'above' })
    );
    expect(p.$('panel-lines').hidden).toBe(true);
    p.render(base());
    expect(panel.hidden).toBe(true);
  });

  test('Escape and losing focus close the panel (only while it shows)', () => {
    const p = page();
    const escape = () =>
      p.window.document.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    escape();
    p.window.dispatchEvent(new p.window.Event('blur'));
    expect(p.events()).toEqual([]);
    p.render(base({ panel: PANEL }, { panel: 'above' }));
    escape();
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    p.window.dispatchEvent(new p.window.Event('blur'));
    expect(p.events()).toEqual([
      ['panelAction', 'close'],
      ['panelAction', 'close']
    ]);
  });

  test('20 s with the pointer outside the window closes the panel; coming back cancels', () => {
    const p = page();
    const doc = p.window.document;
    const leave = () =>
      doc.body.dispatchEvent(
        new p.window.MouseEvent('pointerout', {
          bubbles: true,
          relatedTarget: null
        })
      );
    const enter = () =>
      doc.body.dispatchEvent(
        new p.window.MouseEvent('pointerover', { bubbles: true })
      );
    // Opened by a click: the pointer is inside.
    doc.body.dispatchEvent(
      new p.window.MouseEvent('pointerdown', { bubbles: true })
    );
    p.render(base({ panel: PANEL }, { panel: 'above' }));
    expect(p.timers()).toBe(0);
    leave();
    p.advance(19_000);
    enter();
    p.advance(5_000);
    expect(p.events()).toEqual([]);
    leave();
    p.advance(20_000);
    expect(p.events()).toEqual([['panelAction', 'close']]);
    // Moving between elements inside the window is not leaving it.
    p.render(base({ panel: PANEL }, { panel: 'above' }));
    enter();
    doc.body.dispatchEvent(
      new p.window.MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: p.$('panel')
      })
    );
    p.advance(30_000);
    expect(p.events().length).toBe(1);
    // A closed panel stops the timer.
    leave();
    p.render(base());
    p.advance(30_000);
    expect(p.events().length).toBe(1);
  });

  test('the badge: a labelled dot at the pet’s upper right, no clicks of its own', () => {
    const p = page();
    p.render(base({ badge: { kind: 'answer', label: 'Answer ready' } }));
    const badge = p.$('badge');
    expect(badge.hidden).toBe(false);
    expect(badge.getAttribute('aria-label')).toBe('Answer ready');
    expect(p.$('badge-text').textContent).toBe('Answer ready');
    const inset = Math.round(144 * 0.1);
    expect(badge.style.getPropertyValue('--badge-left')).toBe(
      `${78 + 144 - 14 - inset}px`
    );
    // A quarter down the sprite: clear of the sleep "z z" mark (2b).
    expect(badge.style.getPropertyValue('--badge-top')).toBe(
      `${140 + Math.round(156 * 0.25)}px`
    );
    p.render(base({ badge: null }));
    expect(badge.hidden).toBe(true);
  });
});
