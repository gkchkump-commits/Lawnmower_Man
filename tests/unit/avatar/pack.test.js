import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  PACK_FORMAT, WEIGHT_NAMES, packWeights, plateToWorld, validateMesh, validatePack, withSlash,
} from '../../../src/avatar/pack.js';
import { DEFAULT_PALETTE, isHexColor, mergePalette } from '../../../src/avatar/palette.js';

const dir = fileURLToPath(new URL('../../../public/assets/avatars/reference/', import.meta.url));
const pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
const mesh = JSON.parse(readFileSync(join(dir, 'mesh.json'), 'utf8'));

function dirSize(d) {
  let total = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

describe('committed reference pack', () => {
  it('has a valid manifest', () => {
    expect(validatePack(pack)).toEqual([]);
    expect(pack.format).toBe(PACK_FORMAT);
  });
  it('references files that exist', () => {
    for (const f of Object.values(pack.files)) expect(statSync(join(dir, f)).size).toBeGreaterThan(100);
    for (const p of Object.values(pack.previews)) expect(statSync(join(dir, p.file)).size).toBeGreaterThan(1000);
  });
  it('stays small (< 6 MB)', () => {
    expect(dirSize(dir)).toBeLessThan(6 * 1024 * 1024);
  });
  it('has a valid relief mesh with an open lip slit', () => {
    expect(validateMesh(mesh)).toEqual([]);
    const up = new Set(mesh.groups.slitUpper.slice(1, -1));
    const lo = new Set(mesh.groups.slitLower.slice(1, -1));
    expect(up.size).toBeGreaterThan(8);
    let crossing = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const t = mesh.indices.slice(i, i + 3);
      if (t.some((v) => up.has(v)) && t.some((v) => lo.has(v))) crossing++;
    }
    expect(crossing).toBe(0);
    // upper lip stays with the upper jaw, lower lip goes with the jaw
    const jaw = mesh.weights.jaw;
    for (const v of up) expect(jaw[v]).toBe(0);
    const centre = mesh.groups.slitLower[(mesh.groups.slitLower.length - 1) / 2];
    expect(jaw[centre]).toBe(mesh.weightScale);
  });
  it('has rig weights within range', () => {
    for (const k of WEIGHT_NAMES) {
      const w = mesh.weights[k];
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...w)).toBeLessThanOrEqual(mesh.weightScale);
      expect(Math.max(...w)).toBeGreaterThan(0);        // every control moves something
    }
  });
  it('samples a warm eye / gold line and a cyan rim palette', () => {
    for (const k of ['eye', 'line', 'rim', 'grid', 'wisp', 'mote']) expect(isHexColor(pack.palette[k])).toBe(true);
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [er, , eb] = rgb(pack.palette.eyeGlow);
    expect(er).toBeGreaterThan(eb);                     // amber
    const [rr, , rb] = rgb(pack.palette.rimGlow);
    expect(rb).toBeGreaterThan(rr);                     // cyan
  });
});

describe('validatePack / validateMesh', () => {
  it('reports problems instead of throwing', () => {
    expect(validatePack(null)).toEqual(['pack.json is not an object']);
    const bad = structuredClone(pack);
    bad.format = 'nope';
    delete bad.files.mesh;
    bad.files.plate = '../../etc/passwd';
    bad.version = 99;
    const errs = validatePack(bad);
    expect(errs.some((e) => e.includes('format'))).toBe(true);
    expect(errs.some((e) => e.includes('files.mesh'))).toBe(true);
    expect(errs.some((e) => e.includes('files.plate'))).toBe(true);
    expect(errs.some((e) => e.includes('newer'))).toBe(true);
  });
  it('catches out-of-range indices and wrong lengths', () => {
    const m = structuredClone(mesh);
    m.indices[0] = m.vertexCount + 5;
    m.weights.jaw.pop();
    const errs = validateMesh(m);
    expect(errs.some((e) => e.includes('out of range'))).toBe(true);
    expect(errs.some((e) => e.includes('weights.jaw'))).toBe(true);
  });
});

describe('helpers', () => {
  it('withSlash', () => {
    expect(withSlash('./a')).toBe('./a/');
    expect(withSlash('./a/')).toBe('./a/');
  });
  it('plateToWorld maps the plate to a unit-height, y-up frame', () => {
    const t = plateToWorld(784, 1168);
    expect(t.x(392)).toBe(0);
    expect(t.y(0)).toBeCloseTo(0.5, 9);
    expect(t.y(1168)).toBeCloseTo(-0.5, 9);
    expect(t.z(1168)).toBe(1);
  });
  it('packWeights interleaves into shader attribute order', () => {
    const n = 2;
    const w = Object.fromEntries(WEIGHT_NAMES.map((k, i) => [k, [i * 10, 255]]));
    const { w0, w1, w2 } = packWeights(w, n, 255, [0.25, 0.5]);
    expect(w0[0]).toBeCloseTo(0, 6);                 // jaw
    expect(w0[3]).toBeCloseTo(30 / 255, 6);          // cornerL
    expect(w1[0]).toBeCloseTo(40 / 255, 6);          // cornerR
    expect(w2[2]).toBeCloseTo(100 / 255, 6);         // browR
    expect(w2[3]).toBe(0.25);
    expect(w0[4]).toBe(1);
  });
  it('mergePalette prefers pack glow colours and honours overrides', () => {
    const p = mergePalette({ eye: '#111111', eyeGlow: '#ffaa00', wisp: '#00ffff' }, { rim: '#123456', line: 'bogus' });
    expect(p.eye).toBe('#ffaa00');
    expect(p.wisp).toBe('#00ffff');
    expect(p.rim).toBe('#123456');
    expect(p.line).toBe(DEFAULT_PALETTE.line);
  });
});

describe('lid map + occlusion (masks_c, baker >= 1.1)', () => {
  it('is declared in the manifest and validated as an optional pack file', () => {
    expect(pack.files.masksC).toBe('masks_c.png');
    expect(pack.channels.masksC).toEqual({ r: 'lidCoord', g: 'upperLid', b: 'occlusion' });
    const legacy = structuredClone(pack);
    delete legacy.files.masksC;
    expect(validatePack(legacy)).toEqual([]);
    expect(validatePack({ ...pack, files: { ...pack.files, masksC: '../x.png' } }).join()).toMatch(/masksC/);
    expect(validatePack({ ...pack, files: { ...pack.files, masksC: 'https://e.x/m.png' } }).join()).toMatch(/masksC/);
    expect(validatePack({ ...pack, files: { ...pack.files, masksC: 3 } }).join()).toMatch(/masksC/);
  });
  it('has plausible lid curves for both eyes (upper margin above the closed line above the lower lid)', () => {
    for (const k of ['L', 'R']) {
      const e = pack.rig.eyes[k];
      const l = e.lids;
      expect(l.x.length).toBe(17);
      for (let i = 1; i < l.x.length; i++) expect(l.x[i]).toBeGreaterThan(l.x[i - 1]);
      // the visible eye is wider than MediaPipe's corners and spans the iris
      expect(l.x[0]).toBeLessThan(e.box[0] + 2);
      expect(l.x[l.x.length - 1]).toBeGreaterThan(e.box[2] - 2);
      for (let i = 1; i < l.x.length - 1; i++) {
        expect(l.upper[i]).toBeLessThan(l.closed[i]);
        expect(l.closed[i]).toBeLessThan(l.lower[i]);
      }
      const mid = 8;
      // the open eye's upper margin sits near the top of the iris (well above MediaPipe's lid)
      expect(l.upper[mid]).toBeLessThan(e.center[1] - 0.8 * e.irisRadius);
      expect(l.closed[mid]).toBeGreaterThan(e.center[1]);
    }
  });
});
