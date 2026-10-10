// A small RGBA copy of a decoded VideoFrame, made on the CPU (VideoFrame.copyTo + a box
// downscale). The worker's motion and calibration samples used createImageBitmap + drawImage +
// getImageData, whose getImageData is a synchronous round trip to the GPU process: under
// software GL on a busy PC it blocked the whole worker for up to a minute (measured in
// tapo-e2e: 62.7 s), so it could not even answer that it had no current picture. copyTo is
// asynchronous and, for a software-decoded frame (I420 in memory), a plain copy of about a
// millisecond. Frames in other formats (none, or one this does not know) use the canvas path.
// Pure (the frame is duck-typed), so it is unit-tested in Node.

/** Planar / semi-planar YUV formats: [chroma x shift, chroma y shift, interleaved UV]. */
const YUV = Object.freeze({
  I420: [1, 1, false], I420A: [1, 1, false], I422: [1, 0, false], I422A: [1, 0, false],
  I444: [0, 0, false], I444A: [0, 0, false], NV12: [1, 1, true],
});
/** 8-bit RGB formats: [red offset, blue offset] in each 4-byte pixel. */
const RGB = Object.freeze({ RGBA: [0, 2], RGBX: [0, 2], BGRA: [2, 0], BGRX: [2, 0] });
/** At most this many samples per axis are averaged into one output pixel. */
const MAX_TAPS = 4;

/** Can this frame be read on the CPU? @param {any} frame */
export function cpuReadable(frame) {
  return !!frame && typeof frame.copyTo === 'function' && typeof frame.allocationSize === 'function'
    && (Object.hasOwn(YUV, frame.format) || Object.hasOwn(RGB, frame.format));
}

/** Reusable copy buffers, one per size (the frames of a stream all have the same). */
export class PixelScratch {
  constructor() {
    /** @type {Map<number, Uint8Array>} */
    this._bufs = new Map();
  }

  /** @param {number} size */
  get(size) {
    let b = this._bufs.get(size);
    if (!b) {
      if (this._bufs.size > 3) this._bufs.clear();
      b = new Uint8Array(size);
      this._bufs.set(size, b);
    }
    return b;
  }
}

/**
 * YUV → RGB coefficients for the frame's colour space (BT.709 or BT.601, limited or full range).
 * @param {any} cs VideoColorSpace (or its JSON)
 */
function yuvMatrix(cs) {
  const full = cs?.fullRange === true;
  const m = cs?.matrix === 'bt709' ? { rv: 1.5748, gu: 0.1873, gv: 0.4681, bu: 1.8556 } : { rv: 1.402, gu: 0.3441, gv: 0.7141, bu: 1.772 };
  // limited range: Y 16..235, U/V 16..240
  const ky = full ? 1 : 255 / 219;
  const kc = full ? 1 : 255 / 224;
  return { full, ky, rv: m.rv * kc, gu: m.gu * kc, gv: m.gv * kc, bu: m.bu * kc };
}

/** Sample positions (pixel indices) averaged for output pixel `o` of `n` from `size` pixels. */
function taps(o, n, size) {
  const a = (o * size) / n;
  const b = ((o + 1) * size) / n;
  const k = Math.max(1, Math.min(MAX_TAPS, Math.round(b - a)));
  const out = new Int32Array(k);
  for (let i = 0; i < k; i++) out[i] = Math.min(size - 1, Math.floor(a + ((i + 0.5) * (b - a)) / k));
  return out;
}

const clamp8 = (/** @type {number} */ v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * The frame's visible picture as w×h RGBA (box-averaged).
 * @param {any} frame VideoFrame in a cpuReadable() format
 * @param {number} w @param {number} h
 * @param {PixelScratch} [scratch]
 * @returns {Promise<Uint8ClampedArray>}
 */
export async function frameToRgba(frame, w, h, scratch = new PixelScratch()) {
  const size = frame.allocationSize();
  const buf = scratch.get(size);
  const layout = await frame.copyTo(buf);
  const W = frame.visibleRect?.width || frame.displayWidth || frame.codedWidth;
  const H = frame.visibleRect?.height || frame.displayHeight || frame.codedHeight;
  if (!(W > 0) || !(H > 0) || !Array.isArray(layout) || !layout.length) throw new Error('frame without a picture');
  const out = new Uint8ClampedArray(w * h * 4);
  const xs = Array.from({ length: w }, (_, x) => taps(x, w, W));
  const ys = Array.from({ length: h }, (_, y) => taps(y, h, H));
  const rgb = RGB[/** @type {keyof typeof RGB} */ (frame.format)];
  if (rgb) {
    const { offset, stride } = layout[0];
    const [ro, bo] = rgb;
    for (let oy = 0; oy < h; oy++) {
      for (let ox = 0; ox < w; ox++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const y of ys[oy]) {
          for (const x of xs[ox]) {
            const i = offset + y * stride + x * 4;
            r += buf[i + ro];
            g += buf[i + 1];
            b += buf[i + bo];
            n++;
          }
        }
        const j = (oy * w + ox) * 4;
        out[j] = r / n;
        out[j + 1] = g / n;
        out[j + 2] = b / n;
        out[j + 3] = 255;
      }
    }
    return out;
  }
  const [sx, sy, nv12] = YUV[/** @type {keyof typeof YUV} */ (frame.format)];
  const yp = layout[0];
  const up = layout[1];
  const vp = nv12 ? layout[1] : layout[2];
  if (!up || !vp) throw new Error(`${frame.format} frame without chroma planes`);
  const m = yuvMatrix(frame.colorSpace);
  const y0 = m.full ? 0 : 16;
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let ys2 = 0;
      let us = 0;
      let vs = 0;
      let n = 0;
      for (const y of ys[oy]) {
        const yr = yp.offset + y * yp.stride;
        const cy = y >> sy;
        const ur = up.offset + cy * up.stride;
        const vr = vp.offset + cy * vp.stride;
        for (const x of xs[ox]) {
          ys2 += buf[yr + x];
          const cx = x >> sx;
          if (nv12) {
            us += buf[ur + 2 * cx];
            vs += buf[ur + 2 * cx + 1];
          } else {
            us += buf[ur + cx];
            vs += buf[vr + cx];
          }
          n++;
        }
      }
      const yy = (ys2 / n - y0) * m.ky;
      const u = us / n - 128;
      const v = vs / n - 128;
      const j = (oy * w + ox) * 4;
      out[j] = clamp8(yy + m.rv * v);
      out[j + 1] = clamp8(yy - m.gu * u - m.gv * v);
      out[j + 2] = clamp8(yy + m.bu * u);
      out[j + 3] = 255;
    }
  }
  return out;
}
