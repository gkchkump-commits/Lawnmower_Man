// Synthetic MediaPipe Face Landmarker results for the vision tests: a rigid face (the key points
// src/vision/attention.js reads) rotated, scaled and placed in the frame, projected like the
// landmarker reports it (normalized x/y, z in units of the frame width).
import { KEY_POINTS } from '../../../src/vision/attention.js';

/** The key points of a frontal face, in face widths (x right in the image, y down, z toward the camera < 0). */
const CANON = {
  noseTip: [0, 0.05, -0.35],
  forehead: [0, -0.55, -0.05],
  chin: [0, 0.62, -0.05],
  cheekL: [-0.5, 0, 0.1],
  cheekR: [0.5, 0, 0.1],
  eyeOuterL: [-0.33, -0.12, -0.05],
  eyeInnerL: [-0.12, -0.12, -0.08],
  eyeInnerR: [0.12, -0.12, -0.08],
  eyeOuterR: [0.33, -0.12, -0.05],
  irisL: [-0.22, -0.12, -0.1],
  irisR: [0.22, -0.12, -0.1],
  mouthL: [-0.2, 0.35, -0.12],
  mouthR: [0.2, 0.35, -0.12],
  lipTop: [0, 0.3, -0.2],
  lipBottom: [0, 0.38, -0.19],
};

const rad = (d) => (d * Math.PI) / 180;

/**
 * @param {{ cx?: number, cy?: number, size?: number, yawDeg?: number, pitchDeg?: number, rollDeg?: number,
 *           width?: number, height?: number, blend?: Record<string, number> }} [o]
 *   yaw > 0: the user turns toward the image's right (their own left); pitch > 0: looks up;
 *   size: cheek-to-cheek width / frame width
 * @returns {{ faceLandmarks: any[][], faceBlendshapes: any[] }}
 */
export function faceResult(o = {}) {
  const { cx = 0.5, cy = 0.45, size = 0.22, yawDeg = 0, pitchDeg = 0, rollDeg = 0, width = 320, height = 240 } = o;
  const [y, p, r] = [rad(yawDeg), rad(pitchDeg), rad(rollDeg)];
  const lms = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  for (const [name, idx] of Object.entries(KEY_POINTS)) {
    let [x0, y0, z0] = CANON[name];
    // roll (about z), then pitch (about x), then yaw (about y)
    [x0, y0] = [x0 * Math.cos(r) - y0 * Math.sin(r), x0 * Math.sin(r) + y0 * Math.cos(r)];
    [y0, z0] = [y0 * Math.cos(p) + z0 * Math.sin(p), -y0 * Math.sin(p) + z0 * Math.cos(p)];
    [x0, z0] = [x0 * Math.cos(y) - z0 * Math.sin(y), x0 * Math.sin(y) + z0 * Math.cos(y)];
    lms[idx] = { x: cx + x0 * size, y: cy + y0 * size * (width / height), z: z0 * size };
  }
  const blend = { jawOpen: 0.05, mouthSmileLeft: 0, mouthSmileRight: 0, ...(o.blend || {}) };
  return {
    faceLandmarks: [lms],
    faceBlendshapes: [{ categories: [{ categoryName: '_neutral', score: 0.5 }, ...Object.entries(blend).map(([categoryName, score]) => ({ categoryName, score }))] }],
  };
}

export const noFace = () => ({ faceLandmarks: [], faceBlendshapes: [] });
