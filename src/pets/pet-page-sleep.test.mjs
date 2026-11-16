/**
 * Pet page (desktop/src/pet/pet.js) × sleep (round 3, 2b): the "z z" mark
 * shows beside the head only while a render payload says `sleeping`, the
 * sprite stays a still frame, and a payload without the field renders as
 * before. pet.js runs against a tiny fake DOM (no browser here); pet.css is
 * checked for the reduced-motion rule.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPetPage } from './test-fixtures/fake-pet-page.mjs';

const PET_CSS = fileURLToPath(new URL('../pet/pet.css', import.meta.url));

function loadPage() {
  const { render, byId, body } = loadPetPage();
  const zzz = body.children.find((el) => el.id === 'zzz');
  return { render, pet: byId('pet'), badge: byId('badge'), zzz };
}

const payload = (over = {}) => ({
  state: 'idle',
  row: 0,
  frames: 6,
  durationMs: 1100,
  once: false,
  still: false,
  playKey: 'idle',
  bubble: null,
  size: 'm',
  atlas: { url: 'pet-asset://pet/petdex%3Alando?v=0', rows: 9, scale: 1 },
  second: null,
  box: {
    width: 144,
    height: 156,
    spriteLeft: 0,
    spriteTop: 0,
    spriteWidth: 144,
    spriteHeight: 156,
    bubble: null,
    second: null
  },
  ...over
});

describe('pet page — "z z" while sleeping', () => {
  test('hidden by default and for payloads without the field', () => {
    const page = loadPage();
    expect(page.zzz).toBeTruthy();
    expect(page.zzz.textContent).toBe('z z');
    expect(page.zzz.getAttribute('aria-hidden')).toBe('true');
    expect(page.zzz.hidden).toBe(true);
    page.render(payload());
    expect(page.zzz.hidden).toBe(true);
    expect(page.pet.classList.contains('animate')).toBe(true);
    expect(page.pet.getAttribute('aria-label')).toBe('Desktop pet');
  });

  test('sleeping: mark beside the head, still sprite; waking hides it', () => {
    const page = loadPage();
    page.render(payload());
    page.render(payload({ still: true, sleeping: true, playKey: 'sleeping' }));
    expect(page.zzz.hidden).toBe(false);
    expect(page.pet.classList.contains('animate')).toBe(false);
    expect(page.pet.getAttribute('aria-label')).toBe('Desktop pet, asleep');
    // Upper right of the 144×156 frame, sized with the sprite.
    expect(page.zzz.style.getPropertyValue('--zzz-left')).toBe('92px');
    expect(page.zzz.style.getPropertyValue('--zzz-top')).toBe('12px');
    expect(page.zzz.style.getPropertyValue('--zzz-size')).toBe('16px');

    page.render(payload({ state: 'waving', once: true, playKey: 'hover:1' }));
    expect(page.zzz.hidden).toBe(true);
    expect(page.pet.classList.contains('animate')).toBe(true);
    expect(page.pet.getAttribute('aria-label')).toBe('Desktop pet');
  });

  test('follows the sprite inside a taller window (bubble below / offsets)', () => {
    const page = loadPage();
    page.render(
      payload({
        still: true,
        sleeping: true,
        box: {
          width: 240,
          height: 260,
          spriteLeft: 48,
          spriteTop: 104,
          spriteWidth: 96,
          spriteHeight: 104,
          bubble: null,
          second: null
        }
      })
    );
    expect(page.zzz.style.getPropertyValue('--zzz-left')).toBe('109px');
    expect(page.zzz.style.getPropertyValue('--zzz-top')).toBe('112px');
    expect(page.zzz.style.getPropertyValue('--zzz-size')).toBe('10px');
  });
});

describe('pet page — "z z" beside the answer badge (3b)', () => {
  const num = (value) => Number.parseFloat(value);

  test('the mark and the badge never overlap (sizes s / m / l)', () => {
    for (const scale of [0.5, 0.75, 1]) {
      const page = loadPage();
      const w = Math.round(192 * scale);
      const h = Math.round(208 * scale);
      page.render(
        payload({
          still: true,
          sleeping: true,
          playKey: 'sleeping',
          badge: { kind: 'answer', label: 'Answer ready' },
          box: {
            width: w,
            height: h,
            spriteLeft: 0,
            spriteTop: 0,
            spriteWidth: w,
            spriteHeight: h,
            bubble: null,
            second: null
          }
        })
      );
      const z = page.zzz.style;
      const size = num(z.getPropertyValue('--zzz-size'));
      // "z z": 3 glyphs + letter spacing + italic overhang < 2 em; the
      // float moves it 4 px up and 2 px down (pet.css zzz-float).
      const mark = {
        left: num(z.getPropertyValue('--zzz-left')),
        right: num(z.getPropertyValue('--zzz-left')) + 2 * size,
        top: num(z.getPropertyValue('--zzz-top')) - 4,
        bottom: num(z.getPropertyValue('--zzz-top')) + size + 2
      };
      const b = page.badge.style;
      const dot = {
        left: num(b.getPropertyValue('--badge-left')),
        right: num(b.getPropertyValue('--badge-left')) + 14,
        top: num(b.getPropertyValue('--badge-top')),
        bottom: num(b.getPropertyValue('--badge-top')) + 14
      };
      expect(page.zzz.hidden).toBe(false);
      expect(page.badge.hidden).toBe(false);
      const apart =
        mark.right <= dot.left ||
        dot.right <= mark.left ||
        mark.bottom <= dot.top ||
        dot.bottom <= mark.top;
      expect({ scale, mark, dot, apart }).toMatchObject({ apart: true });
    }
  });
});

describe('pet.css — "z z" mark', () => {
  const css = readFileSync(PET_CSS, 'utf8');

  test('floats, never takes the pointer, and stands still for reduced motion', () => {
    expect(css).toMatch(/#zzz\s*\{[^}]*animation:\s*zzz-float/);
    expect(css).toMatch(/#zzz\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*#zzz\s*\{\s*animation:\s*none;/
    );
    expect(css).toMatch(/#zzz\[hidden\]\s*\{\s*display:\s*none;/);
  });

  test('hex colours only', () => {
    const block = css.slice(css.indexOf('#zzz {'));
    expect(block).not.toMatch(/oklch|rgb\(|hsl\(/);
  });
});
