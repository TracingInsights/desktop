import { describe, test, expect } from 'bun:test';
import {
  createDecodeImage,
  createMakeThumb,
  createThumbRenderer,
  isThumbDataUrl,
  readWebpSize,
  thumbGeometry
} from './images.mjs';
import { fakePng } from './data-test-helpers.mjs';

/** Synthetic WebP headers (no image data — header parsing only). */
function webpHeader(chunk, body) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write(chunk, 12, 'ascii');
  buf.writeUInt32LE(20, 16);
  Buffer.from(body).copy(buf, 20);
  return buf;
}
function vp8x(width, height, flags = 0) {
  const b = Buffer.alloc(10);
  b[0] = flags;
  b.writeUIntLE(width - 1, 4, 3);
  b.writeUIntLE(height - 1, 7, 3);
  return webpHeader('VP8X', b);
}
function vp8l(width, height) {
  const b = Buffer.alloc(5);
  b[0] = 0x2f;
  b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return webpHeader('VP8L', b);
}
function vp8(width, height) {
  const b = Buffer.alloc(10);
  b[3] = 0x9d;
  b[4] = 0x01;
  b[5] = 0x2a;
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return webpHeader('VP8 ', b);
}

describe('readWebpSize', () => {
  test('reads VP8X, VP8L and VP8 headers', () => {
    expect(readWebpSize(vp8x(1536, 1872))).toEqual({
      width: 1536,
      height: 1872
    });
    expect(readWebpSize(vp8l(1536, 2288))).toEqual({
      width: 1536,
      height: 2288
    });
    expect(readWebpSize(vp8(768, 936))).toEqual({ width: 768, height: 936 });
  });

  test('refuses animation, bad signatures and short buffers', () => {
    expect(readWebpSize(vp8x(1536, 1872, 0x02))).toBeNull();
    const badL = vp8l(10, 10);
    badL[20] = 0;
    expect(readWebpSize(badL)).toBeNull();
    const badVp8 = vp8(10, 10);
    badVp8[23] = 0;
    expect(readWebpSize(badVp8)).toBeNull();
    expect(readWebpSize(webpHeader('ALPH', []))).toBeNull();
    expect(readWebpSize(Buffer.alloc(8))).toBeNull();
  });
});

function fakeNativeImage({
  empty = false,
  size = { width: 1536, height: 1872 }
} = {}) {
  const ops = [];
  const image = {
    isEmpty: () => empty,
    getSize: () => size,
    crop(rect) {
      ops.push(['crop', rect]);
      return image;
    },
    resize(opts) {
      ops.push(['resize', opts]);
      return image;
    },
    toDataURL: () => 'data:image/png;base64,AAAA'
  };
  return { ops, createFromBuffer: () => image };
}

describe('createDecodeImage', () => {
  test('PNG through nativeImage, WebP from the header', () => {
    const decode = createDecodeImage(fakeNativeImage());
    expect(decode(fakePng(1536, 1872))).toEqual({ width: 1536, height: 1872 });
    expect(decode(vp8x(3072, 3744))).toEqual({ width: 3072, height: 3744 });
    expect(decode(Buffer.from('GIF89a......'))).toBeNull();
  });

  test('an undecodable PNG is null', () => {
    expect(
      createDecodeImage(fakeNativeImage({ empty: true }))(fakePng(1, 1))
    ).toBeNull();
  });
});

describe('createMakeThumb', () => {
  test('crops idle frame 0 at scale 1 without resizing', () => {
    const ni = fakeNativeImage();
    expect(createMakeThumb(ni)(fakePng(1536, 1872), { scale: 1 })).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(ni.ops).toEqual([['crop', { x: 0, y: 0, width: 192, height: 208 }]]);
  });

  test('scales a 2× atlas down to 192×208', () => {
    const ni = fakeNativeImage();
    createMakeThumb(ni)(fakePng(3072, 3744), { scale: 2 });
    expect(ni.ops).toEqual([
      ['crop', { x: 0, y: 0, width: 384, height: 416 }],
      ['resize', { width: 192, height: 208, quality: 'good' }]
    ]);
  });

  test('WebP returns an empty thumb (filled asynchronously)', () => {
    expect(
      createMakeThumb(fakeNativeImage())(vp8x(1536, 1872), { scale: 1 })
    ).toBe('');
  });

  test('half-scale atlas keeps its own size', () => {
    expect(thumbGeometry({ scale: 0.5 })).toEqual({
      sw: 96,
      sh: 104,
      dw: 96,
      dh: 104
    });
  });
});

describe('isThumbDataUrl', () => {
  test('accepts PNG data URLs only', () => {
    expect(isThumbDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isThumbDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isThumbDataUrl('data:image/png;base64,<script>')).toBe(false);
    expect(isThumbDataUrl(42)).toBe(false);
  });
});

describe('createThumbRenderer', () => {
  function setup({ result = 'data:image/png;base64,QUJD', fail = false } = {}) {
    const windows = [];
    const timers = new Map();
    let seq = 0;
    const renderer = createThumbRenderer({
      createWindow() {
        const win = {
          codes: [],
          destroyed: false,
          loadURL: async (url) => {
            win.url = url;
          },
          isDestroyed: () => win.destroyed,
          destroy: () => {
            win.destroyed = true;
          },
          webContents: {
            executeJavaScript: async (code) => {
              win.codes.push(code);
              if (fail) throw new Error('decode failed');
              return result;
            }
          }
        };
        windows.push(win);
        return win;
      },
      readFile: async (path) =>
        path === '/p/sprite.webp' ? vp8x(1536, 1872) : fakePng(1, 1),
      setTimeout: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id)
    });
    const fireIdle = () => {
      for (const [id, t] of timers) {
        if (t.ms === 20_000) {
          timers.delete(id);
          t.fn();
        }
      }
    };
    return { renderer, windows, fireIdle };
  }
  const record = { imagePath: '/p/sprite.webp', atlas: { scale: 1 } };

  test('renders WebP frame 0 in a hidden about:blank window and caches it', async () => {
    const { renderer, windows } = setup();
    expect(await renderer.thumbFor(record)).toBe('data:image/png;base64,QUJD');
    expect(windows.length).toBe(1);
    expect(windows[0].url).toBe('about:blank');
    expect(windows[0].codes[0]).toContain('"sw":192');
    expect(windows[0].codes[0]).toContain('data:image/webp;base64,');
    expect(await renderer.thumbFor(record)).toBe('data:image/png;base64,QUJD');
    expect(windows[0].codes.length).toBe(1);
  });

  test('the window is destroyed after the idle delay', async () => {
    const { renderer, windows, fireIdle } = setup();
    await renderer.thumbFor(record);
    fireIdle();
    expect(windows[0].destroyed).toBe(true);
  });

  test('PNG pets, missing records and bad results give ""', async () => {
    const { renderer } = setup({ result: '<svg>' });
    expect(
      await renderer.thumbFor({ imagePath: '/p/sprite.png', atlas: {} })
    ).toBe('');
    expect(await renderer.thumbFor(null)).toBe('');
    expect(await renderer.thumbFor(record)).toBe('');
  });

  test('a renderer failure disposes the window and resolves ""', async () => {
    const { renderer, windows } = setup({ fail: true });
    expect(await renderer.thumbFor(record)).toBe('');
    expect(windows[0].destroyed).toBe(true);
  });
});
