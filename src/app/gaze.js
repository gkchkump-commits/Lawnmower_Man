// Cursor → avatar gaze (avatar.lookAt takes -1..1, y up, in canvas space).
//
// Inside the avatar stage the eyes track the pointer exactly as before. Outside it (the global
// cursor from the main process can be anywhere on the desktop) the gaze keeps pointing toward
// the cursor but its strength falls off gently with distance, so a cursor across the screen
// gives a relaxed sideways look instead of eyes pinned to the corners.

/** Gaze strength far away from the stage (0..1). */
export const FAR_GAZE = 0.45;
/** Distance (in stage half-sizes beyond the stage edge) at which half of the falloff has happened. */
export const FALLOFF_HALF = 3;

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
  // outside: project onto the stage edge (keeps the direction, continuous at the edge), then
  // ease the strength from 1 at the edge toward FAR_GAZE far away
  const falloff = 1 - (1 - FAR_GAZE) * (1 - 1 / (1 + (e - 1) / FALLOFF_HALF));
  return [(nx / e) * falloff, (ny / e) * falloff];
}
