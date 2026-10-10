// The Home camera's security pipeline (contract §9.3 / §9.4), the brain of the security
// worker. security-worker.js wires it to the worker's messages; everything platform-specific is
// injected, so it is unit-tested in Node with fakes.
//
//   main (MessagePort) ── config/chunk ──► StreamDecoder (WebCodecs) ─┐
//                      ── bitmap (mock) ───────────────────────────────┤
//                                                                      ▼ newest frame (one kept)
//      LiveCanvas (page canvas, letterboxed) ◄── draw while the view is visible
//      every ~200 ms: 64×36 sample ── MotionDetector ──► det ──► main (while armed)
//      1 Hz armed / 4 Hz boost / 1 Hz overlay: person detector (MediaPipe or the stub)
//      shift-ref / shift-measure: 128×72 luma ── estimateShift ──► shift ──► main (calibration)
//      snap: JPEG of the newest frame ──► main or the page (clipboard)
//
// Messages to main: ready, det (≤ 5/s), snap-ok | snap-err, shift, stats (every 2 s), error.
// Messages to the page: video (size), det-view (person boxes to draw), stats.
//
// `det` carries `detected: true` when `persons` comes from a detector run since the previous
// det (otherwise `persons` is [] and says nothing about people): an additive field so main can
// count detector samples (contract §8.8 "≥ 2 of the last 3 detector samples").
//
// Clocks: `at`, `boost.untilMs` and `ptz.settleUntil` are wall-clock milliseconds (Date.now(),
// shared by main and the renderer); rates and timeouts use the monotonic `now`.

import { StreamDecoder } from './decoder.js';
import { LiveCanvas } from './draw.js';
import { MOTION_HEIGHT, MOTION_WIDTH, MotionDetector, changedFraction, lumaFromRgba } from './motion.js';
import { SHIFT_HEIGHT, SHIFT_WIDTH, estimateShift } from './shift.js';
import { encodeSnapshot } from './snapshot.js';
import { stubDetect } from './stub-detector.js';

export const RATES = Object.freeze({
  motionMs: 200, // ≈ 5 Hz
  armedHz: 1,
  boostHz: 4,
  overlayHz: 1,
});
export const STATS_MS = 2000;
/** The worker tells main which video chunk it has handled every ACK_EVERY chunks or ACK_EVERY_MS. */
export const ACK_EVERY = 4;
export const ACK_EVERY_MS = 250;
/** The longest PTZ move main watches (30 s) plus its settle time: see security-engine.js. */
export const PTZ_MAX_SUPPRESS_MS = 35_000;
/** The image counts as settled after this many consecutive frames with < 1 % change. */
export const SETTLE_FRAMES = 2;
export const SETTLE_FRACTION = 0.01;
export const MAX_SHIFT_TIMEOUT_MS = 15000;
/** Load the MediaPipe detector this long after `hello` (lets the window paint first). */
export const DETECTOR_LOAD_DELAY_MS = 1200;
/** Width of the picture the person detector gets (the model itself works on 320×320). */
export const DETECT_INPUT_WIDTH = 640;
/** A measurement waits for the picture to change (the camera starting to turn, after the
 * stream's delay) or for this long, before a still picture counts as settled. */
export const SHIFT_MIN_WAIT_MS = 1500;
/** The calibration's reference picture waits at most this long for a still picture. */
export const SHIFT_REF_MAX_WAIT_MS = 4000;
/** Changed fraction between frames that shows the camera is turning. */
export const SHIFT_MOVING_FRACTION = 0.03;

/** A decoded frame shared by several consumers: closed when the last one lets go. */
export class FrameRef {
  /** @param {any} image VideoFrame | ImageBitmap @param {number} width @param {number} height @param {number} ts ms */
  constructor(image, width, height, ts) {
    this.image = image;
    this.width = width;
    this.height = height;
    this.ts = ts;
    this.refs = 1;
  }

  retain() {
    this.refs++;
    return this;
  }

  release() {
    if (this.refs <= 0) return;
    this.refs--;
    if (this.refs === 0) {
      try {
        this.image?.close?.();
      } catch { /* already closed */ }
      this.image = null;
    }
  }
}

/**
 * @typedef {object} PipelineDeps
 * @property {(msg: any, transfer?: Transferable[]) => void} postPage
 * @property {(image: any, o?: any) => Promise<any>} createImageBitmap
 * @property {any} OffscreenCanvas
 * @property {any} [VideoDecoder]
 * @property {any} [EncodedVideoChunk]
 * @property {(o: { wasmBase: string, modelUrl: string }) => Promise<import('./detector.js').PersonDetector>} [loadDetector]
 * @property {() => number} [now]       monotonic ms
 * @property {() => number} [wallNow]   Date.now()
 * @property {(fn: () => void, ms: number) => any} [setTimeout]
 * @property {(id: any) => void} [clearTimeout]
 * @property {(fn: () => void, ms: number) => any} [setInterval]
 * @property {(id: any) => void} [clearInterval]
 * @property {number} [detectorDelayMs]
 */

export class SecurityPipeline {
  /** @param {PipelineDeps} d */
  constructor(d) {
    this.d = d;
    this.now = d.now || (() => performance.now());
    this.wallNow = d.wallNow || (() => Date.now());
    this._setTimeout = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = d.clearTimeout || ((id) => clearTimeout(id));
    /** @type {any} MessagePort to main */
    this.port = null;
    this.decoder = new StreamDecoder({
      VideoDecoder: d.VideoDecoder,
      EncodedVideoChunk: d.EncodedVideoChunk,
      onFrame: (f) => this._onVideoFrame(f),
      onError: (e) => this.postMain({ t: 'error', fatal: !!e.fatal, message: e.message }),
      now: this.now,
    });
    this.live = new LiveCanvas();
    this.motion = new MotionDetector();
    /** @type {FrameRef|null} */
    this.lastFrame = null;
    this.lastFrameAt = -Infinity;
    this.video = { width: 0, height: 0 };
    /** @type {{ detector: string, wasmBase: string, modelUrl: string }|null} */
    this.hello = null;
    /** @type {'off'|'loading'|'on'|'stub'|'failed'} */
    this.detectorState = 'off';
    /** @type {import('./detector.js').PersonDetector|null} */
    this.detector = null;
    this.detectorError = '';
    this._detectorKey = '';
    this._loadTimer = null;
    this.armed = { on: false, people: true, sensitivity: 'medium' };
    this._ackedSeq = 0;
    this._ackedAt = 0;
    this.ptz = { moving: false, settleUntil: 0, since: 0 };
    this.boostUntil = 0;
    this.overlay = false;
    this.pageVisible = true;
    this.mainVisible = true;
    this._needReseed = false;
    this.lastMotion = { active: false, score: 0, global: false };
    /** @type {Uint8ClampedArray|null} the newest 64×36 RGBA sample (the stub detector reads it) */
    this.motionRgba = null;
    this.motionRgbaAt = -Infinity;
    this._motionBusy = false;
    this._lastMotionAt = -Infinity;
    this._detBusy = false;
    this._lastDetAt = -Infinity;
    /** @type {Array<{ score: number, box: number[] }>|null} a detector result main has not had yet */
    this._pendingPersons = null;
    this.persons = /** @type {Array<{ score: number, box: number[] }>} */ ([]);
    this.lastDetMs = 0;
    /** @type {number[]} when detections finished (rate) */
    this._detTimes = [];
    /** @type {number[]} when frames arrived (fps) */
    this._frameTimes = [];
    this.shift = { wantRef: false, ref: /** @type {Uint8Array|null} */ (null), measure: /** @type {any} */ (null), busy: false, refReq: /** @type {any} */ (null) };
    this._canvases = /** @type {Record<string, any>} */ ({});
    const si = d.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._statsTimer = si(() => this.postStats(), STATS_MS);
  }

  // ------------------------------------------------------------------------------------------
  // wiring

  /** The page handed over a new port to main (a new one replaces the old). @param {any} port */
  attachPort(port) {
    if (this.port && this.port !== port) {
      try {
        this.port.close();
      } catch { /* gone */ }
    }
    this.port = port;
    this._ackedSeq = 0; // main numbers the chunks of each port from 1
    this._ackedAt = 0;
    this.decoder.reset(-1); // main sends hello + config on the new port
    port.onmessage = (/** @type {MessageEvent} */ e) => this.onMain(e.data);
    port.start?.();
  }

  /** @param {any} msg @param {Transferable[]} [transfer] */
  postMain(msg, transfer) {
    if (!this.port) return;
    try {
      this.port.postMessage(msg, transfer || []);
    } catch (err) {
      console.warn('[tapo-worker] post to main failed', err);
    }
  }

  /** @param {any} msg @param {Transferable[]} [transfer] */
  postPage(msg, transfer) {
    try {
      this.d.postPage(msg, transfer || []);
    } catch (err) {
      console.warn('[tapo-worker] post to page failed', err);
    }
  }

  /** Messages from main (over the port). @param {any} msg */
  onMain(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': return this._onHello(msg);
      case 'config':
        this.decoder.configure(msg).then((ok) => {
          if (!ok) this.postStats();
        }, (err) => this.postMain({ t: 'error', fatal: false, message: String(err?.message || err) }));
        return undefined;
      case 'chunk':
        this.decoder.chunk(msg);
        this._ack(msg.seq);
        return undefined;
      case 'reset':
        this.decoder.reset(Number(msg.gen));
        this._needReseed = true;
        // the newest frame is from before the reconnect: no snapshot of it (the canvas keeps
        // showing it until the first new frame arrives)
        this.lastFrame?.release();
        this.lastFrame = null;
        return undefined;
      case 'idle': return this._idle();
      case 'bitmap': return this._onImage(msg.image, msg.image?.width || 0, msg.image?.height || 0, Number(msg.ts) || this.now());
      case 'armed':
        this.armed = { on: !!msg.on, people: msg.people !== false, sensitivity: String(msg.sensitivity || 'medium') };
        this.motion.setSensitivity(this.armed.sensitivity);
        this._maybeLoadDetector();
        return undefined;
      case 'ptz':
        this.ptz = { moving: !!msg.moving, settleUntil: Number(msg.settleUntil) || 0, since: msg.moving ? (this.ptz.moving ? this.ptz.since : this.wallNow()) : 0 };
        if (this.ptz.moving) this._needReseed = true;
        return undefined;
      case 'boost':
        this.boostUntil = Number(msg.untilMs) || 0;
        return undefined;
      case 'snap': return this._snap(msg, 'main');
      case 'shift-ref': return this._shiftRef(msg);
      case 'shift-measure': return this._shiftMeasure(msg);
      case 'view': // main may say the window is hidden or minimized (the page cannot tell)
        this.mainVisible = msg.visible !== false;
        return undefined;
      default: return undefined; // unknown messages are ignored
    }
  }

  /** Messages from the page. @param {any} msg */
  onPage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'canvas':
        this.live.attach(msg.canvas);
        this._redraw();
        return;
      case 'resize':
        this.live.resize(Number(msg.width) || 0, Number(msg.height) || 0, Number(msg.dpr) || 1);
        this._redraw();
        return;
      case 'view':
        this.pageVisible = msg.visible !== false;
        this._redraw();
        return;
      case 'overlay':
        this.overlay = !!msg.show;
        this._maybeLoadDetector();
        if (!this.overlay && !this.armed.on) this.postPage({ t: 'det-view', persons: [] });
        return;
      case 'snap':
        this._snap(msg, 'page');
        return;
      default:
    }
  }

  get visible() {
    return this.pageVisible && this.mainVisible;
  }

  dispose() {
    (this.d.clearInterval || clearInterval)(this._statsTimer);
    this._clearTimeout(this._loadTimer);
    this._clearTimeout(this.shift.measure?.timer);
    this.decoder.idle();
    this.lastFrame?.release();
    this.lastFrame = null;
    this.detector?.close();
    this.detector = null;
  }

  // ------------------------------------------------------------------------------------------
  // detector

  /** @param {any} msg */
  _onHello(msg) {
    const mode = msg.detector === 'stub' ? 'stub' : 'mediapipe';
    this.hello = { detector: mode, wasmBase: String(msg.wasmBase || ''), modelUrl: String(msg.modelUrl || '') };
    const key = `${mode}|${this.hello.wasmBase}|${this.hello.modelUrl}`;
    if (key !== this._detectorKey) {
      this._detectorKey = key;
      this._clearTimeout(this._loadTimer);
      this._loadTimer = null;
      this.detector?.close();
      this.detector = null;
      this.detectorState = 'off';
      this.detectorError = '';
    }
    this._needReseed = true;
    if (mode === 'stub') {
      this.detectorState = 'stub';
      this.postMain({ t: 'ready', detector: 'stub' });
      return;
    }
    if (this.detectorState === 'on') this.postMain({ t: 'ready', detector: 'on' });
    else if (this.detectorState === 'failed') this.postMain({ t: 'ready', detector: 'failed', error: this.detectorError });
    else this._maybeLoadDetector(true);
  }

  /** Start loading MediaPipe (once): soon after hello, or right away when it is needed. @param {boolean} [soon] */
  _maybeLoadDetector(soon = false) {
    if (!this.hello || this.hello.detector !== 'mediapipe' || this.detectorState !== 'off') return;
    const needed = this.armed.on || this.overlay;
    if (!needed && !soon) return;
    if (this._loadTimer) {
      if (!needed) return;
      this._clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
    const run = () => {
      this._loadTimer = null;
      if (this.detectorState !== 'off' || !this.hello) return;
      if (typeof this.d.loadDetector !== 'function') {
        this._detectorFailed('No person detector is available in this window.');
        return;
      }
      const key = this._detectorKey;
      this.detectorState = 'loading';
      this.d.loadDetector({ wasmBase: this.hello.wasmBase, modelUrl: this.hello.modelUrl }).then((det) => {
        if (key !== this._detectorKey) {
          det.close();
          return;
        }
        this.detector = det;
        this.detectorState = 'on';
        this.postMain({ t: 'ready', detector: 'on' });
        this.postStats();
      }, (err) => {
        if (key === this._detectorKey) this._detectorFailed(String(err?.message || err));
      });
    };
    const delay = needed ? 0 : this.d.detectorDelayMs ?? DETECTOR_LOAD_DELAY_MS;
    this._loadTimer = this._setTimeout(run, delay);
  }

  /** @param {string} message */
  _detectorFailed(message) {
    this.detectorState = 'failed';
    this.detectorError = message;
    this.postMain({ t: 'ready', detector: 'failed', error: message });
    this.postStats();
  }

  /** Person detections per second wanted right now. */
  detectionRate() {
    if (this.detectorState !== 'on' && this.detectorState !== 'stub') return 0;
    if (this._suppressed()) return 0;
    if (this.wallNow() < this.boostUntil) return RATES.boostHz;
    if (this.armed.on && this.armed.people) return RATES.armedHz;
    if (this.overlay) return RATES.overlayHz;
    return 0;
  }

  /**
   * The camera is turning or has just stopped: no detection, no motion. A "moving" older than
   * PTZ_MAX_SUPPRESS_MS no longer counts (main's engine has the same backstop): a move that never
   * reported its end must not blind the detector for good.
   */
  _suppressed() {
    const now = this.wallNow();
    return (this.ptz.moving && now - this.ptz.since < PTZ_MAX_SUPPRESS_MS) || now < this.ptz.settleUntil;
  }

  // ------------------------------------------------------------------------------------------
  // frames

  /** @param {any} frame VideoFrame */
  _onVideoFrame(frame) {
    const ts = Number(frame.timestamp) / 1000; // µs → ms
    this._onImage(frame, frame.displayWidth || frame.codedWidth || 0, frame.displayHeight || frame.codedHeight || 0, Number.isFinite(ts) ? ts : this.now());
  }

  /** A new picture (decoded VideoFrame, or an ImageBitmap from the mock). @param {any} image @param {number} w @param {number} h @param {number} ts */
  _onImage(image, w, h, ts) {
    if (!image) return;
    if (!(w > 0) || !(h > 0)) {
      image.close?.();
      return;
    }
    const ref = new FrameRef(image, w, h, ts);
    const prev = this.lastFrame;
    this.lastFrame = ref;
    prev?.release();
    const now = this.now();
    this.lastFrameAt = now;
    this._frameTimes.push(now);
    if (this._frameTimes.length > 64) this._frameTimes.shift();
    if (w !== this.video.width || h !== this.video.height) {
      this.video = { width: w, height: h };
      this.postPage({ t: 'video', width: w, height: h });
    }
    if (this.visible) this.live.draw(ref);
    this._maybeMotion(ref, now);
    this._maybeDetect(ref, now);
    this._maybeShift(ref);
  }

  _redraw() {
    if (this.visible && this.lastFrame?.image) this.live.draw(this.lastFrame);
  }

  _idle() {
    this.decoder.idle();
    this.lastFrame?.release();
    this.lastFrame = null;
    this.live.clear();
    this._needReseed = true;
    this.persons = [];
    this.postPage({ t: 'det-view', persons: [] });
    this.postStats();
  }

  /**
   * A small RGBA copy of a frame (createImageBitmap does the scaling).
   * @param {FrameRef} ref @param {number} w @param {number} h @param {string} key
   * @returns {Promise<Uint8ClampedArray>}
   */
  async _sample(ref, w, h, key) {
    const bmp = await this.d.createImageBitmap(ref.image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
    try {
      let c = this._canvases[key];
      if (!c) {
        c = new this.d.OffscreenCanvas(w, h);
        this._canvases[key] = c;
      }
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    } finally {
      bmp.close?.();
    }
  }

  /** @param {FrameRef} ref @param {number} now */
  _maybeMotion(ref, now) {
    if (this._motionBusy || now - this._lastMotionAt < RATES.motionMs - 10) return;
    this._lastMotionAt = now;
    this._motionBusy = true;
    ref.retain();
    this._sample(ref, MOTION_WIDTH, MOTION_HEIGHT, 'motion')
      .then((rgba) => this._onMotionSample(rgba, ref.ts))
      .catch((err) => console.warn('[tapo-worker] motion sample failed', err?.message || err))
      .finally(() => {
        ref.release();
        this._motionBusy = false;
      });
  }

  /** @param {Uint8ClampedArray} rgba @param {number} frameTs */
  _onMotionSample(rgba, frameTs) {
    this.motionRgba = rgba;
    this.motionRgbaAt = this.now();
    const luma = lumaFromRgba(rgba, MOTION_WIDTH * MOTION_HEIGHT);
    if (this._suppressed()) {
      this._needReseed = true;
      this.lastMotion = { active: false, score: 0, global: false };
      return;
    }
    if (this._needReseed) {
      this.motion.reseed();
      this._needReseed = false;
    }
    this.lastMotion = this.motion.update(luma);
    if (!this.armed.on) {
      this._pendingPersons = null;
      return;
    }
    const persons = this._pendingPersons;
    this._pendingPersons = null;
    this.postMain({
      t: 'det',
      at: this.wallNow(),
      frameTs,
      motion: { active: this.lastMotion.active, score: round3(this.lastMotion.score), global: this.lastMotion.global },
      persons: persons || [],
      detected: !!persons,
    });
  }

  /** @param {FrameRef} ref @param {number} now */
  _maybeDetect(ref, now) {
    const rate = this.detectionRate();
    if (rate <= 0 || this._detBusy || now - this._lastDetAt < 1000 / rate - 15) return;
    if (this.detectorState === 'stub') {
      // the stub reads the motion sample (at most ~200 ms old)
      if (!this.motionRgba || now - this.motionRgbaAt > 600) return;
      this._lastDetAt = now;
      const t0 = this.now();
      this._onPersons(stubDetect(this.motionRgba, MOTION_WIDTH, MOTION_HEIGHT), this.now() - t0);
      return;
    }
    const det = this.detector;
    if (!det) return;
    this._lastDetAt = now;
    this._detBusy = true;
    ref.retain();
    const w = DETECT_INPUT_WIDTH;
    const h = Math.max(1, Math.round((DETECT_INPUT_WIDTH * ref.height) / ref.width));
    this.d.createImageBitmap(ref.image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
      .then((bmp) => {
        try {
          const t0 = this.now();
          const persons = det.detect(bmp, w, h, ref.ts);
          this._onPersons(persons, this.now() - t0);
        } finally {
          bmp.close?.();
        }
      })
      .catch((err) => this.postMain({ t: 'error', fatal: false, message: `person detection failed: ${err?.message || err}` }))
      .finally(() => {
        ref.release();
        this._detBusy = false;
      });
  }

  /** @param {Array<{ score: number, box: number[] }>} persons @param {number} ms */
  _onPersons(persons, ms) {
    const list = (Array.isArray(persons) ? persons : []).slice(0, 10);
    this.persons = list;
    this._pendingPersons = list;
    this.lastDetMs = Math.round(ms * 10) / 10;
    const now = this.now();
    this._detTimes.push(now);
    while (this._detTimes.length && now - this._detTimes[0] > 4000) this._detTimes.shift();
    if (this.overlay || this.armed.on) this.postPage({ t: 'det-view', persons: list });
  }

  // ------------------------------------------------------------------------------------------
  // snapshots and calibration

  /** @param {{ id?: any, maxSide?: number, quality?: number }} msg @param {'main'|'page'} to */
  _snap(msg, to) {
    const post = (/** @type {any} */ m, /** @type {any[]} */ tr) => (to === 'main' ? this.postMain(m) : this.postPage(m, tr));
    const ref = this.lastFrame?.image ? this.lastFrame.retain() : null;
    if (!ref) {
      post({ t: 'snap-err', id: msg.id, message: 'There is no picture yet.' }, []);
      return;
    }
    encodeSnapshot(ref, { maxSide: msg.maxSide, quality: msg.quality, OffscreenCanvas: this.d.OffscreenCanvas })
      .then((r) => post({ t: 'snap-ok', id: msg.id, jpeg: r.jpeg, width: r.width, height: r.height, frameTs: ref.ts }, [r.jpeg]))
      .catch((err) => post({ t: 'snap-err', id: msg.id, message: String(err?.message || err) }, []))
      .finally(() => ref.release());
  }

  /**
   * Take the calibration's reference picture: with an id, the next still one (≤
   * SHIFT_REF_MAX_WAIT_MS), and main is told when it is taken ({ t: 'shift-ref-ok' }) and moves
   * the camera only then: on a lagging video the reference would otherwise show the camera still
   * settling, or already moving. @param {{ id?: unknown }} msg
   */
  _shiftRef(msg) {
    const s = this.shift;
    this._clearTimeout(s.refReq?.timer);
    s.wantRef = true;
    s.ref = null;
    s.refReq = null;
    // (without an id — an older main — the next frame is the reference, as before)
    if (typeof msg.id !== 'string') return;
    const rr = { id: msg.id, startedAt: this.now(), prev: /** @type {Uint8Array|null} */ (null), stable: 0, timer: /** @type {any} */ (null) };
    // no frames at all: answer anyway (the measurement then says "not measurable")
    rr.timer = this._setTimeout(() => {
      if (s.refReq !== rr) return;
      s.refReq = null;
      if (rr.prev) {
        s.ref = rr.prev;
        s.wantRef = false;
      }
      this.postMain({ t: 'shift-ref-ok', id: rr.id });
    }, SHIFT_REF_MAX_WAIT_MS + 1000);
    s.refReq = rr;
  }

  /** @param {Uint8Array} luma */
  _refTaken(luma) {
    const s = this.shift;
    const rr = s.refReq;
    s.wantRef = false;
    s.ref = luma;
    s.refReq = null;
    if (rr) {
      this._clearTimeout(rr.timer);
      this.postMain({ t: 'shift-ref-ok', id: rr.id });
    }
  }

  /**
   * Tell main which chunk was handled (flow control: main stops sending when this falls behind),
   * every ACK_EVERY chunks or ACK_EVERY_MS. @param {unknown} seq
   */
  _ack(seq) {
    if (!Number.isSafeInteger(seq)) return;
    const n = /** @type {number} */ (seq);
    const now = this.now();
    if (n < this._ackedSeq) this._ackedSeq = 0; // a new port counts from 1 again
    if (n - this._ackedSeq >= ACK_EVERY || now - this._ackedAt >= ACK_EVERY_MS) {
      this._ackedSeq = n;
      this._ackedAt = now;
      this.postMain({ t: 'ack', seq: n });
    }
  }

  /**
   * expectMove: the camera reported that it moved, so wait for the picture to move (the video lags
   * the motor, by more than SHIFT_MIN_WAIT_MS on a real camera over Wi-Fi), up to the timeout.
   * @param {{ id: any, timeoutMs?: number, expectMove?: boolean }} msg
   */
  _shiftMeasure(msg) {
    this._clearTimeout(this.shift.measure?.timer);
    const timeout = Math.min(MAX_SHIFT_TIMEOUT_MS, Math.max(200, Number(msg.timeoutMs) || 6000));
    const m = { id: msg.id, startedAt: this.now(), prev: /** @type {Uint8Array|null} */ (null), latest: /** @type {Uint8Array|null} */ (null), stable: 0, moved: false, expectMove: msg.expectMove === true, timer: null };
    m.timer = this._setTimeout(() => {
      if (this.shift.measure === m) this._finishShift(m, m.latest);
    }, timeout);
    this.shift.measure = m;
  }

  /** @param {FrameRef} ref */
  _maybeShift(ref) {
    const s = this.shift;
    if ((!s.wantRef && !s.measure) || s.busy) return;
    s.busy = true;
    ref.retain();
    this._sample(ref, SHIFT_WIDTH, SHIFT_HEIGHT, 'shift')
      .then((rgba) => {
        const luma = lumaFromRgba(rgba, SHIFT_WIDTH * SHIFT_HEIGHT);
        if (s.wantRef) {
          const rr = s.refReq;
          if (rr) {
            // the reference is a still picture (the last move may still be reaching the video)
            rr.stable = rr.prev && changedFraction(rr.prev, luma) < SETTLE_FRACTION ? rr.stable + 1 : 0;
            rr.prev = luma;
            if (rr.stable < SETTLE_FRAMES && this.now() - rr.startedAt < SHIFT_REF_MAX_WAIT_MS) return;
          }
          this._refTaken(luma);
          return;
        }
        const m = s.measure;
        if (!m) return;
        const change = m.prev ? changedFraction(m.prev, luma) : 1;
        // the camera turned: the picture changed between frames, or differs from the reference
        if ((m.prev && change >= SHIFT_MOVING_FRACTION) || (s.ref && changedFraction(s.ref, luma) >= SHIFT_MOVING_FRACTION)) m.moved = true;
        if (m.prev && change < SETTLE_FRACTION) m.stable++;
        else m.stable = 0;
        m.prev = luma;
        m.latest = luma;
        // settled: still for SETTLE_FRAMES comparisons, after the picture moved (or long enough
        // that a camera which did not move at all is not waited for until the timeout)
        if (m.stable >= SETTLE_FRAMES && (m.moved || (!m.expectMove && this.now() - m.startedAt >= SHIFT_MIN_WAIT_MS))) this._finishShift(m, luma);
      })
      .catch((err) => console.warn('[tapo-worker] shift sample failed', err?.message || err))
      .finally(() => {
        ref.release();
        s.busy = false;
      });
  }

  /** @param {any} m @param {Uint8Array|null} luma */
  _finishShift(m, luma) {
    this._clearTimeout(m.timer);
    if (this.shift.measure === m) this.shift.measure = null;
    const settledMs = Math.round(this.now() - m.startedAt);
    if (!this.shift.ref || !luma) {
      this.postMain({ t: 'shift', id: m.id, dx: 0, dy: 0, score: 0, settledMs });
      return;
    }
    const r = estimateShift(this.shift.ref, luma);
    this.postMain({ t: 'shift', id: m.id, dx: round4(r.dx), dy: round4(r.dy), score: round3(r.score), settledMs });
  }

  // ------------------------------------------------------------------------------------------
  // stats

  fps() {
    const now = this.now();
    const t = this._frameTimes.filter((x) => now - x <= STATS_MS);
    if (t.length < 2) return 0;
    return Math.round(((t.length - 1) / Math.max(1, now - t[0])) * 10000) / 10;
  }

  postStats() {
    const s = this.decoder.stats();
    const fps = this.fps();
    const now = this.now();
    const recent = this._detTimes.filter((x) => now - x <= 4000);
    const detectorHz = Math.round((recent.length / 4) * 10) / 10;
    const main = { t: 'stats', fps, decodeQueue: s.decodeQueue, dropped: s.dropped, decoder: s.decoder, configSupported: s.configSupported };
    // the person detector's rate and last run time, for main's status (camera_status, the drawer)
    this.postMain({ ...main, detectorHz, ...(recent.length ? { detectorMs: this.lastDetMs } : {}) });
    this.postPage({
      ...main,
      // how the video is decoded: null when nothing went through the decoder (the mock's pictures)
      decoding: this.decoder.config ? (this.decoder.acceleration === 'prefer-hardware' ? 'hardware' : 'software') : null,
      codec: this.decoder.codec,
      hasFrame: !!this.lastFrame?.image,
      lastFrameAgoMs: Number.isFinite(this.lastFrameAt) ? Math.round(now - this.lastFrameAt) : null,
      video: { ...this.video },
      detector: { state: this.detectorState, rateHz: detectorHz, lastMs: this.lastDetMs, error: this.detectorError || undefined },
      motion: { ...this.lastMotion },
    });
  }
}

/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;
/** @param {number} v */
const round4 = (v) => Math.round(v * 10000) / 10000;
