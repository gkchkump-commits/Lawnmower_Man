// Engine runtime helpers: quality governor, head motion limits, context-loss cleanup.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { limitHeadMotion, normalizeOptions, softLimit } from '../../../src/avatar/index.js';
import { QualityGovernor, lowerQuality } from '../../../src/avatar/quality.js';
import { MAX_DT, collectGLResources, forgetDisposeListeners } from '../../../src/avatar/stage.js';
import { createAnimState } from '../../../src/avatar/director.js';

describe('QualityGovernor', () => {
  const feed = (g, from, to, fps, q, step = 1 / 30) => {
    let out = null;
    for (let t = from; t <= to && !out; t += step) out = g.sample(t, fps, q);
    return out;
  };
  it('steps down one tier after ~3 s below 24 fps, never during the warm-up', () => {
    const g = new QualityGovernor();
    expect(feed(g, 0, 2.4, 10, 'high')).toBeNull();          // warm-up (2.5 s)
    expect(feed(g, 2.5, 5.4, 10, 'high')).toBeNull();        // < 3 s below the limit
    expect(feed(g, 5.4, 6.0, 10, 'high')).toBe('medium');
  });
  it('restarts its clock after a switch, at good frame rates and after a pause', () => {
    const g = new QualityGovernor({ warmupSec: 0, holdSec: 3 });
    expect(feed(g, 0, 2.0, 12, 'medium')).toBeNull();
    expect(feed(g, 2.0, 4.0, 40, 'medium')).toBeNull();      // good frames reset the clock
    expect(feed(g, 4.0, 6.5, 12, 'medium')).toBeNull();      // (the 1 s smoothing lags ~0.4 s)
    expect(feed(g, 6.5, 8.5, 12, 'medium')).toBe('low');
    // hidden window: samples stop for 10 s; the low-fps time before the pause does not count
    const h = new QualityGovernor({ warmupSec: 0, holdSec: 3 });
    expect(feed(h, 0, 2.5, 12, 'high')).toBeNull();
    expect(h.sample(12.5, 12, 'high')).toBeNull();
    expect(feed(h, 12.5, 15.3, 12, 'high')).toBeNull();
  });
  it('is not fooled by jitter around the limit', () => {
    const g = new QualityGovernor();
    let out = null;
    for (let t = 0; t < 8 && !out; t += 1 / 22) out = g.sample(t, Math.floor(t * 22) % 2 ? 25.5 : 19.5, 'high');
    expect(out).toBe('medium');                              // ~22.5 fps on average
    const ok = new QualityGovernor();
    out = null;
    for (let t = 0; t < 20 && !out; t += 1 / 30) out = ok.sample(t, Math.floor(t * 30) % 2 ? 33 : 23, 'high');
    expect(out).toBeNull();                                  // ~28 fps with dips below 24
  });
  it('leaves the low tier and unknown frame rates alone', () => {
    const g = new QualityGovernor({ warmupSec: 0 });
    expect(feed(g, 0, 10, 5, 'low')).toBeNull();
    expect(feed(g, 0, 10, 0, 'high')).toBeNull();
    expect(lowerQuality('high')).toBe('medium');
    expect(lowerQuality('medium')).toBe('low');
    expect(lowerQuality('low')).toBe('low');
  });
  it('is on by default for live avatars and off for frozen-time renders', () => {
    expect(normalizeOptions().autoQuality).toBe(true);
    expect(normalizeOptions({ fixedTime: 1 }).autoQuality).toBe(false);
    expect(normalizeOptions({ autoQuality: false }).autoQuality).toBe(false);
  });
});

describe('head motion limits', () => {
  it('soft-limits yaw / pitch / roll to the head range, ~identity for small angles', () => {
    expect(softLimit(0.02, 0.25)).toBeCloseTo(0.02, 3);
    expect(softLimit(1, 0.25)).toBeLessThan(0.25);
    expect(softLimit(-1, 0.25)).toBeGreaterThan(-0.25);
    const a = createAnimState();
    Object.assign(a, { headYaw: 0.35, headPitch: -0.25, headRoll: 0.01 });
    limitHeadMotion(a, { yaw: 0.25, pitch: 0.18, roll: 0.2 });
    expect(a.headYaw).toBeLessThan(0.25);
    expect(a.headYaw).toBeGreaterThan(0.2);
    expect(a.headPitch).toBeGreaterThan(-0.18);
    expect(a.headRoll).toBeCloseTo(0.01, 4);
    const b = createAnimState();
    b.headYaw = 0.3;
    expect(limitHeadMotion(b, null).headYaw).toBe(0.3);   // heads without limits are untouched
  });
  it('caps the simulation step at 1/8 s (slow renderers no longer play in slow motion < 15 fps)', () => {
    expect(MAX_DT).toBeCloseTo(1 / 8, 9);
  });
});

describe('context loss cleanup', () => {
  it('detaches stale dispose listeners from every GL resource of the scene', () => {
    const scene = new THREE.Scene();
    const tex = new THREE.Texture();
    const mat = new THREE.ShaderMaterial({ uniforms: { tA: { value: tex }, uX: { value: 1 } } });
    const geo = new THREE.BufferGeometry();
    scene.add(new THREE.Mesh(geo, mat));
    const res = collectGLResources(scene);
    expect(res.has(tex) && res.has(mat) && res.has(geo)).toBe(true);
    const stale = vi.fn();
    for (const o of res) o.addEventListener('dispose', stale);
    expect(forgetDisposeListeners(res)).toBe(3);
    tex.dispose(); mat.dispose(); geo.dispose();
    expect(stale).not.toHaveBeenCalled();
    // listeners added after the restore work normally
    const fresh = vi.fn();
    tex.addEventListener('dispose', fresh);
    tex.dispose();
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
