// A stand-in person detector for tests (contract §9.4): main picks it with
// LAWNMOWER_TAPO_FAKE_DETECTOR=1, and the browser mock always uses it. The camera simulator's
// "person" fixture (and the mock's fake picture) paints a pure green figure; this finds those
// pixels in the small RGBA sample the motion detector already takes and reports one "person"
// around them. Pure, and needs no model or wasm.

/** A green pixel: G > 200, R < 80, B < 80. */
export const STUB_GREEN = Object.freeze({ g: 200, r: 80, b: 80 });
/** The green area must cover at least this fraction of the picture. */
export const STUB_MIN_FRACTION = 0.005;
export const STUB_SCORE = 0.9;

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba @param {number} width @param {number} height
 * @returns {Array<{ score: number, box: [number, number, number, number] }>}  box x, y, w, h in 0..1
 */
export function stubDetect(rgba, width, height) {
  const n = width * height;
  if (!rgba || !(n > 0) || rgba.length < n * 4) return [];
  let count = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = (y * width + x) * 4;
      if (rgba[j + 1] > STUB_GREEN.g && rgba[j] < STUB_GREEN.r && rgba[j + 2] < STUB_GREEN.b) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count / n < STUB_MIN_FRACTION) return [];
  return [{ score: STUB_SCORE, box: [x0 / width, y0 / height, (x1 - x0 + 1) / width, (y1 - y0 + 1) / height] }];
}
