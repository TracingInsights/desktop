import { describe, expect, test } from 'bun:test';
import { mergeUpdateInfo } from './linux-release.mjs';

const appImage = {
  version: '0.2.4',
  files: [
    {
      url: 'TracingInsights-linux.AppImage',
      sha512: 'a',
      size: 3,
      blockMapSize: 1
    }
  ],
  path: 'TracingInsights-linux.AppImage',
  sha512: 'a',
  releaseDate: '2026-11-24T10:00:00.000Z'
};
const deb = {
  version: '0.2.4',
  files: [{ url: 'TracingInsights-linux.deb', sha512: 'd', size: 2 }],
  path: 'TracingInsights-linux.deb',
  sha512: 'd',
  releaseDate: '2026-11-24T10:05:00.000Z'
};
const rpm = {
  version: '0.2.4',
  files: [{ url: 'TracingInsights-linux.rpm', sha512: 'r', size: 2 }],
  path: 'TracingInsights-linux.rpm',
  sha512: 'r',
  releaseDate: '2026-11-24T10:09:00.000Z'
};

describe('mergeUpdateInfo', () => {
  test('lists every package; path / sha512 stay on the AppImage', () => {
    const merged = mergeUpdateInfo([appImage, deb, rpm]);
    expect(merged.files.map((f) => f.url)).toEqual([
      'TracingInsights-linux.AppImage',
      'TracingInsights-linux.deb',
      'TracingInsights-linux.rpm'
    ]);
    expect(merged.path).toBe('TracingInsights-linux.AppImage');
    expect(merged.sha512).toBe('a');
    expect(merged.version).toBe('0.2.4');
    expect(merged.releaseDate).toBe('2026-11-24T10:09:00.000Z');
  });

  test('refuses mixed versions and duplicate files', () => {
    expect(() =>
      mergeUpdateInfo([appImage, { ...deb, version: '0.2.3' }])
    ).toThrow(/version/);
    expect(() => mergeUpdateInfo([appImage, appImage])).toThrow(/twice/);
  });
});
