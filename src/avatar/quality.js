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
  // (high: up to 2x, e.g. a laptop panel at 150-200 %: full resolution; a 3x display costs 2.25x
  // the pixels of 2x for a difference the eye hardly sees at this window size)
  high: { dprCap: 2, msaa: 4, particles: 6000, bloomScale: 0.5, bloomLevels: 5, halfFloat: true },
  medium: { dprCap: 1.5, msaa: 2, particles: 3000, bloomScale: 0.5, bloomLevels: 4, halfFloat: true },
  // (no MSAA and no FXAA: the relief's edges are soft in its own texture; FXAA only smeared the
  // fine wire grid and cost a fifth more)
  low: { dprCap: 1, msaa: 0, particles: 1200, bloomScale: 0.25, bloomLevels: 3, halfFloat: false },
};

/** The first step down of a tier: its pixel ratio cap x this (before MSAA and particles go). */
export const DPR_STEP = 0.75;

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
 * stays below the limit for `holdSec` seconds the governor asks for a step down. The limit is
 * `minFps` (50: the hologram is meant to run at 60), lower on a display that cannot show that many
 * (0.85 x its refresh rate, never below 0.85 x 50). Each tier first gives up some resolution (the
 * pixel ratio x DPR_STEP, when that lowers it), then the next lower tier. The input is smoothed
 * again over ~1 s so frame-time jitter around the limit cannot keep resetting the clock. It
 * ignores the first `warmupSec` after start / after a step (shader compilation, texture uploads)
 * and restarts after a pause in sampling (hidden window).
 */
export class QualityGovernor {
  /** @param {{ minFps?: number, holdSec?: number, warmupSec?: number, smoothSec?: number }} [o] */
  constructor(o = {}) {
    this.minFps = o.minFps ?? 50;
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

  /** The frame rate below which it steps down, on a display of `refreshHz`. @param {number} [refreshHz] */
  limit(refreshHz) {
    const hz = Number.isFinite(refreshHz) && refreshHz > 0 ? refreshHz : 60;
    return Math.min(this.minFps, 0.85 * Math.max(hz, 50));
  }

  /**
   * @param {number} now seconds @param {number} fps measured frame rate @param {string} quality current tier
   * @param {{ refreshHz?: number, dprStep?: boolean }} [o] the display's refresh rate (estimated);
   *   whether a resolution step is still open on this tier
   * @returns {'dpr'|'medium'|'low'|null} 'dpr' (lower the pixel ratio), the tier to switch to, or
   *   null to stay
   */
  sample(now, fps, quality, o = {}) {
    if (this._last === null || now - this._last > 1 || now < this._last) this.reset(now);
    const dt = now - this._last;
    this._last = now;
    if (fps > 0) this._avg = this._avg > 0 ? this._avg + (fps - this._avg) * (1 - Math.exp(-dt / this.smoothSec)) : fps;
    if (quality === 'low' || now < this._armedAt || !(this._avg > 0) || this._avg >= this.limit(o.refreshHz)) {
      this._since = null;
      return null;
    }
    if (this._since === null) this._since = now;
    if (now - this._since < this.holdSec) return null;
    this.reset(now);
    return o.dprStep ? 'dpr' : lowerQuality(quality);
  }
}
