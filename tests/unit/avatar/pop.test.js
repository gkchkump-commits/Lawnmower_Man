// The hologram's depth and glow (no WebGL needed): the relief's normals for its light, the aura
// turning with the head, the quality tiers, the projector's placement and the new options.
import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '../../../src/avatar/index.js';
import { Particles, yprMatrix } from '../../../src/avatar/fx/particles.js';
import { BLOOM_GAIN, COVERAGE_GATE, HALO, haloMix } from '../../../src/avatar/fx/post.js';
import { Projector } from '../../../src/avatar/fx/projector.js';
import { RELIEF_LIGHT, liteDefines, reliefNormals } from '../../../src/avatar/heads/relief/index.js';
import { FACE_FRAG, FACE_VERT } from '../../../src/avatar/heads/relief/shaders.js';
import { headRotation } from '../../../src/avatar/heads/relief/rig.js';
import { rotationYPR } from '../../../src/avatar/heads/procedural/rig.js';
import { QUALITY } from '../../../src/avatar/quality.js';
import { createAnimState } from '../../../src/avatar/director.js';

/** A height-field grid z(x, y) as positions + triangles (both windings, to test the orientation). */
function grid(f, n = 12) {
  const pos = [], idx = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = i / n - 0.5, y = j / n - 0.5;
    pos.push(x, y, f(x, y));
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    // alternate windings: the normals must not care
    if ((i + j) % 2) idx.push(a, b, d, a, d, c); else idx.push(a, d, b, a, c, d);
  }
  return { pos: Float32Array.from(pos), idx };
}

describe('relief light', () => {
  it('normals of the relief face the viewer, tilt outward on a dome, unit length', () => {
    const flat = grid(() => 0);
    const nf = reliefNormals(flat.pos, flat.idx);
    for (let v = 0; v < nf.length; v += 3) expect(nf[v + 2]).toBeCloseTo(1, 6);
    const dome = grid((x, y) => Math.sqrt(Math.max(0, 0.6 - x * x - y * y)));
    const nd = reliefNormals(dome.pos, dome.idx);
    const at = (i, j) => (j * 13 + i) * 3;
    // left edge looks left, right edge right, top up, centre straight out
    expect(nd[at(0, 6)]).toBeLessThan(-0.4);
    expect(nd[at(12, 6)]).toBeGreaterThan(0.4);
    expect(nd[at(6, 12) + 1]).toBeGreaterThan(0.4);
    expect(nd[at(6, 6) + 2]).toBeGreaterThan(0.99);
    for (let v = 0; v < nd.length; v += 3) expect(Math.hypot(nd[v], nd[v + 1], nd[v + 2])).toBeCloseTo(1, 5);
  });

  it('has a turn-responsive light, a glint, a rim and sharpening (and the relief occludes with its mask)', () => {
    for (const k of ['diffuse', 'glint', 'rim', 'sharpen']) expect(RELIEF_LIGHT[k], k).toBeGreaterThan(0);
    expect(RELIEF_LIGHT.diffuse).toBeLessThanOrEqual(0.7);
    expect(COVERAGE_GATE).toEqual([0.04, 0.24]);
    expect(HALO.strength).toBeGreaterThan(0.2);
    expect(HALO.strength).toBeLessThan(0.4);
    // (the rim stays the hologram's cyan and moderate: a whitened edge melts into a white desktop)
    expect(RELIEF_LIGHT.rim).toBeLessThanOrEqual(0.6);
    expect(BLOOM_GAIN).toBeLessThan(0.5);
  });

  it('the silhouette halo is as wide in CSS px at any display scale: its base level moves with the pixel ratio', () => {
    // weight of each level's coverage in the final blur (the up-chain mixes level i with the coarser)
    const weights = (m) => {
      const w = [];
      let k = 1;
      for (let i = 0; i < m.length - 1; i++) { w.push(k * (1 - m[i])); k *= m[i]; }
      w.push(k);
      return w;
    };
    // the CSS width of a level's texel: 2^i / (bloomScale x pixel ratio)
    const cssWidth = (pr, bs, n) => weights(haloMix(n, pr, bs)).reduce((s, w, i) => s + w * (2 ** i) / (bs * pr), 0);
    // (High and Medium: 5 and 4 levels; Low: a quarter-resolution chain of 3)
    for (const [pr, bs, n] of [[2, 0.5, 5], [1.5, 0.5, 5], [1.25, 0.5, 5], [2, 0.5, 4], [1.5, 0.5, 4], [1, 0.25, 3]]) {
      const ref = cssWidth(1, 0.5, n === 3 ? 4 : n);
      expect(cssWidth(pr, bs, n) / ref, `pr ${pr} bloom ${bs} levels ${n}`).toBeGreaterThan(0.75);
      expect(cssWidth(pr, bs, n) / ref, `pr ${pr} bloom ${bs} levels ${n}`).toBeLessThan(1.33);
    }
    // a thin outline, not a fog: most of the weight within two levels of the base
    const w = weights(haloMix(5, 1, 0.5));
    expect(w[1] + w[2]).toBeGreaterThan(0.75);
    expect(w[4]).toBeLessThan(0.1);
    for (const m of haloMix(5, 3, 0.5)) { expect(m).toBeGreaterThanOrEqual(HALO.mix); expect(m).toBeLessThanOrEqual(1); }
  });
});

describe('the aura turns with the head (parallax)', () => {
  it('the particles\' rotation is the heads\' convention', () => {
    const a = new Float32Array(9), b = new Float32Array(9), c = new Float32Array(9);
    for (const [y, p, r] of [[0.2, -0.1, 0.05], [-0.3, 0.15, -0.1], [0, 0, 0.2]]) {
      yprMatrix(y, p, r, a); headRotation(y, p, r, b); rotationYPR(y, p, r, c);
      for (let i = 0; i < 9; i++) { expect(a[i]).toBeCloseTo(b[i], 6); expect(a[i]).toBeCloseTo(c[i], 6); }
    }
  });

  it('follows the head a few frames behind (springs), at once in fixed-time renders', () => {
    const p = new Particles({ maxCount: 100, count: 100, seed: 1, palette: { wisp: 0x1ec5ff, mote: 0xffc394 } });
    p.setAnchors({ center: [0, 0.1], radius: [0.3, 0.4], neckX: 0, neckTop: -0.3, neckBottom: -0.5, neckHalfWidth: 0.12, depth: 0.26, pivot: [0, -0.05, -0.03] });
    const a = createAnimState();
    a.headYaw = 0.2; a.lean = 1;
    const yawOf = () => Math.asin(-p.uniforms.uHeadRot.value.elements[2]);
    p.update(1 / 60, 1 / 60, a);
    expect(yawOf()).toBeGreaterThan(0);
    expect(yawOf()).toBeLessThan(0.05);              // a frame in: barely started (no jump)
    for (let i = 2; i <= 30; i++) p.update(1 / 60, i / 60, a);
    expect(yawOf()).toBeGreaterThan(0.17);           // half a second: nearly there
    expect(p.uniforms.uHeadXform.value.z).toBeGreaterThan(1.02);
    expect(p.uniforms.uHeadPivot.value.toArray()).toEqual([0, -0.05, -0.03]);
    // a live frame rendered without a step (the harness's advance(0)) keeps the state
    const held = yawOf(), pt = p.uniforms.uPTime.value;
    p.update(0, 9, { ...a, headYaw: -0.3 }, false);
    expect(yawOf()).toBeCloseTo(held, 9);
    expect(p.uniforms.uPTime.value).toBe(pt);
    const q = new Particles({ maxCount: 10, count: 10, seed: 1, palette: { wisp: 0x1ec5ff, mote: 0xffc394 } });
    q.update(0, 5, a);
    expect(Math.asin(-q.uniforms.uHeadRot.value.elements[2])).toBeCloseTo(0.2, 6);
  });
});

describe('quality tiers and options', () => {
  it('High renders at the display\'s resolution up to 2x with MSAA; Low stays as cheap and as crisp as it was', () => {
    expect(QUALITY.high.dprCap).toBe(2);
    expect(QUALITY.high.msaa).toBeGreaterThanOrEqual(4);
    expect(QUALITY.medium.msaa).toBeGreaterThan(0);
    // (no FXAA on Low: it smeared the fine wire grid and the irises and cost a fifth more)
    expect(QUALITY.low).toEqual({ dprCap: 1, msaa: 0, particles: 1200, bloomScale: 0.25, bloomLevels: 3, halfFloat: false });
    // ... and its relief shader goes without the light (the turn light, glint, rim, sharpening,
    // scan lines): as cheap as before it
    expect(liteDefines('low')).toEqual({ RELIEF_LITE: '' });
    expect(liteDefines('medium')).toEqual({});
    expect(liteDefines('high')).toEqual({});
    for (const src of [FACE_VERT, FACE_FRAG]) {
      expect((src.match(/#ifndef RELIEF_LITE/g) || []).length).toBe((src.match(/#endif/g) || []).length);
    }
    expect((FACE_FRAG.match(/#ifndef RELIEF_LITE/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('normalizes liveliness, the projector and the glass opacity', () => {
    const o = normalizeOptions();
    expect(o.liveliness).toBe(1);
    expect(o.projector).toBe(false);
    expect(o.opacity).toBeCloseTo(0.94, 6);
    expect(normalizeOptions({ liveliness: 7 }).liveliness).toBe(2);
    expect(normalizeOptions({ liveliness: -1, projector: 1 })).toMatchObject({ liveliness: 0, projector: true });
  });

  it('the projector sits under the bust: from the bottom of the view up to the chin, hidden by default', () => {
    const pr = new Projector({ palette: { wisp: 0x1ec5ff } });
    expect(pr.mesh.visible).toBe(false);
    pr.setAnchors({ center: [0, 0.1], radius: [0.3, 0.4], neckX: 0.01, neckTop: -0.3, neckBottom: -0.5, neckHalfWidth: 0.12, depth: 0.26 }, -0.5, 0.67);
    const e = pr.uniforms.uEmit.value;
    expect(e.x).toBeCloseTo(0.01, 6);
    expect(e.y).toBeGreaterThan(-0.5);
    expect(e.y + e.z).toBeCloseTo(-0.3, 6);           // the cone reaches the chin
    expect(pr.mesh.position.z).toBeLessThan(0);       // behind the head (it occludes the light)
    pr.setVisible(true);
    expect(pr.mesh.visible).toBe(true);
    const a = createAnimState();
    pr.update(1, a);
    const idle = pr.uniforms.uLevel.value;
    a.sleep = 1;
    pr.update(1, a);
    expect(pr.uniforms.uLevel.value).toBeLessThan(0.5 * idle);
    pr.dispose();
  });
});
