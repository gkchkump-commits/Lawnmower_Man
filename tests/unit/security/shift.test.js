// Scene shift estimation for calibration (src/tapo/worker/shift.js): a synthetic textured
// panorama cropped at known offsets, the sign convention, and low scores for featureless scenes.
import { describe, expect, it } from 'vitest';
import { SHIFT_HEIGHT, SHIFT_RELIABLE, SHIFT_WIDTH, estimateShift, halve, sadAt } from '../../../src/tapo/worker/shift.js';

const W = SHIFT_WIDTH;
const H = SHIFT_HEIGHT;

/** A smooth but textured "room": blobs of different brightness on a gradient. */
function panorama(pw, ph, seed = 7) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blobs = Array.from({ length: 60 }, () => ({ x: rnd() * pw, y: rnd() * ph, s: 4 + rnd() * 14, v: 40 + rnd() * 180 }));
  const out = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let v = 50 + (x / pw) * 40 + (y / ph) * 20;
      for (const b of blobs) {
        const d2 = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.s * b.s);
        if (d2 < 1) v = v * d2 + b.v * (1 - d2);
      }
      out[y * pw + x] = v;
    }
  }
  return out;
}

/** The camera's view: a W×H crop at (ox, oy) of the panorama (+ noise). */
function crop(pano, pw, ox, oy, noise = 0, seed = 3) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = pano[(y + oy) * pw + (x + ox)] + (noise ? (rnd() - 0.5) * 2 * noise : 0);
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

const PW = 360;
const PH = 200;
const pano = panorama(PW, PH);
const base = { ox: 120, oy: 60 };

describe('estimateShift', () => {
  it('no movement → (0, 0) with a high score', () => {
    const a = crop(pano, PW, base.ox, base.oy, 3, 1);
    const b = crop(pano, PW, base.ox, base.oy, 3, 2);
    const r = estimateShift(a, b);
    expect(Math.abs(r.dx)).toBeLessThan(0.01);
    expect(Math.abs(r.dy)).toBeLessThan(0.01);
    expect(r.score).toBeGreaterThan(SHIFT_RELIABLE);
  });

  it.each([
    [10, 0], [-10, 0], [0, 6], [0, -6], [23, -9], [-40, 12], [52, 0], [-55, -20],
  ])('camera view moved by (%i, %i) px', (vx, vy) => {
    // the view moves right by vx → the scene moves LEFT in the picture: dx = −vx / W
    const ref = crop(pano, PW, base.ox, base.oy, 2, 1);
    const cur = crop(pano, PW, base.ox + vx, base.oy + vy, 2, 2);
    const r = estimateShift(ref, cur);
    expect(r.dx).toBeCloseTo(-vx / W, 1);
    expect(Math.abs(r.dx - -vx / W)).toBeLessThan(0.6 / W);
    expect(Math.abs(r.dy - -vy / H)).toBeLessThan(0.6 / H);
    expect(r.score).toBeGreaterThan(SHIFT_RELIABLE);
  });

  it('a featureless (dark, flat) scene gives a low score', () => {
    const flat = (seed) => {
      let r = seed;
      const out = new Uint8Array(W * H);
      for (let i = 0; i < out.length; i++) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        out[i] = 12 + ((r >> 8) % 3); // sensor noise in the dark
      }
      return out;
    };
    const r = estimateShift(flat(1), flat(2));
    expect(r.score).toBeLessThan(SHIFT_RELIABLE);
    expect(estimateShift(new Uint8Array(W * H).fill(40), new Uint8Array(W * H).fill(40)).score).toBe(0);
  });

  it('an exposure change after the move does not matter (means are removed)', () => {
    const ref = crop(pano, PW, base.ox, base.oy);
    const cur = crop(pano, PW, base.ox + 16, base.oy).map((v) => Math.min(255, v + 25));
    const r = estimateShift(ref, cur);
    expect(r.dx).toBeCloseTo(-16 / W, 2);
  });

  it('bad input → no shift, no score', () => {
    expect(estimateShift(new Uint8Array(4), new Uint8Array(4))).toEqual({ dx: 0, dy: 0, score: 0 });
  });
});

describe('helpers', () => {
  it('halve averages 2×2 blocks', () => {
    expect([...halve([1, 3, 5, 7, 1, 3, 5, 7], 4, 2)]).toEqual([2, 6]);
  });

  it('sadAt compares cur(x) with ref(x − s)', () => {
    const ref = new Float32Array([0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]);
    const cur = new Float32Array(ref.length);
    for (let y = 0; y < 4; y++) for (let x = 1; x < 9; x++) cur[y * 9 + x] = ref[y * 9 + x - 1];
    expect(sadAt(ref, cur, 9, 4, 1, 0)).toBe(0);
    expect(sadAt(ref, cur, 9, 4, 0, 0)).toBeGreaterThan(0);
  });
});
