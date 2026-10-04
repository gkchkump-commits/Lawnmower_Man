// Procedural app/tray icon: a tiny hologram head (cyan wireframe outline, glowing amber eyes,
// gold lips) rendered with 4×4 supersampling and encoded as PNG with zlib — no image deps.
// scripts/make-icons.mjs writes electron/assets/*.png from this; main.js falls back to it at
// runtime if those files are missing.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Encode straight-alpha RGBA pixels as a PNG.
 * @param {number} width @param {number} height @param {Uint8Array} rgba
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {number} x */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Distance from p to segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Premultiplied colour of the icon at (u, v) ∈ [-1,1]² (v down). `pix` = one pixel in uv units
 * so strokes stay at least ~1 px wide at 16×16.
 * @returns {[number, number, number, number]}
 */
function shade(u, v, pix, detailed) {
  let r = 0, g = 0, b = 0, a = 0;
  const over = (/** @type {number} */ cr, /** @type {number} */ cg, /** @type {number} */ cb, /** @type {number} */ ca) => {
    const k = 1 - ca;
    r = cr * ca + r * k;
    g = cg * ca + g * k;
    b = cb * ca + b * k;
    a = ca + a * k;
  };

  // Head: an ellipse slightly narrower at the chin.
  const cy = -0.02;
  const rx = 0.64 * (v > cy ? 1 - 0.18 * ((v - cy) / 0.86) ** 2 : 1);
  const ry = 0.86;
  const q = Math.hypot(u / rx, (v - cy) / ry);
  const d = (q - 1) * Math.min(rx, ry); // ≈ signed distance to the outline
  const inside = d < 0;

  // Outer cyan glow.
  const glow = detailed ? 0.42 : 0.12; // tiny tray icons need contrast, not haze
  over(0.35, 0.8, 1.0, glow * Math.exp(-Math.abs(d) / Math.max(0.07, 2.5 * pix)) * (inside ? 0.5 : 1));
  if (inside) {
    over(0.05, 0.13, 0.26, detailed ? 0.55 : 0.9);
    if (detailed) {
      // Wireframe: latitude lines and longitude lines bent around the head.
      const lat = Math.abs(((v * 7) % 1 + 1) % 1 - 0.5);
      const bend = u / Math.max(0.2, Math.sqrt(Math.max(0, 1 - ((v - cy) / ry) ** 2)));
      const lon = Math.abs(((bend * 5) % 1 + 1) % 1 - 0.5);
      const line = Math.max(clamp01(1 - (lat * 2) / Math.max(0.06, pix * 7)), clamp01(1 - (lon * 2) / Math.max(0.06, pix * 5)));
      over(0.62, 0.86, 1.0, 0.35 * line);
      // Gold centre line on the forehead.
      const cl = segDist(u, v, 0, -0.78, 0, -0.3);
      over(1.0, 0.75, 0.35, 0.7 * clamp01(1 - cl / Math.max(0.012, pix)));
    }
  }
  // Outline stroke.
  const w = Math.max(0.028, 1.1 * pix);
  over(0.6, 0.9, 1.0, clamp01(1 - (Math.abs(d) - w * 0.5) / Math.max(pix, 0.004)));

  // Eyes: amber glow + bright core (+ dark pupil when large enough).
  const eyeX = detailed ? 0.27 : 0.3;
  for (const ex of [-eyeX, eyeX]) {
    const ed = Math.hypot(u - ex, v + 0.02);
    const er = detailed ? 0.1 : Math.max(0.1, 0.85 * pix);
    over(1.0, 0.62, 0.2, (detailed ? 0.75 : 0.3) * Math.exp(-Math.max(0, ed - er) / Math.max(0.06, (detailed ? 2 : 0.8) * pix)));
    over(1.0, 0.86, 0.55, clamp01(1 - (ed - er) / Math.max(pix, 0.004)));
    if (detailed) over(0.18, 0.06, 0.0, clamp01(1 - (ed - 0.035) / Math.max(pix, 0.004)));
  }

  // Lips: a soft gold arc with a gentle smile (corners up; v grows downwards).
  const mx = clamp01((u + 0.18) / 0.36) * 0.36 - 0.18;
  const my = 0.38 + 0.045 * (1 - (mx / 0.18) ** 2);
  const md = Math.hypot(u - mx, v - my);
  const mw = Math.max(0.03, 1.0 * pix);
  over(1.0, 0.72, 0.32, clamp01(1 - (md - mw * 0.5) / Math.max(pix, 0.004)));

  return [r, g, b, a];
}

/**
 * Render the icon as straight-alpha RGBA.
 * @param {number} size
 * @returns {Uint8Array}
 */
export function renderIconRgba(size) {
  const out = new Uint8Array(size * size * 4);
  const ss = size <= 64 ? 4 : 3;
  const pix = 2 / size;
  const detailed = size >= 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          const c = shade(u * 1.08, v * 1.08, pix * 1.08, detailed);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      r /= n; g /= n; b /= n; a /= n;
      const i = (y * size + x) * 4;
      // premultiplied → straight alpha
      out[i] = a > 0 ? Math.round(clamp01(r / a) * 255) : 0;
      out[i + 1] = a > 0 ? Math.round(clamp01(g / a) * 255) : 0;
      out[i + 2] = a > 0 ? Math.round(clamp01(b / a) * 255) : 0;
      out[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return out;
}

/** PNG bytes of the icon at `size`×`size`. @param {number} size */
export function renderIconPng(size) {
  return encodePng(size, size, renderIconRgba(size));
}
