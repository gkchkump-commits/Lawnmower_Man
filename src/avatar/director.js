// Director: turns high-level state + inputs into a smoothed AnimState every frame.
// PURE logic — no three.js, no DOM — so it is unit-testable and deterministic for a seed.
//
// Motion model (docs/RENDERER.md, "Motion"): every channel is second order — a critically damped
// spring per channel (src/avatar/motion.js) or a minimum-jerk kernel — so velocities are
// continuous (no one-frame "ticks") and 60 / 144 Hz displays show the same motion. The eyes make
// main-sequence saccades, fixate, pursue moving targets and counter-rotate against the head
// (src/avatar/eyes.js); the head follows large gaze shifts late and slowly. Idle life is 1/f-like
// noise that never repeats; blinks have an asymmetric lid profile and log-normal intervals.
// Settled renders (fixed time, visual diffs) keep the original closed-form rest pose exactly.

import { clamp, clamp01, fbm1, lerp, mulberry32, noise1 } from './noise.js';
import { EyeController, GAZE_DEG } from './eyes.js';
import { Spring, envelope, logNormal, minJerk, pinkNoise, pulse, springStep } from './motion.js';

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
 * @property {number} gazeX      -1 (screen left) .. 1 (screen right), eye in head
 * @property {number} gazeY      -1 (down) .. 1 (up), eye in head
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
 * @property {number} mouthPress  0..1 lips pressed / rolled in (m b p)
 * @property {number} mouthTuck   0..1 lower lip under the upper teeth (f v)
 * @property {number} mouthTeeth  0..1 upper lip raised, teeth show (s z, ee)
 * @property {number} mouthTongue 0..1 tongue tip at the teeth (th, l)
 * @property {number} mouthAsym   -1..1 left/right asymmetry of the lips (+ = screen-left corner higher)
 * @property {number} cheekRaise  0..1 cheeks and nasolabial folds lift (spread vowels, smiles)
 * @property {number} chinRaise   0..1 the chin (mentalis) bunches up under pressed lips
 * @property {number} nostrilFlare 0..1 the nostrils widen (a breath in before speaking)
 */

export const STATES = /** @type {const} */ (['idle', 'listening', 'thinking', 'speaking', 'error', 'sleep']);

/** Keys of AnimState in a stable order (handy for overrides / serialisation). */
export const ANIM_KEYS = /** @type {const} */ ([
  'jawOpen', 'mouthWide', 'mouthRound', 'smile', 'blinkL', 'blinkR', 'gazeX', 'gazeY', 'browUp',
  'headYaw', 'headPitch', 'headRoll', 'breath', 'speech', 'energy', 'listen', 'think', 'speak', 'error', 'sleep',
  'mouthPress', 'mouthTuck', 'mouthTeeth', 'mouthTongue', 'mouthAsym', 'cheekRaise', 'chinRaise', 'nostrilFlare',
]);

/** @returns {AnimState} the rest pose */
export function createAnimState() {
  return {
    jawOpen: 0, mouthWide: 0, mouthRound: 0, smile: 0, blinkL: 0, blinkR: 0, gazeX: 0, gazeY: 0,
    browUp: 0, headYaw: 0, headPitch: 0, headRoll: 0, breath: 0, speech: 0, energy: 0.5,
    listen: 0, think: 0, speak: 0, error: 0, sleep: 0,
    mouthPress: 0, mouthTuck: 0, mouthTeeth: 0, mouthTongue: 0, mouthAsym: 0,
    cheekRaise: 0, chinRaise: 0, nostrilFlare: 0,
  };
}

/** Expressiveness range (avatar.expressiveness): 0 = a still face, 1 = default, 2 = animated. */
export const EXPRESSIVENESS_MAX = 2;

const DEG = 180 / Math.PI;

/**
 * Mouth channel springs: [opening, closing] natural frequency (rad/s; t90 = 3.89 / omega). The
 * lip-sync output is already coarticulated, so these only add the inertia of real tissue: lips
 * press and tuck fast (t90 35-45 ms), rounding is slower; the jaw opens in ~70 ms and closes a
 * bit slower, a little faster into a closure (m b p, f v). The lips seal a closure on their own
 * (the rigs bring the lower lip up over a jaw still on its way), so the heavier jaw follows them
 * as it does in speech, without snapping shut within a frame.
 */
export const MOUTH_OMEGA = Object.freeze({
  jaw: [55, 38], wide: [42, 28], round: [33, 24], press: [110, 55], tuck: [90, 50], teeth: [50, 33], tongue: [55, 33],
});
/** The jaw's closing spring into a closure (t90 78 ms; the lips have sealed by then). */
const JAW_INTO_CLOSURE = 50;
const MOUTH_IN = /** @type {const} */ (['jaw', 'wide', 'round', 'press', 'tuck', 'teeth', 'tongue']);
const MOUTH_OUT = /** @type {const} */ ({
  jaw: 'jawOpen', wide: 'mouthWide', round: 'mouthRound', press: 'mouthPress', tuck: 'mouthTuck',
  teeth: 'mouthTeeth', tongue: 'mouthTongue',
});

/**
 * Speech prosody cue (from the lip-sync: src/audio/prosody.js for the local voice's audio,
 * src/audio/articulation.js for a planned utterance):
 *   accent      a stressed syllable starts (a small nod; strength 0..1)
 *   emphasis    an emphasised word (brow raise + a firmer nod)
 *   phrase-start / phrase-end  (punct: , ; . ! ? — ; friendly 0..1 at a sentence end; from the
 *               audio also fall / rise: the final pitch movement in semitones, and pause: the
 *               silence that follows, s)
 *   inhale      a breath before speaking on (nostrils, a slight lift, lips part); lead: the time
 *               until the voice starts (s), the breath is in by then
 * @typedef {{ type: 'accent'|'emphasis'|'phrase-start'|'phrase-end'|'inhale', strength?: number, punct?: string,
 *   friendly?: number, fall?: number, rise?: number, pause?: number, lead?: number }} ProsodyCue
 */

// Blink lid profile (seconds): the lid accelerates down (peak speed late in the close), touches
// briefly, and opens about 2.5x slower with a long, easing tail.
export const BLINK_CLOSE = 0.07;
export const BLINK_HOLD = 0.012;
export const BLINK_OPEN = 0.18;
export const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;

/** Lid closing 0 -> 1, velocity ~ u^2 (1 - u): zero at both ends, peak at 2/3. @param {number} u */
const lidClose = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (4 - 3 * u));
/** Lid opening 1 -> 0, velocity ~ u (1 - u)^3: a quick start and a long tail. @param {number} u */
const lidOpen = (u) => (u <= 0 ? 1 : u >= 1 ? 0 : 1 - u * u * (10 - u * (20 - u * (15 - 4 * u))));

/**
 * Lid closure (0..1) `t` seconds after a blink started.
 * @param {number} t @param {{ close?: number, hold?: number, open?: number }} [p] phase durations
 */
export function blinkCurve(t, p = {}) {
  const c = p.close ?? BLINK_CLOSE, h = p.hold ?? BLINK_HOLD, o = p.open ?? BLINK_OPEN;
  if (t < 0 || t >= c + h + o) return 0;
  if (t < c) return lidClose(t / c);
  if (t < c + h) return 1;
  return lidOpen((t - c - h) / o);
}

/**
 * Asymmetric one-pole smoother (kept for callers that want a cheap first-order lag; the director
 * itself uses springs): fast attack, slower release.
 * @param {number} current @param {number} target @param {number} dt
 * @param {number} attackTau seconds @param {number} releaseTau seconds
 */
export function lipSmooth(current, target, dt, attackTau, releaseTau) {
  const tau = target > current ? attackTau : releaseTau;
  return current + (target - current) * (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
}

/** World gaze (gaze units) of an AnimState: the eyes in the head plus the head's turn. @param {AnimState} a */
export function worldGaze(a) {
  return { x: a.gazeX + (a.headYaw * DEG) / GAZE_DEG.x, y: a.gazeY + (a.headPitch * DEG) / GAZE_DEG.y };
}

const ENERGY = { idle: 0.5, listening: 0.78, thinking: 0.62, speaking: 0.55, error: 0.32, sleep: 0.14 };
/** lookAt(x, y) at +-1 (the stage's edges): this many degrees of world gaze */
const LOOK_DEG = { x: 0.85 * GAZE_DEG.x, y: 8 };
/** The head's share of a target the avatar follows (lookAt: cursor, camera face). */
const HEAD_SHARE_FOLLOW = 0.38;
/** Settled renders keep the original gaze units (6.78 deg vertically per unit, before the relief's
 * vertical iris range was widened): the same on-screen pose. */
const SETTLED_GY = 6.78 / GAZE_DEG.y;
const WEIGHTED = /** @type {const} */ (['listening', 'thinking', 'speaking', 'error', 'sleep']);
const WEIGHT_OMEGA = { listening: 8, thinking: 8, speaking: 8, error: 14, sleep: 3.2 };
/** Blink interval medians (s) by state (log-normal, sigma 0.6, 0.8 s refractory). */
const BLINK_MEDIAN = { idle: 2.8, listening: 4.0, thinking: 2.4, speaking: 2.3, error: 2.6, sleep: 3 };
/** Idle sway (rad, rms: pinkNoise has unit rms): 1/f-like noise from 0.1 Hz (yaw, pitch) and
 * 0.09 Hz (roll) up, 1 deg yaw, 0.45 pitch, 0.26 roll (over 2 min: ~0.8 / 0.45 / 0.25 deg rms,
 * 0.5 deg/s mean yaw speed), and a faint fast tremor (0.07 deg). */
const SWAY = { yaw: 1.0 / DEG, pitch: 0.45 / DEG, roll: 0.26 / DEG, fast: 0.07 / DEG };

/** Probabilistic OR of 0..1 values (smooth where max() would kink). */
const softOr = (a, b) => 1 - (1 - a) * (1 - b);

export class Director {
  /**
   * @param {{ seed?: number, idleMotion?: number, expressiveness?: number }} [opts]
   *   idleMotion scales idle head sway / saccades (0 disables them, e.g. for visual diffs);
   *   expressiveness (0..2, default 1) scales the motion that comes with speech: nods, tilts,
   *   brows, glances, smiles, and the face moving with the mouth.
   */
  constructor(opts = {}) {
    this.seed = (opts.seed ?? 1) | 0;
    this.idleMotion = opts.idleMotion ?? 1;
    this.expressiveness = 1;
    this.setExpressiveness(opts.expressiveness ?? 1);
    // intonation of the voice (semitones re the speaker's usual pitch)
    this._into = { pitch: 0, voiced: false };
    // conversational gaze: a glance away from the listener as a phrase starts, back by its end
    this._glance = { x: 0, y: 0, until: -Infinity };
    this.rng = mulberry32(this.seed * 7919 + 17);
    /** @type {AvatarState} */
    this.current = 'idle';
    this.out = createAnimState();
    this._time = 0;
    this._started = false;
    // inputs
    this._mouth = { jaw: 0, wide: 0, round: 0, press: 0, tuck: 0, teeth: 0, tongue: 0, at: -Infinity };
    this._speechTarget = 0;
    // speech prosody (secondary motion): active impulses { at, kind, amp, ... }
    /** @type {Array<{ at: number, kind: string, amp: number, dir?: number, dur?: number, k?: number, yaw?: number, roll?: number, size?: number, extra?: boolean }>} */
    this._kicks = [];
    this._lastAccent = -Infinity;
    this._lastCue = -Infinity;
    this._blinkDeferred = false;
    this._phraseYaw = 0;
    // prosody and asymmetry draw from their own generator, so the idle blinks / saccades of a
    // seed stay what they were
    this.rng2 = mulberry32(this.seed * 104729 + 3);
    // and the newer motion details (blink shapes, micro-saccades, breathing, thinking) from a third
    this.rng3 = mulberry32(this.seed * 15485863 + 11);
    // a speaker's lips are a little lopsided, always to the same side
    this._asymBias = (this.rng2() < 0.5 ? -1 : 1) * (0.35 + 0.3 * this.rng2());
    this._expr = { smile: 0, browUp: 0 };
    /** @type {null | {x:number,y:number}} the lookAt target (gaze units) */
    this._look = null;
    /** @type {'cursor'|'face'|'glance'} what lookAt is on */
    this._lookKind = 'cursor';
    // blink scheduler
    this._nextBlink = 0;
    this._blinkStart = -Infinity;
    this._blink = { amp: 1, close: BLINK_CLOSE, hold: BLINK_HOLD, open: BLINK_OPEN, total: BLINK_TOTAL };
    this._pendingDouble = Infinity;
    this._blinkRequested = false;
    // gaze scheduler (self-generated targets, gaze units)
    this._saccadeAt = 0;
    this._saccade = { x: 0, y: 0 };
    this._microAt = 0;
    this._micro = { x: 0, y: 0 };
    this._thinkSide = 1;
    this._thinkSwitchAt = 0;
    this._think = { mode: 'up', microAt: 0, mx: 0, my: 0 };
    // the gaze follows a state change after a short, natural delay
    this._gazeState = /** @type {AvatarState} */ ('idle');
    this._gazeNext = /** @type {AvatarState|null} */ (null);
    this._gazeNextAt = Infinity;
    this._gazeT = NaN;
    this._selfJump = false;
    this._glanceOn = false;
    // the lookAt target, reconstructed between its updates (no 12 / 30 Hz staircase) and a short
    // history of it for pursuit's ~100 ms latency
    /** @type {null | { x0: number, y0: number, x1: number, y1: number, t0: number, dur: number }} */
    this._lookSeg = null;
    this._lookLastT = -Infinity;
    this._lookHist = { t: new Float64Array(96), x: new Float64Array(96), y: new Float64Array(96), n: 0, i: 0 };
    this._tg = { x: 0, y: 0, vx: 0, vy: 0, reactive: false, now: false, headShare: 0.3, headFollow: false };
    this.eyes = new EyeController();
    // springs
    /** @type {Record<string, Spring>} */
    this._sw = Object.fromEntries(WEIGHTED.map((s) => [s, new Spring()]));
    /** @type {Record<string, Spring>} */
    this._sm = Object.fromEntries(MOUTH_IN.map((c) => [c, new Spring()]));
    this._s = {
      speech: new Spring(), smile: new Spring(), brow: new Spring(), cheek: new Spring(), chin: new Spring(),
      nostril: new Spring(), energy: new Spring(0.5), pitchS: new Spring(), phraseYaw: new Spring(),
      speechBreath: new Spring(), yaw: new Spring(), pitch: new Spring(), roll: new Spring(),
      thinkSide: new Spring(1), thinkPitch: new Spring(0.045),
    };
    // breathing (live): phase, a sigh now and then
    this._breathPhase = 0;
    this._sighAt = -Infinity;
    this._nextSigh = Infinity;
    this._errorKick = -Infinity;
    this._w = { listening: 0, thinking: 0, speaking: 0, error: 0, sleep: 0 };
    // settled-render internals (the original closed-form pose)
    this._gx = 0; this._gy = 0;
    this._yaw = 0; this._pitch = 0; this._roll = 0;
    this._phraseYawS = 0;
    this._pitchS = 0;
    this._speechBreath = 0;
    this._settledLast = false;
  }

  /** @param {AvatarState} s */
  setState(s) {
    if (!STATES.includes(s)) {
      console.warn(`[avatar] unknown state "${s}" ignored`);
      return;
    }
    const t = this._time;
    if (s === 'error' && this.current !== 'error') this._errorKick = t;
    if (s === 'thinking' && this.current !== 'thinking') {
      // one look-away direction per thinking episode (up and aside, sometimes down and aside),
      // held; it switches side rarely (exponential intervals, mean 11 s, never on a clock)
      this._thinkSide = this.rng() < 0.5 ? -1 : 1;
      this._thinkSwitchAt = t + Math.max(5, -11 * Math.log(Math.max(1e-6, this.rng3())));
      this._think.mode = this.rng3() < 0.85 ? 'up' : 'down';
      this._think.microAt = t + 0.6 + 1.2 * this.rng3();
      this._think.mx = 0; this._think.my = 0;
    }
    if (s !== this.current) {
      // the eyes follow a state change ~100-300 ms later, with a saccade
      this._gazeNext = s;
      const d = s === 'thinking' ? 0.15 + 0.2 * this.rng3() : s === 'sleep' ? 0.4 : 0.1 + 0.15 * this.rng3();
      this._gazeNextAt = t + d;
    }
    this.current = s;
  }

  get state() { return this.current; }

  /**
   * Lip-sync target (0..1 each; a missing field means 0).
   * @param {{jaw?:number, wide?:number, round?:number, press?:number, tuck?:number, teeth?:number, tongue?:number}} m
   */
  setMouth(m) {
    for (const k of MOUTH_IN) this._mouth[k] = clamp01(Number(m?.[k]) || 0);
    this._mouth.at = this._time;
  }

  /**
   * Speech prosody cue(s) from the lip-sync: subtle head nods on stressed syllables and phrase
   * starts, a brow raise on emphasis and questions, blinks at phrase ends (not mid-word) and a
   * micro-smile after a friendly sentence (the lip-sync sends cues only while speech plays;
   * fixed-time renders ignore them). Every kernel starts and ends at rest (minimum jerk).
   * @param {ProsodyCue|ProsodyCue[]|null} cue
   */
  setProsody(cue) {
    if (!cue) return;
    if (Array.isArray(cue)) { for (const c of cue) this.setProsody(c); return; }
    const t = this._time;
    const s = clamp01(Number(cue.strength ?? 1));
    // no two nods alike: each impulse varies a little in size and length, and turns a little
    const vary = () => 0.8 + 0.4 * this.rng2();
    this._lastCue = t;
    switch (cue.type) {
      case 'accent':
        if (t - this._lastAccent < 0.2) return;           // one nod per syllable at most
        this._lastAccent = t;
        this._nod(t, (0.5 + 0.5 * s) * vary());
        break;
      case 'emphasis':
        this._kick({ at: t, kind: 'brow', amp: 0.6 * s });
        this._nod(t, 0.8 * s * vary());
        break;
      case 'phrase-start':
        this._kick({ at: t, kind: 'lift', amp: s * vary(), k: vary() });
        // each phrase is said from a slightly different head angle
        this._phraseYaw = (this.rng2() * 2 - 1) * 0.022 * s;
        // a speaker often looks away as a phrase starts (planning it) and back to the listener
        // as it ends; the glance is an offset on top of lookAt (cursor / camera eye contact)
        if (s >= 0.7 && this.rng2() < 0.5) {
          const side = this.rng2() < 0.5 ? -1 : 1;
          this._glance = {
            x: side * (0.16 + 0.14 * this.rng2()), y: (this.rng2() < 0.6 ? -1 : 1) * (0.04 + 0.08 * this.rng2()),
            until: t + 0.35 + 0.55 * this.rng2(),
          };
        }
        this._lastPhraseStart = t;
        break;
      case 'phrase-end': {
        const p = cue.punct || '.';
        const rise = Number(cue.rise) || 0, fall = Number(cue.fall) || 0;
        if (p === '?' || rise >= 3) {
          // a question (or a rising, asking end): brows up, the head tilts
          const q = p === '?' ? Math.max(0.7, clamp01(rise / 4)) : 0.5 * clamp01(rise / 5);
          this._kick({ at: t, kind: 'brow', amp: 0.9 * q });
          this._kick({ at: t, kind: 'tilt', amp: q, dir: this.rng2() < 0.5 ? -1 : 1 });
        } else if (p === '!') {
          this._kick({ at: t, kind: 'brow', amp: 0.45 });
          this._nod(t, 0.8);
        }
        // final lowering: a falling end settles the head a little, held through the pause
        if (fall > 1 && p !== '?') this._kick({ at: t, kind: 'lower', amp: clamp01((fall - 1) / 4) * (/[.!]/.test(p) ? 1 : 0.6) });
        if (Number(cue.friendly) > 0) this._kick({ at: t + 0.05, kind: 'smile', amp: clamp01(Number(cue.friendly)) });
        // eye contact again at the end of the phrase
        if (this._glance.until > t) this._glance.until = t;
        // blink at the phrase boundary: a deferred blink now, otherwise often (more at real pauses)
        const sinceBlink = t - this._blinkStart;
        const pause = Number.isFinite(cue.pause) ? cue.pause : 1;
        const pr = /[.!?]/.test(p) ? 0.75 : 0.4;
        if (this._blinkDeferred || (sinceBlink > 1.0 && this.rng2() < (pause >= 0.25 ? Math.max(pr, 0.6) : pr))) {
          this._blinkRequested = true;
          this._blinkDeferred = false;
        }
        break;
      }
      case 'inhale':
        // one breath per pause
        if (this._kicks.some((q) => q.kind === 'inhale' && t - q.at < 0.6)) return;
        // the breath is in by the time the voice starts (a quick one before a clip's first words)
        this._kick({ at: t, kind: 'inhale', amp: s, dur: clamp(Number(cue.lead ?? 0.2) - 0.02, 0.06, 0.2) });
        break;
      default:
    }
  }

  /**
   * A nod; one started moments ago (an accent and an emphasis together) takes the larger size
   * instead of adding up. A nod already under way grows by a second pulse from now (raising its
   * amplitude mid-pulse would step its velocity). @param {number} t @param {number} amp
   */
  _nod(t, amp) {
    const prev = this._kicks.find((q) => q.kind === 'nod' && !q.extra && t - q.at < 0.12);
    if (prev) {
      const had = prev.size ?? prev.amp;
      if (amp <= had) return;
      prev.size = amp;
      if (t - prev.at < 1e-6) prev.amp += amp - had;   // (the same frame: it has not moved yet)
      else this._kick({ at: t, kind: 'nod', amp: amp - had, k: prev.k, yaw: prev.yaw, roll: prev.roll, extra: true });
      return;
    }
    const r = this.rng2;
    this._kick({ at: t, kind: 'nod', amp, k: 0.88 + 0.3 * r(), yaw: (r() * 2 - 1) * 0.3, roll: (r() * 2 - 1) * 0.25 });
  }

  /**
   * Intonation of the voice being spoken (the lip-sync's analysis of the local voice): pitch in
   * semitones above (+) / below the speaker's usual pitch. Higher pitch lifts the head a little and,
   * well above the usual, the brows; it is 0 between phrases.
   * @param {{ pitch?: number, voiced?: boolean }|null} v
   */
  setIntonation(v) {
    const p = Number(v?.pitch);
    this._into.pitch = Number.isFinite(p) ? clamp(p, -12, 12) : 0;
    this._into.voiced = !!v?.voiced;
  }

  /** @param {number} k 0..2: how much the speech moves the head, brows and face (1 = default) */
  setExpressiveness(k) {
    const n = Number(k);
    this.expressiveness = Number.isFinite(n) ? clamp(n, 0, EXPRESSIVENESS_MAX) : 1;
  }

  /** @param {{ at: number, kind: string, amp: number, dir?: number, dur?: number, k?: number, yaw?: number, roll?: number, size?: number, extra?: boolean }} k */
  _kick(k) {
    this._kicks.push(k);
    if (this._kicks.length > 24) this._kicks.shift();
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
   * Updates may come at any rate (12 Hz camera, 30 Hz cursor): the eyes see a target that moves
   * continuously between them. `kind`: what is looked at ('cursor', the default; 'face': eye
   * contact; 'glance': a look away from the user's face). The head goes along with a cursor or a
   * face; a glance away is the eyes' (the head turns only a little, as with the avatar's own looks).
   * @param {number|null} x @param {number} [y] @param {'cursor'|'face'|'glance'} [kind]
   */
  lookAt(x, y, kind) {
    this._lookKind = kind === 'glance' ? 'glance' : kind === 'face' ? 'face' : 'cursor';
    if (x === null || x === undefined) {
      if (this._look) this._selfJump = true;
      this._look = null;
      this._lookSeg = null;
      return;
    }
    const nx = clamp(Number(x) || 0, -1, 1), ny = clamp(Number(y) || 0, -1, 1);
    if (this._look && this._look.x === nx && this._look.y === ny) return;
    this._look = { x: nx, y: ny };
    // world target (deg) of this sample: interpolate to it over the time since the last one, or
    // jump when it moved far (the saccade does that)
    const t = this._time;
    const X = nx * LOOK_DEG.x, Y = ny * LOOK_DEG.y;
    const cur = this._lookSeg ? this._lookAtT(t) : null;
    const far = !cur || Math.hypot(X - cur.x, Y - cur.y) > 1.2;
    const dur = far ? 0 : clamp(t - this._lookLastT, 0, 0.12);
    this._lookSeg = { x0: cur ? cur.x : X, y0: cur ? cur.y : Y, x1: X, y1: Y, t0: t, dur };
    // a jump is no motion to pursue: pursuit's velocity history starts over
    if (far) this._lookHist.n = 0;
    this._lookLastT = t;
  }

  /** The reconstructed lookAt target (deg) at time t. @param {number} t */
  _lookAtT(t) {
    const s = this._lookSeg;
    if (!s) return { x: 0, y: 0 };
    const u = s.dur > 0 ? clamp((t - s.t0) / s.dur, 0, 1) : 1;
    return { x: s.x0 + (s.x1 - s.x0) * u, y: s.y0 + (s.y1 - s.y0) * u };
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
    if (!this._started) {
      this._started = true;
      this._nextBlink = time + 1.2 + this.rng() * 2.5;
      this._saccadeAt = time + 0.8 + this.rng();
      this._microAt = time + 0.3;
      this._nextSigh = time + 30 + 60 * this.rng3();
    }
    this._time = time;
    dt = Math.max(0, dt);
    if (opts.settle) {
      this._updateSettled(time);
      this._settledLast = true;
      return this.out;
    }
    if (this._settledLast) this._syncFromSettled();
    this._settledLast = false;
    const o = this.out;
    const im = this.idleMotion;
    const ex = this.expressiveness;
    const sp = (/** @type {Spring} */ s, /** @type {number} */ target, /** @type {number} */ omega) => s.step(target, omega, dt);

    // ---- state weights (springs: posture and glow start and end with zero velocity) -------------
    const w = this._w;
    for (const s of WEIGHTED) w[s] = clamp01(sp(this._sw[s], this.current === s ? 1 : 0, WEIGHT_OMEGA[s]));
    o.listen = w.listening; o.think = w.thinking; o.speak = w.speaking; o.error = w.error; o.sleep = w.sleep;
    const idleW = clamp01(1 - (w.listening + w.thinking + w.speaking + w.error + w.sleep));

    // ---- speech loudness ---------------------------------------------------------------------
    const sS = this._s.speech;
    o.speech = clamp01(sp(sS, this._speechTarget, this._speechTarget > sS.x ? 60 : 16));

    // ---- speech prosody: nods, phrase lifts, question tilts, brows, micro-smiles, breaths --------
    let nod = 0, nodYaw = 0, nodRoll = 0, lift = 0, tilt = 0, browK = 0, smileK = 0, lower = 0, inhale = 0, inhaleHead = 0;
    if (this._kicks.length) {
      this._kicks = this._kicks.filter((q) => time - q.at < 3);
      for (const q of this._kicks) {
        const x = time - q.at;
        const k = q.k ?? 1;
        if (q.kind === 'nod') {
          // down in ~170 ms, back in ~310 ms (each nod 0.88-1.18 x as long)
          const v = q.amp * pulse(x, 0.17 * k, 0.31 * k);
          nod += v; nodYaw += v * (q.yaw ?? 0); nodRoll += v * (q.roll ?? 0);
        } else if (q.kind === 'lift') lift += q.amp * pulse(x, 0.2 * k, 0.36 * k);
        else if (q.kind === 'tilt') tilt += q.amp * (q.dir || 1) * envelope(x, 0.25, 0.45, 0.6);
        else if (q.kind === 'brow') browK = softOr(browK, q.amp * envelope(x, 0.12, 0.3, 0.45));
        else if (q.kind === 'smile') smileK = softOr(smileK, q.amp * envelope(x, 0.3, 0.7, 1.2));
        else if (q.kind === 'lower') lower = softOr(lower, q.amp * envelope(x, 0.28, 0.45, 0.7));
        else if (q.kind === 'inhale') {
          inhale = softOr(inhale, q.amp * envelope(x, q.dur ?? 0.16, 0.04, 0.34));
          // the head and chest rise with it more slowly than the nostrils flare
          inhaleHead = softOr(inhaleHead, q.amp * envelope(x, 0.22, 0.04, 0.4));
        }
      }
    }
    sp(this._s.phraseYaw, this._phraseYaw * w.speaking, 4);
    // intonation: the head and brows follow the voice's pitch a little
    const pitchSt = sp(this._s.pitchS, this._into.pitch * w.speaking, this._into.voiced ? 14 : 6);
    // a breath in lifts the chest; speaking breathes out slowly
    const inhaling = inhale > 0.05;
    sp(this._s.speechBreath, inhaling ? 1 : 0, inhaling ? 9 : 1.4);

    // ---- mouth -------------------------------------------------------------------------------
    const age = time - this._mouth.at;
    const mt = this._mt || (this._mt = { jaw: 0, wide: 0, round: 0, press: 0, tuck: 0, teeth: 0, tongue: 0 });
    for (const c of MOUTH_IN) mt[c] = this._mouth[c];
    if (age > 0.6) {
      // stale viseme target: relax (but keep speech-driven fallback below)
      const fade = clamp01((age - 0.6) / 0.25);
      for (const c of MOUTH_IN) mt[c] *= 1 - fade;
    }
    if (age > 0.3 && w.speaking > 0.1 && o.speech > 0.02) {
      // No visemes arriving (e.g. Web Speech fallback): derive a plausible jaw from loudness.
      const wobble = 0.75 + 0.25 * noise1(time * 9.0, this.seed + 5);
      mt.jaw = Math.max(mt.jaw, clamp01(o.speech * 0.75 * wobble) * w.speaking);
    }
    // the lips part a little for a breath in, unless they are closing for a sound
    if (inhale > 0) mt.jaw = Math.max(mt.jaw, 0.07 * inhale * (1 - clamp01(Math.max(mt.press, mt.tuck) * 2)));
    // into a closure (lips pressing for m b p, tucking for f v) the jaw rises a little faster
    // behind the lips (which seal a 50 ms "m" by themselves)
    const closing = clamp01(Math.max(mt.press, mt.tuck) * 1.6 - 0.4);
    for (const c of MOUTH_IN) {
      const s = this._sm[c];
      const [up, down] = MOUTH_OMEGA[c];
      const om = mt[c] > s.x ? up : c === 'jaw' ? lerp(down, JAW_INTO_CLOSURE, closing) : down;
      o[MOUTH_OUT[c]] = clamp01(sp(s, mt[c], om));
    }
    // a little lopsided while talking (never at rest: the rest pose stays the reference)
    const talk = clamp01(o.jawOpen * 1.5 + 0.5 * (o.mouthWide + o.mouthRound) + 0.4 * o.mouthTeeth) * w.speaking;
    o.mouthAsym = clamp((this._asymBias + 0.6 * fbm1(time * 0.31, this.seed + 61)) * 0.4 * talk, -1, 1);

    // ---- expression ----------------------------------------------------------------------------
    const browPitch = 0.045 * clamp(pitchSt - 2.5, 0, 6);    // well above the usual pitch: brows lift
    const smileT = clamp01(this._expr.smile + 0.08 * w.listening - 0.3 * w.error + 0.22 * smileK * ex);
    const browT = clamp01(this._expr.browUp + 0.18 * w.listening + 0.1 * w.thinking + 0.25 * w.error
      - 0.2 * w.sleep + (0.4 * browK + browPitch + 0.08 * inhale - 0.06 * lower) * ex);
    o.smile = clamp01(sp(this._s.smile, smileT * (1 - w.sleep), 10));
    o.browUp = clamp01(sp(this._s.brow, browT, 15));

    // ---- the face moving with the mouth ----------------------------------------------------------
    // (anatomical coupling, so it stays partly on at expressiveness 0)
    const faceK = 0.4 + 0.6 * Math.min(ex, 1.5);
    // spread vowels and smiles lift the cheeks (a wide-open jaw pulls them down instead)
    const cheekT = clamp01((0.55 * o.mouthWide * (1 - 0.6 * o.jawOpen) + 0.3 * o.mouthTeeth) * faceK * w.speaking + 0.9 * o.smile);
    // pressed lips bunch the chin up a little (mentalis); tucks and puckers less. It goes with the
    // lips' target (not the sprung lips, which would put a second lag on it), rising in ~100 ms
    // and falling as the lips part: in step with the closure, not after it.
    const chinT = clamp01((0.58 * mt.press + 0.2 * mt.tuck + 0.12 * mt.round) * faceK);
    const nostrilT = clamp01(inhale * faceK);
    const cS = this._s.cheek, chS = this._s.chin, nS = this._s.nostril;
    o.cheekRaise = clamp01(sp(cS, cheekT, cheekT > cS.x ? 26 : 18));
    o.chinRaise = clamp01(sp(chS, chinT, chinT > chS.x ? 40 : 26));
    o.nostrilFlare = clamp01(sp(nS, nostrilT, nostrilT > nS.x ? 60 : 14));

    // ---- gaze ------------------------------------------------------------------------------------
    this._gazeTargets(time, im, ex);

    // ---- breathing -------------------------------------------------------------------------------
    // the period wanders around 4 s (3.4-4.6), the depth varies, and now and then a sigh
    const per = (4 + 0.35 * pinkNoise(time, this.seed + 71, { f0: 0.03, octaves: 2 })) * lerp(1, 1.55, w.sleep);
    this._breathPhase += (dt / clamp(per, 3, 7)) * Math.PI * 2;
    if (time >= this._nextSigh) {
      this._sighAt = time;
      this._nextSigh = time + 40 + 80 * this.rng3();
    }
    const sigh = envelope(time - this._sighAt, 1.4, 0.6, 2.4);
    const depth = clamp(0.82 + 0.06 * pinkNoise(time, this.seed + 73, { f0: 0.05, octaves: 2 }) + 0.18 * sigh, 0.55, 1);
    const breathIdle = 0.5 - 0.5 * Math.cos(this._breathPhase) * depth;
    // while speaking, breaths come at the pauses (the inhale cues), not on a clock
    o.breath = clamp01(lerp(breathIdle, 0.25 + 0.6 * this._s.speechBreath.x, w.speaking));

    // ---- head --------------------------------------------------------------------------------------
    const s = this.seed;
    const sway = im * (1 - 0.6 * w.sleep);
    // 1/f-like sway (a handful of octaves from ~0.1 Hz, never repeating) plus a faint fast tremor
    const yawSway = (SWAY.yaw * pinkNoise(time, s + 11, { f0: 0.1 }) + SWAY.fast * pinkNoise(time, s + 12, { f0: 0.6, octaves: 2 })) * sway;
    const pitchSway = (SWAY.pitch * pinkNoise(time, s + 23, { f0: 0.1 }) + SWAY.fast * pinkNoise(time, s + 24, { f0: 0.7, octaves: 2 })) * sway;
    const rollSway = SWAY.roll * pinkNoise(time, s + 37, { f0: 0.09 }) * sway;
    const spk = o.speech * w.speaking * ex;
    // posture: the state's (through the weight springs) plus speech motion (through a spring)
    const thinkPitch = sp(this._s.thinkPitch, this._think.mode === 'down' ? -0.025 : 0.045, 6);
    const side = sp(this._s.thinkSide, this._thinkSide, 4);
    const pitchPosture = -0.035 * w.listening + thinkPitch * w.thinking - 0.09 * w.sleep;
    const rollPosture = 0.03 * w.listening + 0.035 * side * w.thinking + 0.04 * w.sleep;
    const pY = sp(this._s.yaw, spk * 0.02 * noise1(time * 2.3, s + 43), 6.5);
    const pP = sp(this._s.pitch, spk * 0.03 * noise1(time * 3.1, s + 41) + (o.breath - 0.5) * 0.006, 6.5);
    // an error: a short, small head shake that starts and ends at rest
    const since = time - this._errorKick;
    const shake = since >= 0 && since < 0.8 ? 0.012 * Math.sin(since * 28) * envelope(since, 0.06, 0.1, 0.6) : 0;
    const eyes = this.eyes;
    let yaw = yawSway + pY + shake + this._s.phraseYaw.x * ex + eyes.hx.x / DEG + ex * 0.006 * nodYaw;
    let pitch = pitchSway + pP + pitchPosture + eyes.hy.x / DEG
      + ex * (-0.024 * nod + 0.012 * lift + 0.012 * Math.abs(tilt) + 0.0036 * softClamp(pitchSt, -6, 8) - 0.016 * lower + 0.008 * inhaleHead);
    let roll = rollSway + rollPosture + 0.03 * tilt * ex + ex * 0.005 * nodRoll;
    yaw = clamp(yaw, -0.35, 0.35);
    pitch = clamp(pitch, -0.25, 0.25);
    roll = clamp(roll, -0.2, 0.2);
    o.headYaw = yaw; o.headPitch = pitch; o.headRoll = roll;

    // eyes in the head: the world gaze minus the head's turn (vestibulo-ocular reflex)
    o.gazeX = clamp((eyes.x - yaw * DEG) / GAZE_DEG.x, -1, 1);
    o.gazeY = clamp((eyes.y - pitch * DEG) / GAZE_DEG.y, -1, 1);

    // ---- blinks ----------------------------------------------------------------------------------
    this._blinks(time, w, o);

    // ---- energy --------------------------------------------------------------------------------------
    const thinkPulse = 0.12 * (0.5 + 0.5 * Math.sin(time * 2.4));
    const flicker = 0.18 * Math.max(0, noise1(time * 23, s + 51));
    const eT = idleW * ENERGY.idle + w.listening * ENERGY.listening
      + w.thinking * (ENERGY.thinking + thinkPulse) + w.speaking * (ENERGY.speaking + 0.45 * o.speech)
      + w.error * (ENERGY.error - flicker) + w.sleep * ENERGY.sleep;
    const norm = idleW + w.listening + w.thinking + w.speaking + w.error + w.sleep;
    o.energy = clamp01(sp(this._s.energy, clamp01(eT / Math.max(norm, 1e-6)), 13));
    return o;
  }

  /**
   * Where the eyes should look (world, deg) and how they get there (src/avatar/eyes.js).
   * @param {number} time @param {number} im @param {number} ex
   */
  _gazeTargets(time, im, ex) {
    const dt = Number.isFinite(this._gazeT) ? Math.max(0, time - this._gazeT) : 0;
    this._gazeT = time;
    let jump = this._selfJump;
    this._selfJump = false;
    if (this._gazeNext && time >= this._gazeNextAt) {
      this._gazeState = this._gazeNext;
      this._gazeNext = null;
      this._gazeNextAt = Infinity;
      jump = true;
      if (this._gazeState === 'speaking') {
        // starting to speak: the first look goes to the listener (not to an old idle or thinking
        // look-around drawn at full roam), the next look-around comes later
        this._saccade.x = 0; this._saccade.y = 0;
        this._saccadeAt = Math.max(this._saccadeAt, time + 0.8 + 0.7 * this.rng3());
      }
    }
    const gs = this._gazeState;
    const roam = Math.min(1, im);
    // ---- the avatar's own targets: idle looks around, micro-saccades, thinking's look-away
    if (time >= this._saccadeAt) {
      const r1 = this.rng(), r2 = this.rng();
      // while speaking the eyes stay mostly on the listener (the glances below replace them)
      const rm = im * (gs === 'speaking' ? 0.4 : 1);
      // (about +-4.8 deg across, +-2 deg up and down)
      this._saccade.x = (r1 * 2 - 1) * 0.28 * rm;
      this._saccade.y = ((r2 * 2 - 1) * 2 / GAZE_DEG.y) * rm;
      if (this.rng() < 0.35) { this._saccade.x *= 0.2; this._saccade.y *= 0.2; } // back to centre
      this._saccadeAt = time + 0.6 + this.rng() * 2.2;
      if (!this._look && gs !== 'thinking' && gs !== 'sleep' && im > 0) jump = true;
    }
    if (time >= this._microAt) {
      // fixational micro-saccades (a quarter of a degree, every second or two) while the eyes
      // wander; none during eye contact or cursor follow: a still target gives still eyes
      const free = !this._look && roam > 0;
      this._micro.x = free ? ((this.rng3() * 2 - 1) * 0.25 * roam) / GAZE_DEG.x : 0;
      this._micro.y = free ? ((this.rng3() * 2 - 1) * 0.2 * roam) / GAZE_DEG.y : 0;
      this._microAt = time + 0.8 + 1.4 * this.rng3();
      if (free) jump = true;
    }
    if (gs === 'thinking') {
      if (time >= this._thinkSwitchAt) {
        this._thinkSide = -this._thinkSide;
        this._thinkSwitchAt = time + Math.max(8, -11 * Math.log(Math.max(1e-6, this.rng3())));
        jump = true;
      }
      if (time >= this._think.microAt) {
        // small looks within the averted region (1-3 deg)
        const a = (1 + 2 * this.rng3()) * roam, ang = this.rng3() * Math.PI * 2;
        this._think.mx = (a * Math.cos(ang)) / GAZE_DEG.x;
        this._think.my = (0.6 * a * Math.sin(ang)) / GAZE_DEG.y;
        this._think.microAt = time + 0.8 + 1.2 * this.rng3();
        if (roam > 0) jump = true;
      }
    }
    const glanceOn = gs === 'speaking' && time < this._glance.until && ex > 0;
    if (glanceOn !== this._glanceOn) jump = true;
    this._glanceOn = glanceOn;

    // ---- compose the target (deg, world)
    const look = this._look ? this._lookAtT(time) : null;
    let x, y;
    if (look) { x = look.x; y = look.y; } else { x = this._saccade.x * GAZE_DEG.x; y = this._saccade.y * GAZE_DEG.y; }
    if (gs === 'listening') { x *= 0.6; y *= 0.6; }
    if (gs === 'thinking') {
      // look up and aside (the eyes go with the head's lift there), or down and aside
      const up = this._think.mode !== 'down';
      // (~7 deg aside; 7 deg up in the head, which lifts too; or 5 deg down)
      const ax = (this._thinkSide * (up ? 0.42 : 0.36) + this._think.mx) * GAZE_DEG.x;
      const ay = (up ? 7 : -5) + this._think.my * GAZE_DEG.y + (up ? 0.045 : -0.025) * DEG;
      const k = look ? 0.6 : 1;
      x = lerp(x, ax, k); y = lerp(y, ay, k);
    }
    if (gs === 'sleep') { x = 0; y = -1.4 - 0.09 * DEG; }
    else { x += this._micro.x * GAZE_DEG.x; y += this._micro.y * GAZE_DEG.y; }
    if (glanceOn) {
      const gk = Math.min(1, ex);
      x += this._glance.x * gk * GAZE_DEG.x;
      y += this._glance.y * gk * 6.78; // (0.3-0.8 deg: a little up or down)
    }
    // ---- pursuit sees the target's velocity ~100 ms late (and never a 12 / 30 Hz staircase)
    const h = this._lookHist;
    const tg = this._tg;
    tg.vx = 0; tg.vy = 0;
    if (look) {
      h.t[h.i] = time; h.x[h.i] = look.x; h.y[h.i] = look.y;
      h.i = (h.i + 1) % h.t.length;
      h.n = Math.min(h.n + 1, h.t.length);
      const a = this._histAt(time - 0.1), b = this._histAt(time - 0.18);
      if (a && b && a.t - b.t > 0.02) { tg.vx = (a.x - b.x) / (a.t - b.t); tg.vy = (a.y - b.y) / (a.t - b.t); }
    } else {
      h.n = 0;
    }
    tg.x = x; tg.y = y;
    tg.reactive = !!look && !jump;
    tg.now = jump;
    // the head goes along with a followed target (cursor, face: a 20 deg look ends with ~7 deg of
    // head, as before the eye controller) more than with the avatar's own looks; a glance away
    // from the user is the eyes' own look
    const follow = !!look && this._lookKind !== 'glance';
    tg.headFollow = follow;
    tg.headShare = follow ? HEAD_SHARE_FOLLOW : gs === 'thinking' ? 0.3 : gs === 'speaking' ? 0.2 : 0.25;
    this.eyes.update(dt, time, tg);
  }

  /** The look target at time t from the history (null when it does not reach back that far). @param {number} t */
  _histAt(t) {
    const h = this._lookHist;
    const L = h.t.length;
    for (let k = 1; k <= h.n; k++) {
      const i = (h.i - k + L) % L;
      if (h.t[i] <= t) {
        if (k === 1) return { t: h.t[i], x: h.x[i], y: h.y[i] };
        const j = (i + 1) % L;
        const u = (t - h.t[i]) / Math.max(1e-6, h.t[j] - h.t[i]);
        return { t, x: h.x[i] + (h.x[j] - h.x[i]) * u, y: h.y[i] + (h.y[j] - h.y[i]) * u };
      }
    }
    return null;
  }

  /**
   * Blinks: log-normal intervals by state with a refractory period, an asymmetric lid profile,
   * partial blinks, rare doubles, blinks with large gaze shifts.
   * @param {number} time @param {Record<string, number>} w @param {AnimState} o
   */
  _blinks(time, w, o) {
    const busy = time - this._blinkStart < this._blink.total;
    // While talking, a scheduled blink waits for the next phrase boundary (people blink
    // between phrases, rarely mid-word), at most ~2 s.
    // (mid-phrase: a cue came moments ago, or the voice is sounding right now)
    const midPhrase = w.speaking > 0.5 && (time - this._lastCue < 0.6 || this._into.voiced || o.speech > 0.25);
    const due = time >= this._nextBlink && !(midPhrase && time - this._nextBlink < 2);
    if (!busy && time >= this._nextBlink && !due) this._blinkDeferred = true;
    // a large gaze shift often comes with a blink
    for (const amp of this.eyes.take()) {
      if (amp >= 15 && time - this._blinkStart > 0.5 && this.rng3() < 0.65) this._blinkRequested = true;
    }
    if (!busy && (this._blinkRequested || due || time >= this._pendingDouble)) {
      this._blinkDeferred = false;
      const wasDouble = time >= this._pendingDouble;
      const asked = this._blinkRequested;
      this._blinkStart = time;
      this._blinkRequested = false;
      this._pendingDouble = Infinity;
      const r = this.rng3;
      // about one in five is a partial blink; each varies in speed
      const amp = asked ? 1 : r() < 0.2 ? 0.55 + 0.25 * r() : 0.88 + 0.12 * r();
      const close = 0.06 + 0.02 * r(), hold = 0.02 * r(), open = 0.15 + 0.07 * r();
      this._blink = { amp, close, hold, open, total: close + hold + open + 0.01 };
      if (!wasDouble && this.rng() < 0.04) this._pendingDouble = time + this._blink.total + 0.12 + 0.08 * r();
      this._nextBlink = time + logNormal(this.rng, BLINK_MEDIAN[this.current] ?? 2.8, 0.6, 0.8, 12);
    }
    const bl = this._blink;
    const blinkL = bl.amp * blinkCurve(time - this._blinkStart, bl);
    // the second eye trails by a few milliseconds — subtle but alive
    const blinkR = bl.amp * blinkCurve(time - this._blinkStart - 0.007, bl);
    const sleepClose = smooth01(w.sleep * 1.15);
    // (the upper lid following a downward gaze is drawn by the heads, from gazeY)
    o.blinkL = clamp01(softOr(blinkL, sleepClose));
    o.blinkR = clamp01(softOr(blinkR, sleepClose));
  }

  /** After settled frames, start the live dynamics from the settled pose (at rest). */
  _syncFromSettled() {
    const o = this.out;
    for (const s of WEIGHTED) this._sw[s].set(this._w[s]);
    for (const c of MOUTH_IN) this._sm[c].set(o[MOUTH_OUT[c]]);
    this._s.speech.set(o.speech); this._s.smile.set(o.smile); this._s.brow.set(o.browUp);
    this._s.cheek.set(o.cheekRaise); this._s.chin.set(o.chinRaise); this._s.nostril.set(o.nostrilFlare);
    this._s.energy.set(o.energy);
    this.eyes.reset(o.gazeX * GAZE_DEG.x + o.headYaw * DEG, o.gazeY * GAZE_DEG.y + o.headPitch * DEG);
    this._breathPhase = (this._time / 4.2) * Math.PI * 2;
    this._gazeState = this.current;
    this._gazeNext = null;
  }

  /**
   * Settled (fixed-time) pose: every channel at its target, no random events, the original
   * closed-form idle sway and breathing (the rest render is the visual-diff reference).
   * @param {number} time
   */
  _updateSettled(time) {
    const o = this.out;
    const w = this._w;
    for (const s of WEIGHTED) w[s] = this.current === s ? 1 : 0;
    o.listen = w.listening; o.think = w.thinking; o.speak = w.speaking; o.error = w.error; o.sleep = w.sleep;
    const idleW = clamp01(1 - (w.listening + w.thinking + w.speaking + w.error + w.sleep));
    o.speech = this._speechTarget;
    for (const c of MOUTH_IN) o[MOUTH_OUT[c]] = this._mouth[c];
    o.mouthAsym = 0;
    const ex = this.expressiveness;
    this._phraseYawS = this._phraseYaw * w.speaking;
    this._pitchS = 0;
    const smileT = clamp01(this._expr.smile + 0.08 * w.listening - 0.3 * w.error);
    const browT = clamp01(this._expr.browUp + 0.18 * w.listening + 0.1 * w.thinking + 0.25 * w.error - 0.2 * w.sleep);
    o.smile = smileT * (1 - w.sleep);
    o.browUp = browT;
    const faceK = 0.4 + 0.6 * Math.min(ex, 1.5);
    o.cheekRaise = clamp01((0.55 * o.mouthWide * (1 - 0.6 * o.jawOpen) + 0.3 * o.mouthTeeth) * faceK * w.speaking + 0.9 * o.smile);
    o.chinRaise = clamp01((0.58 * o.mouthPress + 0.2 * o.mouthTuck + 0.12 * o.mouthRound) * faceK);
    o.nostrilFlare = 0;
    const sleepClose = smooth01(w.sleep * 1.15);
    o.blinkL = sleepClose;
    o.blinkR = sleepClose;
    // gaze
    let gxT = this._look ? this._look.x * 0.85 : this._saccade.x;
    let gyT = this._look ? this._look.y * 0.75 : this._saccade.y;
    gxT = lerp(gxT, this._thinkSide * 0.42, w.thinking * (this._look ? 0.6 : 1));
    gyT = lerp(gyT, 0.48, w.thinking * (this._look ? 0.6 : 1));
    gxT = lerp(gxT, gxT * 0.4, w.listening * 0.6);
    gyT = lerp(gyT, gyT * 0.4, w.listening * 0.6);
    gxT = lerp(gxT, 0, w.sleep);
    gyT = lerp(gyT, -0.2, w.sleep);
    gxT += this._micro.x * (1 - w.sleep);
    gyT += this._micro.y * (1 - w.sleep);
    this._gx = gxT; this._gy = gyT;
    o.gazeX = clamp(gxT, -1, 1);
    o.gazeY = clamp(gyT * SETTLED_GY, -1, 1);
    // breathing
    this._breathPhase = (time / 4.2) * Math.PI * 2;
    o.breath = 0.5 - 0.5 * Math.cos(this._breathPhase);
    // head
    const s = this.seed;
    const sway = this.idleMotion * (1 - 0.6 * w.sleep);
    let yawT = 0.04 * fbm1(time * 0.13, s + 11) * sway + this._gx * 0.1;
    let pitchT = 0.028 * fbm1(time * 0.11, s + 23) * sway + this._gy * 0.06 + (o.breath - 0.5) * 0.006;
    let rollT = 0.022 * fbm1(time * 0.09, s + 37) * sway;
    pitchT += -0.035 * w.listening + 0.045 * w.thinking - 0.09 * w.sleep;
    rollT += 0.03 * w.listening + 0.035 * this._thinkSide * w.thinking + 0.04 * w.sleep;
    this._yaw = clamp(yawT, -0.35, 0.35);
    this._pitch = clamp(pitchT, -0.25, 0.25);
    this._roll = clamp(rollT, -0.2, 0.2);
    o.headYaw = this._yaw + this._phraseYawS * ex;
    o.headPitch = this._pitch;
    o.headRoll = this._roll;
    // energy
    const thinkPulse = 0.12 * (0.5 + 0.5 * Math.sin(time * 2.4));
    const eT = idleW * ENERGY.idle + w.listening * ENERGY.listening
      + w.thinking * (ENERGY.thinking + thinkPulse) + w.speaking * (ENERGY.speaking + 0.45 * o.speech)
      + w.error * ENERGY.error + w.sleep * ENERGY.sleep;
    const norm = idleW + w.listening + w.thinking + w.speaking + w.error + w.sleep;
    o.energy = clamp01(eT / Math.max(norm, 1e-6));
  }
}

/** Clamp to [lo, hi] with corners rounded over ~1 unit (no kink where it starts to limit). */
function softClamp(v, lo, hi) {
  const sp = (x) => (x > 30 ? x : Math.log1p(Math.exp(x)));
  return lo + sp(v - lo) - sp(v - hi);
}

/** @param {number} x */
function smooth01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

// re-exported for tests and tools
export { minJerk, springStep };
