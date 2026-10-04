// Small DSP helpers shared by the mic (resampling, levels) and the lip-sync (band energies).
// Pure functions / classes over Float32Arrays; unit-tested in Node.

/** Root-mean-square of `x[start..end)`. @param {ArrayLike<number>} x */
export function rms(x, start = 0, end = x.length) {
  let acc = 0;
  const n = Math.max(0, end - start);
  for (let i = start; i < end; i++) acc += x[i] * x[i];
  return n ? Math.sqrt(acc / n) : 0;
}

/** Amplitude → dBFS (floored at -100). @param {number} a */
export function toDb(a) {
  return a > 1e-5 ? 20 * Math.log10(a) : -100;
}

/** Map a dBFS level to 0..1 for meters. @param {number} db @param {number} [lo] @param {number} [hi] */
export function dbToUnit(db, lo = -60, hi = -12) {
  return Math.min(1, Math.max(0, (db - lo) / (hi - lo)));
}

const PHASES = 256;

/**
 * Streaming windowed-sinc (Blackman) resampler with an anti-aliasing low-pass when
 * downsampling (e.g. 48 kHz mic → 16 kHz for speech recognition). Arbitrary rate ratios;
 * output sample n corresponds to input time n·from/to (no group delay).
 */
export class Resampler {
  /**
   * @param {number} fromRate @param {number} toRate
   * @param {{ halfTaps?: number }} [opts] filter half length, in samples of the lower rate (default 16)
   */
  constructor(fromRate, toRate, opts = {}) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate; // input samples per output sample
    this.identity = fromRate === toRate;
    // cutoff relative to the input Nyquist; 0.92 leaves a transition band below the new Nyquist
    this.cutoff = toRate < fromRate ? (toRate / fromRate) * 0.92 : 1;
    this.half = Math.ceil((opts.halfTaps ?? 16) / this.cutoff); // kernel half-width in input samples
    this._table = buildTable(this.half, this.cutoff);
    // buf[i] holds input sample (base + i); samples before 0 are zeros (history)
    this._buf = new Float32Array(Math.max(1024, this.half * 4));
    this._len = this.half;
    this._base = -this.half;
    this._t = 0; // absolute input time of the next output sample
    this._received = 0;
  }

  /**
   * Feed input; returns the output samples that can be computed so far.
   * @param {Float32Array} input
   * @returns {Float32Array}
   */
  process(input) {
    if (this.identity) return new Float32Array(input);
    this._append(input);
    this._received += input.length;
    return this._drain(Infinity);
  }

  /** Emit the remaining output for all input received so far (zero-padded). */
  flush() {
    if (this.identity) return new Float32Array(0);
    this._append(new Float32Array(this.half + 1));
    return this._drain(this._received);
  }

  /** @param {Float32Array} input */
  _append(input) {
    if (this._len + input.length > this._buf.length) {
      const next = new Float32Array(Math.max(this._buf.length * 2, this._len + input.length));
      next.set(this._buf.subarray(0, this._len));
      this._buf = next;
    }
    this._buf.set(input, this._len);
    this._len += input.length;
  }

  /** @param {number} limit stop before input time `limit` */
  _drain(limit) {
    const { half, step, _table: table, _buf: buf } = this;
    const out = [];
    for (;;) {
      const t = this._t;
      if (t >= limit) break;
      const i0 = Math.floor(t);
      if (i0 + half - this._base >= this._len) break; // needs samples we don't have yet
      const phase = Math.round((t - i0) * (PHASES - 1));
      const row = table[phase];
      const o = i0 - this._base;
      let acc = 0;
      for (let k = -half + 1, j = 0; k <= half; k++, j++) acc += buf[o + k] * row[j];
      out.push(acc);
      this._t = t + step;
    }
    // drop samples that no future output needs
    const keepFrom = Math.floor(this._t) - half + 1 - this._base;
    if (keepFrom > 0) {
      const n = Math.min(keepFrom, this._len);
      this._buf.copyWithin(0, n, this._len);
      this._len -= n;
      this._base += n;
    }
    return Float32Array.from(out);
  }
}

/**
 * Precompute kernel rows for PHASES fractional offsets.
 * @param {number} half @param {number} cutoff
 */
function buildTable(half, cutoff) {
  const rows = [];
  const taps = 2 * half;
  for (let ph = 0; ph < PHASES; ph++) {
    const frac = ph / (PHASES - 1);
    const row = new Float32Array(taps);
    let sum = 0;
    for (let t = 0, k = -half + 1; k <= half; k++, t++) {
      const x = k - frac; // distance from the output position
      const w = blackman((x + half) / (2 * half));
      const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      row[t] = cutoff * s * w;
      sum += row[t];
    }
    // normalise DC gain to exactly 1
    if (sum !== 0) for (let t = 0; t < taps; t++) row[t] /= sum;
    rows.push(row);
  }
  return rows;
}

/** Blackman window over u ∈ [0, 1]. @param {number} u */
function blackman(u) {
  if (u <= 0 || u >= 1) return 0;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
}

/**
 * One-shot resample.
 * @param {Float32Array} input @param {number} fromRate @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return new Float32Array(input);
  const r = new Resampler(fromRate, toRate);
  const a = r.process(input);
  const b = r.flush();
  const expected = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(expected);
  out.set(a.subarray(0, expected));
  if (a.length < expected) out.set(b.subarray(0, expected - a.length), a.length);
  return out;
}

/**
 * Average magnitude (linear, from analyser dB data) of frequency bands.
 * @param {Float32Array} freqDb  AnalyserNode.getFloatFrequencyData output (dB per bin)
 * @param {number} sampleRate
 * @param {Array<[number, number]>} bands  [loHz, hiHz] pairs
 * @returns {number[]} linear magnitude per band
 */
export function bandEnergies(freqDb, sampleRate, bands) {
  const binHz = sampleRate / 2 / freqDb.length;
  return bands.map(([lo, hi]) => {
    const a = Math.max(0, Math.floor(lo / binHz));
    const b = Math.min(freqDb.length - 1, Math.ceil(hi / binHz));
    let acc = 0;
    let n = 0;
    for (let i = a; i <= b; i++) {
      const db = freqDb[i];
      if (Number.isFinite(db)) acc += 10 ** (db / 20);
      n++;
    }
    return n ? acc / n : 0;
  });
}
