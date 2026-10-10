// The simulated pan/tilt motor (contract §11.2). Pure state machine on an injected clock: the
// position is integrated lazily whenever someone looks (a request, a video frame, the control
// API), so it needs no timers and is exact at any polling rate.
//
// Units are ONVIF generic space, x/y in [-1, 1]. Pan moves at 0.35 units/s, tilt at 0.25.
// Per axis the motor is idle, driving to a target (RelativeMove / AbsoluteMove / GotoPreset; the
// requested speed is ignored, as on Tapo firmware) or running at a velocity (ContinuousMove,
// until its timeout or a Stop). Pushing against an end stop is counted in `endStopMs` (on a real
// camera that is the gearbox grinding), so tests can assert it never happens for long.

import { SIM_TRUTH } from './geometry.mjs';

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @typedef {{ pos: number, mode: 'idle'|'target'|'velocity', target: number, vel: number, until: number,
 *              speed: number, endStopMs: number, travelled: number }} Axis
 */

/** @param {number} pos @param {number} speed @returns {Axis} */
function axis(pos, speed) {
  return { pos, mode: 'idle', target: pos, vel: 0, until: Infinity, speed, endStopMs: 0, travelled: 0 };
}

/**
 * Advance one axis from t0 to t1 (ms).
 * @param {Axis} a @param {number} t0 @param {number} t1
 */
function step(a, t0, t1) {
  if (a.mode === 'idle' || t1 <= t0) return;
  if (a.mode === 'target') {
    const dist = a.target - a.pos;
    const max = (a.speed * (t1 - t0)) / 1000;
    if (Math.abs(dist) <= max) {
      a.travelled += Math.abs(dist);
      a.pos = a.target;
      a.mode = 'idle';
    } else {
      a.travelled += max;
      a.pos += Math.sign(dist) * max;
    }
    return;
  }
  // velocity
  const end = Math.min(t1, a.until);
  if (end > t0) {
    const want = a.pos + (a.vel * a.speed * (end - t0)) / 1000;
    const got = clamp(want, -1, 1);
    if (got !== want) {
      // reached the stop at some point in [t0, end]: the rest of the interval it pushes
      const reachMs = a.vel !== 0 ? (Math.abs(got - a.pos) / (Math.abs(a.vel) * a.speed)) * 1000 : 0;
      a.endStopMs += Math.max(0, end - t0 - reachMs);
    }
    a.travelled += Math.abs(got - a.pos);
    a.pos = got;
  }
  if (t1 >= a.until) {
    a.mode = 'idle';
    a.vel = 0;
    a.until = Infinity;
  }
}

export class PtzModel {
  /**
   * @param {{ now?: () => number, x?: number, y?: number, getQuirks?: () => Record<string, any> }} [o]
   */
  constructor(o = {}) {
    this._now = o.now || Date.now;
    this._quirks = o.getQuirks || (() => ({}));
    this.x = axis(o.x ?? 0, SIM_TRUTH.panUnitsPerSec);
    this.y = axis(o.y ?? 0, SIM_TRUTH.tiltUnitsPerSec);
    this._t = this._now();
    /** Count of commands per kind, for tests. @type {Record<string, number>} */
    this.counts = {};
  }

  /** Bring the position up to date. @returns {this} */
  advance() {
    const t = this._now();
    step(this.x, this._t, t);
    step(this.y, this._t, t);
    this._t = t;
    return this;
  }

  get position() {
    this.advance();
    return { x: round6(this.x.pos), y: round6(this.y.pos) };
  }

  get moving() {
    this.advance();
    return this.x.mode !== 'idle' || this.y.mode !== 'idle';
  }

  /** @param {string} kind */
  _count(kind) {
    this.counts[kind] = (this.counts[kind] || 0) + 1;
  }

  /**
   * RelativeMove. Translations below `minEffectiveStep` on an axis are acknowledged and ignored;
   * with `relativeActsContinuous` the move turns into an endless ContinuousMove (seen on a C260).
   * @param {number} dx @param {number} dy @returns {{ x: boolean, y: boolean }} which axes moved
   */
  relative(dx, dy) {
    this.advance();
    this._count('relative');
    const q = this._quirks();
    const min = Number(q.minEffectiveStep) || 0;
    const moved = { x: Math.abs(dx) >= min && dx !== 0, y: Math.abs(dy) >= min && dy !== 0 };
    if (q.relativeActsContinuous) {
      if (moved.x) this._velocity(this.x, Math.sign(dx) * clamp(Math.abs(dx) * 2, 0.2, 1), Infinity);
      if (moved.y) this._velocity(this.y, Math.sign(dy) * clamp(Math.abs(dy) * 2, 0.2, 1), Infinity);
      return moved;
    }
    if (moved.x) this._target(this.x, clamp(this.x.pos + dx, -1, 1));
    if (moved.y) this._target(this.y, clamp(this.y.pos + dy, -1, 1));
    return moved;
  }

  /** AbsoluteMove / GotoPreset / GotoHomePosition. @param {number} x @param {number} y */
  absolute(x, y) {
    this.advance();
    this._count('absolute');
    this._target(this.x, clamp(x, -1, 1));
    this._target(this.y, clamp(y, -1, 1));
  }

  /**
   * ContinuousMove. A zero velocity stops that axis (also when Stop is ignored on pan).
   * @param {number} vx @param {number} vy @param {number} [timeoutMs] Infinity = until Stop
   */
  continuous(vx, vy, timeoutMs = Infinity) {
    this.advance();
    this._count('continuous');
    const until = Number.isFinite(timeoutMs) ? this._t + timeoutMs : Infinity;
    this._velocity(this.x, clamp(vx, -1, 1), until);
    this._velocity(this.y, clamp(vy, -1, 1), until);
  }

  /**
   * Stop. With `stopIgnoredOnPan` the pan axis keeps going (C520WS firmware report); only a
   * zero-velocity ContinuousMove stops it then.
   * @param {{ panTilt?: boolean }} [o]
   */
  stop(o = {}) {
    this.advance();
    this._count('stop');
    if (o.panTilt === false) return;
    const q = this._quirks();
    if (!q.stopIgnoredOnPan) this._idle(this.x);
    this._idle(this.y);
  }

  /** Reboot / reset: motion stops where it is. */
  halt() {
    this.advance();
    this._idle(this.x);
    this._idle(this.y);
  }

  /** @param {number} x @param {number} y */
  place(x, y) {
    this.advance();
    this.halt();
    this.x.pos = clamp(x, -1, 1);
    this.y.pos = clamp(y, -1, 1);
  }

  /** Total time a motor pushed against an end stop (ms). */
  get endStopMs() {
    this.advance();
    return Math.round(this.x.endStopMs + this.y.endStopMs);
  }

  /** Snapshot for GET /state. */
  snapshot() {
    this.advance();
    return {
      ...this.position,
      moving: this.x.mode !== 'idle' || this.y.mode !== 'idle',
      pan: this.x.mode,
      tilt: this.y.mode,
      endStopMs: this.endStopMs,
      travelled: { x: round6(this.x.travelled), y: round6(this.y.travelled) },
      counts: { ...this.counts },
    };
  }

  /** @param {Axis} a @param {number} target */
  _target(a, target) {
    a.mode = target === a.pos ? 'idle' : 'target';
    a.target = target;
    a.vel = 0;
    a.until = Infinity;
  }

  /** @param {Axis} a @param {number} vel @param {number} until */
  _velocity(a, vel, until) {
    if (vel === 0) {
      this._idle(a);
      return;
    }
    a.mode = 'velocity';
    a.vel = vel;
    a.until = until;
  }

  /** @param {Axis} a */
  _idle(a) {
    a.mode = 'idle';
    a.vel = 0;
    a.target = a.pos;
    a.until = Infinity;
  }
}

/** @param {number} v */
function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}
