// Quality tiers (pure data). The RTX 5070 laptop target runs "high" at 60 fps; "low" is for
// integrated GPUs / software rendering (SwiftShader in tests).

/**
 * @typedef {Object} QualityTier
 * @property {number} dprCap        device-pixel-ratio cap for the canvas backing store
 * @property {number} msaa          samples for the scene render target (0 = off)
 * @property {number} particles     base particle count (multiplied by options.particles)
 * @property {number} bloomScale    bloom chain resolution relative to the canvas
 * @property {number} bloomLevels   number of mip levels in the bloom chain
 * @property {boolean} halfFloat    HalfFloat bloom targets when available (the scene target is
 *                                  half float on every tier, see fx/post.js)
 */

/** @type {Record<'low'|'medium'|'high', QualityTier>} */
export const QUALITY = {
  high: { dprCap: 2, msaa: 4, particles: 6000, bloomScale: 0.5, bloomLevels: 5, halfFloat: true },
  medium: { dprCap: 1.5, msaa: 2, particles: 3000, bloomScale: 0.5, bloomLevels: 4, halfFloat: true },
  low: { dprCap: 1, msaa: 0, particles: 1200, bloomScale: 0.25, bloomLevels: 3, halfFloat: false },
};

/** @param {string} q @returns {'low'|'medium'|'high'} */
export function normalizeQuality(q) {
  return q === 'low' || q === 'medium' || q === 'high' ? q : 'high';
}

/** Next lower tier ('low' stays 'low'). @param {string} q @returns {'medium'|'low'} */
export function lowerQuality(q) {
  return q === 'high' ? 'medium' : 'low';
}

/**
 * Automatic quality downgrade (pure logic, fed with the measured frame rate): when the frame rate
 * stays below `minFps` for `holdSec` seconds the governor asks for the next lower tier. The input
 * is smoothed again over ~1 s so frame-time jitter around the limit (22..26 fps) cannot keep
 * resetting the clock. It ignores the first `warmupSec` after start / after a switch (shader
 * compilation, texture uploads) and restarts after a pause in sampling (hidden window).
 */
export class QualityGovernor {
  /** @param {{ minFps?: number, holdSec?: number, warmupSec?: number, smoothSec?: number }} [o] */
  constructor(o = {}) {
    this.minFps = o.minFps ?? 24;
    this.holdSec = o.holdSec ?? 3;
    this.warmupSec = o.warmupSec ?? 2.5;
    this.smoothSec = o.smoothSec ?? 1;
    this._since = null;
    this._armedAt = -Infinity;
    this._last = null;
    this._avg = 0;
  }

  /** Start (or restart) the warm-up window at `now` seconds. */
  reset(now) {
    this._since = null;
    this._armedAt = now + this.warmupSec;
    this._last = now;
    this._avg = 0;
  }

  /** Smoothed frame rate the decisions are based on (0 = no data yet). */
  get fps() { return this._avg; }

  /**
   * @param {number} now seconds @param {number} fps measured frame rate @param {string} quality current tier
   * @returns {'medium'|'low'|null} the tier to switch to, or null to stay
   */
  sample(now, fps, quality) {
    if (this._last === null || now - this._last > 1 || now < this._last) this.reset(now);
    const dt = now - this._last;
    this._last = now;
    if (fps > 0) this._avg = this._avg > 0 ? this._avg + (fps - this._avg) * (1 - Math.exp(-dt / this.smoothSec)) : fps;
    if (quality === 'low' || now < this._armedAt || !(this._avg > 0) || this._avg >= this.minFps) {
      this._since = null;
      return null;
    }
    if (this._since === null) this._since = now;
    if (now - this._since < this.holdSec) return null;
    this.reset(now);
    return lowerQuality(quality);
  }
}
