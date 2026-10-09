// Motion primitives for the director (pure, no three.js): second-order springs, minimum-jerk
// kernels, a One Euro filter and 1/f ("pink") noise. Everything here is frame-rate independent:
// the springs are solved exactly for a target held over the step (so 60, 144 and 165 Hz sample the
// same continuous motion), the kernels and the noise are functions of time.
//
// Why second order: a first-order lag (x += (target - x) * k) puts 100 % of its peak velocity
// into the first frame after a target change, so every viseme, nod or state change starts with a
// velocity step (a visible "tick"). A critically damped spring starts from zero velocity and
// never overshoots; its velocity is continuous whatever the target does.

/**
 * Critically damped spring, exact step (unconditionally stable for any dt). `s` = { x, v } is
 * updated in place; omega (rad/s) sets the speed: t50 = 1.68 / omega, t90 = 3.89 / omega.
 * @param {{ x: number, v: number }} s @param {number} target @param {number} omega @param {number} dt
 * @returns {number} the new position
 */
export function springStep(s, target, omega, dt) {
  if (!(dt > 0)) return s.x;
  const y = s.x - target;
  const e = Math.exp(-omega * dt);
  const c = s.v + omega * y;
  s.x = target + (y + c * dt) * e;
  s.v = (s.v - omega * c * dt) * e;
  return s.x;
}

/**
 * Under-damped spring (0 < zeta < 1), exact step: a natural motion with a slight rebound (a nod
 * that settles), or with zeta >= 1 the critically damped one.
 * @param {{ x: number, v: number }} s @param {number} target @param {number} omega
 * @param {number} zeta @param {number} dt
 */
export function spring2Step(s, target, omega, zeta, dt) {
  if (!(dt > 0)) return s.x;
  if (zeta >= 1) return springStep(s, target, omega, dt);
  const y0 = s.x - target;
  const v0 = s.v;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const a = zeta * omega;
  const e = Math.exp(-a * dt);
  const c = Math.cos(wd * dt), sn = Math.sin(wd * dt);
  const B = (v0 + a * y0) / wd;
  // y(t) = e^{-a t} (y0 cos wd t + B sin wd t), and its derivative
  s.x = target + e * (y0 * c + B * sn);
  s.v = e * ((B * wd - a * y0) * c - (a * B + wd * y0) * sn);
  return s.x;
}

/** A critically damped spring with its own state. */
export class Spring {
  /** @param {number} [x] */
  constructor(x = 0) {
    this.x = x;
    this.v = 0;
  }

  /** @param {number} target @param {number} omega @param {number} dt */
  step(target, omega, dt) {
    return springStep(this, target, omega, dt);
  }

  /** Jump to `x` at rest. @param {number} x */
  set(x) {
    this.x = x;
    this.v = 0;
    return x;
  }
}

/** Minimum-jerk 0 -> 1 (zero velocity and acceleration at both ends). @param {number} u */
export function minJerk(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/** d/du of minJerk. @param {number} u */
export function minJerkVel(u) {
  if (u <= 0 || u >= 1) return 0;
  const w = u * (1 - u);
  return 30 * w * w;
}

/**
 * A pulse 0 -> 1 -> 0: minimum-jerk up over `a` seconds, back down over `r` (zero velocity at
 * its start, its peak and its end). x: seconds since it started.
 * @param {number} x @param {number} a @param {number} r
 */
export function pulse(x, a, r) {
  if (x <= 0) return 0;
  if (x < a) return minJerk(x / a);
  if (x < a + r) return 1 - minJerk((x - a) / r);
  return 0;
}

/**
 * Attack / hold / release envelope with minimum-jerk ramps (0..1), x seconds after it started.
 * @param {number} x @param {number} a @param {number} h @param {number} r
 */
export function envelope(x, a, h, r) {
  if (x <= 0) return 0;
  if (x < a) return minJerk(x / a);
  if (x < a + h) return 1;
  return 1 - minJerk((x - a - h) / r);
}

/**
 * One Euro filter (Casiez, Roussel & Vogel 2012): a low-pass whose cutoff rises with the speed,
 * so a still input stays still (heavy smoothing) and a moving one is followed with little lag.
 * Time in seconds.
 */
export class OneEuro {
  /** @param {number} [minCutoff] Hz @param {number} [beta] @param {number} [dCutoff] Hz */
  constructor(minCutoff = 0.5, beta = 8, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    /** @type {number|null} */
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  /** @param {number} cutoff @param {number} dt */
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param {number} x the new sample @param {number} t its time (s) */
  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.dx = 0;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }

  /** Forget the history (the next sample is taken as it is). */
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** Integer hash -> [0, 1). */
function hash(n, seed) {
  let h = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** C2 value-gradient noise in about [-1, 1] that is not 0 on its lattice (unlike plain gradient noise). */
function vgNoise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash(i, seed) * 2 - 1, g1 = hash(i + 1, seed) * 2 - 1;
  const v0 = hash(i, seed + 7919) * 2 - 1, v1 = hash(i + 1, seed + 7919) * 2 - 1;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const grad = g0 * f + (g1 * (f - 1) - g0 * f) * u;
  const val = v0 + (v1 - v0) * u;
  return 0.55 * val + 1.1 * grad;
}

/** rms of one octave of vgNoise (measured over 8 seeds x 4000 s: 0.3206) */
const VG_RMS = 0.3206;

/**
 * 1/f-like noise of time: `octaves` layers from `f0` Hz up, each `lacunarity` x faster (a
 * non-integer ratio, and a random phase per layer and seed, so their lattice points never line
 * up) and `gain` x weaker (gain = lac^(-beta/2) for a position spectrum ~ 1/f^beta). Smooth
 * (C2), deterministic, non-repeating; unit rms for any octave count (the layers are independent,
 * so it is normalised by their root-sum-square), peaks about +-3.
 * @param {number} t seconds @param {number} seed
 * @param {{ f0?: number, octaves?: number, lacunarity?: number, gain?: number }} [o]
 */
export function pinkNoise(t, seed, o = {}) {
  const f0 = o.f0 ?? 0.07, n = o.octaves ?? 5, lac = o.lacunarity ?? 1.93, gain = o.gain ?? 0.62;
  let sum = 0, amp = 1, f = f0, norm2 = 0;
  for (let k = 0; k < n; k++) {
    const s = (seed | 0) * 31 + k * 1013;
    sum += amp * vgNoise(t * f + 97.3 * hash(k, s), s);
    norm2 += amp * amp;
    amp *= gain;
    f *= lac;
  }
  return sum / (Math.sqrt(norm2) * VG_RMS);
}

/** Standard normal from a uniform generator (Box-Muller, one value). @param {() => number} rng */
export function gauss(rng) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal draw: `median` x e^(sigma * N(0, 1)), clamped to [lo, hi].
 * @param {() => number} rng @param {number} median @param {number} sigma @param {number} [lo] @param {number} [hi]
 */
export function logNormal(rng, median, sigma, lo = 0, hi = Infinity) {
  const v = median * Math.exp(sigma * gauss(rng));
  return v < lo ? lo : v > hi ? hi : v;
}
