// AudioPlayer: ordered playback queue for synthesized speech.
//
// Clips are played strictly in the order they were enqueued:
//   { kind: 'audio', audioB64 | wav | samples+sampleRate, visemes?, text? }  → Web Audio
//   { kind: 'speech', text, rate? }                                         → Web Speech (fallback)
// Audio clips go through a per-clip gain (click-free stop) into an AnalyserNode, which the
// lip-sync reads for level/spectrum; `current.time` is the playback clock of the clip (output
// latency compensated) used to sample viseme timelines.
//
// Events: 'start' (clip), 'end' (clip, { stopped }), 'idle', 'boundary' ({ word, clip }), 'error' (err, clip)

import { Emitter } from '../app/emitter.js';
import { base64ToBytes, decodeWav } from './wav.js';

/**
 * @typedef {object} AudioClip
 * @property {'audio'} kind
 * @property {string} [audioB64]   WAV file, base64
 * @property {ArrayBuffer} [wav]   WAV file
 * @property {Float32Array} [samples]
 * @property {number} [sampleRate]
 * @property {Array<{start:number,end:number,viseme:string}>|null} [visemes]
 * @property {string} [text]
 */
/**
 * @typedef {object} SpeechClip
 * @property {'speech'} kind
 * @property {string} text
 * @property {number} [rate]
 */
/** @typedef {AudioClip|SpeechClip} Clip */

export class AudioPlayer extends Emitter {
  /**
   * @param {object} [deps]
   * @param {() => AudioContext} [deps.createContext]   lazily creates the AudioContext
   * @param {{ speak: Function, cancel: Function, available?: boolean }|null} [deps.speech]  Web Speech wrapper
   * @param {() => number} [deps.now]                    seconds clock for speech clips
   */
  constructor(deps = {}) {
    super();
    this._createContext = deps.createContext || defaultContextFactory;
    this.speech = deps.speech || null;
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Array<{ clip: Clip, resolve: (r: { stopped: boolean, error?: Error }) => void }>} */
    this._queue = [];
    /** @type {null | { clip: Clip, kind: 'audio'|'speech', resolve: Function, source?: AudioBufferSourceNode, gain?: GainNode, startAt: number, duration: number }} */
    this._playing = null;
    this._timeBuf = null;
    this._disposed = false;
  }

  /** Something is playing or queued. */
  get busy() {
    return !!this._playing || this._queue.length > 0;
  }

  /** Sample rate of the output (for spectrum bin mapping). */
  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  /** The clip being played and its playback time in seconds, or null. */
  get current() {
    const p = this._playing;
    if (!p) return null;
    let time;
    if (p.kind === 'audio' && this.ctx) {
      const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      time = Math.max(0, this.ctx.currentTime - p.startAt - latency);
    } else {
      time = Math.max(0, this._now() - p.startAt);
    }
    return { clip: p.clip, kind: p.kind, time };
  }

  /** Create/resume the AudioContext (call from a user gesture in browsers). */
  async unlock() {
    const ctx = this._ensureContext();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* still locked; a later gesture will retry */ }
    }
    return !!ctx && ctx.state === 'running';
  }

  /**
   * Queue a clip. Resolves when it finished ({ stopped: false }) or was stopped/flushed.
   * @param {Clip} clip
   * @returns {Promise<{ stopped: boolean, error?: Error }>}
   */
  enqueue(clip) {
    return new Promise((resolve) => {
      if (this._disposed) {
        resolve({ stopped: true });
        return;
      }
      this._queue.push({ clip, resolve });
      if (!this._playing) this._next();
    });
  }

  /** Stop the current clip and drop everything queued. */
  stop() {
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) q.resolve({ stopped: true });
    const p = this._playing;
    if (p) {
      this._playing = null;
      if (p.kind === 'audio') this._stopSource(p);
      else {
        try { this.speech?.cancel(); } catch { /* ignore */ }
      }
      p.resolve({ stopped: true });
      this.emit('end', p.clip, { stopped: true });
    }
    if (p || queued.length) this.emit('idle');
  }

  /** Linear RMS of the current output (0 when silent / unavailable). */
  level() {
    const a = this.analyser;
    if (!a || !this._playing || this._playing.kind !== 'audio') return 0;
    if (!this._timeBuf || this._timeBuf.length !== a.fftSize) this._timeBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this._timeBuf);
    let acc = 0;
    for (let i = 0; i < this._timeBuf.length; i++) acc += this._timeBuf[i] * this._timeBuf[i];
    return Math.sqrt(acc / this._timeBuf.length);
  }

  /**
   * Fill `out` with the current spectrum in dB (AnalyserNode.getFloatFrequencyData).
   * @param {Float32Array} out @returns {boolean} false when no audio is playing
   */
  spectrum(out) {
    const a = this.analyser;
    if (!a || !this._playing || this._playing.kind !== 'audio') return false;
    if (out.length !== a.frequencyBinCount) return false;
    a.getFloatFrequencyData(/** @type {any} */ (out));
    return true;
  }

  dispose() {
    this._disposed = true;
    this.stop();
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.analyser = null;
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------

  _ensureContext() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = this._createContext();
    } catch (err) {
      console.warn('[player] Web Audio unavailable:', err);
      this.ctx = null;
      return null;
    }
    if (!this.ctx) return null;
    const a = this.ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.55;
    a.connect(this.ctx.destination);
    this.analyser = a;
    return this.ctx;
  }

  _next() {
    if (this._playing || this._disposed) return;
    const item = this._queue.shift();
    if (!item) {
      this.emit('idle');
      return;
    }
    const { clip, resolve } = item;
    if (clip && clip.kind === 'speech') this._playSpeech(clip, resolve);
    else this._playAudio(/** @type {AudioClip} */ (clip), resolve);
  }

  /** @param {Clip} clip @param {Function} resolve @param {Error} err */
  _fail(clip, resolve, err) {
    this.emit('error', err, clip);
    resolve({ stopped: false, error: err });
    this.emit('end', clip, { stopped: false });
    queueMicrotask(() => this._next());
  }

  /** @param {AudioClip} clip @param {Function} resolve */
  _playAudio(clip, resolve) {
    const ctx = this._ensureContext();
    if (!ctx || !this.analyser) {
      this._fail(clip, resolve, new Error('Web Audio is not available'));
      return;
    }
    let buffer;
    try {
      buffer = toAudioBuffer(ctx, clip);
    } catch (err) {
      this._fail(clip, resolve, /** @type {Error} */ (err));
      return;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.analyser);
    const startAt = ctx.currentTime + 0.01;
    const entry = { clip, kind: /** @type {const} */ ('audio'), resolve, source, gain, startAt, duration: buffer.duration };
    this._playing = entry;
    source.onended = () => {
      if (this._playing !== entry) return;
      this._playing = null;
      this._disconnect(entry);
      resolve({ stopped: false });
      this.emit('end', clip, { stopped: false });
      this._next();
    };
    try {
      source.start(startAt);
    } catch (err) {
      this._playing = null;
      this._disconnect(entry);
      this._fail(clip, resolve, /** @type {Error} */ (err));
      return;
    }
    this.emit('start', clip);
  }

  /** @param {SpeechClip} clip @param {Function} resolve */
  _playSpeech(clip, resolve) {
    const speech = this.speech;
    if (!speech) {
      this._fail(clip, resolve, new Error('Browser speech synthesis is not available'));
      return;
    }
    const entry = { clip, kind: /** @type {const} */ ('speech'), resolve, startAt: this._now(), duration: 0 };
    this._playing = entry;
    this.emit('start', clip);
    Promise.resolve()
      .then(() => speech.speak(clip.text, {
        rate: clip.rate,
        onStart: () => { if (this._playing === entry) entry.startAt = this._now(); },
        onBoundary: (/** @type {string} */ word) => { if (this._playing === entry) this.emit('boundary', { word, clip }); },
      }))
      .catch((err) => {
        if (this._playing === entry) this.emit('error', err, clip);
      })
      .finally(() => {
        if (this._playing !== entry) return;
        this._playing = null;
        resolve({ stopped: false });
        this.emit('end', clip, { stopped: false });
        this._next();
      });
  }

  /** Fade out quickly (no click) and stop. */
  _stopSource(entry) {
    const ctx = this.ctx;
    try {
      if (ctx && entry.gain) {
        const t = ctx.currentTime;
        entry.gain.gain.cancelScheduledValues(t);
        entry.gain.gain.setValueAtTime(entry.gain.gain.value, t);
        entry.gain.gain.linearRampToValueAtTime(0, t + 0.03);
        entry.source.onended = null;
        entry.source.stop(t + 0.04);
        setTimeout(() => this._disconnect(entry), 80);
      } else {
        entry.source?.stop();
        this._disconnect(entry);
      }
    } catch {
      this._disconnect(entry);
    }
  }

  _disconnect(entry) {
    try { entry.source?.disconnect(); } catch { /* ignore */ }
    try { entry.gain?.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Build an AudioBuffer from a clip (base64 WAV, WAV bytes or raw samples).
 * @param {BaseAudioContext} ctx @param {AudioClip} clip
 */
export function toAudioBuffer(ctx, clip) {
  let samples;
  let rate;
  if (clip.samples && clip.sampleRate) {
    samples = clip.samples;
    rate = clip.sampleRate;
  } else {
    const bytes = clip.wav ? new Uint8Array(clip.wav) : clip.audioB64 ? base64ToBytes(clip.audioB64) : null;
    if (!bytes) throw new Error('clip has no audio');
    const d = decodeWav(bytes);
    samples = d.samples;
    rate = d.sampleRate;
  }
  if (!samples.length) throw new Error('clip is empty');
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (samples), 0);
  return buf;
}

function defaultContextFactory() {
  const AC = globalThis.AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
  if (!AC) throw new Error('AudioContext is not supported');
  return new AC({ latencyHint: 'interactive' });
}
