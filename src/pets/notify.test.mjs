import { describe, test, expect } from 'bun:test';
import { createNotifier } from './notify.mjs';

function fakeNotification({ supported = true } = {}) {
  const shown = [];
  class FakeNotification {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
    }
    on(event, fn) {
      this.handlers.set(event, fn);
    }
    show() {
      shown.push(this);
    }
    static isSupported() {
      return supported;
    }
  }
  return { FakeNotification, shown };
}

describe('createNotifier', () => {
  test('on: shows the notice with its click handler', () => {
    const { FakeNotification, shown } = fakeNotification();
    let clicked = 0;
    const notify = createNotifier({
      Notification: FakeNotification,
      getSettings: () => ({ notifications: true })
    });
    expect(
      notify({ title: 'Update ready', body: 'b', onClick: () => clicked++ })
    ).toBe('shown');
    expect(shown.map((n) => n.options)).toEqual([
      { title: 'Update ready', body: 'b' }
    ]);
    shown[0].handlers.get('click')();
    expect(clicked).toBe(1);
  });

  test('silent passes through; no click handler without onClick', () => {
    const { FakeNotification, shown } = fakeNotification();
    const notify = createNotifier({
      Notification: FakeNotification,
      getSettings: () => ({ notifications: true })
    });
    notify({ title: 't', body: 'b', silent: true });
    expect(shown[0].options).toEqual({ title: 't', body: 'b', silent: true });
    expect(shown[0].handlers.size).toBe(0);
  });

  test('off: nothing is shown', () => {
    const { FakeNotification, shown } = fakeNotification();
    let current = { notifications: false };
    const notify = createNotifier({
      Notification: FakeNotification,
      getSettings: () => current
    });
    expect(notify({ title: 't', body: 'b' })).toBe('off');
    expect(shown).toEqual([]);
    // Read on every call: turning them back on applies at once.
    current = { notifications: true };
    expect(notify({ title: 't', body: 'b' })).toBe('shown');
  });

  test('without settings (pets runtime failed) notifications stay on', () => {
    const { FakeNotification, shown } = fakeNotification();
    const notify = createNotifier({ Notification: FakeNotification });
    expect(notify({ title: 't', body: 'b' })).toBe('shown');
    expect(shown.length).toBe(1);
  });

  test('unsupported platform: nothing is shown', () => {
    const { FakeNotification, shown } = fakeNotification({ supported: false });
    const notify = createNotifier({
      Notification: FakeNotification,
      getSettings: () => ({ notifications: true })
    });
    expect(notify({ title: 't', body: 'b' })).toBe('unsupported');
    expect(shown).toEqual([]);
  });
});
