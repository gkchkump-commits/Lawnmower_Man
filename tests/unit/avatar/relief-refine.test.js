// Mesh refinement of the relief head's mouth region (src/avatar/heads/relief/refine.js): the rest
// surface is exactly what it was (original vertices untouched, new ones on the old edges with
// linearly interpolated attributes, the same area and winding, no T-junctions), only sampled finer.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mouthRegion, refineMesh } from '../../../src/avatar/heads/relief/refine.js';
import { refineFaceMesh } from '../../../src/avatar/heads/relief/index.js';

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

/** a w x h grid of quads (two triangles each), spacing s px, with a linear attribute f = 2x + 3y */
function grid(nx, ny, s) {
  const positions = [], f = [], indices = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { positions.push(i * s, j * s, 0.1 * i); f.push(2 * i * s + 3 * j * s); }
  const v = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) indices.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  return { positions, indices, attrs: { f: { data: f, size: 1 } } };
}

const signedArea = (p, a, b, c) => 0.5 * ((p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]));

function stats(mesh) {
  const p = mesh.positions, idx = mesh.indices;
  let area = 0, minSigned = Infinity;
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const s = signedArea(p, idx[t], idx[t + 1], idx[t + 2]);
    area += s;
    minSigned = Math.min(minSigned, s);
    for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let boundary = 0, overShared = 0;
  for (const [k, n] of edges) {
    if (n > 2) overShared++;
    if (n === 1) {
      const [a, b] = k.split(',').map(Number);
      boundary += Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]);
    }
  }
  return { area, minSigned, boundary, overShared, edges };
}

describe('refineMesh', () => {
  const g = grid(8, 6, 16);
  const inside = (x, y) => Math.hypot(x - 64, y - 48) < 40;
  const r = refineMesh(g, { inside, maxLen: 6, levels: 3 });

  it('keeps the original vertices and appends new ones on the old edges', () => {
    const n0 = g.positions.length / 3;
    expect(r.added).toBeGreaterThan(100);
    expect(r.vertexCount).toBe(n0 + r.added);
    expect(Array.from(r.positions.slice(0, n0 * 3))).toEqual(g.positions.map((v) => Math.fround(v)));
    // every attribute is the linear interpolation (f = 2x + 3y holds at every new vertex)
    for (let i = n0; i < r.vertexCount; i++) {
      expect(r.attrs.f[i]).toBeCloseTo(2 * r.positions[i * 3] + 3 * r.positions[i * 3 + 1], 2);
    }
  });

  it('is conforming: same area and winding, no T-junctions, the same boundary', () => {
    const a = stats({ positions: g.positions, indices: g.indices });
    const b = stats(r);
    expect(b.area).toBeCloseTo(a.area, 3);
    expect(b.minSigned).toBeGreaterThan(0); // no flipped or degenerate triangles
    expect(b.overShared).toBe(0);
    // a T-junction would leave an interior edge with one triangle (extra boundary length)
    expect(b.boundary).toBeCloseTo(a.boundary, 6);
  });

  it('refines inside the region only, down to maxLen', () => {
    let maxIn = 0, maxOut = 0;
    for (const k of stats(r).edges.keys()) {
      const [a, b] = k.split(',').map(Number);
      const p = r.positions;
      const len = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]);
      const mx = 0.5 * (p[a * 3] + p[b * 3]), my = 0.5 * (p[a * 3 + 1] + p[b * 3 + 1]);
      if (Math.hypot(mx - 64, my - 48) < 30) maxIn = Math.max(maxIn, len);
      else if (Math.hypot(mx - 64, my - 48) > 50) maxOut = Math.max(maxOut, len);
    }
    expect(maxIn).toBeLessThanOrEqual(6);
    expect(maxOut).toBeCloseTo(16 * Math.SQRT2, 6); // untouched far away
  });
});

describe('the relief head mesh', () => {
  const pack = read('../../../public/assets/avatars/reference/pack.json');
  const mesh = read('../../../public/assets/avatars/reference/mesh.json');
  const m = refineFaceMesh(mesh, pack);

  it('samples the mouth at <= ~6 px and leaves the baked vertices in place', () => {
    expect(m.vertexCount).toBeGreaterThan(2 * mesh.vertexCount);
    expect(m.vertexCount).toBeLessThan(65536 * 4);
    for (let i = 0; i < mesh.positions.length; i++) expect(m.positions[i]).toBe(Math.fround(mesh.positions[i]));
    const inMouth = mouthRegion(pack);
    let worst = 0;
    const p = m.positions, idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
      for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const mx = 0.5 * (p[a * 3] + p[b * 3]), my = 0.5 * (p[a * 3 + 1] + p[b * 3 + 1]);
        // (well inside the region: edges straddling its rim are split there or not at all)
        const hw = pack.rig.mouth.halfWidth, [cx, cy] = pack.rig.mouth.center;
        if (!inMouth(mx, my) || Math.hypot((mx - cx) / (1.4 * hw), (my - cy - 0.15 * hw) / (0.8 * hw)) > 1) continue;
        worst = Math.max(worst, Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]));
      }
    }
    expect(worst).toBeLessThanOrEqual(6.2);
    // the weights stay in range, the attribute arrays match the vertex count
    for (const k of Object.keys(mesh.weights)) {
      expect(m.weights[k].length).toBe(m.vertexCount);
      expect(Math.max(...m.weights[k])).toBeLessThanOrEqual(mesh.weightScale);
    }
    expect(m.edge.length).toBe(m.vertexCount);
  });
});
