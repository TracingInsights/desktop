import { describe, test, expect } from 'bun:test';
import {
  AMBIENT_WAITING_MS,
  canStartMoment,
  computeBehaviour,
  driverFirstName,
  driverSurname,
  duoHeadToHead,
  HOVER_BUBBLE_MS,
  latestRaceStartMs,
  nextRateNudgeAt,
  rateMoment,
  resultMoment,
  stateDurationMs
} from './behaviour.mjs';
import {
  BUBBLE_MS,
  CHAT_SIGNAL_TTL_MS,
  RESULT_REACTION_WINDOW_MS,
  SESSION_LEAD_MS
} from './contract.mjs';

const T0 = Date.parse('2026-11-22T04:00:00Z');
const race = {
  key: '2026_22_race_2026-11-22T04:00:00',
  kind: 'race',
  year: 2026,
  round: 22,
  gp: 'Las Vegas Grand Prix',
  startsAt: '2026-11-22T04:00:00Z'
};

/** Base input: ambient, nothing going on, last input just now. */
function input(overrides = {}) {
  return {
    nowMs: T0,
    interaction: null,
    reducedMotion: false,
    quietUntilMs: null,
    chatReactions: true,
    chat: null,
    sessionReactions: 'calm',
    calendar: null,
    dismissedBubbleKey: null,
    lastActivityAtMs: T0,
    onBattery: false,
    locked: false,
    ...overrides
  };
}

const live = (bubble = 'Lights out! · Las Vegas Grand Prix') => ({
  phase: 'live',
  session: race,
  nextBoundaryAt: T0 + 2 * 60 * 60 * 1000,
  bubble
});
const lead = (bubble = 'Race in 30 min · Las Vegas Grand Prix') => ({
  phase: 'lead',
  session: race,
  nextBoundaryAt: T0,
  bubble
});

describe('computeBehaviour — ambient (row 6)', () => {
  test('idle by default, next change at the waiting threshold', () => {
    const out = computeBehaviour(input());
    expect(out).toMatchObject({
      state: 'idle',
      once: false,
      still: false,
      bubble: null
    });
    expect(out.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
  });

  test('waiting loop after 10 minutes without input', () => {
    const out = computeBehaviour(
      input({ nowMs: T0 + AMBIENT_WAITING_MS, lastActivityAtMs: T0 })
    );
    expect(out.state).toBe('waiting');
    expect(out.once).toBe(false);
    expect(out.nextChangeAt).toBeNull();
  });

  test('on battery the ambient pose is a still frame', () => {
    expect(computeBehaviour(input({ onBattery: true }))).toMatchObject({
      state: 'idle',
      still: true
    });
  });

  test('a locked screen stills everything', () => {
    const out = computeBehaviour(
      input({ locked: true, chat: { signal: 'streaming', atMs: T0 } })
    );
    expect(out).toMatchObject({ state: 'running', still: true });
  });
});

describe('computeBehaviour — interaction (row 1)', () => {
  test('drag picks the running direction', () => {
    expect(
      computeBehaviour(
        input({ interaction: { kind: 'drag', direction: 'left' } })
      ).state
    ).toBe('running-left');
    expect(
      computeBehaviour(
        input({ interaction: { kind: 'drag', direction: 'right' } })
      ).state
    ).toBe('running-right');
  });

  test('click plays jumping once, then falls through', () => {
    const click = { kind: 'click', atMs: T0 };
    const during = computeBehaviour(input({ interaction: click }));
    expect(during).toMatchObject({ state: 'jumping', once: true });
    expect(during.nextChangeAt).toBe(T0 + stateDurationMs('jumping'));
    const after = computeBehaviour(
      input({ interaction: click, nowMs: T0 + stateDurationMs('jumping') })
    );
    expect(after.state).toBe('idle');
  });

  test('a second click restarts the animation (new playKey)', () => {
    const a = computeBehaviour(
      input({ interaction: { kind: 'click', atMs: T0 } })
    );
    const b = computeBehaviour(
      input({ nowMs: T0 + 100, interaction: { kind: 'click', atMs: T0 + 100 } })
    );
    expect(a.playKey).not.toBe(b.playKey);
  });

  test('hover waves once', () => {
    expect(
      computeBehaviour(input({ interaction: { kind: 'hover', atMs: T0 } }))
    ).toMatchObject({ state: 'waving', once: true });
  });

  test('beats quiet, chat and the calendar', () => {
    const out = computeBehaviour(
      input({
        interaction: { kind: 'click', atMs: T0 },
        quietUntilMs: T0 + 60_000,
        chat: { signal: 'streaming', atMs: T0 },
        calendar: live()
      })
    );
    expect(out.state).toBe('jumping');
  });

  test('reduce motion keeps the pose but stills it', () => {
    expect(
      computeBehaviour(
        input({
          reducedMotion: true,
          interaction: { kind: 'drag', direction: 'left' }
        })
      )
    ).toMatchObject({ state: 'running-left', still: true });
  });
});

describe('computeBehaviour — reduce motion (row 2)', () => {
  test('forces idle frame 0 over chat and calendar', () => {
    const out = computeBehaviour(
      input({
        reducedMotion: true,
        chat: { signal: 'streaming', atMs: T0 },
        sessionReactions: 'lively',
        calendar: live()
      })
    );
    expect(out).toMatchObject({ state: 'idle', still: true });
  });

  test('bubbles are still shown', () => {
    const out = computeBehaviour(
      input({ reducedMotion: true, calendar: live() })
    );
    expect(out.bubble?.text).toBe('Lights out! · Las Vegas Grand Prix');
  });
});

describe('computeBehaviour — quiet (row 3)', () => {
  test('idle with no bubble while quiet, over chat and calendar', () => {
    const out = computeBehaviour(
      input({
        quietUntilMs: T0 + 60_000,
        chat: { signal: 'streaming', atMs: T0 },
        calendar: live()
      })
    );
    expect(out).toMatchObject({ state: 'idle', still: false, bubble: null });
  });

  test('quiet expiry is the next change and clears itself', () => {
    const quietUntilMs = T0 + 60_000;
    const out = computeBehaviour(
      input({ quietUntilMs, chat: { signal: 'streaming', atMs: T0 } })
    );
    expect(out.nextChangeAt).toBe(quietUntilMs);
    const after = computeBehaviour(
      input({
        nowMs: quietUntilMs,
        quietUntilMs,
        lastActivityAtMs: quietUntilMs,
        chat: { signal: 'streaming', atMs: quietUntilMs - 1000 }
      })
    );
    expect(after.state).toBe('running');
  });

  test('a past quietUntil is ignored', () => {
    const out = computeBehaviour(
      input({ quietUntilMs: T0 - 1, chat: { signal: 'streaming', atMs: T0 } })
    );
    expect(out.state).toBe('running');
  });
});

describe('computeBehaviour — chat activity (row 4)', () => {
  const cases = [
    ['planning', 'running', false],
    ['streaming', 'running', false],
    ['needs-choice', 'waiting', false],
    ['review-open', 'review', false],
    ['done', 'jumping', true],
    ['error', 'failed', true]
  ];
  for (const [signal, state, once] of cases) {
    test(`${signal} → ${state}${once ? ' once' : ''}`, () => {
      expect(
        computeBehaviour(input({ chat: { signal, atMs: T0 } }))
      ).toMatchObject({ state, once });
    });
  }

  test('idle signal clears chat activity', () => {
    expect(
      computeBehaviour(input({ chat: { signal: 'idle', atMs: T0 } })).state
    ).toBe('idle');
  });

  test('a loop signal expires after CHAT_SIGNAL_TTL_MS without refresh', () => {
    const chat = { signal: 'streaming', atMs: T0 };
    const out = computeBehaviour(input({ chat }));
    expect(out.nextChangeAt).toBe(T0 + CHAT_SIGNAL_TTL_MS);
    const expired = computeBehaviour(
      input({
        chat,
        nowMs: T0 + CHAT_SIGNAL_TTL_MS,
        lastActivityAtMs: T0 + CHAT_SIGNAL_TTL_MS
      })
    );
    expect(expired.state).toBe('idle');
  });

  test('done plays once then returns to ambient', () => {
    const chat = { signal: 'done', atMs: T0 };
    const after = computeBehaviour(
      input({ chat, nowMs: T0 + stateDurationMs('jumping') })
    );
    expect(after.state).toBe('idle');
  });

  test('chatReactions off ignores signals', () => {
    expect(
      computeBehaviour(
        input({ chatReactions: false, chat: { signal: 'streaming', atMs: T0 } })
      ).state
    ).toBe('idle');
  });

  test('chat beats the calendar', () => {
    expect(
      computeBehaviour(
        input({
          chat: { signal: 'needs-choice', atMs: T0 },
          sessionReactions: 'lively',
          calendar: live()
        })
      ).state
    ).toBe('waiting');
  });
});

describe('computeBehaviour — calendar (row 5)', () => {
  test('lead: waiting once + bubble at T−30', () => {
    const now = T0 - SESSION_LEAD_MS;
    const out = computeBehaviour(
      input({ nowMs: now, lastActivityAtMs: now, calendar: lead() })
    );
    expect(out).toMatchObject({ state: 'waiting', once: true });
    expect(out.bubble).toEqual({
      key: `${race.key}:lead`,
      kind: 'calendar',
      text: 'Race in 30 min · Las Vegas Grand Prix',
      target: '/'
    });
  });

  test('lead after the once animation: ambient idle, bubble until BUBBLE_MS', () => {
    const start = T0 - SESSION_LEAD_MS;
    const now = start + stateDurationMs('waiting');
    const out = computeBehaviour(
      input({ nowMs: now, lastActivityAtMs: now, calendar: lead() })
    );
    expect(out.state).toBe('idle');
    expect(out.bubble).not.toBeNull();
    expect(out.nextChangeAt).toBe(start + BUBBLE_MS);
    const later = computeBehaviour(
      input({
        nowMs: start + BUBBLE_MS,
        lastActivityAtMs: start + BUBBLE_MS,
        calendar: lead()
      })
    );
    expect(later.bubble).toBeNull();
  });

  test('start: jumping once + "Lights out!" bubble', () => {
    const out = computeBehaviour(input({ calendar: live() }));
    expect(out).toMatchObject({ state: 'jumping', once: true });
    expect(out.bubble?.text).toBe('Lights out! · Las Vegas Grand Prix');
  });

  test('during the session: Calm → idle, Lively → running loop', () => {
    const now = T0 + 20 * 60 * 1000;
    const calm = computeBehaviour(
      input({ nowMs: now, lastActivityAtMs: now, calendar: live() })
    );
    expect(calm).toMatchObject({ state: 'idle', bubble: null });
    const lively = computeBehaviour(
      input({
        nowMs: now,
        lastActivityAtMs: now,
        sessionReactions: 'lively',
        calendar: live()
      })
    );
    expect(lively).toMatchObject({ state: 'running', once: false });
  });

  test('Off ignores the calendar entirely', () => {
    const out = computeBehaviour(
      input({ sessionReactions: 'off', calendar: live() })
    );
    expect(out).toMatchObject({ state: 'idle', bubble: null });
    expect(out.nextChangeAt).toBe(T0 + AMBIENT_WAITING_MS);
  });

  test('on battery Lively is treated as Calm', () => {
    const now = T0 + 20 * 60 * 1000;
    const out = computeBehaviour(
      input({
        nowMs: now,
        lastActivityAtMs: now,
        sessionReactions: 'lively',
        onBattery: true,
        calendar: live()
      })
    );
    expect(out).toMatchObject({ state: 'idle', still: true });
  });

  test('launching mid-session shows no start bubble or jump', () => {
    const now = T0 + 5 * 60 * 1000;
    const out = computeBehaviour(
      input({ nowMs: now, lastActivityAtMs: now, calendar: live() })
    );
    expect(out).toMatchObject({ state: 'idle', bubble: null });
  });

  test('a dismissed bubble stays hidden', () => {
    const out = computeBehaviour(
      input({ calendar: live(), dismissedBubbleKey: `${race.key}:live` })
    );
    expect(out.bubble).toBeNull();
    expect(out.state).toBe('jumping');
  });

  test('the next calendar boundary is a change point', () => {
    const now = T0 - 2 * 60 * 60 * 1000;
    const out = computeBehaviour(
      input({
        nowMs: now,
        lastActivityAtMs: now - AMBIENT_WAITING_MS,
        calendar: {
          phase: null,
          session: null,
          nextBoundaryAt: T0 - SESSION_LEAD_MS
        }
      })
    );
    expect(out.state).toBe('waiting');
    expect(out.nextChangeAt).toBe(T0 - SESSION_LEAD_MS);
  });

  test('a session with an unparseable start is ignored', () => {
    const out = computeBehaviour(
      input({ calendar: { ...live(), session: { ...race, startsAt: 'nope' } } })
    );
    expect(out).toMatchObject({ state: 'idle', bubble: null });
  });
});

// --- Round 2: bubble priority, celebrations, once-only moments ---

const hover = (atMs = T0, text = 'Race in 2 h · Las Vegas GP') => ({
  atMs,
  text,
  target: '/'
});
const party = (atMs = T0) => ({
  atMs,
  text: 'New personal best!',
  target: '/games/rwanda'
});
const momentOf = (kind, extra = {}) => ({
  kind,
  key: `${kind}-key`,
  text: `${kind} text`,
  target: `/${kind}`,
  atMs: T0,
  state: null,
  once: false,
  ...extra
});

describe('computeBehaviour — bubble priority (plan §12)', () => {
  const all = {
    hoverBubble: hover(),
    celebration: party(),
    calendar: live()
  };

  test('hover > celebrate > result > calendar > rate > fact', () => {
    const order = [
      ['hover', { ...all, moment: momentOf('result') }],
      [
        'celebrate',
        { celebration: party(), calendar: live(), moment: momentOf('result') }
      ],
      ['result', { calendar: live(), moment: momentOf('result') }],
      ['calendar', { calendar: live(), moment: momentOf('rate') }],
      ['rate', { moment: momentOf('rate') }],
      ['fact', { moment: momentOf('fact') }]
    ];
    for (const [kind, overrides] of order) {
      expect(computeBehaviour(input(overrides)).bubble?.kind).toBe(kind);
    }
  });

  test('every bubble carries its own click target', () => {
    expect(computeBehaviour(input({ hoverBubble: hover() })).bubble).toEqual({
      key: `hover:${T0}`,
      kind: 'hover',
      text: 'Race in 2 h · Las Vegas GP',
      target: '/'
    });
    expect(
      computeBehaviour(input({ celebration: party() })).bubble.target
    ).toBe('/games/rwanda');
    expect(
      computeBehaviour(input({ moment: momentOf('rate') })).bubble
    ).toEqual({
      key: 'rate:rate-key',
      kind: 'rate',
      text: 'rate text',
      target: '/rate'
    });
  });

  test('a dismissed bubble gives way to the next one', () => {
    const out = computeBehaviour(
      input({
        moment: momentOf('result'),
        calendar: live(),
        dismissedBubbleKeys: new Set(['result:result-key'])
      })
    );
    expect(out.bubble.kind).toBe('calendar');
  });

  test('quiet hides every bubble', () => {
    const out = computeBehaviour(
      input({ ...all, moment: momentOf('result'), quietUntilMs: T0 + 1000 })
    );
    expect(out.bubble).toBeNull();
    expect(out.state).toBe('idle');
  });

  test('hover bubble lasts HOVER_BUBBLE_MS, others BUBBLE_MS', () => {
    const later = (ms, o) => computeBehaviour(input({ nowMs: T0 + ms, ...o }));
    expect(
      later(HOVER_BUBBLE_MS - 1, { hoverBubble: hover() }).bubble
    ).not.toBeNull();
    expect(later(HOVER_BUBBLE_MS, { hoverBubble: hover() }).bubble).toBeNull();
    expect(
      later(BUBBLE_MS - 1, { celebration: party() }).bubble
    ).not.toBeNull();
    expect(later(BUBBLE_MS, { celebration: party() }).bubble).toBeNull();
    expect(
      later(BUBBLE_MS - 1, { moment: momentOf('fact') }).bubble
    ).not.toBeNull();
    expect(later(BUBBLE_MS, { moment: momentOf('fact') }).bubble).toBeNull();
    expect(computeBehaviour(input({ hoverBubble: hover() })).nextChangeAt).toBe(
      T0 + HOVER_BUBBLE_MS
    );
  });

  test('a bubble from the future (clock skew) is not shown', () => {
    expect(
      computeBehaviour(input({ celebration: party(T0 + 5000) })).bubble
    ).toBeNull();
  });
});

describe('computeBehaviour — celebration (row 4)', () => {
  test('jumping once, then back; the bubble stays', () => {
    const out = computeBehaviour(input({ celebration: party() }));
    expect(out).toMatchObject({
      state: 'jumping',
      once: true,
      layer: 'celebrate',
      playKey: `celebrate:${T0}`
    });
    expect(out.nextChangeAt).toBe(T0 + stateDurationMs('jumping'));
    const after = computeBehaviour(
      input({ celebration: party(), nowMs: T0 + stateDurationMs('jumping') })
    );
    expect(after.state).toBe('idle');
    expect(after.bubble?.kind).toBe('celebrate');
  });

  test('over chat, under a user interaction', () => {
    expect(
      computeBehaviour(
        input({ celebration: party(), chat: { signal: 'streaming', atMs: T0 } })
      ).state
    ).toBe('jumping');
    expect(
      computeBehaviour(
        input({
          celebration: party(),
          interaction: { kind: 'drag', direction: 'left' }
        })
      ).state
    ).toBe('running-left');
  });

  test('reduce motion: idle still frame, bubble shown, layer kept', () => {
    const out = computeBehaviour(
      input({ celebration: party(), reducedMotion: true })
    );
    expect(out).toMatchObject({
      state: 'idle',
      still: true,
      once: false,
      layer: 'celebrate'
    });
    expect(out.bubble?.kind).toBe('celebrate');
  });
});

describe('computeBehaviour — result moment pose (row 6)', () => {
  test('a once pose plays once, then the bubble stays alone', () => {
    const m = momentOf('result', { state: 'failed', once: true });
    const out = computeBehaviour(input({ moment: m }));
    expect(out).toMatchObject({ state: 'failed', once: true, layer: 'moment' });
    const after = computeBehaviour(
      input({ moment: m, nowMs: T0 + stateDurationMs('failed') })
    );
    expect(after).toMatchObject({ state: 'idle', layer: 'ambient' });
    expect(after.bubble?.kind).toBe('result');
  });

  test('a held idle pose lasts the bubble (over the Lively loop)', () => {
    const m = momentOf('result', { state: 'idle', once: false });
    const o = { moment: m, calendar: live(), sessionReactions: 'lively' };
    expect(
      computeBehaviour(input({ ...o, nowMs: T0 + BUBBLE_MS - 1 }))
    ).toMatchObject({ state: 'idle', layer: 'moment' });
    expect(computeBehaviour(input({ ...o, nowMs: T0 + BUBBLE_MS })).state).toBe(
      'running'
    );
  });

  test('no pose: the bubble only', () => {
    const out = computeBehaviour(input({ moment: momentOf('result') }));
    expect(out).toMatchObject({ state: 'idle', layer: 'ambient' });
    expect(out.bubble?.kind).toBe('result');
  });

  test('chat activity wins over the result pose', () => {
    const out = computeBehaviour(
      input({
        moment: momentOf('result', { state: 'jumping', once: true }),
        chat: { signal: 'planning', atMs: T0 }
      })
    );
    expect(out.state).toBe('running');
    expect(out.bubble?.kind).toBe('result');
  });
});

describe('canStartMoment', () => {
  const ambient = computeBehaviour(input());
  test('an idle pet with no bubble takes any moment', () => {
    for (const kind of ['result', 'rate', 'fact']) {
      expect(canStartMoment(kind, ambient)).toBe(true);
    }
  });

  test('a result may push aside a calendar bubble; rate / fact wait', () => {
    const calendar = computeBehaviour(input({ calendar: live() }));
    expect(calendar.bubble?.kind).toBe('calendar');
    expect(canStartMoment('result', calendar)).toBe(true);
    expect(canStartMoment('rate', calendar)).toBe(false);
    expect(canStartMoment('fact', calendar)).toBe(false);
  });

  test('never over an interaction, celebration, chat or a higher bubble', () => {
    for (const o of [
      { interaction: { kind: 'click', atMs: T0 } },
      { interaction: { kind: 'drag', direction: 'right' } },
      { celebration: party() },
      { chat: { signal: 'streaming', atMs: T0 } },
      { hoverBubble: hover() },
      { celebration: party(T0 - 2000) } // bubble only, pose done
    ]) {
      const out = computeBehaviour(input(o));
      for (const kind of ['result', 'rate', 'fact']) {
        expect(canStartMoment(kind, out)).toBe(false);
      }
    }
  });

  test('reduce motion keeps the layer, so a busy pet still counts as busy', () => {
    const out = computeBehaviour(
      input({ reducedMotion: true, chat: { signal: 'streaming', atMs: T0 } })
    );
    expect(out.state).toBe('idle');
    expect(canStartMoment('fact', out)).toBe(false);
    expect(
      canStartMoment('fact', computeBehaviour(input({ reducedMotion: true })))
    ).toBe(true);
  });
});

// --- Pure moment builders ---

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SP = {
  key: '2026_20_race_2026-11-08T17:00',
  kind: 'race',
  year: 2026,
  round: 20,
  gp: 'São Paulo Grand Prix',
  startsAt: '2026-11-08T17:00:00Z',
  rateSlug: 'sao-paulo'
};
const SP_START = Date.parse(SP.startsAt);
const SP_END = SP_START + 2 * HOUR;
const result = (driverId, name, position, status = 'finished') => ({
  driverId,
  name,
  code: name.slice(-3).toUpperCase(),
  position,
  status
});
const feedWith = (results, extra = {}) => ({
  v: 1,
  sessions: [SP],
  season: 2026,
  latestRace: {
    key: SP.key,
    year: 2026,
    round: 20,
    gp: 'São Paulo Grand Prix',
    rateSlug: 'sao-paulo',
    grandPrixId: 'sao-paulo',
    startsAt: null,
    results
  },
  seasonResults: {},
  drivers: [],
  petDrivers: {},
  ...extra
});

describe('resultMoment', () => {
  const at = SP_END + HOUR;
  const run = (entry, opts = {}) =>
    resultMoment({
      feed: feedWith([entry]),
      favoriteDriverId: entry.driverId,
      nowMs: at,
      ...opts
    });

  test('P1 jumps: "Max wins the São Paulo GP!"', () => {
    expect(run(result('max-verstappen', 'Max Verstappen', 1))).toEqual({
      kind: 'result',
      key: SP.key,
      text: 'Max wins the São Paulo GP!',
      target: '/stats/races/2026/20/sao-paulo',
      state: 'jumping',
      once: true
    });
  });

  test('podium waves, points hold idle, the rest is bubble only', () => {
    const cases = [
      [2, 'P2 for Kimi · São Paulo GP', 'waving', true],
      [3, 'P3 for Kimi · São Paulo GP', 'waving', true],
      [4, 'P4 for Kimi · São Paulo GP', 'idle', false],
      [10, 'P10 for Kimi · São Paulo GP', 'idle', false],
      [11, 'P11 for Kimi · São Paulo GP', null, false],
      [20, 'P20 for Kimi · São Paulo GP', null, false]
    ];
    for (const [position, text, state, once] of cases) {
      expect(
        run(result('kimi-antonelli', 'Kimi Antonelli', position))
      ).toMatchObject({ text, state, once });
    }
  });

  test('DNF / DSQ play failed; DNS / NC / DNQ are bubble only', () => {
    const cases = [
      ['dnf', 'DNF for Max · São Paulo GP', 'failed', true],
      ['dsq', 'DSQ for Max · São Paulo GP', 'failed', true],
      ['dns', 'DNS for Max · São Paulo GP', null, false],
      ['nc', 'NC for Max · São Paulo GP', null, false],
      ['dnq', 'DNQ for Max · São Paulo GP', null, false]
    ];
    for (const [status, text, state, once] of cases) {
      expect(
        run(result('max-verstappen', 'Max Verstappen', null, status))
      ).toMatchObject({ text, state, once });
    }
    expect(
      run(result('max-verstappen', 'Max Verstappen', null, 'finished'))
    ).toBeNull();
    expect(
      run(result('max-verstappen', 'Max Verstappen', null, null))
    ).toBeNull();
  });

  test('no favourite, or the favourite not in the race → null', () => {
    const feed = feedWith([result('max-verstappen', 'Max Verstappen', 1)]);
    expect(
      resultMoment({ feed, favoriteDriverId: null, nowMs: at })
    ).toBeNull();
    expect(
      resultMoment({ feed, favoriteDriverId: 'lando-norris', nowMs: at })
    ).toBeNull();
    expect(
      resultMoment({
        feed: null,
        favoriteDriverId: 'max-verstappen',
        nowMs: at
      })
    ).toBeNull();
  });

  test('only within RESULT_REACTION_WINDOW_MS of the nominal race end', () => {
    const entry = result('max-verstappen', 'Max Verstappen', 1);
    expect(run(entry, { nowMs: SP_START - 1 })).toBeNull();
    expect(run(entry, { nowMs: SP_START })).not.toBeNull();
    expect(
      run(entry, { nowMs: SP_END + RESULT_REACTION_WINDOW_MS - 1 })
    ).not.toBeNull();
    expect(
      run(entry, { nowMs: SP_END + RESULT_REACTION_WINDOW_MS })
    ).toBeNull();
  });

  test('race timing: session by key, else by year + round, else latestRace.startsAt, else none', () => {
    const entry = result('max-verstappen', 'Max Verstappen', 1);
    const base = feedWith([entry]);
    const byRound = {
      ...base,
      sessions: [{ ...SP, key: 'other-key' }]
    };
    expect(latestRaceStartMs(base)).toBe(SP_START);
    expect(latestRaceStartMs(byRound)).toBe(SP_START);
    const fromRace = {
      ...base,
      sessions: [],
      latestRace: { ...base.latestRace, startsAt: '2026-11-08T18:00:00Z' }
    };
    expect(latestRaceStartMs(fromRace)).toBe(SP_START + HOUR);
    const unknown = { ...base, sessions: [] };
    expect(latestRaceStartMs(unknown)).toBeNull();
    expect(
      resultMoment({
        feed: unknown,
        favoriteDriverId: entry.driverId,
        nowMs: at
      })
    ).toBeNull();
  });

  test('without grandPrixId the click opens the season races; name fallbacks', () => {
    const feed = feedWith([
      {
        driverId: 'x-y',
        name: 'Zhou',
        code: 'ZHO',
        position: 1,
        status: 'finished'
      }
    ]);
    feed.latestRace.grandPrixId = null;
    expect(
      resultMoment({ feed, favoriteDriverId: 'x-y', nowMs: at })
    ).toMatchObject({
      text: 'Zhou wins the São Paulo GP!',
      target: '/stats/races/2026'
    });
  });
});

describe('rateMoment / nextRateNudgeAt', () => {
  const feed = feedWith([]);
  test('from nominal end + 1 h until end + 2 days', () => {
    expect(rateMoment({ feed, nowMs: SP_END + HOUR - 1 })).toBeNull();
    expect(rateMoment({ feed, nowMs: SP_END + HOUR })).toEqual({
      kind: 'rate',
      key: SP.key,
      text: 'Rate the São Paulo GP',
      target: '/rate/2026/sao-paulo/race',
      state: null,
      once: false
    });
    expect(rateMoment({ feed, nowMs: SP_END + 2 * DAY - 1 })).not.toBeNull();
    expect(rateMoment({ feed, nowMs: SP_END + 2 * DAY })).toBeNull();
  });

  test('the most recent eligible race wins; no rate slug or non-race → skipped', () => {
    const earlier = {
      ...SP,
      key: 'early',
      round: 19,
      gp: 'Mexican Grand Prix',
      startsAt: '2026-11-07T17:00:00Z',
      rateSlug: 'mexico'
    };
    const noSlug = { ...SP, key: 'noslug', startsAt: '2026-11-08T18:00:00Z' };
    delete noSlug.rateSlug;
    const quali = { ...SP, key: 'q', kind: 'qualifying' };
    const f = { ...feed, sessions: [earlier, SP, noSlug, quali] };
    expect(rateMoment({ feed: f, nowMs: SP_END + 2 * HOUR })?.key).toBe(SP.key);
    expect(rateMoment({ feed: f, nowMs: SP_END }).key).toBe('early');
  });

  test('nextRateNudgeAt: the next end + 1 h ahead, else null', () => {
    expect(nextRateNudgeAt({ feed, nowMs: SP_START })).toBe(SP_END + HOUR);
    expect(nextRateNudgeAt({ feed, nowMs: SP_END + HOUR })).toBeNull();
    expect(nextRateNudgeAt({ feed: null, nowMs: 0 })).toBeNull();
  });
});

describe('duoHeadToHead', () => {
  const feed = {
    ...feedWith([]),
    season: 2026,
    petDrivers: {
      'max-4': 'max-verstappen',
      lando: 'lando-norris',
      senna: 'ayrton-senna',
      'senna-sprint': 'ayrton-senna'
    },
    seasonResults: {
      'max-verstappen': [1, 2, null, 5, 1, 3],
      'lando-norris': [2, 1, 4, null, 3, 3]
    },
    drivers: [
      { id: 'lando-norris', name: 'Lando Norris', code: 'NOR' },
      { id: 'max-verstappen', name: 'Max Verstappen', code: 'VER' }
    ]
  };

  test('races where both were classified, whoever finished ahead', () => {
    // Second pet on the right: first pet's driver reads first.
    expect(
      duoHeadToHead({
        feed,
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando',
        secondSide: 'right'
      })
    ).toEqual({
      text: '2026 · Verstappen 2–1 Norris (races)',
      target:
        '/stats/compare/drivers?ids=max-verstappen,lando-norris&from=2026&to=2026'
    });
    expect(
      duoHeadToHead({
        feed,
        firstPetId: 'petdex:lando',
        secondPetId: 'petdex:max-4',
        secondSide: 'right'
      })?.text
    ).toBe('2026 · Norris 1–2 Verstappen (races)');
  });

  test('second pet on the left (the default layout): its driver reads first, with its own wins', () => {
    for (const secondSide of ['left', undefined]) {
      expect(
        duoHeadToHead({
          feed,
          firstPetId: 'petdex:max-4',
          secondPetId: 'petdex:lando',
          secondSide
        })
      ).toEqual({
        text: '2026 · Norris 1–2 Verstappen (races)',
        target:
          '/stats/compare/drivers?ids=lando-norris,max-verstappen&from=2026&to=2026'
      });
    }
    expect(
      duoHeadToHead({
        feed,
        firstPetId: 'petdex:lando',
        secondPetId: 'petdex:max-4',
        secondSide: 'left'
      })?.text
    ).toBe('2026 · Verstappen 2–1 Norris (races)');
  });

  test('null unless both pets map to different drivers with results', () => {
    for (const [a, b] of [
      ['petdex:max-4', 'petdex:pia'],
      ['petdex:max-4', 'codex:lando'],
      ['import:x', 'petdex:lando'],
      ['petdex:senna', 'petdex:senna-sprint'],
      ['petdex:max-4', 'petdex:senna'],
      ['petdex:max-4', null]
    ]) {
      expect(duoHeadToHead({ feed, firstPetId: a, secondPetId: b })).toBeNull();
    }
    expect(
      duoHeadToHead({
        feed: {
          ...feed,
          seasonResults: { 'max-verstappen': [null], 'lando-norris': [1] }
        },
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando'
      })
    ).toBeNull();
    expect(
      duoHeadToHead({
        feed: null,
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando'
      })
    ).toBeNull();
  });

  test('names fall back to results, then code, then id; no season → no prefix', () => {
    const f = { ...feed, season: null, drivers: [] };
    f.latestRace = {
      ...f.latestRace,
      results: [result('max-verstappen', 'Max Verstappen', 1)]
    };
    expect(
      duoHeadToHead({
        feed: f,
        firstPetId: 'petdex:max-4',
        secondPetId: 'petdex:lando',
        secondSide: 'right'
      })
    ).toEqual({
      text: 'Verstappen 2–1 lando-norris (races)',
      target: '/stats/compare/drivers?ids=max-verstappen,lando-norris'
    });
  });

  test('driver name helpers', () => {
    expect(driverFirstName('Max Verstappen')).toBe('Max');
    expect(driverFirstName('Kimi Antonelli')).toBe('Kimi');
    expect(driverSurname('Max Verstappen')).toBe('Verstappen');
    expect(driverSurname('Carlos Sainz Jr.')).toBe('Sainz Jr.');
    expect(driverSurname('Zhou')).toBe('Zhou');
  });
});
