// Acoustic articulation of a voice clip: what the sound itself says the mouth is doing, frame by
// frame (5 ms), so the lip-sync can take the AMOUNTS and the exact TIMING of the mouth from the
// audio while the viseme timeline gives the shapes (src/audio/fusion.js):
//   e         loudness (dBFS): syllable nuclei, closures, pauses
//   lo / hi   loudness below 400 Hz / above 3 kHz (dBFS): a nasal murmur
//             (m n) keeps its low band while the rest falls away; frication (s f sh) lives up high
//   mid       loudness of 0.8-5 kHz (dBFS): the vowel's upper formants. It falls away in any closure,
//             a nasal murmur's too, and its steepest rise is where the lips part (the burst of a
//             b / p, the end of an m's murmur)
//   f1 f2 f3  formants (Hz, 0 = none) from LPC: F1 rises as the jaw opens, F2 rises with spread /
//             front vowels and falls with rounding, F3 falls with rounding and r
//   voiced    periodicity 0..1 (normalised autocorrelation at the pitch period)
// Pure, deterministic and incremental (`advance(maxFrames)`): it runs in a worker
// (acoustics-worker.js) while earlier clips play, or a few frames at a time on the main thread.

/** Analysis hop (s). */
export const AC_HOP = 0.005;
const E_WIN = 0.015;        // loudness window (s)
const LPC_WIN = 0.025;      // formant analysis window (s)
const VOICE_WIN = 0.03;     // periodicity window (s)
const FLOOR_DB = -80;
const FORMANT_GATE_DB = -52; // quieter frames (dBFS) get no formants
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** RBJ biquad coefficients [b0, b1, b2, a1, a2] (a0 = 1). @param {'lp'|'hp'} type */
function biquad(type, fc, fs, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * Math.min(fc, 0.45 * fs)) / fs;
  const c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  if (type === 'lp') return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
}

/** Run biquads in cascade over x (a new array). @param {Float32Array} x @param {number[][]} stages */
function filter(x, stages) {
  let y = x;
  for (const [b0, b1, b2, a1, a2] of stages) {
    const out = new Float32Array(y.length);
    let z1 = 0, z2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = b0 * v + z1;
      z1 = b1 * v - a1 * o + z2;
      z2 = b2 * v - a2 * o;
      out[i] = o;
    }
    y = out;
  }
  return y;
}

/** RMS (dBFS, floored) of x[a, b). */
function rmsDb(x, a, b) {
  let acc = 0;
  for (let j = a; j < b; j++) acc += x[j] * x[j];
  return b > a ? Math.max(FLOOR_DB, 10 * Math.log10(acc / (b - a) + 1e-12)) : FLOOR_DB;
}

/**
 * LPC coefficients of a windowed frame (autocorrelation method, Levinson-Durbin).
 * @param {Float32Array} x @param {number} s start @param {number} N length @param {Float32Array} w window
 * @param {number} p order @param {Float64Array} r scratch (p + 1) @param {Float64Array} a out (p + 1, a[0] = 1)
 * @param {Float64Array} tmp scratch (p + 1) @returns {boolean} false for a silent / singular frame
 */
export function lpc(x, s, N, w, p, r, a, tmp) {
  for (let k = 0; k <= p; k++) {
    let acc = 0;
    for (let j = 0; j + k < N; j++) acc += x[s + j] * w[j] * x[s + j + k] * w[j + k];
    r[k] = acc;
  }
  if (!(r[0] > 1e-10)) return false;
  r[0] *= 1 + 1e-5; // a little white-noise floor (numerical stability)
  a.fill(0);
  a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    for (let j = 0; j <= i; j++) tmp[j] = a[j];
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (!(err > 1e-14)) return false;
  }
  return true;
}

/**
 * Complex roots of z^p + a1 z^(p-1) + ... + ap (Durand-Kerner), warm-started from `re` / `im`
 * when `warm` (the previous frame's roots: a few iterations instead of dozens).
 * @param {Float64Array} a coefficients (a[0] = 1) @param {number} p
 * @param {Float64Array} re @param {Float64Array} im in/out roots @param {boolean} warm
 */
export function polyRoots(a, p, re, im, warm) {
  if (!warm) {
    // (0.4 + 0.9i)^k: the classic start, no two alike and none on the real axis
    let zr = 1, zi = 0;
    for (let k = 0; k < p; k++) {
      const nr = zr * 0.4 - zi * 0.9, ni = zr * 0.9 + zi * 0.4;
      zr = nr; zi = ni;
      re[k] = zr; im[k] = zi;
    }
  }
  for (let it = 0; it < 80; it++) {
    let moved = 0;
    for (let k = 0; k < p; k++) {
      const xr = re[k], xi = im[k];
      // P(x) by Horner
      let pr = 1, pi = 0;
      for (let j = 1; j <= p; j++) {
        const nr = pr * xr - pi * xi + a[j];
        pi = pr * xi + pi * xr;
        pr = nr;
      }
      // prod (x - z_j), j != k
      let dr = 1, di = 0;
      for (let j = 0; j < p; j++) {
        if (j === k) continue;
        const ur = xr - re[j], ui = xi - im[j];
        const nr = dr * ur - di * ui;
        di = dr * ui + di * ur;
        dr = nr;
      }
      const dd = dr * dr + di * di;
      if (!(dd > 1e-30)) { re[k] += 1e-6; im[k] += 1e-6; moved = 1; continue; }
      const qr = (pr * dr + pi * di) / dd, qi = (pi * dr - pr * di) / dd;
      re[k] = xr - qr;
      im[k] = xi - qi;
      const m = Math.abs(qr) + Math.abs(qi);
      if (m > moved) moved = m;
    }
    if (moved < 1e-9) return it + 1;
  }
  return 80;
}

/**
 * Loudness, band loudness, formants and voicing of one clip, 5 ms frames, filled frame by frame
 * by `advance()` (the constructor only filters the signal). Loudness is in dBFS, so a partial
 * analysis (the start of a clip) means the same as the whole one.
 */
export class AcousticAnalysis {
  /** @param {Float32Array} samples mono @param {number} sampleRate */
  constructor(samples, sampleRate) {
    this.sampleRate = sampleRate;
    this.duration = samples.length / sampleRate;
    this.hop = AC_HOP;
    const n = this.n = Math.max(1, Math.ceil(this.duration / AC_HOP));
    this._x = samples;
    // the low band (a nasal murmur, the voicing bar of a voiced closure) and the high band (frication)
    this._lo = filter(samples, [biquad('lp', 400, sampleRate), biquad('lp', 400, sampleRate)]);
    this._hi = filter(samples, [biquad('hp', 3000, sampleRate), biquad('hp', 3000, sampleRate)]);
    this._mid = filter(samples, [biquad('hp', 800, sampleRate), biquad('hp', 800, sampleRate), biquad('lp', 5000, sampleRate), biquad('lp', 5000, sampleRate)]);
    this.e = new Float32Array(n).fill(FLOOR_DB);
    this.lo = new Float32Array(n).fill(FLOOR_DB);
    this.hi = new Float32Array(n).fill(FLOOR_DB);
    this.mid = new Float32Array(n).fill(FLOOR_DB);
    this.f1 = new Float32Array(n);
    this.f2 = new Float32Array(n);
    this.f3 = new Float32Array(n);
    this.voiced = new Float32Array(n);
    this.done = 0;
    this._smoothed = false;
    // formants on a ~11-12 kHz copy (formants up to ~5 kHz), pre-emphasised; voicing on a 1 kHz
    // low-passed copy at ~3 kHz
    const D = Math.max(1, Math.round(sampleRate / 12000));
    this.fs = sampleRate / D;
    const aa = D > 1 ? filter(samples, [biquad('lp', 0.42 * this.fs, sampleRate), biquad('lp', 0.42 * this.fs, sampleRate)]) : samples;
    const y = new Float32Array(Math.ceil(samples.length / D));
    for (let i = 0, k = 0; i < aa.length; i += D, k++) y[k] = aa[i];
    const pre = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) pre[i] = y[i] - 0.94 * (i > 0 ? y[i - 1] : 0);
    this._y = pre;
    const Dv = Math.max(1, Math.round(sampleRate / 3000));
    this.fv = sampleRate / Dv;
    const lv = filter(samples, [biquad('lp', 1000, sampleRate), biquad('lp', 1000, sampleRate)]);
    const v = new Float32Array(Math.ceil(samples.length / Dv));
    for (let i = 0, k = 0; i < lv.length; i += Dv, k++) v[k] = lv[i];
    this._v = v;
    this.p = Math.min(18, Math.round(this.fs / 1000) + 2);
    this._N = Math.round(LPC_WIN * this.fs);
    this._w = new Float32Array(this._N);
    for (let j = 0; j < this._N; j++) this._w[j] = 0.54 - 0.46 * Math.cos((2 * Math.PI * j) / (this._N - 1));
    const p = this.p;
    this._r = new Float64Array(p + 1);
    this._a = new Float64Array(p + 1);
    this._tmp = new Float64Array(p + 1);
    this._re = new Float64Array(p);
    this._im = new Float64Array(p);
    this._warm = false;
    this._cand = [];
  }

  get complete() { return this.done >= this.n; }

  /**
   * Analyse up to `maxFrames` more frames (formants, voicing). @param {number} [maxFrames]
   * @returns {number} frames analysed now
   */
  advance(maxFrames = Infinity) {
    const end = Math.min(this.n, this.done + maxFrames);
    const y = this._y, N = this._N, p = this.p, fs = this.fs;
    let k = 0;
    const sr = this.sampleRate, half = Math.max(1, Math.round((E_WIN * sr) / 2));
    for (let i = this.done; i < end; i++, k++) {
      const c = Math.round(i * AC_HOP * sr);
      const a0 = Math.max(0, c - half), b0 = Math.min(this._x.length, c + half);
      this.e[i] = rmsDb(this._x, a0, b0);
      this.lo[i] = rmsDb(this._lo, a0, b0);
      this.hi[i] = rmsDb(this._hi, a0, b0);
      this.mid[i] = rmsDb(this._mid, a0, b0);
      this.voiced[i] = this._voicing(i);
      if (this.e[i] < FORMANT_GATE_DB) { this._warm = false; continue; }
      const s = Math.round(i * AC_HOP * fs - N / 2);
      if (s < 0 || s + N > y.length) { this._warm = false; continue; }
      if (!lpc(y, s, N, this._w, p, this._r, this._a, this._tmp)) { this._warm = false; continue; }
      polyRoots(this._a, p, this._re, this._im, this._warm);
      this._warm = true;
      this._pick(i);
    }
    this.done = end;
    if (this.done >= this.n && !this._smoothed) this._smooth();
    return k;
  }

  /** Formant candidates of the roots -> F1, F2, F3 of frame i. */
  _pick(i) {
    const fs = this.fs, c = this._cand;
    c.length = 0;
    for (let k = 0; k < this.p; k++) {
      const im = this._im[k];
      if (!(im > 1e-6)) continue;
      const re = this._re[k];
      const mag = Math.hypot(re, im);
      if (!(mag > 0.5 && mag < 1.0001)) continue;
      const f = (Math.atan2(im, re) * fs) / (2 * Math.PI);
      const bw = (-Math.log(mag) * fs) / Math.PI;
      if (f > 150 && f < 0.5 * fs - 150 && bw < 500) c.push(f, bw);
    }
    // (sorted by frequency, few of them: insertion sort on pairs)
    for (let a = 2; a < c.length; a += 2) {
      for (let b = a; b > 0 && c[b - 2] > c[b]; b -= 2) {
        const f = c[b], w = c[b + 1];
        c[b] = c[b - 2]; c[b + 1] = c[b - 1];
        c[b - 2] = f; c[b - 1] = w;
      }
    }
    let f1 = 0, f2 = 0, f3 = 0;
    for (let a = 0; a < c.length; a += 2) {
      const f = c[a], bw = c[a + 1];
      if (!f1) { if (f >= 180 && f <= 1200 && bw < 400) f1 = f; } else if (!f2) { if (f >= Math.max(550, f1 + 150) && f <= 3200) f2 = f; } else if (!f3) { if (f >= f2 + 200 && f <= 4500) { f3 = f; break; } }
    }
    this.f1[i] = f1; this.f2[i] = f2; this.f3[i] = f3;
  }

  /** Periodicity 0..1 of frame i: the normalised autocorrelation at the best lag (60-450 Hz). */
  _voicing(i) {
    if (this.e[i] < FORMANT_GATE_DB - 8) return 0;
    const x = this._v, fs = this.fv;
    const N = Math.round(VOICE_WIN * fs);
    const s = Math.round(i * AC_HOP * fs - N / 2);
    if (s < 0 || s + N + Math.ceil(fs / 60) > x.length) return 0;
    let mean = 0;
    for (let j = 0; j < N; j++) mean += x[s + j];
    mean /= N;
    let e0 = 0;
    for (let j = 0; j < N; j++) { const v = x[s + j] - mean; e0 += v * v; }
    if (!(e0 > 1e-10)) return 0;
    let best = 0;
    for (let L = Math.floor(fs / 450); L <= Math.ceil(fs / 60); L++) {
      let acc = 0, e1 = 0;
      for (let j = 0; j < N; j++) {
        const u = x[s + j + L] - mean;
        acc += (x[s + j] - mean) * u;
        e1 += u * u;
      }
      const r = acc / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) best = r;
    }
    return clamp(best, 0, 1);
  }

  /** A 5-frame median of each formant track over frames that have one (single slips removed). */
  _smooth() {
    this._smoothed = true;
    for (const key of /** @type {const} */ (['f1', 'f2', 'f3'])) {
      const src = this[key], out = new Float32Array(src.length), v = [];
      for (let i = 0; i < src.length; i++) {
        if (!(src[i] > 0)) continue;
        v.length = 0;
        for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < src.length && src[j] > 0) v.push(src[j]);
        v.sort((x, y) => x - y);
        out[i] = v.length >= 3 ? v[v.length >> 1] : src[i];
      }
      this[key] = out;
    }
  }

  /**
   * The analysis as plain transferable data: `done` frames are valid (all of them once complete).
   * @param {boolean} [copy] copies of the arrays (a partial track sent while the rest is analysed)
   * @returns {AcousticTrack}
   */
  toTrack(copy = false) {
    const c = (a) => (copy ? a.slice() : a);
    return {
      hop: AC_HOP, n: this.n, done: this.done, duration: this.duration,
      e: c(this.e), lo: c(this.lo), hi: c(this.hi), mid: c(this.mid), f1: c(this.f1), f2: c(this.f2), f3: c(this.f3), voiced: c(this.voiced),
    };
  }
}

/**
 * @typedef {{ hop: number, n: number, done: number, duration: number, e: Float32Array, lo: Float32Array,
 *   hi: Float32Array, mid?: Float32Array, f1: Float32Array, f2: Float32Array, f3: Float32Array, voiced: Float32Array }} AcousticTrack
 *   e / lo / hi / mid in dBFS (floored at -80), f1-f3 in Hz (0 = none), voiced 0..1; frames >= done
 *   are not analysed yet (mid: absent in tracks made without it, e.g. synthetic test tracks)
 */

/** The whole analysis at once (worker, tests). @param {Float32Array} samples @param {number} sampleRate */
export function analyseAcoustics(samples, sampleRate) {
  const a = new AcousticAnalysis(samples, sampleRate);
  a.advance();
  return a.toTrack();
}

/** Linearly interpolated value of a track array at time t (s). @param {AcousticTrack} tr @param {Float32Array} arr @param {number} t */
export function trackAt(tr, arr, t) {
  const x = t / tr.hop;
  if (!(x > 0)) return arr[0];
  if (x >= tr.n - 1) return arr[tr.n - 1];
  const i = Math.floor(x), f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

/** Frame index of time t (clamped). @param {AcousticTrack} tr @param {number} t */
export function trackFrame(tr, t) {
  return clamp(Math.round(t / tr.hop), 0, tr.n - 1);
}
