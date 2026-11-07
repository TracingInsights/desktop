import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFacts,
  FACT_CACHE_FILE,
  FACT_RETRY_MS,
  FACT_TEXT_CHARS,
  factPath,
  factText,
  localDayKey,
  localHour,
  nextLocalHourAt,
  onThisDaySlug
} from './facts.mjs';

/** Local wall-clock time (tests stay timezone-independent). */
const local = (y, m, d, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

const NOV_06 = {
  date: 'nov-06',
  totalEvents: 8,
  headline: '1994: Japan — winner Damon Hill',
  races: [
    {
      year: 1994,
      grandPrixName: 'Japan',
      winner: { driverId: 'damon-hill', name: 'Damon Hill' }
    }
  ]
};

describe('local date helpers', () => {
  test('day key, slug and hour follow the local calendar', () => {
    const t = local(2026, 11, 6, 9, 30);
    expect(localDayKey(t)).toBe('2026-11-06');
    expect(onThisDaySlug(t)).toBe('nov-06');
    expect(localHour(t)).toBe(9);
    expect(onThisDaySlug(local(2028, 2, 29, 12))).toBe('feb-29');
    expect(onThisDaySlug(local(2026, 1, 1))).toBe('jan-01');
    expect(onThisDaySlug(local(2026, 12, 31, 23, 59))).toBe('dec-31');
    expect(localDayKey(local(2026, 1, 9))).toBe('2026-01-09');
  });

  test('nextLocalHourAt: today when ahead, else tomorrow', () => {
    expect(nextLocalHourAt(local(2026, 11, 6, 8, 59), 9)).toBe(
      local(2026, 11, 6, 9)
    );
    expect(nextLocalHourAt(local(2026, 11, 6, 9), 9)).toBe(
      local(2026, 11, 7, 9)
    );
    expect(nextLocalHourAt(local(2026, 12, 31, 23), 9)).toBe(
      local(2027, 1, 1, 9)
    );
  });
});

describe('factText', () => {
  test('the headline, prefixed', () => {
    expect(factText(NOV_06)).toBe(
      'On this day · 1994: Japan — winner Damon Hill'
    );
  });

  test('no headline / the empty-day headline → first race winner, else null', () => {
    const { headline: _drop, ...noHeadline } = NOV_06;
    expect(factText(noHeadline)).toBe(
      'On this day · 1994: Japan — winner Damon Hill'
    );
    expect(
      factText({
        ...NOV_06,
        headline: 'No events on this date in F1 history',
        races: []
      })
    ).toBeNull();
    expect(factText({ headline: '   ', races: [{ year: 'x' }] })).toBeNull();
    for (const bad of [null, 'x', [], 7]) expect(factText(bad)).toBeNull();
  });

  test('one clean line, capped with an ellipsis', () => {
    expect(factText({ headline: '1950:\nFirst\t race\u0000' })).toBe(
      'On this day · 1950: First race'
    );
    const long = factText({ headline: 'x'.repeat(400) });
    expect(long.length).toBe(FACT_TEXT_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  test('factPath opens the day page', () => {
    expect(factPath('nov-06')).toBe('/stats/on-this-day/nov-06');
  });
});

describe('createFacts', () => {
  let root;
  let calls;
  let respond;
  let clock;

  const make = () =>
    createFacts({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return respond(url);
      },
      userDataDir: root,
      appUrl: 'https://app.tracinginsights.com',
      now: () => clock,
      setTimeout: () => 0,
      clearTimeout: () => {}
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tif1ai-facts-'));
    calls = [];
    clock = local(2026, 11, 6, 9, 5);
    respond = () => new Response(JSON.stringify(NOV_06));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('fetches the local day once, caches it, tells listeners', async () => {
    const facts = make();
    let changes = 0;
    facts.onChange(() => changes++);
    expect(facts.today()).toBeNull();
    expect(facts.today()).toBeNull(); // in flight: no second request
    await facts.settled();
    expect(calls.map((c) => c.url)).toEqual([
      'https://app.tracinginsights.com/stats/data/on-this-day/nov-06.json'
    ]);
    expect(changes).toBe(1);
    expect(facts.today()).toEqual({
      day: '2026-11-06',
      slug: 'nov-06',
      text: 'On this day · 1994: Japan — winner Damon Hill',
      path: '/stats/on-this-day/nov-06'
    });
    clock = local(2026, 11, 6, 22);
    expect(facts.today()?.slug).toBe('nov-06');
    expect(calls).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(root, FACT_CACHE_FILE), 'utf8'))
    ).toEqual({
      day: '2026-11-06',
      slug: 'nov-06',
      text: 'On this day · 1994: Japan — winner Damon Hill'
    });
  });

  test('a restart on the same day reads the cache, no network', async () => {
    await (async () => {
      const facts = make();
      facts.today();
      await facts.settled();
    })();
    respond = () => {
      throw new Error('offline');
    };
    const again = make();
    expect(again.today()?.text).toContain('Damon Hill');
    expect(calls).toHaveLength(1);
  });

  test('the next local day fetches that day', async () => {
    const facts = make();
    facts.today();
    await facts.settled();
    clock = local(2026, 11, 7, 9);
    respond = () =>
      new Response(JSON.stringify({ headline: '1999: Something' }));
    expect(facts.today()).toBeNull();
    await facts.settled();
    expect(calls[1].url).toEndWith('/stats/data/on-this-day/nov-07.json');
    expect(facts.today()?.text).toBe('On this day · 1999: Something');
  });

  test('a failed fetch retries after FACT_RETRY_MS, not before', async () => {
    respond = () => new Response('down', { status: 503 });
    const facts = make();
    facts.today();
    await facts.settled();
    expect(facts.today()).toBeNull();
    await facts.settled();
    expect(calls).toHaveLength(1);
    clock += FACT_RETRY_MS;
    respond = () => new Response(JSON.stringify(NOV_06));
    expect(facts.today()).toBeNull();
    await facts.settled();
    expect(calls).toHaveLength(2);
    expect(facts.today()?.text).toContain('Japan');
  });

  test('network errors and bad bodies count as failures', async () => {
    for (const reply of [
      () => {
        throw new Error('offline');
      },
      () => new Response('{not json'),
      () =>
        new Response('x', { headers: { 'content-length': String(1 << 20) } }),
      () => new Response('x'.repeat(300 * 1024))
    ]) {
      rmSync(join(root, FACT_CACHE_FILE), { force: true });
      respond = reply;
      const facts = make();
      facts.today();
      await facts.settled();
      expect(facts.today()).toBeNull();
    }
  });

  test('404 = a quiet day: cached with no text, not refetched', async () => {
    respond = () => new Response('nope', { status: 404 });
    const facts = make();
    facts.today();
    await facts.settled();
    expect(facts.today()).toEqual({
      day: '2026-11-06',
      slug: 'nov-06',
      text: null,
      path: '/stats/on-this-day/nov-06'
    });
    clock += 2 * FACT_RETRY_MS;
    facts.today();
    expect(calls).toHaveLength(1);
  });

  test('an invalid cache file is ignored', async () => {
    writeFileSync(
      join(root, FACT_CACHE_FILE),
      JSON.stringify({ day: '2026-11-06', slug: '../x', text: 'x' })
    );
    const facts = make();
    expect(facts.today()).toBeNull();
    await facts.settled();
    expect(calls).toHaveLength(1);
  });

  test('the request times out through AbortController', async () => {
    const timers = [];
    let signal;
    const facts = createFacts({
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        );
      },
      userDataDir: root,
      appUrl: 'https://app.tracinginsights.com',
      now: () => clock,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => {},
      timeoutMs: 1234
    });
    facts.today();
    expect(timers[0].ms).toBe(1234);
    timers[0].fn();
    await facts.settled();
    expect(signal.aborted).toBe(true);
    expect(facts.today()).toBeNull();
  });
});
