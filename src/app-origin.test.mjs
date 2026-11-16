import { describe, expect, it } from 'bun:test';
import { appOriginsFor, isAppOrigin } from './app-origin.mjs';
import { isTrustedAppSender } from './ipc.mjs';
import { askNavigation } from './pets/ask-window.mjs';

describe('app origins around the host switch', () => {
  it('trusts both production hosts for either production URL', () => {
    const both = [
      'https://tracinginsights.com',
      'https://app.tracinginsights.com'
    ];
    expect(appOriginsFor('https://app.tracinginsights.com')).toEqual(both);
    expect(appOriginsFor('https://tracinginsights.com/')).toEqual(both);
  });

  it('trusts only a dev server itself', () => {
    expect(appOriginsFor('http://localhost:5173')).toEqual([
      'http://localhost:5173'
    ]);
  });

  it('accepts one origin or the list', () => {
    const origins = appOriginsFor('https://app.tracinginsights.com');
    expect(isAppOrigin('https://tracinginsights.com', origins)).toBe(true);
    expect(isAppOrigin('https://ratings.tracinginsights.com', origins)).toBe(
      false
    );
    expect(isAppOrigin('https://a.test', 'https://a.test')).toBe(true);
  });

  it('keeps the IPC bridge and the ask window on the root domain', () => {
    const appOrigin = appOriginsFor('https://app.tracinginsights.com');
    const window = { webContents: {}, isDestroyed: () => false };
    const event = {
      sender: window.webContents,
      senderFrame: { url: 'https://tracinginsights.com/chat' }
    };
    expect(isTrustedAppSender(event, { mainWindow: window, appOrigin })).toBe(
      true
    );
    expect(
      askNavigation('https://tracinginsights.com/stats', appOrigin)
    ).toEqual({ kind: 'main', path: '/stats' });
    expect(askNavigation('https://evil.example/stats', appOrigin).kind).toBe(
      'outside'
    );
  });

  it('keeps links and redirects to app. in the app when it loads the root domain', () => {
    const appOrigin = appOriginsFor('https://tracinginsights.com');
    const window = { webContents: {}, isDestroyed: () => false };
    const event = {
      sender: window.webContents,
      senderFrame: { url: 'https://app.tracinginsights.com/chat' }
    };
    expect(isTrustedAppSender(event, { mainWindow: window, appOrigin })).toBe(
      true
    );
    expect(
      askNavigation('https://app.tracinginsights.com/stats', appOrigin)
    ).toEqual({ kind: 'main', path: '/stats' });
    expect(
      askNavigation('https://app.tracinginsights.com.evil.com/', appOrigin).kind
    ).toBe('outside');
  });
});
