// Quality tiers (pure data). The RTX 5070 laptop target runs "high" at 60 fps; "low" is for
// integrated GPUs / software rendering (SwiftShader in tests).

/**
 * @typedef {Object} QualityTier
 * @property {number} dprCap        device-pixel-ratio cap for the canvas backing store
 * @property {number} msaa          samples for the scene render target (0 = off)
 * @property {number} particles     base particle count (multiplied by options.particles)
 * @property {number} bloomScale    bloom chain resolution relative to the canvas
 * @property {number} bloomLevels   number of mip levels in the bloom chain
 * @property {boolean} halfFloat    use HalfFloat render targets when available
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
