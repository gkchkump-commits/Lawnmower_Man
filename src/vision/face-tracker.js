// FaceTracker: feeds camera frames to the Face Landmarker and reports one FaceObservation (or
// null) per processed frame.
//
//  * The landmarker runs in a module worker (face-worker.js). Each tick wraps the <video>'s
//    current frame in a VideoFrame (a reference, ~0.1 ms: no copy, no wait for the GPU process)
//    and transfers it; the worker uploads it and closes it. createImageBitmap is only the fallback
//    without WebCodecs: it waits for the GPU process, which can take 100+ ms while the hologram
//    renders. The next frame is only sent once the worker answered, so detection never queues up
//    behind a slow machine.
//  * If the worker cannot start (no module workers, no OffscreenCanvas WebGL, …) it falls back
//    to running the landmarker on the main thread, capped at a low rate.
//  * The rate is set by the caller (setRate): ~12/s while someone is there, a few per second to
//    notice someone arriving, 0 to pause.
//
// Events: 'ready' ({ mode: 'worker'|'main', delegate, ms }), 'observation' ({ obs, t, ms }),
//         'error' (Error; fatal ones also stop the tracker), 'mode' (the fallback kicked in).
/* global Worker, createImageBitmap, VideoFrame */

import { Emitter } from '../app/emitter.js';
import { visionAssetUrls } from './assets.js';
import { DETECT_WIDTH, detectSize } from './frame-size.js';

export { DETECT_WIDTH, detectSize, visionAssetUrls };

/** The main-thread fallback never runs faster than this (it shares the thread with rendering). */
export const MAIN_THREAD_MAX_HZ = 4;
/** This many failed detections in a row, or no answer for this long, stop the tracker. */
export const MAX_CONSECUTIVE_ERRORS = 5;
export const ANSWER_TIMEOUT_MS = 10_000;

/**
 * The <video>'s current frame as something to transfer to the worker: a VideoFrame (no copy) or,
 * without WebCodecs, a ~320 px ImageBitmap.
 * @param {HTMLVideoElement} v
 * @returns {Promise<{ image: VideoFrame|ImageBitmap, width: number, height: number }>}
 */
export async function grabFrame(v) {
  if (typeof VideoFrame === 'function') {
    const image = new VideoFrame(v, { timestamp: Math.round(performance.now() * 1000) });
    return { image, width: image.displayWidth || v.videoWidth, height: image.displayHeight || v.videoHeight };
  }
  const { width, height } = detectSize(v.videoWidth, v.videoHeight);
  const image = await createImageBitmap(v, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
  return { image, width, height };
}


export class FaceTracker extends Emitter {
  /**
   * @param {object} [o]
   * @param {() => Worker} [o.createWorker]   tests / custom builds
   * @param {() => Promise<{ createFaceEngine: Function }>} [o.loadEngine]  main-thread fallback
   * @param {{ wasmBase: string, modelUrl: string }} [o.urls]
   * @param {() => number} [o.now]
   */
  constructor(o = {}) {
    super();
    this._createWorker = o.createWorker || (() => new Worker(new URL('./face-worker.js', import.meta.url), { type: 'module', name: 'face-tracker' }));
    this._loadEngine = o.loadEngine || (() => import('./landmarker.js'));
    this._urls = o.urls || null;
    this._now = o.now || (() => performance.now());
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {'idle'|'starting'|'worker'|'main'|'failed'} */
    this.mode = 'idle';
    this.rate = 0;
    this.delegate = '';
    /** Last detection time in ms (worker or main thread), for the info panel. */
    this.lastMs = 0;
    this.frames = 0;
    /** @type {Worker|null} */
    this._worker = null;
    /** @type {any} */
    this._engine = null;
    this._timer = /** @type {any} */ (0);
    this._inFlight = false;
    this._seq = 0;
    this._lastSent = -Infinity;
    /** @type {Promise<void>|null} */
    this._starting = null;
    this._gen = 0;
    this._errors = 0;
    this._watchdog = /** @type {any} */ (0);
  }

  get running() {
    return this.mode === 'worker' || this.mode === 'main';
  }

  /**
   * Load the landmarker (worker first, then the main-thread fallback). Resolves when ready;
   * rejects (and emits 'error') when neither works.
   */
  start() {
    if (this._starting) return this._starting;
    const gen = ++this._gen;
    this.mode = 'starting';
    this._starting = this._startWorker(gen)
      .catch((err) => {
        if (gen !== this._gen) throw err;
        console.warn('[vision] face tracker worker unavailable, using the main thread:', err?.message || err);
        this.emit('mode', 'main');
        return this._startMain(gen);
      })
      .catch((err) => {
        if (gen === this._gen) {
          this.mode = 'failed';
          this._starting = null;
          this.emit('error', Object.assign(new Error(`Face tracking could not start: ${err?.message || err}`), { fatal: true }));
        }
        throw err;
      });
    return this._starting;
  }

  /** @param {HTMLVideoElement|null} video */
  setVideo(video) {
    this.video = video;
    this._schedule(0);
  }

  /** Detections per second (0 pauses). @param {number} hz */
  setRate(hz) {
    const r = Math.max(0, Number(hz) || 0);
    if (r === this.rate) return;
    this.rate = r;
    this._schedule(0);
  }

  /** Stop and release the worker / engine. */
  stop() {
    this._gen++;
    clearTimeout(this._timer);
    clearTimeout(this._watchdog);
    this._timer = 0;
    this._watchdog = 0;
    this._inFlight = false;
    this._errors = 0;
    this._starting = null;
    if (this._worker) {
      try { this._worker.postMessage({ type: 'close' }); } catch { /* gone */ }
      const w = this._worker;
      setTimeout(() => { try { w.terminate(); } catch { /* ignore */ } }, 500);
    }
    this._worker = null;
    this._engine?.close?.();
    this._engine = null;
    this.mode = 'idle';
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------

  /** @param {number} gen */
  _startWorker(gen) {
    return new Promise((resolve, reject) => {
      /** @type {Worker} */
      let w;
      try {
        w = this._createWorker();
      } catch (err) {
        reject(err);
        return;
      }
      const t0 = this._now();
      const timeout = setTimeout(() => fail(new Error('the face tracker worker did not start within 30 s')), 30_000);
      const fail = (/** @type {any} */ err) => {
        clearTimeout(timeout);
        try { w.terminate(); } catch { /* ignore */ }
        if (this._worker === w) this._worker = null;
        reject(err instanceof Error ? err : new Error(String(err?.message || err)));
      };
      w.addEventListener('error', (e) => {
        e.preventDefault?.();
        if (gen !== this._gen) return;
        // starting: the worker script did not load (→ main-thread fallback); later: it crashed
        if (this.mode === 'starting') fail(new Error(e.message || 'the worker script failed to load'));
        else this._fail(new Error(e.message || 'the face tracker worker crashed'));
      });
      w.addEventListener('message', (e) => {
        const m = /** @type {any} */ (e).data || {};
        if (gen !== this._gen) return;
        if (m.type === 'ready') {
          clearTimeout(timeout);
          this.mode = 'worker';
          this.delegate = m.delegate || '';
          this.emit('ready', { mode: 'worker', delegate: this.delegate, ms: Math.round(this._now() - t0) });
          resolve();
          this._schedule(0);
        } else if (m.type === 'result') {
          this._onResult(m.obs ?? null, m.ms || 0, !!m.skipped);
        } else if (m.type === 'error') {
          if (m.fatal && this.mode === 'starting') fail(new Error(m.message));
          else this._onDetectError(new Error(m.message));
        }
      });
      this._worker = w;
      w.postMessage({ type: 'init', ...(this._urls || visionAssetUrls()) });
    });
  }

  /** @param {number} gen */
  async _startMain(gen) {
    const t0 = this._now();
    const { createFaceEngine } = await this._loadEngine();
    const engine = await createFaceEngine(this._urls || visionAssetUrls());
    if (gen !== this._gen) {
      engine.close();
      return;
    }
    this._engine = engine;
    this.mode = 'main';
    this.delegate = engine.delegate || '';
    this.emit('ready', { mode: 'main', delegate: this.delegate, ms: Math.round(this._now() - t0) });
    this._schedule(0);
  }

  _interval() {
    const hz = this.mode === 'main' ? Math.min(this.rate, MAIN_THREAD_MAX_HZ) : this.rate;
    return hz > 0 ? 1000 / hz : Infinity;
  }

  /** Plan the next frame grab. @param {number} [delay] */
  _schedule(delay) {
    clearTimeout(this._timer);
    this._timer = 0;
    if (!this.running || this._inFlight || !this.video) return;
    const iv = this._interval();
    if (!Number.isFinite(iv)) return;
    const wait = delay !== undefined ? Math.max(0, this._lastSent + iv - this._now(), delay) : Math.max(0, this._lastSent + iv - this._now());
    this._timer = setTimeout(() => this._grab(), wait);
  }

  async _grab() {
    this._timer = 0;
    const v = this.video;
    if (!this.running || this._inFlight || !v) return;
    if (v.readyState < 2 || !v.videoWidth) {
      this._timer = setTimeout(() => this._grab(), 100);
      return;
    }
    const gen = this._gen;
    this._inFlight = true;
    this._lastSent = this._now();
    if (this.mode === 'main' && this._engine) {
      // same thread: MediaPipe reads the video element directly (capped at a low rate)
      const t = this._now();
      let obs = null;
      try {
        obs = this._engine.detect(v, v.videoWidth, v.videoHeight, t);
      } catch (err) {
        this._onDetectError(/** @type {Error} */ (err));
        return;
      }
      this._onResult(obs, Math.round((this._now() - t) * 10) / 10, false);
      return;
    }
    if (this.mode !== 'worker' || !this._worker) {
      this._inFlight = false;
      return;
    }
    let frame;
    try {
      frame = await grabFrame(v);
    } catch {
      // the video has no frame right now (device switching): try again on the next tick
      this._inFlight = false;
      if (gen === this._gen) this._schedule();
      return;
    }
    if (gen !== this._gen || !this._worker) {
      frame.image.close();
      return;
    }
    const t = this._now();
    const id = ++this._seq;
    this._worker.postMessage({ type: 'frame', id, image: frame.image, width: frame.width, height: frame.height, t }, [frame.image]);
    // a worker that hangs (or died without an error event) must not stall tracking silently
    this._watchdog = setTimeout(() => this._fail(new Error('the face tracker stopped answering')), ANSWER_TIMEOUT_MS);
  }

  /** One detection failed: tolerated now and then, not over and over. @param {Error} err */
  _onDetectError(err) {
    clearTimeout(this._watchdog);
    this._inFlight = false;
    if (++this._errors >= MAX_CONSECUTIVE_ERRORS) {
      this._fail(new Error(`face detection keeps failing: ${err.message}`));
      return;
    }
    this.emit('error', err);
    this._schedule();
  }

  /** Give up: release the worker / engine and report a fatal error. @param {Error} err */
  _fail(err) {
    if (this.mode === 'failed' || this.mode === 'idle') return;
    this.stop();
    this.mode = 'failed';
    this.emit('error', Object.assign(err, { fatal: true }));
  }

  /** @param {any} obs @param {number} ms @param {boolean} skipped */
  _onResult(obs, ms, skipped) {
    clearTimeout(this._watchdog);
    this._inFlight = false;
    if (!skipped) this._errors = 0;
    if (!skipped) {
      this.frames++;
      this.lastMs = ms;
      this.emit('observation', { obs, t: this._now(), ms });
    }
    this._schedule();
  }
}
