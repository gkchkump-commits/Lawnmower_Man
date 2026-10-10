// "Hey Jade" must not wake her up when she says her own name (contract-wake §8.5).
//
// Four defences, cheapest first: Chromium's echo canceller (the mic constraint, src/audio/mic.js),
// the persona (she never says "hey Jade"), this text mask, and stage 2's self-talk rule
// (src/wake/phrase.js). The mask knows what she is saying: every clip the speech queue plays
// (her replies, her own say() lines) with its text, from 'playing' to the player's 'end'. A
// stage-1 hit whose keyword overlaps a clip that contains her name, from 100 ms before it to
// 400 ms after it, is ignored. The keyword's time comes from the utility in 16 kHz sample
// indices of the mic tap; TapClock maps those to performance.now() through the arrival time of
// each block, minus the capture latency (0.03 s; 0.17 s more with the 'all' echo canceller,
// which delays the capture so the reference arrives first).
//
// echo() is the last check on a transcript: a command whose words are mostly those of one of
// her sentences from the last 10 s is her own voice coming back, not the user.
//
// Pure (clock injected): tests/unit/wake/self-mask.test.js.

import { normalize } from './phrase.js';

/** her name in a sentence ("I'm Jade", "Jade here", and the spellings a TTS line might use) */
export const HAS_NAME = /\bja(?:de|ed|yde|ide)\b/i;

/** Capture latency of the mic path in seconds (the 'all' echo canceller adds 170 ms). @param {any} echo */
export function inputLatencySec(echo) {
  return 0.03 + (echo === 'all' ? 0.17 : 0);
}

/**
 * Maps 16 kHz tap sample indices to performance.now() milliseconds.
 */
export class TapClock {
  /** @param {{ rate?: number, keepMs?: number }} [o] */
  constructor(o = {}) {
    this.rate = o.rate ?? 16000;
    this.keepSamples = Math.round(((o.keepMs ?? 6000) / 1000) * this.rate);
    /** @type {Array<{ at: number, len: number, arrival: number }>} */
    this.blocks = [];
  }

  /** A block of `len` samples starting at index `at` arrived at `arrivalPerf` (its last sample). */
  push(at, len, arrivalPerf) {
    if (!(len > 0) || !Number.isFinite(at) || !Number.isFinite(arrivalPerf)) return;
    this.blocks.push({ at, len, arrival: arrivalPerf });
    const keepFrom = at + len - this.keepSamples;
    while (this.blocks.length > 2 && this.blocks[0].at + this.blocks[0].len < keepFrom) this.blocks.shift();
  }

  clear() {
    this.blocks = [];
  }

  /**
   * When sample `idx` reached the microphone, in performance.now() ms; null before any block.
   * Outside the known blocks it extrapolates from the nearest one.
   * @param {number} idx @param {number} [latencySec]
   */
  perf(idx, latencySec = 0) {
    const b = this.blocks;
    if (!b.length) return null;
    let blk = b[b.length - 1];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].at <= idx) {
        blk = b[i];
        break;
      }
      blk = b[i];
    }
    // the block's last sample arrived at blk.arrival
    return blk.arrival - ((blk.at + blk.len - idx) / this.rate) * 1000 - latencySec * 1000;
  }
}

/**
 * @typedef {object} SpokenClip
 * @property {any} key          the clip object (matched against the player's 'end')
 * @property {string} text
 * @property {'audio'|'speech'} kind   her local voice / the system voice
 * @property {boolean} hasName
 * @property {number} startPerf
 * @property {number} endPerf   Infinity while it plays
 */

export class SelfMask {
  /**
   * @param {{ now?: () => number, preMs?: number, tailMs?: number, echoWindowMs?: number, jaccard?: number, keepMs?: number }} [o]
   */
  constructor(o = {}) {
    this._now = o.now || (() => performance.now());
    this.preMs = o.preMs ?? 100;
    this.tailMs = o.tailMs ?? 400;
    this.echoWindowMs = o.echoWindowMs ?? 10000;
    this.jaccard = o.jaccard ?? 0.8;
    this.keepMs = o.keepMs ?? 30000;
    /** @type {SpokenClip[]} */
    this.clips = [];
    /** @type {Set<string>} texts the mask lets through (the echo test) */
    this._exempt = new Set();
  }

  /**
   * A clip of hers started playing.
   * @param {{ key: any, text: string, kind?: string, startPerf?: number }} c
   */
  clipStart(c) {
    const text = String(c.text || '');
    this.clips.push({
      key: c.key,
      text,
      kind: c.kind === 'speech' ? 'speech' : 'audio',
      hasName: HAS_NAME.test(text) && !this._exempt.has(text.trim()),
      startPerf: c.startPerf ?? this._now(),
      endPerf: Infinity,
    });
    this._prune();
  }

  /** The player finished (or stopped) a clip. @param {any} key @param {number} [endPerf] */
  clipEnd(key, endPerf = this._now()) {
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const c = this.clips[i];
      if (c.key === key && c.endPerf === Infinity) {
        c.endPerf = endPerf;
        return;
      }
    }
  }

  /** Everything she was saying stopped (barge-in, a new reply). @param {number} [endPerf] */
  allEnded(endPerf = this._now()) {
    for (const c of this.clips) if (c.endPerf === Infinity) c.endPerf = endPerf;
  }

  /** Let this exact text through (the echo test says a line that is designed to wake her). @param {string} text */
  exempt(text) {
    this._exempt.add(String(text).trim());
  }

  /** @param {string} text */
  unexempt(text) {
    this._exempt.delete(String(text).trim());
  }

  /**
   * Is a hit whose keyword spans [startPerf, endPerf] her own voice saying her name?
   * @param {number|null} startPerf @param {number|null} endPerf
   * @returns {null | { reason: 'self'|'system', text: string }}
   */
  masked(startPerf, endPerf) {
    if (startPerf == null || endPerf == null) {
      // no timing (no tap blocks yet): mask while a clip with her name plays
      const c = this.clips.find((x) => x.hasName && x.endPerf === Infinity);
      return c ? { reason: c.kind === 'speech' ? 'system' : 'self', text: c.text } : null;
    }
    const a = Math.min(startPerf, endPerf);
    const b = Math.max(startPerf, endPerf);
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const c = this.clips[i];
      if (!c.hasName) continue;
      if (a <= c.endPerf + this.tailMs && b >= c.startPerf - this.preMs) return { reason: c.kind === 'speech' ? 'system' : 'self', text: c.text };
    }
    return null;
  }

  /** Is she speaking a clip with her name right now (incl. the tail)? */
  speakingName(now = this._now()) {
    return this.clips.some((c) => c.hasName && now >= c.startPerf - this.preMs && now <= c.endPerf + this.tailMs);
  }

  /**
   * Is this transcript one of her sentences of the last 10 s coming back through the speakers?
   * (Jaccard similarity of the word sets ≥ 0.8, with at least 3 words.)
   * @param {string} text @param {number} [now]
   */
  echo(text, now = this._now()) {
    const words = new Set(normalize(text));
    if (words.size < 3) return false;
    for (const c of this.clips) {
      if (now - c.startPerf > this.echoWindowMs) continue;
      if (jaccard(words, new Set(normalize(c.text))) >= this.jaccard) return true;
    }
    return false;
  }

  _prune() {
    const now = this._now();
    this.clips = this.clips.filter((c) => c.endPerf === Infinity || now - c.endPerf < this.keepMs);
    if (this.clips.length > 200) this.clips.splice(0, this.clips.length - 200);
  }
}

/** @param {Set<string>} a @param {Set<string>} b */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
