// LevelNormalizer: a slow software level control in front of the keyword spotters
// (contract-wake §7.6). The tiny KWS models are not level-invariant: in the eval, zh-en recall fell
// from 66 % to 38 % for quiet talkers without it (eval.md §3.4). Pure; no Electron.
//
// * The speech level is measured only on VAD-speech blocks (mean square, a 300 ms time constant;
//   the first 300 ms of speech after start-up use a running mean, so the first utterance is not
//   judged by a default), and the gain that brings it to targetDb is clamped to [minGainDb,
//   maxGainDb].
// * Outside speech the gain is frozen, so each stream starts with the previous utterance's gain.
// * It changes only what the spotters see; the renderer's audio for Whisper is untouched.

import { AGC_DEFAULTS, SAMPLE_RATE } from './config.js';

const LN10_20 = Math.LN10 / 20;

/** dB → linear amplitude. @param {number} db */
export const dbToGain = (db) => Math.exp(db * LN10_20);

/** RMS of a block in dBFS (−Infinity for digital silence). @param {Float32Array} x */
export function rmsDb(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const ms = x.length ? s / x.length : 0;
  return ms > 0 ? 10 * Math.log10(ms) : -Infinity;
}

export class LevelNormalizer {
  /** @param {{ targetDb?: number, minGainDb?: number, maxGainDb?: number, tauMs?: number, sampleRate?: number, limit?: number|null }} [o] */
  constructor(o = {}) {
    this.limit = o.limit === undefined ? AGC_DEFAULTS.limit : o.limit;
    this.targetDb = o.targetDb ?? AGC_DEFAULTS.targetDb;
    this.minGainDb = o.minGainDb ?? AGC_DEFAULTS.minGainDb;
    this.maxGainDb = o.maxGainDb ?? AGC_DEFAULTS.maxGainDb;
    this.tauSec = (o.tauMs ?? AGC_DEFAULTS.tauMs) / 1000;
    this.sampleRate = o.sampleRate ?? SAMPLE_RATE;
    /** mean-square speech level estimate (0 = none yet) */
    this._p = 0;
    /** seconds of speech the estimate has seen (for the start-up running mean) */
    this._seen = 0;
    this._gainDb = 0;
    this._gain = 1;
  }

  /** The current gain in dB. */
  get gainDb() {
    return this._gainDb;
  }

  /** The speech level estimate in dBFS (null before any speech). */
  get levelDb() {
    return this._p > 0 ? 10 * Math.log10(this._p) : null;
  }

  /**
   * Update the level estimate from one block of the raw input. Only speech blocks count; the gain
   * stays frozen otherwise. @param {Float32Array} x @param {boolean} speaking
   */
  observe(x, speaking) {
    if (!speaking || !x.length) return;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const ms = s / x.length;
    if (!(ms > 1e-12)) return; // digital silence inside a "speech" block says nothing about the level
    const dur = x.length / this.sampleRate;
    if (this._seen < this.tauSec) {
      // start-up: the running mean over the first tau of speech
      this._p = (this._p * this._seen + ms * dur) / (this._seen + dur);
    } else {
      const a = 1 - Math.exp(-dur / this.tauSec);
      this._p += a * (ms - this._p);
    }
    this._seen += dur;
    const want = this.targetDb - 10 * Math.log10(this._p);
    this._gainDb = Math.min(this.maxGainDb, Math.max(this.minGainDb, want));
    this._gain = dbToGain(this._gainDb);
  }

  /**
   * A gained copy of `x` (the input is not modified). With a peak limit (the default), a block whose
   * peak would exceed it gets less gain instead of being clipped: clipping a loud "Hey" after a
   * quiet utterance garbles exactly the audio the spotters need. @param {Float32Array} x
   */
  apply(x) {
    const out = new Float32Array(x.length);
    let g = this._gain;
    if (this.limit) {
      let peak = 0;
      for (let i = 0; i < x.length; i++) {
        const a = x[i] < 0 ? -x[i] : x[i];
        if (a > peak) peak = a;
      }
      if (peak * g > this.limit) g = this.limit / peak;
    }
    if (g === 1) {
      out.set(x);
      return out;
    }
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * g;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  /**
   * A new utterance after a quiet gap (the recipe's look-ahead): the level estimate restarts from
   * this utterance's own first speech blocks (the running mean of the start-up phase). The gain
   * stays as it is until the first of them arrives.
   */
  beginUtterance() {
    this._seen = 0;
  }

  /** Forget the level. */
  reset() {
    this._p = 0;
    this._seen = 0;
    this._gainDb = 0;
    this._gain = 1;
  }
}
