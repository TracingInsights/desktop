import { describe, test, expect } from 'bun:test';
import {
  buildPetMenuTemplate,
  buildTrayMenuTemplate,
  createPetsTray,
  trayIconSize
} from './tray.mjs';

const state = (over = {}) => ({
  petEnabled: true,
  hasPet: true,
  supported: true,
  size: 'm',
  launchAtLogin: false,
  quietActive: false,
  sessionQuietAvailable: false,
  ...over
});

function actionsLog() {
  const log = [];
  const actions = {
    openMain: () => log.push(['openMain']),
    togglePet: () => log.push(['togglePet']),
    choosePet: () => log.push(['choosePet']),
    quiet: (k) => log.push(['quiet', k]),
    setSize: (s) => log.push(['size', s]),
    setLaunchAtLogin: (on) => log.push(['login', on]),
    quit: () => log.push(['quit'])
  };
  return { log, actions };
}

const labels = (template) => template.map((i) => i.label ?? '—');
const find = (template, label) => template.find((i) => i.label === label);

describe('tray menu', () => {
  test('items in plan order', () => {
    const { actions } = actionsLog();
    expect(labels(buildTrayMenuTemplate(state(), actions))).toEqual([
      'Open TracingInsights',
      '—',
      'Hide pet',
      'Choose pet…',
      'Quiet',
      '—',
      'Launch at login',
      '—',
      'Quit TracingInsights'
    ]);
  });

  test('a downloaded update adds Restart to update on top', () => {
    const { log, actions } = actionsLog();
    const template = buildTrayMenuTemplate(state({ updateReady: '0.2.1' }), {
      ...actions,
      installUpdate: () => log.push(['installUpdate'])
    });
    expect(labels(template).slice(0, 3)).toEqual([
      'Restart to update (0.2.1)',
      '—',
      'Open TracingInsights'
    ]);
    template[0].click();
    expect(log).toContainEqual(['installUpdate']);
  });

  test('Show/Hide follows the setting and needs a supported pet', () => {
    const { actions } = actionsLog();
    expect(
      find(
        buildTrayMenuTemplate(state({ petEnabled: false }), actions),
        'Show pet'
      )
    ).toBeDefined();
    expect(
      find(buildTrayMenuTemplate(state({ hasPet: false }), actions), 'Hide pet')
        .enabled
    ).toBe(false);
    expect(
      find(
        buildTrayMenuTemplate(state({ supported: false }), actions),
        'Hide pet'
      ).enabled
    ).toBe(false);
  });

  test('Quiet submenu enables session / off only when they apply', () => {
    const { log, actions } = actionsLog();
    const quiet = find(
      buildTrayMenuTemplate(state(), actions),
      'Quiet'
    ).submenu;
    expect(quiet.map((i) => [i.label, i.enabled ?? true])).toEqual([
      ['Until this session ends', false],
      ['For 1 hour', true],
      ['Off', false]
    ]);
    quiet[1].click();
    expect(log).toEqual([['quiet', '1h']]);
    const live = find(
      buildTrayMenuTemplate(
        state({ sessionQuietAvailable: true, quietActive: true }),
        actions
      ),
      'Quiet'
    ).submenu;
    expect(live.every((i) => i.enabled !== false)).toBe(true);
  });

  test('launch at login is a checkbox reflecting the setting', () => {
    const { log, actions } = actionsLog();
    const item = find(
      buildTrayMenuTemplate(state({ launchAtLogin: true }), actions),
      'Launch at login'
    );
    expect(item).toMatchObject({ type: 'checkbox', checked: true });
    item.click({ checked: false });
    expect(log).toEqual([['login', false]]);
  });
});

describe('pet context menu', () => {
  test('quiet, size, choose, hide, open', () => {
    const { log, actions } = actionsLog();
    const template = buildPetMenuTemplate(state({ size: 'l' }), actions);
    expect(labels(template)).toEqual([
      'Quiet until this session ends',
      'Quiet for 1 hour',
      '—',
      'Size',
      'Choose pet…',
      'Hide pet',
      '—',
      'Open TracingInsights'
    ]);
    const sizes = find(template, 'Size').submenu;
    expect(sizes.filter((i) => i.checked).map((i) => i.label)).toEqual([
      'Large'
    ]);
    sizes[0].click();
    expect(log).toEqual([['size', 's']]);
    expect(
      labels(buildPetMenuTemplate(state({ quietActive: true }), actions))
    ).toContain('Quiet off');
  });
});

describe('Ask an F1 question…', () => {
  test('tray: right after Open TracingInsights; pet menu: first', () => {
    const { log, actions } = actionsLog();
    const withAsk = { ...actions, openAsk: () => log.push(['openAsk']) };
    const tray = buildTrayMenuTemplate(state(), withAsk);
    expect(labels(tray).slice(0, 3)).toEqual([
      'Open TracingInsights',
      'Ask an F1 question…',
      '—'
    ]);
    expect(labels(tray)).toContain('Quit TracingInsights');
    const pet = buildPetMenuTemplate(state(), withAsk);
    expect(labels(pet)).toEqual([
      'Ask an F1 question…',
      '—',
      'Quiet until this session ends',
      'Quiet for 1 hour',
      '—',
      'Size',
      'Choose pet…',
      'Hide pet',
      '—',
      'Open TracingInsights'
    ]);
    find(tray, 'Ask an F1 question…').click();
    find(pet, 'Ask an F1 question…').click();
    expect(log).toEqual([['openAsk'], ['openAsk']]);
  });

  test('absent without an openAsk action', () => {
    const { actions } = actionsLog();
    expect(labels(buildTrayMenuTemplate(state(), actions))).not.toContain(
      'Ask an F1 question…'
    );
    expect(labels(buildPetMenuTemplate(state(), actions))[0]).toBe(
      'Quiet until this session ends'
    );
  });
});

describe('createPetsTray', () => {
  function fakes(platform = 'win32') {
    const trays = [];
    class Tray {
      constructor(image) {
        this.image = image;
        this.handlers = {};
        this.destroyed = false;
        trays.push(this);
      }
      setToolTip(t) {
        this.tooltip = t;
      }
      setContextMenu(menu) {
        this.menu = menu;
      }
      on(e, fn) {
        this.handlers[e] = fn;
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
    }
    const image = {
      isEmpty: () => false,
      resize: (o) => ({ resized: o, toPNG: () => Buffer.alloc(1) })
    };
    const { log, actions } = actionsLog();
    const tray = createPetsTray({
      Tray,
      Menu: { buildFromTemplate: (t) => ({ template: t }) },
      nativeImage: {
        createFromPath: () => image,
        createEmpty: () => ({ empty: true })
      },
      iconPath: '/x/icon.png',
      platform,
      getState: () => state(),
      actions
    });
    return { tray, trays, log };
  }

  test('created once with a resized icon and a menu; click opens on Windows', () => {
    const { tray, trays, log } = fakes('win32');
    tray.ensure();
    tray.ensure();
    expect(trays.length).toBe(1);
    expect(trays[0].image.resized).toEqual({
      width: 16,
      height: 16,
      quality: 'best'
    });
    expect(trays[0].tooltip).toBe('TracingInsights');
    expect(trays[0].menu.template[0].label).toBe('Open TracingInsights');
    trays[0].handlers.click();
    expect(log).toEqual([['openMain']]);
  });

  test('no click handler on Linux; destroy + ensure recreates', () => {
    const { tray, trays } = fakes('linux');
    tray.ensure();
    expect(trays[0].handlers.click).toBeUndefined();
    tray.destroy();
    expect(tray.exists()).toBe(false);
    tray.ensure();
    expect(trays.length).toBe(2);
    expect(trayIconSize('linux')).toBe(24);
  });
});
