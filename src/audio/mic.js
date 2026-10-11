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
//         'error' (Error), 'state' ({ active, mode, paused }), 'mute' ({ muted }), 'lost' ({ reason })
// The device is released `idleCloseMs` after the last use so the OS microphone indicator does
// not stay on.
//
// "Hey Jade" (src/wake/, contract-wake §9.2): setTap(fn) hands every 16 kHz block to the wake
// word, whatever the mode and even while paused (the VAD stays half-duplex), and keeps the device
// open; the last 3 s are kept in a ring, so a capture can start where the keyword ended
// (start('utterance', { fromSample })). Sample indices count from the Mic's creation and keep
// counting across reopenings (samplesSeen).
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
// ---- "Hey Jade" (wake word; src/wake/, contract-wake §9.2) ----
/** the rolling memory of the last 3 s of 16 kHz audio (only while a tap is set) */
export const RING_SEC = 3;
/** a reopened device starts this many samples later, so the wake word sees a gap */
const REOPEN_GAP = TARGET_RATE;
// ---- end "Hey Jade" ----

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
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be started (it may be in use, or Windows may be blocking it).'; // wake: a privacy block looks the same
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
   * @param {() => number} [deps.now]     performance.now() clock (ms)
   */
  constructor(deps = {}) {
    super();
    this._gum = deps.getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this._createContext = deps.createContext || (() => new AudioContext({ latencyHint: 'interactive' }));
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now())); // wake: arrival times
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
    // ---- "Hey Jade" (wake word; contract-wake §9.2) ----
    /** @type {null | ((x: Float32Array, info: { at: number, arrivalPerf: number }) => void)} */
    this._tap = null;
    /** 16 kHz samples seen since the Mic was created (monotonic; a reopen adds a gap) */
    this.samplesSeen = 0;
    this._ring = new Float32Array(RING_SEC * TARGET_RATE);
    /** index of the oldest sample the ring holds */
    this._ringStart = 0;
    /** a capture ignores the samples before this index (start({ fromSample }) in the future) */
    this._from = 0;
    this._noSpeechMs = this.noSpeechMs;
    this._noSpeechDeadline = Infinity;
    this._ignoreStartUntil = -Infinity;
    /** @type {'all'|'app'} the echo canceller asked for */
    this._echoMode = 'app';
    this._reopenWhenIdle = false;
    this._opened = 0;
    /** noise floor of the tapped audio, for a capture that starts in the middle of speech */
    this._floor = { db: -60, frames: 0, part: new Float32Array(320), n: 0 };
    // ---- end "Hey Jade" ----
  }

  get supported() {
    return !!globalThis.navigator?.mediaDevices?.getUserMedia;
  }

  get active() {
    return this.mode !== null;
  }

  /**
   * Start capturing in `mode`. Throws (with a friendly message) if the mic can't be opened.
   * fromSample ('utterance', with a tap): start at that sample index, replaying what the ring
   * already holds from there (the command right after "Hey Jade"); noSpeechMs: this start's
   * no-speech timeout (Infinity = none; default the instance's).
   * @param {'ptt'|'utterance'|'handsfree'} mode
   * @param {{ fromSample?: number, noSpeechMs?: number }} [o]
   */
  async start(mode, o = {}) {
    clearTimeout(this._idleTimer);
    await this.open();
    this.mode = mode;
    this.paused = false;
    this._rec = [];
    this._recLen = 0;
    this._heard = false;
    this._resetVad();
    clearTimeout(this._noSpeechTimer);
    // ---- "Hey Jade": a per-start timeout, and a start in the past (the ring) or the future ----
    this._noSpeechDeadline = Infinity;
    const from = Number(o.fromSample);
    this._from = Number.isFinite(from) && this._tap ? from : 0;
    if (mode === 'utterance') {
      const ms = o.noSpeechMs ?? this.noSpeechMs;
      this._noSpeechMs = ms;
      if (Number.isFinite(ms)) {
        this._noSpeechDeadline = this._now() + ms;
        this._noSpeechTimer = /** @type {any} */ (setTimeout(() => this._checkNoSpeech(), ms));
      }
    }
    this._emitState();
    if (this._from && this._from < this.samplesSeen) {
      const past = this.ring(Math.max(this._from, this._ringStart), this.samplesSeen);
      this._from = this.samplesSeen;
      if (past && past.length) this._consume(past);
    }
    // ---- end "Hey Jade" ----
  }

  // ---- "Hey Jade" (wake word; contract-wake §9.2) ----

  /** Open the device without a capture (the wake word's tap needs it). Throws a friendly error. */
  async open() {
    clearTimeout(this._idleTimer);
    try {
      await this._open();
    } catch (err) {
      const e = new Error(describeMicError(err));
      e.name = /** @type {any} */ (err)?.name || 'MicError';
      throw e;
    }
    if (this._ctx && this._ctx.state === 'suspended') await this._ctx.resume().catch(() => {});
  }

  /** The device is open (a live track). */
  get isOpen() {
    return !!this._stream && this._stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /**
   * Every 16 kHz block goes to `fn` (whatever the mode, also while paused) and into the 3 s
   * ring; the device stays open while a tap is set. null removes it (close() releases the device).
   * @param {null | ((x: Float32Array, info: { at: number, arrivalPerf: number }) => void)} fn
   */
  setTap(fn) {
    this._tap = typeof fn === 'function' ? fn : null;
    if (!this._tap) this._ringStart = this.samplesSeen; // the memory goes with the tap
  }

  get tapped() {
    return !!this._tap;
  }

  /** The oldest sample index the ring still holds (ring() refuses anything before it). */
  get ringStart() {
    return this._ringStart;
  }

  /**
   * The 16 kHz samples [fromIdx, toIdx) from the ring; null when part of the range is no
   * longer (or not yet) there.
   * @param {number} fromIdx @param {number} toIdx @returns {Float32Array|null}
   */
  ring(fromIdx, toIdx) {
    const a = Math.round(fromIdx);
    const b = Math.round(toIdx);
    if (!(b >= a) || a < this._ringStart || b > this.samplesSeen) return null;
    const out = new Float32Array(b - a);
    const L = this._ring.length;
    for (let i = a, j = 0; i < b; i++, j++) out[j] = this._ring[i % L];
    return out;
  }

  /** A VAD start before `perfMs` does not count as the user speaking (the earcon, ACK-7). @param {number} perfMs */
  ignoreSpeechStartUntil(perfMs) {
    this._ignoreStartUntil = Number(perfMs) || -Infinity;
  }

  /**
   * The echo canceller to ask for: 'all' = every app's playback (Windows 11; Chromium falls back
   * to the app's own output elsewhere), 'app' = this app's output (the default). A change while
   * the device is open reopens it at the next idle moment.
   * @param {'all'|'app'} mode
   */
  setEchoMode(mode) {
    const m = mode === 'all' ? 'all' : 'app';
    if (m === this._echoMode) return;
    this._echoMode = m;
    if (!this._stream) return;
    if (this.mode) this._reopenWhenIdle = true;
    else this.reopen().catch(() => {});
  }

  get echoMode() {
    return this._echoMode;
  }

  /** What the track really does: 'all' | true | false (undefined without a device). */
  get echoCancellation() {
    const t = this._track();
    try {
      return /** @type {any} */ (t?.getSettings?.() || {}).echoCancellation;
    } catch {
      return undefined;
    }
  }

  get trackLabel() {
    return String(this._track()?.label || '');
  }

  get muted() {
    return !!this._track()?.muted;
  }

  /** Release and open the device again (a changed default device, a new echo mode). */
  async reopen() {
    this._reopenWhenIdle = false;
    const keepTap = this._tap;
    this.close();
    this._tap = keepTap;
    if (keepTap) await this.open();
  }

  _track() {
    return this._stream?.getAudioTracks?.()[0] || null;
  }

  _checkNoSpeech() {
    if (this.mode === 'utterance' && !this._heard && !this._vad.speaking) {
      this._finishCapture();
      this.emit('discard', { reason: 'no-speech' });
    }
  }

  /** The tapped audio's noise floor (20 ms frames, the VAD's rule). @param {Float32Array} x */
  _trackFloor(x) {
    const f = this._floor;
    for (let i = 0; i < x.length; i++) {
      f.part[f.n++] = x[i];
      if (f.n < f.part.length) continue;
      f.n = 0;
      const db = toDb(rms(f.part));
      if (f.frames === 0) f.db = db;
      else if (db < f.db) f.db += (db - f.db) * 0.25;
      else f.db += (db - f.db) * (db > f.db + 10 ? 0.0015 : 0.02);
      f.db = Math.max(-95, f.db);
      f.frames++;
    }
  }
  // ---- end "Hey Jade" ----

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
    this._tap = null; // wake:
    this.close();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------

  _finishCapture() {
    clearTimeout(this._noSpeechTimer);
    this._noSpeechDeadline = Infinity; // wake:
    this._from = 0; // wake:
    this.mode = null;
    this.paused = false;
    this.level = 0;
    this._rec = [];
    this._recLen = 0;
    this._emitState();
    clearTimeout(this._idleTimer);
    if (this._reopenWhenIdle) queueMicrotask(() => { if (!this.mode && this._reopenWhenIdle) this.reopen().catch(() => {}); }); // wake: a new echo mode
    if (this._tap) return; // wake: the wake word keeps the device open
    this._idleTimer = /** @type {any} */ (setTimeout(() => { if (!this.mode && !this._tap) this.close(); }, this.idleCloseMs)); // wake: (tapped)
  }

  _emitState() {
    this.emit('state', { active: this.active, mode: this.mode, paused: this.paused });
  }

  _resetVad() {
    // keep the learned noise floor across utterances
    let floor = this._vad.floorDb; // wake: let
    let calibrated = this._vad._frames > 0; // wake: let
    // wake: with a tap, the floor of the audio heard so far (a capture may start mid-speech)
    if (this._tap && this._floor.frames >= 10) {
      floor = this._floor.db;
      calibrated = true;
    }
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
      const keepTap = this._tap; // wake:
      this.close();
      this._tap = keepTap; // wake:
      const stream = await this._gum({
        audio: {
          // wake: 'all' = every app's playback is the echo reference (Windows 11), else this app's
          echoCancellation: this._echoMode === 'all' ? /** @type {any} */ ({ ideal: 'all' }) : true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
        },
        video: false,
      });
      const ctx = this._createContext();
      this._stream = stream;
      this._ctx = ctx;
      // wake: a reopened device's samples start after a gap (the wake word resets its streams)
      if (this._opened++ > 0) this.samplesSeen += REOPEN_GAP;
      this._ringStart = this.samplesSeen;
      for (const t of stream.getAudioTracks()) {
        t.addEventListener?.('ended', () => this._onTrackEnded());
        t.addEventListener?.('mute', () => this.emit('mute', { muted: true })); // wake: Windows' mute (WIN-3)
        t.addEventListener?.('unmute', () => this.emit('mute', { muted: false })); // wake:
      }
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
    const tap = this._tap; // wake:
    this.close();
    this._tap = tap; // wake: the wake word opens the default device again (WIN-5)
    if (wasActive) {
      this.mode = null;
      this._emitState();
      this.emit('error', new Error('The microphone was disconnected.'));
    }
    if (tap) this.emit('lost', { reason: 'ended' }); // wake:
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
    if (!this._resampler) return;
    if (!this.mode && !this._tap) return; // wake: the tap needs every block
    const x = this._resampler.process(block);
    // ---- "Hey Jade": the tap and the ring see every block, also while paused (BRG-7) ----
    const at = this.samplesSeen;
    this.samplesSeen += x.length;
    if (this._tap && x.length) {
      const L = this._ring.length;
      for (let i = 0; i < x.length; i++) this._ring[(at + i) % L] = x[i];
      this._ringStart = Math.max(this._ringStart, this.samplesSeen - L);
      this._trackFloor(x);
      try {
        this._tap(x, { at, arrivalPerf: this._now() });
      } catch (err) {
        console.warn('[mic] the wake word tap failed', err);
      }
    }
    if (!this.mode || this.paused) return;
    let y = x;
    if (this._from > at) {
      // a capture that starts where a keyword will end
      if (this._from >= at + x.length) return;
      y = x.subarray(this._from - at);
    }
    // ---- end "Hey Jade" ----
    this._consume(y);
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
        // wake: the earcon (or its echo) starting the VAD is not the user speaking (ACK-7)
        if (this._now() < this._ignoreStartUntil) continue;
        this._heard = true;
        this.emit('speechstart');
      } else if (ev.type === 'speechend') {
        const utt = { wav: encodeWav(ev.samples, TARGET_RATE), durationMs: ev.durationMs, speechMs: ev.speechMs };
        if (this.mode === 'utterance') this._finishCapture();
        this.emit('utterance', utt);
        if (!this.mode) return;
      } else if (ev.type === 'discard') {
        this.emit('discard', { reason: ev.reason });
        // wake: a cough or a steady noise does not keep a window open; past the deadline it ends (END-5)
        if (this.mode === 'utterance') {
          this._heard = false;
          if (this._now() >= this._noSpeechDeadline) this._checkNoSpeech();
          if (!this.mode) return;
        }
      }
    }
  }
}
