// AudioPlayer: ordered playback queue for synthesized speech.
//
// Clips are played strictly in the order they were enqueued:
//   { kind: 'audio', audioB64 | wav | samples+sampleRate, visemes?, text? }  → Web Audio
//   { kind: 'speech', text, rate? }                                         → Web Speech (fallback)
//
// Audio clips (the local voice):
//
//   source → clip gain ─┬→ analyser → mute → destination      the DRY voice, for the lip-sync
//                       └→ voice character (AudioWorklet) → destination
//                          (or straight to the destination for 'natural' / without the worklet)
//
// The analyser always sees the unprocessed voice, so loudness and spectrum lip-sync do not
// depend on the effect, and `current.time` is the playback clock of the dry clip (output latency
// compensated) used to sample viseme timelines. The voice character (src/audio/voicefx.js) runs
// on the audio thread with no added latency; its tail rings out in the shared worklet node after
// a clip has ended, so it neither cuts the end of a clip nor delays the next one. The system
// voice (Web Speech) cannot be processed.
//
// Events: 'start' (clip), 'end' (clip, { stopped }), 'idle', 'error' (err, clip), and for speech
// clips 'speechstart' (clip: the voice really started) and 'boundary' ({ word, charIndex,
// charLength, clip }: a word starts; charIndex into clip.text when the voice reports it)
/* global AudioWorkletNode */

import { Emitter } from '../app/emitter.js';
import { normalizeFx } from './voicefx.js';
import { base64ToBytes, decodeWav } from './wav.js';
// Bundled by Vite into its own same-origin module (voicefx.js inlined): the app's CSP only
// allows worklet scripts from 'self' (no blob: or data: URLs).
import FX_WORKLET_URL from './voicefx-worklet.js?worker&url';

/** How long the first clip may wait for the effect to load before it plays without it. */
export const FX_WAIT_MS = 30;

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
/** @typedef {import('./voicefx.js').VoiceCharacter} VoiceCharacter */
/**
 * State of the voice character effect:
 *  'off'         'natural' was chosen and the effect was never needed (nothing loaded)
 *  'loading'     the worklet module is loading
 *  'ready'       the effect is running on the audio thread
 *  'unavailable' no AudioWorklet in this environment, or it failed: the voice plays unprocessed
 * @typedef {'off'|'loading'|'ready'|'unavailable'} FxState
 */

export class AudioPlayer extends Emitter {
  /**
   * @param {object} [deps]
   * @param {() => AudioContext} [deps.createContext]   lazily creates the AudioContext
   * @param {{ speak: Function, cancel: Function, available?: boolean }|null} [deps.speech]  Web Speech wrapper
   * @param {() => number} [deps.now]                    seconds clock for speech clips
   * @param {string} [deps.fxModuleUrl]                  the voice character worklet module
   * @param {{ character?: VoiceCharacter, amount?: number }} [deps.voiceFx] initial character
   */
  constructor(deps = {}) {
    super();
    this._createContext = deps.createContext || defaultContextFactory;
    this.speech = deps.speech || null;
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    this._fxUrl = deps.fxModuleUrl || moduleUrl(FX_WORKLET_URL);
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Array<{ clip: Clip, resolve: (r: { stopped: boolean, error?: Error }) => void }>} */
    this._queue = [];
    /** @type {null | { clip: Clip, kind: 'audio'|'speech', resolve: Function, source?: AudioBufferSourceNode, gain?: GainNode, startAt: number, duration: number, buffer?: AudioBuffer, fx?: boolean }} */
    this._playing = null;
    this._timeBuf = null;
    this._disposed = false;
    /** the wanted character (applies to audio clips; 'natural' = unprocessed) */
    this._fx = normalizeFx({ character: 'natural', amount: 0, ...(deps.voiceFx || {}) });
    /** @type {FxState} */
    this.fxState = 'off';
    /** @type {AudioWorkletNode|null} */
    this._fxNode = null;
    /** @type {Promise<boolean>|null} */
    this._fxLoading = null;
    this._fxStats = new Map();
    this._fxStatsId = 0;
    /** @type {null | { clip: AudioClip, resolve: Function }} a clip waiting for the effect to load */
    this._pendingStart = null;
    if (this._fxWanted()) this._prepareFx();
  }

  /** Something is playing or queued. */
  get busy() {
    return !!this._playing || this._queue.length > 0 || !!this._pendingStart;
  }

  /** Sample rate of the output (for spectrum bin mapping). */
  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  /**
   * The clip being played and its playback time in seconds, or null. For audio clips, `buffer`
   * is the dry (unprocessed) decoded AudioBuffer.
   */
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
    /** @type {{ clip: Clip, kind: 'audio'|'speech', time: number, buffer?: AudioBuffer }} */
    const cur = { clip: p.clip, kind: p.kind, time };
    if (p.buffer) cur.buffer = p.buffer;
    return cur;
  }

  /**
   * The voice character: what is wanted and whether the effect is running.
   * `active`: audio clips are processed right now (false for 'natural', or while unavailable).
   */
  get voiceFx() {
    const { character, amount } = this._fx;
    return { character, amount, state: this.fxState, active: this._fxWanted() && this.fxState === 'ready' };
  }

  /**
   * Choose the voice character for the local voice (settings voice.character / voice.fxAmount).
   * Takes effect immediately, ramped (no clicks), also in the middle of a clip that is already
   * going through the effect. Loads the effect the first time a character other than 'natural'
   * is chosen.
   * @param {{ character?: VoiceCharacter|string, amount?: number }} o
   */
  setVoiceFx(o = {}) {
    this._fx = normalizeFx({ character: o.character ?? this._fx.character, amount: o.amount ?? this._fx.amount });
    if (this._fxNode) this._fxNode.port.postMessage({ type: 'set', ...this._fx });
    if (this._fxWanted()) this._prepareFx();
  }

  /**
   * What the effect has done so far, asked from the audio thread (tests, diagnostics); null when
   * it is not running.
   * @returns {Promise<null | { character: string, amount: number, blocks: number, inSq: number, outSq: number, diffSq: number, pitchSource: string, failed: boolean }>}
   */
  fxStats() {
    const node = this._fxNode;
    if (!node) return Promise.resolve(null);
    const id = ++this._fxStatsId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._fxStats.delete(id);
        resolve(null);
      }, 1000);
      this._fxStats.set(id, (/** @type {any} */ s) => {
        clearTimeout(timer);
        resolve(s);
      });
      node.port.postMessage({ type: 'stats', id });
    });
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
      if (!this._playing && !this._pendingStart) this._next();
    });
  }

  /** Stop the current clip and drop everything queued. */
  stop() {
    const queued = this._queue;
    this._queue = [];
    const pending = this._pendingStart;
    this._pendingStart = null;
    if (pending) queued.push(pending);
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

  /** Linear RMS of the current (dry) output (0 when silent / unavailable). */
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
   * Fill `out` with the current (dry) spectrum in dB (AnalyserNode.getFloatFrequencyData).
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
    try { this._fxNode?.disconnect(); } catch { /* ignore */ }
    this._fxNode = null;
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
    // The analyser is a tap on the dry voice; a muted path to the destination keeps it pulled
    // in every browser without making the dry voice audible next to the processed one.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    a.connect(mute);
    mute.connect(this.ctx.destination);
    this.analyser = a;
    return this.ctx;
  }

  /** A character other than natural is wanted. */
  _fxWanted() {
    return this._fx.character !== 'natural' && this._fx.amount > 0;
  }

  /**
   * Load the effect worklet once (in the background; nothing waits for it except a first clip,
   * for at most FX_WAIT_MS). @returns {Promise<boolean>} ready
   */
  _prepareFx() {
    if (this._fxNode) return Promise.resolve(true);
    if (this._fxLoading) return this._fxLoading;
    if (this.fxState === 'unavailable') return Promise.resolve(false);
    const ctx = this._ensureContext();
    if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
      this.fxState = 'unavailable';
      return Promise.resolve(false);
    }
    this.fxState = 'loading';
    this._fxLoading = ctx.audioWorklet.addModule(this._fxUrl).then(() => {
      if (this._disposed || this.ctx !== ctx) return false;
      const node = new AudioWorkletNode(ctx, 'lawnmower-voicefx', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { ...this._fx },
      });
      node.port.onmessage = (e) => this._onFxMessage(e.data);
      // a processor that throws outputs silence: send the voice around it from then on
      node.onprocessorerror = () => this._fxFailed('the voice effect stopped');
      node.connect(ctx.destination);
      this._fxNode = node;
      this.fxState = 'ready';
      return true;
    }).catch((err) => {
      this.fxState = 'unavailable';
      console.warn(`[player] the voice character effect is unavailable (${err?.message || err}); the local voice plays unprocessed`);
      return false;
    }).finally(() => {
      this._fxLoading = null;
    });
    return this._fxLoading;
  }

  /** @param {any} m */
  _onFxMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'stats') {
      const cb = this._fxStats.get(m.id);
      this._fxStats.delete(m.id);
      cb?.(m);
    } else if (m.type === 'error') {
      console.warn(`[player] the voice effect failed (${m.message}); it now passes the voice through`);
    }
  }

  /** @param {string} why */
  _fxFailed(why) {
    console.warn(`[player] ${why}; the local voice plays unprocessed`);
    const node = this._fxNode;
    this._fxNode = null;
    this.fxState = 'unavailable';
    // the clip now playing through the node: route it straight to the destination
    const p = this._playing;
    if (p && p.fx && p.gain && this.ctx) {
      try { p.gain.disconnect(node); } catch { /* ignore */ }
      try { p.gain.connect(this.ctx.destination); } catch { /* ignore */ }
      p.fx = false;
    }
    try { node?.disconnect(); } catch { /* ignore */ }
  }

  _next() {
    if (this._playing || this._pendingStart || this._disposed) return;
    const item = this._queue.shift();
    if (!item) {
      this.emit('idle');
      return;
    }
    const { clip, resolve } = item;
    if (clip && clip.kind === 'speech') this._playSpeech(clip, resolve);
    else this._startAudio(/** @type {AudioClip} */ (clip), resolve);
  }

  /** @param {Clip} clip @param {Function} resolve @param {Error} err */
  _fail(clip, resolve, err) {
    this.emit('error', err, clip);
    resolve({ stopped: false, error: err });
    this.emit('end', clip, { stopped: false });
    queueMicrotask(() => this._next());
  }

  /**
   * Play an audio clip; when the effect is wanted but still loading (only before the very first
   * processed clip), wait for it for at most FX_WAIT_MS.
   * @param {AudioClip} clip @param {Function} resolve
   */
  _startAudio(clip, resolve) {
    const loading = this._fxWanted() ? this._fxLoading : null;
    if (!loading) {
      this._playAudio(clip, resolve);
      return;
    }
    const item = { clip, resolve };
    this._pendingStart = item;
    const go = () => {
      // stop() resolved it meanwhile (or it already started)
      if (this._pendingStart !== item) return;
      this._pendingStart = null;
      this._playAudio(clip, resolve);
    };
    loading.then(go, go);
    setTimeout(go, FX_WAIT_MS);
  }

  /** @param {AudioClip} clip @param {Function} resolve */
  _playAudio(clip, resolve) {
    const ctx = this._ensureContext();
    if (!ctx || !this.analyser) {
      this._fail(clip, resolve, new Error('Web Audio is not available'));
      return;
    }
    let buffer;
    let samples;
    try {
      ({ buffer, samples } = toAudioBuffer(ctx, clip, true));
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
    const fxNode = this._fxWanted() ? this._fxNode : null;
    gain.connect(fxNode || ctx.destination);
    const startAt = ctx.currentTime + 0.01;
    const entry = { clip, kind: /** @type {const} */ ('audio'), resolve, source, gain, startAt, duration: buffer.duration, buffer, fx: !!fxNode };
    this._playing = entry;
    if (fxNode && samples) {
      // the effect analyses the clip's pitch ahead of the playhead (transferred: no copy)
      try {
        fxNode.port.postMessage({ type: 'clip', samples, rate: buffer.sampleRate, startTime: startAt }, [samples.buffer]);
      } catch { /* the live pitch tracker takes over */ }
    }
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
        onStart: () => {
          if (this._playing !== entry) return;
          entry.startAt = this._now();
          this.emit('speechstart', clip);
        },
        onBoundary: (/** @type {string} */ word, /** @type {{ charIndex?: number, charLength?: number }} */ info) => {
          if (this._playing === entry) this.emit('boundary', { word, charIndex: info?.charIndex, charLength: info?.charLength, clip });
        },
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
 * @param {boolean} [withSamples]  also return a private copy of the mono samples
 * @returns {any} the AudioBuffer, or { buffer, samples } with `withSamples`
 */
export function toAudioBuffer(ctx, clip, withSamples = false) {
  let samples;
  let rate;
  let own = false;
  if (clip.samples && clip.sampleRate) {
    samples = clip.samples;
    rate = clip.sampleRate;
  } else {
    const bytes = clip.wav ? new Uint8Array(clip.wav) : clip.audioB64 ? base64ToBytes(clip.audioB64) : null;
    if (!bytes) throw new Error('clip has no audio');
    const d = decodeWav(bytes);
    samples = d.samples;
    rate = d.sampleRate;
    own = true;
  }
  if (!samples.length) throw new Error('clip is empty');
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (samples), 0);
  if (!withSamples) return buf;
  // decoded samples are ours to hand over; a caller's array is copied, never detached
  return { buffer: buf, samples: own ? samples : new Float32Array(samples) };
}

/** Resolve a bundled module path against the page (the app is served from app://lawnmower/). @param {string} u */
function moduleUrl(u) {
  try {
    return new URL(u, globalThis.document?.baseURI || globalThis.location?.href).href;
  } catch {
    return u;
  }
}

function defaultContextFactory() {
  const AC = globalThis.AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
  if (!AC) throw new Error('AudioContext is not supported');
  return new AC({ latencyHint: 'interactive' });
}
