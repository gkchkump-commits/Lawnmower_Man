// Where the video sits in the live view, and what a click means (pure; shared by the worker,
// which draws the frames, and the page, which turns clicks into click-to-center commands and
// draws the person boxes). The video is letterboxed: scaled to fit, centred, its aspect kept;
// the bars around it are not part of the picture.

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

/**
 * The rectangle a srcW×srcH video occupies inside a dstW×dstH box (same units as dst).
 * @param {number} srcW @param {number} srcH @param {number} dstW @param {number} dstH
 * @returns {Rect}
 */
export function letterbox(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0) || !(srcH > 0) || !(dstW > 0) || !(dstH > 0)) return { x: 0, y: 0, width: Math.max(0, dstW || 0), height: Math.max(0, dstH || 0) };
  const k = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * k;
  const height = srcH * k;
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height };
}

/**
 * A pointer position → (u, v) in the video, 0..1 (u right, v down), or null when it is on a
 * letterbox bar or outside.
 * @param {number} px @param {number} py   pointer position, in the box's coordinates
 * @param {number} boxW @param {number} boxH  the live view box
 * @param {number} videoW @param {number} videoH  the video's size (any unit, only the aspect counts)
 * @returns {{ u: number, v: number }|null}
 */
export function uvAt(px, py, boxW, boxH, videoW, videoH) {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const r = letterbox(videoW, videoH, boxW, boxH);
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const u = (px - r.x) / r.width;
  const v = (py - r.y) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}

/**
 * A box in video fractions ([x, y, w, h], 0..1) → a rectangle in the live view box.
 * @param {[number, number, number, number]} box @param {Rect} video  letterbox() of the view
 * @returns {Rect}
 */
export function boxToView(box, video) {
  const [x, y, w, h] = box;
  return { x: video.x + x * video.width, y: video.y + y * video.height, width: w * video.width, height: h * video.height };
}

/** Clamp a [x, y, w, h] box to the unit square (what main accepts from the worker). @param {number[]} b */
export function clampBox(b) {
  const c = (/** @type {number} */ v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const x = c(b[0]);
  const y = c(b[1]);
  return /** @type {[number, number, number, number]} */ ([x, y, Math.min(c(b[2]), 1 - x), Math.min(c(b[3]), 1 - y)]);
}
