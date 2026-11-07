import { describe, test, expect } from 'bun:test';
import {
  attachZoomKeys,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  nextZoomLevel,
  zoomActionFor
} from './zoom-keys.mjs';

const key = (over) => ({ type: 'keyDown', control: true, ...over });

describe('zoomActionFor', () => {
  test('Ctrl + "+" in every form zooms in', () => {
    // Ctrl+Shift+= ("Ctrl +"), Ctrl+= and the numpad.
    expect(zoomActionFor(key({ key: '+', code: 'Equal' }), 'linux')).toBe('in');
    expect(zoomActionFor(key({ key: '=', code: 'Equal' }), 'linux')).toBe('in');
    expect(zoomActionFor(key({ key: '+', code: 'NumpadAdd' }), 'win32')).toBe(
      'in'
    );
  });

  test('minus and zero', () => {
    expect(zoomActionFor(key({ key: '-', code: 'Minus' }), 'linux')).toBe(
      'out'
    );
    expect(
      zoomActionFor(key({ key: '-', code: 'NumpadSubtract' }), 'linux')
    ).toBe('out');
    expect(zoomActionFor(key({ key: '0', code: 'Digit0' }), 'linux')).toBe(
      'reset'
    );
    expect(zoomActionFor(key({ key: '0', code: 'Numpad0' }), 'linux')).toBe(
      'reset'
    );
  });

  test('needs Ctrl (Cmd on macOS), ignores Alt and key-up', () => {
    expect(
      zoomActionFor({ type: 'keyDown', key: '+', code: 'Equal' }, 'linux')
    ).toBeNull();
    expect(zoomActionFor(key({ key: '+', alt: true }), 'linux')).toBeNull();
    expect(zoomActionFor(key({ type: 'keyUp', key: '+' }), 'linux')).toBeNull();
    expect(zoomActionFor(key({ key: '+' }), 'darwin')).toBeNull();
    expect(
      zoomActionFor(
        { type: 'keyDown', meta: true, key: '+', code: 'Equal' },
        'darwin'
      )
    ).toBe('in');
    expect(zoomActionFor(key({ key: 'a', code: 'KeyA' }), 'linux')).toBeNull();
  });
});

describe('nextZoomLevel', () => {
  test('steps by 0.5 within bounds, reset to 0', () => {
    expect(nextZoomLevel('in', 0)).toBe(0.5);
    expect(nextZoomLevel('out', 0)).toBe(-0.5);
    expect(nextZoomLevel('in', MAX_ZOOM_LEVEL)).toBe(MAX_ZOOM_LEVEL);
    expect(nextZoomLevel('out', MIN_ZOOM_LEVEL)).toBe(MIN_ZOOM_LEVEL);
    expect(nextZoomLevel('reset', 2)).toBe(0);
  });
});

test('attachZoomKeys zooms and stops the menu from zooming again', () => {
  let handler;
  let level = 0;
  const wc = {
    on: (event, fn) => event === 'before-input-event' && (handler = fn),
    getZoomLevel: () => level,
    setZoomLevel: (next) => (level = next)
  };
  attachZoomKeys(wc, 'linux');
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    }
  };
  handler(event, key({ key: '+', code: 'Equal' }));
  expect(level).toBe(0.5);
  expect(event.prevented).toBe(true);
  const typing = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    }
  };
  handler(typing, { type: 'keyDown', key: '+', code: 'Equal' });
  expect(typing.prevented).toBe(false);
  expect(level).toBe(0.5);
});
