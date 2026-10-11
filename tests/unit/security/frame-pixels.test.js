// Reading decoded VideoFrames on the CPU (src/tapo/worker/frame-pixels.js), and the worker using it
// instead of the canvas readback that blocked it for a minute under software GL.
import { describe, expect, it } from 'vitest';
import { cpuReadable, frameToRgba } from '../../../src/tapo/worker/frame-pixels.js';
import { stubDetect } from '../../../src/tapo/worker/stub-detector.js';
import { SecurityPipeline } from '../../../src/tapo/worker/pipeline.js';
import { fakeGraphics, flush, manualClock, render, room } from './helpers.js';

const BT601 = { y: [65.481, 128.553, 24.966], u: [-37.797, -74.203, 112], v: [112, -93.786, -18.214] };
const BT709 = { y: [46.559, 156.629, 15.812], u: [-25.664, -86.336, 112], v: [112, -101.73, -10.27] };
const dot = (k, [r, g, b]) => (k[0] * r + k[1] * g + k[2] * b) / 255;

/**
 * A VideoFrame stand-in in a YUV format (limited range), painted by `paint(u, v) → [r, g, b]`.
 * `pad` adds bytes at the end of every row (a stride wider than the picture).
 */
function yuvFrame(paint, W, H, { format = 'I420', matrix = 'bt709', pad = 0, failCopy = false } = {}) {
  const k = matrix === 'bt709' ? BT709 : BT601;
  const cw = Math.ceil(W / 2);
  const ch = Math.ceil(H / 2);
  const ys = W + pad;
  const cs = format === 'NV12' ? 2 * cw + pad : cw + pad;
  const yBytes = ys * H;
  const cBytes = cs * ch;
  const bytes = new Uint8Array(yBytes + (format === 'NV12' ? cBytes : 2 * cBytes));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) bytes[y * ys + x] = Math.round(16 + dot(k.y, paint((x + 0.5) / W, (y + 0.5) / H)));
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const rgb = paint((2 * x + 1) / W, (2 * y + 1) / H);
      const u = Math.round(128 + dot(k.u, rgb));
      const v = Math.round(128 + dot(k.v, rgb));
      if (format === 'NV12') {
        bytes[yBytes + y * cs + 2 * x] = u;
        bytes[yBytes + y * cs + 2 * x + 1] = v;
      } else {
        bytes[yBytes + y * cs + x] = u;
        bytes[yBytes + cBytes + y * cs + x] = v;
      }
    }
  }
  const layout = format === 'NV12'
    ? [{ offset: 0, stride: ys }, { offset: yBytes, stride: cs }]
    : [{ offset: 0, stride: ys }, { offset: yBytes, stride: cs }, { offset: yBytes + cBytes, stride: cs }];
  const f = frameOf(bytes, layout, { format, W, H, matrix, failCopy });
  f.paint = paint; // (what the fake canvas path draws, for the fallback)
  return f;
}

function frameOf(bytes, layout, { format, W, H, matrix = 'bt709', failCopy = false }) {
  const f = {
    format, codedWidth: W, codedHeight: H + 26, displayWidth: W, displayHeight: H, width: W, height: H, timestamp: 0, closed: false,
    visibleRect: { x: 0, y: 0, width: W, height: H }, colorSpace: { fullRange: false, matrix },
    copies: 0,
    allocationSize: () => bytes.length,
    async copyTo(dst) {
      f.copies++;
      if (failCopy) throw new Error('copyTo is not supported for this frame');
      dst.set(bytes);
      return layout.map((p) => ({ ...p }));
    },
    close() { f.closed = true; },
  };
  return f;
}

/** Mean absolute difference per channel (RGB) of two RGBA pictures. */
function meanDiff(a, b) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) s += Math.abs(a[i + c] - b[i + c]);
    n += 3;
  }
  return s / n;
}

describe('frameToRgba', () => {
  it('I420 (BT.709, limited range) → the picture, box-downscaled', async () => {
    const paint = room();
    const f = yuvFrame(paint, 320, 180);
    const rgba = await frameToRgba(f, 64, 36);
    expect(rgba).toHaveLength(64 * 36 * 4);
    expect(meanDiff(rgba, render({ paint }, 64, 36))).toBeLessThan(8);
    expect(rgba[3]).toBe(255);
  });

  it('BT.601, NV12 and a padded stride give the same picture', async () => {
    const paint = room({ offset: 0.2 });
    const want = render({ paint }, 32, 18);
    for (const o of [{ matrix: 'smpte170m' }, { format: 'NV12' }, { pad: 13 }, { format: 'NV12', pad: 7, matrix: 'bt470bg' }]) {
      expect(meanDiff(await frameToRgba(yuvFrame(paint, 160, 90, o), 32, 18), want)).toBeLessThan(8);
    }
  });

  it('the stub detector still finds the simulator\'s pure green figure', async () => {
    const paint = room({ figure: { x: 0.5, y: 0.5 } });
    const rgba = await frameToRgba(yuvFrame(paint, 640, 360), 64, 36);
    const [p] = stubDetect(rgba, 64, 36);
    expect(p).toBeTruthy();
    expect(p.box[0]).toBeGreaterThan(0.4);
    expect(p.box[0]).toBeLessThan(0.5);
  });

  it('RGBA / BGRA frames: channels in their order', async () => {
    const px = (r, g, b, a = 255) => [r, g, b, a];
    const bgra = new Uint8Array([...px(30, 20, 10), ...px(30, 20, 10), ...px(90, 80, 70), ...px(90, 80, 70)]); // B, G, R, A
    const f = frameOf(bgra, [{ offset: 0, stride: 8 }], { format: 'BGRA', W: 2, H: 2 });
    expect([...(await frameToRgba(f, 1, 1))]).toEqual([40, 50, 60, 255]); // averaged, R and B swapped back
    const rgba = frameOf(new Uint8Array([200, 100, 0, 255]), [{ offset: 0, stride: 4 }], { format: 'RGBA', W: 1, H: 1 });
    expect([...(await frameToRgba(rgba, 1, 1))]).toEqual([200, 100, 0, 255]);
  });

  it('only frames it can read: known formats with copyTo', () => {
    expect(cpuReadable(yuvFrame(room(), 16, 8))).toBe(true);
    expect(cpuReadable({ ...yuvFrame(room(), 16, 8), format: null })).toBe(false); // a GPU-only frame
    expect(cpuReadable({ ...yuvFrame(room(), 16, 8), format: 'I420P10' })).toBe(false);
    expect(cpuReadable({ width: 640, height: 360, close() {} })).toBe(false); // an ImageBitmap (the mock)
    expect(cpuReadable(null)).toBe(false);
  });
});

describe('SecurityPipeline reads decoded frames on the CPU', () => {
  function setup() {
    const clock = manualClock();
    const g = fakeGraphics();
    const toMain = [];
    const port = { onmessage: null, postMessage(m) { toMain.push(m); }, start() {}, close() {} };
    const p = new SecurityPipeline({ postPage: () => {}, createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas, ...clock });
    p.attachPort(port);
    const main = (m) => port.onmessage({ data: m });
    const feed = async (n, paint, rx, o = {}) => {
      const frames = [];
      for (let i = 0; i < n; i++) {
        const f = yuvFrame(paint, 320, 180, o);
        frames.push(f);
        p._onVideoFrame(f, rx + i * 66);
        await flush(3);
        clock.advance(100);
      }
      await flush();
      return frames;
    };
    return { p, g, toMain, main, feed, clock };
  }

  it('the calibration shift is measured without a canvas readback', async () => {
    const s = setup();
    s.main({ t: 'shift-ref', id: 'r', after: 0 });
    await s.feed(4, room(), 100);
    const [ok] = s.toMain.filter((m) => m.t === 'shift-ref-ok');
    expect(ok).toMatchObject({ ok: true, still: true });
    s.main({ t: 'shift-measure', id: 'm', timeoutMs: 6000, expectMove: true, after: 1000 });
    await s.feed(5, room({ offset: 0.12 }), 1100);
    const [r] = s.toMain.filter((m) => m.t === 'shift');
    expect(r).toMatchObject({ gated: true, refAt: ok.at });
    expect(r.dx).toBeLessThan(-0.08);
    expect(r.dx).toBeGreaterThan(-0.16);
    expect(r.score).toBeGreaterThan(0.15);
    expect(s.g.stats.bitmaps).toBe(0); // no createImageBitmap, no getImageData
  });

  it('a frame whose copy fails: the canvas path from then on', async () => {
    const s = setup();
    s.main({ t: 'shift-ref', id: 'r', after: 0 });
    const frames = await s.feed(4, room(), 100, { failCopy: true });
    expect(frames[0].copies).toBeGreaterThanOrEqual(1); // (its motion and shift samples)
    expect(frames.slice(1).every((f) => f.copies === 0)).toBe(true);
    expect(s.toMain.filter((m) => m.t === 'shift-ref-ok')).toEqual([expect.objectContaining({ ok: true })]);
    expect(s.g.stats.bitmaps).toBeGreaterThan(0);
  });
});
