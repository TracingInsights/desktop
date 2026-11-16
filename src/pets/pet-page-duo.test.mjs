/**
 * The bundled pet page script (src/pet/pet.js) on a minimal fake DOM:
 * the duo's second sprite plays its own `secondAnim` (row, frames,
 * duration, once, delayMs → CSS custom properties set through CSSOM), and
 * each sprite restarts only when its own playKey / row changes (4b).
 */
import { describe, test, expect } from 'bun:test';
import { fakeElement, loadPetPage } from './test-fixtures/fake-pet-page.mjs';

/** Load pet.js against fresh elements; returns the render callback. */
function loadPage() {
  const elements = {
    pet: fakeElement('pet', { classes: ['sprite'] }),
    second: fakeElement('second', { hidden: true, classes: ['sprite'] }),
    bubble: fakeElement('bubble', { hidden: true })
  };
  const { render } = loadPetPage({ elements });
  const animating = (el) => el.classList.contains('animate');
  /** Render and report which sprites restarted. */
  const step = (payload) => {
    for (const el of [elements.pet, elements.second]) el.log.length = 0;
    render(payload);
    return {
      pet: elements.pet.log.includes('stop') || false,
      second: elements.second.log.includes('stop') || false
    };
  };
  return { ...elements, render, step, animating };
}

const BOX = {
  width: 295,
  height: 156,
  spriteLeft: 151,
  spriteTop: 0,
  spriteWidth: 144,
  spriteHeight: 156,
  bubble: null,
  second: { left: 0, top: 0, side: 'left' }
};

const sprite = (name) => ({
  url: `pet-asset://pet/${name}/sprite?v=0`,
  rows: 9,
  scale: 1
});

/** A duo payload: the first plays `first`; `secondAnim` as given. */
function payload(first, secondAnim = null, extra = {}) {
  return {
    state: first.state,
    row: first.row,
    frames: first.frames,
    durationMs: first.durationMs,
    once: first.once ?? false,
    still: false,
    playKey: first.playKey,
    bubble: null,
    size: 'm',
    atlas: sprite('max'),
    second: sprite('lando'),
    secondAnim,
    box: BOX,
    ...extra
  };
}

const IDLE = { state: 'idle', row: 0, frames: 6, durationMs: 1100 };
const WAVING = { state: 'waving', row: 3, frames: 4, durationMs: 700 };
const FAILED = { state: 'failed', row: 5, frames: 8, durationMs: 1220 };

describe('pet.js — duo second sprite (4b)', () => {
  test('no secondAnim: the second plays the first’s row, no delay', () => {
    const page = loadPage();
    const restarted = page.step(payload({ ...IDLE, playKey: 'idle' }));
    expect(page.second.hidden).toBe(false);
    for (const el of [page.pet, page.second]) {
      expect(el.props.get('--row')).toBe('0');
      expect(el.props.get('--frames')).toBe('6');
      expect(el.props.get('--duration')).toBe('1100ms');
      expect(el.props.get('--delay')).toBe('0ms');
      expect(page.animating(el)).toBe(true);
    }
    // First render: nothing was animating yet, so nothing to stop.
    expect(restarted).toEqual({ pet: false, second: false });
  });

  test('secondAnim: own row, frames, duration, once and delay', () => {
    const page = loadPage();
    page.step(payload({ ...IDLE, playKey: 'idle' }));
    page.step(
      payload(
        { ...WAVING, once: true, playKey: 'duo-wave:1' },
        {
          ...WAVING,
          once: true,
          still: false,
          playKey: 'duo-wave:1:second',
          delayMs: 700
        }
      )
    );
    expect(page.pet.props.get('--row')).toBe('3');
    expect(page.pet.props.get('--delay')).toBe('0ms');
    expect(page.second.props.get('--row')).toBe('3');
    expect(page.second.props.get('--frames')).toBe('4');
    expect(page.second.props.get('--duration')).toBe('700ms');
    expect(page.second.props.get('--delay')).toBe('700ms');
    expect(page.second.classList.contains('once')).toBe(true);

    const failing = {
      ...FAILED,
      once: true,
      still: false,
      playKey: 'result:k:1:second',
      delayMs: 0
    };
    page.step(payload({ ...IDLE, playKey: 'idle' }, failing));
    expect(page.pet.props.get('--row')).toBe('0');
    expect(page.pet.classList.contains('once')).toBe(false);
    expect(page.second.props.get('--row')).toBe('5');
    expect(page.second.props.get('--frames')).toBe('8');
    expect(page.second.props.get('--delay')).toBe('0ms');
  });

  test('each sprite restarts only when its own playKey changes (the stagger survives)', () => {
    const page = loadPage();
    page.step(payload({ ...IDLE, playKey: 'idle' }));
    const answer = {
      ...WAVING,
      once: true,
      still: false,
      playKey: 'duo-wave:1:second',
      delayMs: 700
    };
    // Wave start: both change → both restart.
    expect(
      page.step(
        payload({ ...WAVING, once: true, playKey: 'duo-wave:1' }, answer)
      )
    ).toEqual({ pet: true, second: true });
    // The first is done (back to idle); the second's delayed wave must not
    // restart, or its delay would start over.
    expect(page.step(payload({ ...IDLE, playKey: 'idle' }, answer))).toEqual({
      pet: true,
      second: false
    });
    expect(page.animating(page.second)).toBe(true);
    // The second's wave is over: it rejoins the first's idle (restart it
    // only; the first keeps its phase).
    expect(page.step(payload({ ...IDLE, playKey: 'idle' }, null))).toEqual({
      pet: false,
      second: true
    });
    expect(page.second.props.get('--row')).toBe('0');
    expect(page.second.props.get('--delay')).toBe('0ms');
    // Same render again: nothing restarts.
    expect(page.step(payload({ ...IDLE, playKey: 'idle' }, null))).toEqual({
      pet: false,
      second: false
    });
  });

  test('fallback idle on the second while the first plays a row it lacks', () => {
    const page = loadPage();
    page.step(payload({ ...IDLE, playKey: 'idle' }));
    const look = { state: 'look-a', row: 9, frames: 8, durationMs: 1120 };
    const idle = {
      ...IDLE,
      once: false,
      still: false,
      playKey: 'idle',
      delayMs: 0
    };
    // The second already plays idle (playKey + row unchanged): no restart.
    expect(
      page.step(
        payload({ ...look, once: true, playKey: 'look-a:1' }, idle, {
          atlas: { ...sprite('max'), rows: 11 }
        })
      )
    ).toEqual({ pet: true, second: false });
    expect(page.pet.props.get('--row')).toBe('9');
    expect(page.pet.props.get('--sheet-h')).toBe(`${11 * 156}px`);
    expect(page.second.props.get('--row')).toBe('0');
  });

  test('still: neither sprite animates; a junk secondAnim mirrors the first', () => {
    const page = loadPage();
    page.step(
      payload({ ...IDLE, playKey: 'idle' }, null, {
        still: true
      })
    );
    expect(page.animating(page.pet)).toBe(false);
    expect(page.animating(page.second)).toBe(false);
    page.step(
      payload(
        { ...IDLE, playKey: 'idle' },
        { ...FAILED, still: true, playKey: 'x', once: true, delayMs: 0 },
        { still: true }
      )
    );
    expect(page.animating(page.second)).toBe(false);
    expect(page.second.props.get('--row')).toBe('5');
    for (const junk of ['waving', 7, { state: 'failed' }]) {
      page.step(payload({ ...WAVING, playKey: 'hover:1' }, junk));
      expect(page.second.props.get('--row')).toBe('3');
      expect(page.animating(page.second)).toBe(true);
    }
  });

  test('a single pet ignores secondAnim and keeps #second hidden', () => {
    const page = loadPage();
    page.step(
      payload(
        { ...IDLE, playKey: 'idle' },
        { ...FAILED, once: true, still: false, playKey: 'x', delayMs: 0 },
        { second: null, box: { ...BOX, second: null } }
      )
    );
    expect(page.second.hidden).toBe(true);
    expect(page.second.props.size).toBe(0);
    expect(page.animating(page.pet)).toBe(true);
  });
});
