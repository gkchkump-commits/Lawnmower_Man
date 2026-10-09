// Prosody of a voice clip, from its samples: a loudness envelope and the pitch (F0) contour, and
// from those the speech events a speaker's face and head follow: stressed syllables (pitch and
// loudness peaks), phrase ends with their final fall or rise, pauses, breaths before phrases.
//
// Pure and incremental. The loudness envelope of a whole clip costs well under a millisecond and
// is computed at once; the pitch (YIN, de Cheveigné & Kawahara 2002, on a low-passed signal
// decimated to ~6 kHz) costs ~25 µs per 10 ms frame and is computed a bounded number of frames at
// a time (`advance`), so a frame of the app never spends more than a millisecond or two on it,
// while the analysis still runs many times faster than the audio plays.

/** Analysis frame step (s). */
export const HOP = 0.01;
/** Loudness window (s), centred on the frame time. */
const E_WIN = 0.03;
/** Pitch search range (Hz): low male voices to high female ones. */
const F_MIN = 60;
const F_MAX = 500;
/** YIN: cumulative-mean-normalised difference threshold, and the worst value still called voiced. */
const YIN_THRESHOLD = 0.15;
const YIN_UNVOICED = 0.38;
/** Frames quieter than this (dB below the clip's loudest frame) are not analysed for pitch. */
const PITCH_GATE_DB = -40;
const FLOOR_DB = -80;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Semitones of f relative to ref. @param {number} f @param {number} ref */
export function semitones(f, ref) {
  return 12 * Math.log2(f / ref);
}

/**
 * Biquad low-pass coefficients (RBJ cookbook). @param {number} fc @param {number} fs @param {number} q
 * @returns {number[]} [b0, b1, b2, a1, a2] (a0 = 1)
 */
function lowpass(fc, fs, q) {
  const w = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w), al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
}

/**
 * Loudness envelope: RMS over E_WIN around each frame, in dB relative to the loudest frame
 * (0 dB), floored at FLOOR_DB. @param {Float32Array} x @param {number} sr @param {number} n frames
 */
export function energyEnvelope(x, sr, n) {
  const out = new Float32Array(n);
  const half = Math.max(1, Math.round((E_WIN * sr) / 2));
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = Math.round(i * HOP * sr);
    const a = Math.max(0, c - half), b = Math.min(x.length, c + half);
    let acc = 0;
    for (let j = a; j < b; j++) acc += x[j] * x[j];
    const db = b > a ? 10 * Math.log10(acc / (b - a) + 1e-12) : -120;
    out[i] = db;
    if (db > peak) peak = db;
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(FLOOR_DB, out[i] - peak);
  return out;
}

/**
 * YIN pitch of one window. @param {Float32Array} x decimated signal @param {number} s window start
 * @param {number} W window length @param {number} tauMin @param {number} tauMax
 * @param {Float32Array} d scratch (tauMax + 2) @returns {{ tau: number, clarity: number }} tau 0 = unvoiced
 */
export function yinWindow(x, s, W, tauMin, tauMax, d) {
  // difference function d(tau) = sum (x_j - x_{j+tau})^2
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let acc = 0;
    for (let j = 0; j < W; j++) {
      const v = x[s + j] - x[s + j + tau];
      acc += v * v;
    }
    d[tau] = acc;
  }
  // cumulative mean normalised difference
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    run += d[tau];
    d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    // no dip under the threshold: the global minimum, if it is still periodic enough
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < m) { m = d[tau]; best = tau; }
    if (!(m < YIN_UNVOICED)) return { tau: 0, clarity: clamp01(1 - m) };
  }
  return refineDip(d, best);
}

/** Parabolic interpolation of the CMNDF dip at integer lag `best`. @param {Float32Array} d @param {number} best */
function refineDip(d, best) {
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const den = a - 2 * b + c;
  const shift = den > 1e-12 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
  return { tau: best + shift, clarity: clamp01(1 - b) };
}

/**
 * Octave correction: the periodic dip of the CMNDF nearest to lag `tau` (+-8 %), if it is a
 * usable one, else null. YIN's classic errors are a period twice (or half) the true one; the
 * caller asks for the alternative that keeps the contour continuous.
 * @param {Float32Array} d CMNDF from the last yinWindow call @param {number} tau @param {number} tauMin @param {number} tauMax
 */
export function dipNear(d, tau, tauMin, tauMax) {
  const lo = Math.max(tauMin, Math.floor(tau * 0.92)), hi = Math.min(tauMax, Math.ceil(tau * 1.08));
  let best = -1, m = YIN_UNVOICED;
  for (let k = lo; k <= hi; k++) if (d[k] < m && d[k] <= d[k - 1] && d[k] <= d[k + 1]) { m = d[k]; best = k; }
  return best > 0 ? refineDip(d, best) : null;
}

/**
 * Loudness and pitch of one clip, frame by frame (HOP). `energy` is complete on construction;
 * `f0` (Hz; 0 = unvoiced or silent; NaN = not analysed yet) fills in as `advance()` is called.
 */
export class VoiceAnalysis {
  /**
   * @param {Float32Array} samples mono @param {number} sampleRate
   * @param {{ refHz?: number }} [o] refHz: the speaker's usual pitch, if known (steadies the octave
   *   check of the first frames)
   */
  constructor(samples, sampleRate, o = {}) {
    this.refHz = o.refHz > 0 ? o.refHz : 0;
    this._recent = new Float32Array(48);
    this._ri = 0;
    this._rc = 0;
    this._rcv = 0;
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.duration = samples.length / sampleRate;
    this.n = Math.max(1, Math.ceil(this.duration / HOP));
    this.energy = energyEnvelope(samples, sampleRate, this.n);
    this.f0 = new Float32Array(this.n).fill(NaN);
    this.clarity = new Float32Array(this.n);
    /** frames analysed for pitch (0..n) */
    this.done = 0;
    // pitch runs on a ~1 kHz low-passed copy decimated to ~6 kHz (made as the analysis proceeds)
    this.dec = Math.max(1, Math.round(sampleRate / 6000));
    this.fs = sampleRate / this.dec;
    this.W = Math.round(0.02 * this.fs);
    this.tauMin = Math.max(2, Math.floor(this.fs / F_MAX));
    this.tauMax = Math.ceil(this.fs / F_MIN);
    this._x = new Float32Array(Math.ceil(samples.length / this.dec) + 1);
    this._xn = 0;   // decimated samples made
    this._src = 0;  // source samples filtered
    this._bq = [lowpass(1000, sampleRate, 0.5412), lowpass(1000, sampleRate, 1.3066)]; // 4th-order Butterworth
    this._z = new Float64Array(4);
    this._d = new Float32Array(this.tauMax + 3);
  }

  get complete() { return this.done >= this.n; }

  /** Frame index of time t (clamped). @param {number} t */
  frame(t) {
    return clamp(Math.round(t / HOP), 0, this.n - 1);
  }

  /** Loudness (dB re the loudest frame) at t, linearly interpolated. @param {number} t */
  energyAt(t) {
    const x = t / HOP;
    if (!(x > 0)) return this.energy[0];
    if (x >= this.n - 1) return this.energy[this.n - 1];
    const i = Math.floor(x), f = x - i;
    return this.energy[i] * (1 - f) + this.energy[i + 1] * f;
  }

  /** Filter + decimate the source up to decimated index `need` (exclusive). */
  _decimate(need) {
    const x = this.samples, out = this._x, D = this.dec;
    const [p, q] = this._bq, z = this._z;
    const until = Math.min(x.length, need * D);
    for (let i = this._src; i < until; i++) {
      // two cascaded biquads (transposed direct form II)
      const v = x[i];
      const y1 = p[0] * v + z[0];
      z[0] = p[1] * v - p[3] * y1 + z[1];
      z[1] = p[2] * v - p[4] * y1;
      const y2 = q[0] * y1 + z[2];
      z[2] = q[1] * y1 - q[3] * y2 + z[3];
      z[3] = q[2] * y1 - q[4] * y2;
      if (i % D === 0) out[this._xn++] = y2;
    }
    this._src = Math.max(this._src, until);
  }

  /**
   * Analyse the pitch of up to `maxFrames` more frames (all of them by default).
   * @param {number} [maxFrames] @returns {number} frames analysed now
   */
  advance(maxFrames = Infinity) {
    const end = Math.min(this.n, this.done + maxFrames);
    const W = this.W, d = this._d;
    let k = 0;
    for (let i = this.done; i < end; i++, k++) {
      const s = Math.round(i * HOP * this.fs - W / 2);
      if (this.energy[i] < PITCH_GATE_DB || s < 0) {
        this.f0[i] = 0;
        continue;
      }
      const need = s + W + this.tauMax + 2;
      if (need > this._xn) this._decimate(need);
      if (need > this._xn) { this.f0[i] = 0; continue; } // the clip ends inside the window
      let r = yinWindow(this._x, s, W, this.tauMin, this.tauMax, d);
      const c = this._center();
      if (r.tau > 0 && c > 0) {
        // keep the contour continuous: an octave slip (+-12 st from the voice's centre) takes the
        // dip at the other octave when there is one; a far outlier without one is not trusted
        const st = semitones(this.fs / r.tau, c);
        const alt = st > 8 ? dipNear(d, r.tau * 2, this.tauMin, this.tauMax) : st < -7 ? dipNear(d, r.tau / 2, this.tauMin, this.tauMax) : null;
        if (alt && Math.abs(semitones(this.fs / alt.tau, c)) < Math.abs(st)) r = alt;
        else if (st > 11 || st < -10) r = { tau: 0, clarity: r.clarity };
      }
      this.f0[i] = r.tau > 0 ? this.fs / r.tau : 0;
      this.clarity[i] = r.clarity;
      if (r.tau > 0) {
        this._recent[this._ri++ % this._recent.length] = this.f0[i];
        this._rc = 0;
      }
    }
    this.done = end;
    return k;
  }

  /** The voice's centre pitch (Hz): the median of the last voiced frames, or the given reference. */
  _center() {
    const n = Math.min(this._ri, this._recent.length);
    if (n < 8) return this.refHz;
    if (this._rc > 0) return this._rcv;
    const v = Array.from(this._recent.subarray(0, n)).sort((x, y) => x - y);
    this._rcv = v[n >> 1];
    this._rc = 1;
    return this._rcv;
  }

  /** Analyse up to time t (s), at most maxFrames now. @param {number} t @param {number} [maxFrames] */
  advanceTo(t, maxFrames = Infinity) {
    const want = clamp(Math.ceil(t / HOP) + 1, 0, this.n);
    return want > this.done ? this.advance(Math.min(maxFrames, want - this.done)) : 0;
  }

  /** True when the pitch of every frame up to time t is known. @param {number} t */
  readyTo(t) {
    return this.done >= Math.min(this.n, Math.ceil(t / HOP) + 1);
  }

  /**
   * Robust pitch at frame i: the median of the voiced frames in i-2..i+2 (octave slips and single
   * stray frames removed), 0 when fewer than 2 of them are voiced or not analysed.
   * @param {number} i
   */
  pitch(i) {
    const v = _med;
    let n = 0;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j < 0 || j >= this.done) continue;
      const f = this.f0[j];
      if (f > 0) v[n++] = f;
    }
    if (n < 2 || !(this.f0[clamp(i, 0, this.n - 1)] >= 0)) return 0;
    for (let a = 1; a < n; a++) for (let b = a; b > 0 && v[b - 1] > v[b]; b--) { const t = v[b]; v[b] = v[b - 1]; v[b - 1] = t; }
    return n & 1 ? v[n >> 1] : 0.5 * (v[(n >> 1) - 1] + v[n >> 1]);
  }

  /** Median pitch (Hz) of the voiced frames analysed so far in [t0, t1) (0 if none). */
  medianPitch(t0 = 0, t1 = this.duration) {
    const a = this.frame(t0), b = Math.min(this.done, Math.ceil(t1 / HOP));
    const v = [];
    for (let i = a; i < b; i++) if (this.f0[i] > 0) v.push(this.f0[i]);
    if (!v.length) return 0;
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  }
}
const _med = new Float32Array(5);

// ---------------------------------------------------------------------------------------------
// Speech events from a clip's analysis and its viseme timeline
// ---------------------------------------------------------------------------------------------

const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U']);

/**
 * @typedef {{ start: number, end: number, viseme: string }} VisemeSegment
 * @typedef {{ start: number, end: number, rest: number }} Phrase   speech between rests >= 100 ms;
 *   rest: the silence after it (s; Infinity after the last one)
 * @typedef {{ t: number, type: string, strength: number, punct?: string, friendly?: number,
 *   fall?: number, rise?: number, pause?: number, lead?: number }} Cue   lead: an inhale's time
 *   before the voice starts again (s)
 */

/**
 * Phrases of a timeline: runs of sound between rests of at least `minRest` s.
 * @param {VisemeSegment[]} tl @param {number} [minRest] @returns {Phrase[]}
 */
export function phrasesOf(tl, minRest = 0.1) {
  /** @type {Phrase[]} */
  const out = [];
  let start = NaN, last = NaN;
  for (const s of tl) {
    const rest = s.viseme === 'sil';
    if (!rest) {
      if (!Number.isFinite(start)) start = s.start;
      last = s.end;
    } else if (Number.isFinite(start) && s.end - s.start >= minRest) {
      out.push({ start, end: last, rest: Infinity });
      start = NaN;
    }
  }
  if (Number.isFinite(start)) out.push({ start, end: last, rest: Infinity });
  for (let k = 0; k + 1 < out.length; k++) out[k].rest = out[k + 1].start - out[k].end;
  return out;
}

/**
 * Where the voice really stops at the end of a phrase: the last frame before `end` (searching
 * back at most `maxTrim` s) louder than `quietDb`. Kokoro gives a phrase-final consonant the
 * pause's time too (a 200 ms "d" before a full stop); the mouth should rest when the sound does.
 * @param {VoiceAnalysis} a @param {number} start @param {number} end @param {number} [quietDb]
 * @param {number} [maxTrim]
 */
export function audibleEnd(a, start, end, quietDb = -36, maxTrim = 0.25) {
  const lo = Math.max(a.frame(start), a.frame(end - maxTrim));
  for (let i = a.frame(end); i >= lo; i--) if (a.energy[i] > quietDb) return Math.min(end, (i + 1) * HOP);
  return Math.max(start, end - maxTrim);
}

/**
 * Peak loudness (dB) of a time span. @param {VoiceAnalysis} a @param {number} t0 @param {number} t1
 */
export function peakEnergy(a, t0, t1) {
  let m = FLOOR_DB;
  for (let i = a.frame(t0); i <= a.frame(t1); i++) if (a.energy[i] > m) m = a.energy[i];
  return m;
}

/**
 * Pitch features of a span: the highest smoothed pitch (st re ref) and how far it rose from the
 * lowest point in the `back` s before (st). NaN when unvoiced or not analysed.
 * @param {VoiceAnalysis} a @param {number} t0 @param {number} t1 @param {number} ref Hz @param {number} [back]
 */
export function pitchPeak(a, t0, t1, ref, back = 0.25) {
  let hi = -Infinity, lo = Infinity;
  for (let i = a.frame(t0 - back); i <= a.frame(t1); i++) {
    const f = a.pitch(i);
    if (!(f > 0)) continue;
    const st = semitones(f, ref);
    if (i * HOP >= t0 - HOP) hi = Math.max(hi, st);
    if (i * HOP <= t0 + 0.04) lo = Math.min(lo, st);
  }
  if (!Number.isFinite(hi)) return { st: NaN, rise: NaN };
  return { st: hi, rise: Number.isFinite(lo) ? Math.max(0, hi - lo) : 0 };
}

/**
 * Final pitch movement of a phrase (st): fall = how far the last voiced stretch drops below its
 * highest point in the last `win` s (>= 0); rise = how far it ends above its lowest point there.
 * @param {VoiceAnalysis} a @param {number} end @param {number} ref @param {number} [win]
 */
export function finalContour(a, end, ref, win = 0.4) {
  const v = [];
  for (let i = a.frame(end - win); i <= a.frame(end); i++) {
    const f = a.pitch(i);
    if (f > 0) v.push(semitones(f, ref));
  }
  // the last couple of voiced frames are often creaky (irregular): leave them out
  if (v.length > 6) v.length -= 2;
  if (v.length < 3) return { fall: 0, rise: 0 };
  const last = (v[v.length - 1] + v[v.length - 2] + v[v.length - 3]) / 3;
  const hi = Math.max(...v), lo = Math.min(...v);
  return { fall: clamp(hi - last, 0, 12), rise: clamp(last - lo, 0, 12) };
}

/**
 * How prominent a vowel is (0..1): its pitch peak above the speaker's reference and the rise into
 * it (pitch accents are high, rising syllables), its loudness against the clip's typical vowel,
 * and its length. Without pitch (unvoiced, or not analysed yet) loudness and length decide.
 * @param {{ st: number, rise: number }} p @param {number} eRel dB above the clip's median vowel peak
 * @param {number} durRel duration / the median vowel's
 */
export function prominence(p, eRel, durRel) {
  const loud = clamp01((eRel + 4) / 9);
  const long = clamp01((durRel - 0.7) / 1.3);
  if (!Number.isFinite(p.st)) return clamp01(0.62 * loud + 0.38 * long);
  const high = clamp01((p.st + 1) / 5);
  const rising = clamp01(p.rise / 3);
  return clamp01(0.32 * high + 0.23 * rising + 0.3 * loud + 0.15 * long);
}

/** Accents: the prominence a vowel needs (as the local maximum, or on its own), the least time
 * between two accents (s), and how far around a vowel its rivals are looked for (s). */
export const ACCENT_MIN = 0.45;
export const ACCENT_STRONG = 0.8;
export const ACCENT_GAP = 0.26;
export const ACCENT_NEAR = 0.3;

/** Median of the peak loudness of a timeline's vowels (dB) and of their durations (s). */
export function vowelNorms(a, tl) {
  const e = [], d = [];
  for (const s of tl) {
    if (!VOWELS.has(s.viseme)) continue;
    e.push(peakEnergy(a, s.start, s.end));
    d.push(s.end - s.start);
  }
  const med = (v, dflt) => (v.length ? v.sort((x, y) => x - y)[v.length >> 1] : dflt);
  return { energy: med(e, -6), dur: med(d, 0.09) };
}

/**
 * The timeline with each phrase's last sound cut where the voice really stops (audibleEnd); the
 * rest of the pause becomes `sil`. Returns a new array (the input is not changed).
 * @param {VisemeSegment[]} tl @param {VoiceAnalysis} a @returns {VisemeSegment[]}
 */
export function trimPhraseEnds(tl, a) {
  const out = tl.map((s) => ({ ...s }));
  for (const p of phrasesOf(out)) {
    const ae = audibleEnd(a, p.start, p.end);
    if (!(ae < p.end - 0.03)) continue;
    for (const s of out) {
      if (s.viseme === 'sil' || s.end <= ae || s.start >= p.end) continue;
      if (s.start >= ae - 0.03) s.viseme = 'sil';      // a sound that is not heard at all
      else s.end = ae;
    }
  }
  // close the gaps the cut left with rest, and merge neighbouring rests
  const res = [];
  for (const s of out) {
    const prev = res[res.length - 1];
    if (prev && s.start > prev.end + 1e-6) res.push({ start: prev.end, end: s.start, viseme: 'sil' });
    const last = res[res.length - 1];
    if (last && last.viseme === 'sil' && s.viseme === 'sil') last.end = s.end;
    else res.push(s);
  }
  return res;
}

/**
 * The text's phrase end (punctuation, friendliness) that belongs to audio phrase k: one each when
 * the counts agree; otherwise the last phrase takes the last end and the others the end nearest
 * in relative position (`pos`, 0..1 through the text) — a voice does not pause at every comma,
 * and sometimes pauses where the text has none.
 * @param {Array<{ punct?: string, friendly?: number, pos?: number }>} ends @param {Phrase[]} P @param {number} k
 */
export function endFor(ends, P, k) {
  if (!ends.length) return null;
  if (ends.length === P.length) return ends[k];
  if (k === P.length - 1) return ends[ends.length - 1];
  const pos = P[k].end / Math.max(1e-6, P[P.length - 1].end);
  let best = null, d = Infinity;
  for (const e of ends.slice(0, -1)) {
    const dd = Math.abs((e.pos ?? 0) - pos);
    if (Number.isFinite(e.pos) && dd < d) { d = dd; best = e; }
  }
  return d < 0.25 ? best : null;
}

/**
 * The speech events of one clip as it plays, from its analysis and timeline:
 *   inhale        before the first phrase and in pauses >= 0.22 s (a breath before speaking on)
 *   phrase-start  each phrase (strength 1 for the first)
 *   accent        stressed syllables: vowels whose pitch, rise, loudness and length stand out
 *   emphasis      an accent high above the speaker's usual pitch (a brow raise)
 *   phrase-end    where the voice stops, with its final pitch fall / rise (st), the pause that
 *                 follows (s), and the punctuation / friendliness of the text's phrase
 * Cues are decided as late as possible (an accent once its vowel is analysed, at most a few
 * frames before it is due) and handed out in time order by take().
 */
export class ClipProsody {
  /**
   * @param {VoiceAnalysis} analysis @param {VisemeSegment[]} tl the (trimmed) timeline
   * @param {{ ref?: () => number, ends?: Array<{ punct?: string, friendly?: number }> }} [o]
   *   ref: the speaker's reference pitch (Hz) now; ends: the text's phrase ends, in order
   */
  constructor(analysis, tl, o = {}) {
    this.a = analysis;
    this.tl = tl;
    this.ref = o.ref || (() => analysis.medianPitch() || 150);
    this.phrases = phrasesOf(tl);
    this.norms = vowelNorms(analysis, tl);
    const ends = o.ends || [];
    /** @type {Array<{ t: number, need: number, make: () => (Cue|Cue[]|null) }>} */
    const items = [];
    const P = this.phrases;
    P.forEach((p, k) => {
      // a breath before the phrase: in the clip's leading silence, or early in a long pause
      // (lead: the time it has before the voice starts again)
      if (k === 0 && p.start >= 0.05) items.push({ t: 0, need: 0, make: () => ({ t: 0, type: 'inhale', strength: clamp01(0.55 + p.start / 0.4), lead: p.start }) });
      if (k > 0 && P[k - 1].rest >= 0.22) {
        const t = P[k - 1].end + 0.04;
        items.push({ t, need: 0, make: () => ({ t, type: 'inhale', strength: clamp01(P[k - 1].rest / 0.6), lead: p.start - t }) });
      }
      items.push({ t: p.start, need: 0, make: () => ({ t: p.start, type: 'phrase-start', strength: k === 0 ? 1 : 0.7 }) });
      const vs = tl.filter((s) => s.start >= p.start && s.end <= p.end + 1e-6 && VOWELS.has(s.viseme));
      for (const s of vs) {
        // decided against the vowels around it: up to ACCENT_NEAR s later must be analysed
        const near = vs.filter((x) => x !== s && Math.abs(x.start - s.start) <= ACCENT_NEAR);
        const need = Math.max(s.end, ...near.map((x) => x.end)) + 0.03;
        items.push({ t: s.start, need, make: () => this._accent(s, near) });
      }
      const e = endFor(ends, P, k);
      items.push({
        t: p.end,
        need: p.end + 0.03,
        make: () => {
          const c = finalContour(analysis, p.end, this.ref());
          return {
            t: p.end, type: 'phrase-end', strength: 1, punct: e?.punct || (k === P.length - 1 ? '.' : ','),
            friendly: e?.friendly || 0, fall: c.fall, rise: c.rise, pause: p.rest,
          };
        },
      });
    });
    items.sort((x, y) => x.t - y.t);
    this.items = items;
    this.i = 0;
    /** @type {Map<VisemeSegment, { p: { st: number, rise: number }, score: number }>} */
    this._scores = new Map();
    this._lastAccent = -Infinity;
    this._lastEmph = -Infinity;
  }

  /** Prominence of a vowel (cached once its frames are analysed). @param {VisemeSegment} s */
  score(s) {
    const hit = this._scores.get(s);
    if (hit) return hit;
    const p = pitchPeak(this.a, s.start, s.end, this.ref());
    const r = { p, score: prominence(p, peakEnergy(this.a, s.start, s.end) - this.norms.energy, (s.end - s.start) / this.norms.dur) };
    if (this.a.readyTo(s.end + 0.03)) this._scores.set(s, r);
    return r;
  }

  /**
   * An accent on vowel s when it is prominent and stands out from the vowels around it (a
   * stressed syllable beats its neighbours; a run of loud syllables gets one accent, not five).
   * @param {VisemeSegment} s @param {VisemeSegment[]} near @returns {Cue[]|null}
   */
  _accent(s, near) {
    const { p, score } = this.score(s);
    if (s.start - this._lastAccent < ACCENT_GAP) return null;
    const best = near.reduce((m, x) => Math.max(m, this.score(x).score), 0);
    if (!(score >= ACCENT_STRONG || (score >= ACCENT_MIN && score >= best - 0.02))) return null;
    this._lastAccent = s.start;
    /** @type {Cue[]} */
    const out = [{ t: s.start, type: 'accent', strength: clamp01((score - 0.3) / 0.5) }];
    // well above the speaker's usual pitch and rising into it: an emphasised word (brows)
    if (p.st >= 5 && p.rise >= 3 && score >= 0.6 && s.start - this._lastEmph >= 2) {
      this._lastEmph = s.start;
      out.push({ t: s.start, type: 'emphasis', strength: clamp01((p.st - 3) / 6) });
    }
    return out;
  }

  /**
   * Cues due by clip time t (s), in order; cues that are more than `late` s overdue (a seek, a
   * stall) are dropped. @param {number} t @param {number} [late] @returns {Cue[]|null}
   */
  take(t, late = 0.4) {
    let out = null;
    while (this.i < this.items.length && this.items[this.i].t <= t) {
      const it = this.items[this.i++];
      if (t - it.t >= late) continue;
      const c = it.make();
      if (!c) continue;
      (out ||= []).push(...(Array.isArray(c) ? c : [c]));
    }
    return out;
  }

  /** Clip time up to which the pitch must be known for the cues due by t. @param {number} t */
  needBy(t) {
    let need = 0;
    for (let k = this.i; k < this.items.length && this.items[k].t <= t; k++) need = Math.max(need, this.items[k].need);
    return need;
  }

  /**
   * Intonation at clip time t: pitch in semitones above (+) or below the speaker's reference
   * (0 when unvoiced) and whether the voice is voiced there.
   * @param {number} t @returns {{ pitch: number, voiced: boolean }}
   */
  intonation(t) {
    const f = this.a.pitch(this.a.frame(t));
    return f > 0 ? { pitch: semitones(f, this.ref()), voiced: true } : { pitch: 0, voiced: false };
  }
}

export { VOWELS as PROSODY_VOWELS };
