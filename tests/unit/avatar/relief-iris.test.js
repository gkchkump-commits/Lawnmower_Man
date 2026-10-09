// The relief head's irises (src/avatar/heads/relief/iris.js): locating the painted iris (the pack's
// landmark values sit off it), painting it over for the moving iris disc, and where the plate shows
// the open eye; plus the shader that moves the disc and the lid that follows a downward gaze.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IRIS_GLOW_PX, fillIrises, irisLayer, locateIris, openMap } from '../../../src/avatar/heads/relief/iris.js';
import { FACE_FRAG } from '../../../src/avatar/heads/relief/shaders.js';
import { RIG_LIMITS, buildRig, rigUniforms } from '../../../src/avatar/heads/relief/rig.js';
import { buildProcRig, procRigUniforms } from '../../../src/avatar/heads/procedural/rig.js';
import { createAnimState } from '../../../src/avatar/director.js';

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const W = 200, H = 160;
const IRIS = { cx: 100.3, cy: 80.7, r: 28 };

/** an eye: dark eye white with a few grid lines, a bright iris with radial streaks, a dark pupil */
function eyeImage() {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - IRIS.cx, y + 0.5 - IRIS.cy);
      let l = 70 + (x % 12 === 0 || y % 12 === 0 ? 50 : 0);
      if (d < IRIS.r) l = 215 + 25 * Math.cos(12 * Math.atan2(y - IRIS.cy, x - IRIS.cx));
      if (d < 9) l = 60;
      const i = (y * W + x) * 4;
      px[i] = l; px[i + 1] = 0.9 * l; px[i + 2] = 0.7 * l; px[i + 3] = 255;
    }
  }
  return px;
}
const lum = (px, x, y) => { const i = (y * W + x) * 4; return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; };

describe('locateIris', () => {
  it('finds the painted iris from a guess 15 px off and 20 % small', () => {
    const hit = locateIris(eyeImage(), W, H, { cx: 112, cy: 92, r: 22.5, box: [55, 50, 145, 115] });
    expect(hit).not.toBeNull();
    expect(Math.abs(hit.cx - IRIS.cx)).toBeLessThan(0.6);
    expect(Math.abs(hit.cy - IRIS.cy)).toBeLessThan(0.6);
    expect(Math.abs(hit.r - IRIS.r)).toBeLessThan(1.5);
  });

  it('finds nothing where there is no pupil in a bright iris', () => {
    const flat = new Uint8ClampedArray(W * H * 4).fill(120);
    expect(locateIris(flat, W, H, { cx: 100, cy: 80, r: 22, box: [55, 50, 145, 115] })).toBeNull();
  });
});

describe('fillIrises', () => {
  it('paints the iris over with the eye white beside it and leaves everything past the rim alone', () => {
    const src = eyeImage();
    const px = Uint8ClampedArray.from(src);
    const disc = IRIS.r + IRIS_GLOW_PX;
    fillIrises(px, W, H, [{ cx: IRIS.cx, cy: IRIS.cy, r: disc }]);
    // no iris, no pupil left: the fill is about as dark as the eye white
    let maxL = 0, minL = 255;
    for (let y = 60; y < 100; y++) for (let x = 80; x < 120; x++) { maxL = Math.max(maxL, lum(px, x, y)); minL = Math.min(minL, lum(px, x, y)); }
    expect(maxL).toBeLessThan(140);
    expect(minL).toBeGreaterThan(55);
    // outside the disc nothing changed (so a disc drawn back over it reproduces the image)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.hypot(x + 0.5 - IRIS.cx, y + 0.5 - IRIS.cy) < disc) continue;
        const i = (y * W + x) * 4;
        expect(px[i]).toBe(src[i]);
      }
    }
  });

  it('carries the eye white texture across where the open map allows it', () => {
    const open = new Uint8Array(W * H).fill(255);
    const plain = Uint8ClampedArray.from(eyeImage()), textured = Uint8ClampedArray.from(eyeImage());
    fillIrises(plain, W, H, [{ cx: IRIS.cx, cy: IRIS.cy, r: 31 }]);
    fillIrises(textured, W, H, [{ cx: IRIS.cx, cy: IRIS.cy, r: 31 }], open);
    const spread = (px) => {
      const v = [];
      for (let x = 85; x < 116; x++) v.push(lum(px, x, 80));
      const m = v.reduce((a, b) => a + b) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    };
    expect(spread(textured)).toBeGreaterThan(2 * spread(plain) + 3);
  });
});

describe('openMap', () => {
  it('is the inside of the open eye: in from both lid glows, nothing below the closed-eye line', () => {
    // a column of the lid coordinate: 0 on the upper lid line (y 20), 1 on the closed line (y 60),
    // back down to -1 just below it
    const w = 4, h = 80;
    const lids = new Uint8ClampedArray(w * h * 4);
    const wAt = (y) => (y < 20 ? -1 + y / 20 : y <= 60 ? (y - 20) / 40 : Math.max(-1, 1 - (y - 60) / 2));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lids[(y * w + x) * 4] = Math.round(255 * (0.5 + 0.5 * wAt(y)));
    const m = openMap(lids, null, w, h);
    const col = Array.from({ length: h }, (_, y) => m[y * w + 1]);
    expect(col[22]).toBe(0);          // the upper lid's glow (w < 0.13)
    expect(col[40]).toBe(255);        // the middle of the eye
    expect(col[57]).toBe(0);          // the band at the closed line (the lower lid glows there)
    expect(col[63]).toBe(0);          // below it
    expect(Math.max(...col.slice(0, 20))).toBe(0);
  });

  it('falls back to the aperture mask for packs without a lid coordinate', () => {
    const ap = new Uint8ClampedArray(4 * 4).fill(255);
    expect(Array.from(openMap(null, ap, 2, 2))).toEqual([255, 255, 255, 255]);
    expect(openMap(null, null, 2, 2)).toBeNull();
  });

  it('irisLayer without a DOM returns the pack values and no textures', () => {
    const pack = read('../../../public/assets/avatars/reference/pack.json');
    const l = irisLayer(null, pack);
    expect(l.canvas).toBeNull();
    expect(l.open).toBeNull();
    expect(l.eyes.L.cx).toBe(pack.rig.eyes.L.center[0]);
    expect(l.eyes.L.disc).toBe(pack.rig.eyes.L.irisRadius + IRIS_GLOW_PX);
  });
});

describe('the gaze in the face shader and the rigs', () => {
  it('moves the iris as a disc over the painted-over plate, with the uv warp only as a fallback', () => {
    for (const s of ['uniform sampler2D tSclera;', 'uniform sampler2D tOpen;', 'uniform float uIrisLayer;', 'vec3 eyeLayer(', 'vec3 irisAt(']) {
      expect(FACE_FRAG).toContain(s);
    }
    expect(FACE_FRAG).toMatch(/if \(uIrisLayer < 0\.5 && mB\.g > 0\.001\) suv -= /);
    // nothing changes at rest: the eye layer is skipped at gaze 0
    expect(FACE_FRAG).toMatch(/uIrisLayer > 0\.5 && abs\(uGaze\.x\) \+ abs\(uGaze\.y\) > 1e-6/);
  });

  it('the upper lid follows a downward gaze part of the way, not an upward one (both heads)', () => {
    const pack = read('../../../public/assets/avatars/reference/pack.json');
    const mesh = read('../../../public/assets/avatars/reference/mesh.json');
    const rig = buildRig(pack, mesh);
    const at = (gazeY, blink = 0) => rigUniforms(rig, Object.assign(createAnimState(), { gazeY, blinkL: blink, blinkR: blink }), {}).blink[0];
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(0);
    expect(at(-1)).toBeCloseTo(RIG_LIMITS.lidGaze, 9);
    expect(at(-0.5)).toBeCloseTo(0.5 * RIG_LIMITS.lidGaze, 9);
    expect(at(-1, 1)).toBe(1); // a blink still closes all the way
    const meta = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/assets/models/head.json', import.meta.url)), 'utf8'));
    const prig = buildProcRig(meta);
    const pat = (gazeY) => procRigUniforms(prig, Object.assign(createAnimState(), { gazeY }), {}).blink[0];
    expect(pat(0)).toBe(0);
    expect(pat(0.8)).toBe(0);
    expect(pat(-1)).toBeCloseTo(0.25, 9);
  });

  it('the gaze travel is in iris radii: a larger painted iris moves farther', () => {
    const pack = read('../../../public/assets/avatars/reference/pack.json');
    const rig = buildRig(pack, read('../../../public/assets/avatars/reference/mesh.json'));
    const a = Object.assign(createAnimState(), { gazeX: 1, gazeY: 1 });
    const g0 = rigUniforms(rig, a, {}).gaze.slice();
    for (const k of ['L', 'R']) rig.eyes[k].irisR *= 1.25;
    const g1 = rigUniforms(rig, a, {}).gaze;
    expect(g1[0]).toBeCloseTo(1.25 * g0[0], 9);
    expect(g1[1] * pack.plate.height).toBeCloseTo(1.25 * RIG_LIMITS.gazeY * pack.rig.eyes.L.irisRadius * 0.5 * (1 + pack.rig.eyes.R.irisRadius / pack.rig.eyes.L.irisRadius), 6);
  });
});
