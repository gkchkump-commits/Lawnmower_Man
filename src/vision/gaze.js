// Where the avatar's eyes go: the mouse cursor or the user's face (eye contact).
//
// Eye contact on a flat screen: a face drawn looking straight out of the picture looks at every
// viewer in front of it, wherever they sit (the "Mona Lisa effect"). So eye contact is a gaze of
// about (0, 0); the face position only adds a small lean toward where the user is, so the eyes
// visibly follow when they move, and the contact is broken by short natural glances away
// (people hold eye contact for a few seconds at a time, not continuously): a look 8-15 deg to
// the side or down and aside for 0.5-1.5 s, then back (the director makes both saccades). The
// contact phases last a log-normal time (median 3.5 s), not a uniform one.
//
// Priority: a moving cursor wins for `cursorWinsMs` (then the gaze returns to the user); with no
// face in view the cursor keeps the gaze for its own hold time, exactly like before the camera;
// otherwise the face; otherwise nothing (the director's idle saccades).
//
// Pure apart from the injected clock/timer: unit-tested.

export const GAZE_DEFAULTS = Object.freeze({
  cursorWinsMs: 1500,
  cursorHoldMs: 5000,
  faceGainX: 0.35,
  faceGainY: 0.3,
  contactMedianMs: 3500,
  contactSigma: 0.45,
  contactMinMs: 1500,
  contactMaxMs: 9000,
  glanceMinMs: 500,
  glanceMaxMs: 1500,
  /** how far a glance looks away (deg of eye rotation) */
  glanceMinDeg: 8,
  glanceMaxDeg: 15,
  /** targets closer than this to the last one are not sent again (gaze units; the face centre
   * comes One Euro filtered, so this only drops the repeats) */
  dedupe: 0.0015,
});

/** Degrees of world gaze per lookAt unit (the director's mapping: 0.85 x 17.2 deg, 8 deg). */
const DEG_PER_UNIT = { x: 14.6, y: 8 };

const clamp = (/** @type {number} */ v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * Length (ms) of a contact or glance phase. Contact: log-normal (median contactMedianMs), glance:
 * uniform; both from `rng` (0..1).
 * @param {'contact'|'glance'} phase @param {() => number} rng @param {typeof GAZE_DEFAULTS} o
 */
export function phaseLength(phase, rng, o = GAZE_DEFAULTS) {
  if (phase === 'glance') return o.glanceMinMs + rng() * (o.glanceMaxMs - o.glanceMinMs);
  // a standard normal from one uniform (the logistic approximation of its inverse CDF)
  const u = Math.min(1 - 1e-6, Math.max(1e-6, rng()));
  const z = 0.5513 * Math.log(u / (1 - u));
  return clamp(o.contactMedianMs * Math.exp(o.contactSigma * z), o.contactMinMs, o.contactMaxMs);
}

/**
 * Eye-contact gaze for a face at (x, y) (AttentionState: mirrored like a selfie, -1..1, y up).
 * @param {{ x: number, y: number }} att @param {Partial<typeof GAZE_DEFAULTS>} [o]
 * @returns {[number, number]}
 */
export function faceGaze(att, o = {}) {
  const gx = o.faceGainX ?? GAZE_DEFAULTS.faceGainX;
  const gy = o.faceGainY ?? GAZE_DEFAULTS.faceGainY;
  return [clamp((Number(att?.x) || 0) * gx), clamp((Number(att?.y) || 0) * gy)];
}

export class GazeArbiter {
  /**
   * @param {object} o
   * @param {(target: [number, number]|null) => void} o.apply  avatar.lookAt(x, y) / lookAt(null)
   * @param {() => number} [o.now]
   * @param {() => number} [o.rng]  0..1 (the length of contact and glance phases)
   * @param {(fn: () => void, ms: number) => any} [o.setTimeout]
   * @param {(id: any) => void} [o.clearTimeout]
   * @param {Partial<typeof GAZE_DEFAULTS>} [o.options]
   */
  constructor(o) {
    this._apply = o.apply;
    this._now = o.now || (() => performance.now());
    this._rng = o.rng || Math.random;
    this._setTimeout = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = o.clearTimeout || ((id) => clearTimeout(id));
    this.o = { ...GAZE_DEFAULTS, ...(o.options || {}) };
    /** @type {{ g: [number, number], at: number, holdMs: number }|null} */
    this._cursor = null;
    /** @type {[number, number]|null} */
    this._face = null;
    /** contact / glance phases while the face is the target */
    this._phase = /** @type {'contact'|'glance'} */ ('contact');
    this._phaseUntil = 0;
    /** where the current glance looks, relative to the face (gaze units) */
    this._glance = /** @type {[number, number]} */ ([0, 0]);
    /** @type {[number, number]|null} what was applied last */
    this.target = null;
    /** @type {'cursor'|'face'|'glance'|null} */
    this.source = null;
    this._timer = null;
  }

  /**
   * The cursor moved: look at it (gaze units, avatar.lookAt) for up to `holdMs` without moves.
   * @param {[number, number]} g @param {number} [holdMs]
   */
  cursor(g, holdMs = this.o.cursorHoldMs) {
    this._cursor = { g: [clamp(g[0]), clamp(g[1])], at: this._now(), holdMs };
    this.update();
  }

  /** The cursor left (browser preview) or cursor-follow was turned off. */
  releaseCursor() {
    this._cursor = null;
    this.update();
  }

  /** @param {[number, number]|null} g eye-contact target (faceGaze), null = no face to look at */
  setFace(g) {
    const had = !!this._face;
    this._face = g ? [clamp(g[0]), clamp(g[1])] : null;
    if (this._face && !had) this._startPhase('contact', this._now());
    this.update();
  }

  /** Re-decide now (also runs by itself when a hold or a phase ends). */
  update() {
    const now = this._now();
    const c = this._cursor;
    /** @type {[number, number]|null} */
    let target = null;
    /** @type {'cursor'|'face'|'glance'|null} */
    let source = null;
    if (c && now - c.at >= c.holdMs) this._cursor = null;
    const cursorLive = !!this._cursor && now - this._cursor.at < (this._face ? Math.min(this.o.cursorWinsMs, this._cursor.holdMs) : this._cursor.holdMs);
    if (cursorLive && this._cursor) {
      target = this._cursor.g;
      source = 'cursor';
    } else if (this._face) {
      while (now >= this._phaseUntil) this._startPhase(this._phase === 'contact' ? 'glance' : 'contact', this._phaseUntil || now);
      if (this._phase === 'contact') {
        target = this._face;
        source = 'face';
      } else {
        // an explicit look away (a saccade there and one back), not the idle wandering
        target = [clamp(this._face[0] + this._glance[0]), clamp(this._face[1] + this._glance[1])];
        source = 'glance';
      }
    }
    this.source = source;
    if (!sameTarget(target, this.target, this.o.dedupe)) {
      this.target = target ? [target[0], target[1]] : null;
      this._apply(this.target);
    }
    this._scheduleNext(now);
  }

  /** Send the current target again (a new avatar was created: it starts without one). */
  reapply() {
    this._apply(this.target ? [this.target[0], this.target[1]] : null);
  }

  dispose() {
    this._clearTimeout(this._timer);
    this._timer = null;
  }

  // ------------------------------------------------------------------------------------------

  /** @param {'contact'|'glance'} phase @param {number} from */
  _startPhase(phase, from) {
    this._phase = phase;
    this._phaseUntil = Math.max(from, this._now() - 60_000) + phaseLength(phase, this._rng, this.o);
    if (phase === 'glance') {
      // 8-15 deg to the side (a little up or down), or down and aside
      const r = this._rng;
      const side = r() < 0.5 ? -1 : 1;
      const a = this.o.glanceMinDeg + r() * (this.o.glanceMaxDeg - this.o.glanceMinDeg);
      if (r() < 0.65) {
        this._glance = [(side * a) / DEG_PER_UNIT.x, ((r() * 2 - 1) * 1.5) / DEG_PER_UNIT.y];
      } else {
        const down = 0.55 + 0.25 * r();
        this._glance = [(side * a * Math.sqrt(1 - down * down)) / DEG_PER_UNIT.x, (-a * down * 0.6) / DEG_PER_UNIT.y];
      }
    }
  }

  /** Wake up when the decision can change by itself (a cursor hold or a phase ends). @param {number} now */
  _scheduleNext(now) {
    this._clearTimeout(this._timer);
    this._timer = null;
    let next = Infinity;
    const c = this._cursor;
    if (c) {
      const ends = [c.at + c.holdMs];
      if (this._face) ends.push(c.at + Math.min(this.o.cursorWinsMs, c.holdMs));
      for (const t of ends) if (t > now) next = Math.min(next, t);
    }
    if (this._face) next = Math.min(next, this._phaseUntil);
    if (!Number.isFinite(next)) return;
    this._timer = this._setTimeout(() => {
      this._timer = null;
      this.update();
    }, Math.max(0, next - now) + 1);
  }
}

/** @param {[number, number]|null} a @param {[number, number]|null} b @param {number} eps */
function sameTarget(a, b, eps) {
  if (!a || !b) return a === b;
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}
