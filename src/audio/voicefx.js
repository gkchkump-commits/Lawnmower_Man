// Voice character DSP: turns the local voice (Kokoro) into a synthetic "hologram" voice.
//
// Pure JS over Float32Arrays with no imports, so the very same code runs on the audio thread
// (voicefx-worklet.js, an AudioWorklet) and in Node (unit tests, tools/voicefx/render.mjs for the
// demo files). Streaming with zero latency: every sample out depends only on the input up to it,
// so nothing is delayed and the lip-sync clock (which follows the dry voice) stays exact. The one
// thing taken from ahead of the playhead is the pitch: the player hands over each clip before it
// plays, and ClipPitch analyses it with centred windows (no tracking lag, no octave slips).
//
//   x ─┬─────────────────────────────────────────────────────────────────────────── dry ──┐
//      │   clip → YIN look-ahead (or live YIN) ─► carrier (saw (+ sub-octave) / noise)    │
//      ├─ 28 analysis bands ─► envelopes ─► × carrier bands (per-band normalised) ── vocoder ──┤
//      └─ high-pass ─────────────────────────────────────────────── sibilance (vocoder-heavy) ─┤
//                         ring mod → bit crush → metallic comb → doubler → air shelf → AGC → limiter
//
// Characters: 'natural' (an exact copy), 'synth' (the default: the dry voice with a pitch-locked
// vocoder layer, a doubler, a metallic sheen and air), 'vocoder' (fully vocoded, the pitch snapped
// to semitones), 'robot' (a monotone vocoder with ring modulation and grit). `amount` (0..1)
// scales the wet mix and the intensity; a gated AGC keeps the loudness of the dry voice, and a
// peak limiter keeps every sample inside ±LIMIT.

/** @typedef {'natural'|'synth'|'vocoder'|'robot'} VoiceCharacter */

/** @type {readonly VoiceCharacter[]} */
export const VOICE_CHARACTERS = Object.freeze(['natural', 'synth', 'vocoder', 'robot']);
export const DEFAULT_CHARACTER = /** @type {VoiceCharacter} */ ('synth');
export const DEFAULT_FX_AMOUNT = 0.6;
/** Output peak ceiling. */
export const LIMIT = 0.95;
/** Longest tail (comb, doubler, envelopes, limiter release) the effects can leave, seconds. */
export const TAIL_SEC = 0.25;

const TAU = 2 * Math.PI;

/**
 * Validate a character/amount pair (unknown character → the default, amount clamped to 0..1).
 * @param {{ character?: unknown, amount?: unknown }} [o]
 * @returns {{ character: VoiceCharacter, amount: number }}
 */
export function normalizeFx(o = {}) {
  const character = VOICE_CHARACTERS.includes(/** @type {any} */ (o.character)) ? /** @type {VoiceCharacter} */ (o.character) : DEFAULT_CHARACTER;
  const a = Number(o.amount);
  const amount = Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : DEFAULT_FX_AMOUNT;
  return { character, amount };
}

/**
 * Continuous mix parameters of a character at an amount. Every field is a level or a rate that
 * can be ramped, so switching characters or moving the amount slider never clicks.
 * @param {VoiceCharacter} character @param {number} amount 0..1
 */
export function presetParams(character, amount) {
  const a = Math.min(1, Math.max(0, Number(amount) || 0));
  const p = {
    dry: 1, // the unprocessed voice
    voc: 0, // vocoder layer
    vocGate: 1, // 1: vocoder only on voiced sounds (the dry voice carries the consonants)
    noise: 0, // unvoiced sounds excite the vocoder with noise (0..1)
    hiNoise: 0, // bands above ~4.5 kHz always use noise (crisp s / sh / t)
    sib: 0, // dry high-passed sibilance added back (vocoder-heavy characters)
    mono: 0, // 1: carrier on one note (the clip's median pitch), 0: follows the voice
    sub: 0, // a saw an octave below in the carrier (fills the bands under a monotone)
    snap: 0, // pull the carrier pitch to the nearest semitone (0..1)
    ring: 0, // ring modulation depth (0..1)
    ringHz: 50,
    crush: 0, // bit/sample-rate reduction mix (0..1)
    comb: 0, // metallic comb resonance mix (0..1)
    combHz: 360,
    combFb: 0.5,
    chorus: 0, // doubler mix (0..1)
    air: 0, // high-shelf gain, dB
  };
  switch (character) {
    case 'synth':
      // Intelligibility first: the dry voice stays the strongest layer; the vocoder adds a
      // perfectly periodic, buzz-bright copy exactly at the voice's own pitch (any snap would
      // beat against the dry voice), the doubler and the comb give the hologram shimmer, the
      // shelf the digital air.
      // (~4 dB under the dry voice at the default amount: measured on real Kokoro speech, a
      // louder layer smears the formants enough to cost intelligibility)
      p.dry = 1 - 0.35 * a;
      p.voc = 0.85 * a;
      p.comb = 0.35 * a;
      p.combHz = 380;
      p.combFb = 0.45;
      p.chorus = 0.55 * a;
      p.air = 6 * a;
      break;
    case 'vocoder':
      // The classic synth voice: everything is vocoded, the pitch snaps to semitones; noise and
      // sibilance keep the consonants.
      p.dry = 0.3 * (1 - a);
      p.voc = 1;
      p.vocGate = 0;
      p.noise = 1;
      p.hiNoise = 1;
      p.sib = 0.35 + 0.15 * a;
      p.snap = 0.6 + 0.4 * a;
      p.chorus = 0.3 * a;
      p.air = 3 * a;
      break;
    case 'robot':
      // A monotone vocoder (one note per sentence: the clip's median pitch), ring modulation and
      // grit.
      p.dry = 0.3 * (1 - a);
      p.voc = 1;
      p.vocGate = 0;
      p.noise = 1;
      p.hiNoise = 1;
      p.sib = 0.35 + 0.15 * a;
      p.mono = 1;
      p.snap = 1;
      // an octave below the note: the bands under a monotone that sits above the voice's own
      // pitch (a falling phrase end) keep their energy, and the robot sounds bigger
      p.sub = 0.4 + 0.3 * a;
      p.ring = 0.25 + 0.5 * a;
      p.ringHz = 55;
      p.crush = 0.35 * a;
      p.comb = 0.2 + 0.3 * a;
      p.combHz = 150;
      p.combFb = 0.55;
      p.air = 2 * a;
      break;
    default:
      break;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Pitch

const PITCH_RATE = 8000; // analysis rate (low-passed, decimated)
const PITCH_HOP = 0.005; // one analysis every 5 ms
const PITCH_WIN = 0.02; // 20 ms integration window
const F0_MIN = 60;
const F0_MAX = 500;
const HIST_LO = -40; // semitones from A4: 44 Hz ..
const HIST_BINS = 48; // .. 698 Hz

/** YIN geometry for an analysis rate. @param {number} rate */
function yinSetup(rate) {
  const tauMin = Math.max(2, Math.floor(rate / F0_MAX));
  const tauMax = Math.ceil(rate / F0_MIN);
  const W = Math.max(tauMax, Math.round(PITCH_WIN * rate));
  return { tauMin, tauMax, W, span: W + tauMax + 1, d: new Float64Array(tauMax + 2) };
}

/**
 * One YIN analysis (de Cheveigné & Kawahara 2002) of `lin[0 .. span)`.
 * @param {Float64Array|Float32Array} lin @param {ReturnType<typeof yinSetup>} g @param {number} rate
 * @param {boolean} wasVoiced  hysteresis: staying voiced is easier than becoming voiced
 * @returns {number} F0 in Hz, or 0 when unvoiced; the periodicity (1 − the dip) is in g.d[0]
 */
function yinFrame(lin, g, rate, wasVoiced) {
  const { W, tauMin, tauMax, span, d } = g;
  let energy = 0;
  for (let i = 0; i < span; i++) energy += lin[i] * lin[i];
  d[0] = 0;
  // energy gate (-50 dBFS RMS): silence and breath noise are unvoiced
  if (energy / span < 1e-5) return 0;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let acc = 0;
    for (let j = 0; j < W; j++) {
      const diff = lin[j] - lin[j + tau];
      acc += diff * diff;
    }
    running += acc;
    d[tau] = running > 0 ? (acc * tau) / running : 1;
  }
  const threshold = wasVoiced ? 0.3 : 0.2;
  let best = -1;
  let bestVal = Infinity;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      bestVal = d[tau];
      break;
    }
    if (d[tau] < bestVal) {
      bestVal = d[tau];
      best = tau;
    }
  }
  const periodicity = Math.max(0, Math.min(1, 1 - bestVal));
  if (best < 0 || bestVal >= (wasVoiced ? 0.45 : 0.35)) return 0;
  d[0] = periodicity;
  // parabolic interpolation around the dip
  let t = best;
  if (best > 1 && best < tauMax) {
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const den = a - 2 * b + c;
    if (den > 1e-12) t = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return rate / t;
}

/**
 * Fold an F0 estimate by octaves toward a reference pitch (YIN's classic errors are an octave
 * low at voicing onsets and creak, an octave high on weak fundamentals).
 * @param {number} f @param {number} ref
 */
export function foldOctave(f, ref) {
  if (!(f > 0) || !(ref > 0)) return f;
  const r = Math.log2(f / ref);
  if (r < -0.8) return f * 2;
  if (r > 0.9) return f / 2;
  return f;
}

/**
 * Causal YIN pitch tracker on a low-passed, decimated (~8 kHz) copy of the live input: one
 * analysis every 5 ms over the last ~37 ms. Used when the clip's own look-ahead analysis
 * (ClipPitch) is not available; its estimate lags the voice by ~25 ms.
 */
export class PitchTracker {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.D = Math.max(1, Math.round(sampleRate / PITCH_RATE));
    this.rate = sampleRate / this.D;
    this.g = yinSetup(this.rate);
    this.hop = Math.max(1, Math.round(PITCH_HOP * this.rate));
    let size = 1;
    while (size < this.g.span * 2) size <<= 1;
    this._ring = new Float64Array(size);
    this._mask = size - 1;
    this._w = 0;
    this._lin = new Float64Array(this.g.span);
    this._lp = biquadLowpass(Math.min(1000, 0.4 * this.rate), sampleRate);
    this._z = new Float64Array(4);
    this._phase = 0;
    this._hopCount = 0;
    this._hist = [0, 0, 0];
    /** last voiced F0 (Hz, median of 3 analyses); 0 until the first voiced frame */
    this.f0 = 0;
    this.voiced = false;
    /** 1 − the YIN dip: ~1 for a clean periodic voice, 0 when unvoiced */
    this.periodicity = 0;
    /** the speaker's typical pitch (Hz) to fold octave errors toward; 0 = unknown */
    this.ref = 0;
    /** analyses run so far */
    this.frames = 0;
  }

  reset() {
    this._ring.fill(0);
    this._z.fill(0);
    this._w = 0;
    this._phase = 0;
    this._hopCount = 0;
    this.voiced = false;
    this.periodicity = 0;
  }

  /** Feed one input sample. @param {number} x @returns {boolean} true when an analysis ran */
  push(x) {
    const c = this._lp;
    const z = this._z;
    // two cascaded low-pass biquads (transposed direct form II)
    const y = c[0] * x + z[0];
    z[0] = c[1] * x - c[3] * y + z[1];
    z[1] = c[2] * x - c[4] * y;
    const y2 = c[0] * y + z[2];
    z[2] = c[1] * y - c[3] * y2 + z[3];
    z[3] = c[2] * y - c[4] * y2;
    if (++this._phase < this.D) return false;
    this._phase = 0;
    this._ring[this._w] = y2;
    this._w = (this._w + 1) & this._mask;
    if (++this._hopCount < this.hop) return false;
    this._hopCount = 0;
    this._analyze();
    return true;
  }

  _analyze() {
    const { _lin: lin, _ring: ring, _mask: mask } = this;
    const span = this.g.span;
    let r = (this._w - span) & mask;
    for (let i = 0; i < span; i++) {
      lin[i] = ring[r];
      r = (r + 1) & mask;
    }
    this.frames++;
    const f = foldOctave(yinFrame(lin, this.g, this.rate, this.voiced), this.ref);
    this.periodicity = this.g.d[0];
    if (!f) {
      this.voiced = false;
      return;
    }
    const h = this._hist;
    if (!this.voiced) h[0] = h[1] = h[2] = f;
    else {
      h[0] = h[1];
      h[1] = h[2];
      h[2] = f;
    }
    this.voiced = true;
    this.f0 = median3(h[0], h[1], h[2]);
  }
}

/**
 * Look-ahead pitch analysis of a whole clip that is about to play. The player hands the clip's
 * samples to the effect before they sound, so every frame can be analysed over a window centred
 * on its own time (no lag) and smoothed with the frames after it (a median of five removes the
 * octave errors at voicing onsets). step() analyses incrementally, a few frames per audio
 * block, always ahead of the playhead.
 */
export class ClipPitch {
  /** @param {Float32Array} samples @param {number} rate the clip's sample rate */
  constructor(samples, rate) {
    this.src = samples;
    this.srcRate = rate;
    this.D = Math.max(1, Math.round(rate / PITCH_RATE));
    this.rate = rate / this.D;
    this.g = yinSetup(this.rate);
    this.duration = samples.length / rate;
    this.count = Math.floor(this.duration / PITCH_HOP) + 1;
    /** F0 per 5 ms frame (Hz, 0 = unvoiced) */
    this.f0 = new Float32Array(this.count);
    /** frames analysed so far */
    this.done = 0;
    this.dec = new Float64Array(Math.ceil(samples.length / this.D) + 1);
    this._decN = 0;
    this._srcPos = 0;
    this._lp = biquadLowpass(Math.min(1000, 0.4 * this.rate), rate);
    this._z = new Float64Array(4);
    this._lin = new Float64Array(this.g.span);
    this._med = new Float64Array(5);
    this._voiced = false;
    // semitone histogram of the voiced frames (the clip's median pitch: the robot's one note)
    this._hist = new Uint16Array(HIST_BINS);
    /** voiced frames analysed so far */
    this.voicedFrames = 0;
  }

  /** Median pitch of the frames analysed so far, in semitones from A4 (undefined: none). */
  medianSt() {
    if (!this.voicedFrames) return undefined;
    const half = this.voicedFrames / 2;
    let acc = 0;
    for (let k = 0; k < HIST_BINS; k++) {
      acc += this._hist[k];
      if (acc >= half) return k + HIST_LO;
    }
    return undefined;
  }

  /**
   * Analyse up to `max` more frames, but none beyond `untilSec` (clip time).
   * @param {number} max @param {number} [untilSec]
   * @returns {number} frames analysed
   */
  step(max, untilSec = Infinity) {
    const { g, rate, dec, _lin: lin } = this;
    const half = g.span >> 1;
    let n = 0;
    while (n < max && this.done < this.count && this.done * PITCH_HOP <= untilSec) {
      const centre = Math.round(this.done * PITCH_HOP * rate);
      this._decimateTo(centre - half + g.span);
      const start = centre - half;
      for (let i = 0; i < g.span; i++) {
        const j = start + i;
        lin[i] = j >= 0 && j < this._decN ? dec[j] : 0;
      }
      const f = yinFrame(lin, g, rate, this._voiced);
      this._voiced = f > 0;
      this.f0[this.done++] = f;
      if (f > 0) {
        const bin = Math.round(12 * Math.log2(f / 440)) - HIST_LO;
        if (bin >= 0 && bin < HIST_BINS) {
          this._hist[bin]++;
          this.voicedFrames++;
        }
      }
      n++;
    }
    return n;
  }

  /** True when the frames needed for time t (clip seconds) are analysed. @param {number} t */
  covers(t) {
    return this.done >= this.count || this.done > Math.ceil(t / PITCH_HOP) + 2;
  }

  /**
   * Pitch at clip time t: the median of the voiced frames among the five around it (0 when the
   * frame at t is unvoiced or outside the clip).
   * @param {number} t
   */
  at(t) {
    const k = Math.round(t / PITCH_HOP);
    if (k < 0 || k >= this.count || !this.f0[k]) return 0;
    const m = this._med;
    let n = 0;
    for (let j = Math.max(0, k - 2); j <= Math.min(this.done - 1, k + 2); j++) {
      const v = this.f0[j];
      if (v > 0) {
        let i = n++;
        while (i > 0 && m[i - 1] > v) {
          m[i] = m[i - 1];
          i--;
        }
        m[i] = v;
      }
    }
    return n ? (n & 1 ? m[n >> 1] : 0.5 * (m[(n >> 1) - 1] + m[n >> 1])) : 0;
  }

  /** Low-pass and decimate the clip up to decimated index `end`. @param {number} end */
  _decimateTo(end) {
    const lim = Math.min(end, this.dec.length);
    const { src, D, _lp: c, _z: z } = this;
    while (this._decN < lim && this._srcPos < src.length) {
      let y2 = 0;
      for (let k = 0; k < D && this._srcPos < src.length; k++) {
        const x = src[this._srcPos++];
        const y = c[0] * x + z[0];
        z[0] = c[1] * x - c[3] * y + z[1];
        z[1] = c[2] * x - c[4] * y;
        y2 = c[0] * y + z[2];
        z[2] = c[1] * y - c[3] * y2 + z[3];
        z[3] = c[2] * y - c[4] * y2;
      }
      this.dec[this._decN++] = y2;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The effect

// 28 bands (~1/4 octave): fewer smear the formants (measured: 20 bands cost ~10 points of
// recogniser word accuracy in the synth blend), more cost CPU for little gain
const N_BANDS = 28;
const F_LO = 110;
const F_HI = 7600;
const HI_NOISE_HZ = 4500;
const LOW_HZ = 900; // voicing ratio: energy below this vs above HIGH_HZ
const HIGH_HZ = 2800;
const SUB = 32; // control-rate sub-block (parameter ramps, carrier frequency)
const COMB_MAX_SEC = 0.012;
const CHORUS_MAX_SEC = 0.03;
const CRUSH_HZ = 6000;
const CRUSH_LEVELS = 48;

/** Parameters ramped at the control rate (the ones a click could come from). */
const RAMPED = ['dry', 'voc', 'vocGate', 'noise', 'hiNoise', 'sib', 'mono', 'sub', 'snap', 'ring', 'ringHz', 'crush', 'comb', 'combHz', 'combFb', 'chorus', 'air'];

export class VoiceFx {
  /**
   * @param {number} sampleRate
   * @param {{ character?: VoiceCharacter, amount?: number, seed?: number, bands?: number }} [o]
   */
  constructor(sampleRate, o = {}) {
    if (!(sampleRate >= 8000)) throw new RangeError('VoiceFx needs a sample rate of at least 8 kHz');
    this.sampleRate = sampleRate;
    const sr = sampleRate;
    this.tracker = new PitchTracker(sr);

    // vocoder filter bank: log-spaced bands, two cascaded band-pass biquads each
    const hi = Math.min(F_HI, 0.42 * sr);
    const n = Math.max(4, Math.round(o.bands ?? N_BANDS));
    this.n = n;
    this.fc = new Float64Array(n);
    this.bb0 = new Float64Array(n);
    this.ba1 = new Float64Array(n);
    this.ba2 = new Float64Array(n);
    this.envA = new Float64Array(n);
    let hiStart = n;
    let lowEnd = 0;
    let highStart = n;
    for (let k = 0; k < n; k++) {
      const e0 = F_LO * (hi / F_LO) ** (k / n);
      const e1 = F_LO * (hi / F_LO) ** ((k + 1) / n);
      const fc = Math.sqrt(e0 * e1);
      // two identical stages: each 1/0.642 wider so the pair is -3 dB at the band edges
      const q = (0.642 * fc) / (e1 - e0);
      const w0 = (TAU * fc) / sr;
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      this.fc[k] = fc;
      this.bb0[k] = alpha / a0;
      this.ba1[k] = (-2 * Math.cos(w0)) / a0;
      this.ba2[k] = (1 - alpha) / a0;
      // envelope smoothing: ~3 periods of the band centre, 1.5..8 ms (smooth lows, fast highs)
      const tau = Math.min(0.008, Math.max(0.0015, 3 / fc));
      this.envA[k] = 1 - Math.exp(-1 / (tau * sr));
      if (fc >= HI_NOISE_HZ && hiStart === n) hiStart = k;
      if (fc < LOW_HZ) lowEnd = k + 1;
      if (fc > HIGH_HZ && highStart === n) highStart = k;
    }
    this.hiStart = hiStart;
    this.lowEnd = lowEnd;
    this.highStart = highStart;
    // per band: modulator stages (4 states), carrier stages (4 states), power envelopes
    this.zm = new Float64Array(4 * n);
    this.zc = new Float64Array(4 * n);
    this.pm = new Float64Array(n);
    this.pc = new Float64Array(n);

    this.sibC = biquadHighpass(Math.min(5000, 0.4 * sr), sr, 0.7);
    this.sibZ = new Float64Array(2);
    this.combLen = nextPow2(Math.ceil(COMB_MAX_SEC * sr) + 4);
    this.combBuf = new Float64Array(this.combLen);
    this.chLen = nextPow2(Math.ceil(CHORUS_MAX_SEC * sr) + 4);
    this.chBuf = new Float64Array(this.chLen);
    this.airZ = new Float64Array(2);
    this.airC = new Float64Array(5);
    this._airDb = NaN;

    this.seed = (o.seed ?? 0x9e3779b9) >>> 0 || 1;
    /** samples processed since construction (the clock clips are scheduled on) */
    this.frame = 0;
    /** @type {null | { pitch: ClipPitch, start: number }} the clip being analysed ahead */
    this.clip = null;
    /** where the carrier pitch came from in the last block (tests, diagnostics) */
    this.pitchSource = /** @type {'clip'|'live'|'none'} */ ('none');
    this.target = presetParams('natural', 0);
    this.cur = { ...this.target };
    /** fx mix against the exact dry copy: 0 = natural (bit-exact bypass), 1 = full character */
    this.mix = 0;
    this.mixTarget = 0;
    this.character = /** @type {VoiceCharacter} */ ('natural');
    this.amount = 0;
    this._resetState();
    this.configure(o);
  }

  /**
   * Change the character and/or amount; the change is ramped over ~40 ms.
   * @param {{ character?: VoiceCharacter, amount?: number }} o
   */
  configure(o = {}) {
    const { character, amount } = normalizeFx({ character: o.character ?? this.character, amount: o.amount ?? this.amount });
    this.character = character;
    this.amount = amount;
    const active = character !== 'natural' && amount > 0;
    this.mixTarget = active ? 1 : 0;
    if (active) {
      this.target = presetParams(character, amount);
      // from bypass: start from clean state at the new character (the mix ramp fades it in)
      if (this.mix === 0) {
        this._resetState();
        this.cur = { ...this.target };
        this.agc = estimateGain(this.target);
      }
    }
  }

  /** Clear the filter and delay states (the long-term pitch and the loudness match are kept). */
  reset() {
    this._resetState();
  }

  /**
   * The dry samples of a clip that starts `delay` samples after the start of the next process()
   * block (negative: it started that long ago). Its pitch is then analysed ahead of the playhead
   * instead of tracked live, so the carrier is exactly in tune with the voice.
   * @param {Float32Array} samples @param {number} rate the clip's sample rate @param {number} delay
   */
  setClip(samples, rate, delay = 0) {
    if (!(samples && samples.length) || !(rate > 0)) {
      this.clip = null;
      return;
    }
    this.clip = { pitch: new ClipPitch(samples, rate), start: this.frame + Math.round(delay) };
  }

  /** True while the effect does no work (bypass, or silence after the tail has died away). */
  get idle() {
    return this.mix === 0 || this._asleep;
  }

  _resetState() {
    this.tracker.reset();
    this.zm.fill(0);
    this.zc.fill(0);
    this.pm.fill(0);
    this.pc.fill(0);
    this.sibZ.fill(0);
    this.combBuf.fill(0);
    this.chBuf.fill(0);
    this.airZ.fill(0);
    this.combW = 0;
    this.chW = 0;
    this.combLp = 0;
    this.phase = 0;
    this.phase2 = 0;
    this.ringPhase = 0;
    this.lfo1 = 0;
    this.lfo2 = 0.37;
    this.crushHold = 0;
    this.crushPhase = 0;
    this.v = 0;
    this.vClip = -1;
    this._wasVoiced = false;
    this.st = this.ltSt ?? -9; // carrier pitch in semitones from A4 (−9 ≈ C4)
    this.agc ??= 1;
    this.pIn = 0;
    this.pOut = 0;
    this.peakEnv = 0;
    this.quiet = 0;
    this._asleep = false;
    this.freq = 440 * 2 ** (this.st / 12);
  }

  /**
   * Process one block (mono in → mono out, same length). `input` may be null (nothing playing).
   * @param {Float32Array|null} input @param {Float32Array} output
   */
  process(input, output) {
    const len = output.length;
    const has = !!input && input.length >= len;
    const sr = this.sampleRate;
    const frame0 = this.frame;
    this.frame += len;
    // exact bypass
    if (this.mix === 0 && this.mixTarget === 0) {
      if (has) output.set(/** @type {Float32Array} */ (input).subarray(0, len));
      else output.fill(0);
      return;
    }
    const clip = this.clip;
    if (clip) {
      const t = (frame0 + len - clip.start) / sr; // clip time at the end of this block
      if (t > clip.pitch.duration + 0.1) this.clip = null;
      else {
        // analyse ahead of the playhead: what the next 40 ms need first (up to 12 frames, 60 ms
        // of audio, ~0.25 ms of work per block, so a late start catches up within a few
        // blocks), then 3 more frames per block toward the end of the clip (its median pitch)
        const need = clip.pitch.step(12, t + 0.04);
        if (need < 3) clip.pitch.step(3 - need);
      }
    }
    // asleep: silent input and a dead tail → zeros, no work
    if (this._asleep) {
      if (!has || !hasSignal(/** @type {Float32Array} */ (input), len)) {
        output.fill(0);
        if (this.mixTarget === 0) this.mix = 0;
        return;
      }
      this._asleep = false;
    }
    for (let i0 = 0; i0 < len; i0 += SUB) {
      const i1 = Math.min(len, i0 + SUB);
      this._control(i1 - i0, frame0 + i0);
      this._run(input, output, i0, i1, has);
    }
    // sleep after 250 ms of silence once the tail is inaudible (no CPU while idle; the states
    // are cleared before they could decay into denormals)
    if (this.quiet > 0.25 * sr) {
      this._resetState();
      this._asleep = true;
      if (this.mixTarget === 0) this.mix = 0;
    }
  }

  /**
   * Control-rate update: parameter ramps, carrier pitch, voicing, air shelf.
   * @param {number} n samples in this sub-block @param {number} frame its first sample's frame
   */
  _control(n, frame) {
    const sr = this.sampleRate;
    const k = 1 - Math.exp(-n / (0.04 * sr)); // ~40 ms ramps
    const cur = /** @type {Record<string, number>} */ (this.cur);
    const tgt = /** @type {Record<string, number>} */ (this.target);
    for (const key of RAMPED) cur[key] += (tgt[key] - cur[key]) * k;
    // the mix ramps linearly (a full fade in 40 ms) so the bypass is reached exactly
    const step = n / (0.04 * sr);
    if (this.mix < this.mixTarget) this.mix = Math.min(this.mixTarget, this.mix + step);
    else if (this.mix > this.mixTarget) this.mix = Math.max(this.mixTarget, this.mix - step);
    // the voice's pitch now: from the clip's look-ahead analysis when it covers the playhead
    // (exact, no lag), else from the live tracker (~25 ms late)
    const tr = this.tracker;
    const ltHz = this.ltSt === undefined ? 0 : 440 * 2 ** (this.ltSt / 12);
    tr.ref = ltHz;
    let f0 = 0;
    let voiced = false;
    this.vClip = -1;
    const clip = this.clip;
    const t = clip ? (frame + 0.5 * n - clip.start) / sr : -1;
    if (clip && t >= 0 && t <= clip.pitch.duration && clip.pitch.covers(t)) {
      f0 = foldOctave(clip.pitch.at(t), ltHz);
      voiced = f0 > 0;
      this.vClip = voiced ? 1 : 0;
      this.pitchSource = 'clip';
    } else {
      f0 = tr.voiced ? tr.f0 : 0;
      voiced = tr.voiced;
      this.pitchSource = tr.frames ? 'live' : 'none';
    }
    let target = this.st;
    if (voiced) {
      const st = 12 * Math.log2(f0 / 440);
      this.ltSt = this.ltSt === undefined ? st : this.ltSt + (st - this.ltSt) * (1 - Math.exp(-n / (1.5 * sr)));
      target = st + cur.mono * (this._monoRef() - st);
      target += cur.snap * (Math.round(target) - target);
      // a new voiced run starts at its own pitch (the carrier was silent), later frames glide
      if (!this._wasVoiced) this.st = target;
    } else if (cur.mono > 0.5 && this.ltSt !== undefined) {
      target = Math.round(this._monoRef());
    }
    this._wasVoiced = voiced;
    // glide: 4 ms between analysis frames, ~15 ms for snapped notes (a sung legato)
    this.st += (target - this.st) * (1 - Math.exp(-n / ((0.004 + 0.011 * cur.snap) * sr)));
    this.freq = 440 * 2 ** (this.st / 12);
    if (Math.abs(cur.air - this._airDb) > 0.05 || Number.isNaN(this._airDb)) {
      this._airDb = cur.air;
      highShelf(this.airC, Math.min(6500, 0.4 * sr), cur.air, sr);
    }
  }

  /**
   * The monotone's pitch (semitones from A4): the median of the clip being played, else the
   * speaker's long-term average; it only moves when that drifts by more than 3/4 of a
   * semitone, so a sentence stays on one note.
   */
  _monoRef() {
    const cp = this.clip?.pitch;
    const ref = cp && cp.voicedFrames >= 20 ? cp.medianSt() : this.ltSt;
    if (ref === undefined) return this.st;
    if (this.monoSt === undefined || Math.abs(ref - this.monoSt) > 0.75) this.monoSt = ref;
    return this.monoSt;
  }

  /**
   * @param {Float32Array|null} input @param {Float32Array} output
   * @param {number} i0 @param {number} i1 @param {boolean} has
   */
  _run(input, output, i0, i1, has) {
    const sr = this.sampleRate;
    const p = this.cur;
    const n = this.n;
    const { bb0, ba1, ba2, envA, zm, zc, pm, pc, tracker, sibC, sibZ, combBuf, chBuf, airC, airZ } = this;
    const combMask = this.combLen - 1;
    const chMask = this.chLen - 1;
    const hiStart = this.hiStart;
    const lowEnd = this.lowEnd;
    const highStart = this.highStart;
    const inc = this.freq / sr;
    const ringInc = p.ringHz / sr;
    const combD = Math.max(2, Math.min(this.combLen - 3, sr / p.combHz));
    const lfoInc1 = 0.53 / sr;
    const lfoInc2 = 0.37 / sr;
    const crushInc = CRUSH_HZ / sr;
    const vA = 1 - Math.exp(-1 / (0.005 * sr));
    const agcA = 1 - Math.exp(-1 / (0.3 * sr));
    const agcG = 1 - Math.exp(-1 / (0.2 * sr));
    const relA = Math.exp(-1 / (0.06 * sr));
    const mix = this.mix;
    const vClip = this.vClip;
    let seed = this.seed;
    let { phase, phase2, ringPhase, lfo1, lfo2, crushHold, crushPhase, v, agc, pIn, pOut, peakEnv, combW, chW, combLp, quiet } = this;
    for (let i = i0; i < i1; i++) {
      const x = has ? /** @type {Float32Array} */ (input)[i] : 0;
      tracker.push(x);

      // carrier: band-limited saw (PolyBLEP) and white noise of the same RMS
      phase += inc;
      if (phase >= 1) phase -= 1;
      let saw = 2 * phase - 1;
      if (phase < inc) {
        const t = phase / inc;
        saw -= t + t - t * t - 1;
      } else if (phase > 1 - inc) {
        const t = (phase - 1) / inc;
        saw -= t * t + t + t + 1;
      }
      if (p.sub > 1e-4) {
        const inc2 = 0.5 * inc;
        phase2 += inc2;
        if (phase2 >= 1) phase2 -= 1;
        let s2 = 2 * phase2 - 1;
        if (phase2 < inc2) {
          const t = phase2 / inc2;
          s2 -= t + t - t * t - 1;
        } else if (phase2 > 1 - inc2) {
          const t = (phase2 - 1) / inc2;
          s2 -= t * t + t + t + 1;
        }
        saw = (saw + p.sub * s2) / Math.sqrt(1 + p.sub * p.sub);
      }
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed >>> 0) / 2147483648 - 1;
      // voiced → saw, unvoiced → noise (constant power, so the per-band normalisation is steady)
      const nv = p.noise * (1 - v);
      const carrier = saw * Math.sqrt(1 - nv) + noise * Math.sqrt(nv);
      const hiCarrier = carrier + p.hiNoise * (noise - carrier);

      // vocoder bands
      let voc = 0;
      let eLow = 0;
      let eHigh = 0;
      let eAll = 0;
      let pcSum = 0;
      for (let k = 0; k < n; k++) pcSum += pc[k];
      const floor = 1e-9 + 0.002 * (pcSum / n);
      for (let k = 0; k < n; k++) {
        const b0 = bb0[k];
        const a1 = ba1[k];
        const a2 = ba2[k];
        const s = 4 * k;
        // modulator (the voice): two band-pass stages, b1 = 0 and b2 = −b0
        let y = b0 * x + zm[s];
        zm[s] = zm[s + 1] - a1 * y;
        zm[s + 1] = -b0 * x - a2 * y;
        const m = b0 * y + zm[s + 2];
        zm[s + 2] = zm[s + 3] - a1 * m;
        zm[s + 3] = -b0 * y - a2 * m;
        // carrier through the same band
        const cin = k >= hiStart ? hiCarrier : carrier;
        let yc = b0 * cin + zc[s];
        zc[s] = zc[s + 1] - a1 * yc;
        zc[s + 1] = -b0 * cin - a2 * yc;
        const c = b0 * yc + zc[s + 2];
        zc[s + 2] = zc[s + 3] - a1 * c;
        zc[s + 3] = -b0 * yc - a2 * c;
        const ea = envA[k];
        const pmk = (pm[k] += ea * (m * m - pm[k]));
        const pck = (pc[k] += ea * (c * c - pc[k]));
        // the carrier band takes the voice band's envelope (normalised by its own)
        const g = Math.sqrt(pmk / (pck + floor));
        voc += c * (g < 40 ? g : 40);
        eAll += pmk;
        if (k < lowEnd) eLow += pmk;
        else if (k >= highStart) eHigh += pmk;
      }
      // voicing: the clip analysis when it covers the playhead; otherwise from the band
      // energies (instant, unlike the live tracker): voiced sounds have their energy low,
      // fricatives high; silence is unvoiced
      let vt = vClip;
      if (vt < 0) {
        vt = 0;
        if (eAll > 1e-7) {
          const r = eLow / (eLow + 3 * eHigh + 1e-12);
          vt = r > 0.6 ? 1 : r < 0.3 ? 0 : (r - 0.3) / 0.3;
        }
      }
      v += (vt - v) * vA;

      // sibilance: the dry voice above ~5 kHz
      const hs = sibC[0] * x + sibZ[0];
      sibZ[0] = sibC[1] * x - sibC[3] * hs + sibZ[1];
      sibZ[1] = sibC[2] * x - sibC[4] * hs;

      const gate = 1 - p.vocGate * (1 - v);
      let w = p.dry * x + p.voc * gate * voc + p.sib * hs;

      // ring modulation (sine), depth `ring`
      if (p.ring > 1e-4) {
        ringPhase += ringInc;
        if (ringPhase >= 1) ringPhase -= 1;
        w *= 1 - p.ring + p.ring * Math.sin(TAU * ringPhase);
      }
      // bit crush: sample-and-hold at ~6 kHz, coarse levels
      if (p.crush > 1e-4) {
        crushPhase += crushInc;
        if (crushPhase >= 1) {
          crushPhase -= 1;
          crushHold = Math.round(w * CRUSH_LEVELS) / CRUSH_LEVELS;
        }
        w += p.crush * (crushHold - w);
      }
      // metallic comb: a short damped feedback delay
      if (p.comb > 1e-4) {
        const rp = combW - combD;
        const ri = Math.floor(rp);
        const fr = rp - ri;
        const d0 = combBuf[ri & combMask];
        const d1 = combBuf[(ri + 1) & combMask];
        const delayed = d0 + fr * (d1 - d0);
        combLp += 0.6 * (delayed - combLp);
        const yc = w + p.combFb * combLp;
        combBuf[combW & combMask] = yc;
        w += p.comb * ((1 - p.combFb) * yc - w);
      } else {
        combBuf[combW & combMask] = w;
      }
      combW++;
      // doubler: two slowly modulated delays (~11 and ~17 ms)
      chBuf[chW & chMask] = w;
      if (p.chorus > 1e-4) {
        lfo1 += lfoInc1;
        if (lfo1 >= 1) lfo1 -= 1;
        lfo2 += lfoInc2;
        if (lfo2 >= 1) lfo2 -= 1;
        const t1 = chW - (0.011 + 0.002 * Math.sin(TAU * lfo1)) * sr;
        const t2 = chW - (0.017 + 0.0025 * Math.sin(TAU * lfo2)) * sr;
        w += p.chorus * 0.5 * (readFrac(chBuf, chMask, t1) - readFrac(chBuf, chMask, t2) * 0.85);
      }
      chW++;
      // air: high shelf
      const ya = airC[0] * w + airZ[0];
      airZ[0] = airC[1] * w - airC[3] * ya + airZ[1];
      airZ[1] = airC[2] * w - airC[4] * ya;
      w = ya;

      // loudness match: the processed voice as loud as the dry voice (gated, ~0.3 s)
      pIn += agcA * (x * x - pIn);
      pOut += agcA * (w * w - pOut);
      if (pIn > 1e-6 && pOut > 1e-9) {
        const gt = Math.sqrt(pIn / pOut);
        agc += agcG * ((gt < 0.25 ? 0.25 : gt > 4 ? 4 : gt) - agc);
      }
      let y = w * agc;
      // crossfade with the exact dry copy (character changes to/from natural)
      if (mix < 1) y = x + mix * (y - x);
      // peak limiter: instant attack, 60 ms release, never above LIMIT
      const ay = y < 0 ? -y : y;
      const decayed = peakEnv * relA;
      peakEnv = ay > decayed ? ay : decayed; // the envelope is never below the sample
      if (peakEnv > LIMIT) y *= LIMIT / peakEnv;
      if (!(y === y) || y > 1 || y < -1) y = 0; // NaN guard
      output[i] = y;
      quiet = ay > 3e-5 || (x > 1e-6 || x < -1e-6) ? 0 : quiet + 1;
    }
    Object.assign(this, { seed, phase, phase2, ringPhase, lfo1, lfo2, crushHold, crushPhase, v, agc, pIn, pOut, peakEnv, combW, chW, combLp, quiet });
    if (!Number.isFinite(agc) || !Number.isFinite(pc[0]) || !Number.isFinite(pm[0])) {
      this.agc = 1;
      this._resetState();
    }
  }
}

/**
 * Render a whole clip offline (tests, demo files): the input plus the effect's tail. Like the
 * app's player, it hands the clip to the effect for the look-ahead pitch analysis
 * (`lookahead: false` uses the live tracker only).
 * @param {Float32Array} samples @param {number} sampleRate
 * @param {{ character?: VoiceCharacter, amount?: number, block?: number, lookahead?: boolean }} [o]
 * @returns {Float32Array} input.length + tail samples (exactly input.length for 'natural')
 */
export function renderVoiceFx(samples, sampleRate, o = {}) {
  const { character, amount } = normalizeFx(o);
  const fx = new VoiceFx(sampleRate, { character, amount });
  if (o.lookahead !== false) fx.setClip(samples, sampleRate, 0);
  const natural = fx.mixTarget === 0;
  const tail = natural ? 0 : Math.round(TAIL_SEC * sampleRate);
  const out = new Float32Array(samples.length + tail);
  const block = o.block ?? 128;
  const inBuf = new Float32Array(block);
  const outBuf = new Float32Array(block);
  for (let i = 0; i < out.length; i += block) {
    const n = Math.min(block, out.length - i);
    inBuf.fill(0);
    if (i < samples.length) inBuf.set(samples.subarray(i, Math.min(samples.length, i + n)));
    const ob = n === block ? outBuf : outBuf.subarray(0, n);
    fx.process(n === block ? inBuf : inBuf.subarray(0, n), ob);
    out.set(ob, i);
  }
  return out;
}

/**
 * The AGC's starting gain for a character (measured on real Kokoro speech; the AGC refines it
 * within ~0.3 s), so the first syllable after a change is not too loud or too soft.
 * @param {ReturnType<typeof presetParams>} p
 */
function estimateGain(p) {
  const wet = p.dry + 0.8 * p.voc + 0.5 * p.chorus + 0.3 * p.sib;
  return Math.min(2, Math.max(0.5, 1 / Math.max(0.5, wet)));
}

/** @param {Float64Array} buf @param {number} mask @param {number} pos */
function readFrac(buf, mask, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = buf[i & mask];
  return a + f * (buf[(i + 1) & mask] - a);
}

/** @param {Float32Array} x @param {number} n */
function hasSignal(x, n) {
  for (let i = 0; i < n; i++) if (x[i] > 1e-6 || x[i] < -1e-6) return true;
  return false;
}

/** @param {number} a @param {number} b @param {number} c */
function median3(a, b, c) {
  return a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b;
}

/** @param {number} n */
function nextPow2(n) {
  let s = 1;
  while (s < n) s <<= 1;
  return s;
}

/** RBJ low-pass, Butterworth Q, normalised [b0, b1, b2, a1, a2]. @param {number} f @param {number} sr */
function biquadLowpass(f, sr) {
  const w0 = (TAU * f) / sr;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  return new Float64Array([((1 - cw) / 2) / a0, (1 - cw) / a0, ((1 - cw) / 2) / a0, (-2 * cw) / a0, (1 - alpha) / a0]);
}

/** RBJ high-pass, normalised [b0, b1, b2, a1, a2]. @param {number} f @param {number} sr @param {number} q */
function biquadHighpass(f, sr, q) {
  const w0 = (TAU * f) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  return new Float64Array([((1 + cw) / 2) / a0, -(1 + cw) / a0, ((1 + cw) / 2) / a0, (-2 * cw) / a0, (1 - alpha) / a0]);
}

/**
 * RBJ high shelf (slope 0.8) into `c` as normalised [b0, b1, b2, a1, a2].
 * @param {Float64Array} c @param {number} f @param {number} db @param {number} sr
 */
function highShelf(c, f, db, sr) {
  const A = 10 ** (db / 40);
  const w0 = (TAU * f) / sr;
  const cw = Math.cos(w0);
  const S = 0.8;
  const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sq = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + sq;
  c[0] = (A * (A + 1 + (A - 1) * cw + sq)) / a0;
  c[1] = (-2 * A * (A - 1 + (A + 1) * cw)) / a0;
  c[2] = (A * (A + 1 + (A - 1) * cw - sq)) / a0;
  c[3] = (2 * (A - 1 - (A + 1) * cw)) / a0;
  c[4] = (A + 1 - (A - 1) * cw - sq) / a0;
}
