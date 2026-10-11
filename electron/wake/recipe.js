// OnsetRecipe: how continuous microphone audio is cut into keyword-spotting streams
// (contract-wake §7.5; the algorithm verified in wake/contract-probe/stream/stream.cjs and
// eval.md §3.6). Pure: the VAD, the spotters and the level normaliser are injected, so the unit
// tests drive it with fakes and the utility process with sherpa-onnx.
//
// Why: one endless KWS stream loses up to a third of the wakes (its state drifts), and resetting
// after short pauses cuts "Hey, | Jade" in half. So, per 20 ms block:
//   * the VAD sees every block; at a rising edge, every spotter gets a FRESH stream when there was
//     no speech for ≥ quietMs (or no stream is active), fed the last prerollMs of audio first;
//   * while a stream is active every block goes to every spotter (after the level normaliser);
//   * the first HEY_JADE / HEY_JUDE / JADE hit of a stream is reported and all streams are renewed
//     (HEY_JUDE too: the renderer counts them for its media-burst rule);
//   * a JADE hit (the name-only stream, wake.phrase = 'jade') counts only when its first token lies
//     within namePrefixMs of the stream start ("Jade, …" at the very start of an utterance);
//   * nothing is fed hangoverMs after the last speech block, and a gap in the sample indices (the
//     mic reopened, a paused tap) ends any stream and resets the VAD;
//   * continuous speech without a quiet gap (TV, radio, a long reply of hers): after maxStreamMs a
//     new set of streams starts and the old one keeps running for overlapMs, so a call that spans
//     the renewal is still heard whole by the old streams (long streams lose wakes and their
//     timestamps drift by seconds);
//   * a hit whose last-token time lies more than stampLateMs before the moment it was decided is
//     re-anchored to emitAt - reanchorMs: the decoder's timestamps drift in long streams, while a
//     correct stamp is always ≤ 0.56 s before the decision (measured, TV bed and clean speech).
// Sample indices (`at`) count 16 kHz samples of the renderer's Mic (monotonic, §6.3).

import { RECIPE_DEFAULTS, SAMPLE_RATE } from './config.js';

/**
 * @typedef {object} SpotterLike         utility/sherpa.js createSpotter() (or a test fake)
 * @property {() => any} newStream
 * @property {(s: any, x: Float32Array) => void} accept
 * @property {(s: any) => Array<{ keyword: string, timestamps: number[], tokens?: string[] }>} drain
 */

/**
 * @typedef {object} VadLike
 * @property {(x: Float32Array) => boolean} accept   speech detected after this block
 * @property {() => void} reset
 */

/**
 * @typedef {object} AgcLike
 * @property {(x: Float32Array, speaking: boolean) => void} observe
 * @property {(x: Float32Array) => Float32Array} apply
 * @property {() => void} [beginUtterance]   a fresh utterance starts (the look-ahead re-measures its level)
 */

/**
 * @typedef {object} Hit
 * @property {'HEY_JADE'|'HEY_JUDE'|'JADE'} keyword
 * @property {string} model      the spotter that fired: 'zhen' | 'giga' | 'name'
 * @property {number} streamAt   sample index of the stream's first sample (the pre-roll start)
 * @property {number} startAt    streamAt + first token time
 * @property {number} endAt      streamAt + last token time (≈ 90 ms before the acoustic end of "Jade")
 * @property {number} emitAt     sample index at which the hit was decided (end of the block)
 * @property {boolean} [reanchored]  the stamps were implausible and were put just before emitAt
 */

const PRIORITY = { HEY_JADE: 0, JADE: 1, HEY_JUDE: 2 };

export class OnsetRecipe {
  /**
   * @param {{ spotters: Array<{ name: string, spotter: SpotterLike }>, vad: VadLike, agc?: AgcLike|null, sampleRate?: number,
   *   quietMs?: number, prerollMs?: number, hangoverMs?: number, maxStreamMs?: number, overlapMs?: number, namePrefixMs?: number, nameFeedMs?: number,
   *   stampLateMs?: number, reanchorMs?: number, maxKeywordMs?: number,
   *   blockSamples?: number, agcLookaheadMs?: number, onStreams?: (n: number) => void }} o
   */
  constructor(o) {
    const sr = o.sampleRate ?? SAMPLE_RATE;
    const ms = (/** @type {number} */ v) => Math.round((v * sr) / 1000);
    this.sampleRate = sr;
    this.vad = o.vad;
    this.agc = o.agc || null;
    this._spotters = o.spotters.slice();
    /** @type {Array<{ name: string, spotter: SpotterLike }>|null} */
    this._pending = null;
    this.quiet = ms(o.quietMs ?? RECIPE_DEFAULTS.quietMs);
    this.preroll = ms(o.prerollMs ?? RECIPE_DEFAULTS.prerollMs);
    this.hangover = ms(o.hangoverMs ?? RECIPE_DEFAULTS.hangoverMs);
    this.maxStream = ms(o.maxStreamMs ?? RECIPE_DEFAULTS.maxStreamMs);
    this.overlap = ms(o.overlapMs ?? RECIPE_DEFAULTS.overlapMs);
    this.stampLate = ms(o.stampLateMs ?? RECIPE_DEFAULTS.stampLateMs);
    this.reanchorBy = ms(o.reanchorMs ?? RECIPE_DEFAULTS.reanchorMs);
    this.maxKeyword = ms(o.maxKeywordMs ?? RECIPE_DEFAULTS.maxKeywordMs);
    this.namePrefix = ms(o.namePrefixMs ?? RECIPE_DEFAULTS.namePrefixMs);
    // the name-only stream is useless once a call at the very start can no longer complete
    this.nameFeed = ms(o.nameFeedMs ?? (o.namePrefixMs ?? RECIPE_DEFAULTS.namePrefixMs) + 2000);
    this.block = Math.max(1, o.blockSamples ?? RECIPE_DEFAULTS.blockSamples);
    // the level normaliser's look-ahead at an utterance onset (only with an agc)
    this.lookahead = ms(o.agcLookaheadMs ?? RECIPE_DEFAULTS.agcLookaheadMs);
    /** @type {{ blocks: Float32Array[], speech: number }|null} */
    this._hold = null;
    this._onStreams = o.onStreams || null;
    this._buf = new Float32Array(this.block);
    this._fill = 0;
    this._bufStart = 0;
    this._ring = new Float32Array(Math.max(1, this.preroll));
    this._ringPos = 0;
    this._ringFill = 0;
    /** @type {number|null} */
    this._next = null;
    this._wasSpeaking = false;
    this._lastSpeechEnd = -Infinity;
    this._active = false;
    this._streamAt = 0;
    /** at: the stream's first sample; until: the sample after which an overlapped old stream stops
     * @type {Array<{ name: string, spotter: SpotterLike, s: any, spent: boolean, at: number, until: number }>} */
    this._streams = [];
    this.stats = { blocks: 0, samples: 0, speechSamples: 0, fedSamples: 0, onsets: 0, fresh: 0, streams: 0, hits: 0, gaps: 0, renewals: 0, reanchored: 0 };
  }

  /** A stream is being fed now. */
  get active() {
    return this._active;
  }

  /** The VAD's state after the last block. */
  get speaking() {
    return this._wasSpeaking;
  }

  /** The spotters in use (names). */
  get spotterNames() {
    return this._spotters.map((s) => s.name);
  }

  /**
   * Swap the spotters (new thresholds or phrase). Takes effect at the next fresh stream, so an
   * utterance in progress is finished with the old ones.
   * @param {Array<{ name: string, spotter: SpotterLike }>} spotters
   */
  setSpotters(spotters) {
    if (!this._active) {
      this._spotters = spotters.slice();
      this._pending = null;
    } else {
      this._pending = spotters.slice();
    }
  }

  /** Drop the streams now (the renderer consumed a hit, or the mic is muted). */
  reset() {
    this._end();
  }

  /**
   * Feed audio. @param {Float32Array} pcm @param {number} at index of pcm[0]
   * @returns {Hit[]}
   */
  push(pcm, at) {
    /** @type {Hit[]} */
    const hits = [];
    if (this._next !== null && at !== this._next) {
      this._flushPartial(hits);
      this._gap();
    }
    this._next = at + pcm.length;
    // Whole blocks on absolute multiples of blockSamples (a partial one waits for the next frame,
    // ≤ 20 ms): the decisions do not depend on how the renderer happens to frame its audio.
    const B = this.block;
    let o = 0;
    while (o < pcm.length) {
      const idx = at + o;
      const toBoundary = B - (idx % B);
      const take = Math.min(toBoundary, pcm.length - o);
      if (this._fill === 0 && take === B) {
        this._step(pcm.subarray(o, o + B), idx, hits);
      } else {
        if (this._fill === 0) this._bufStart = idx;
        this._buf.set(pcm.subarray(o, o + take), this._fill);
        this._fill += take;
        if (take === toBoundary) this._flushPartial(hits);
      }
      o += take;
    }
    return hits;
  }

  /** Process the buffered (partial) block. @param {Hit[]} hits */
  _flushPartial(hits) {
    if (!this._fill) return;
    const blk = this._buf.slice(0, this._fill);
    this._fill = 0;
    this._step(blk, this._bufStart, hits);
  }

  /** @param {Float32Array} blk @param {number} start @param {Hit[]} hits */
  _step(blk, start, hits) {
    const end = start + blk.length;
    const st = this.stats;
    st.blocks++;
    st.samples += blk.length;
    const speaking = !!this.vad.accept(blk);
    if (speaking) st.speechSamples += blk.length;
    if (speaking && !this._wasSpeaking) {
      st.onsets++;
      if (!this._active || end - this._lastSpeechEnd >= this.quiet) this._fresh(start, true, true);
    }
    // (after the onset: with the look-ahead, an utterance's level starts with its own first block)
    this.agc?.observe(blk, speaking);
    this._wasSpeaking = speaking;
    if (speaking) this._lastSpeechEnd = end;
    if (this._active && end - this._lastSpeechEnd > this.hangover) {
      if (this._hold) {
        // an utterance shorter than the look-ahead: decode what was held before the stream ends
        this._release(end);
        this._drain(end, hits);
      }
      this._end();
    }
    // continuous speech without a quiet gap: a new set of streams, the old one overlapping (§7.5)
    if (this._active && speaking && this.maxStream > 0 && !this._hold && start - this._streamAt >= this.maxStream) this._renew(start);
    if (this._active) {
      st.fedSamples += blk.length;
      if (this._hold) {
        this._hold.blocks.push(blk.slice());
        if (speaking) this._hold.speech += blk.length;
        if (this._hold.speech >= this.lookahead) this._release(end);
      } else this._feed(this.agc ? this.agc.apply(blk) : blk, end);
      if (!this._hold) this._drain(end, hits);
    }
    this._pushRing(blk);
  }

  /** Feed one block to every live stream. @param {Float32Array} x @param {number} end */
  _feed(x, end) {
    if (this._streams.some((r) => end - x.length >= r.until)) this._streams = this._streams.filter((r) => end - x.length < r.until);
    for (const r of this._streams) {
      if (r.spent) continue;
      if (r.name === 'name' && end - r.at > this.nameFeed) {
        r.spent = true;
        continue;
      }
      r.spotter.accept(r.s, x);
    }
  }

  /** The look-ahead is over: feed the held audio with this utterance's gain. @param {number} end */
  _release(end) {
    const held = /** @type {{ blocks: Float32Array[] }} */ (this._hold).blocks;
    this._hold = null;
    for (const b of held) this._feed(this.agc ? this.agc.apply(b) : b, end);
  }

  /** Collect the spotters' hits; report the best one and renew the streams. @param {number} end @param {Hit[]} hits */
  _drain(end, hits) {
    /** @type {Hit|null} */
    let best = null;
    for (const r of this._streams) {
      if (r.spent) continue;
      for (const h of r.spotter.drain(r.s)) {
        const kw = /** @type {Hit['keyword']} */ (h.keyword);
        if (!(kw in PRIORITY) || !Array.isArray(h.timestamps) || !h.timestamps.length) continue;
        const t0 = Math.round(h.timestamps[0] * this.sampleRate);
        const t1 = Math.round(h.timestamps[h.timestamps.length - 1] * this.sampleRate);
        if (kw === 'JADE') {
          // the name stream fires once per stream at most; only "Jade, …" right at the start counts
          r.spent = true;
          if (t0 > this.namePrefix) continue;
        }
        /** @type {Hit} */
        const hit = { keyword: kw, model: r.name, streamAt: r.at, startAt: r.at + t0, endAt: r.at + t1, emitAt: end };
        if (this.stampLate > 0 && end - hit.endAt > this.stampLate) {
          // drifted timestamps (a long stream): the keyword ended just before it was decided
          hit.endAt = Math.max(r.at, end - this.reanchorBy);
          hit.startAt = Math.max(r.at, hit.endAt - Math.min(Math.max(0, t1 - t0), this.maxKeyword));
          hit.reanchored = true;
          this.stats.reanchored++;
        }
        if (!best || PRIORITY[kw] < PRIORITY[best.keyword]) best = hit;
      }
    }
    if (best) {
      this.stats.hits++;
      hits.push(best);
      this._fresh(end, false, false); // one hit per stream: renew all of them (no pre-roll: it was this utterance)
    }
  }

  /**
   * New streams for every spotter, starting at `start` (minus the pre-roll when asked). At an
   * utterance onset with the level normaliser and a look-ahead, the feed is held until that much
   * speech has set this utterance's level, and then given to the spotters at once.
   * @param {number} start @param {boolean} preroll @param {boolean} onset
   */
  _fresh(start, preroll, onset) {
    if (this._pending) {
      this._spotters = this._pending;
      this._pending = null;
    }
    this._active = true;
    const pre = preroll ? this._ringTail() : null;
    this._streamAt = start - (pre ? pre.length : 0);
    this._streams = this._spotters.map(({ name, spotter }) => ({ name, spotter, s: spotter.newStream(), spent: false, at: this._streamAt, until: Infinity }));
    this.stats.streams += this._streams.length;
    if (preroll) this.stats.fresh++;
    if (onset && this.agc && this.lookahead > 0) {
      this.agc.beginUtterance?.();
      this._hold = { blocks: pre && pre.length ? [pre] : [], speech: 0 };
    } else {
      this._hold = null;
      if (pre && pre.length) this._feed(this.agc ? this.agc.apply(pre) : pre, start);
    }
    this._onStreams?.(this._streams.length);
  }

  /**
   * Renew during continuous speech: new streams from `start` (with the pre-roll); the current ones
   * go on for overlapMs, so a call that began before the renewal is still heard whole.
   * @param {number} start
   */
  _renew(start) {
    if (this._pending) {
      this._spotters = this._pending;
      this._pending = null;
    }
    const until = start + this.overlap;
    const old = this._streams.filter((r) => !r.spent && r.until === Infinity).map((r) => ({ ...r, until }));
    const pre = this._ringTail();
    this._streamAt = start - pre.length;
    const fresh = this._spotters.map(({ name, spotter }) => ({ name, spotter, s: spotter.newStream(), spent: false, at: this._streamAt, until: Infinity }));
    this._streams = this.overlap > 0 ? [...old, ...fresh] : fresh;
    this.stats.streams += fresh.length;
    this.stats.renewals++;
    if (pre.length) {
      const x = this.agc ? this.agc.apply(pre) : pre;
      for (const r of fresh) r.spotter.accept(r.s, x);
    }
    this._onStreams?.(fresh.length);
  }

  _end() {
    this._active = false;
    this._hold = null;
    this._streams = [];
    if (this._pending) {
      this._spotters = this._pending;
      this._pending = null;
    }
  }

  _gap() {
    this.stats.gaps++;
    this._end();
    this.vad.reset();
    this._ringPos = 0;
    this._ringFill = 0;
    this._wasSpeaking = false;
    this._lastSpeechEnd = -Infinity;
  }

  /** @param {Float32Array} blk */
  _pushRing(blk) {
    const n = this._ring.length;
    if (!this.preroll) return;
    if (blk.length >= n) {
      this._ring.set(blk.subarray(blk.length - n));
      this._ringPos = 0;
      this._ringFill = n;
      return;
    }
    const k = Math.min(blk.length, n - this._ringPos);
    this._ring.set(blk.subarray(0, k), this._ringPos);
    this._ring.set(blk.subarray(k), 0);
    this._ringPos = (this._ringPos + blk.length) % n;
    this._ringFill = Math.min(n, this._ringFill + blk.length);
  }

  /** The last ≤ prerollMs of audio (oldest first), excluding the current block. */
  _ringTail() {
    const n = this._ring.length;
    const fill = this.preroll ? this._ringFill : 0;
    const out = new Float32Array(fill);
    if (!fill) return out;
    // the newest sample is at ringPos - 1
    const start = (this._ringPos - fill + n) % n;
    if (start + fill <= n) out.set(this._ring.subarray(start, start + fill));
    else {
      out.set(this._ring.subarray(start));
      out.set(this._ring.subarray(0, fill - (n - start)), n - start);
    }
    return out;
  }
}
