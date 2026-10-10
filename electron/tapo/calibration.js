// Calibration wizard (contract §8.4): finds the camera's axis signs, how many ONVIF units turn
// the view by one width/height, the smallest step the firmware acts on and its travel speed, by
// moving a little and measuring how far the picture shifted (the worker's shift estimator,
// §9.3). Pure Node; the PTZ controller, the shift measurement and saving are injected.
//
// Moves are raw ONVIF intent (+x = right, +y = up; no inversion, no minStep) and each one is
// undone, so the camera ends where it started — also on cancel or failure.
//
// A wrong calibration turns the D-pad, the keys, click-to-center and Claude's camera_look the
// wrong way, which is worse than asking the user. So nothing is concluded from a picture that is
// not provably current: the camera window's worker can stall for many seconds (synchronous
// readback under software GL, a busy PC) and keep decoding frames that left the camera before the
// last move, and a still picture is no proof of a current one.
//   * Every reference and measurement names `after`, when the last move ended (main's monotonic
//     clock, `clock`); the worker uses only frames that reached main later, and says which one it
//     used (`at`; a measurement also the reference's `refAt`). Anything else is not used.
//   * No reference picture → no measurement: the reference is asked for once more, then the user
//     is asked (with the camera turned) instead.
//   * Each axis is measured both ways: after the move there, a new reference at the turned
//     position and the move back; the way back must shift the picture the other way by 0.5×–2× as
//     much. If not, the axis is measured once more, then the user is asked. The min-step probe
//     takes a step only when its way back confirms it too, and it went the way the pan went.

import { EventEmitter } from 'node:events';

/**
 * @typedef {{ invertPan: boolean, invertTilt: boolean, viewUnitsX: number, viewUnitsY: number, minStep: number, msPerUnit: number }} CalibrationResult
 * @typedef {{ step: 'idle'|'pan'|'tilt'|'min-step'|'ask'|'done'|'failed', question?: string, answers?: string[], note?: string,
 *   progress: number, result?: CalibrationResult, error?: string }} CalibrationState
 *   note (ask): why the picture could not answer the question itself
 * @typedef {{ dx: number, dy: number, score: number, settledMs?: number, at?: number, refAt?: number, moved?: boolean, frames?: number }} Shift
 *   at: arrival stamp of the measured frame, refAt: of the reference it was compared with (both on
 *   the `clock` of the options); without them the measurement is not used
 * @typedef {{ ok: boolean, at?: number, still?: boolean, reason?: string }} RefAnswer
 *   ok with `at`: a reference picture that arrived at `at` (later than the request's `after`)
 * @typedef {{ settledMs: number, measured?: boolean, moved?: boolean }} MoveResult
 * @typedef {{ cancelled: boolean }} Run
 */

export const MIN_SHIFT = 0.02;
export const MIN_SCORE = 0.15;
/** The min-step probe: a step "turned the picture" above this shift. */
export const MIN_STEP_SHIFT = 0.01;
/** The way back must shift the picture by this much of the way there (either way round). */
export const RETURN_RATIO = Object.freeze({ min: 0.5, max: 2 });
export const ANSWER_TIMEOUT_MS = 120_000;
/** Why the user is asked (CalibrationState.note). */
export const ASK_NOTES = Object.freeze({
  plain: 'The picture was too dark or too plain to measure.',
  small: 'The picture hardly moved, so the turn could not be measured.',
  lagging: 'The picture is running too far behind the camera to measure (the PC is busy).',
  disagree: 'Measured there and back, the picture did not agree with itself.',
});
const QUESTIONS = {
  x: { question: 'Which way did the camera turn? (The picture moves the other way.)', answers: ['left', 'right', 'none'] },
  y: { question: 'Which way did the camera tilt? (The picture moves the other way.)', answers: ['up', 'down', 'none'] },
};

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));

/**
 * Does the way back confirm the way there? Opposite sign, 0.5×–2× the size.
 * @param {number} there scene shift of the move there @param {number} back of the move back
 * @param {number} [min] the smallest shift that counts as a move
 */
export function returnAgrees(there, back, min = MIN_SHIFT) {
  if (!Number.isFinite(there) || !Number.isFinite(back) || Math.abs(there) < min) return false;
  if (Math.sign(back) !== -Math.sign(there)) return false;
  const k = Math.abs(back) / Math.abs(there);
  return k >= RETURN_RATIO.min && k <= RETURN_RATIO.max;
}

class Cancelled extends Error {}

/**
 * @typedef {object} CalibrationOptions
 * @property {{ rawMove: (x: number, y: number) => Promise<MoveResult>, stopAll: (reason: string) => Promise<void> }} ptz
 *   `measured: false`: the move ended with the app's timed Stop (no GetStatus), so `settledMs` is
 *   the app's own estimate, not the camera's travel time
 * @property {{ ref: (o: { after: number }) => Promise<RefAnswer>, measure: (o: { timeoutMs: number, expectMove?: boolean, after: number }) => Promise<Shift> }} vision
 *   `after`: when the camera's last move ended (`clock`): only pictures that arrived later count.
 *   `expectMove`: the camera reported that it moved, so the picture must move too: wait for it
 *   (up to timeoutMs) however late the video is, instead of giving up after a short wait
 * @property {() => number} [clock]   monotonic ms of `after`, `at` and `refAt` (default performance.now())
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
    this._clock = o.clock || (() => performance.now());
    this._delay = o.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {CalibrationState} */
    this._state = { step: 'idle', progress: 0 };
    /** @type {Run|null} */
    this._run = null;
    /** @type {((a: string) => void)|null} */
    this._answer = null;
    /** raw displacement not undone yet */
    this._net = { x: 0, y: 0 };
    /** when the last move ended (`clock`): pictures that arrived before it are not current */
    this._after = 0;
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
    // (a move just before the calibration, by the user: its pictures are not the start either)
    this._after = this._clock();
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

  /** @param {Run} run */
  _check(run) {
    if (run.cancelled) throw new Cancelled('cancelled');
  }

  /** @param {Run} run @param {number} x @param {number} y @returns {Promise<MoveResult>} */
  async _move(run, x, y) {
    this._check(run);
    const r = await this._o.ptz.rawMove(x, y);
    this._net.x += x;
    this._net.y += y;
    // the move has ended (the camera's MoveStatus, or the app's Stop): older pictures may show
    // the camera before or during it
    this._after = this._clock();
    return r;
  }

  /** @param {Run} run @param {'x'|'y'} axis @param {number} amount */
  _moveAxis(run, axis, amount) {
    return this._move(run, axis === 'x' ? amount : 0, axis === 'y' ? amount : 0);
  }

  /**
   * A reference picture that arrived after the last move, confirmed by the worker. Asked for once
   * more when there is none; null then, and nothing is measured against it.
   * @param {Run} run @param {boolean} first the calibration's first picture (no move to wait out)
   * @returns {Promise<{ at: number }|null>}
   */
  async _ref(run, first) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      // the video lags the motor: let the last move reach the picture before the reference frame
      if (!first || attempt > 1) await this._delay(1000);
      this._check(run);
      const after = this._after;
      /** @type {RefAnswer|undefined} */
      let r;
      try {
        r = await this._o.vision.ref({ after });
      } catch (err) {
        r = { ok: false, reason: /** @type {Error} */ (err).message };
      }
      this._check(run);
      if (r && r.ok === true && typeof r.at === 'number' && r.at > after) {
        if (r.still === false) this._log('info', '[tapo] calibration: the reference picture never stood still (the scene moves); using the newest one');
        return { at: r.at };
      }
      const why = r?.ok === false && r.reason ? r.reason
        : r?.ok === true && typeof r.at === 'number' ? 'its picture is from before the camera\'s last move' : 'the camera window gave no current reference picture';
      this._log('info', `[tapo] calibration: no reference picture yet (${why})${attempt === 1 ? '; asking again' : '; not measuring without one'}`);
    }
    return null;
  }

  /**
   * Measure the move that just ended against `ref`. Not reliable when the score is low (dark,
   * featureless) or the picture is not provably current: it arrived before the move ended, or it
   * was compared with another reference than the one confirmed before the move (a stalled worker
   * that took a late one).
   * @param {Run} run @param {'x'|'y'} axis @param {{ at: number }} ref @param {MoveResult} mv
   * @param {string} label for the log ("x +0.2")
   */
  async _measure(run, axis, ref, mv, label) {
    const after = this._after;
    const m = await this._o.vision.measure({ timeoutMs: 6000, expectMove: mv.moved === true, after });
    this._check(run);
    const d = axis === 'x' ? m.dx : m.dy;
    const current = typeof m.at === 'number' && m.at > after && m.refAt === ref.at;
    const reliable = current && Number.isFinite(d) && m.score >= MIN_SCORE;
    const camera = mv.moved === true ? 'reported the move' : mv.measured ? 'reported no move' : 'cannot report';
    const stale = current ? '' : typeof m.at !== 'number' ? ', NOT USED: the picture is not known to be from after the move'
      : m.at <= after ? ', NOT USED: the picture is from before the move ended' : ', NOT USED: measured against another reference picture';
    this._log('info', `[tapo] calibration ${label}: shift ${Number(d).toFixed(3)} (score ${Number(m.score).toFixed(2)}, picture settled after ${m.settledMs ?? '?'} ms, camera ${camera}${stale})`);
    return { d, reliable, current, m };
  }

  /** @param {Run} run @param {'x'|'y'} axis @param {number} progress @param {string} note why */
  async _ask(run, axis, progress, note) {
    const q = QUESTIONS[axis];
    this._set({ step: 'ask', progress, question: q.question, answers: [...q.answers], note });
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
   * Ask which way the camera went while it is turned (the user can see where it went), then turn
   * it back. @param {Run} run @param {'x'|'y'} axis @param {number} progress @param {number} amount
   * @param {number} settledMs @param {boolean} turned the camera is turned by `amount` already
   * @param {string} note why the picture cannot tell (ASK_NOTES)
   */
  async _askTurned(run, axis, progress, amount, settledMs, turned, note) {
    if (!turned) await this._moveAxis(run, axis, amount);
    const answer = await this._ask(run, axis, progress, note);
    await this._moveAxis(run, axis, -amount);
    return { d: null, amount, settledMs, answer };
  }

  /**
   * Measure one axis: +0.2 (then +0.4 if the picture barely moved), measured both ways, then
   * undone. The two directions disagreeing → measured once more, then the user is asked.
   * Unreliable (dark, featureless, no current picture) → the user is asked which way it went.
   * @param {Run} run @param {'x'|'y'} axis @param {number} progress
   * @returns {Promise<{ d: number|null, amount: number, settledMs: number, answer?: string }>}
   */
  async _axis(run, axis, progress) {
    let amount = 0.2;
    for (let round = 1; round <= 2; round++) {
      const r = await this._axisOnce(run, axis, progress, round === 1 && axis === 'x');
      if (!('mismatch' in r)) return r;
      amount = r.mismatch;
      this._log('warn', `[tapo] calibration ${axis}: the way back did not confirm the way there${round === 1 ? '; measuring again' : '; asking'}`);
    }
    // measured twice, and twice the two directions disagreed: the user says which way it turns
    return this._askTurned(run, axis, progress, amount, 0, false, ASK_NOTES.disagree);
  }

  /**
   * @param {Run} run @param {'x'|'y'} axis @param {number} progress @param {boolean} first
   * @returns {Promise<{ d: number|null, amount: number, settledMs: number, answer?: string } | { mismatch: number }>}
   */
  async _axisOnce(run, axis, progress, first) {
    for (const amount of [0.2, 0.4]) {
      this._set({ step: axis === 'x' ? 'pan' : 'tilt', progress });
      const ref = await this._ref(run, first);
      first = false;
      // nothing current to measure against: the user says which way it went
      if (!ref) return this._askTurned(run, axis, progress, amount, 0, false, ASK_NOTES.lagging);
      const mv = await this._moveAxis(run, axis, amount);
      // only a travel time the camera reported (MoveStatus) says anything about its speed; a
      // timed Stop's time is msPerUnit itself and would feed back into it on every calibration.
      // (msPerUnit is the motor's speed: not when the picture settled, which also holds the
      // video's lag, 1–2 s on a real camera and more with a stalled worker)
      const settledMs = mv.measured === false ? 0 : mv.settledMs;
      // (a real camera's video lags the motor by a second or two: if it says it moved, the
      // worker waits for the picture to move)
      const there = await this._measure(run, axis, ref, mv, `${axis} +${amount}`);
      if (there.reliable && Math.abs(there.d) >= MIN_SHIFT) {
        // the way back, against a new reference at the turned position
        const ref2 = await this._ref(run, false);
        if (!ref2) return this._askTurned(run, axis, progress, amount, settledMs, true, ASK_NOTES.lagging);
        const mvBack = await this._moveAxis(run, axis, -amount);
        const back = await this._measure(run, axis, ref2, mvBack, `${axis} -${amount} (back)`);
        if (back.reliable && returnAgrees(there.d, back.d)) {
          const size = (Math.abs(there.d) + Math.abs(back.d)) / 2;
          return { d: Math.sign(there.d) * size, amount, settledMs };
        }
        return { mismatch: amount }; // (the camera is back where it started)
      }
      // the camera is still turned: the user can see where it went
      if (!there.reliable || amount === 0.4) {
        const note = there.reliable ? ASK_NOTES.small : there.current ? ASK_NOTES.plain : ASK_NOTES.lagging;
        return this._askTurned(run, axis, progress, amount, settledMs, true, note);
      }
      await this._moveAxis(run, axis, -amount);
    }
    return { mismatch: 0.4 }; // (not reached: 0.4 always returns above)
  }

  /**
   * The smallest pan step the firmware acts on: 0.02, 0.05, 0.1, each undone. A step counts only
   * when it shifted the picture the way the pan measurement did (`sign`) and its way back
   * confirms it; a step whose two directions disagree is tried once more, then the next one.
   * No current reference picture → the probe stops (`stopped`): minStep stays as it was.
   * @param {Run} run @param {number} sign the sign of the pan measurement's shift for +x
   * @returns {Promise<{ found: number|null, stopped: boolean }>}
   */
  async _minStep(run, sign) {
    for (const s of [0.02, 0.05, 0.1]) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ref = await this._ref(run, false);
        if (!ref) return { found: null, stopped: true };
        const mv = await this._move(run, s, 0);
        const there = await this._measure(run, 'x', ref, mv, `min step +${s}`);
        if (!there.reliable || Math.abs(there.d) <= MIN_STEP_SHIFT) {
          // too small to turn the picture (or it cannot tell): a bigger step
          await this._move(run, -s, 0);
          break;
        }
        const ref2 = await this._ref(run, false);
        if (!ref2) {
          await this._move(run, -s, 0);
          return { found: null, stopped: true };
        }
        const mvBack = await this._move(run, -s, 0);
        const back = await this._measure(run, 'x', ref2, mvBack, `min step -${s} (back)`);
        if (Math.sign(there.d) === sign && back.reliable && returnAgrees(there.d, back.d, MIN_STEP_SHIFT)) return { found: s, stopped: false };
        this._log('warn', `[tapo] calibration: min step ${s} was not confirmed by its way back${attempt === 1 ? '; once more' : ''}`);
      }
    }
    return { found: null, stopped: false };
  }

  /** @param {Run} run */
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
        const r = await this._minStep(run, Math.sign(pan.d));
        if (r.found !== null) out.minStep = r.found;
        else if (!r.stopped) out.minStep = 0.1;
        else this._log('info', '[tapo] calibration: the smallest step could not be measured; it stays as it was');
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
