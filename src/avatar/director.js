// Director: turns high-level state + inputs into a smoothed AnimState every frame.
// PURE logic — no three.js, no DOM — so it is unit-testable and deterministic for a seed.

import { clamp, clamp01, expApproach, fbm1, lerp, mulberry32, noise1 } from './noise.js';

/** @typedef {'idle'|'listening'|'thinking'|'speaking'|'error'|'sleep'} AvatarState */

/**
 * Animation state consumed by heads, particles and post. All numbers, smoothed.
 * L / R are the VIEWER's (screen) left / right.
 * @typedef {Object} AnimState
 * @property {number} jawOpen    0..1
 * @property {number} mouthWide  0..1 (E / I / S visemes: corners spread)
 * @property {number} mouthRound 0..1 (O / U visemes: lips pucker)
 * @property {number} smile      0..1
 * @property {number} blinkL     0 open .. 1 closed
 * @property {number} blinkR     0 open .. 1 closed
 * @property {number} gazeX      -1 (screen left) .. 1 (screen right)
 * @property {number} gazeY      -1 (down) .. 1 (up)
 * @property {number} browUp     0..1
 * @property {number} headYaw    radians, + turns toward screen right
 * @property {number} headPitch  radians, + looks up
 * @property {number} headRoll   radians, + tilts counter-clockwise (as seen on screen)
 * @property {number} breath     0..1 breathing cycle
 * @property {number} speech     0..1 smoothed loudness
 * @property {number} energy     0..1 overall glow (0.5 = idle / reference look)
 * @property {number} listen     0..1 state weight
 * @property {number} think      0..1 state weight
 * @property {number} speak      0..1 state weight
 * @property {number} error      0..1 state weight
 * @property {number} sleep      0..1 state weight
 */

export const STATES = /** @type {const} */ (['idle', 'listening', 'thinking', 'speaking', 'error', 'sleep']);

/** Keys of AnimState in a stable order (handy for overrides / serialisation). */
export const ANIM_KEYS = /** @type {const} */ ([
  'jawOpen', 'mouthWide', 'mouthRound', 'smile', 'blinkL', 'blinkR', 'gazeX', 'gazeY', 'browUp',
  'headYaw', 'headPitch', 'headRoll', 'breath', 'speech', 'energy', 'listen', 'think', 'speak', 'error', 'sleep',
]);

/** @returns {AnimState} the rest pose */
export function createAnimState() {
  return {
    jawOpen: 0, mouthWide: 0, mouthRound: 0, smile: 0, blinkL: 0, blinkR: 0, gazeX: 0, gazeY: 0,
    browUp: 0, headYaw: 0, headPitch: 0, headRoll: 0, breath: 0, speech: 0, energy: 0.5,
    listen: 0, think: 0, speak: 0, error: 0, sleep: 0,
  };
}

// Blink envelope (seconds): fast close, short hold, slower open.
export const BLINK_CLOSE = 0.07;
export const BLINK_HOLD = 0.04;
export const BLINK_OPEN = 0.13;
export const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;

/** Lid closure (0..1) `t` seconds after a blink started. */
export function blinkCurve(t) {
  if (t < 0 || t >= BLINK_TOTAL) return 0;
  if (t < BLINK_CLOSE) {
    const u = t / BLINK_CLOSE;
    return u * u * (3 - 2 * u);
  }
  if (t < BLINK_CLOSE + BLINK_HOLD) return 1;
  const u = (t - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Asymmetric one-pole smoother for lip-sync: fast attack (opening), slower release (closing),
 * which keeps consonant closures visible while letting vowels blend (coarticulation-friendly).
 * @param {number} current @param {number} target @param {number} dt
 * @param {number} attackTau seconds @param {number} releaseTau seconds
 */
export function lipSmooth(current, target, dt, attackTau, releaseTau) {
  const tau = target > current ? attackTau : releaseTau;
  return current + (target - current) * expApproach(dt, tau);
}

const ENERGY = { idle: 0.5, listening: 0.78, thinking: 0.62, speaking: 0.55, error: 0.32, sleep: 0.14 };

export class Director {
  /**
   * @param {{ seed?: number, idleMotion?: number }} [opts]
   *   idleMotion scales idle head sway / saccades (0 disables them, e.g. for visual diffs).
   */
  constructor(opts = {}) {
    this.seed = (opts.seed ?? 1) | 0;
    this.idleMotion = opts.idleMotion ?? 1;
    this.rng = mulberry32(this.seed * 7919 + 17);
    /** @type {AvatarState} */
    this.current = 'idle';
    this.out = createAnimState();
    this._time = 0;
    this._started = false;
    // inputs
    this._mouth = { jaw: 0, wide: 0, round: 0, at: -Infinity };
    this._speechTarget = 0;
    this._expr = { smile: 0, browUp: 0 };
    this._look = /** @type {null | {x:number,y:number}} */ (null);
    // blink scheduler
    this._nextBlink = 0;
    this._blinkStart = -Infinity;
    this._pendingDouble = Infinity;
    this._blinkRequested = false;
    // gaze scheduler
    this._saccadeAt = 0;
    this._saccade = { x: 0, y: 0 };
    this._microAt = 0;
    this._micro = { x: 0, y: 0 };
    this._thinkSide = 1;
    this._thinkSwitchAt = 0;
    // smoothed internals
    this._gx = 0; this._gy = 0;
    this._yaw = 0; this._pitch = 0; this._roll = 0;
    this._breathPhase = 0;
    this._errorKick = -Infinity;
    this._w = { listening: 0, thinking: 0, speaking: 0, error: 0, sleep: 0 };
  }

  /** @param {AvatarState} s */
  setState(s) {
    if (!STATES.includes(s)) {
      console.warn(`[avatar] unknown state "${s}" ignored`);
      return;
    }
    if (s === 'error' && this.current !== 'error') this._errorKick = this._time;
    if (s === 'thinking' && this.current !== 'thinking') {
      this._thinkSide = this.rng() < 0.5 ? -1 : 1;
      this._thinkSwitchAt = this._time + 2.5 + this.rng() * 2;
    }
    this.current = s;
  }

  get state() { return this.current; }

  /** Lip-sync target (0..1 each). @param {{jaw?:number, wide?:number, round?:number}} m */
  setMouth(m) {
    this._mouth.jaw = clamp01(m?.jaw ?? 0);
    this._mouth.wide = clamp01(m?.wide ?? 0);
    this._mouth.round = clamp01(m?.round ?? 0);
    this._mouth.at = this._time;
  }

  /** @param {number} level 0..1 loudness envelope */
  setSpeechLevel(level) { this._speechTarget = clamp01(Number(level) || 0); }

  /** @param {{smile?:number, browUp?:number}} e */
  setExpression(e) {
    if (e?.smile !== undefined) this._expr.smile = clamp01(e.smile);
    if (e?.browUp !== undefined) this._expr.browUp = clamp01(e.browUp);
  }

  /** Trigger a blink as soon as possible. */
  blink() { this._blinkRequested = true; }

  /**
   * Cursor gaze target in canvas space, -1..1 (x right, y up). null releases (idle saccades).
   * @param {number|null} x @param {number} [y]
   */
  lookAt(x, y) {
    if (x === null || x === undefined) { this._look = null; return; }
    this._look = { x: clamp(Number(x) || 0, -1, 1), y: clamp(Number(y) || 0, -1, 1) };
  }

  /** @param {number} k */
  setIdleMotion(k) { this.idleMotion = Math.max(0, Number(k) || 0); }

  /**
   * Advance and return the (shared, mutated) AnimState.
   * @param {number} dt seconds since last update (clamped by the caller)
   * @param {number} time absolute seconds
   * @param {{settle?: boolean}} [opts] settle: jump to targets, no random events (fixed-time renders)
   * @returns {AnimState}
   */
  update(dt, time, opts = {}) {
    const settle = !!opts.settle;
    if (!this._started) {
      this._started = true;
      this._nextBlink = time + 1.2 + this.rng() * 2.5;
      this._saccadeAt = time + 0.8 + this.rng();
      this._microAt = time + 0.3;
    }
    this._time = time;
    dt = Math.max(0, dt);
    const k = (tau) => (settle ? 1 : expApproach(dt, tau));
    const o = this.out;
    const im = this.idleMotion;

    // ---- state weights ---------------------------------------------------------------------
    for (const s of /** @type {const} */ (['listening', 'thinking', 'speaking', 'error', 'sleep'])) {
      const target = this.current === s ? 1 : 0;
      const tau = s === 'sleep' ? 0.8 : s === 'error' ? 0.2 : 0.3;
      this._w[s] += (target - this._w[s]) * k(tau);
    }
    const w = this._w;
    o.listen = w.listening; o.think = w.thinking; o.speak = w.speaking; o.error = w.error; o.sleep = w.sleep;
    const idleW = clamp01(1 - (w.listening + w.thinking + w.speaking + w.error + w.sleep));

    // ---- speech ------------------------------------------------------------------------------
    o.speech = settle ? this._speechTarget : lipSmooth(o.speech, this._speechTarget, dt, 0.02, 0.12);

    // ---- mouth -------------------------------------------------------------------------------
    const age = time - this._mouth.at;
    let jawT = this._mouth.jaw, wideT = this._mouth.wide, roundT = this._mouth.round;
    if (!settle && age > 0.6) {
      // stale viseme target: relax (but keep speech-driven fallback below)
      const fade = clamp01((age - 0.6) / 0.25);
      jawT *= 1 - fade; wideT *= 1 - fade; roundT *= 1 - fade;
    }
    if (!settle && age > 0.3 && w.speaking > 0.1 && o.speech > 0.02) {
      // No visemes arriving (e.g. Web Speech fallback): derive a plausible jaw from loudness.
      const wobble = 0.75 + 0.25 * noise1(time * 9.0, this.seed + 5);
      jawT = Math.max(jawT, clamp01(o.speech * 0.75 * wobble) * w.speaking);
    }
    if (settle) {
      o.jawOpen = jawT; o.mouthWide = wideT; o.mouthRound = roundT;
    } else {
      o.jawOpen = lipSmooth(o.jawOpen, jawT, dt, 0.035, 0.085);
      o.mouthWide = lipSmooth(o.mouthWide, wideT, dt, 0.05, 0.1);
      o.mouthRound = lipSmooth(o.mouthRound, roundT, dt, 0.06, 0.11);
    }

    // ---- expression ----------------------------------------------------------------------------
    const smileT = clamp01(this._expr.smile + 0.08 * w.listening - 0.3 * w.error);
    const browT = clamp01(this._expr.browUp + 0.18 * w.listening + 0.1 * w.thinking + 0.25 * w.error
      - 0.2 * w.sleep);
    o.smile += (smileT * (1 - w.sleep) - o.smile) * k(0.25);
    o.browUp += (browT - o.browUp) * k(0.2);

    // ---- blinks ----------------------------------------------------------------------------------
    let blink = 0;
    if (!settle) {
      const busy = time - this._blinkStart < BLINK_TOTAL;
      if (!busy && (this._blinkRequested || time >= this._nextBlink || time >= this._pendingDouble)) {
        const wasDouble = time >= this._pendingDouble;
        this._blinkStart = time;
        this._blinkRequested = false;
        this._pendingDouble = Infinity;
        if (!wasDouble && this.rng() < 0.18) this._pendingDouble = time + BLINK_TOTAL + 0.06;
        const lo = w.listening > 0.5 ? 3.0 : w.thinking > 0.5 ? 1.8 : 2.0;
        const hi = w.listening > 0.5 ? 7.0 : w.thinking > 0.5 ? 5.0 : 6.0;
        this._nextBlink = time + lo + this.rng() * (hi - lo);
      }
      blink = blinkCurve(time - this._blinkStart);
    }
    const sleepClose = smooth01(w.sleep * 1.15);
    o.blinkL = Math.max(blink, sleepClose);
    // the second eye trails by a few milliseconds — subtle but alive
    o.blinkR = Math.max(settle ? 0 : blinkCurve(time - this._blinkStart - 0.008), sleepClose);

    // ---- gaze ----------------------------------------------------------------------------------
    let gxT = 0, gyT = 0;
    if (!settle) {
      if (time >= this._saccadeAt) {
        const r1 = this.rng(), r2 = this.rng();
        this._saccade.x = (r1 * 2 - 1) * 0.28 * im;
        this._saccade.y = (r2 * 2 - 1) * 0.16 * im;
        if (this.rng() < 0.35) { this._saccade.x *= 0.2; this._saccade.y *= 0.2; } // back to centre
        this._saccadeAt = time + 0.6 + this.rng() * 2.2;
      }
      if (time >= this._microAt) {
        this._micro.x = (this.rng() * 2 - 1) * 0.035;
        this._micro.y = (this.rng() * 2 - 1) * 0.025;
        this._microAt = time + 0.25 + this.rng() * 0.9;
      }
      if (w.thinking > 0.5 && time >= this._thinkSwitchAt) {
        this._thinkSide = -this._thinkSide;
        this._thinkSwitchAt = time + 2.5 + this.rng() * 2.0;
      }
    }
    if (this._look) {
      gxT = this._look.x * 0.85;
      gyT = this._look.y * 0.75;
    } else {
      gxT = this._saccade.x;
      gyT = this._saccade.y;
    }
    // thinking: glance up and aside
    gxT = lerp(gxT, this._thinkSide * 0.42, w.thinking * (this._look ? 0.6 : 1));
    gyT = lerp(gyT, 0.48, w.thinking * (this._look ? 0.6 : 1));
    // listening: attend to the user (centre), speaking: mostly at the user
    gxT = lerp(gxT, gxT * 0.4, w.listening * 0.6);
    gyT = lerp(gyT, gyT * 0.4, w.listening * 0.6);
    gxT = lerp(gxT, 0, w.sleep);
    gyT = lerp(gyT, -0.2, w.sleep);
    gxT += this._micro.x * (1 - w.sleep);
    gyT += this._micro.y * (1 - w.sleep);
    // saccades are fast (~40 ms)
    this._gx += (gxT - this._gx) * k(0.04);
    this._gy += (gyT - this._gy) * k(0.04);
    o.gazeX = clamp(this._gx, -1, 1);
    o.gazeY = clamp(this._gy, -1, 1);

    // ---- breathing -------------------------------------------------------------------------------
    const period = lerp(4.2, 6.5, w.sleep);
    if (settle) this._breathPhase = (time / 4.2) * Math.PI * 2;
    else this._breathPhase += (dt / period) * Math.PI * 2;
    o.breath = 0.5 - 0.5 * Math.cos(this._breathPhase);

    // ---- head --------------------------------------------------------------------------------------
    const s = this.seed;
    const sway = im * (1 - 0.6 * w.sleep);
    let yawT = 0.04 * fbm1(time * 0.13, s + 11) * sway + this._gx * 0.1;
    let pitchT = 0.028 * fbm1(time * 0.11, s + 23) * sway + this._gy * 0.06 + (o.breath - 0.5) * 0.006;
    let rollT = 0.022 * fbm1(time * 0.09, s + 37) * sway;
    pitchT += -0.035 * w.listening + 0.045 * w.thinking - 0.09 * w.sleep;
    rollT += 0.03 * w.listening + 0.035 * this._thinkSide * w.thinking + 0.04 * w.sleep;
    if (!settle) {
      const sp = o.speech * w.speaking;
      pitchT += sp * 0.03 * noise1(time * 3.1, s + 41);
      yawT += sp * 0.02 * noise1(time * 2.3, s + 43);
      const since = time - this._errorKick;
      if (since >= 0 && since < 0.6) yawT += 0.05 * Math.sin(since * 38) * (1 - since / 0.6);
    }
    const headTau = 0.35;
    this._yaw += (clamp(yawT, -0.35, 0.35) - this._yaw) * k(headTau);
    this._pitch += (clamp(pitchT, -0.25, 0.25) - this._pitch) * k(headTau);
    this._roll += (clamp(rollT, -0.2, 0.2) - this._roll) * k(headTau);
    o.headYaw = this._yaw; o.headPitch = this._pitch; o.headRoll = this._roll;

    // ---- energy --------------------------------------------------------------------------------------
    const thinkPulse = 0.12 * (0.5 + 0.5 * Math.sin(time * 2.4));
    const flicker = settle ? 0 : 0.18 * Math.max(0, noise1(time * 23, s + 51));
    const eT = idleW * ENERGY.idle + w.listening * ENERGY.listening
      + w.thinking * (ENERGY.thinking + thinkPulse) + w.speaking * (ENERGY.speaking + 0.45 * o.speech)
      + w.error * (ENERGY.error - flicker) + w.sleep * ENERGY.sleep;
    const norm = idleW + w.listening + w.thinking + w.speaking + w.error + w.sleep;
    o.energy += (clamp01(eT / Math.max(norm, 1e-6)) - o.energy) * k(0.12);
    return o;
  }
}

function smooth01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
