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
 * @property {[number,number,number,number]} hinge jaw centre x, half jaw width, slit y, chin y
 * @property {ReturnType<typeof faceAnchors>} face  cheek / chin / nostril-wing centres and radii
 * @property {number} px            world units per plate pixel
 */
/** @typedef {{ center:[number,number], uv:[number,number], irisR:number, height:number, discR?:number }} EyeRig  discR: the moving iris disc (iris + glow), set by the head once it has located the painted iris */

/** Tunable magnitudes, fractions of the face height (fh) / mouth half width (hw). */
export const RIG_LIMITS = {
  jawDropFh: 0.095,       // lower lip drop at jawOpen = 1
  wideCornerHw: 0.13,     // corners outward for mouthWide = 1
  jawCornerInHw: 0.06,   // the corners draw in a little as the jaw opens wide (the lips stretch down)
  wideLipFh: 0.007,       // lips part (teeth show) for wide
  roundCornerHw: 0.4,     // corners inward for mouthRound = 1 (more stretches the cheek grid)
  roundPushFh: 0.05,      // lips forward for round
  roundLipFh: 0.014,      // centre parting for round: rounded lips leave a small round orifice (the jaw sets how open)
  roundLensHw: 0.35,      // ... narrower than the corners: protruded lips meet beside it (an 'oo' about half an 'ah''s width)
  smileUpFh: 0.032,       // corners up for smile
  smileOutHw: 0.07,
  smileLidFrac: 0.12,     // lower lid squint
  browFh: 0.02,
  gazeX: 0.6,             // iris shift in iris radii (gazeX = 1: ~17 deg of eye rotation)
  gazeY: 0.45,            // (gazeY = 1: ~12.8 deg; the iris slides under the lids, which stay put)
  lidGaze: 0.25,          // upper lid travel (blink units) at gazeY = -1
  breathFh: 0.003,
  // posture and lids of the behaviour layer (lean / shiftX / squint)
  leanScale: 0.03,        // the head grows this much at lean = 1 (toward the viewer)
  leanDropFh: 0.012,      // ... and sinks a little (leaning in from a seated pose)
  shiftFh: 0.02,          // sideways shift of the head at shiftX = 1
  squintBlink: 0.42,      // a squint closes the eye this much (the lid wipe, both lids; a yawn: half shut)
  squintLowerFrac: 0.12,  // and pushes the lower lid up
  // speech channels (lip-sync): press m b p, tuck f v, teeth s z ee, tongue th l
  teethLiftFh: 0.016,     // upper lip lift for teeth = 1 (the incisors show)
  teethDropFh: 0.004,     // lower lip drop for teeth = 1
  tuckLiftFh: 0.012,      // upper lip lift for tuck (the incisor edge shows over the lower lip)
  tuckRaiseFh: 0.003,     // the lower lip rises to the upper teeth
  tuckShapeLift: 0.5,     // share of the neighbouring vowel's upper-lip lift kept under a full tuck (a narrow band of incisors)
  tuckLensHw: 0.2,        // the opening of f / v is this much narrower (the lips stay close beside the incisors)
  pressThin: 0.28,        // lip thinning at press = 1 (texture compressed toward the seam)
  pressContactPx: 2.5,    // the lips meet: the dark rest gap closes (plate px)
  tuckThin: 0.32,         // lower lip rolled in under the teeth
  tuckRisePx: 4,          // its visible edge moves up (plate px)
  teethShift: 0.6,        // the upper incisors follow a lifted upper lip by this fraction
  asymFh: 0.008,          // corner height difference at |mouthAsym| = 1
  // the face moving with the mouth
  jawUpperLipFh: 0.02,    // the upper lip rises as the jaw opens (~20 % of the lower lip: open vowels; the incisors show)
  roundThick: 0.22,       // rounded (protruded) lips look fuller: the lip texture expands
  cornerJawShare: 0.4,    // the commissures drop with this share of the jaw: the opening is a lens, the corners stay closed
  lensFull: 0.3,          // how much fuller (rounder-ended) an open / spread opening is than a small one (lens exponent)
  cheekLiftFh: 0.012,     // cheeks / nasolabial folds lift for cheekRaise = 1
  cheekOutFh: 0.004,      // ... and move a little outward
  chinLiftFh: 0.007,      // the chin boss bunches up under pressed lips (mentalis)
  nostrilPx: 3.5,         // each nostril wing moves outward (plate px) at nostrilFlare = 1
  // jaw hinge: the jaw turns about joints in front of the ears
  hingeSide: 0.55,        // its sides near the joints drop this much less than the chin
  hingeStretch: 0.12,     // the chin travels this much farther than the lips (the lower face lengthens)
  hingeBack: 0.35,        // and swings back (z) by this much of its drop, more the farther below
};

/** MediaPipe Face Mesh landmark ids of the regions the face rig moves (the relief mesh has a
 * vertex at every landmark: mesh.groups.landmarks[id]). */
const LM_CHEEK = { L: [101, 36, 205], R: [330, 266, 425] };   // the cheek's apple, beside the fold
const LM_CHIN = [18, 200, 175];
const LM_ALA = { L: [129, 64], R: [358, 294] };

/**
 * Centres (world units) of the cheeks, the chin boss and the nostril wings, from the mesh's
 * landmark vertices; estimated from the pack's few landmarks for meshes without them.
 * @param {any} pack @param {any} [mesh]
 */
export function faceAnchors(pack, mesh) {
  const W = pack.plate.width, H = pack.plate.height;
  const wx = (x) => (x - W / 2) / H, wy = (y) => (H / 2 - y) / H;
  const ids = mesh?.groups?.landmarks;
  const pos = mesh?.positions;
  const at = (list) => {
    let x = 0, y = 0;
    for (const i of list) { const v = ids[i]; x += pos[v * 3]; y += pos[v * 3 + 1]; }
    return [wx(x / list.length), wy(y / list.length)];
  };
  const lm = pack.landmarks || {};
  const r = pack.rig;
  const fh = r.faceHeight / H;
  const hw = r.mouth.halfWidth / H;
  const mouth = r.mouth.center;
  if (Array.isArray(ids) && ids.length >= 478 && pos) {
    return {
      cheekL: at(LM_CHEEK.L), cheekR: at(LM_CHEEK.R), chin: at(LM_CHIN), alaL: at(LM_ALA.L), alaR: at(LM_ALA.R),
      cheekRadius: [0.7 * hw, 0.09 * fh], chinRadius: [0.75 * hw, 0.075 * fh], alaRadius: 0.034 * fh,
    };
  }
  // estimates: cheeks above-outside the mouth corners, the chin boss half way to the chin
  const nose = lm.noseTip || [mouth[0], mouth[1] - 0.18 * r.faceHeight];
  const chin = lm.chin || [mouth[0], mouth[1] + 0.25 * r.faceHeight];
  const lower = lm.lipLower || [mouth[0], mouth[1] + 0.07 * r.faceHeight];
  const cy = 0.5 * (nose[1] + mouth[1]) - 0.06 * r.faceHeight;
  const ax = 0.42 * r.mouth.halfWidth;
  return {
    cheekL: [wx(mouth[0] - 1.75 * r.mouth.halfWidth), wy(cy)], cheekR: [wx(mouth[0] + 1.75 * r.mouth.halfWidth), wy(cy)],
    chin: [wx(mouth[0]), wy(lower[1] + 0.45 * (chin[1] - lower[1]))],
    alaL: [wx(nose[0] - ax * 2), wy(nose[1])], alaR: [wx(nose[0] + ax * 2), wy(nose[1])],
    cheekRadius: [0.7 * hw, 0.09 * fh], chinRadius: [0.75 * hw, 0.075 * fh], alaRadius: 0.034 * fh,
  };
}

/**
 * Build the world-space rig from pack.json (and the mesh, for the face regions' landmarks).
 * @param {any} pack parsed pack.json @param {any} [mesh] parsed mesh.json
 * @returns {ReliefRig}
 */
export function buildRig(pack, mesh) {
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
  const lm = pack.landmarks || {};
  const jl = lm.jawAngleL, jr = lm.jawAngleR;
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
    // hinge: centre line x, half the jaw width (angle to angle), the slit's and the chin's y
    hinge: [
      wx(jl && jr ? 0.5 * (jl[0] + jr[0]) : r.mouth.center[0]),
      (jl && jr ? 0.5 * (jr[0] - jl[0]) : 2.2 * r.mouth.halfWidth) * s,
      wy(r.mouth.center[1]),
      wy(chinY),
    ],
    face: faceAnchors(pack, mesh),
    px: s,
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
  // what the shapes alone would do to the lips (the upper lip rises a little with the jaw, too)
  const lift0 = (L.wideLipFh * wide + 0.004 * smile + L.roundLipFh * round + L.teethLiftFh * teeth
    + L.jawUpperLipFh * clamp01(a.jawOpen)) * fh;
  const drop0 = (L.wideLipFh * 1.2 * wide + L.roundLipFh * round + L.teethDropFh * teeth) * fh;
  // Pressing / tucking lips close the slit whatever the jaw does: the lower lip comes back up
  // over a slightly open jaw (the chin stays down), so a closure never leaks a dark line. The
  // parting the shapes add fades out with the square of the press: a press that is only half
  // released still holds the lips nearly together (short m / b / p stay sealed for their length).
  const openK = (1 - press) * (1 - press);
  u.upperLift = lift0 * openK * (1 - (1 - L.tuckShapeLift) * tuck) + L.tuckLiftFh * tuck * fh;
  u.lowerDrop = drop0 * Math.max(0, openK - tuck) - (press + tuck) * u.jawDrop - L.tuckRaiseFh * tuck * fh;
  // (the part of it that closes the lips over the jaw: at the corners it cancels the jaw's share)
  u.lowerClose = (press + tuck) * u.jawDrop;
  u.lipPush = L.roundPushFh * round * fh;
  // corners: x outward is -x for L, +x for R; asymmetry tilts the mouth a little
  const out = (L.wideCornerHw * wide - L.roundCornerHw * round + L.smileOutHw * smile - L.jawCornerInHw * clamp01(a.jawOpen) * clamp01(a.jawOpen)) * hw;
  const up = L.smileUpFh * smile * fh - 0.004 * round * fh;
  const tilt = L.asymFh * clamp(a.mouthAsym ?? 0, -1, 1) * fh;
  u.cornerL = u.cornerL || [0, 0];
  u.cornerR = u.cornerR || [0, 0];
  u.cornerL[0] = -out; u.cornerL[1] = up + tilt;
  u.cornerR[0] = out; u.cornerR[1] = up - tilt;
  // the lens of the opening spans the corners where they are now (wide for E); rounded lips leave
  // an orifice narrower still (the lips protrude and meet beside it: O / U)
  u.lens = u.lens || [1, L.cornerJawShare, 0.75, 0.55];
  u.lens[0] = Math.max(0.35, (1 + out / hw) * (1 - L.roundLensHw * round) * (1 - L.tuckLensHw * tuck));
  u.lens[1] = L.cornerJawShare;
  // the opening's outline: a slender almond for a small or rounded opening; an open vowel's and a
  // spread one's are fuller toward the corners (rounder ends, a flatter middle: a smaller
  // exponent of the lens profile, upper lip and lower lip)
  const jo = clamp01((clamp01(a.jawOpen) - 0.15) / 0.5);
  const full = (jo * jo * (3 - 2 * jo) + 0.5 * wide * (1 - jo)) * (1 - round);
  u.lens[2] = 0.75 - L.lensFull * full;
  u.lens[3] = 0.55 - 0.75 * L.lensFull * full;
  // the opening at the centre (plate px) for the shading of the lips' inner edges and the cavity
  const px = 1 / (rig.px ?? 1 / 1168);
  u.open = u.open || [0, 0, 1, 0.65];
  u.open[0] = Math.max(0, u.upperLift) * px;
  u.open[1] = Math.max(0, u.jawDrop + u.lowerDrop) * px;
  u.open[2] = u.lens[0];
  u.open[3] = 0.5 * (u.lens[2] + u.lens[3]);
  // lip texture warp (plate px): x upper thinning, y contact, z lower lip rise, w lower thinning
  // (pressed lips thin, rounded ones fill out: a negative thinning expands the lip texture)
  const thick = L.roundThick * round * (1 - press) * (1 - tuck);
  u.lipWarp = u.lipWarp || [0, 0, 0, 0];
  u.lipWarp[0] = L.pressThin * press - thick;
  u.lipWarp[1] = L.pressContactPx * press;
  u.lipWarp[2] = L.tuckRisePx * tuck;
  u.lipWarp[3] = L.pressThin * press + L.tuckThin * tuck - thick;
  // the face moving with the mouth (world units): cheek lift, chin boss lift, nostril wings out
  u.faceMove = u.faceMove || [0, 0, 0, 0];
  u.faceMove[0] = L.cheekLiftFh * clamp01(a.cheekRaise ?? 0) * fh;
  u.faceMove[1] = L.chinLiftFh * clamp01(a.chinRaise ?? 0) * fh;
  u.faceMove[2] = L.nostrilPx * clamp01(a.nostrilFlare ?? 0) * (rig.px ?? 1 / 1168);
  u.faceMove[3] = L.cheekOutFh * clamp01(a.cheekRaise ?? 0) * fh;
  u.tongue = clamp01(a.mouthTongue ?? 0) * (1 - press);
  u.tuck = tuck;
  // the upper incisors follow a lifted upper lip part of the way (world units); in a tuck they
  // fill the small opening down to the lower lip that touches them
  u.teethShift = L.teethShift * lift0 * openK + 1.1 * L.tuckLiftFh * tuck * fh;
  // eyelids (world units, + = toward closing); the upper lid follows a downward gaze part of the
  // way (lidGaze of its travel at gazeY = -1; nothing at rest)
  const lidG = L.lidGaze * clamp01(-(a.gazeY ?? 0));
  const squint = clamp01(a.squint ?? 0);
  const sq = 1 - L.squintBlink * squint;
  const bl = 1 - (1 - clamp01(a.blinkL)) * (1 - lidG) * sq, br = 1 - (1 - clamp01(a.blinkR)) * (1 - lidG) * sq;
  const eL = rig.eyes.L.height, eR = rig.eyes.R.height;
  const lt = rig.lidTravel ?? 1;
  u.lids = u.lids || [0, 0, 0, 0];
  u.lids[0] = lt * bl * eL;
  u.lids[1] = (lt * bl + L.smileLidFrac * smile + L.squintLowerFrac * squint) * eL;
  u.lids[2] = lt * br * eR;
  u.lids[3] = (lt * br + L.smileLidFrac * smile + L.squintLowerFrac * squint) * eR;
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
  // posture: sideways shift, lean (scale about the head pivot, sinking a little); 0 / 1 at rest
  const lean = clamp(a.lean ?? 0, -1, 1);
  u.headXform = u.headXform || [0, 0, 1];
  u.headXform[0] = L.shiftFh * clamp(a.shiftX ?? 0, -1, 1) * fh;
  u.headXform[1] = -L.leanDropFh * lean * fh;
  u.headXform[2] = 1 + L.leanScale * lean;
  return u;
}

/**
 * The upper incisors' crowns in the pack's mouth texture (its upper half is the cavity with the
 * upper teeth along its top): the brightest band of rows across the middle fifth, where the mean
 * luminance exceeds 45 % of its peak. Fractions of the texture height (0 = top row), or null.
 * @param {Uint8ClampedArray|Uint8Array} rgba @param {number} w @param {number} h
 * @returns {{ top: number, bottom: number }|null}
 */
export function incisorBand(rgba, w, h) {
  const x0 = Math.floor(0.4 * w), x1 = Math.ceil(0.6 * w), rows = h >> 1;
  const lum = new Float32Array(rows);
  let peak = 0, pr = -1;
  for (let y = 0; y < rows; y++) {
    let acc = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      acc += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    }
    lum[y] = acc / ((x1 - x0) * 255);
    if (lum[y] > peak) { peak = lum[y]; pr = y; }
  }
  if (pr < 0 || peak < 0.2) return null;
  let a = pr, b = pr;
  while (a > 0 && lum[a - 1] > 0.45 * peak) a--;
  while (b + 1 < rows && lum[b + 1] > 0.45 * peak) b++;
  return { top: a / h, bottom: (b + 1) / h };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
