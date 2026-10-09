// Eye movements (pure): where the eyes look in the world, how they get there, and how much the
// head helps. Angles in degrees of eye rotation; the director converts to and from gaze units.
//
//   saccades   discrete shifts on a minimum-jerk profile along the main sequence (duration
//              21 + 2.2 A ms: 2 deg in 25 ms, 15 deg in 54 ms; the peak velocity in the middle),
//              after a reaction time for targets the avatar reacts to (cursor, face), at once for
//              its own (idle looks, thinking, glances)
//   fixation   between saccades the eyes hold still (no slow drifting toward a target)
//   pursuit    a moving target is followed smoothly (gain ~0.9, at most 30 deg/s, ~100 ms
//              latency), with catch-up saccades when it gets away (> 1.5 deg)
//   head       the head takes a share of large shifts (none below ~8 deg), starting ~30 ms after
//              the eyes and arriving later; over seconds it turns part of the way toward where
//              the eyes keep looking. The director counter-rotates the eyes against the head
//              (vestibulo-ocular reflex): the world gaze stays on the target while the head
//              moves, so eye + head never overshoot.

import { Spring, minJerk, minJerkVel } from './motion.js';

/** Degrees of eye rotation per gaze unit (relief iris travel: 0.6 / 0.24 iris radii). */
export const GAZE_DEG = Object.freeze({ x: 17.16, y: 6.78 });

/** Main-sequence saccade duration (s) for an amplitude in degrees. @param {number} a */
export const saccadeDuration = (a) => (21 + 2.2 * Math.abs(a)) / 1000;

/** Main-sequence peak velocity (deg/s) for an amplitude in degrees. @param {number} a */
export const saccadePeakVelocity = (a) => 500 * (1 - Math.exp(-Math.abs(a) / 14));

const smooth = (e0, e1, x) => {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
};

export const EYE_DEFAULTS = Object.freeze({
  /** reaction time to a target the avatar follows (cursor, face), s */
  latency: 0.17,
  /** a static target this far away (deg) gets a corrective saccade */
  fixTol: 0.4,
  /** a moving target this far away (deg) gets a catch-up saccade */
  pursuitTol: 1.5,
  /** below this target speed (deg/s) a target counts as still */
  moving: 0.3,
  pursuitGain: 0.9,
  pursuitMax: 30,
  /** smallest interval between two reactive saccades (s) */
  refractory: 0.12,
  /** pursuit starts only after the target has kept moving this long (s); a brief ramp or a
   * step gets a saccade instead */
  pursuitOnset: 0.12,
});

export class EyeController {
  /** @param {Partial<typeof EYE_DEFAULTS>} [o] */
  constructor(o = {}) {
    this.o = { ...EYE_DEFAULTS, ...o };
    /** world gaze (deg) and its velocity */
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    /** @type {null | { t0: number, D: number, x0: number, y0: number, x1: number, y1: number, amp: number }} */
    this.sac = null;
    this._errSince = NaN;
    this._lastSac = -Infinity;
    this._movingSince = NaN;
    /** the head's share of the gaze (deg): a spring toward a goal set by the saccades */
    this.hx = new Spring();
    this.hy = new Spring();
    this._hGoal = { x: 0, y: 0, at: -Infinity, omega: 2.5 };
    this._pendingHead = null;
    /** saccades started since the last take(): their amplitudes (deg), for gaze-evoked blinks */
    this.started = /** @type {number[]} */ ([]);
  }

  /** Jump to a gaze at rest (settled renders). @param {number} x @param {number} y */
  reset(x = 0, y = 0) {
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.sac = null;
    this._errSince = NaN;
    this._movingSince = NaN;
    this.hx.set(0); this.hy.set(0);
    this._hGoal = { x: 0, y: 0, at: -Infinity, omega: 2.5 };
    this._pendingHead = null;
  }

  get saccading() { return !!this.sac; }

  /**
   * Advance by dt to time t.
   * @param {number} dt @param {number} t
   * @param {{ x: number, y: number, vx?: number, vy?: number, reactive?: boolean, now?: boolean,
   *   headShare?: number }} tg  the target (deg, world); vx / vy its velocity as pursuit sees it
   *   (deg/s, ~100 ms late); reactive: the avatar is following something (a reaction time);
   *   now: the avatar's own target just moved (saccade at once, whatever the size)
   */
  update(dt, t, tg) {
    const o = this.o;
    dt = Math.max(0, dt);
    // ---- a saccade in flight is ballistic
    if (this.sac) {
      const s = this.sac;
      const u = (t - s.t0) / s.D;
      if (u >= 1) {
        this.x = s.x1; this.y = s.y1;
        this.vx = 0; this.vy = 0;
        this.sac = null;
      } else {
        const p = minJerk(u), dp = minJerkVel(u) / s.D;
        this.x = s.x0 + (s.x1 - s.x0) * p;
        this.y = s.y0 + (s.y1 - s.y0) * p;
        this.vx = (s.x1 - s.x0) * dp;
        this.vy = (s.y1 - s.y0) * dp;
      }
    }
    if (!this.sac) {
      const tvx = tg.vx || 0, tvy = tg.vy || 0;
      const fast = Math.hypot(tvx, tvy) > o.moving;
      if (!fast) this._movingSince = NaN;
      else if (!Number.isFinite(this._movingSince)) this._movingSince = t;
      const moving = fast && t - this._movingSince >= o.pursuitOnset;
      const ex = tg.x - this.x, ey = tg.y - this.y;
      const err = Math.hypot(ex, ey);
      const tol = tg.now ? 0.1 : moving ? o.pursuitTol : o.fixTol;
      if (err > tol) {
        if (tg.now) this._errSince = -Infinity;
        else if (!Number.isFinite(this._errSince)) this._errSince = t;
        const wait = tg.reactive ? o.latency : 0;
        if (t - this._errSince >= wait && (tg.now || t - this._lastSac >= o.refractory)) {
          // aim where a moving target will be when the eyes land
          const D0 = saccadeDuration(err);
          this._start(t, tg.x + tvx * D0, tg.y + tvy * D0, tg.headShare);
        }
      } else {
        this._errSince = NaN;
      }
      if (!this.sac) {
        // fixation: hold; pursuit: follow the target's velocity, correct the position gently
        let cx = 0, cy = 0;
        if (moving) {
          // (pursuit matches the target's speed; it corrects only small position errors, the
          // larger ones are the catch-up saccades' job)
          const cl = (v) => (v > 0.6 ? 0.6 : v < -0.6 ? -0.6 : v);
          cx = o.pursuitGain * tvx + 3 * cl(ex);
          cy = o.pursuitGain * tvy + 3 * cl(ey);
          const sp = Math.hypot(cx, cy);
          if (sp > o.pursuitMax) { cx *= o.pursuitMax / sp; cy *= o.pursuitMax / sp; }
        }
        // eye velocity is continuous: it approaches the command within ~50 ms
        const k = 1 - Math.exp(-dt / 0.05);
        this.vx += (cx - this.vx) * k;
        this.vy += (cy - this.vy) * k;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
      }
    }
    // ---- the head: starts ~30 ms after a saccade, faster for larger shifts; between them it
    // turns slowly part of the way toward where the eyes keep looking
    const ph = this._pendingHead;
    if (ph && t >= ph.at) {
      this._hGoal = { x: ph.x, y: ph.y, at: ph.at, omega: ph.omega };
      this._pendingHead = null;
    }
    const g = this._hGoal;
    const settle = 1 - Math.exp(-dt / 3);
    const fx = this.sac ? this.sac.x1 : this.x, fy = this.sac ? this.sac.y1 : this.y;
    const share = tg.headShare ?? 0.3;
    g.x += (share * fx - g.x) * settle;
    g.y += (0.5 * share * fy - g.y) * settle;
    const age = t - g.at;
    const omega = 2.5 + (g.omega - 2.5) * Math.exp(-Math.max(0, age) / 0.6);
    // (the fast goal relaxes toward the sustained share over a few seconds, above)
    this.hx.step(g.x, omega, dt);
    this.hy.step(g.y, omega, dt);
    return this;
  }

  /** @param {number} t @param {number} x1 @param {number} y1 @param {number} [share] */
  _start(t, x1, y1, share = 0.3) {
    const amp = Math.hypot(x1 - this.x, y1 - this.y);
    const D = saccadeDuration(amp);
    this.sac = { t0: t, D, x0: this.x, y0: this.y, x1, y1, amp };
    this._lastSac = t;
    this._errSince = NaN;
    this.started.push(amp);
    if (this.started.length > 8) this.started.shift();
    // large shifts: the head takes a share of the remaining way, quickly
    const big = smooth(8, 30, amp);
    if (big > 0) {
      const s = Math.max(share, 0.1 + 0.25 * big);
      this._pendingHead = {
        at: t + 0.03, x: this.hx.x + s * (x1 - this.hx.x), y: this.hy.x + 0.5 * s * (y1 - this.hy.x), omega: 4 + 8 * big,
      };
    }
  }

  /** Amplitudes (deg) of the saccades started since the last call. */
  take() {
    const s = this.started;
    this.started = [];
    return s;
  }
}
