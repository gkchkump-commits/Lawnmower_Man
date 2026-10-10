// How far did the picture move? The calibration wizard (main's electron/tapo/calibration.js,
// contract §8.4) turns the camera a known amount and asks the worker how much the scene shifted,
// to learn which way the motors turn and how many ONVIF units one view width is. Pure.
//
// Block matching on luma: the reference (before the move) and the current picture (after the
// image settled), both 128×72. A coarse search on a 64×36 version tries every whole-pixel shift
// in range by the mean absolute difference over the overlapping area, with each side's own mean
// over that area removed (integral images make that O(1) per shift), so an exposure change
// after the turn does not matter. The best shift is refined at 128×72 (±2 px) with a parabola
// through the neighbours for a sub-pixel result.
//
// Sign convention: dx, dy are the scene's movement as fractions of the width/height, + = the
// scene moved right/down (a camera turning right moves the scene left, dx < 0).
// Score: 1 − best / second-best difference among shifts away from the best one, scaled down for
// a picture without contrast. A textured scene gives a sharp, unique minimum (score near 1); a
// dark, blurry or featureless one gives many similar candidates or no contrast (score near 0).
// ≥ SHIFT_RELIABLE counts as a measurement.

export const SHIFT_WIDTH = 128;
export const SHIFT_HEIGHT = 72;
/** Search range as fractions of the view. (Contract §9.4 says ±24×±14 px at 64×36, i.e.
 * ±0.375×±0.39; the horizontal range is a little wider here because a 0.2-unit pan of a Tapo
 * C2xx can turn the view by about 0.4 of its width.) */
export const SHIFT_RANGE = Object.freeze({ x: 0.45, y: 0.39 });
export const SHIFT_RELIABLE = 0.15;
/** Contrast (standard deviation of the luma, 0..255) below which nothing can be measured, and
 * at which the score is no longer scaled down. Sensor noise in the dark is about 1. */
export const SHIFT_CONTRAST = Object.freeze({ none: 2.5, full: 8 });
/** Shifts at least this many coarse pixels away from the best one compete for "second best". */
const PEAK_RADIUS = 2;

/** w×h luma → (w/2)×(h/2) by 2×2 averaging. @param {ArrayLike<number>} src @param {number} w @param {number} h */
export function halve(src, w, h) {
  const W = w >> 1;
  const H = h >> 1;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * W + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) / 4;
    }
  }
  return out;
}

/** Summed-area table, (w+1)×(h+1). @param {ArrayLike<number>} a @param {number} w @param {number} h */
function integral(a, w, h) {
  const W = w + 1;
  const s = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += a[y * w + x];
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
    }
  }
  return s;
}

/** Sum of [x0, x1) × [y0, y1) from a summed-area table of width w. */
function boxSum(s, w, x0, y0, x1, y1) {
  const W = w + 1;
  return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
}

/**
 * Mean absolute difference between cur(x, y) and ref(x − sx, y − sy) over their overlap, each
 * with its own mean over the overlap removed. `sr`/`sc` are summed-area tables (optional: without
 * them the plain difference is used).
 * @param {ArrayLike<number>} ref @param {ArrayLike<number>} cur @param {number} w @param {number} h
 * @param {number} sx @param {number} sy @param {Float64Array} [sr] @param {Float64Array} [sc]
 */
export function sadAt(ref, cur, w, h, sx, sy, sr, sc) {
  const x0 = Math.max(0, sx);
  const x1 = Math.min(w, w + sx);
  const y0 = Math.max(0, sy);
  const y1 = Math.min(h, h + sy);
  if (x1 - x0 < 4 || y1 - y0 < 4) return Infinity;
  const area = (x1 - x0) * (y1 - y0);
  const off = sr && sc ? (boxSum(sc, w, x0, y0, x1, y1) - boxSum(sr, w, x0 - sx, y0 - sy, x1 - sx, y1 - sy)) / area : 0;
  let s = 0;
  for (let y = y0; y < y1; y++) {
    const rc = y * w;
    const rr = (y - sy) * w - sx;
    for (let x = x0; x < x1; x++) s += Math.abs(cur[rc + x] - ref[rr + x] - off);
  }
  return s / area;
}

/** Standard deviation of a picture. @param {ArrayLike<number>} a */
export function contrastOf(a) {
  const n = a.length;
  if (!n) return 0;
  let s = 0;
  let q = 0;
  for (let i = 0; i < n; i++) {
    s += a[i];
    q += a[i] * a[i];
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, q / n - m * m));
}

/** Vertex of the parabola through (−1, a), (0, b), (1, c), clamped to ±0.5. */
function subPixel(a, b, c) {
  const d = a - 2 * b + c;
  if (!(d > 1e-9) || !Number.isFinite(a) || !Number.isFinite(c)) return 0;
  return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
}

/**
 * @param {ArrayLike<number>} ref  luma before the move, width×height
 * @param {ArrayLike<number>} cur  luma after the move
 * @param {{ width?: number, height?: number, range?: { x: number, y: number } }} [o]
 * @returns {{ dx: number, dy: number, score: number }}
 */
export function estimateShift(ref, cur, o = {}) {
  const w = o.width || SHIFT_WIDTH;
  const h = o.height || SHIFT_HEIGHT;
  const range = o.range || SHIFT_RANGE;
  if (!ref || !cur || ref.length < w * h || cur.length < w * h) return { dx: 0, dy: 0, score: 0 };
  // coarse: every whole-pixel shift at half resolution
  const cw = w >> 1;
  const ch = h >> 1;
  const r2 = halve(ref, w, h);
  const c2 = halve(cur, w, h);
  const ir2 = integral(r2, cw, ch);
  const ic2 = integral(c2, cw, ch);
  const mx = Math.max(1, Math.round(range.x * cw));
  const my = Math.max(1, Math.round(range.y * ch));
  const sads = [];
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let sy = -my; sy <= my; sy++) {
    for (let sx = -mx; sx <= mx; sx++) {
      const s = sadAt(r2, c2, cw, ch, sx, sy, ir2, ic2);
      sads.push({ sx, sy, s });
      if (s < best || (s === best && Math.abs(sx) + Math.abs(sy) < Math.abs(bx) + Math.abs(by))) {
        best = s;
        bx = sx;
        by = sy;
      }
    }
  }
  let second = Infinity;
  for (const c of sads) {
    if (Math.abs(c.sx - bx) <= PEAK_RADIUS && Math.abs(c.sy - by) <= PEAK_RADIUS) continue;
    if (c.s < second) second = c.s;
  }
  // refine at full resolution around the coarse result
  const ir = integral(ref, w, h);
  const ic = integral(cur, w, h);
  const sad = (/** @type {number} */ sx, /** @type {number} */ sy) => sadAt(ref, cur, w, h, sx, sy, ir, ic);
  let fb = Infinity;
  let fx = 2 * bx;
  let fy = 2 * by;
  for (let sy = 2 * by - 2; sy <= 2 * by + 2; sy++) {
    for (let sx = 2 * bx - 2; sx <= 2 * bx + 2; sx++) {
      const s = sad(sx, sy);
      if (s < fb) {
        fb = s;
        fx = sx;
        fy = sy;
      }
    }
  }
  const px = fx + subPixel(sad(fx - 1, fy), fb, sad(fx + 1, fy));
  const py = fy + subPixel(sad(fx, fy - 1), fb, sad(fx, fy + 1));
  let score = 0;
  if (Number.isFinite(second) && second > 1e-6) score = Math.max(0, Math.min(1, 1 - best / second));
  // a picture without contrast (dark, covered, out of focus) cannot be measured, however the
  // noise happens to line up
  const contrast = Math.min(contrastOf(r2), contrastOf(c2));
  const k = Math.max(0, Math.min(1, (contrast - SHIFT_CONTRAST.none) / (SHIFT_CONTRAST.full - SHIFT_CONTRAST.none)));
  return { dx: px / w, dy: py / h, score: score * k };
}
