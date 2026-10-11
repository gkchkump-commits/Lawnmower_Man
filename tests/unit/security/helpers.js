// Fakes for the Home camera worker tests: pictures that render themselves at any size, a
// createImageBitmap / OffscreenCanvas pair that passes those pixels through, a manual clock.

/**
 * A fake picture: `paint(x, y)` gives [r, g, b] for a point in 0..1 coordinates.
 * @param {(u: number, v: number) => [number, number, number]} paint @param {number} [width] @param {number} [height]
 */
export function fakeImage(paint, width = 640, height = 360) {
  const img = {
    width,
    height,
    displayWidth: width,
    displayHeight: height,
    timestamp: 0,
    closed: false,
    paint,
    close() {
      img.closed = true;
    },
  };
  return img;
}

/** RGBA of a fake picture at w×h. */
export function render(img, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = img.paint((x + 0.5) / w, (y + 0.5) / h);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}

export function fakeGraphics() {
  const stats = { bitmaps: 0, drawsOnLive: 0, encodes: 0 };
  const createImageBitmap = async (src, o = {}) => {
    if (!src || src.closed) throw new Error('source closed');
    stats.bitmaps++;
    const w = o.resizeWidth || src.width;
    const h = o.resizeHeight || src.height;
    const data = render(src, w, h);
    return { width: w, height: h, data, close() {} };
  };
  class OffscreenCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.last = null;
    }

    getContext() {
      const c = this;
      return {
        fillStyle: '',
        imageSmoothingQuality: '',
        fillRect() {},
        drawImage(img) {
          c.last = img;
          if (c.live) stats.drawsOnLive++;
        },
        getImageData(x, y, w, h) {
          return { data: c.last?.data || render(c.last, w, h) };
        },
      };
    }

    async convertToBlob() {
      stats.encodes++;
      const bytes = new Uint8Array(2000);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return { arrayBuffer: async () => bytes.buffer };
    }
  }
  return { createImageBitmap, OffscreenCanvas, stats };
}

/** A manual clock with timers (monotonic `now` and a wall clock that moves with it). */
export function manualClock(start = 1000) {
  let t = start;
  const wall0 = 1_760_000_000_000;
  let timers = [];
  let seq = 0;
  const clock = {
    now: () => t,
    wallNow: () => wall0 + t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    /** @param {number} ms */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    get wall0() {
      return wall0;
    },
  };
  return clock;
}

/** Let promise chains settle. */
export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** A textured "room" with an optional green figure at (fx, fy) and a horizontal view offset. */
export function room({ offset = 0, figure = null, flat = false } = {}) {
  return (u, v) => {
    if (flat) return [30, 30, 30];
    if (figure && Math.abs(u - figure.x) < 0.05 && Math.abs(v - figure.y) < 0.15) return [0, 255, 0];
    const x = u + offset;
    let l = 70 + x * 20 + v * 15;
    for (const b of BLOBS) {
      const d2 = ((x - b.x) ** 2) / (b.s * b.s) + ((v - b.y) ** 2) / (b.s * b.s * 3.2);
      if (d2 < 1) l = l * d2 + b.l * (1 - d2);
    }
    return [l, l * 0.95, l * 0.9];
  };
}

/** Irregular blobs over a 2.5-view-wide panorama (deterministic, not periodic). */
const BLOBS = (() => {
  let r = 11;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: 90 }, () => ({ x: rnd() * 2.5, y: rnd(), s: 0.02 + rnd() * 0.06, l: 30 + rnd() * 200 }));
})();
