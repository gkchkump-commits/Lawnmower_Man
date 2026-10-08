// Snapshots for Claude: one JPEG of the current camera frame (longest side ≤ 640 px, quality
// ~0.75 — a few tens of KB, far below the 1.5 MB limit main enforces) plus a small thumbnail
// for the transcript. Nothing is stored: the picture goes into the Claude turn and the
// thumbnail lives in the chat panel's DOM only.
/* global FileReader */

export const SNAPSHOT_MAX_SIDE = 640;
export const SNAPSHOT_QUALITY = 0.75;
export const THUMB_MAX_SIDE = 160;
/** Same limit as electron/ipc-validate.js (characters of base64). */
export const SNAPSHOT_MAX_BASE64 = 1.5 * 1024 * 1024;

/**
 * Scale (w, h) down so the longest side is at most `max` (never up), as whole pixels.
 * @param {number} w @param {number} h @param {number} [max]
 * @returns {{ width: number, height: number }}
 */
export function fitSize(w, h, max = SNAPSHOT_MAX_SIDE) {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * @typedef {object} Snapshot
 * @property {'image/jpeg'} mediaType
 * @property {string} data     base64, no data: prefix (what claude.send() takes)
 * @property {number} width
 * @property {number} height
 * @property {string} thumb    data: URL of a small JPEG for the transcript
 */

/**
 * Take a snapshot of a playing <video>.
 * @param {HTMLVideoElement} video
 * @param {{ maxSide?: number, quality?: number, thumbSide?: number }} [o]
 * @returns {Promise<Snapshot>}
 */
export async function captureSnapshot(video, o = {}) {
  if (!video || video.readyState < 2 || !video.videoWidth) throw new Error('The camera has no picture yet');
  const { width, height } = fitSize(video.videoWidth, video.videoHeight, o.maxSide ?? SNAPSHOT_MAX_SIDE);
  const canvas = drawScaled(video, width, height);
  let quality = o.quality ?? SNAPSHOT_QUALITY;
  let data = '';
  for (let i = 0; i < 4; i++) {
    data = base64Of(await toDataUrl(canvas, quality));
    if (data.length <= SNAPSHOT_MAX_BASE64) break;
    quality *= 0.7; // a huge (noisy) frame: try again smaller
  }
  if (data.length > SNAPSHOT_MAX_BASE64) throw new Error('The snapshot is too large');
  const t = fitSize(width, height, o.thumbSide ?? THUMB_MAX_SIDE);
  const thumb = await toDataUrl(drawScaled(canvas, t.width, t.height), 0.7);
  return { mediaType: 'image/jpeg', data, width, height, thumb };
}

/** @param {CanvasImageSource} src @param {number} w @param {number} h */
function drawScaled(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/** @param {HTMLCanvasElement} canvas @param {number} quality @returns {Promise<string>} */
function toDataUrl(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode the snapshot'));
        return;
      }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error('Could not read the snapshot'));
      r.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

/** "data:image/jpeg;base64,AAAA" → "AAAA" @param {string} url */
export function base64Of(url) {
  const i = url.indexOf(',');
  return i >= 0 ? url.slice(i + 1) : url;
}
