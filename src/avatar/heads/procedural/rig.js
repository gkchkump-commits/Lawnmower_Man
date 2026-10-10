// Procedural head rig math (PURE: no three.js / DOM): AnimState -> shader uniform values.
// World units are the stage's (view 1 unit tall at the focal plane); angles in radians.

/** Tunable magnitudes. fh = face height (forehead landmark -> chin), hw = mouth half width. */
export const PROC_LIMITS = Object.freeze({
  jawAngle: 0.15,          // jaw rotation at jawOpen = 1 (lower lip drops ~0.055 units)
  wideJawAngle: 0.025,     // lips part a little for wide visemes (E / I / S)
  wideCornerHw: 0.12,      // corners outward for mouthWide = 1
  jawCornerInHw: 0.06,     // the corners draw in a little as the jaw opens wide (the lips stretch down)
  wideLipFh: 0.006,        // upper lip lift / lower lip drop for wide
  roundCornerHw: 0.3,      // corners inward for mouthRound = 1
  roundPushFh: 0.03,       // lips forward for round
  smileUpFh: 0.03,         // corners up for smile
  smileOutHw: 0.09,
  smileBackFh: 0.012,      // corners back into the cheeks
  cheekFh: 0.012,          // cheek raise for smile
  squint: 0.18,            // lower lid rises with smile (fraction of the aperture)
  browFh: 0.022,           // brow lift for browUp = 1
  gazeYaw: 0.33,           // eyeball rotation at gazeX = +-1
  gazePitch: 0.22,
  vergence: 0.025,         // slight convergence (eyes look at a point in front of the face)
  breathFh: 0.004,
  // speech channels (lip-sync): press m b p, tuck f v, teeth s z ee, tongue th l
  teethLiftFh: 0.011,      // upper lip lift for teeth = 1 (the incisors show)
  tuckLiftFh: 0.011,       // upper lip lift for tuck (the incisor edge shows)
  tuckRaiseFh: 0.004,      // the lower lip rises to the upper teeth...
  tuckBackFh: 0.012,       // ...and draws back under them
  tuckShapeLift: 0.5,      // share of the neighbouring vowel's upper-lip lift kept under a full tuck (as the relief head)
  pressThinFh: 0.005,      // pressed lips thin toward the seam...
  pressInFh: 0.004,        // ...and flatten (the seam itself stays: the cavity must not show)
  jawLipK: 0.37,           // lower-lip drop per radian of jaw rotation (cancelled by a closure)
  asymFh: 0.008,           // corner height difference at |mouthAsym| = 1
  // the face moving with the mouth
  jawUpperLipFh: 0.01,     // the upper lip rises a little as the jaw opens
  chinLiftFh: 0.008,       // the chin boss bunches up under pressed lips (mentalis)
  nostrilFh: 0.006,        // each nostril wing moves outward at nostrilFlare = 1
});

/**
 * Rotation R = Rz(roll) * Ry(yaw) * Rx(-pitch) as a column-major 3x3 (THREE.Matrix3#elements).
 * yaw > 0 turns the face toward screen right, pitch > 0 looks up, roll > 0 tilts
 * counter-clockwise on screen (director.js conventions).
 * @param {number} yaw @param {number} pitch @param {number} roll @param {Float32Array|number[]} out
 */
export function rotationYPR(yaw, pitch, roll, out) {
  const ax = -pitch;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  const m00 = cz * cy, m01 = cz * sy * sx - sz * cx, m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy, m11 = sz * sy * sx + cz * cx, m12 = sz * sy * cx - cz * sx;
  const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
  out[0] = m00; out[1] = m10; out[2] = m20;
  out[3] = m01; out[4] = m11; out[5] = m21;
  out[6] = m02; out[7] = m12; out[8] = m22;
  return out;
}

/** Rotation about +X by `a` (positive opens the jaw: the chin moves down and back). */
export function rotationX(a, out) {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = 1; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = c; out[5] = s;
  out[6] = 0; out[7] = -s; out[8] = c;
  return out;
}

/** Column-major mat3 * vec3 into out (length 3). */
export function mulMat3Vec3(m, v, out) {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[3] * y + m[6] * z;
  out[1] = m[1] * x + m[4] * y + m[7] * z;
  out[2] = m[2] * x + m[5] * y + m[8] * z;
  return out;
}

/**
 * @typedef {Object} ProcRig
 * @property {number} faceH  @property {number} mouthHW
 * @property {[number,number,number]} jawPivot  @property {[number,number,number]} headPivot
 * @property {{axisX:number[], axisY:number[], axisZ:number[]}[]} eyes
 */

/** @param {any} meta head.json @returns {ProcRig} */
export function buildProcRig(meta) {
  const r = meta.rig;
  const fh = r.faceHeight, hw = r.mouthHalfWidth;
  const mc = r.mouthCenter;
  const chinY = r.chinY ?? mc[1] - 0.27 * fh;
  const nose = meta.features?.noseTip ?? [mc[0], mc[1] + 0.17 * fh, mc[2] + 0.07];
  return {
    faceH: fh,
    mouthHW: hw,
    jawPivot: [...r.jawPivot],
    headPivot: [...r.headPivot],
    eyes: meta.eyes.map((e) => ({ axisX: [...e.axisX], axisY: [...e.axisY], axisZ: [...e.axisZ] })),
    // the chin boss (x, y, radii) between the lower lip and the chin, and the nostril wings
    // (|x| from the midline, y, radius, the front z they sit at)
    chin: [mc[0], mc[1] + 0.6 * (chinY - mc[1]), 0.8 * hw, 0.065 * fh],
    ala: [0.45 * hw, nose[1] - 0.02 * fh, 0.035 * fh, nose[2] - 0.03],
  };
}

/**
 * CPU mirror of HEAD_VERT's deformation (shaders.js) for one vertex — used by tests and any
 * CPU-side picking. Head rotation is not included (it is a rigid transform on top).
 * @param {ArrayLike<number>} p rest position (3)
 * @param {ArrayLike<number>} w rig weights 0..1 in RIG_CHANNELS order (8)
 * @param {any} u procRigUniforms() output
 * @param {ProcRig} rig
 * @param {number[]|Float32Array} out (3)
 * @param {number} [seam] lip-seam closeness 0..1 (aExtra.y; pressed lips thin toward the seam)
 */
export function deformVertex(p, w, u, rig, out, seam = 0) {
  let x = p[0], y = p[1], z = p[2];
  x += w[3] * u.cornerL[0] + w[4] * u.cornerR[0];
  y += w[3] * u.cornerL[1] + w[4] * u.cornerR[1];
  z += w[3] * u.cornerL[2] + w[4] * u.cornerR[2];
  y += w[1] * u.lips[0] - w[2] * u.lips[1];
  z += (w[1] + w[2]) * u.lips[2];
  const mx = u.mouthX || [0, 0, 0, 0];
  y += (w[2] - w[1]) * mx[0] * (1 - seam);
  z -= (w[1] + w[2]) * mx[1] * (1 - seam) + w[2] * mx[2];
  y += w[5] * u.brow[0] + w[6] * u.brow[1];
  y += w[7] * u.lips[3];
  z += w[7] * u.lips[3] * 0.35;
  const f = u.face || [0, 0, 0, 0];
  if (f[0] + f[1] > 0) {
    // chin boss (on the jaw, not the lower lip) and nostril wings (on the front of the face)
    const c = rig.chin, al = rig.ala;
    const cx = (p[0] - c[0]) / c[2], cy = (p[1] - c[1]) / c[3];
    y += Math.exp(-(cx * cx + cy * cy)) * w[0] * (1 - w[2]) * f[0];
    const ax = (Math.abs(p[0]) - al[0]) / al[2], ay = (p[1] - al[1]) / al[2];
    const front = smoothstep(al[3] - 0.06, al[3], p[2]);
    x += Math.sign(p[0]) * Math.exp(-(ax * ax + ay * ay)) * front * f[1];
  }
  const jp = rig.jawPivot, m = u.jawRot;
  const rx = x - jp[0], ry = y - jp[1], rz = z - jp[2];
  const jx = jp[0] + m[0] * rx + m[3] * ry + m[6] * rz;
  const jy = jp[1] + m[1] * rx + m[4] * ry + m[7] * rz;
  const jz = jp[2] + m[2] * rx + m[5] * ry + m[8] * rz;
  out[0] = x + (jx - x) * w[0];
  out[1] = y + (jy - y) * w[0];
  out[2] = z + (jz - z) * w[0];
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Compute every rig uniform for an AnimState. Writes into `u` (allocates only on first use)
 * and returns it.
 *   jawRot, headRot: Float32Array(9) column-major
 *   cornerL, cornerR: [x, y, z] displacement   lips: [upperLift, lowerDrop, push, cheek]
 *   brow: [L, R]   breathY   blink: [L, R]   squint   gaze: Float32Array(6) two unit vectors
 * @param {ProcRig} rig @param {import('../../director.js').AnimState} a @param {any} u
 */
export function procRigUniforms(rig, a, u) {
  const L = PROC_LIMITS;
  const fh = rig.faceH, hw = rig.mouthHW;
  const jaw = clamp01(a.jawOpen), wide = clamp01(a.mouthWide), round = clamp01(a.mouthRound);
  const smile = clamp01(a.smile);
  const press = clamp01(a.mouthPress ?? 0), teeth = clamp01(a.mouthTeeth ?? 0);
  const tuck = clamp01(a.mouthTuck ?? 0) * (1 - press);       // a closure wins over a tuck
  u.jawAngle = L.jawAngle * jaw + L.wideJawAngle * wide * (1 - jaw);
  u.jawRot = rotationX(u.jawAngle, u.jawRot || new Float32Array(9));
  u.headRot = rotationYPR(a.headYaw, a.headPitch, a.headRoll, u.headRot || new Float32Array(9));
  const out = (L.wideCornerHw * wide - L.roundCornerHw * round + L.smileOutHw * smile - L.jawCornerInHw * jaw * jaw) * hw;
  const up = (L.smileUpFh * smile - 0.004 * round) * fh;
  const back = (-L.smileBackFh * smile + 0.01 * round) * fh;
  const tilt = L.asymFh * clamp(a.mouthAsym ?? 0, -1, 1) * fh;
  u.cornerL = u.cornerL || [0, 0, 0];
  u.cornerR = u.cornerR || [0, 0, 0];
  u.cornerL[0] = -out; u.cornerL[1] = up + tilt; u.cornerL[2] = back;
  u.cornerR[0] = out; u.cornerR[1] = up - tilt; u.cornerR[2] = back;
  u.lips = u.lips || [0, 0, 0, 0];
  // pressing / tucking lips stay closed over a slightly open jaw (the lower lip comes back up);
  // the upper lip rises a little with the jaw too (open vowels). The shapes' parting fades with
  // the square of the press (as on the relief head: a half-released press still seals).
  const lift0 = (L.wideLipFh * wide + 0.004 * smile + L.teethLiftFh * teeth + L.jawUpperLipFh * jaw) * fh;
  const openK = (1 - press) * (1 - press);
  u.lips[0] = lift0 * openK * (1 - (1 - L.tuckShapeLift) * tuck) + L.tuckLiftFh * tuck * fh;      // upper lift
  u.lips[1] = L.wideLipFh * 1.2 * wide * fh * Math.max(0, openK - tuck)    // lower drop
    - (press + tuck) * L.jawLipK * u.jawAngle - L.tuckRaiseFh * tuck * fh;
  u.lips[2] = L.roundPushFh * round * fh;                         // push forward
  // cheek raise: smiles, and the spread vowels of speech (the director's cheekRaise)
  u.lips[3] = L.cheekFh * Math.max(smile, clamp01(a.cheekRaise ?? 0)) * fh;
  // chin boss lift (mentalis, pressed lips) and nostril wings out (a breath in), world units
  u.face = u.face || [0, 0, 0, 0];
  u.face[0] = L.chinLiftFh * clamp01(a.chinRaise ?? 0) * fh;
  u.face[1] = L.nostrilFh * clamp01(a.nostrilFlare ?? 0) * fh;
  // press thinning, press roll-in, tuck draw-back (world units), tongue tip amount
  u.mouthX = u.mouthX || [0, 0, 0, 0];
  u.mouthX[0] = L.pressThinFh * press * fh;
  u.mouthX[1] = L.pressInFh * press * fh;
  u.mouthX[2] = L.tuckBackFh * tuck * fh;
  u.mouthX[3] = clamp01(a.mouthTongue ?? 0) * (1 - press);
  u.brow = u.brow || [0, 0];
  u.brow[0] = u.brow[1] = L.browFh * clamp01(a.browUp) * fh;
  u.breathY = (a.breath - 0.5) * L.breathFh * fh;
  u.blink = u.blink || [0, 0];
  // the upper lid follows a downward gaze part of the way (nothing at rest)
  const lidG = 0.25 * clamp01(-(a.gazeY ?? 0));
  u.blink[0] = 1 - (1 - clamp01(a.blinkL)) * (1 - lidG);
  u.blink[1] = 1 - (1 - clamp01(a.blinkR)) * (1 - lidG);
  u.squint = L.squint * smile;
  // gaze directions in the head's rest frame
  const gx = Math.tan(clamp(a.gazeX, -1, 1) * L.gazeYaw);
  const gy = Math.tan(clamp(a.gazeY, -1, 1) * L.gazePitch);
  u.gaze = u.gaze || new Float32Array(6);
  for (let i = 0; i < 2; i++) {
    const e = rig.eyes[i];
    const verg = (i === 0 ? 1 : -1) * L.vergence;    // screen-left eye looks a little right
    let x = e.axisZ[0] + e.axisX[0] * (gx + verg) + e.axisY[0] * gy;
    let y = e.axisZ[1] + e.axisX[1] * (gx + verg) + e.axisY[1] * gy;
    let z = e.axisZ[2] + e.axisX[2] * (gx + verg) + e.axisY[2] * gy;
    const n = Math.hypot(x, y, z) || 1;
    x /= n; y /= n; z /= n;
    u.gaze[i * 3] = x; u.gaze[i * 3 + 1] = y; u.gaze[i * 3 + 2] = z;
  }
  return u;
}
