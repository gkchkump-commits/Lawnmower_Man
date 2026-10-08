// Relief rig math (pure): converts an AnimState into shader uniform values.
// All outputs are in relief WORLD units (plate is 1 unit tall, y up, z toward the camera).

/**
 * @typedef {Object} ReliefRig     rig geometry in world units (built by buildRig)
 * @property {number} faceH         face height (forehead top -> chin)
 * @property {number} mouthHalfW
 * @property {[number,number]} mouthCenter
 * @property {[number,number,number]} jawPivot   temporomandibular joint (informational)
 * @property {[number,number,number]} headPivot
 * @property {{L: EyeRig, R: EyeRig}} eyes
 * @property {number} plateW        plate width/height ratio (uv x scale)
 * @property {[number,number]} neckBand world y range over which the head rotation fades in
 *           (the neck below [0] stays put, everything above [1] turns with the head)
 * @property {number} lidTravel     geometric lid travel per unit blink (0 when the pack has a lid
 *           map: the blink is a texture wipe, so no texels may shift; 1 for older packs)
 */
/** @typedef {{ center:[number,number], uv:[number,number], irisR:number, height:number }} EyeRig */

/** Tunable magnitudes, fractions of the face height (fh) / mouth half width (hw). */
export const RIG_LIMITS = {
  jawDropFh: 0.095,       // lower lip drop at jawOpen = 1
  wideCornerHw: 0.11,     // corners outward for mouthWide = 1
  wideLipFh: 0.007,       // lips part (teeth show) for wide
  roundCornerHw: 0.4,     // corners inward for mouthRound = 1
  roundPushFh: 0.035,     // lips forward for round
  roundLipFh: 0.015,      // centre parting for round (the lip weights are 0 at the corners)
  smileUpFh: 0.032,       // corners up for smile
  smileOutHw: 0.07,
  smileLidFrac: 0.12,     // lower lid squint
  browFh: 0.02,
  gazeX: 0.6,             // iris shift in iris radii
  gazeY: 0.24,
  breathFh: 0.003,
  // speech channels (lip-sync): press m b p, tuck f v, teeth s z ee, tongue th l
  teethLiftFh: 0.012,     // upper lip lift for teeth = 1 (the incisors show)
  teethDropFh: 0.004,     // lower lip drop for teeth = 1
  tuckLiftFh: 0.012,      // upper lip lift for tuck (the incisor edge shows over the lower lip)
  tuckRaiseFh: 0.003,     // the lower lip rises to the upper teeth
  pressThin: 0.28,        // lip thinning at press = 1 (texture compressed toward the seam)
  pressContactPx: 2.5,    // the lips meet: the dark rest gap closes (plate px)
  tuckThin: 0.32,         // lower lip rolled in under the teeth
  tuckRisePx: 4,          // its visible edge moves up (plate px)
  teethShift: 0.6,        // the upper incisors follow a lifted upper lip by this fraction
  asymFh: 0.008,          // corner height difference at |mouthAsym| = 1
};

/**
 * Build the world-space rig from pack.json.
 * @param {any} pack parsed pack.json
 * @returns {ReliefRig}
 */
export function buildRig(pack) {
  const W = pack.plate.width, H = pack.plate.height;
  const s = 1 / H;
  const wx = (x) => (x - W / 2) * s, wy = (y) => (H / 2 - y) * s, wz = (z) => z * s;
  const r = pack.rig;
  const faceH = r.faceHeight * s;
  const chinY = pack.framing?.chinY ?? r.chinY ?? H * 0.8;
  const jawPivot = /** @type {[number,number,number]} */ ([wx(r.jawPivot[0]), wy(r.jawPivot[1]), wz(r.jawPivot[2])]);
  const eye = (e) => ({
    center: /** @type {[number,number]} */ ([wx(e.center[0]), wy(e.center[1])]),
    uv: /** @type {[number,number]} */ ([e.center[0] / W, 1 - e.center[1] / H]),
    irisR: e.irisRadius * s,
    height: (e.height ?? 30) * s,
  });
  return {
    faceH,
    mouthHalfW: r.mouth.halfWidth * s,
    mouthCenter: /** @type {[number,number]} */ ([wx(r.mouth.center[0]), wy(r.mouth.center[1])]),
    jawPivot,
    headPivot: [wx(r.headPivot[0]), wy(r.headPivot[1]), wz(r.headPivot[2])],
    eyes: { L: eye(r.eyes.L), R: eye(r.eyes.R) },
    plateW: W / H,
    neckBand: [wy(chinY) - 0.12, wy(chinY) - 0.01],
    lidTravel: pack.files?.masksC ? 0 : 1,
  };
}

/**
 * Euler (yaw about +Y, pitch looking up, roll counter-clockwise on screen) -> column-major mat3.
 * Matches THREE.Matrix3#elements layout. Writes into `out` (length 9) and returns it.
 * @param {number} yaw @param {number} pitch @param {number} roll @param {Float32Array|number[]} out
 */
export function headRotation(yaw, pitch, roll, out) {
  const ax = -pitch; // looking up = negative rotation about +X (nose moves up)
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  // R = Rz * Ry * Rx (row-major m[r][c] below)
  const m00 = cz * cy, m01 = cz * sy * sx - sz * cx, m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy, m11 = sz * sy * sx + cz * cx, m12 = sz * sy * cx - cz * sx;
  const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
  out[0] = m00; out[1] = m10; out[2] = m20;
  out[3] = m01; out[4] = m11; out[5] = m21;
  out[6] = m02; out[7] = m12; out[8] = m22;
  return out;
}

/**
 * Compute every rig uniform for an AnimState. Writes into `u` (plain numbers / arrays, no
 * allocation after the first call) and returns it.
 * @param {ReliefRig} rig @param {import('../../director.js').AnimState} a @param {any} u
 */
export function rigUniforms(rig, a, u) {
  const L = RIG_LIMITS;
  const fh = rig.faceH, hw = rig.mouthHalfW;
  u.jawDrop = L.jawDropFh * fh * clamp01(a.jawOpen);
  const wide = clamp01(a.mouthWide), round = clamp01(a.mouthRound), smile = clamp01(a.smile);
  const press = clamp01(a.mouthPress ?? 0), teeth = clamp01(a.mouthTeeth ?? 0);
  const tuck = clamp01(a.mouthTuck ?? 0) * (1 - press);     // a closure wins over a tuck
  // what the shapes alone would do to the lips
  const lift0 = (L.wideLipFh * wide + 0.004 * smile + L.roundLipFh * round + L.teethLiftFh * teeth) * fh;
  const drop0 = (L.wideLipFh * 1.2 * wide + L.roundLipFh * round + L.teethDropFh * teeth) * fh;
  // Pressing / tucking lips close the slit whatever the jaw does: the lower lip comes back up
  // over a slightly open jaw (the chin stays down), so a closure never leaks a dark line.
  u.upperLift = lift0 * (1 - press) + L.tuckLiftFh * tuck * fh;
  u.lowerDrop = drop0 * (1 - press - tuck) - (press + tuck) * u.jawDrop - L.tuckRaiseFh * tuck * fh;
  u.lipPush = L.roundPushFh * round * fh;
  // corners: x outward is -x for L, +x for R; asymmetry tilts the mouth a little
  const out = (L.wideCornerHw * wide - L.roundCornerHw * round + L.smileOutHw * smile) * hw;
  const up = L.smileUpFh * smile * fh - 0.004 * round * fh;
  const tilt = L.asymFh * clamp(a.mouthAsym ?? 0, -1, 1) * fh;
  u.cornerL = u.cornerL || [0, 0];
  u.cornerR = u.cornerR || [0, 0];
  u.cornerL[0] = -out; u.cornerL[1] = up + tilt;
  u.cornerR[0] = out; u.cornerR[1] = up - tilt;
  // lip texture warp (plate px): x upper thinning, y contact, z lower lip rise, w lower thinning
  u.lipWarp = u.lipWarp || [0, 0, 0, 0];
  u.lipWarp[0] = L.pressThin * press;
  u.lipWarp[1] = L.pressContactPx * press;
  u.lipWarp[2] = L.tuckRisePx * tuck;
  u.lipWarp[3] = L.pressThin * press + L.tuckThin * tuck;
  u.tongue = clamp01(a.mouthTongue ?? 0) * (1 - press);
  // the upper incisors follow a lifted upper lip part of the way (world units); in a tuck they
  // fill the small opening down to the lower lip that touches them
  u.teethShift = L.teethShift * lift0 * (1 - press) + 1.1 * L.tuckLiftFh * tuck * fh;
  // eyelids (world units, + = toward closing)
  const bl = clamp01(a.blinkL), br = clamp01(a.blinkR);
  const eL = rig.eyes.L.height, eR = rig.eyes.R.height;
  const lt = rig.lidTravel ?? 1;
  u.lids = u.lids || [0, 0, 0, 0];
  u.lids[0] = lt * bl * eL;
  u.lids[1] = (lt * bl + L.smileLidFrac * smile) * eL;
  u.lids[2] = lt * br * eR;
  u.lids[3] = (lt * br + L.smileLidFrac * smile) * eR;
  u.brows = u.brows || [0, 0];
  u.brows[0] = u.brows[1] = L.browFh * clamp01(a.browUp) * fh;
  // gaze: iris offset in plate UV units (x uses the plate aspect)
  const gx = clamp(a.gazeX, -1, 1), gy = clamp(a.gazeY, -1, 1);
  const ir = 0.5 * (rig.eyes.L.irisR + rig.eyes.R.irisR);
  u.gaze = u.gaze || [0, 0];
  u.gaze[0] = (gx * L.gazeX * ir) / rig.plateW;
  u.gaze[1] = gy * L.gazeY * ir;
  u.blink = u.blink || [0, 0];
  u.blink[0] = bl; u.blink[1] = br;
  u.headRot = headRotation(a.headYaw, a.headPitch, a.headRoll, u.headRot || new Float32Array(9));
  u.breathY = (a.breath - 0.5) * L.breathFh * fh;
  return u;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
