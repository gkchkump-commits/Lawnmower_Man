// Size of the frames the face detector gets (shared by the tracker and its worker).

/** Width of the frames sent to the detector (the face detector itself works on 128 px). */
export const DETECT_WIDTH = 320;

/** Detector frame size for a video of w×h (keeps the aspect ratio). @param {number} w @param {number} h */
export function detectSize(w, h, maxW = DETECT_WIDTH) {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, maxW / w);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
