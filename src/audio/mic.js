// Microphone capture for voice input.
//
// getUserMedia (echo cancellation, noise suppression, auto gain) → AudioWorklet capture
// (same-origin module; Blob-URL and ScriptProcessor fallbacks) → streaming resampler to
// 16 kHz → energy VAD → PCM16 WAV utterances for the voice server's /stt.
//
// Modes:
//   'ptt'        push-to-talk: record until stop(); leading/trailing silence trimmed
//   'utterance'  one utterance, ended automatically by the VAD (or by stop())
//   'handsfree'  continuous: every utterance the VAD detects is emitted; pause()/resume()
//                implement half-duplex (no listening while the avatar speaks)
//
// Events: 'speechstart', 'utterance' ({ wav, durationMs, speechMs }), 'discard' ({ reason }),
//         'error' (Error), 'state' ({ active, mode, paused })
// The device is released `idleCloseMs` after the last use so the OS microphone indicator does
// not stay on.
/* global AudioWorkletNode */

import { Emitter } from '../app/emitter.js';
import { Resampler, dbToUnit, rms, toDb } from './dsp.js';
import { EnergyVad, concat, trimSilence } from './vad.js';
import { encodeWav } from './wav.js';
// Emitted as a separate same-origin file (never inlined as a data: URL, which the app's CSP
// would block for worklet scripts).
import WORKLET_URL from './mic-worklet.js?url&no-inline';

export const TARGET_RATE = 16000;
const MAX_PTT_SEC = 120;

/** Same code as ./mic-worklet.js (Blob-URL fallback when the module file cannot be loaded). */
const WORKLET_SOURCE = `class LawnmowerCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._size = 2048; this._buf = new Float32Array(this._size); this._n = 0; this._alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this._alive = false; }; }
  process(inputs) { const input = inputs[0];
    if (input && input.length) { const ch0 = input[0]; const chans = input.length;
      for (let i = 0; i < ch0.length; i++) { let v = ch0[i]; for (let c = 1; c < chans; c++) v += input[c][i];
        this._buf[this._n++] = chans > 1 ? v / chans : v;
        if (this._n === this._size) { const out = this._buf; this.port.postMessage(out, [out.buffer]); this._buf = new Float32Array(this._size); this._n = 0; } } }
    return this._alive; } }
registerProcessor('lawnmower-capture', LawnmowerCaptureProcessor);`;

/**
 * Turn getUserMedia errors into messages a user can act on.
 * @param {any} err
 */
export function describeMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow microphone access for Lawnmower Man in your system privacy settings (Windows: Settings › Privacy & security › Microphone).';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Plug one in or pick a default input device in your sound settings.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is in use by another application or could not be started.';
  return `The microphone could not be started${err?.message ? `: ${err.message}` : ''}.`;
}

export class Mic extends Emitter {
  /**
   * @param {object} [deps]
   * @param {(c: MediaStreamConstraints) => Promise<MediaStream>} [deps.getUserMedia]
   * @param {() => AudioContext} [deps.createContext]
   * @param {import('./vad.js').VadOptions} [deps.vad]
   * @param {number} [deps.idleCloseMs]   release the device after this long unused (default 20 s)
   * @param {number} [deps.noSpeechMs]    'utterance' mode gives up without speech (default 8 s)
   */
  constructor(deps = {}) {
    super();
    this._gum = deps.getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this._createContext = deps.createContext || (() => new AudioContext({ latencyHint: 'interactive' }));
    this._vadOpts = { sampleRate: TARGET_RATE, ...(deps.vad || {}) };
    this.idleCloseMs = deps.idleCloseMs ?? 20000;
    this.noSpeechMs = deps.noSpeechMs ?? 8000;
    /** @type {null|'ptt'|'utterance'|'handsfree'} */
    this.mode = null;
    this.paused = false;
    this.level = 0;
    this._stream = /** @type {MediaStream|null} */ (null);
    this._ctx = /** @type {AudioContext|null} */ (null);
    this._nodes = /** @type {AudioNode[]} */ ([]);
    this._opening = /** @type {Promise<void>|null} */ (null);
    this._resampler = /** @type {Resampler|null} */ (null);
    this._vad = new EnergyVad(this._vadOpts);
    /** @type {Float32Array[]} */
    this._rec = [];
    this._recLen = 0;
    this._idleTimer = 0;
    this._noSpeechTimer = 0;
    this._heard = false;
  }

  get supported() {
    return !!globalThis.navigator?.mediaDevices?.getUserMedia;
  }

  get active() {
    return this.mode !== null;
  }

  /**
   * Start capturing in `mode`. Throws (with a friendly message) if the mic can't be opened.
   * @param {'ptt'|'utterance'|'handsfree'} mode
   */
  async start(mode) {
    clearTimeout(this._idleTimer);
    try {
      await this._open();
    } catch (err) {
      const e = new Error(describeMicError(err));
      e.name = /** @type {any} */ (err)?.name || 'MicError';
      throw e;
    }
    if (this._ctx && this._ctx.state === 'suspended') await this._ctx.resume().catch(() => {});
    this.mode = mode;
    this.paused = false;
    this._rec = [];
    this._recLen = 0;
    this._heard = false;
    this._resetVad();
    clearTimeout(this._noSpeechTimer);
    if (mode === 'utterance') {
      this._noSpeechTimer = /** @type {any} */ (setTimeout(() => {
        if (this.mode === 'utterance' && !this._heard && !this._vad.speaking) {
          this._finishCapture();
          this.emit('discard', { reason: 'no-speech' });
        }
      }, this.noSpeechMs));
    }
    this._emitState();
  }

  /**
   * Stop capturing and return the recorded utterance ('ptt', 'utterance'), or null when
   * nothing usable was recorded.
   * @returns {Promise<{ wav: ArrayBuffer, durationMs: number, speechMs: number }|null>}
   */
  async stop() {
    const mode = this.mode;
    if (!mode) return null;
    /** @type {{ wav: ArrayBuffer, durationMs: number, speechMs: number }|null} */
    let result = null;
    if (mode === 'ptt') {
      const all = concat(this._rec);
      const { samples, speechMs } = trimSilence(all, TARGET_RATE);
      if (speechMs >= 150 && samples.length) {
        result = { wav: encodeWav(samples, TARGET_RATE), durationMs: Math.round((samples.length / TARGET_RATE) * 1000), speechMs };
      }
    } else if (mode === 'utterance') {
      const ev = this._vad.end().find((e) => e.type === 'speechend');
      if (ev && ev.type === 'speechend') result = { wav: encodeWav(ev.samples, TARGET_RATE), durationMs: ev.durationMs, speechMs: ev.speechMs };
    }
    this._finishCapture();
    return result;
  }

  /** Stop without producing an utterance. */
  cancel() {
    if (!this.mode) return;
    this._finishCapture();
  }

  /** Half-duplex: ignore input while the avatar speaks (hands-free). */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.level = 0;
    this._emitState();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._resetVad();
    this._emitState();
  }

  /** Release the device now. */
  close() {
    clearTimeout(this._idleTimer);
    clearTimeout(this._noSpeechTimer);
    this.mode = null;
    for (const n of this._nodes) {
      try { /** @type {any} */ (n).port?.postMessage('stop'); } catch { /* ignore */ }
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this._nodes = [];
    for (const t of this._stream?.getTracks() || []) {
      try { t.stop(); } catch { /* ignore */ }
    }
    this._stream = null;
    try { this._ctx?.close(); } catch { /* ignore */ }
    this._ctx = null;
    this._resampler = null;
    this.level = 0;
  }

  dispose() {
    this.close();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------

  _finishCapture() {
    clearTimeout(this._noSpeechTimer);
    this.mode = null;
    this.paused = false;
    this.level = 0;
    this._rec = [];
    this._recLen = 0;
    this._emitState();
    clearTimeout(this._idleTimer);
    this._idleTimer = /** @type {any} */ (setTimeout(() => { if (!this.mode) this.close(); }, this.idleCloseMs));
  }

  _emitState() {
    this.emit('state', { active: this.active, mode: this.mode, paused: this.paused });
  }

  _resetVad() {
    // keep the learned noise floor across utterances
    const floor = this._vad.floorDb;
    const calibrated = this._vad._frames > 0;
    this._vad.reset();
    if (calibrated) {
      this._vad.floorDb = floor;
      this._vad._frames = 1e9; // skip the calibration phase
    }
  }

  async _open() {
    if (this._stream && this._ctx && this._stream.getAudioTracks().some((t) => t.readyState === 'live')) return;
    if (this._opening) return this._opening;
    this._opening = (async () => {
      this.close();
      const stream = await this._gum({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
        },
        video: false,
      });
      const ctx = this._createContext();
      this._stream = stream;
      this._ctx = ctx;
      for (const t of stream.getAudioTracks()) t.addEventListener?.('ended', () => this._onTrackEnded());
      this._resampler = new Resampler(ctx.sampleRate, TARGET_RATE);
      const src = ctx.createMediaStreamSource(stream);
      this._nodes.push(src);
      const node = await this._captureNode(ctx);
      src.connect(node);
      this._nodes.push(node);
    })();
    try {
      await this._opening;
    } catch (err) {
      this.close();
      throw err;
    } finally {
      this._opening = null;
    }
  }

  _onTrackEnded() {
    const wasActive = this.active;
    this.close();
    if (wasActive) {
      this.mode = null;
      this._emitState();
      this.emit('error', new Error('The microphone was disconnected.'));
    }
  }

  /** @param {AudioContext} ctx @returns {Promise<AudioNode>} */
  async _captureNode(ctx) {
    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      const urls = [];
      try { urls.push(new URL(WORKLET_URL, document.baseURI).href); } catch { /* ignore */ }
      urls.push('blob');
      for (const u of urls) {
        let blobUrl = '';
        try {
          if (u === 'blob') {
            blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
            await ctx.audioWorklet.addModule(blobUrl);
          } else {
            await ctx.audioWorklet.addModule(u);
          }
          const node = new AudioWorkletNode(ctx, 'lawnmower-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
          node.port.onmessage = (e) => this._onBlock(e.data);
          return node;
        } catch (err) {
          console.warn(`[mic] AudioWorklet (${u === 'blob' ? 'blob' : 'module'}) unavailable: ${err?.message || err}`);
        } finally {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
        }
      }
    }
    // Deprecated but universally available fallback.
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => this._onBlock(new Float32Array(e.inputBuffer.getChannelData(0)));
    const mute = ctx.createGain();
    mute.gain.value = 0;
    sp.connect(mute);
    mute.connect(ctx.destination);
    this._nodes.push(mute);
    return sp;
  }

  /** @param {Float32Array} block samples at the context rate */
  _onBlock(block) {
    if (!this.mode || !this._resampler) return;
    if (this.paused) return;
    const x = this._resampler.process(block);
    this._consume(x);
  }

  /** @param {Float32Array} x 16 kHz samples */
  _consume(x) {
    if (!x.length) return;
    // smoothed meter level (fast attack, slower release)
    const lv = dbToUnit(toDb(rms(x)), -60, -15);
    this.level = lv > this.level ? lv : this.level * 0.8 + lv * 0.2;
    if (this.mode === 'ptt') {
      if (this._recLen < MAX_PTT_SEC * TARGET_RATE) {
        this._rec.push(x);
        this._recLen += x.length;
      }
      return;
    }
    for (const ev of this._vad.process(x)) {
      if (ev.type === 'speechstart') {
        this._heard = true;
        this.emit('speechstart');
      } else if (ev.type === 'speechend') {
        const utt = { wav: encodeWav(ev.samples, TARGET_RATE), durationMs: ev.durationMs, speechMs: ev.speechMs };
        if (this.mode === 'utterance') this._finishCapture();
        this.emit('utterance', utt);
        if (!this.mode) return;
      } else if (ev.type === 'discard') {
        this.emit('discard', { reason: ev.reason });
      }
    }
  }
}
