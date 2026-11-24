import { describe, expect, test } from 'bun:test';
import { selfUpdateSupport } from './update-support.mjs';

const none = () => false;

describe('selfUpdateSupport', () => {
  test('dev runs never update', () => {
    expect(
      selfUpdateSupport({
        isPackaged: false,
        platform: 'win32',
        env: {},
        resourcesPath: '/r',
        exists: none
      })
    ).toBe(false);
  });

  test('Windows installer updates; the portable exe does not', () => {
    const base = {
      isPackaged: true,
      platform: 'win32',
      resourcesPath: 'C:/r',
      exists: none
    };
    expect(selfUpdateSupport({ ...base, env: {} })).toBe(true);
    expect(
      selfUpdateSupport({
        ...base,
        env: { PORTABLE_EXECUTABLE_DIR: 'C:/Downloads' }
      })
    ).toBe(false);
  });

  test('macOS updates', () => {
    expect(
      selfUpdateSupport({
        isPackaged: true,
        platform: 'darwin',
        env: {},
        resourcesPath: '/r',
        exists: none
      })
    ).toBe(true);
  });

  test('Linux: AppImage and deb / rpm update; tar.gz and Flatpak do not', () => {
    const base = {
      isPackaged: true,
      platform: 'linux',
      resourcesPath: '/opt/TracingInsights/resources'
    };
    expect(
      selfUpdateSupport({
        ...base,
        env: { APPIMAGE: '/x.AppImage' },
        exists: none
      })
    ).toBe(true);
    const seen = [];
    const hasPackageType = (path) => {
      seen.push(path);
      return path === '/opt/TracingInsights/resources/package-type';
    };
    expect(
      selfUpdateSupport({ ...base, env: {}, exists: hasPackageType })
    ).toBe(true);
    expect(seen).toEqual(['/opt/TracingInsights/resources/package-type']);
    expect(selfUpdateSupport({ ...base, env: {}, exists: none })).toBe(false);
    expect(
      selfUpdateSupport({
        ...base,
        env: { FLATPAK_ID: 'com.tracinginsights.desktop' },
        exists: () => true
      })
    ).toBe(false);
  });
});
