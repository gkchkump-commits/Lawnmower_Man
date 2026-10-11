// The irises of the relief head's plate, for its gaze (pure pixel code, plus a canvas wrapper).
//
// The shader draws each iris as a disc that slides rigidly inside the open eye (the old uv warp
// dragged the lids, the lid lines and the eye's outline along at large gaze). That needs two
// things from the plate:
//  - where the iris really is. The pack's eye centres and iris radii come from face landmarks
//    (MediaPipe's iris points), which on the stylised reference plate sit ~25 px off the painted
//    iris and ~20 % small; locateIris finds the painted one: the dark pupil inside the bright iris,
//    then the iris' rim on the luminance profile across it.
//  - what lies under it: fillIrises paints each iris (with its glow) over with the sclera beside it,
//    so the crescent a moving iris uncovers shows sclera, not a second iris.

/** Rec. 709 luminance of RGBA texel i (byte offset). */
const lumAt = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

/**
 * Find the iris near a guess: the pupil-sized square that is darkest against the ring of iris
 * around it (summed-area tables, sub-pixel peak), then the rim: the radius at which the luminance
 * profile along the horizontal (the part of an iris the lids never hide) falls half way from the
 * iris to the sclera beside it.
 * @param {ArrayLike<number>} px RGBA, `w` x `h`
 * @param {number} w @param {number} h
 * @param {{ cx: number, cy: number, r: number, box: [number, number, number, number] }} guess
 *   landmark centre and iris radius (px), and the box the centre is searched in
 * @returns {{ cx: number, cy: number, r: number, contrast: number } | null} null: no pupil there
 */
export function locateIris(px, w, h, guess) {
  const R = guess.r;
  const a = Math.max(2, Math.round(0.2 * R)), c = Math.round(0.4 * R), b = Math.max(c + 2, Math.round(0.75 * R));
  const sx0 = Math.max(b, Math.floor(guess.box[0])), sx1 = Math.min(w - 1 - b, Math.ceil(guess.box[2]));
  const sy0 = Math.max(b, Math.floor(guess.box[1])), sy1 = Math.min(h - 1 - b, Math.ceil(guess.box[3]));
  if (!(sx1 > sx0 && sy1 > sy0)) return null;
  // summed-area table over the search box plus the ring's reach
  const x0 = sx0 - b, y0 = sy0 - b, W = sx1 + b - x0 + 2, H = sy1 + b - y0 + 2;
  const S = new Float64Array(W * H);
  for (let y = 1; y < H; y++) {
    let row = 0;
    for (let x = 1; x < W; x++) {
      row += lumAt(px, ((y0 + y - 1) * w + x0 + x - 1) * 4);
      S[y * W + x] = S[(y - 1) * W + x] + row;
    }
  }
  // sum over the square of half size k around (x, y) (plate px)
  const sq = (x, y, k) => {
    const xa = x - k - x0, xb = x + k + 1 - x0, ya = y - k - y0, yb = y + k + 1 - y0;
    return S[yb * W + xb] - S[ya * W + xb] - S[yb * W + xa] + S[ya * W + xa];
  };
  const nA = (2 * a + 1) ** 2, nRing = (2 * b + 1) ** 2 - (2 * c + 1) ** 2;
  const score = (x, y) => {
    const pupil = sq(x, y, a) / nA;
    return (sq(x, y, b) - sq(x, y, c)) / nRing - pupil;
  };
  let best = -Infinity, bx = 0, by = 0;
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const s = score(x, y);
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  if (!(best > 30)) return null; // no dark pupil in a bright iris
  // sub-pixel: a parabola through the peak and its neighbours, per axis
  const peak = (m, z, p) => {
    const d = m - 2 * z + p;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / d)) : 0;
  };
  const cx = bx + 0.5 + (bx > sx0 && bx < sx1 ? peak(score(bx - 1, by), best, score(bx + 1, by)) : 0);
  const cy = by + 0.5 + (by > sy0 && by < sy1 ? peak(score(bx, by - 1), best, score(bx, by + 1)) : 0);
  // the rim: mean luminance on rays within 30 deg of the horizontal, both sides
  const sample = (x, y) => {
    const xi = Math.max(0, Math.min(w - 2, Math.floor(x - 0.5))), yi = Math.max(0, Math.min(h - 2, Math.floor(y - 0.5)));
    const fx = Math.max(0, Math.min(1, x - 0.5 - xi)), fy = Math.max(0, Math.min(1, y - 0.5 - yi));
    const i = (yi * w + xi) * 4;
    const top = lumAt(px, i) * (1 - fx) + lumAt(px, i + 4) * fx;
    const bot = lumAt(px, i + w * 4) * (1 - fx) + lumAt(px, i + w * 4 + 4) * fx;
    return top * (1 - fy) + bot * fy;
  };
  const step = 0.5, n = Math.ceil((2.2 * R) / step);
  const prof = [];
  for (let k = 0; k <= n; k++) {
    const r = k * step;
    let s = 0, m = 0;
    for (let j = -6; j <= 6; j++) {
      const th = (j / 6) * (Math.PI / 6);
      for (const side of [-1, 1]) { s += sample(cx + side * r * Math.cos(th), cy + r * Math.sin(th)); m++; }
    }
    prof.push(s / m);
  }
  const median = (lo, hi) => {
    const v = prof.slice(Math.round(lo / step), Math.round(hi / step) + 1).sort((p, q) => p - q);
    return v[v.length >> 1];
  };
  const iris = median(0.5 * R, R), sclera = median(1.55 * R, 2.2 * R);
  if (!(iris - sclera > 20)) return null;
  const mid = 0.5 * (iris + sclera);
  let r = NaN;
  for (let k = Math.round((0.8 * R) / step); k < prof.length; k++) {
    if (prof[k] < mid) {
      const f = (prof[k - 1] - mid) / Math.max(1e-6, prof[k - 1] - prof[k]);
      r = (k - 1 + f) * step;
      break;
    }
  }
  if (!Number.isFinite(r)) return null;
  return { cx, cy, r: Math.max(0.7 * R, Math.min(1.8 * R, r)), contrast: best };
}

/**
 * Where the plate shows the inside of the open eye (eye white or iris) and not a lid or the
 * glowing lid margins: 0..255 per texel (row 0 = the image's top row). From the lid coordinate
 * of masks_c (w = 2 r - 1: 0 on the lid lines, rising to 1 on the closed-eye line, falling below
 * it): inside means at least ~2 px below the level where the upper margin's glow ends (w = 0.13),
 * down across the closed-eye line to where the lower margin's glow begins, just below it (w = 0.9
 * on its far side: on the reference plate the iris' lower rim, the eye white's glow starts a pixel
 * lower), measured in px along w's vertical gradient. Packs without masks_c: masks_b's eye aperture.
 * @param {ArrayLike<number>|null} lids RGBA of masks_c (or null)
 * @param {ArrayLike<number>|null} aperture RGBA of masks_b (used without masks_c)
 * @param {number} w @param {number} h
 * @returns {Uint8Array|null}
 */
export function openMap(lids, aperture, w, h) {
  if (!lids && !aperture) return null;
  const out = new Uint8Array(w * h);
  const step = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  if (!lids) {
    for (let i = 0; i < w * h; i++) out[i] = Math.round(255 * step(0.3, 0.75, aperture[i * 4] / 255));
    return out;
  }
  const W = (x, y) => (lids[(y * w + x) * 4] / 255) * 2 - 1;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 0; x < w; x++) {
      const v = W(x, y);
      if (v <= 0.1) continue;
      const gy = (W(x, y + 2) - W(x, y - 2)) / 4; // per px, > 0 above the closed-eye line
      let k;
      if (gy >= 0.004) k = step(0, 2, (v - 0.13) / gy);
      else if (gy <= -0.004) k = step(0, 2, (v - 0.9) / -gy);
      else k = v > 0.9 ? 1 : 0; // on the closed-eye line
      out[y * w + x] = Math.round(255 * k);
    }
  }
  return out;
}

/**
 * Paint the irises of an RGBA image over with what would be there without them, in place, with a
 * 2 px feather inside the rim (so a disc drawn back over the fill with its edge from `r` to `r` +
 * 2 px reproduces the image exactly). The base of each row runs from the texels just beyond the
 * iris on its left to those on its right (3-9 px out, past the glow; smoothed over five rows): the
 * eye white beside the iris, and the lid margins that cross the disc near its top and bottom, run
 * on. The fine detail (texel minus its 7 x 7 mean) beside the iris is added, mirrored back and
 * forth within a 10 px strip beyond the rim, where `open` says the texel and its source are the
 * same kind of place (both inside the open eye, or both on a lid margin's glow): the grid lines
 * that cross the eye white and the lid glows run on, with the same texture. With the lid
 * coordinate (masks_c), a texel on a lid margin's glow takes the glow beyond the disc at the same
 * lid coordinate instead (the margin runs on along its own curve, not along the row, which near
 * the top of an arched lid would smear the lid line into a flat band).
 * @param {Uint8ClampedArray|Uint8Array} px RGBA, `w` x `h`
 * @param {number} w @param {number} h
 * @param {Array<{ cx: number, cy: number, r: number }>} eyes iris centres and outer radii (px)
 * @param {ArrayLike<number>|null} [open] openMap() (0..255 per texel)
 * @param {ArrayLike<number>|null} [lids] RGBA of masks_c (the lid coordinate in r)
 */
export function fillIrises(px, w, h, eyes, open = null, lids = null) {
  const src = Uint8ClampedArray.from(px);
  const lidW = (x, y) => (lids[(y * w + x) * 4] / 255) * 2 - 1;
  const lidSide = (x, y) => Math.sign(lidW(x, Math.min(h - 1, y + 1)) - lidW(x, Math.max(0, y - 1)));
  /** the glow beyond the disc (columns `x0`.. outward by `dir`) at lid coordinate w0 on the same
   * side of the closed-eye line as the texel: RGB, or null */
  const alongLid = (x0, dir, y, w0, side) => {
    const c = [0, 0, 0];
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const x = x0 + dir * j;
      if (x < 0 || x >= w) continue;
      let best = 0.06, by = -1;
      for (let yy = Math.max(1, y - 16); yy <= Math.min(h - 2, y + 16); yy++) {
        if (lidSide(x, yy) !== side) continue;
        const d = Math.abs(lidW(x, yy) - w0);
        if (d < best) { best = d; by = yy; }
      }
      if (by < 0) continue;
      const i = (by * w + x) * 4;
      c[0] += src[i]; c[1] += src[i + 1]; c[2] += src[i + 2]; n++;
    }
    return n ? c.map((v) => v / n) : null;
  };
  const smooth = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const openAt = (x, y) => (open && x >= 0 && x < w && y >= 0 && y < h ? open[y * w + x] / 255 : 0);
  /** fine detail of channel c at texel (x, y): the texel minus its 7 x 7 mean */
  const detail = (x, y, c) => {
    let s = 0, n = 0;
    for (let j = -3; j <= 3; j++) {
      for (let k = -3; k <= 3; k++) {
        const xx = x + k, yy = y + j;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        s += src[(yy * w + xx) * 4 + c]; n++;
      }
    }
    return src[(y * w + x) * 4 + c] - s / n;
  };
  const P = 10, GAP = 3;
  for (const e of eyes) {
    const r = e.r;
    const y0 = Math.max(0, Math.floor(e.cy - r)), y1 = Math.min(h - 1, Math.ceil(e.cy + r));
    const x0 = Math.max(0, Math.floor(e.cx - r)), x1 = Math.min(w - 1, Math.ceil(e.cx + r));
    // per row: the colour beyond the iris on each side
    const rowSide = [];
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - e.cy;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const side = (dir) => {
        const c = [0, 0, 0];
        let n = 0;
        for (let k = GAP; k <= GAP + 6; k++) {
          const x = Math.floor(e.cx + dir * (half + k));
          if (x < 0 || x >= w) continue;
          // (inside the open eye, the eye white: where the lid glow is beside a row near the top or
          // bottom of the disc, the nearest open texel toward the eye's middle)
          let yy = y;
          if (open && openAt(x, y) >= 0.5) {
            // already the eye white
          } else if (open && openAt(Math.floor(e.cx), y) >= 0.5) {
            const sy = Math.sign(e.cy - (y + 0.5)) || 1;
            for (let q = 1; q <= 12; q++) if (openAt(x, y + sy * q) >= 0.5) { yy = y + sy * q; break; }
          }
          const i = (yy * w + x) * 4;
          c[0] += src[i]; c[1] += src[i + 1]; c[2] += src[i + 2]; n++;
        }
        return n ? c.map((v) => v / n) : null;
      };
      const L = side(-1), R = side(1);
      rowSide.push([L || R || [0, 0, 0], R || L || [0, 0, 0]]);
    }
    const sideAt = (k, j) => {
      let c0 = 0, c1 = 0, c2 = 0, n = 0;
      for (let q = -2; q <= 2; q++) {
        const row = rowSide[k + q];
        if (!row) continue;
        c0 += row[j][0]; c1 += row[j][1]; c2 += row[j][2]; n++;
      }
      return [c0 / n, c1 / n, c2 / n];
    };
    for (let y = y0; y <= y1; y++) {
      const k = y - y0;
      const L = sideAt(k, 0), R = sideAt(k, 1);
      const dy = y + 0.5 - e.cy;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const xl = e.cx - half, xr = e.cx + half;
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - e.cx, dy);
        const a = Math.min(1, Math.max(0, (r - d) / 2)); // 2 px feather inside the rim
        if (a <= 0) continue;
        const u = Math.max(0, Math.min(1, (x + 0.5 - xl) / Math.max(1e-6, xr - xl)));
        const s = smooth(0.3, 0.7, u);
        // sources of the texture: back and forth within the strip beyond each side's rim
        const pp = (o) => { const t = ((o % (2 * P)) + 2 * P) % (2 * P); return t < P ? t : 2 * P - t; };
        const ml = Math.floor(xl - GAP - pp(x + 0.5 - xl)), mr = Math.floor(xr + GAP + pp(xr - (x + 0.5)));
        // (the detail of the same kind of place: eye white for eye white, lid glow for lid glow)
        const kt = openAt(x, y), same = (o) => (open ? kt * o + (1 - kt) * (1 - o) : 0);
        const kl = same(openAt(ml, y)) * (1 - s), kr = same(openAt(mr, y)) * s;
        const i = (y * w + x) * 4;
        // a lid margin's glow: the same glow beyond the disc, along the lid
        let lid = null;
        if (lids && kt < 1) {
          const w0 = lidW(x, y), side = lidSide(x, y);
          const gl = alongLid(Math.floor(e.cx - r - GAP), -1, y, w0, side), gr = alongLid(Math.ceil(e.cx + r + GAP), 1, y, w0, side);
          if (gl || gr) lid = [0, 1, 2].map((c) => (gl || gr)[c] + ((gr || gl)[c] - (gl || gr)[c]) * s);
        }
        for (let c = 0; c < 3; c++) {
          let f = L[c] + (R[c] - L[c]) * u;
          if (kl > 0) f += kl * detail(ml, y, c);
          if (kr > 0) f += kr * detail(mr, y, c);
          if (lid) f += (lid[c] - f) * (1 - kt);
          px[i + c] = src[i + c] + (f - src[i + c]) * a;
        }
      }
    }
  }
  return px;
}

/** px beyond the measured rim that still glow (the disc that moves carries them along) */
export const IRIS_GLOW_PX = 3;

/** @typedef {{ cx: number, cy: number, r: number, disc: number, found: boolean }} IrisEye  px: centre, rim, disc (rim + glow) */

/**
 * The irises of a relief pack's plate: located on the plate (falling back to the pack's landmark
 * values), the plate with them painted over, and where the eye is open (see openMap) - or, without
 * a DOM or a readable image, only the pack's values (canvas and open null).
 * @param {CanvasImageSource & { width: number, height: number }} image the plate
 * @param {any} pack parsed pack.json
 * @param {{ lids?: CanvasImageSource|null, aperture?: CanvasImageSource|null }} [masks] masks_c
 *   (lid coordinate in r) and masks_b (eye aperture in r, for packs without masks_c)
 * @returns {{ canvas: HTMLCanvasElement|null, open: Uint8Array|null, eyes: Record<'L'|'R', IrisEye> }}
 */
export function irisLayer(image, pack, masks = {}) {
  /** @type {Record<string, IrisEye>} */
  const eyes = {};
  const guess = (k) => {
    const e = pack.rig.eyes[k];
    const lids = e.lids;
    const box = lids?.x?.length
      ? [lids.x[0], Math.min(...lids.upper), lids.x[lids.x.length - 1], Math.max(...lids.lower)]
      : [e.center[0] - e.width / 2, e.center[1] - e.height, e.center[0] + e.width / 2, e.center[1] + e.height];
    return { cx: e.center[0], cy: e.center[1], r: e.irisRadius, box };
  };
  for (const k of ['L', 'R']) {
    const g = guess(k);
    eyes[k] = { cx: g.cx, cy: g.cy, r: g.r, disc: g.r + IRIS_GLOW_PX, found: false };
  }
  const none = { canvas: null, open: null, eyes };
  if (typeof document === 'undefined' || !image || !(image.width > 0)) return none;
  try {
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return none;
    const read = (img) => {
      if (!img) return null;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const lidPx = read(masks.lids);
    const open = openMap(lidPx, masks.lids ? null : read(masks.aperture), c.width, c.height);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(image, 0, 0);
    const all = g.getImageData(0, 0, c.width, c.height);
    for (const k of ['L', 'R']) {
      const hit = locateIris(all.data, c.width, c.height, guess(k));
      if (hit) eyes[k] = { cx: hit.cx, cy: hit.cy, r: hit.r, disc: hit.r + IRIS_GLOW_PX, found: true };
    }
    fillIrises(all.data, c.width, c.height, [eyes.L, eyes.R].map((e) => ({ cx: e.cx, cy: e.cy, r: e.disc })), open, lidPx);
    g.putImageData(all, 0, 0);
    return { canvas: c, open, eyes };
  } catch {
    return none;
  }
}
