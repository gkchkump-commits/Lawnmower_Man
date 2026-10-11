// Cursor → avatar gaze (avatar.lookAt takes -1..1, y up, in canvas space).
//
// Inside the avatar stage the eyes track the pointer exactly as before. Outside it (the global
// cursor from the main process can be anywhere on the desktop) the gaze points toward the cursor:
// its direction, projected onto the stage edge, at full strength. The strength used to ease off
// with distance (a relaxed sideways look for a cursor across the screen), but a strength that
// shrinks with distance grows as the cursor comes closer, so a cursor approaching the window
// turned the eyes away from it first (audit D15). The look is not held forever anyway: it relaxes
// 5 s after the cursor stops (src/main.js), and the head now takes a share of a large look, so the
// eyes are not pinned to the corners of the eye.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {number} x  cursor x in CSS px (same coordinate space as `rect`)
 * @param {number} y  cursor y in CSS px
 * @param {{ left: number, top: number, width: number, height: number }} rect  the avatar stage
 * @returns {[number, number]|null}  [gx, gy] for avatar.lookAt, or null when not computable
 */
export function gazeFromPoint(x, y, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const nx = ((x - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((y - rect.top) / rect.height) * 2;
  // distance from the stage centre in "stage half-sizes" (1 = on the edge)
  const e = Math.max(Math.abs(nx), Math.abs(ny));
  if (e <= 1) return [clamp(nx, -1, 1), clamp(ny, -1, 1)];
  // outside: project onto the stage edge (keeps the direction, continuous at the edge; each
  // component moves the same way as the cursor)
  return [nx / e, ny / e];
}
