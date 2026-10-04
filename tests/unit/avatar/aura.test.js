// Pure helpers of the particle aura (wisp ribbons, collar) and the relief head's anchors.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KIND_FRACTIONS, RADIUS_SAMPLES, WISP_STREAMS, assignWispSlots, jawEllipse, outlineRadii, smoothRadii,
  wispDensity,
} from '../../../src/avatar/fx/particles.js';
import { jawFromLandmarks } from '../../../src/avatar/heads/relief/index.js';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/assets/avatars/reference/pack.json', import.meta.url)), 'utf8'));

function circle(r, n = 64, cx = 0, cy = 0) {
  const o = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    o.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return o;
}

describe('outlineRadii', () => {
  it('measures a circle around its centre', () => {
    const r = outlineRadii(circle(0.4, 128, 0.1, -0.2), [0.1, -0.2], RADIUS_SAMPLES, () => -1);
    expect(r.length).toBe(RADIUS_SAMPLES);
    for (const v of r) {
      expect(v).toBeGreaterThan(0.399);
      expect(v).toBeLessThan(0.4001);
    }
  });
  it('takes the farthest crossing (ears) and falls back when the ray misses', () => {
    // a square with a spike to the right (+x): the ray at angle 0 reaches the spike tip
    const shape = [-1, -1, 1, -1, 1, -0.1, 3, 0, 1, 0.1, 1, 1, -1, 1];
    const r = outlineRadii(shape, [0, 0], 8, () => 7);
    const at0 = r[4];                       // angles start at -PI, step PI/4 -> index 4 = 0 rad
    expect(at0).toBeCloseTo(3, 6);
    expect(r[0]).toBeCloseTo(1, 6);         // -PI: the left edge
    const miss = outlineRadii([5, 5, 6, 5, 6, 6], [0, 0], 4, () => 7);
    expect(Array.from(miss).filter((v) => v === 7).length).toBeGreaterThan(0);
  });
});

describe('smoothRadii', () => {
  it('keeps a constant table and fills a narrow notch', () => {
    const flat = new Float32Array(48).fill(0.3);
    for (const v of smoothRadii(flat, 1, 1.5)) expect(v).toBeCloseTo(0.3, 6);
    const notch = new Float32Array(48).fill(0.3);
    notch[10] = 0.1;                         // the gap between ear and cranium
    const s = smoothRadii(notch, 1, 1.5);
    expect(s[10]).toBeGreaterThan(0.29);
    expect(Math.max(...s)).toBeLessThanOrEqual(0.3 + 1e-6);
  });
});

describe('assignWispSlots', () => {
  const wisp = KIND_FRACTIONS.findIndex(([k]) => k === 'wisp');
  const n = 4000;
  const kinds = new Float32Array(n).map((_, i) => (i % 3 === 0 ? wisp : 0));
  const seeds = new Float32Array(n * 4).fill(0.5);
  const count = assignWispSlots(seeds, kinds, wisp);
  it('only touches wisp particles', () => {
    expect(count).toBe(Math.ceil(n / 3));
    expect(Array.from(seeds.slice(4, 8))).toEqual([0.5, 0.5, 0.5, 0.5]);   // particle 1 is a halo mote
  });
  it('spreads every prefix of the buffer evenly over sides, streams and the ribbon length', () => {
    // the first 10% of the wisps (what a low quality tier may draw) already covers every lane
    const lanes = new Map();
    let seen = 0;
    for (let i = 0; i < n && seen < count / 10; i++) {
      if (kinds[i] !== wisp) continue;
      seen++;
      const side = seeds[i * 4] < 0.5 ? 0 : 1;
      const stream = Math.floor(seeds[i * 4 + 1] * WISP_STREAMS);
      const key = `${side}:${stream}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(seeds[i * 4 + 2]);
    }
    expect(lanes.size).toBe(2 * WISP_STREAMS);
    for (const slots of lanes.values()) {
      for (const u of slots) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
      // no big gap along the ribbon: the largest gap between sorted slots stays small
      const s = [...slots].sort((a, b) => a - b);
      let gap = s[0] + 1 - s[s.length - 1];
      for (let k = 1; k < s.length; k++) gap = Math.max(gap, s[k] - s[k - 1]);
      expect(gap).toBeLessThan(0.25);
    }
  });
});

describe('wisp sprite density', () => {
  it('grows sprites mildly for sparse auras and never below 1', () => {
    expect(wispDensity(6000)).toBe(1);
    expect(wispDensity(12000)).toBe(1);
    expect(wispDensity(1200)).toBeGreaterThan(1.4);
    expect(wispDensity(1200)).toBeLessThanOrEqual(1.6);
    expect(wispDensity(1)).toBe(1.6);
  });
});

describe('jaw ellipse for the collar', () => {
  it('derives a jaw from the head ellipse when the head gives none', () => {
    const j = jawEllipse({ center: [0, 0.1], radius: [0.3, 0.4] });
    expect(j.center[1] - j.radius[1]).toBeCloseTo(0.1 - 0.4, 9);   // bottom of the jaw = chin
    expect(j.radius[0]).toBeLessThan(0.3);
  });
  it('uses the relief landmarks: jaw angles -> chin', () => {
    const W = pack.plate.width, H = pack.plate.height;
    const j = jawFromLandmarks(pack.landmarks, W, H);
    const chinW = (H / 2 - pack.landmarks.chin[1]) / H;
    expect(j.center[1] - j.radius[1]).toBeCloseTo(chinW, 6);
    expect(j.radius[0]).toBeGreaterThan(0.1);
    expect(jawEllipse({ center: [0, 0], radius: [1, 1], jaw: j })).toBe(j);
    expect(jawFromLandmarks({}, W, H)).toBeUndefined();
  });
});
