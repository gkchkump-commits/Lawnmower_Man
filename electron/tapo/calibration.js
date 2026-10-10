// Calibration wizard (contract §8.4): finds the camera's axis signs, how many ONVIF units turn
// the view by one width/height, the smallest step the firmware acts on and its travel speed, by
// moving a little and measuring how far the picture shifted (the worker's shift estimator,
// §9.3). Pure Node; the PTZ controller, the shift measurement and saving are injected.
//
// Moves are raw ONVIF intent (+x = right, +y = up; no inversion, no minStep) and each one is
// undone: by the opposite command, or by what the camera reported it travelled when that was
// less (an end stop cut it short); a move it reported as not made is not undone. At the end, also
// on cancel or failure, the camera goes back to the position it reported at the start (or by the
// moves not undone yet, when it cannot report one). An axis whose start is near an end stop is
// measured away from it, and one that the camera reports as blocked the other way.
//
// A wrong calibration turns the D-pad, the keys, click-to-center and Claude's camera_look the
// wrong way, which is worse than asking the user. So nothing is concluded from a picture that is
// not provably current. Two things make a picture old: the camera window's worker can stall for
// many seconds (synchronous readback under software GL, a busy PC) and keep decoding frames that
// left the camera before the last move; and the video itself can lag the motor before it reaches
// main (the camera, the network, go2rtc on a busy PC), so a frame that arrived after the move may
// still show the camera before it. A still picture is no proof of a current one.
//   * Every reference and measurement names `after`, when the last move ended (main's monotonic
//     clock, `clock`); the worker uses only frames that reached main later, and says which one it
//     used (`at`; a measurement also the reference's `refAt`). Anything else is not used.
//   * No reference picture → no measurement: the reference is asked for once more, then the user
//     is asked (with the camera turned) instead. A reference must be a still picture.
//   * A measurement counts only when the picture moved (when the camera reported the move, or
//     cannot report: then the full wait is waited for) and settled. The camera reporting a move
//     and the picture not following, or a picture that hardly moved, means the picture runs
//     behind: that axis is asked about and nothing more is measured in this run (a later
//     reference could show the earlier moves).
//   * The picture's lag behind the camera is learnt from when it first changed after a move
//     (`changedAt`; it cannot change before the motor starts), and later references wait it out.
//   * Each axis is measured both ways: after the move there, a new reference at the turned
//     position, which must match the frame the measurement ended on (`vsLast`: a measurement that
//     ended on a picture still catching up would not), then the move back, which must shift the
//     picture the other way by 0.75×–1.33× as much per unit (the view units come from the larger
//     of the two: a picture that has not caught up shows less). If not, the axis is measured once
//     more, then the user is asked. The view units use the travel the camera reported (GetStatus).
//   * The min-step probe takes a step only when it went the way the pan went and its way back
//     confirms it; a step counts as "too small" only when its picture is current, settled and
//     still and the camera did not report it as made; anything else stops the probe and minStep
//     stays as it was.

import { EventEmitter } from 'node:events';

/**
 * @typedef {{ invertPan: boolean, invertTilt: boolean, viewUnitsX: number, viewUnitsY: number, minStep: number, msPerUnit: number }} CalibrationResult
 * @typedef {{ step: 'idle'|'pan'|'tilt'|'min-step'|'ask'|'cancelling'|'done'|'failed', question?: string, answers?: string[], note?: string,
 *   progress: number, result?: CalibrationResult, error?: string }} CalibrationState
 *   note (ask): why the picture could not answer the question itself; cancelling: the camera is
 *   being put back after a cancel
 * @typedef {{ dx: number, dy: number, score: number, settledMs?: number, at?: number, refAt?: number, moved?: boolean, settled?: boolean,
 *   frames?: number, firstAt?: number, changedAt?: number, contrast?: number }} Shift
 *   at: arrival stamp of the measured frame, refAt: of the reference it was compared with (both on
 *   the `clock` of the options; without them the measurement is not used); moved: the picture
 *   changed; settled: it then stood still; firstAt / changedAt: arrival stamps of the first frame
 *   looked at and of the first that showed the change; contrast: luma standard deviation
 * @typedef {{ ok: boolean, at?: number, still?: boolean, reason?: string, contrast?: number, vsLast?: { at: number, dx: number, dy: number, score: number } }} RefAnswer
 *   ok with `at`: a reference picture that arrived at `at` (later than the request's `after`);
 *   vsLast: the shift from the frame the last measurement ended on (`at`) to this reference
 * @typedef {{ settledMs: number, measured?: boolean, moved?: boolean, travel?: { x: number, y: number } }} MoveResult
 * @typedef {MoveResult & { startedAt: number, cmd: { x: number, y: number }, turned: { x: number, y: number } }} Move
 *   turned: what the move changed (the reported travel; nothing for a move reported as not made;
 *   the command `cmd` when the camera cannot report)
 * @typedef {{ cancelled: boolean, abort: AbortController, stopped: Promise<never>, fail: (e: Error) => void }} Run
 * @typedef {{ k: number, dir: number, travel: number, settledMs: number } | { k: null, answer: string, dir: number }} AxisResult
 *   k: the scene shift (view fractions) per raw unit; dir: the sign of the move the answer is about
 * @typedef {{ d: number, current: boolean, readable: boolean, plain: boolean, m: Shift }} Measured
 */

export const MIN_SHIFT = 0.02;
export const MIN_SCORE = 0.15;
/** The min-step probe: a step "turned the picture" above this shift. */
export const MIN_STEP_SHIFT = 0.01;
/** The way back must shift the picture by this much of the way there per unit (either way round). */
export const RETURN_RATIO = Object.freeze({ min: 0.75, max: 4 / 3 });
/** The min-step probe only decides "moved or not": a looser window. */
export const STEP_RETURN_RATIO = Object.freeze({ min: 0.5, max: 2 });
/** The reference at the turned position shows the frame the measurement ended on: within this. */
export const MATCH_SHIFT = 0.02;
/** A reported travel shorter than this share of the command: an end stop; measured the other way. */
export const SHORT_TRAVEL = 0.5;
/** A start this close to an end of the generic space (±1): that axis is measured away from it. */
export const END_ROOM = 0.45;
/** Waited for before each reference (and longer when the picture is known to lag more). */
export const REF_DELAY_MS = 1000;
/** The camera still for this long before the first reference (a move just before the start, by
 * the user, may still be on its way to the picture: a real camera's video lags by 1–2 s). */
export const START_IDLE_MS = 3000;
export const MEASURE_MS = 6000;
/** The worker's longest measurement (pipeline.js MAX_SHIFT_TIMEOUT_MS). */
export const MAX_MEASURE_MS = 15_000;
/** On top of the learnt lag: this much, or this share of it (the larger). */
export const LAG_MARGIN = Object.freeze({ ms: 300, share: 0.25 });
/** A picture this far behind the camera is not measured with. */
export const MAX_LAG_MS = 12_000;
/** Contrast (luma standard deviation) below which a picture that could not be matched is "plain". */
export const PLAIN_CONTRAST = 8;
/** Closer than this to where it started: not turned back. */
export const RESTORE_EPS = 0.005;
export const MIN_STEPS = Object.freeze([0.02, 0.05, 0.1]);
export const ANSWER_TIMEOUT_MS = 120_000;
/** Why the user is asked (CalibrationState.note). */
export const ASK_NOTES = Object.freeze({
  plain: 'The picture was too dark or too plain to measure.',
  unclear: 'The pictures before and after the turn could not be matched.',
  small: 'The picture hardly moved, so the turn could not be measured.',
  still: 'The picture did not move, or it runs too far behind the camera to tell.',
  lagging: 'The picture is running too far behind the camera to measure (the PC is busy).',
  unsettled: 'The picture did not stand still, so the turn could not be measured.',
  disagree: 'Measured there and back, the picture did not agree with itself.',
  noMove: 'The camera reported that it did not move.',
});
const QUESTIONS = {
  x: { question: 'Which way did the camera turn? (The picture moves the other way.)', answers: ['left', 'right', 'none'] },
  y: { question: 'Which way did the camera tilt? (The picture moves the other way.)', answers: ['up', 'down', 'none'] },
};

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));
/** "+0.2", "-0.05" @param {number} v */
const sig = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 1000) / 1000}`;
/** @param {unknown} p @returns {{ x: number, y: number }|null} */
const posOf = (p) => (p && typeof p === 'object' && Number.isFinite(/** @type {any} */ (p).x) && Number.isFinite(/** @type {any} */ (p).y) ? { x: /** @type {any} */ (p).x, y: /** @type {any} */ (p).y } : null);

/**
 * Does the way back confirm the way there? Opposite sign, and within `ratio` of its size.
 * @param {number} there scene shift of the move there @param {number} back of the move back (per
 *   the same travel) @param {number} [min] the smallest shift that counts as a move
 * @param {{ min: number, max: number }} [ratio]
 */
export function returnAgrees(there, back, min = MIN_SHIFT, ratio = RETURN_RATIO) {
  if (!Number.isFinite(there) || !Number.isFinite(back) || Math.abs(there) < min) return false;
  if (Math.sign(back) !== -Math.sign(there)) return false;
  const k = Math.abs(back) / Math.abs(there);
  return k >= ratio.min && k <= ratio.max;
}

class Cancelled extends Error {}

/**
 * @typedef {object} CalibrationOptions
 * @property {{ rawMove: (x: number, y: number) => Promise<MoveResult>, stopAll: (reason: string) => Promise<void>,
 *   position?: () => Promise<{ x: number, y: number }|null>, idleMs?: () => number }} ptz
 *   `measured: false`: the move ended with the app's timed Stop (no GetStatus), so `settledMs` is
 *   the app's own estimate, not the camera's travel time; `travel`: the position change the camera
 *   reported; `position`: a fresh GetStatus position (null when it cannot tell); `idleMs`: how
 *   long the camera has been still
 * @property {{ ref: (o: { after: number, signal?: AbortSignal }) => Promise<RefAnswer>,
 *   measure: (o: { timeoutMs: number, expectMove?: boolean, after: number, signal?: AbortSignal }) => Promise<Shift> }} vision
 *   `after`: when the camera's last move ended (`clock`): only pictures that arrived later count.
 *   `expectMove`: the camera reported that it moved (or cannot report), so the picture must move
 *   too: wait for it (up to timeoutMs) however late the video is, instead of giving up after a
 *   short wait. `signal`: aborted when the calibration is cancelled
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
    /** start again once a cancelled run has put the camera back */
    this._again = false;
    this._reset();
  }

  _reset() {
    /** raw displacement not undone yet */
    this._net = { x: 0, y: 0 };
    /** when the last move ended (`clock`): pictures that arrived before it are not current */
    this._after = 0;
    /** the frame the last measurement ended on, while the camera has not moved since @type {number|null} */
    this._lastAt = null;
    /** how far (ms, an upper bound) the picture runs behind the camera; null: not seen yet @type {number|null} */
    this._lagMs = null;
    /** the picture was found running behind the camera: why (nothing more is measured) @type {string|null} */
    this._distrust = null;
    /** the position the camera reported at the start @type {{ x: number, y: number }|null} */
    this._start = null;
    /** the smallest step the probe found (the restore's two-step correction) @type {number|null} */
    this._minStepFound = null;
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
    if (this._run) {
      // a cancelled run is still putting the camera back: start once it is there
      if (this._run.cancelled) this._again = true;
      return this.state;
    }
    const why = this._o.canStart();
    if (why) {
      this._set({ step: 'failed', progress: 0, error: why });
      return this.state;
    }
    /** @type {(e: Error) => void} */
    let fail = () => {};
    /** @type {Promise<never>} */
    const stopped = new Promise((_, reject) => { fail = reject; });
    stopped.catch(() => {});
    const run = { cancelled: false, abort: new AbortController(), stopped, fail };
    this._run = run;
    this._reset();
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
      // taken: no longer asking (the dialog would otherwise show the question again until the
      // next state arrives)
      this._set({ step: (this._state.answers || []).includes('up') ? 'tilt' : 'pan', progress: this._state.progress });
      f(a);
    }
    return this.state;
  }

  /**
   * Stop: a pending picture request is dropped at once and the camera is put back; the state
   * says 'cancelling' until it is, then 'idle'.
   */
  cancel() {
    const run = this._run;
    this._again = false;
    if (!run) {
      if (this._state.step !== 'idle') this._set({ step: 'idle', progress: 0 });
      return this.state;
    }
    if (!run.cancelled) {
      run.cancelled = true;
      run.abort.abort();
      run.fail(new Cancelled('cancelled'));
      if (this._answer) {
        const f = this._answer;
        this._answer = null;
        f('cancel');
      }
      this._set({ step: 'cancelling', progress: this._state.progress });
    }
    return this.state;
  }

  /** @param {Run} run */
  _check(run) {
    if (run.cancelled) throw new Cancelled('cancelled');
  }

  /** A promise that a cancel ends at once. @template T @param {Run} run @param {Promise<T>} p @returns {Promise<T>} */
  _race(run, p) {
    return Promise.race([p, run.stopped]);
  }

  /** @param {Run} run @param {number} ms */
  async _sleep(run, ms) {
    if (ms > 0) await this._race(run, this._delay(ms));
    this._check(run);
  }

  /** The camera's position now (null when it cannot tell). */
  async _position() {
    if (!this._o.ptz.position) return null;
    try {
      return posOf(await this._o.ptz.position());
    } catch {
      return null;
    }
  }

  /** How long after a move's end its picture may still be on its way (0 until the lag is seen). */
  _allowance() {
    if (this._lagMs === null) return 0;
    return Math.round(this._lagMs + Math.max(LAG_MARGIN.ms, this._lagMs * LAG_MARGIN.share));
  }

  /**
   * A frame that showed a move arrived `bound` ms after the move began: the picture runs at most
   * that far behind (it cannot change before the motor starts). Raised only when the picture was
   * seen unchanged first (`late`), or not known yet: a frame that already showed the change says
   * nothing new. @param {number} bound @param {boolean} late
   */
  _learnLag(bound, late) {
    if (!Number.isFinite(bound)) return;
    if (this._lagMs !== null && !late) return;
    const lag = Math.max(this._lagMs ?? 0, Math.round(Math.max(0, bound)));
    if (lag !== this._lagMs) this._log('info', `[tapo] calibration: the picture runs up to ${lag} ms behind the camera`);
    this._lagMs = lag;
  }

  /** @param {Run} run @param {number} x @param {number} y @returns {Promise<Move>} */
  async _move(run, x, y) {
    this._check(run);
    const startedAt = this._clock();
    // (not cut short by a cancel: the restore must know where the camera went)
    const r = (await this._o.ptz.rawMove(x, y)) || { settledMs: 0 };
    const t = posOf(r.travel);
    const turned = r.moved === false ? { x: 0, y: 0 } : t || { x, y };
    this._net.x += turned.x;
    this._net.y += turned.y;
    // the move has ended (the camera's MoveStatus, or the app's Stop): older pictures may show
    // the camera before or during it
    this._after = this._clock();
    this._lastAt = null;
    this._check(run);
    return { ...r, ...(t ? { travel: t } : {}), startedAt, cmd: { x, y }, turned };
  }

  /**
   * The raw move that undoes `mv` on `axis`: the opposite command, or the opposite of the
   * reported travel when that was shorter (an end stop cut it short; the way back is free). A
   * firmware whose moves overshoot does so both ways, so the opposite command brings it back.
   * 0 for a move the camera reported as not made. @param {Move} mv @param {'x'|'y'} axis
   */
  _undoOf(mv, axis) {
    const cmd = mv.cmd[axis];
    const turned = mv.turned[axis];
    return Math.abs(turned) < Math.abs(cmd) - 1e-3 ? -turned : -cmd;
  }

  /** Undo `mv` (when it moved anything). @param {Run} run @param {Move} mv @returns {Promise<Move|null>} */
  async _undo(run, mv) {
    const x = this._undoOf(mv, 'x');
    const y = this._undoOf(mv, 'y');
    if (Math.abs(x) <= 1e-6 && Math.abs(y) <= 1e-6) return null;
    return this._move(run, x, y);
  }

  /** @param {Run} run @param {'x'|'y'} axis @param {number} amount */
  _moveAxis(run, axis, amount) {
    return this._move(run, axis === 'x' ? amount : 0, axis === 'y' ? amount : 0);
  }

  /**
   * A still reference picture that arrived after the last move (and the picture's known lag),
   * confirmed by the worker. When the camera has not moved since the last measurement, it must
   * also show the frame that measurement ended on: if the picture changed since, that frame was
   * not the camera's final view (the picture was still catching up), and nothing is measured.
   * Asked for once more when there is none (or it was not still).
   * @param {Run} run @param {boolean} first the calibration's first picture (no move to wait out)
   * @returns {Promise<{ at: number } | { note: string }>}
   */
  async _ref(run, first) {
    const match = this._lastAt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const now = first && attempt === 1;
      const after = now ? this._after : this._after + this._allowance();
      // the video lags the motor: let the last move reach the picture before the reference frame
      if (!now) await this._sleep(run, Math.max(REF_DELAY_MS, after - this._clock()));
      // (a thrown error, such as no live stream at all, ends the calibration with its message)
      const r = await this._race(run, this._o.vision.ref({ after, signal: run.abort.signal }));
      this._check(run);
      const again = attempt === 1 ? '; asking again' : '';
      if (r && r.ok === true && typeof r.at === 'number' && r.at > after) {
        if (r.still !== true) {
          this._log('info', `[tapo] calibration: the reference picture did not stand still${again || '; not measuring against it'}`);
          if (attempt === 1) continue;
          // right after a move that can be the move still reaching the picture
          if (!first) this._distrust = ASK_NOTES.unsettled;
          return { note: ASK_NOTES.unsettled };
        }
        if (match !== null) {
          const v = r.vsLast;
          const same = !!v && v.at === match && v.score >= MIN_SCORE && Math.abs(v.dx) <= MATCH_SHIFT && Math.abs(v.dy) <= MATCH_SHIFT;
          if (!same) {
            const how = !v || v.at !== match ? 'it could not be compared with the measured one' : `by ${sig(v.dx)}, ${sig(v.dy)} (score ${v.score.toFixed(2)})`;
            this._log('warn', `[tapo] calibration: the picture changed after the measurement ended (${how}): it was still catching up with the camera; not used`);
            this._distrust = ASK_NOTES.lagging;
            return { note: ASK_NOTES.lagging };
          }
        }
        return { at: r.at };
      }
      const why = r?.ok === false && r.reason ? r.reason
        : r?.ok === true && typeof r.at === 'number' ? 'its picture is from before the camera\'s last move' : 'the camera window gave no current reference picture';
      this._log('info', `[tapo] calibration: no reference picture yet (${why})${again || '; not measuring without one'}`);
    }
    return { note: ASK_NOTES.lagging };
  }

  /**
   * Measure the move that just ended against `ref`. Not current when the picture arrived before
   * the move ended, or was compared with another reference than the one confirmed before the move
   * (a stalled worker that took a late one); not readable when the score is low (dark,
   * featureless, or two pictures that do not match). A move the camera reported as made, or that
   * it cannot report on, is waited for the full time (however late the video shows it); one it
   * reported as not made is looked at only after the picture's known lag.
   * @param {Run} run @param {'x'|'y'} axis @param {{ at: number }} ref @param {Move} mv
   * @param {string} label for the log ("x +0.2")
   * @returns {Promise<Measured>}
   */
  async _measure(run, axis, ref, mv, label) {
    const expectMove = mv.moved !== false;
    let after = this._after;
    if (!expectMove) {
      after += this._allowance();
      await this._sleep(run, after - this._clock());
    }
    const timeoutMs = Math.min(MAX_MEASURE_MS, MEASURE_MS + (expectMove ? this._allowance() : 0));
    const m = await this._race(run, this._o.vision.measure({ timeoutMs, expectMove, after, signal: run.abort.signal }));
    this._check(run);
    const d = axis === 'x' ? m.dx : m.dy;
    const current = typeof m.at === 'number' && m.at > after && m.refAt === ref.at;
    this._lastAt = current ? /** @type {number} */ (m.at) : null;
    if (current && m.moved === true && typeof m.changedAt === 'number') this._learnLag(m.changedAt - mv.startedAt, typeof m.firstAt === 'number' && m.changedAt > m.firstAt);
    const readable = Number.isFinite(d) && m.score >= MIN_SCORE;
    const plain = !(typeof m.contrast === 'number' && m.contrast >= PLAIN_CONTRAST);
    const camera = mv.moved === true ? 'reported the move' : mv.moved === false ? 'reported no move' : mv.measured ? 'reported no position' : 'cannot report';
    const picture = m.moved !== true ? 'did not move' : m.settled === true ? `settled after ${m.settledMs ?? '?'} ms` : `did not settle in ${m.settledMs ?? '?'} ms`;
    const stale = current ? '' : typeof m.at !== 'number' ? ', NOT USED: the picture is not known to be from after the move'
      : m.at <= after ? ', NOT USED: the picture is from before the move ended' : ', NOT USED: measured against another reference picture';
    this._log('info', `[tapo] calibration ${label}: shift ${Number(d).toFixed(3)} (score ${Number(m.score).toFixed(2)}, picture ${picture}, camera ${camera}${stale})`);
    return { d, current, readable, plain, m };
  }

  /**
   * Can an axis measurement be used? null if so, else why not (ASK_NOTES). A picture that is not
   * current, did not follow a move, did not settle or hardly moved is running behind the camera
   * (or something else moves in view): nothing more is measured in this run.
   * @param {Measured} r @param {Move} mv @returns {string|null}
   */
  _axisVerdict(r, mv) {
    /** @param {string} note */
    const distrust = (note) => {
      this._distrust = note;
      return note;
    };
    if (!r.current) return distrust(ASK_NOTES.lagging);
    if (r.m.moved !== true) return distrust(mv.moved === true ? ASK_NOTES.lagging : ASK_NOTES.still);
    if (r.m.settled !== true) return distrust(ASK_NOTES.unsettled);
    if (!r.readable) return r.plain ? ASK_NOTES.plain : ASK_NOTES.unclear;
    if (Math.abs(r.d) < MIN_SHIFT) return distrust(ASK_NOTES.small);
    if (this._lagMs !== null && this._lagMs > MAX_LAG_MS) return distrust(ASK_NOTES.lagging);
    return null;
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
   * it back. @param {Run} run @param {'x'|'y'} axis @param {number} progress
   * @param {number} amount the move to make (when not turned yet) @param {Move|null} turned the
   *   move the camera is turned by already (null: not turned)
   * @param {string} note why the picture cannot tell (ASK_NOTES)
   * @returns {Promise<AxisResult>}
   */
  async _askTurned(run, axis, progress, amount, turned, note) {
    const mv = turned || (await this._moveAxis(run, axis, amount));
    const answer = await this._ask(run, axis, progress, note);
    await this._undo(run, mv);
    return { k: null, answer, dir: Math.sign(mv.turned[axis]) || Math.sign(amount) };
  }

  /**
   * Measure one axis: 0.2 (then 0.4 if the camera reported that it did not move) the way `dir`
   * says, measured both ways, then undone. The two directions disagreeing → measured once more,
   * then the user is asked. Blocked (an end stop) → the other way. Not measurable → the user is
   * asked which way it went.
   * @param {Run} run @param {'x'|'y'} axis @param {number} progress @param {number} dir ±1
   * @returns {Promise<AxisResult>}
   */
  async _axis(run, axis, progress, dir) {
    let first = axis === 'x';
    let flipped = false;
    let note = ASK_NOTES.disagree;
    for (let round = 1; round <= 2;) {
      if (this._distrust) return this._askTurned(run, axis, progress, dir * 0.2, null, this._distrust);
      const r = await this._axisOnce(run, axis, progress, dir, first);
      first = false;
      if ('blocked' in r) {
        if (flipped) return this._askTurned(run, axis, progress, dir * 0.4, null, ASK_NOTES.noMove);
        flipped = true;
        dir = -dir;
        this._log('info', `[tapo] calibration ${axis}: ${r.blocked}; measuring the other way`);
        continue;
      }
      if (!('mismatch' in r)) return r;
      note = r.note || ASK_NOTES.disagree;
      this._log('warn', `[tapo] calibration ${axis}: the way back did not confirm the way there${round === 1 && !this._distrust ? '; measuring again' : '; asking'}`);
      round++;
    }
    // measured twice, and twice the two directions disagreed: the user says which way it turns
    return this._askTurned(run, axis, progress, dir * 0.2, null, note);
  }

  /**
   * @param {Run} run @param {'x'|'y'} axis @param {number} progress @param {number} dir @param {boolean} first
   * @returns {Promise<AxisResult | { mismatch: true, note?: string } | { blocked: string }>}
   */
  async _axisOnce(run, axis, progress, dir, first) {
    this._set({ step: axis === 'x' ? 'pan' : 'tilt', progress });
    const ref = await this._ref(run, first);
    // nothing current to measure against: the user says which way it went
    if ('note' in ref) return this._askTurned(run, axis, progress, dir * 0.2, null, ref.note);
    for (const size of [0.2, 0.4]) {
      const amount = dir * size;
      const mv = await this._moveAxis(run, axis, amount);
      const turned = mv.turned[axis];
      if (mv.moved === false) {
        // nothing moved, so nothing can reach the picture later either: the same reference, a bigger move
        this._log('info', `[tapo] calibration ${axis} ${sig(amount)}: the camera reported no move`);
        continue;
      }
      if (mv.travel && Math.abs(turned) < SHORT_TRAVEL * size) {
        if (this._lagMs === null) {
          // how far the picture runs behind is not known yet: this short turn (and its undo) must
          // reach the picture before the next reference, or that reference shows it late, and the
          // next measurement takes it for its own move. Wait for the picture to show it (which
          // also tells the lag: it was current before this turn); if it does not, it runs behind.
          const seen = await this._measure(run, axis, ref, mv, `${axis} ${sig(amount)} (cut short)`);
          if (!seen.current || seen.m.moved !== true || seen.m.settled !== true) this._distrust = ASK_NOTES.lagging;
        }
        await this._undo(run, mv);
        return { blocked: `the camera turned only ${sig(turned)} of ${sig(amount)} (an end stop)` };
      }
      // the camera is turned from here on: the user can see where it went
      const there = await this._measure(run, axis, ref, mv, `${axis} ${sig(amount)}`);
      const bad = this._axisVerdict(there, mv);
      if (bad) return this._askTurned(run, axis, progress, amount, mv, bad);
      // the way back, against a new reference at the turned position (the frame `there` ended on)
      const ref2 = await this._ref(run, false);
      if ('note' in ref2) return this._askTurned(run, axis, progress, amount, mv, ref2.note);
      const mvBack = await this._moveAxis(run, axis, this._undoOf(mv, axis));
      if (mvBack.moved === false) return this._askTurned(run, axis, progress, amount, mv, ASK_NOTES.disagree); // (still turned)
      const backTurned = mvBack.turned[axis];
      const back = await this._measure(run, axis, ref2, mvBack, `${axis} ${sig(backTurned)} (back)`);
      const badBack = this._axisVerdict(back, mvBack);
      if (badBack) return { mismatch: true, note: badBack }; // (the camera is back where it started)
      // per unit of travel: the camera may report a slightly different way back
      const backScaled = backTurned ? back.d * Math.abs(turned / backTurned) : NaN;
      if (returnAgrees(there.d, backScaled)) {
        const k = (Math.sign(there.d) * Math.max(Math.abs(there.d), Math.abs(backScaled))) / turned;
        return { k, dir: Math.sign(turned), travel: Math.abs(turned), settledMs: mv.measured === false ? 0 : mv.settledMs };
      }
      return { mismatch: true };
    }
    return { blocked: 'the camera reported that it did not move' };
  }

  /**
   * Is a min-step measurement a step that moved, one that did not ('still'), or neither (why)?
   * "Did not move" needs a current, settled, readable, still picture, and a camera that did not
   * report the step as made (or cannot report, and the picture stood still for the full wait
   * beyond its known lag).
   * @param {Measured} r @param {Move} mv @returns {string}
   */
  _stepVerdict(r, mv) {
    if (!r.current) return 'the picture is not current';
    if (r.m.settled !== true) return 'the picture did not settle';
    if (!r.readable) return 'the picture could not be measured';
    const small = Math.abs(r.d) <= MIN_STEP_SHIFT;
    if (mv.moved === true) {
      if (r.m.moved !== true) return 'the camera reported the step, but the picture did not follow';
      return small ? 'the camera reported the step, but the picture hardly moved' : 'moved';
    }
    if (mv.moved === false) return small ? 'still' : 'the camera reported no move, but the picture moved';
    if (r.m.moved === true) return small ? 'the picture changed but hardly moved' : 'moved';
    return small && this._lagMs !== null ? 'still' : 'the picture did not move (it may run behind the camera)';
  }

  /** @param {string} why @returns {{ found: null, stopped: true }} */
  _stopProbe(why) {
    this._log('info', `[tapo] calibration: the smallest step could not be measured (${why}); it stays as it was`);
    return { found: null, stopped: true };
  }

  /**
   * The smallest pan step the firmware acts on: 0.02, 0.05, 0.1 the way `dir` says, each undone.
   * A step counts only when it shifted the picture the way the pan measurement did and its way
   * back confirms it; a step whose two directions disagree is tried once more, then the next one.
   * Anything that cannot be told (no current reference, a picture that does not settle or follow
   * the camera) stops the probe (`stopped`): minStep stays as it was. 0.1 is the answer only when
   * every size reliably did not move.
   * @param {Run} run @param {number} dir ±1 @param {number} k the pan's scene shift per raw unit
   * @returns {Promise<{ found: number|null, stopped: boolean }>}
   */
  async _minStep(run, dir, k) {
    const want = Math.sign(k * dir); // the picture's shift for a step the way `dir` says
    let allStill = true;
    for (const s of MIN_STEPS) {
      let still = false;
      for (let attempt = 1; attempt <= 2 && !still; attempt++) {
        const step = dir * s;
        const ref = await this._ref(run, false);
        if ('note' in ref) return this._stopProbe('no current reference picture');
        const mv = await this._move(run, step, 0);
        const t = mv.turned.x;
        const there = await this._measure(run, 'x', ref, mv, `min step ${sig(step)}`);
        const v = this._stepVerdict(there, mv);
        if (v !== 'moved') {
          await this._undo(run, mv);
          if (v === 'still') {
            still = true; // too small to turn the picture: a bigger step
            continue;
          }
          return this._stopProbe(v);
        }
        const ref2 = await this._ref(run, false);
        if ('note' in ref2) {
          await this._undo(run, mv);
          return this._stopProbe('no current reference picture at the turned position');
        }
        const mvBack = await this._move(run, this._undoOf(mv, 'x'), 0);
        const back = await this._measure(run, 'x', ref2, mvBack, `min step ${sig(mvBack.turned.x || -t)} (back)`);
        const vb = mvBack.moved === false ? 'still' : this._stepVerdict(back, mvBack);
        if (vb !== 'moved' && vb !== 'still') return this._stopProbe(vb);
        const backScaled = vb === 'moved' && mvBack.turned.x ? back.d * Math.abs(t / mvBack.turned.x) : 0;
        if (Math.sign(there.d) === want && returnAgrees(there.d, backScaled, MIN_STEP_SHIFT, STEP_RETURN_RATIO)) return { found: s, stopped: false };
        this._log('warn', `[tapo] calibration: min step ${s} was not confirmed by its way back${attempt === 1 ? '; once more' : ''}`);
      }
      if (!still) allStill = false;
    }
    return { found: null, stopped: !allStill };
  }

  /** An axis is measured away from an end stop it starts near. @param {number|undefined} v */
  _dirFor(v) {
    return typeof v === 'number' && v > 1 - END_ROOM ? -1 : 1;
  }

  /** @param {Run} run */
  async _sequence(run) {
    const cur = this._o.current();
    /** @type {CalibrationResult} */
    const out = { ...cur };
    try {
      this._start = await this._race(run, this._position());
      this._check(run);
      if (this._start) this._log('info', `[tapo] calibration: the camera reports ${sig(this._start.x)}, ${sig(this._start.y)}; it goes back there at the end`);
      // a move just before the start (the user's) may still be on its way to the picture
      const idle = this._o.ptz.idleMs ? Number(this._o.ptz.idleMs()) : Infinity;
      if (idle < START_IDLE_MS) {
        this._log('info', `[tapo] calibration: the camera moved ${Math.round(idle)} ms ago; waiting for its picture`);
        await this._sleep(run, START_IDLE_MS - idle);
        this._after = this._clock();
      }
      // 1. pan
      const pan = await this._axis(run, 'x', 0.1, this._dirFor(this._start?.x));
      if (pan.k !== null) {
        // the camera turning right moves the scene left: a scene that moved right for +x means mirrored pan
        out.invertPan = pan.k > 0;
        out.viewUnitsX = clamp(1 / Math.abs(pan.k), 0.05, 4);
        // only a travel time the camera reported (MoveStatus) says anything about its speed; a
        // timed Stop's time is msPerUnit itself and would feed back into it on every calibration.
        // (msPerUnit is the motor's speed: not when the picture settled, which also holds the
        // video's lag, 1–2 s on a real camera and more with a stalled worker)
        if (pan.settledMs > 0) out.msPerUnit = Math.round(clamp(pan.settledMs / pan.travel, 500, 20000));
      } else if (pan.answer === 'left' || pan.answer === 'right') {
        // (a mirrored camera turns left for +x, right for −x)
        out.invertPan = pan.dir > 0 ? pan.answer === 'left' : pan.answer === 'right';
      } else {
        throw new Error('The camera did not turn. Check that privacy mode is off and pan/tilt works in the Tapo app.');
      }
      // 2. tilt
      const tilt = await this._axis(run, 'y', 0.45, this._dirFor(this._start?.y));
      if (tilt.k !== null) {
        // tilting up moves the scene down
        out.invertTilt = tilt.k < 0;
        out.viewUnitsY = clamp(1 / Math.abs(tilt.k), 0.05, 4);
      } else if (tilt.answer === 'up' || tilt.answer === 'down') {
        out.invertTilt = tilt.dir > 0 ? tilt.answer === 'down' : tilt.answer === 'up';
      } else {
        throw new Error('The camera did not tilt. Check that privacy mode is off and pan/tilt works in the Tapo app.');
      }
      // 3. the smallest pan step the firmware acts on (only when the picture can be measured)
      if (pan.k !== null) {
        this._set({ step: 'min-step', progress: 0.75 });
        const r = this._distrust ? this._stopProbe('the picture runs behind the camera') : await this._minStep(run, pan.dir, pan.k);
        if (r.found !== null) out.minStep = r.found;
        else if (!r.stopped) out.minStep = 0.1;
        this._minStepFound = r.found ?? (r.stopped ? null : 0.1);
      }
      this._check(run);
      const result = { ...out, calibratedAt: new Date(this._now()).toISOString() };
      this._o.save(result);
      this._log('info', `[tapo] calibration done: ${JSON.stringify(out)}`);
      await this._restore();
      this._run = null;
      this._set({ step: 'done', progress: 1, result: out });
    } catch (err) {
      const cancelled = err instanceof Cancelled || run.cancelled;
      await this._restore();
      this._run = null;
      if (cancelled) {
        this._log('info', '[tapo] calibration cancelled');
        this._set({ step: 'idle', progress: 0 });
      } else {
        this._log('warn', `[tapo] calibration failed: ${/** @type {Error} */ (err).message}`);
        this._set({ step: 'failed', progress: this._state.progress, error: /** @type {Error} */ (err).message });
      }
    }
    if (this._again) {
      this._again = false;
      this.start();
    }
  }

  /**
   * Stop, and put the camera back where it reported it was at the start (checked once more
   * after the move), or undo the moves not undone yet when it cannot report a position. Never
   * throws.
   */
  async _restore() {
    try {
      await this._o.ptz.stopAll('calibration ended');
      const net = this._net;
      this._net = { x: 0, y: 0 };
      for (let pass = 1; pass <= 2; pass++) {
        const p = this._start ? await this._position() : null;
        if (!p && pass > 1) return;
        // (+ 0: no −0 in a command)
        const back = p && this._start ? { x: this._start.x - p.x + 0, y: this._start.y - p.y + 0 } : { x: -net.x + 0, y: -net.y + 0 };
        if (Math.abs(back.x) <= RESTORE_EPS && Math.abs(back.y) <= RESTORE_EPS) return;
        this._log('info', `[tapo] calibration: turning the camera back by ${sig(back.x)}, ${sig(back.y)}`);
        for (const m of p && this._start ? this._steps(back, this._start) : [back]) await this._o.ptz.rawMove(m.x, m.y);
      }
    } catch (err) {
      this._log('warn', `[tapo] calibration: could not turn the camera back (${/** @type {Error} */ (err).message})`);
    }
  }

  /**
   * The moves that turn the camera by `v` to `target`: a correction smaller than the firmware's
   * smallest step would be ignored, so on such an axis it goes away from the end the target is
   * nearer to first, then on to the target (two moves of at least that step each).
   * @param {{ x: number, y: number }} v @param {{ x: number, y: number }} target
   */
  _steps(v, target) {
    const min = Math.max(0.05, this._o.current().minStep || 0, this._minStepFound || 0) * 1.25;
    const a = { x: v.x, y: v.y };
    const b = { x: 0, y: 0 };
    for (const k of /** @type {const} */ (['x', 'y'])) {
      if (Math.abs(v[k]) <= RESTORE_EPS || Math.abs(v[k]) >= min) continue;
      const s = Math.sign(target[k]) || 1;
      a[k] = -s * (v[k] * s >= 0 ? min : min + Math.abs(v[k]));
      b[k] = v[k] - a[k];
    }
    return b.x || b.y ? [a, b] : [a];
  }
}
