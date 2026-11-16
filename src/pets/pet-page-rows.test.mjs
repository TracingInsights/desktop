/**
 * The bundled pet page (src/pet/pet.js) draws any row the payload names on
 * a sheet `atlas.rows` tall — so a v2 look (row 9 / 10 of 11) needs nothing
 * special in the renderer. Runs the real script against a minimal fake DOM
 * (Electron cannot run here).
 */
import { describe, test, expect } from 'bun:test';
import { loadPetPage } from './test-fixtures/fake-pet-page.mjs';

function loadPage() {
  const { render, byId } = loadPetPage();
  expect(typeof render).toBe('function');
  return { render, pet: byId('pet') };
}

const box = {
  width: 144,
  height: 156,
  spriteLeft: 0,
  spriteTop: 0,
  spriteWidth: 144,
  spriteHeight: 156,
  bubble: null
};

describe('pet page: atlas rows', () => {
  test('a look-a payload on an 11-row sheet shows row 9 of an 11-row background', () => {
    const { render, pet } = loadPage();
    render({
      state: 'look-a',
      row: 9,
      frames: 8,
      durationMs: 1120,
      once: true,
      still: false,
      playKey: 'look:1',
      bubble: null,
      size: 'm',
      atlas: {
        url: 'pet-asset://pet/petdex-cli%3Aboba/sprite?v=0',
        rows: 11,
        scale: 1
      },
      box,
      second: null
    });
    expect(Object.fromEntries(pet.props)).toMatchObject({
      '--frame-h': '156px',
      '--sheet-w': `${8 * 144}px`,
      '--sheet-h': `${11 * 156}px`,
      '--row': '9',
      '--frames': '8',
      '--duration': '1120ms'
    });
    expect(pet.style.backgroundImage).toBe(
      'url("pet-asset://pet/petdex-cli%3Aboba/sprite?v=0")'
    );
    expect([...pet.classes].sort()).toEqual(['animate', 'once']);

    // look-b: row 10, the last row of the sheet.
    render({
      state: 'look-b',
      row: 10,
      frames: 8,
      durationMs: 1120,
      once: true,
      still: false,
      playKey: 'look:2',
      bubble: null,
      size: 'm',
      atlas: { url: 'pet-asset://pet/petdex-cli%3Aboba/sprite?v=0', rows: 11 },
      box,
      second: null
    });
    expect(pet.props.get('--row')).toBe('10');
    expect(pet.props.get('--sheet-h')).toBe(`${11 * 156}px`);
  });

  test('a v1 sheet stays 9 rows tall', () => {
    const { render, pet } = loadPage();
    render({
      state: 'idle',
      row: 0,
      frames: 6,
      durationMs: 1100,
      once: false,
      still: false,
      playKey: 'idle',
      bubble: null,
      size: 'm',
      atlas: { url: 'pet-asset://pet/codex%3Aa/sprite?v=0', rows: 9 },
      box,
      second: null
    });
    expect(pet.props.get('--sheet-h')).toBe(`${9 * 156}px`);
    expect(pet.props.get('--row')).toBe('0');
  });
});
