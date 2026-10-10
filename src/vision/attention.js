// Attention: what the camera's face tracker says about the user, as a few stable signals.
//
//   summarizeFaceResult()  MediaPipe FaceLandmarkerResult → a compact FaceObservation (a dozen
//                          landmarks and the blendshapes we use). Runs in the tracker worker, so
//                          only ~1 KB per frame crosses postMessage.
//   faceGeometry()         FaceObservation → centre, size and head yaw/pitch/roll.
//   AttentionTracker       a stream of observations (or null: no face) → AttentionState with
//                          hysteresis and smoothing: present/absent, the face centre mirrored
//                          like a selfie view, approximate distance, head pose, "looking at the
//                          screen", smiling, talking.
//
// Pure (no DOM, no MediaPipe import): unit-tested on synthetic landmarker results.

import { OneEuro } from '../avatar/motion.js';

/** Landmark indices we keep (MediaPipe Face Mesh topology, 478 points with irises). */
export const KEY_POINTS = Object.freeze({
  noseTip: 1,
  forehead: 10,
  chin: 152,
  cheekL: 234, // screen-left in the camera image (the subject's right cheek)
  cheekR: 454,
  eyeOuterL: 33,
  eyeInnerL: 133,
  eyeInnerR: 362,
  eyeOuterR: 263,
  irisL: 468,
  irisR: 473,
  mouthL: 61,
  mouthR: 291,
  lipTop: 13,
  lipBottom: 14,
});

/** Blendshapes (ARKit names) we keep. */
export const BLENDSHAPES = Object.freeze([
  'jawOpen', 'mouthClose', 'mouthSmileLeft', 'mouthSmileRight', 'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
]);

/**
 * @typedef {object} FaceObservation
 * @property {number} width   frame width in px (the detector input)
 * @property {number} height  frame height in px
 * @property {Record<string, [number, number, number]>} points  KEY_POINTS → [x, y, z], normalized
 *   image coordinates (x right, y down, 0..1; z roughly in units of the frame width)
 * @property {Record<string, number>} blend  BLENDSHAPES → 0..1 (missing ones are absent)
 */

/**
 * @param {any} result FaceLandmarkerResult ({ faceLandmarks, faceBlendshapes })
 * @param {number} width @param {number} height  the frame the result belongs to
 * @returns {FaceObservation|null} the first face, or null when there is none
 */
export function summarizeFaceResult(result, width, height) {
  const lms = result && Array.isArray(result.faceLandmarks) ? result.faceLandmarks[0] : null;
  if (!Array.isArray(lms) || lms.length < 468) return null;
  /** @type {Record<string, [number, number, number]>} */
  const points = {};
  for (const [name, i] of Object.entries(KEY_POINTS)) {
    const p = lms[i];
    if (!p) continue;
    points[name] = [num(p.x), num(p.y), num(p.z)];
  }
  /** @type {Record<string, number>} */
  const blend = {};
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (Array.isArray(cats)) {
    for (const c of cats) {
      if (c && BLENDSHAPES.includes(c.categoryName)) blend[c.categoryName] = clamp01(num(c.score));
    }
  }
  return { width: Math.max(1, num(width) || 1), height: Math.max(1, num(height) || 1), points, blend };
}

/**
 * Face centre, size and head pose from an observation.
 * yaw > 0: the user turns their head toward their own left (the camera image's right);
 * pitch > 0: the user looks up; roll > 0: the head tilts toward the image's right (clockwise
 * in the image). All in radians.
 * @param {FaceObservation} obs
 * @returns {{ cx: number, cy: number, size: number, yaw: number, pitch: number, roll: number }|null}
 *   cx, cy: normalized image coordinates of the face centre; size: cheek-to-cheek width as a
 *   fraction of the frame width
 */
export function faceGeometry(obs) {
  const p = obs?.points;
  if (!p || !p.cheekL || !p.cheekR || !p.forehead || !p.chin || !p.noseTip) return null;
  const W = obs.width;
  const H = obs.height;
  // pixels, so a non-square frame does not skew the angles (z is in units of the width)
  const P = (/** @type {[number, number, number]} */ q) => [q[0] * W, q[1] * H, q[2] * W];
  const L = P(p.cheekL), R = P(p.cheekR), T = P(p.forehead), B = P(p.chin), N = P(p.noseTip);
  const right = sub(R, L);
  const down = sub(B, T);
  // the face normal points out of the face: toward the camera (-z: MediaPipe's z shrinks
  // toward the camera) for a frontal face
  let n = cross(down, right);
  if (!(norm(n) > 1e-9)) return null;
  n = scale(n, 1 / norm(n));
  // A frontal face has n = (0, 0, -1). Turning toward the image's right moves the normal to +x.
  const yaw = Math.atan2(n[0], -n[2]);
  const pitch = Math.atan2(-n[1], Math.hypot(n[0], n[2]));
  const roll = Math.atan2(right[1], right[0]);
  const cx = (L[0] + R[0] + T[0] + B[0] + N[0]) / 5 / W;
  const cy = (T[1] + B[1]) / 2 / H;
  const size = norm(right) / W;
  return { cx, cy, size, yaw, pitch, roll };
}

/**
 * Approximate camera-to-face distance in cm from the face width in the frame, for a typical
 * laptop webcam (about 65° horizontal field of view) and an average cheek-to-cheek width.
 * @param {number} size  cheek-to-cheek width / frame width
 * @param {{ fovDeg?: number, faceWidthCm?: number }} [o]
 */
export function estimateDistanceCm(size, o = {}) {
  const fov = ((o.fovDeg ?? 65) * Math.PI) / 180;
  const faceW = o.faceWidthCm ?? 14;
  if (!(size > 0)) return Infinity;
  // the face spans `size` of the frame → it subtends size * fov (small-angle, good enough)
  return faceW / (2 * Math.tan((size * fov) / 2));
}

/**
 * @typedef {object} AttentionState
 * @property {boolean} present    a face is (stably) in view
 * @property {number} changedAt   when `present` last flipped (ms)
 * @property {number} lastSeen    last frame with a face (ms; -Infinity before the first)
 * @property {number} x           face centre, mirrored like a selfie view: -1 (screen left) .. 1
 * @property {number} y           -1 (bottom of the frame) .. 1 (top)
 * @property {number} size        cheek-to-cheek width / frame width
 * @property {number} distanceCm  approximate distance from the camera
 * @property {number} yaw         head yaw, radians (mirrored too: > 0 = turned toward screen right)
 * @property {number} pitch       head pitch, radians (> 0 = looking up)
 * @property {number} roll        head tilt, radians, as seen in the selfie view (> 0 = counter-clockwise
 *                                on screen: the image's clockwise, mirrored)
 * @property {boolean} looking    looking at the screen (head and eyes toward it)
 * @property {number} smile       0..1, smoothed
 * @property {boolean} smiling
 * @property {number} jaw         jawOpen, smoothed
 * @property {boolean} talking    the jaw moves like speech
 */

/** Tunables (exported for the tests and docs/CAMERA.md). */
export const ATTENTION_DEFAULTS = Object.freeze({
  presentAfterMs: 200, // a face this long (and at least 2 frames) → present
  absentAfterMs: 1500, // no face this long (and at least 2 frames) → absent
  smoothMs: 150, // time constant of the pose / size smoothing
  // the face centre (what the eyes follow): a One Euro filter, so a still face gives still eyes
  // and a moving one is followed with little lag
  centreMinCutoff: 0.5, // Hz
  centreBeta: 8,
  centreDCutoff: 1, // Hz
  // looking at the screen: the camera sits above (or beside) it, so allow a cone around it
  lookYawDeg: 24,
  lookPitchUpDeg: 18,
  lookPitchDownDeg: 34,
  lookEyesAside: 0.62, // eyeLookIn/Out above this → looking aside
  lookOnMs: 250,
  lookOffMs: 700,
  smileOn: 0.45,
  smileOff: 0.28,
  smileOnMs: 350,
  talkWindowMs: 1200, // jaw movement is judged over this window
  talkOn: 0.06, // mean |Δ jawOpen| per frame (at ~12 fps) that counts as talking
  talkOff: 0.025,
  talkRange: 0.12, // and the jaw must open and close by at least this much
});

export class AttentionTracker {
  /** @param {Partial<typeof ATTENTION_DEFAULTS>} [o] */
  constructor(o = {}) {
    this.o = { ...ATTENTION_DEFAULTS, ...o };
    this.reset();
  }

  reset(now = 0) {
    /** @type {AttentionState} */
    this.state = {
      present: false, changedAt: now, lastSeen: -Infinity, x: 0, y: 0, size: 0, distanceCm: Infinity,
      yaw: 0, pitch: 0, roll: 0, looking: false, smile: 0, smiling: false, jaw: 0, talking: false,
    };
    this._hits = 0;
    this._firstHit = 0;
    this._misses = 0;
    this._lastT = null;
    const o = this.o;
    this._fx = new OneEuro(o.centreMinCutoff, o.centreBeta, o.centreDCutoff);
    this._fy = new OneEuro(o.centreMinCutoff, o.centreBeta, o.centreDCutoff);
    this._lookSince = null;
    this._unlookSince = null;
    this._smileSince = null;
    /** @type {Array<{ t: number, jaw: number }>} */
    this._jaw = [];
  }

  /**
   * Feed one tracker frame.
   * @param {FaceObservation|null} obs  null: the frame had no face
   * @param {number} now  ms
   * @returns {AttentionState} the (shared, updated) state
   */
  update(obs, now) {
    const o = this.o;
    const s = this.state;
    const dt = this._lastT === null ? 0 : Math.max(0, now - this._lastT);
    this._lastT = now;
    const g = obs ? faceGeometry(obs) : null;

    if (!g) {
      this._misses++;
      this._hits = 0;
      if (s.present && this._misses >= 2 && now - s.lastSeen >= o.absentAfterMs) {
        s.present = false;
        s.changedAt = now;
        s.looking = false;
        s.smiling = false;
        s.talking = false;
        this._lookSince = this._unlookSince = this._smileSince = null;
        this._jaw = [];
      }
      return s;
    }

    if (this._hits === 0) this._firstHit = now;
    this._hits++;
    this._misses = 0;
    const wasSeen = Number.isFinite(s.lastSeen);
    // after a gap, jump to the new position instead of gliding across the frame
    const fresh = !wasSeen || now - s.lastSeen > o.absentAfterMs;
    s.lastSeen = now;
    if (!s.present && this._hits >= 2 && now - this._firstHit >= o.presentAfterMs) {
      s.present = true;
      s.changedAt = now;
    }

    const k = fresh ? 1 : 1 - Math.exp(-dt / Math.max(1, o.smoothMs));
    // selfie view: the user's right appears on the screen's right
    const x = clamp(1 - 2 * g.cx, -1, 1);
    const y = clamp(1 - 2 * g.cy, -1, 1);
    if (fresh) { this._fx.reset(); this._fy.reset(); }
    s.x = this._fx.filter(x, now / 1000);
    s.y = this._fy.filter(y, now / 1000);
    s.size += (g.size - s.size) * k;
    s.yaw += (-g.yaw - s.yaw) * k;
    s.pitch += (g.pitch - s.pitch) * k;
    s.roll += (g.roll - s.roll) * k;
    s.distanceCm = estimateDistanceCm(s.size);

    // ---- looking at the screen: head roughly toward it, eyes not turned aside
    const b = obs.blend || {};
    const aside = Math.max(
      Math.min(b.eyeLookOutLeft ?? 0, b.eyeLookInRight ?? 0),
      Math.min(b.eyeLookInLeft ?? 0, b.eyeLookOutRight ?? 0),
    );
    const eyesUp = Math.min(b.eyeLookUpLeft ?? 0, b.eyeLookUpRight ?? 0);
    const deg = 180 / Math.PI;
    const toward = Math.abs(g.yaw * deg) <= o.lookYawDeg
      && g.pitch * deg <= o.lookPitchUpDeg && g.pitch * deg >= -o.lookPitchDownDeg
      && aside < o.lookEyesAside && eyesUp < 0.7
      && Math.min(b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0) < 0.85;
    if (toward) {
      this._unlookSince = null;
      if (this._lookSince === null) this._lookSince = now;
      if (!s.looking && now - this._lookSince >= o.lookOnMs) s.looking = true;
    } else {
      this._lookSince = null;
      if (this._unlookSince === null) this._unlookSince = now;
      if (s.looking && now - this._unlookSince >= o.lookOffMs) s.looking = false;
    }

    // ---- smile
    const smileRaw = ((b.mouthSmileLeft ?? 0) + (b.mouthSmileRight ?? 0)) / 2;
    s.smile += (smileRaw - s.smile) * (fresh ? 1 : 1 - Math.exp(-dt / 180));
    if (s.smile >= o.smileOn) {
      if (this._smileSince === null) this._smileSince = now;
      if (now - this._smileSince >= o.smileOnMs) s.smiling = true;
    } else {
      this._smileSince = null;
      if (s.smile <= o.smileOff) s.smiling = false;
    }

    // ---- talking: the jaw keeps opening and closing (a held-open mouth is not speech)
    const jaw = clamp01(b.jawOpen ?? 0);
    s.jaw += (jaw - s.jaw) * (fresh ? 1 : 1 - Math.exp(-dt / 80));
    this._jaw.push({ t: now, jaw });
    while (this._jaw.length && now - this._jaw[0].t > o.talkWindowMs) this._jaw.shift();
    if (this._jaw.length >= 4) {
      let moved = 0, lo = 1, hi = 0;
      for (let i = 0; i < this._jaw.length; i++) {
        const v = this._jaw[i].jaw;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        if (i > 0) moved += Math.abs(v - this._jaw[i - 1].jaw);
      }
      const span = Math.max(1, this._jaw[this._jaw.length - 1].t - this._jaw[0].t);
      // normalise to "per frame at 12 fps" so the threshold does not depend on the rate
      const perFrame = (moved / span) * (1000 / 12);
      if (!s.talking && perFrame >= o.talkOn && hi - lo >= o.talkRange) s.talking = true;
      else if (s.talking && (perFrame < o.talkOff || hi - lo < o.talkRange * 0.5)) s.talking = false;
    } else {
      s.talking = false;
    }
    return s;
  }
}

// ---------------------------------------------------------------------------------------------

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
/** @param {number} v */
function clamp01(v) {
  return clamp(v, 0, 1);
}
/** @param {number[]} a @param {number[]} b */
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
/** @param {number[]} a @param {number[]} b */
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** @param {number[]} a */
function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
/** @param {number[]} a @param {number} k */
function scale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}
