// Runs the acoustic analysis of voice clips (acoustics.js) in a worker (acoustics-worker.js), so a
// clip is analysed while the one before it plays and no frame of the app pays for it. Without
// Worker (Node: tests, tools) the analysis runs synchronously. A worker that cannot start or fails
// is given up: the lip-sync then plays the viseme timeline alone, as before the acoustics.
/* global Worker */
import { analyseAcoustics } from './acoustics.js';
import { base64ToBytes, decodeWav } from './wav.js';

/**
 * @typedef {import('./acoustics.js').AcousticTrack} AcousticTrack
 * @typedef {{ track: AcousticTrack|null, final: boolean, failed: boolean, promise: Promise<AcousticTrack|null> }} AcousticJob
 *   track: what has been analysed so far (track.done frames; the whole clip once final)
 */

export class AcousticsClient {
  /**
   * @param {{ createWorker?: (() => any)|null, sync?: boolean }} [o] createWorker: tests;
   *   sync: analyse on the calling thread (default: when there is no Worker)
   */
  constructor(o = {}) {
    this.sync = o.sync ?? typeof Worker === 'undefined';
    this._create = o.createWorker === undefined
      ? () => new Worker(new URL('./acoustics-worker.js', import.meta.url), { type: 'module', name: 'acoustics' })
      : o.createWorker;
    /** @type {any} */
    this._worker = null;
    this.failed = false;
    this._id = 0;
    /** @type {Map<number, { job: AcousticJob, resolve: (t: AcousticTrack|null) => void }>} */
    this._jobs = new Map();
  }

  /** Start the worker and compile the analysis (idle time at start-up). */
  warmUp() {
    const w = this._ensure();
    try { w?.postMessage({ type: 'warm' }); } catch { /* ignore */ }
  }

  /** @returns {any} */
  _ensure() {
    if (this.sync || this.failed) return null;
    if (this._worker) return this._worker;
    try {
      const w = this._create?.();
      if (!w) throw new Error('no worker');
      w.onmessage = (ev) => this._onMessage(ev.data);
      w.onerror = (ev) => this._fail(ev?.message || 'worker error');
      this._worker = w;
      return w;
    } catch (err) {
      this._fail(err?.message || err);
      return null;
    }
  }

  /** @param {any} why */
  _fail(why) {
    if (!this.failed) console.warn('[lipsync] acoustic analysis unavailable, the mouth follows the viseme timeline only:', why);
    this.failed = true;
    try { this._worker?.terminate?.(); } catch { /* ignore */ }
    this._worker = null;
    for (const { job, resolve } of this._jobs.values()) {
      job.failed = true;
      job.final = true;
      resolve(job.track);
    }
    this._jobs.clear();
  }

  /** @param {any} m */
  _onMessage(m) {
    const e = this._jobs.get(m?.id);
    if (!e) return;
    if (m.error) {
      e.job.failed = true;
      e.job.final = true;
      this._jobs.delete(m.id);
      e.resolve(e.job.track);
      return;
    }
    e.job.track = m.track;
    if (m.final) {
      e.job.final = true;
      this._jobs.delete(m.id);
      e.resolve(m.track);
    }
  }

  /**
   * Analyse a clip: its decoded samples, or its WAV as base64.
   * @param {{ samples?: Float32Array, sampleRate?: number, audioB64?: string, wav?: ArrayBuffer }} src
   * @returns {AcousticJob}
   */
  analyse(src) {
    /** @type {AcousticJob} */
    const job = { track: null, final: false, failed: false, promise: Promise.resolve(null) };
    const w = this._ensure();
    if (!w) {
      if (this.failed && !this.sync) {
        job.failed = true;
        job.final = true;
        return job;
      }
      try {
        let { samples, sampleRate } = src;
        if (!samples) {
          const d = decodeWav(src.wav ? new Uint8Array(src.wav) : base64ToBytes(String(src.audioB64 || '')));
          samples = d.samples;
          sampleRate = d.sampleRate;
        }
        job.track = analyseAcoustics(samples, /** @type {number} */ (sampleRate));
      } catch {
        job.failed = true;
      }
      job.final = true;
      job.promise = Promise.resolve(job.track);
      return job;
    }
    const id = ++this._id;
    job.promise = new Promise((resolve) => this._jobs.set(id, { job, resolve }));
    try {
      if (src.samples) {
        // (a copy: the caller's samples stay usable)
        w.postMessage({ type: 'analyse', id, samples: src.samples, sampleRate: src.sampleRate });
      } else if (src.wav) {
        const d = decodeWav(new Uint8Array(src.wav));
        w.postMessage({ type: 'analyse', id, samples: d.samples, sampleRate: d.sampleRate }, [d.samples.buffer]);
      } else {
        w.postMessage({ type: 'analyse', id, audioB64: String(src.audioB64 || '') });
      }
    } catch (err) {
      this._fail(err?.message || err);
    }
    return job;
  }

  dispose() {
    try { this._worker?.terminate?.(); } catch { /* ignore */ }
    this._worker = null;
    this._jobs.clear();
  }
}
