// Ordered text-to-speech pipeline: sentences go in, audio comes out in the same order.
//
// Synthesis runs ahead of playback with limited parallelism: while sentence N plays, sentences
// N+1 and N+2 are already being synthesized (prefetch), but never more than `maxParallel`
// requests at once (the voice server serialises GPU work per engine anyway) and never more than
// `maxAhead` sentences beyond the one playing. Clips are handed to the player strictly in
// order; a sentence whose synthesis failed is skipped. clear() aborts everything (barge-in).
//
// Events: 'ready' (item) when a sentence's clip has been synthesized (before it plays), 'playing'
// (item) when the player starts a clip of ours, 'idle' when everything queued has been played (or
// cleared), 'error' (err, item) when a sentence could not be synthesized.

import { Emitter } from './emitter.js';
import { isAbortError } from '../speech/voice-client.js';

/**
 * @typedef {object} SpeechItem
 * @property {number} id
 * @property {string} text
 * @property {Record<string, any>} meta
 * @property {'queued'|'synth'|'ready'|'fed'|'done'|'failed'} status
 * @property {any} [clip]
 * @property {AbortController} [abort]
 */

export class SpeechQueue extends Emitter {
  /**
   * @param {object} deps
   * @param {{ synthesize: (text: string, o: { signal: AbortSignal }) => Promise<any> }} deps.tts
   * @param {{ enqueue: (clip: any) => Promise<any>, stop: () => void, on?: Function }} deps.player
   * @param {number} [deps.maxParallel] concurrent synthesis requests (default 2)
   * @param {number} [deps.maxAhead]    sentences synthesized ahead of the playing one (default 2)
   */
  constructor(deps) {
    super();
    this.tts = deps.tts;
    this.player = deps.player;
    this.maxParallel = deps.maxParallel ?? 2;
    this.maxAhead = deps.maxAhead ?? 2;
    /** @type {SpeechItem[]} */
    this.items = [];
    this._feedIdx = 0;
    this._ids = 0;
    this._gen = 0;
    this._busy = false;
    /** @type {Map<any, SpeechItem>} */
    this._byClip = new Map();
    this._offStart = typeof this.player.on === 'function'
      ? this.player.on('start', (clip) => {
        const item = this._byClip.get(clip);
        if (item) this.emit('playing', item);
      })
      : null;
  }

  /** Anything queued, synthesizing or playing. */
  get busy() {
    return this._busy;
  }

  /** Number of sentences not yet finished. */
  get pending() {
    return this.items.filter((i) => i.status !== 'done' && i.status !== 'failed').length;
  }

  /**
   * Queue a sentence.
   * @param {string} text @param {Record<string, any>} [meta]
   * @returns {SpeechItem|null}
   */
  push(text, meta = {}) {
    const t = String(text || '').trim();
    if (!t) return null;
    /** @type {SpeechItem} */
    const item = { id: ++this._ids, text: t, meta, status: 'queued' };
    this.items.push(item);
    this._busy = true;
    this._pump();
    return item;
  }

  /** Drop everything: abort synthesis, stop playback. */
  clear() {
    const wasBusy = this._busy;
    this._gen++;
    for (const it of this.items) it.abort?.abort();
    this.items = [];
    this._feedIdx = 0;
    this._byClip.clear();
    this._busy = false;
    try { this.player.stop(); } catch { /* ignore */ }
    if (wasBusy) this.emit('idle');
  }

  dispose() {
    this.clear();
    this._offStart?.();
    this.removeAllListeners();
  }

  _pump() {
    const gen = this._gen;
    // index of the first unfinished item (the one playing or next to play)
    let playIdx = this.items.findIndex((i) => i.status !== 'done' && i.status !== 'failed');
    if (playIdx < 0) playIdx = this.items.length;
    let inFlight = this.items.filter((i) => i.status === 'synth').length;
    const limit = Math.min(this.items.length, playIdx + 1 + this.maxAhead);
    for (let i = playIdx; i < limit && inFlight < this.maxParallel; i++) {
      const it = this.items[i];
      if (it.status !== 'queued') continue;
      inFlight++;
      this._synth(it, gen);
    }
    // feed ready clips to the player, strictly in order
    while (this._feedIdx < this.items.length) {
      const it = this.items[this._feedIdx];
      if (it.status === 'failed') {
        this._feedIdx++;
        continue;
      }
      if (it.status !== 'ready') break;
      it.status = 'fed';
      this._feedIdx++;
      this._byClip.set(it.clip, it);
      Promise.resolve(this.player.enqueue(it.clip)).then(() => {
        if (gen !== this._gen) return;
        it.status = 'done';
        this._byClip.delete(it.clip);
        this._pump();
      }, () => {
        if (gen !== this._gen) return;
        it.status = 'done';
        this._pump();
      });
    }
    if (this._busy && this.items.every((i) => i.status === 'done' || i.status === 'failed')) {
      this.items = [];
      this._feedIdx = 0;
      this._busy = false;
      this.emit('idle');
    }
  }

  /** @param {SpeechItem} it @param {number} gen */
  _synth(it, gen) {
    it.status = 'synth';
    it.abort = new AbortController();
    let p;
    try {
      p = Promise.resolve(this.tts.synthesize(it.text, { signal: it.abort.signal }));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then((clip) => {
        if (gen !== this._gen) return;
        it.clip = clip;
        it.status = 'ready';
        this.emit('ready', it);
        this._pump();
      }, (err) => {
        if (gen !== this._gen) return;
        it.status = 'failed';
        if (!isAbortError(err)) this.emit('error', err, it);
        this._pump();
      });
  }
}
