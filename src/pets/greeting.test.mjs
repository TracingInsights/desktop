/**
 * Race-weekend greetings (round 3, 4c): day parts, the 36 h window, the
 * text per case, local-time formatting per locale (time zone and locale
 * injected, so the machine's own clock never matters) and the settings /
 * native-state plumbing of the `greetings` toggle + `lastGreetingKey` marker.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dayPartAt,
  formatLocalTime,
  GREETING_TEXT_CHARS,
  GREETING_WINDOW_MS,
  greetingKey,
  greetingMoment,
  localDateKey,
  nextDayPartStartAt,
  nextGreetingCheckAt
} from './greeting.mjs';
import { BUBBLE_KINDS, bubbleRank } from './behaviour.mjs';
import { DEFAULT_SETTINGS, PAGE_WRITABLE_SETTINGS } from './contract.mjs';
import {
  createPetsSettings,
  MARKER_SETTINGS,
  normaliseSettings,
  readSettingsSync,
  validatePagePatch
} from './settings.mjs';
import { parseNativeState } from './native-state.mjs';
import { NATIVE_STATE_VERSION } from './native-protocol.mjs';

const SP = 'America/Sao_Paulo'; // UTC−3, no DST
const LA = 'America/Los_Angeles'; // PST (UTC−8) in late November
const LONDON = 'Europe/London';
const GB = { locale: 'en-GB' };
const US = { locale: 'en-US' };
/** "2026-11-08T09:00" São Paulo wall clock → ms. */
const sp = (local) => Date.parse(`${local}:00-03:00`);
const la = (local) => Date.parse(`${local}:00-08:00`);

/** A São Paulo sprint weekend, all times São Paulo local (UTC−3). */
const SP_WEEKEND = [
  {
    key: 'sq',
    kind: 'sprint-qualifying',
    gp: 'São Paulo Grand Prix',
    startsAt: '2026-11-06T18:30:00Z' // Fri 15:30
  },
  {
    key: 'sprint',
    kind: 'sprint',
    gp: 'São Paulo Grand Prix',
    startsAt: '2026-11-07T14:00:00Z' // Sat 11:00
  },
  {
    key: 'quali',
    kind: 'qualifying',
    gp: 'São Paulo Grand Prix',
    startsAt: '2026-11-07T18:00:00Z' // Sat 15:00
  },
  {
    key: 'race',
    kind: 'race',
    gp: 'São Paulo Grand Prix',
    startsAt: '2026-11-08T17:00:00Z' // Sun 14:00
  }
];
/** Las Vegas: quali Fri 20:00, race Sat 20:00 (Los Angeles local). */
const LV_WEEKEND = [
  {
    key: 'lv-quali',
    kind: 'qualifying',
    gp: 'Las Vegas Grand Prix',
    startsAt: '2026-11-21T04:00:00Z'
  },
  {
    key: 'lv-race',
    kind: 'race',
    gp: 'Las Vegas Grand Prix',
    startsAt: '2026-11-22T04:00:00Z'
  }
];
const ABU_DHABI_RACE = {
  key: 'ad-race',
  kind: 'race',
  gp: 'Abu Dhabi Grand Prix',
  startsAt: '2026-12-06T13:00:00Z' // 13:00 in London (GMT)
};

const greet = (sessions, nowMs, format = GB, timeZone = SP) =>
  greetingMoment({ sessions, nowMs, timeZone, ...format });

describe('day parts (local clock)', () => {
  test('morning 06:00–11:59, evening 17:00–22:59, nothing else', () => {
    const cases = [
      ['00:30', null],
      ['05:59', null],
      ['06:00', 'morning'],
      ['11:59', 'morning'],
      ['12:00', null],
      ['16:59', null],
      ['17:00', 'evening'],
      ['22:59', 'evening'],
      ['23:00', null]
    ];
    for (const [hm, part] of cases) {
      expect([hm, dayPartAt(sp(`2026-11-08T${hm}`), SP)]).toEqual([hm, part]);
    }
  });

  test('the marker is "<local date>:<part>" — the local date, not UTC', () => {
    expect(greetingKey(sp('2026-11-08T06:00'), SP)).toBe('2026-11-08:morning');
    expect(greetingKey(sp('2026-11-08T22:59'), SP)).toBe('2026-11-08:evening');
    expect(greetingKey(sp('2026-11-08T13:00'), SP)).toBeNull();
    // 20:00 on the 20th in Los Angeles is already the 21st in UTC.
    const lvQuali = Date.parse(LV_WEEKEND[0].startsAt);
    expect(localDateKey(lvQuali, LA)).toBe('2026-11-20');
    expect(greetingKey(lvQuali, LA)).toBe('2026-11-20:evening');
  });

  test('next day-part start: strictly after, across midnight and DST', () => {
    expect(nextDayPartStartAt(sp('2026-11-08T05:00'), SP)).toBe(
      sp('2026-11-08T06:00')
    );
    expect(nextDayPartStartAt(sp('2026-11-08T06:00'), SP)).toBe(
      sp('2026-11-08T17:00')
    );
    expect(nextDayPartStartAt(sp('2026-11-08T12:30'), SP)).toBe(
      sp('2026-11-08T17:00')
    );
    expect(nextDayPartStartAt(sp('2026-11-08T23:30'), SP)).toBe(
      sp('2026-11-09T06:00')
    );
    // London clocks go back on 2026-10-25 (BST → GMT) and forward on 2026-03-29.
    expect(
      nextDayPartStartAt(Date.parse('2026-10-24T23:30:00+01:00'), LONDON)
    ).toBe(Date.parse('2026-10-25T06:00:00Z'));
    expect(nextDayPartStartAt(Date.parse('2026-03-28T23:00:00Z'), LONDON)).toBe(
      Date.parse('2026-03-29T06:00:00+01:00')
    );
    // Half-hour zones: India is UTC+5:30.
    expect(
      nextDayPartStartAt(Date.parse('2026-11-10T18:30:00Z'), 'Asia/Kolkata')
    ).toBe(Date.parse('2026-11-11T06:00:00+05:30'));
  });

  test('without a time zone the system clock is used', () => {
    const next = new Date(nextDayPartStartAt(Date.parse('2026-11-08T12:00Z')));
    expect([6, 17]).toContain(next.getHours());
    expect(next.getMinutes()).toBe(0);
  });
});

describe('local time per locale', () => {
  const race = Date.parse(SP_WEEKEND[3].startsAt);

  test('en-US writes 12 h, en-GB / de-DE 24 h (two-digit hours)', () => {
    expect(formatLocalTime(race, { locale: 'en-US', timeZone: SP })).toMatch(
      /^2:00\sPM$/
    );
    expect(formatLocalTime(race, { locale: 'en-GB', timeZone: SP })).toBe(
      '14:00'
    );
    expect(formatLocalTime(race, { locale: 'de-DE', timeZone: SP })).toBe(
      '14:00'
    );
    const morning = sp('2026-11-07T09:05');
    expect(formatLocalTime(morning, { locale: 'en-GB', timeZone: SP })).toBe(
      '09:05'
    );
    expect(formatLocalTime(morning, { locale: 'en-US', timeZone: SP })).toMatch(
      /^9:05\sAM$/
    );
  });

  test('the same instant in another time zone', () => {
    expect(formatLocalTime(race, { locale: 'en-GB', timeZone: LONDON })).toBe(
      '17:00'
    );
  });
});

describe('greetingMoment', () => {
  test('race day morning: "Race day! Lights out at …"', () => {
    expect(greet(SP_WEEKEND, sp('2026-11-08T09:00'))).toEqual({
      kind: 'greeting',
      key: '2026-11-08:morning',
      text: 'Race day! Lights out at 14:00 · São Paulo GP',
      target: '/',
      state: null,
      once: false
    });
    expect(greet(SP_WEEKEND, sp('2026-11-08T09:00'), US).text).toMatch(
      /^Race day! Lights out at 2:00\sPM · São Paulo GP$/
    );
  });

  test('a session later today, sprint and sprint qualifying likewise', () => {
    expect(greet(LV_WEEKEND, la('2026-11-20T09:00'), GB, LA)?.text).toBe(
      'Qualifying today at 20:00 · Las Vegas GP'
    );
    expect(greet(LV_WEEKEND, la('2026-11-20T09:00'), US, LA)?.text).toMatch(
      /^Qualifying today at 8:00\sPM · Las Vegas GP$/
    );
    // Evening part, still ahead tonight.
    expect(greet(LV_WEEKEND, la('2026-11-20T17:30'), GB, LA)?.text).toBe(
      'Qualifying today at 20:00 · Las Vegas GP'
    );
    expect(greet(SP_WEEKEND, sp('2026-11-06T09:00'))?.text).toBe(
      'Sprint qualifying today at 15:30 · São Paulo GP'
    );
    // Two sessions today and no race: the first one.
    expect(greet(SP_WEEKEND, sp('2026-11-07T07:00'))?.text).toBe(
      'Sprint today at 11:00 · São Paulo GP'
    );
  });

  test('race day with the race tonight (evening part)', () => {
    expect(greet(LV_WEEKEND, la('2026-11-21T18:00'), GB, LA)).toMatchObject({
      key: '2026-11-21:evening',
      text: 'Race day! Lights out at 20:00 · Las Vegas GP'
    });
  });

  test('the race wins over an earlier session on the same day', () => {
    const sessions = [
      {
        kind: 'sprint',
        gp: 'Test Grand Prix',
        startsAt: '2026-11-08T13:00:00Z'
      },
      { kind: 'race', gp: 'Test Grand Prix', startsAt: '2026-11-08T18:00:00Z' }
    ];
    expect(greet(sessions, sp('2026-11-08T07:00'))?.text).toBe(
      'Race day! Lights out at 15:00 · Test GP'
    );
  });

  test('tomorrow: evening part only', () => {
    const sessions = [ABU_DHABI_RACE];
    const evening = Date.parse('2026-12-05T18:00:00Z');
    expect(greet(sessions, evening, GB, LONDON)).toMatchObject({
      key: '2026-12-05:evening',
      text: 'Tomorrow: Race at 13:00 · Abu Dhabi GP'
    });
    expect(greet(sessions, evening, US, LONDON)?.text).toMatch(
      /^Tomorrow: Race at 1:00\sPM · Abu Dhabi GP$/
    );
    // The same morning: the race is tomorrow, nothing to say yet.
    expect(
      greet(sessions, Date.parse('2026-12-05T09:00:00Z'), GB, LONDON)
    ).toBeNull();
    // Sprint Saturday from Friday evening: the first session tomorrow.
    expect(greet(SP_WEEKEND, sp('2026-11-06T17:00'))?.text).toBe(
      'Tomorrow: Sprint at 11:00 · São Paulo GP'
    );
    // Saturday evening after qualifying: the race tomorrow.
    expect(greet(SP_WEEKEND, sp('2026-11-07T17:00'))?.text).toBe(
      'Tomorrow: Race at 14:00 · São Paulo GP'
    );
  });

  test('a live session: skip (the calendar bubble speaks)', () => {
    // Las Vegas qualifying is live 20:00–21:00; the race is tomorrow.
    expect(greet(LV_WEEKEND, la('2026-11-20T20:30'), GB, LA)).toBeNull();
    expect(greet(LV_WEEKEND, la('2026-11-20T21:05'), GB, LA)?.text).toBe(
      'Tomorrow: Race at 20:00 · Las Vegas GP'
    );
  });

  test('outside the day parts, or nothing within 36 h → null', () => {
    expect(greet(SP_WEEKEND, sp('2026-11-08T13:00'))).toBeNull();
    expect(greet(SP_WEEKEND, sp('2026-11-08T17:00'))).toBeNull(); // race over
    // Wednesday evening: sprint qualifying is 46.5 h away.
    expect(greet(SP_WEEKEND, sp('2026-11-04T17:00'))).toBeNull();
    // Thursday evening: it is tomorrow (22.5 h).
    expect(greet(SP_WEEKEND, sp('2026-11-05T17:00'))?.text).toBe(
      'Tomorrow: Sprint qualifying at 15:30 · São Paulo GP'
    );
    expect(greet([], sp('2026-11-08T09:00'))).toBeNull();
    expect(GREETING_WINDOW_MS).toBe(36 * 60 * 60 * 1000);
  });

  test('bad sessions are ignored', () => {
    const sessions = [
      { kind: 'race', gp: 'Bad GP', startsAt: 'not a date' },
      { kind: 'practice', gp: 'FP1 GP', startsAt: '2026-11-08T13:00:00Z' },
      SP_WEEKEND[3]
    ];
    expect(greet(sessions, sp('2026-11-08T09:00'))?.text).toBe(
      'Race day! Lights out at 14:00 · São Paulo GP'
    );
  });

  test('one plain line of at most 80 characters', () => {
    const long = {
      kind: 'sprint-qualifying',
      gp: 'Formula 1 Very Long Title Sponsor Name Grand Prix of the Desert Kingdom 2026',
      startsAt: '2026-11-08T17:00:00Z'
    };
    const text = greet([long], sp('2026-11-08T09:00'))?.text ?? '';
    expect(text.length).toBe(GREETING_TEXT_CHARS);
    expect(
      text.startsWith('Sprint qualifying today at 14:00 · Formula 1')
    ).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    for (const now of [sp('2026-11-06T09:00'), sp('2026-11-07T17:00')]) {
      expect(greet(SP_WEEKEND, now, US)?.text.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('nextGreetingCheckAt (36 h window)', () => {
  test('no session ahead → no wake-up', () => {
    expect(
      nextGreetingCheckAt({
        sessions: [],
        nowMs: sp('2026-11-02T10:00'),
        timeZone: SP
      })
    ).toBeNull();
    expect(
      nextGreetingCheckAt({
        sessions: SP_WEEKEND,
        nowMs: sp('2026-11-09T10:00'),
        timeZone: SP
      })
    ).toBeNull();
  });

  test('between weekends: the first day part within 36 h of the next session', () => {
    // Sprint qualifying Fri 15:30 − 36 h = Thu 03:30 → Thu 06:00.
    expect(
      nextGreetingCheckAt({
        sessions: SP_WEEKEND,
        nowMs: sp('2026-11-02T10:00'),
        timeZone: SP
      })
    ).toBe(sp('2026-11-05T06:00'));
  });

  test('inside the window: simply the next day part', () => {
    expect(
      nextGreetingCheckAt({
        sessions: SP_WEEKEND,
        nowMs: sp('2026-11-07T07:00'),
        timeZone: SP
      })
    ).toBe(sp('2026-11-07T17:00'));
  });
});

describe('bubble priority', () => {
  test('greeting ranks below calendar and above rate', () => {
    expect(BUBBLE_KINDS).toContain('greeting');
    expect(bubbleRank('calendar')).toBeLessThan(bubbleRank('greeting'));
    expect(bubbleRank('greeting')).toBeLessThan(bubbleRank('rate'));
    expect(bubbleRank('rate')).toBeLessThan(bubbleRank('fact'));
  });
});

describe('settings: greetings + lastGreetingKey', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tif1ai-pets-greeting-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('defaults: greetings on, no marker; only the toggle is page-writable', () => {
    expect(DEFAULT_SETTINGS.greetings).toBe(true);
    expect(DEFAULT_SETTINGS.lastGreetingKey).toBeNull();
    expect(PAGE_WRITABLE_SETTINGS).toContain('greetings');
    expect(PAGE_WRITABLE_SETTINGS).not.toContain('lastGreetingKey');
    expect(MARKER_SETTINGS).toContain('lastGreetingKey');
    expect(validatePagePatch({ greetings: false })).toEqual({
      ok: true,
      patch: { greetings: false }
    });
    expect(validatePagePatch({ greetings: 'yes' }).ok).toBe(false);
    expect(
      validatePagePatch({ lastGreetingKey: '2026-11-08:morning' }).ok
    ).toBe(false);
  });

  test('field-wise validation: invalid → default', () => {
    expect(normaliseSettings({ greetings: false }).greetings).toBe(false);
    expect(normaliseSettings({ greetings: 'no' }).greetings).toBe(true);
    for (const bad of ['2026-11-08', '2026-11-08:night', 'x', 7, '']) {
      expect(normaliseSettings({ lastGreetingKey: bad }).lastGreetingKey).toBe(
        null
      );
    }
    expect(
      normaliseSettings({ lastGreetingKey: '2026-11-08:evening' })
        .lastGreetingKey
    ).toBe('2026-11-08:evening');
  });

  test('setMarker saves a valid key (survives a re-read) and refuses others', () => {
    const settings = createPetsSettings({ userDataDir: dir });
    expect(settings.setMarker('lastGreetingKey', '2026-11-08:morning').ok).toBe(
      true
    );
    expect(settings.setMarker('lastGreetingKey', '2026-11-08').ok).toBe(false);
    expect(readSettingsSync(dir).lastGreetingKey).toBe('2026-11-08:morning');
    expect(settings.update({ greetings: false }).ok).toBe(true);
    expect(readSettingsSync(dir).greetings).toBe(false);
  });

  test('the native pet may report a shown greeting (pet-native-state.json)', () => {
    const { markers } = parseNativeState({
      v: NATIVE_STATE_VERSION,
      shownMoments: [{ name: 'lastGreetingKey', value: '2026-11-08:evening' }]
    });
    expect(markers).toEqual([
      { name: 'lastGreetingKey', value: '2026-11-08:evening' }
    ]);
  });
});
