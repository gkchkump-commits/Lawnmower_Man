// Invariants of the committed procedural head model (public/assets/models/head.*) and of the
// decoder in src/avatar/heads/procedural/format.js.
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CURVE_TEX_WIDTH, FORMAT, RIG_CHANNELS, decodeModel, packCurveTexture, validateMeta,
} from '../../../src/avatar/heads/procedural/format.js';

/** Even-odd point in polygon on a flat [x0, y0, x1, y1, ...] array. */
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const dir = fileURLToPath(new URL('../../../public/assets/models/', import.meta.url));
const meta = JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8'));
const bin = readFileSync(join(dir, meta.buffer.uri));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const model = decodeModel(meta, buffer);

const clone = (o) => JSON.parse(JSON.stringify(o));

describe('committed procedural head model', () => {
  it('validates and stays small (< 2 MB)', () => {
    expect(validateMeta(meta)).toEqual([]);
    expect(meta.format).toBe(FORMAT);
    const size = statSync(join(dir, 'head.json')).size + statSync(join(dir, meta.buffer.uri)).size;
    expect(size).toBeLessThan(2 * 1024 * 1024);
  });

  it('records the scan attribution (CC BY 3.0)', () => {
    expect(meta.source.attribution).toMatch(/Lee Perry-Smith/);
    expect(meta.source.license).toBe('CC BY 3.0');
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/Lee Perry-Smith/);
    expect(readme).toMatch(/CC BY 3\.0/);
  });

  it('decodes consistent buffers', () => {
    const n = model.vertexCount;
    expect(model.positions.length).toBe(n * 3);
    expect(model.rig.length).toBe(n * RIG_CHANNELS.length);
    expect(model.index.length % 3).toBe(0);
    expect(model.skinVertexCount).toBeLessThan(n);
    // every vertex is referenced by a triangle
    const used = new Uint8Array(n);
    for (const i of model.index) used[i] = 1;
    expect(used.every((u) => u === 1)).toBe(true);
  });

  it('has no degenerate skin triangles', () => {
    const P = model.positions, I = model.index, skin = model.skinVertexCount;
    let degenerate = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (a >= skin || b >= skin || c >= skin) continue;
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area < 1e-12) degenerate++;
    }
    expect(degenerate).toBe(0);
  });

  it('flags exactly the mouth cavity vertices as cavity', () => {
    const n = model.vertexCount, skin = model.skinVertexCount, cav = model.cavity;
    for (let i = 0; i < n; i++) expect(cav[i * 4] > 127).toBe(i >= skin);
  });

  it('welds the cavity rim to the lip edges (no gap whatever the rig does)', () => {
    // every cavity vertex at depth 0 (cav.v == 0) sits exactly on a skin vertex of the lip
    // edge AND carries the same rig weights, so both always move together
    const P = model.positions, W = model.rig, skin = model.skinVertexCount, cav = model.cavity;
    const C = RIG_CHANNELS.length;
    const key = (i) => `${P[i * 3].toFixed(5)},${P[i * 3 + 1].toFixed(5)},${P[i * 3 + 2].toFixed(5)}`;
    const wkey = (i) => Array.from(W.subarray(i * C, i * C + C)).join(',');
    const skinAt = new Map();
    for (let i = 0; i < skin; i++) {
      const k = key(i);
      if (!skinAt.has(k)) skinAt.set(k, []);
      skinAt.get(k).push(wkey(i));
    }
    let rim = 0;
    for (let i = skin; i < model.vertexCount; i++) {
      if (cav[i * 4 + 2] !== 0) continue;
      rim++;
      const twins = skinAt.get(key(i));
      expect(twins).toBeDefined();
      expect(twins).toContain(wkey(i));
    }
    expect(rim).toBeGreaterThan(20);
  });

  it('fits the relief framing (head inside the 1-unit view, eyes and mouth where expected)', () => {
    const [ex, ey] = [meta.eyes[0].center, meta.eyes[1].center];
    expect(ex[0]).toBeLessThan(0);
    expect(ey[0]).toBeGreaterThan(0);
    // reference frame: eyes ~0.08 above the centre, mouth ~0.16 below
    expect((ex[1] + ey[1]) / 2).toBeGreaterThan(0.03);
    expect((ex[1] + ey[1]) / 2).toBeLessThan(0.13);
    expect(meta.rig.mouthCenter[1]).toBeLessThan(-0.1);
    expect(meta.rig.mouthCenter[1]).toBeGreaterThan(-0.22);
    expect(meta.features.headTop).toBeLessThan(0.5);
    expect(meta.features.headTop).toBeGreaterThan(0.4);
  });

  it('has an outline that contains the face and excludes the corners of the view', () => {
    const o = meta.outline;
    for (const e of meta.eyes) expect(pointInPolygon(e.center[0], e.center[1], o)).toBe(true);
    expect(pointInPolygon(meta.rig.mouthCenter[0], meta.rig.mouthCenter[1], o)).toBe(true);
    expect(pointInPolygon(0.32, 0.48, o)).toBe(false);
    expect(pointInPolygon(-0.32, -0.48, o)).toBe(false);
  });

  it('keeps every rig weight inside the face where it belongs', () => {
    const P = model.positions, W = model.rig, n = model.skinVertexCount;
    const C = RIG_CHANNELS.length;
    const jaw = RIG_CHANNELS.indexOf('jaw');
    const browL = RIG_CHANNELS.indexOf('browL');
    for (let i = 0; i < n; i++) {
      const y = P[i * 3 + 1], z = P[i * 3 + 2];
      // nothing above the eyes or on the back of the head moves with the jaw
      if (y > meta.eyes[0].center[1] || z < meta.rig.jawPivot[2] - 0.05) expect(W[i * C + jaw]).toBeLessThan(13);
      // the brows stay above the nose tip
      if (y < meta.features.noseTip[1]) expect(W[i * C + browL]).toBeLessThan(13);
    }
  });

  it('describes eyes with an upper lid above the lower lid', () => {
    for (const e of meta.eyes) {
      for (let t = -0.8; t <= 0.8; t += 0.2) {
        const lid = (c) => (1 - t * t) * (c[0] + c[1] * t + c[2] * t * t);
        expect(lid(e.upper)).toBeGreaterThan(lid(e.lower));
      }
      expect(e.irisRadius).toBeLessThan(e.ballRadius);
      expect(e.pupilRadius).toBeLessThan(e.irisRadius);
    }
  });
});

describe('format validation', () => {
  it('rejects broken metadata', () => {
    expect(validateMeta(null)).not.toEqual([]);
    const m1 = clone(meta); m1.format = 'nope';
    expect(validateMeta(m1).join()).toMatch(/format/);
    const m2 = clone(meta); m2.layout.rig.offset += 1;
    expect(validateMeta(m2).join()).toMatch(/misaligned/);
    const m3 = clone(meta); m3.buffer.uri = '../../etc/passwd';
    expect(validateMeta(m3).join()).toMatch(/plain file name/);
    const m4 = clone(meta); m4.eyes = [m4.eyes[0]];
    expect(validateMeta(m4).join()).toMatch(/two eyes/);
    const m5 = clone(meta); m5.curves.chunks[0].count = 1e6;
    expect(validateMeta(m5).join()).toMatch(/out of range/);
    const m6 = clone(meta); m6.curves.groups[1].firstChunk += 1;
    expect(validateMeta(m6).join()).toMatch(/groups/);
  });

  it('rejects truncated buffers and out-of-range indices', () => {
    expect(() => decodeModel(meta, buffer.slice(0, buffer.byteLength - 4))).toThrow(/bytes/);
    const bad = buffer.slice(0);
    const L = meta.layout.index;
    const Ctor = L.type === 'uint32' ? Uint32Array : Uint16Array;
    new Ctor(bad, L.offset, 1)[0] = meta.vertexCount + 5;
    expect(() => decodeModel(meta, bad)).toThrow(/out of range/);
  });
});

describe('packCurveTexture', () => {
  it('stores points, then 2-texel records per chunk and per curve group', () => {
    const pts = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0.5, 2, 0, 0, 0.25]);
    const chunks = [{ start: 0, count: 2, center: [1, 0, 0], radius: 1 }];
    const groups = [{ firstChunk: 0, chunkCount: 1, center: [1, 0, 0], radius: 1.5 }];
    const t = packCurveTexture(pts, chunks, groups, 0.1);
    expect(t.width).toBe(CURVE_TEX_WIDTH);
    expect(t.chunkBase).toBe(3);
    expect(t.chunkCount).toBe(1);
    expect(t.groupBase).toBe(5);
    expect(t.groupCount).toBe(1);
    expect(Array.from(t.data.slice(0, 12))).toEqual(Array.from(pts));
    const o = t.chunkBase * 4;
    expect(t.data[o]).toBe(1);
    expect(t.data[o + 3]).toBeCloseTo(1.1);
    expect(t.data[o + 4]).toBe(0);
    expect(t.data[o + 5]).toBe(2);
    const g = t.groupBase * 4;
    expect(t.data[g + 3]).toBeCloseTo(1.6);
    expect(t.data[g + 4]).toBe(0);
    expect(t.data[g + 5]).toBe(1);
  });

  it('bounds every chunk of the real model', () => {
    const P = model.curvePoints;
    for (const c of model.curveChunks) {
      for (let i = c.start; i <= c.start + c.count; i++) {
        const d = Math.hypot(P[i * 4] - c.center[0], P[i * 4 + 1] - c.center[1], P[i * 4 + 2] - c.center[2]);
        expect(d).toBeLessThanOrEqual(c.radius + 1e-4);
      }
    }
    // every chunk lies inside its curve group's sphere
    for (const g of model.curveGroups) {
      for (let k = g.firstChunk; k < g.firstChunk + g.chunkCount; k++) {
        const c = model.curveChunks[k];
        const d = Math.hypot(c.center[0] - g.center[0], c.center[1] - g.center[1], c.center[2] - g.center[2]);
        expect(d).toBeLessThanOrEqual(g.radius + 1e-4);
      }
    }
    const t = packCurveTexture(model.curvePoints, model.curveChunks, model.curveGroups, 0.016);
    expect(t.height * t.width).toBeGreaterThanOrEqual(t.groupBase + 2 * t.groupCount);
  });
});
