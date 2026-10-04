// Pure helpers of the engine that do not need WebGL.
import { describe, expect, it } from 'vitest';
import { HEAD_NAMES, normalizeOptions, pointInPolygon } from '../../../src/avatar/index.js';
import { fillHaloBases } from '../../../src/avatar/fx/particles.js';
import { QUALITY, normalizeQuality } from '../../../src/avatar/quality.js';
import { clamp, expApproach, fbm1, hash1, mulberry32, noise1 } from '../../../src/avatar/noise.js';

describe('normalizeOptions', () => {
  it('fills contract defaults', () => {
    const o = normalizeOptions();
    expect(o.renderer).toBe('relief');
    expect(o.packUrl).toBe('./assets/avatars/reference/');
    expect(o.quality).toBe('high');
    expect(o.particles).toBe(1);
    expect(o.bloom).toBe(1);
    expect(o.transparent).toBe(true);
    expect(o.fixedTime).toBeUndefined();
    expect(o.seed).toBe(1);
  });
  it('clamps and sanitises', () => {
    const o = normalizeOptions({ renderer: 'bogus', quality: 'ultra', particles: 9, bloom: -1, packUrl: 'x', fixedTime: 2, transparent: false });
    expect(o.renderer).toBe('relief');
    expect(o.quality).toBe('high');
    expect(o.particles).toBe(2);
    expect(o.bloom).toBe(0);
    expect(o.packUrl).toBe('x/');
    expect(o.fixedTime).toBe(2);
    expect(o.transparent).toBe(false);
  });
  it('knows the head names of the contract', () => {
    expect(HEAD_NAMES).toEqual(['relief', 'procedural', 'placeholder']);
  });
});

describe('pointInPolygon', () => {
  const square = [0, 0, 1, 0, 1, 1, 0, 1];
  it('works for simple and concave shapes', () => {
    expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
    expect(pointInPolygon(1.5, 0.5, square)).toBe(false);
    const u = [0, 0, 3, 0, 3, 3, 2, 3, 2, 1, 1, 1, 1, 3, 0, 3];
    expect(pointInPolygon(1.5, 2, u)).toBe(false);   // inside the notch
    expect(pointInPolygon(0.5, 2, u)).toBe(true);
  });
});

describe('quality tiers', () => {
  it('scale particles and resolution down', () => {
    expect(QUALITY.high.particles).toBeGreaterThan(QUALITY.medium.particles);
    expect(QUALITY.medium.particles).toBeGreaterThan(QUALITY.low.particles);
    expect(QUALITY.low.dprCap).toBeLessThanOrEqual(QUALITY.medium.dprCap);
    expect(QUALITY.medium.bloomScale).toBeLessThanOrEqual(0.5);
    expect(normalizeQuality('medium')).toBe('medium');
    expect(normalizeQuality(undefined)).toBe('high');
  });
});

describe('noise', () => {
  it('mulberry32 is deterministic and uniform-ish', () => {
    const a = mulberry32(5), b = mulberry32(5);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });
  it('noise1 is continuous, bounded and seed dependent', () => {
    let maxStep = 0;
    for (let x = 0; x < 20; x += 0.01) {
      const v = noise1(x, 3);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      maxStep = Math.max(maxStep, Math.abs(noise1(x + 0.01, 3) - v));
    }
    expect(maxStep).toBeLessThan(0.08);
    expect(noise1(1.37, 1)).not.toBe(noise1(1.37, 2));
    expect(Math.abs(fbm1(2.5, 1))).toBeLessThanOrEqual(1.01);
    expect(hash1(7, 1)).toBe(hash1(7, 1));
  });
  it('helpers', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(expApproach(0, 0.1)).toBe(0);
    expect(expApproach(1, 0)).toBe(1);
  });
});

describe('fillHaloBases', () => {
  it('places halo particles on the outline with outward normals, none on the faded neck end', () => {
    const n = 500;
    const seeds = new Float32Array(n * 4);
    const rng = mulberry32(1);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
    // square outline around the origin, bottom edge below the neck cut
    const outline = [-1, -1, 1, -1, 1, 1, -1, 1];
    const base = new Float32Array(n * 4);
    fillHaloBases(base, seeds, outline, { center: [0, 0], radius: [1, 1], neckBottom: -0.95 });
    let bottom = 0;
    for (let k = 0; k < n; k++) {
      const [x, y, nx, ny] = base.slice(k * 4, k * 4 + 4);
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeCloseTo(1, 4);   // on the square
      expect(nx * x + ny * y).toBeGreaterThan(0);                     // outward
      if (y < -0.999 && Math.abs(x) < 0.999) bottom++;
    }
    expect(bottom).toBe(0);
  });
});
