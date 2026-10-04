// Energy-based voice activity detection with an adaptive noise floor.
//
// Works on 16 kHz mono float frames (after resampling). The noise floor follows the quietest
// recent energy (falls fast, rises slowly, and almost freezes while speech is detected), and
// speech is energy sufficiently above that floor. Start needs a short run of loud frames;
// end needs a "hangover" of quiet frames, so short pauses between words don't cut the
// utterance. Utterances that are too short are discarded (coughs, clicks); too long ones are
// cut at maxUtteranceMs. A pre-roll keeps the soft onset of the first word. Steady noise (a
// fan switching on) is told apart from speech by its lack of loudness modulation: speech
// energy swings by many dB between syllables, a fan's does not.
//
// Pure logic (no Web Audio), unit-tested with synthetic signals.

import { dbToUnit, rms, toDb } from './dsp.js';

/**
 * @typedef {object} VadOptions
 * @property {number} [sampleRate]      default 16000
 * @property {number} [frameMs]         analysis frame (default 20)
 * @property {number} [marginDb]        start threshold above the noise floor (default 10)
 * @property {number} [endMarginDb]     end threshold above the floor (default 6; hysteresis)
 * @property {number} [minThresholdDb]  absolute minimum start threshold (default -50 dBFS)
 * @property {number} [startMs]         loud time needed to start (default 60)
 * @property {number} [hangoverMs]      quiet time needed to end (default 700)
 * @property {number} [preRollMs]       audio kept from before the start (default 300)
 * @property {number} [tailMs]          quiet audio kept after the end (default 150)
 * @property {number} [minSpeechMs]     shorter speech is discarded (default 250)
 * @property {number} [maxUtteranceMs]  utterances are cut here (default 30000)
 * @property {number} [initialFloorDb]  starting noise floor estimate (default -60)
 * @property {number} [calibrationMs]   initial time used only to learn the noise floor (default 200)
 * @property {number} [minModulationDb] loudness std-dev below which "speech" is steady noise (default 2)
 * @property {number} [noiseCheckMs]    window for the steady-noise check during speech (default 1500)
 */

export const VAD_DEFAULTS = Object.freeze({
  sampleRate: 16000,
  frameMs: 20,
  marginDb: 10,
  endMarginDb: 6,
  minThresholdDb: -50,
  startMs: 60,
  hangoverMs: 700,
  preRollMs: 300,
  tailMs: 150,
  minSpeechMs: 250,
  maxUtteranceMs: 30000,
  initialFloorDb: -60,
  calibrationMs: 200,
  minModulationDb: 2,
  noiseCheckMs: 1500,
});

/**
 * @typedef {{ type: 'speechstart' }
 *   | { type: 'speechend', samples: Float32Array, durationMs: number, speechMs: number, reason: 'silence'|'maxlength'|'forced' }
 *   | { type: 'discard', durationMs: number, speechMs: number, reason: 'too-short'|'steady-noise' }} VadEvent
 */

export class EnergyVad {
  /** @param {VadOptions} [options] */
  constructor(options = {}) {
    this.opts = { ...VAD_DEFAULTS, ...options };
    this.frameLen = Math.max(1, Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000));
    this.reset();
  }

  reset() {
    this._partial = new Float32Array(this.frameLen);
    this._partialLen = 0;
    this.floorDb = this.opts.initialFloorDb;
    this.speaking = false;
    this.levelDb = -100;
    this._loudMs = 0;
    this._quietMs = 0;
    this._speechMs = 0;
    /** @type {Float32Array[]} */
    this._pre = [];
    /** @type {Float32Array[]} */
    this._utt = [];
    /** @type {number[]} frame levels (dB) of the current utterance */
    this._uttDb = [];
    this._frames = 0;
  }

  /** Current input level 0..1 (for meters). */
  get level() { return dbToUnit(this.levelDb); }

  /** Start threshold in dBFS. */
  get threshold() { return Math.max(this.opts.minThresholdDb, this.floorDb + this.opts.marginDb); }

  /**
   * Feed samples; returns the events produced.
   * @param {Float32Array} samples
   * @returns {VadEvent[]}
   */
  process(samples) {
    /** @type {VadEvent[]} */
    const events = [];
    let i = 0;
    const n = samples.length;
    while (i < n) {
      const take = Math.min(this.frameLen - this._partialLen, n - i);
      this._partial.set(samples.subarray(i, i + take), this._partialLen);
      this._partialLen += take;
      i += take;
      if (this._partialLen === this.frameLen) {
        this._frame(this._partial.slice(), events);
        this._partialLen = 0;
      }
    }
    return events;
  }

  /**
   * Force the end of the current utterance (e.g. the user stopped hands-free mode).
   * @returns {VadEvent[]}
   */
  end() {
    /** @type {VadEvent[]} */
    const events = [];
    if (this.speaking) this._finish(events, 'forced');
    return events;
  }

  /** @param {Float32Array} frame @param {VadEvent[]} events */
  _frame(frame, events) {
    const o = this.opts;
    const fm = o.frameMs;
    const db = toDb(rms(frame));
    this.levelDb = db;
    this._frames++;

    if (this._frames * fm <= o.calibrationMs) {
      // learn the room first: follow the level quickly in both directions, never trigger
      this.floorDb += (db - this.floorDb) * (this._frames === 1 ? 1 : 0.3);
      return;
    }
    // noise floor: fast fall, slow rise; nearly frozen during speech
    if (db < this.floorDb) this.floorDb += (db - this.floorDb) * 0.25;
    else this.floorDb += (db - this.floorDb) * (this.speaking ? 0.0015 : 0.02);
    this.floorDb = Math.max(-95, this.floorDb);

    const startTh = Math.max(o.minThresholdDb, this.floorDb + o.marginDb);
    const endTh = Math.max(o.minThresholdDb - (o.marginDb - o.endMarginDb), this.floorDb + o.endMarginDb);

    if (!this.speaking) {
      this._pre.push(frame);
      const maxPre = Math.ceil(o.preRollMs / fm) + Math.ceil(o.startMs / fm);
      while (this._pre.length > maxPre) this._pre.shift();
      if (db >= startTh) this._loudMs += fm;
      else this._loudMs = Math.max(0, this._loudMs - fm);
      if (this._loudMs >= o.startMs) {
        this.speaking = true;
        this._utt = this._pre;
        this._uttDb = [db];
        this._pre = [];
        this._speechMs = this._loudMs;
        this._quietMs = 0;
        events.push({ type: 'speechstart' });
      }
      return;
    }

    this._utt.push(frame);
    this._uttDb.push(db);
    // steady loud "speech" for a while = a noise source: abort and learn it as the floor
    const win = Math.round(o.noiseCheckMs / fm);
    if (this._uttDb.length >= win && this._uttDb.length % 5 === 0) {
      const recent = this._uttDb.slice(-win);
      const { mean, std } = meanStd(recent);
      if (std < o.minModulationDb) {
        this.floorDb = mean - 1;
        this._finish(events, 'silence', 'steady-noise');
        return;
      }
    }
    if (db >= endTh) {
      this._quietMs = 0;
      this._speechMs += fm;
    } else {
      this._quietMs += fm;
    }
    const durMs = this._utt.length * fm;
    if (this._quietMs >= o.hangoverMs) this._finish(events, 'silence');
    else if (durMs >= o.maxUtteranceMs) this._finish(events, 'maxlength');
  }

  /**
   * @param {VadEvent[]} events @param {'silence'|'maxlength'|'forced'} reason
   * @param {'steady-noise'} [discardReason] discard regardless of length
   */
  _finish(events, reason, discardReason) {
    const o = this.opts;
    const fm = o.frameMs;
    // drop trailing quiet beyond the tail
    const dropFrames = Math.max(0, Math.floor((this._quietMs - o.tailMs) / fm));
    const frames = this._utt.slice(0, Math.max(0, this._utt.length - dropFrames));
    const speechMs = this._speechMs;
    const levels = this._uttDb.slice(0, Math.max(1, this._uttDb.length - Math.floor(this._quietMs / fm)));
    this.speaking = false;
    this._utt = [];
    this._uttDb = [];
    this._pre = [];
    this._loudMs = 0;
    this._quietMs = 0;
    this._speechMs = 0;
    const durationMs = frames.length * fm;
    if (discardReason || meanStd(levels).std < o.minModulationDb) {
      events.push({ type: 'discard', durationMs, speechMs, reason: 'steady-noise' });
      return;
    }
    if (speechMs < o.minSpeechMs) {
      events.push({ type: 'discard', durationMs, speechMs, reason: 'too-short' });
      return;
    }
    events.push({ type: 'speechend', samples: concat(frames), durationMs, speechMs, reason });
  }
}

/** @param {number[]} xs */
function meanStd(xs) {
  if (!xs.length) return { mean: 0, std: 0 };
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return { mean: m, std: Math.sqrt(v / xs.length) };
}

/** @param {Float32Array[]} parts */
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Trim leading/trailing silence from a push-to-talk recording.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{ marginDb?: number, minThresholdDb?: number, padMs?: number, frameMs?: number }} [opts]
 * @returns {{ samples: Float32Array, speechMs: number }} speechMs = time above threshold
 */
export function trimSilence(samples, sampleRate, opts = {}) {
  const frameMs = opts.frameMs ?? 20;
  const marginDb = opts.marginDb ?? 10;
  const minTh = opts.minThresholdDb ?? -50;
  const padMs = opts.padMs ?? 200;
  const fl = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const nFrames = Math.floor(samples.length / fl);
  if (!nFrames) return { samples: new Float32Array(0), speechMs: 0 };
  const dbs = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) dbs[f] = toDb(rms(samples, f * fl, (f + 1) * fl));
  // noise floor estimate: 10th percentile of frame energies
  const sorted = Array.from(dbs).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  // capped so a recording that is speech from start to end is not trimmed away
  const th = Math.min(-30, Math.max(minTh, floor + marginDb));
  let first = -1;
  let last = -1;
  let speechFrames = 0;
  for (let f = 0; f < nFrames; f++) {
    if (dbs[f] >= th) {
      if (first < 0) first = f;
      last = f;
      speechFrames++;
    }
  }
  if (first < 0) return { samples: new Float32Array(0), speechMs: 0 };
  const pad = Math.round(padMs / frameMs);
  const a = Math.max(0, first - pad) * fl;
  const b = Math.min(samples.length, (last + 1 + pad) * fl);
  return { samples: samples.slice(a, b), speechMs: speechFrames * frameMs };
}
