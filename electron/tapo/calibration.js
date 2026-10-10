// Calibration wizard (contract §8.4): finds the camera's axis signs, how many ONVIF units turn
// the view by one width/height, the smallest step the firmware acts on and its travel speed, by
// moving a little and measuring how far the picture shifted (the worker's shift estimator,
// §9.3). Pure Node; the PTZ controller, the shift measurement and saving are injected.
//
// Moves are raw ONVIF intent (+x = right, +y = up; no inversion, no minStep) and each one is
// undone, so the camera ends where it started — also on cancel or failure.

import { EventEmitter } from 'node:events';

/**
 * @typedef {{ invertPan: boolean, invertTilt: boolean, viewUnitsX: number, viewUnitsY: number, minStep: number, msPerUnit: number }} CalibrationResult
 * @typedef {{ step: 'idle'|'pan'|'tilt'|'min-step'|'ask'|'done'|'failed', question?: string, answers?: string[],
 *   progress: number, result?: CalibrationResult, error?: string }} CalibrationState
 * @typedef {{ dx: number, dy: number, score: number, settledMs?: number }} Shift
 */

export const MIN_SHIFT = 0.02;
export const MIN_SCORE = 0.15;
export const ANSWER_TIMEOUT_MS = 120_000;
const QUESTIONS = {
  x: { question: 'Which way did the camera turn? (The picture moves the other way.)', answers: ['left', 'right', 'none'] },
  y: { question: 'Which way did the camera tilt? (The picture moves the other way.)', answers: ['up', 'down', 'none'] },
};

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));

class Cancelled extends Error {}

/**
 * @typedef {object} CalibrationOptions
 * @property {{ rawMove: (x: number, y: number) => Promise<{ settledMs: number, measured?: boolean, moved?: boolean }>, stopAll: (reason: string) => Promise<void> }} ptz
 *   `measured: false`: the move ended with the app's timed Stop (no GetStatus), so `settledMs` is
 *   the app's own estimate, not the camera's travel time
 * @property {{ ref: () => Promise<void>, measure: (o: { timeoutMs: number, expectMove?: boolean }) => Promise<Shift> }} vision
 *   `expectMove`: the camera reported that it moved, so the picture must move too: wait for it
 *   (up to timeoutMs) however late the video is, instead of giving up after a short wait
 * @property {() => string|null} canStart     null, or why it cannot start now
 * @property {() => CalibrationResult} current the settings in force (kept for what cannot be measured)
 * @property {(r: CalibrationResult & { calibratedAt: string }) => void} save
 * @property {(level: string, msg: string) => void} [log]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [delay]
 */

export class CalibrationWizard extends EventEmitter {
  /** @param {CalibrationOptions} o */
  constructor(o) {
    super();
    this._o = o;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._delay = o.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {CalibrationState} */
    this._state = { step: 'idle', progress: 0 };
    /** @type {{ cancelled: boolean }|null} */
    this._run = null;
    /** @type {((a: string) => void)|null} */
    this._answer = null;
    /** raw displacement not undone yet */
    this._net = { x: 0, y: 0 };
  }

  /** @returns {CalibrationState} */
  get state() {
    return JSON.parse(JSON.stringify(this._state));
  }

  get running() {
    return !!this._run;
  }

  /** @param {CalibrationState} s */
  _set(s) {
    this._state = s;
    this.emit('state', this.state);
  }

  /**
   * The lm:tapo:calibrate request.
   * @param {{ action: 'start'|'answer'|'cancel', answer?: string }} req
   * @returns {CalibrationState}
   */
  request(req) {
    if (req.action === 'start') return this.start();
    if (req.action === 'answer') return this.answer(String(req.answer || ''));
    return this.cancel();
  }

  start() {
    if (this._run) return this.state;
    const why = this._o.canStart();
    if (why) {
      this._set({ step: 'failed', progress: 0, error: why });
      return this.state;
    }
    const run = { cancelled: false };
    this._run = run;
    this._net = { x: 0, y: 0 };
    this._set({ step: 'pan', progress: 0.05 });
    this._sequence(run).catch(() => {});
    return this.state;
  }

  /** @param {string} a */
  answer(a) {
    if (this._answer && this._state.step === 'ask' && (this._state.answers || []).includes(a)) {
      const f = this._answer;
      this._answer = null;
      f(a);
    }
    return this.state;
  }

  cancel() {
    const run = this._run;
    if (!run) {
      if (this._state.step !== 'idle') this._set({ step: 'idle', progress: 0 });
      return this.state;
    }
    run.cancelled = true;
    if (this._answer) {
      const f = this._answer;
      this._answer = null;
      f('cancel');
    }
    this._set({ step: 'idle', progress: 0 });
    return this.state;
  }

  /** @param {{ cancelled: boolean }} run */
  _check(run) {
    if (run.cancelled) throw new Cancelled('cancelled');
  }

  /** @param {{ cancelled: boolean }} run @param {number} x @param {number} y */
  async _move(run, x, y) {
    this._check(run);
    const r = await this._o.ptz.rawMove(x, y);
    this._net.x += x;
    this._net.y += y;
    return r;
  }

  /** @param {{ cancelled: boolean }} run @param {boolean} first */
  async _ref(run, first) {
    // the video lags the motor: let the last move reach the picture before the reference frame
    if (!first) await this._delay(1000);
    this._check(run);
    await this._o.vision.ref();
  }

  /** @param {{ cancelled: boolean }} run @param {'x'|'y'} axis @param {number} progress */
  async _ask(run, axis, progress) {
    const q = QUESTIONS[axis];
    this._set({ step: 'ask', progress, question: q.question, answers: [...q.answers] });
    const answer = await new Promise((resolve) => {
      this._answer = resolve;
      setTimeout(() => {
        if (this._answer === resolve) {
          this._answer = null;
          resolve('timeout');
        }
      }, ANSWER_TIMEOUT_MS).unref?.();
    });
    this._check(run);
    if (answer === 'timeout') throw new Error('No answer came, so the calibration stopped. Press Calibrate to try again.');
    return /** @type {string} */ (answer);
  }

  /**
   * Measure one axis: +0.2 (then +0.4 if the picture barely moved), measure, undo. Unreliable
   * (dark, featureless) → ask the user which way it went.
   * @param {{ cancelled: boolean }} run @param {'x'|'y'} axis @param {number} progress
   * @returns {Promise<{ d: number|null, amount: number, settledMs: number, answer?: string }>}
   */
  async _axis(run, axis, progress) {
    let first = true;
    for (const amount of [0.2, 0.4]) {
      this._set({ step: axis === 'x' ? 'pan' : 'tilt', progress });
      await this._ref(run, first && axis === 'x');
      first = false;
      const mv = await this._move(run, axis === 'x' ? amount : 0, axis === 'y' ? amount : 0);
      // only a travel time the camera reported (MoveStatus) says anything about its speed; a
      // timed Stop's time is msPerUnit itself and would feed back into it on every calibration
      const settledMs = mv.measured === false ? 0 : mv.settledMs;
      this._check(run);
      // (a real camera's video lags the motor by a second or two: if it says it moved, wait for
      // the picture to move)
      const m = await this._o.vision.measure({ timeoutMs: 6000, expectMove: mv.moved === true });
      this._check(run);
      const d = axis === 'x' ? m.dx : m.dy;
      const reliable = Number.isFinite(d) && m.score >= MIN_SCORE;
      this._log('info', `[tapo] calibration ${axis} +${amount}: shift ${Number(d).toFixed(3)} (score ${Number(m.score).toFixed(2)}, picture settled after ${m.settledMs ?? '?'} ms, camera ${mv.moved === true ? 'reported the move' : mv.measured ? 'reported no move' : 'cannot report'})`);
      if (reliable && Math.abs(d) >= MIN_SHIFT) {
        await this._move(run, axis === 'x' ? -amount : 0, axis === 'y' ? -amount : 0);
        // msPerUnit is the motor's speed: the camera's own travel time, not when the picture
        // settled, which also holds the video's lag (1–2 s on a real camera, more with a stalled
        // worker: tapo-e2e on a loaded PC made msPerUnit 20000, the cap) divided by 0.2 units
        return { d, amount, settledMs };
      }
      if (!reliable || amount === 0.4) {
        // the camera is still turned: the user can see where it went
        const answer = await this._ask(run, axis, progress);
        await this._move(run, axis === 'x' ? -amount : 0, axis === 'y' ? -amount : 0);
        return { d: null, amount, settledMs, answer };
      }
      await this._move(run, axis === 'x' ? -amount : 0, axis === 'y' ? -amount : 0);
    }
    return { d: null, amount: 0.4, settledMs: 0 };
  }

  /** @param {{ cancelled: boolean }} run */
  async _sequence(run) {
    const cur = this._o.current();
    /** @type {CalibrationResult} */
    const out = { ...cur };
    try {
      // 1. pan
      const pan = await this._axis(run, 'x', 0.1);
      if (pan.d !== null) {
        // the camera turning right moves the scene left: a scene that moved right means mirrored pan
        out.invertPan = pan.d > 0;
        out.viewUnitsX = clamp(pan.amount / Math.abs(pan.d), 0.05, 4);
        if (pan.settledMs > 0) out.msPerUnit = Math.round(clamp(pan.settledMs / pan.amount, 500, 20000));
      } else if (pan.answer === 'left' || pan.answer === 'right') {
        out.invertPan = pan.answer === 'left';
      } else {
        throw new Error('The camera did not turn. Check that privacy mode is off and pan/tilt works in the Tapo app.');
      }
      // 2. tilt
      const tilt = await this._axis(run, 'y', 0.45);
      if (tilt.d !== null) {
        // tilting up moves the scene down
        out.invertTilt = tilt.d < 0;
        out.viewUnitsY = clamp(tilt.amount / Math.abs(tilt.d), 0.05, 4);
      } else if (tilt.answer === 'up' || tilt.answer === 'down') {
        out.invertTilt = tilt.answer === 'down';
      } else {
        throw new Error('The camera did not tilt. Check that privacy mode is off and pan/tilt works in the Tapo app.');
      }
      // 3. the smallest pan step the firmware acts on (only when the picture can be measured)
      if (pan.d !== null) {
        this._set({ step: 'min-step', progress: 0.75 });
        let found = null;
        for (const s of [0.02, 0.05, 0.1]) {
          await this._ref(run, false);
          const mv = await this._move(run, s, 0);
          const m = await this._o.vision.measure({ timeoutMs: 6000, expectMove: mv.moved === true });
          await this._move(run, -s, 0);
          if (m.score >= MIN_SCORE && Math.abs(m.dx) > 0.01) {
            found = s;
            break;
          }
        }
        out.minStep = found ?? 0.1;
      }
      this._check(run);
      const result = { ...out, calibratedAt: new Date(this._now()).toISOString() };
      this._o.save(result);
      this._log('info', `[tapo] calibration done: ${JSON.stringify(out)}`);
      this._run = null;
      this._set({ step: 'done', progress: 1, result: out });
    } catch (err) {
      const cancelled = err instanceof Cancelled || run.cancelled;
      await this._restore().catch(() => {});
      this._run = null;
      if (cancelled) {
        this._log('info', '[tapo] calibration cancelled');
        if (this._state.step !== 'idle') this._set({ step: 'idle', progress: 0 });
      } else {
        this._log('warn', `[tapo] calibration failed: ${/** @type {Error} */ (err).message}`);
        this._set({ step: 'failed', progress: this._state.progress, error: /** @type {Error} */ (err).message });
      }
    }
  }

  /** Stop and undo whatever has not been moved back yet. */
  async _restore() {
    await this._o.ptz.stopAll('calibration ended');
    const { x, y } = this._net;
    this._net = { x: 0, y: 0 };
    if (Math.abs(x) > 1e-6 || Math.abs(y) > 1e-6) await this._o.ptz.rawMove(-x, -y);
  }
}
