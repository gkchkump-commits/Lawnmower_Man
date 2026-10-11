// What the simulated camera "sees": a grid of pre-encoded 1-second GOPs, one per pan/tilt
// position, cut from one panorama (contract §11.3). Shared by make-fixtures.mjs (which renders the
// grid) and the RTSP server (which picks the segment nearest to the virtual position).
//
// Positions are ONVIF generic-space units in [-1, 1]. The grid index is the PHYSICAL direction the
// lens points to (i > 0: turned right, j > 0: turned up); the quirks mirrorPan / invertTilt sit
// between the ONVIF position and that direction, exactly like on the real camera.
//
// Truth the calibration is checked against: one pan grid step is 0.1 units and moves the crop by
// 80 px of a 640 px view, so a full view width is 0.8 units (viewUnitsX); one tilt step is 0.2
// units and 60 px of a 360 px view, so a full view height is 1.2 units (viewUnitsY). The grid
// spans ±0.4 units on both axes; beyond that the edge segment is shown (the camera keeps turning
// and GetStatus says so, the picture just stops changing).

export const VIEW = Object.freeze({ width: 640, height: 360 });
export const SUB_VIEW = Object.freeze({ width: 320, height: 180 });
export const FPS = 15;
export const GOP_FRAMES = 15;

export const PAN_STEPS = 4; // i = -4..4
export const TILT_STEPS = 2; // j = -2..2
export const PAN_STEP_UNITS = 0.1;
export const TILT_STEP_UNITS = 0.2;
export const PAN_STEP_PX = 80;
export const TILT_STEP_PX = 60;

/** The panorama the crops come from (stream1 pixels). */
export const PANO = Object.freeze({
  width: VIEW.width + 2 * PAN_STEPS * PAN_STEP_PX, // 1280
  height: VIEW.height + 2 * TILT_STEPS * TILT_STEP_PX, // 600
});

/** The person variants exist for this neighbourhood of the centre (i, j in -1..1). */
export const PERSON_STEPS = 1;

/** Ground truth for calibration checks (ONVIF units per full view width/height, per §4 names). */
export const SIM_TRUTH = Object.freeze({
  viewUnitsX: (VIEW.width / PAN_STEP_PX) * PAN_STEP_UNITS, // 0.8
  viewUnitsY: (VIEW.height / TILT_STEP_PX) * TILT_STEP_UNITS, // 1.2
  minEffectiveStep: 0.05,
  panUnitsPerSec: 0.35,
  tiltUnitsPerSec: 0.25,
});

/** Round half away from zero, tolerant of float noise (0.05 / 0.1 = 0.4999999…). @param {number} v */
export function roundHalfAway(v) {
  return Math.sign(v) * Math.floor(Math.abs(v) + 0.5 + 1e-9);
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Grid cell for a position, already converted to the physical direction.
 * @param {number} pan physical pan (units, + = right) @param {number} tilt physical tilt (+ = up)
 * @returns {{ i: number, j: number }}
 */
export function gridCell(pan, tilt) {
  const i = clamp(roundHalfAway(pan / PAN_STEP_UNITS), -PAN_STEPS, PAN_STEPS);
  const j = clamp(roundHalfAway(tilt / TILT_STEP_UNITS), -TILT_STEPS, TILT_STEPS);
  return { i: i || 0, j: j || 0 }; // no -0 in file names
}

/**
 * Grid cell while a motor runs. Real video changes on every frame while the camera turns (the
 * scene slides and blurs); the grid would instead rest on one cell for several frames between
 * steps, and a "has the picture settled?" check (calibration) would then measure mid-move. So
 * for each axis that is turning, odd and even frames show the two cells on either side of the
 * position (floor / ceil); an axis at rest shows its nearest cell. On a cell exactly, or past the
 * end of the grid, both sides are the same cell and the picture holds still.
 * @param {number} pan @param {number} tilt physical direction, as gridCell
 * @param {{ x: boolean, y: boolean }} moving which axes are turning @param {number} frameNo
 * @returns {{ i: number, j: number }}
 */
export function gridCellMoving(pan, tilt, moving, frameNo) {
  const near = gridCell(pan, tilt);
  const side = (/** @type {number} */ u) => (frameNo % 2 ? Math.ceil(u - 1e-9) : Math.floor(u + 1e-9));
  const i = moving.x ? clamp(side(pan / PAN_STEP_UNITS), -PAN_STEPS, PAN_STEPS) : near.i;
  const j = moving.y ? clamp(side(tilt / TILT_STEP_UNITS), -TILT_STEPS, TILT_STEPS) : near.j;
  return { i: i || 0, j: j || 0 };
}

/** Segment id of a grid cell: 'p-1_t0', 'p0_t0_person'. @param {number} i @param {number} j @param {boolean} [person] */
export function segmentId(i, j, person = false) {
  return `p${i}_t${j}${person ? '_person' : ''}`;
}

/** Top-left of the crop of cell (i, j) in panorama pixels (stream1 scale). @param {number} i @param {number} j */
export function cropOrigin(i, j) {
  return {
    x: PAN_STEPS * PAN_STEP_PX + i * PAN_STEP_PX,
    y: TILT_STEPS * TILT_STEP_PX - j * TILT_STEP_PX, // looking up moves the window up
  };
}

/** Every cell of the grid. @returns {Array<{ i: number, j: number }>} */
export function allCells() {
  const out = [];
  for (let j = -TILT_STEPS; j <= TILT_STEPS; j++) for (let i = -PAN_STEPS; i <= PAN_STEPS; i++) out.push({ i, j });
  return out;
}

/** Cells that also have a person variant. */
export function personCells() {
  return allCells().filter(({ i, j }) => Math.abs(i) <= PERSON_STEPS && Math.abs(j) <= PERSON_STEPS);
}

/**
 * The walking figure: pure green (0,255,0) boxes on a transparent canvas, which the stub person
 * detector (LAWNMOWER_TAPO_FAKE_DETECTOR=1) looks for; nothing else in the scene is green (the
 * panorama is rendered grey-blue). It stands in the middle of the room (panorama pixels, stream1
 * scale) and walks right at `pxPerSec` during each 1-second GOP, so the person segments also
 * carry motion for the local motion detector.
 */
export const PERSON = Object.freeze({
  x: 586, // canvas left at t = 0
  y: 236,
  width: 48,
  height: 188, // 52 % of the view height: someone a few metres from the camera
  pxPerSec: 90,
  boxes: Object.freeze([
    { x: 10, y: 0, w: 28, h: 28 }, // head
    { x: 0, y: 30, w: 48, h: 104 }, // body
    { x: 0, y: 134, w: 18, h: 54 }, // legs
    { x: 30, y: 134, w: 18, h: 54 },
  ]),
});
