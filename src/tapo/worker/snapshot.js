// JPEG snapshots of the newest decoded frame (contract §9.4), in the security worker: for main
// (alerts, the best picture of an event saved next to its clip, Claude's camera_snapshot) and for
// the page (Space copies one to the clipboard). OffscreenCanvas → convertToBlob; a frame that
// encodes too large (noise in the dark) is tried again at lower quality.

import { fitSize } from '../../vision/snapshot.js';

export { fitSize };
/** Same limit as main's image checks: 1.5 MB of base64. */
export const SNAPSHOT_MAX_BASE64 = 1.5 * 1024 * 1024;
/** bytes of a JPEG whose base64 is at most SNAPSHOT_MAX_BASE64 characters */
export const SNAPSHOT_MAX_BYTES = Math.floor((SNAPSHOT_MAX_BASE64 / 4) * 3);
export const SNAPSHOT_DEFAULT = Object.freeze({ maxSide: 1280, quality: 0.75 });

/**
 * @param {{ image: any, width: number, height: number }} frame  the newest frame (VideoFrame or ImageBitmap)
 * @param {{ maxSide?: number, quality?: number, OffscreenCanvas?: any }} [o]
 * @returns {Promise<{ jpeg: ArrayBuffer, width: number, height: number }>}
 */
export async function encodeSnapshot(frame, o = {}) {
  const Canvas = o.OffscreenCanvas || globalThis.OffscreenCanvas;
  if (!frame || !frame.image) throw new Error('There is no picture yet.');
  if (typeof Canvas !== 'function') throw new Error('Snapshots are not supported here.');
  const maxSide = Math.max(16, Math.min(4096, Math.round(o.maxSide || SNAPSHOT_DEFAULT.maxSide)));
  const { width, height } = fitSize(frame.width, frame.height, maxSide);
  if (!width || !height) throw new Error('The picture has no size.');
  const canvas = new Canvas(width, height);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(frame.image, 0, 0, width, height);
  let quality = Math.min(0.95, Math.max(0.3, Number(o.quality) || SNAPSHOT_DEFAULT.quality));
  for (let i = 0; i < 4; i++) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const jpeg = await blob.arrayBuffer();
    if (jpeg.byteLength <= SNAPSHOT_MAX_BYTES) return { jpeg, width, height };
    quality *= 0.7;
  }
  throw new Error('The snapshot is too large.');
}

/** A JPEG starts with FF D8 FF. @param {ArrayBuffer} buf */
export function isJpeg(buf) {
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  return b.length === 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
