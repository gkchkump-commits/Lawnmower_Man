// The tray icon while "Hey Jade" has the microphone open: the app's tray head with a small
// cyan "listening" dot in its lower right corner, so the tray says it even when the window is
// hidden (the Windows taskbar's microphone icon does not say which app). Rendered from the
// procedural icon (electron/icon.js) at the tray's three scales; no image files.

import { encodePng, renderIconRgba } from '../icon.js';

/** [display scale factor, size] (like electron/assets/tray*.png) */
export const TRAY_SIZES = Object.freeze([[1, 16], [1.5, 24], [2, 32]]);

/**
 * The tray head with a listening dot, as PNG bytes.
 * @param {number} size
 * @returns {Buffer}
 */
export function renderListeningTrayPng(size) {
  const px = renderIconRgba(size);
  const r = size * 0.21; // the dot
  const ring = Math.max(1, size / 16); // a dark ring, so it shows on light taskbars too
  const cx = size - r - 0.5;
  const cy = size - r - 0.5;
  const ss = 4;
  for (let y = Math.floor(cy - r - ring - 1); y <= Math.ceil(cy + r + ring + 1); y++) {
    for (let x = Math.floor(cx - r - ring - 1); x <= Math.ceil(cx + r + ring + 1); x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      let dot = 0;
      let edge = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / ss - cx, y + (sy + 0.5) / ss - cy);
          if (d <= r) dot++;
          else if (d <= r + ring) edge++;
        }
      }
      const n = ss * ss;
      const a = (dot + edge) / n;
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      // cyan (127, 227, 255) inside, near-black ring; composited over the head
      const fr = (dot * 127 + edge * 8) / (dot + edge);
      const fg = (dot * 227 + edge * 12) / (dot + edge);
      const fb = (dot * 255 + edge * 20) / (dot + edge);
      const ba = px[i + 3] / 255;
      const oa = a + ba * (1 - a);
      for (const [k, f] of /** @type {Array<[number, number]>} */ ([[0, fr], [1, fg], [2, fb]])) {
        px[i + k] = Math.round((f * a + px[i + k] * ba * (1 - a)) / Math.max(oa, 1e-6));
      }
      px[i + 3] = Math.round(oa * 255);
    }
  }
  return encodePng(size, size, px);
}

/** @type {any} */
let cached = null;

/**
 * The listening tray image (all three scales). Cached.
 * @param {any} nativeImage Electron's nativeImage
 */
export function listeningTrayImage(nativeImage) {
  if (cached) return cached;
  if (typeof nativeImage?.createEmpty === 'function') {
    const img = nativeImage.createEmpty();
    for (const [scale, size] of TRAY_SIZES) {
      try { img.addRepresentation?.({ scaleFactor: scale, buffer: renderListeningTrayPng(size) }); } catch { /* one scale less */ }
    }
    cached = img;
  } else {
    cached = nativeImage.createFromBuffer(renderListeningTrayPng(32), { scaleFactor: 2 });
  }
  return cached;
}
