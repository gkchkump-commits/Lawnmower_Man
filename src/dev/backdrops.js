// Desktop backdrops for the avatar harness (bg=dark|bright|busy): the transparent hologram is
// composited over them exactly as the desktop window is over the real desktop (premultiplied
// alpha), so its silhouette and glow can be judged over a dark wallpaper, a light one and a busy
// screen full of windows, icons and text. Deterministic (seeded), drawn once per size, no assets.

/** @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft blurred blobs (the Windows 11 "bloom" wallpaper look). */
function bloom(g, w, h, colors, r) {
  g.save();
  g.filter = `blur(${Math.round(0.06 * Math.max(w, h))}px)`;
  for (const [cx, cy, rx, ry, rot, col] of colors) {
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(cx * w, cy * h, rx * w, ry * h, rot, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // a little grain so it is not a perfect gradient
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 4;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function dark(g, w, h, r) {
  const bgGrad = g.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, '#060a16');
  bgGrad.addColorStop(1, '#0c1226');
  g.fillStyle = bgGrad;
  g.fillRect(0, 0, w, h);
  bloom(g, w, h, [
    [0.75, 0.35, 0.45, 0.22, -0.7, '#1b3a8a'],
    [0.6, 0.62, 0.35, 0.16, 0.5, '#2a56c8'],
    [0.2, 0.8, 0.3, 0.12, -0.3, '#13244f'],
  ], r);
}

function bright(g, w, h, r) {
  const bgGrad = g.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, '#f4f7fb');
  bgGrad.addColorStop(1, '#dfe8f4');
  g.fillStyle = bgGrad;
  g.fillRect(0, 0, w, h);
  bloom(g, w, h, [
    [0.72, 0.42, 0.42, 0.2, -0.6, '#b9d0f2'],
    [0.55, 0.66, 0.32, 0.14, 0.4, '#9fbdea'],
    [0.25, 0.2, 0.3, 0.12, 0.2, '#ffffff'],
  ], r);
  // a light-theme window over part of it (white, the hardest case for a light hologram)
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,0.18)';
  g.shadowBlur = 18;
  g.fillRect(0.08 * w, 0.06 * h, 0.7 * w, 0.52 * h);
  g.shadowBlur = 0;
  g.fillStyle = '#f0f2f5';
  g.fillRect(0.08 * w, 0.06 * h, 0.7 * w, 0.045 * h);
  g.fillStyle = '#c9ced6';
  for (let i = 0; i < 9; i++) g.fillRect(0.12 * w, (0.14 + i * 0.045) * h, (0.3 + 0.32 * r()) * w, 0.012 * h);
}

function busy(g, w, h, r) {
  // a photo-like wallpaper: a sunset sky, hills, a lake
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#2b4c8c');
  sky.addColorStop(0.45, '#e9846a');
  sky.addColorStop(0.62, '#f6c37a');
  sky.addColorStop(1, '#36506e');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  for (let k = 0; k < 3; k++) {
    g.fillStyle = ['#3d2f4f', '#2a2741', '#1c2234'][k];
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) g.lineTo(x, (0.55 + 0.06 * k) * h + Math.sin(x * (0.01 + 0.006 * k) + k * 2) * 0.05 * h + (r() - 0.5) * 3);
    g.lineTo(w, h);
    g.fill();
  }
  // desktop icons (a column on the left)
  for (let i = 0; i < 7; i++) {
    const x = 0.03 * w, y = (0.03 + i * 0.105) * h, s = 0.075 * Math.min(w, h * 0.7);
    g.fillStyle = `hsl(${Math.floor(r() * 360)},70%,${45 + 20 * r()}%)`;
    g.fillRect(x, y, s, s * 0.85);
    g.fillStyle = '#fff';
    g.fillRect(x, y + s * 0.95, s, 0.012 * h);
  }
  // a browser window with colourful thumbnails
  const bx = 0.2 * w, by = 0.08 * h, bw = 0.62 * w, bh = 0.42 * h;
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 16;
  g.fillStyle = '#fafafa';
  g.fillRect(bx, by, bw, bh);
  g.shadowBlur = 0;
  g.fillStyle = '#dde3ea';
  g.fillRect(bx, by, bw, 0.05 * h);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const tx = bx + 0.03 * w + i * 0.2 * w, ty = by + 0.08 * h + j * 0.11 * h;
      const gr = g.createLinearGradient(tx, ty, tx + 0.17 * w, ty + 0.08 * h);
      gr.addColorStop(0, `hsl(${Math.floor(r() * 360)},75%,55%)`);
      gr.addColorStop(1, `hsl(${Math.floor(r() * 360)},75%,40%)`);
      g.fillStyle = gr;
      g.fillRect(tx, ty, 0.17 * w, 0.08 * h);
      g.fillStyle = '#333';
      g.fillRect(tx, ty + 0.088 * h, 0.13 * w * (0.6 + 0.4 * r()), 0.008 * h);
    }
  }
  // a dark code editor lower right
  const ex = 0.38 * w, ey = 0.56 * h, ew = 0.6 * w, eh = 0.34 * h;
  g.shadowBlur = 16;
  g.fillStyle = '#1e1f24';
  g.fillRect(ex, ey, ew, eh);
  g.shadowBlur = 0;
  const cols = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#eeffff'];
  for (let i = 0; i < 16; i++) {
    let x = ex + 0.03 * w + (i % 4 === 0 ? 0 : 0.03 * w);
    for (let k = 0; k < 4; k++) {
      const len = (0.04 + 0.1 * r()) * w;
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.fillRect(x, ey + 0.03 * h + i * 0.019 * h, len, 0.008 * h);
      x += len + 0.015 * w;
      if (x > ex + ew - 0.05 * w) break;
    }
  }
  // a text document on the lower left: black text on white
  const dx = 0.05 * w, dy = 0.62 * h, dw = 0.3 * w, dh = 0.3 * h;
  g.shadowBlur = 14;
  g.fillStyle = '#ffffff';
  g.fillRect(dx, dy, dw, dh);
  g.shadowBlur = 0;
  g.fillStyle = '#222';
  g.font = `${Math.max(8, Math.round(0.016 * h))}px sans-serif`;
  for (let i = 0; i < 12; i++) g.fillText('Lorem ipsum dolor sit amet'.slice(0, 10 + Math.floor(r() * 16)), dx + 0.02 * w, dy + 0.04 * h + i * 0.021 * h);
  // the taskbar
  g.fillStyle = 'rgba(32,36,44,0.92)';
  g.fillRect(0, 0.955 * h, w, 0.045 * h);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = `hsl(${Math.floor(r() * 360)},65%,60%)`;
    g.fillRect((0.3 + i * 0.055) * w, 0.963 * h, 0.03 * w, 0.03 * h);
  }
}

export const BACKDROPS = /** @type {const} */ (['dark', 'bright', 'busy']);

/**
 * Paint a backdrop behind the avatar canvas: a <canvas> as the first child of `view`.
 * @param {HTMLElement} view @param {'dark'|'bright'|'busy'} kind @param {number} [seed]
 */
export function paintBackdrop(view, kind, seed = 7) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(view.clientWidth * dpr), h = Math.round(view.clientHeight * dpr);
  c.width = w; c.height = h;
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  // (the avatar canvas over it: positioned elements paint above static ones)
  for (const el of view.querySelectorAll('canvas#avatar')) {
    /** @type {HTMLElement} */ (el).style.position = 'relative';
    /** @type {HTMLElement} */ (el).style.zIndex = '1';
  }
  for (const el of view.querySelectorAll('.label, #stats, #caption')) /** @type {HTMLElement} */ (el).style.zIndex = '2';
  const g = c.getContext('2d', { willReadFrequently: true });
  const r = rng(seed * 2654435761 + (kind === 'dark' ? 1 : kind === 'bright' ? 2 : 3));
  if (kind === 'dark') dark(g, w, h, r);
  else if (kind === 'bright') bright(g, w, h, r);
  else busy(g, w, h, r);
  view.prepend(c);
  return c;
}
