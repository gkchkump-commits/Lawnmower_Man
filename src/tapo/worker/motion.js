// Local motion detection for the Home camera (contract §8.8 / §9.4). Pure: the security worker
// hands it a tiny 64×36 luma picture about 5 times a second and gets back whether something is
// moving. Cheap on purpose (well under a millisecond per sample), so it runs whenever frames
// flow and keeps its background warm for when the camera is armed.
//
// Background: an exponential moving average of the picture (α 0.05, so about 4 s at 5 Hz to
// absorb a change for good). A pixel "changed" when it is more than 18 (of 255) away from the
// background. The picture moves when the changed fraction stays above the sensitivity's
// threshold for 3 samples in a row, and stops after 3 samples below it. A sudden change of most
// of the picture (the camera's night-vision switch, auto-exposure, someone switching on the
// light, the camera turning) is not motion: it is reported as `global` and the background starts
// over from the new picture.

export const MOTION_WIDTH = 64;
export const MOTION_HEIGHT = 36;

export const MOTION = Object.freeze({
  alpha: 0.05,
  pixelThreshold: 18,
  globalFraction: 0.5,
  consecutive: 3,
  /** changed fraction that counts as motion, by security.sensitivity */
  fraction: Object.freeze({ low: 0.03, medium: 0.015, high: 0.008 }),
});

/**
 * RGBA pixels → luma (BT.601 weights, integer math).
 * @param {Uint8ClampedArray|Uint8Array} rgba @param {number} [n] pixel count (default rgba.length / 4)
 * @param {Uint8Array} [out]
 */
export function lumaFromRgba(rgba, n = rgba.length >> 2, out = new Uint8Array(n)) {
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  return out;
}

/**
 * Fraction of pixels that differ by more than `threshold` between two equally sized pictures.
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number} [threshold]
 */
export function changedFraction(a, b, threshold = MOTION.pixelThreshold) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > threshold) c++;
  return c / n;
}

/**
 * @typedef {object} MotionSample
 * @property {boolean} active  something is moving (after the 3-sample confirmation)
 * @property {number} score    changed fraction of this sample, 0..1
 * @property {boolean} global  most of the picture changed at once (not motion; background reset)
 */

export class MotionDetector {
  /** @param {{ width?: number, height?: number, sensitivity?: 'low'|'medium'|'high' }} [o] */
  constructor(o = {}) {
    this.width = o.width || MOTION_WIDTH;
    this.height = o.height || MOTION_HEIGHT;
    this.n = this.width * this.height;
    this.bg = new Float32Array(this.n);
    this.seeded = false;
    this.active = false;
    this._above = 0;
    this._below = 0;
    this.threshold = MOTION.fraction.medium;
    this.setSensitivity(o.sensitivity || 'medium');
  }

  /** @param {'low'|'medium'|'high'|string} s */
  setSensitivity(s) {
    this.threshold = /** @type {Record<string, number>} */ (MOTION.fraction)[s] ?? MOTION.fraction.medium;
  }

  /** Start over: the next sample becomes the background (after a camera move, a stream reset). */
  reseed() {
    this.seeded = false;
    this.active = false;
    this._above = 0;
    this._below = 0;
  }

  /**
   * @param {ArrayLike<number>} luma  width×height luma, row-major
   * @returns {MotionSample}
   */
  update(luma) {
    if (!luma || luma.length < this.n) return { active: this.active, score: 0, global: false };
    const bg = this.bg;
    if (!this.seeded) {
      for (let i = 0; i < this.n; i++) bg[i] = luma[i];
      this.seeded = true;
      return { active: false, score: 0, global: false };
    }
    const thr = MOTION.pixelThreshold;
    const a = MOTION.alpha;
    let changed = 0;
    for (let i = 0; i < this.n; i++) {
      const v = luma[i];
      if (Math.abs(v - bg[i]) > thr) changed++;
      bg[i] += a * (v - bg[i]);
    }
    const score = changed / this.n;
    if (score > MOTION.globalFraction) {
      // the whole picture jumped: not motion; start over from what the camera sees now
      for (let i = 0; i < this.n; i++) bg[i] = luma[i];
      this.active = false;
      this._above = 0;
      this._below = 0;
      return { active: false, score, global: true };
    }
    if (score > this.threshold) {
      this._above++;
      this._below = 0;
      if (this._above >= MOTION.consecutive) this.active = true;
    } else {
      this._below++;
      this._above = 0;
      if (this._below >= MOTION.consecutive) this.active = false;
    }
    return { active: this.active, score, global: false };
  }
}
