// The test stand-in for the person detector (src/tapo/worker/stub-detector.js).
import { describe, expect, it } from 'vitest';
import { STUB_SCORE, stubDetect } from '../../../src/tapo/worker/stub-detector.js';

const W = 64;
const H = 36;
function picture(fill = [90, 90, 90], rect = null, color = [0, 255, 0]) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const c = inside ? color : fill;
      rgba.set([...c, 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

describe('stubDetect', () => {
  it('finds a green figure and boxes it in 0..1', () => {
    const persons = stubDetect(picture(undefined, { x: 16, y: 9, w: 4, h: 12 }), W, H);
    expect(persons).toEqual([{ score: STUB_SCORE, box: [16 / W, 9 / H, 4 / W, 12 / H] }]);
  });

  it('ignores too few green pixels (< 0.5 %) and greens that are not pure', () => {
    expect(stubDetect(picture(undefined, { x: 1, y: 1, w: 3, h: 3 }), W, H)).toEqual([]); // 9 px = 0.39 %
    expect(stubDetect(picture(undefined, { x: 10, y: 10, w: 10, h: 10 }, [100, 255, 0]), W, H)).toEqual([]); // yellowish
    expect(stubDetect(picture([20, 180, 20]), W, H)).toEqual([]); // a green lawn is not bright enough
  });

  it('bad input → nothing', () => {
    expect(stubDetect(new Uint8ClampedArray(8), W, H)).toEqual([]);
    expect(stubDetect(/** @type {any} */ (null), W, H)).toEqual([]);
  });
});
