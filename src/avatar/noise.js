// Deterministic random numbers and smooth 1D noise (pure JS, no three.js).

/**
 * Mulberry32 PRNG. Returns a function producing floats in [0, 1).
 * @param {number} seed any integer
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0, 1). Stateless, used by the noise below. */
export function hash1(n, seed = 0) {
  let h = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * Smooth 1D gradient noise ("Perlin-like"), range about [-1, 1], C1-continuous.
 * @param {number} x
 * @param {number} [seed]
 */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash1(i, seed) * 2 - 1;
  const g1 = hash1(i + 1, seed) * 2 - 1;
  const v0 = g0 * f;
  const v1 = g1 * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10); // quintic fade
  return (v0 + (v1 - v0) * u) * 2.0;
}

/**
 * Fractal sum of noise1 (2 octaves by default), range about [-1, 1].
 * @param {number} x
 * @param {number} [seed]
 * @param {number} [octaves]
 */
export function fbm1(x, seed = 0, octaves = 2) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise1(x * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Frame-rate independent exponential approach factor for time constant tau (seconds). */
export function expApproach(dt, tau) {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-dt / tau);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
