// Local motion detection (src/tapo/worker/motion.js) on synthetic 64×36 luma sequences.
import { describe, expect, it } from 'vitest';
import { MOTION, MotionDetector, changedFraction, lumaFromRgba } from '../../../src/tapo/worker/motion.js';

const W = 64;
const H = 36;

/** A static textured scene with optional bright blob at (bx, by) of size s. */
function scene({ blob = null, offset = 0, noise = 0, seed = 1 } = {}) {
  const out = new Uint8Array(W * H);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 60 + ((x * 7 + y * 13) % 40) + offset;
      if (noise) v += (rnd() - 0.5) * 2 * noise;
      if (blob && x >= blob.x && x < blob.x + blob.s && y >= blob.y && y < blob.y + blob.s) v = 230;
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

describe('MotionDetector', () => {
  it('a static (noisy) scene never moves', () => {
    const m = new MotionDetector();
    for (let i = 0; i < 50; i++) {
      const s = m.update(scene({ noise: 6, seed: i + 1 }));
      expect(s.active).toBe(false);
      expect(s.global).toBe(false);
    }
  });

  it('a moving blob becomes active after 3 samples and stops 3 samples after it is gone', () => {
    const m = new MotionDetector();
    m.update(scene());
    const states = [];
    for (let i = 0; i < 5; i++) states.push(m.update(scene({ blob: { x: 5 + i * 6, y: 10, s: 6 } })).active);
    expect(states).toEqual([false, false, true, true, true]);
    // the blob leaves: the picture returns to the background
    const after = [];
    for (let i = 0; i < 4; i++) after.push(m.update(scene()).active);
    expect(after).toEqual([true, true, false, false]);
  });

  it('a small blob below the threshold is ignored; sensitivity changes the threshold', () => {
    const blob = { x: 30, y: 15, s: 5 }; // 25 px = 1.09 % of the picture
    const low = new MotionDetector({ sensitivity: 'low' });
    const high = new MotionDetector({ sensitivity: 'high' });
    low.update(scene());
    high.update(scene());
    let lowActive = false;
    let highActive = false;
    for (let i = 0; i < 6; i++) {
      const s = scene({ blob: { ...blob, x: blob.x + (i % 2) * 5 } });
      lowActive ||= low.update(s).active;
      highActive ||= high.update(s).active;
    }
    expect(lowActive).toBe(false);
    expect(highActive).toBe(true);
    expect(MOTION.fraction.high).toBeLessThan(25 / (W * H));
    expect(MOTION.fraction.low).toBeGreaterThan(25 / (W * H));
  });

  it('a global flash (IR switch, light on) is reported as global, not motion, and re-seeds', () => {
    const m = new MotionDetector();
    m.update(scene());
    const flash = m.update(scene({ offset: 120 }));
    expect(flash).toMatchObject({ global: true, active: false });
    expect(flash.score).toBeGreaterThan(0.5);
    // the brighter picture is the new background: no motion afterwards
    for (let i = 0; i < 5; i++) expect(m.update(scene({ offset: 120 })).active).toBe(false);
  });

  it('reseed(): the next sample becomes the background', () => {
    const m = new MotionDetector();
    m.update(scene());
    m.reseed();
    expect(m.update(scene({ blob: { x: 1, y: 1, s: 12 } }))).toEqual({ active: false, score: 0, global: false });
    expect(m.update(scene({ blob: { x: 1, y: 1, s: 12 } })).score).toBe(0);
  });

  it('ignores a picture of the wrong size', () => {
    const m = new MotionDetector();
    expect(m.update(new Uint8Array(10))).toEqual({ active: false, score: 0, global: false });
  });
});

describe('helpers', () => {
  it('lumaFromRgba uses BT.601 weights', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect([...lumaFromRgba(rgba)]).toEqual([255, 76, 149, 28]);
  });

  it('changedFraction counts pixels beyond the threshold', () => {
    expect(changedFraction([0, 0, 0, 0], [0, 19, 18, 100])).toBe(0.5);
    expect(changedFraction([], [])).toBe(0);
  });
});
