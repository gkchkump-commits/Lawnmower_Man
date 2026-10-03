// The reworked procedural look (judge proceduralFixes): model data the shader relies on (optional
// "extra" block with the neck / lip-seam masks, seam fit, open orbit loops, lens-shaped jaw
// opening, larger iris), the halo triangle subset, tier defines and the shader contract.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RIG_CHANNELS, decodeModel, validateMeta } from '../../../src/avatar/heads/procedural/format.js';
import { GRID, HALO, haloIndex, haloOn, seamFit, tierDefines } from '../../../src/avatar/heads/procedural/index.js';
import { DEFAULT_DEFINES, HALO_FRAG, HALO_VERT, HEAD_FRAG, HEAD_VERT } from '../../../src/avatar/heads/procedural/shaders.js';
import { buildProcRig, deformVertex, procRigUniforms } from '../../../src/avatar/heads/procedural/rig.js';
import { createAnimState } from '../../../src/avatar/director.js';

const dir = fileURLToPath(new URL('../../../public/assets/models/', import.meta.url));
const meta = JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8'));
const bin = readFileSync(join(dir, meta.buffer.uri));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const model = decodeModel(meta, buffer);
const clone = (o) => JSON.parse(JSON.stringify(o));
const skin = model.skinVertexCount;
const P = model.positions;

describe('optional extra block (neck mask, lip seam)', () => {
  it('is present in the committed model and decodes to 4 channels per vertex', () => {
    expect(meta.layout.extra).toBeDefined();
    expect(model.extra.length).toBe(model.vertexCount * 4);
  });

  it('older models without it still decode (zeros)', () => {
    const m = clone(meta);
    delete m.layout.extra;
    expect(validateMeta(m)).toEqual([]);
    const old = decodeModel(m, buffer);
    expect(old.extra.length).toBe(model.vertexCount * 4);
    expect(old.extra.every((v) => v === 0)).toBe(true);
  });

  it('rejects a misaligned extra block', () => {
    const m = clone(meta);
    m.layout.extra.offset += 2;
    expect(validateMeta(m).join()).toMatch(/extra/);
  });

  it('marks the neck below the jaw line, never the face', () => {
    const chinY = meta.rig.chinY;
    let face = 0, faceMarked = 0, neck = 0, neckMarked = 0;
    for (let i = 0; i < skin; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const m = model.extra[i * 4] / 255;
      if (y > meta.rig.mouthCenter[1] && z > 0.2) { face++; if (m > 0.5) faceMarked++; }
      if (y < chinY - 0.06 && Math.abs(x) < 0.1) { neck++; if (m > 0.5) neckMarked++; }
    }
    expect(face).toBeGreaterThan(1000);
    expect(faceMarked).toBe(0);
    expect(neckMarked / neck).toBeGreaterThan(0.95);
  });

  it('marks both sides of the lip seam, and nothing far from the mouth', () => {
    const mc = meta.rig.mouthCenter;
    let up = 0, lo = 0;
    for (let i = 0; i < skin; i++) {
      const prox = model.extra[i * 4 + 1] / 255;
      if (prox < 0.5) continue;
      const d = Math.hypot(P[i * 3] - mc[0], P[i * 3 + 1] - mc[1]);
      expect(d).toBeLessThan(meta.rig.mouthHalfWidth * 1.3);
      if (model.extra[i * 4 + 2] > 127) up++; else lo++;
    }
    expect(up).toBeGreaterThan(20);
    expect(lo).toBeGreaterThan(20);
  });
});

describe('seam fit', () => {
  it('describes the rest lip seam (where the upper teeth hang)', () => {
    const [c0, c2, c4] = seamFit(meta);
    expect(Math.abs(c0 - meta.rig.mouthCenter[1])).toBeLessThan(0.01);
    const hw = meta.rig.mouthHalfWidth;
    const y = (dx) => c0 + (c2 + c4 * dx * dx) * dx * dx;
    // the corners: within a few px of the rig corners
    expect(Math.abs(y(meta.rig.cornerL[0] - meta.rig.mouthCenter[0]) - meta.rig.cornerL[1])).toBeLessThan(0.012);
    expect(Math.abs(y(hw * 0.5))).toBeLessThan(1);
  });

  it('falls back to a straight seam for models without it', () => {
    const m = clone(meta);
    delete m.rig.seamFit;
    expect(seamFit(m)).toEqual([meta.rig.mouthCenter[1], 0, 0]);
  });
});

describe('gold contour curves', () => {
  const names = meta.curves.names;
  const pointsOf = (name) => {
    const g = meta.curves.groups[names.indexOf(name)];
    const first = meta.curves.chunks[g.firstChunk];
    const last = meta.curves.chunks[g.firstChunk + g.chunkCount - 1];
    const out = [];
    for (let i = first.start; i <= last.start + last.count; i++) out.push(meta.curves.points.slice(i * 4, i * 4 + 4));
    return out;
  };

  it('has elliptical orbit loops instead of circular rings, and no mouth ring', () => {
    expect(names).toContain('orbitL');
    expect(names).toContain('orbitR');
    expect(names.some((n) => /^ring/.test(n))).toBe(false);
    for (const n of ['orbitL', 'orbitR']) {
      const pts = pointsOf(n);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      expect(w / h).toBeGreaterThan(1.1);                       // wider than tall
      // open: the two ends are far apart and fade out (gap toward the nose / glabella)
      const a = pts[0], b = pts[pts.length - 1];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(0.02);
      expect(a[3]).toBeLessThan(0.05);
      expect(b[3]).toBeLessThan(0.05);
      // brightest along the cheekbone (below the eye), faint along the brow
      const eyeY = meta.eyes[0].center[1];
      const below = pts.filter((p) => p[1] < eyeY - 0.03).map((p) => p[3]);
      const above = pts.filter((p) => p[1] > eyeY + 0.03).map((p) => p[3]);
      expect(Math.max(...below)).toBeGreaterThan(Math.max(...above));
    }
  });

  it('has open nasolabial arcs that fade out beside the chin', () => {
    for (const n of ['nasolabialL', 'nasolabialR']) {
      const pts = pointsOf(n);
      expect(pts[pts.length - 1][3]).toBeLessThan(0.02);
      expect(Math.max(...pts.map((p) => p[3]))).toBeGreaterThan(0.4);
    }
  });

  it('has branching forehead veins, alar rims and bright lip contours', () => {
    for (const n of ['veinL1', 'veinR1', 'alarL', 'alarR', 'lipUpper', 'lipLower', 'seam']) expect(names).toContain(n);
    const lipMax = Math.max(...pointsOf('lipUpper').map((p) => p[3]));
    const foreheadMax = Math.max(...pointsOf('foreheadL').map((p) => p[3]));
    expect(lipMax).toBeGreaterThan(foreheadMax);
  });
});

describe('lens-shaped mouth opening', () => {
  it('opens most in the middle and stays nearly closed at the corners', () => {
    const rig = buildProcRig(meta);
    const u = procRigUniforms(rig, { ...createAnimState(), jawOpen: 1 }, {});
    const C = RIG_CHANNELS.length;
    const w = new Float32Array(C);
    const out = [0, 0, 0];
    // the lower lip edge = the cavity rim vertices on the lower side (welded to the lip, same
    // weights); cavity u runs 0..1 from corner to corner
    const cav = model.cavity;
    const drop = (lo, hi) => {
      let s = 0, k = 0;
      for (let i = skin; i < model.vertexCount; i++) {
        if (cav[i * 4 + 2] !== 0 || cav[i * 4 + 3] > 64) continue;          // rim, lower side
        const u01 = Math.abs(cav[i * 4 + 1] / 255 - 0.5) * 2;               // 0 middle .. 1 corner
        if (u01 < lo || u01 > hi) continue;
        for (let c = 0; c < C; c++) w[c] = model.rig[i * C + c] / 255;
        s += deformVertex(P.subarray(i * 3, i * 3 + 3), w, u, rig, out)[1] - P[i * 3 + 1];
        k++;
      }
      return { mean: s / k, k };
    };
    const mid = drop(0, 0.3), corner = drop(0.82, 0.97);
    expect(mid.k).toBeGreaterThan(5);
    expect(corner.k).toBeGreaterThan(3);
    expect(mid.mean).toBeLessThan(-0.03);
    expect(Math.abs(corner.mean)).toBeLessThan(0.6 * Math.abs(mid.mean));
  });
});

describe('eyes', () => {
  it('carry a large amber iris disc with a visible pupil', () => {
    for (const e of meta.eyes) {
      expect(e.irisRadius).toBeGreaterThan(0.022);
      expect(e.pupilRadius / e.irisRadius).toBeGreaterThan(0.25);
      expect(e.pupilRadius / e.irisRadius).toBeLessThan(0.45);
    }
  });

  it('sit where the reference eyes glow (pupils measured on neutral.jpg, ~472 px)', () => {
    const D = meta.camera.distance;
    for (const e of meta.eyes) {
      const front = e.ball.map((v, k) => v + e.axisZ[k] * e.ballRadius);
      const k = D / (D - front[2]);
      const py = 584 - front[1] * k * 1168;
      expect(Math.abs(py - 472)).toBeLessThan(8);
    }
  });
});

describe('halo triangle subset', () => {
  it('keeps only skin triangles that can reach the silhouette', () => {
    const idx = haloIndex(model);
    expect(idx.length % 3).toBe(0);
    expect(idx.length).toBeGreaterThan(3000);
    expect(idx.length).toBeLessThan(model.index.length);
    let frontKept = 0;
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) expect(idx[t + k]).toBeLessThan(skin);
      const nz = (i) => (model.shell[i * 4 + 2] / 255) * 2 - 1;
      if (Math.min(nz(idx[t]), nz(idx[t + 1]), nz(idx[t + 2])) > 0.7) frontKept++;
    }
    expect(frontKept).toBe(0);
    // a stricter limit keeps fewer triangles
    expect(haloIndex(model, 0.3).length).toBeLessThan(idx.length);
  });

  it('is a small additive glow', () => {
    expect(HALO.offset).toBeGreaterThan(0);
    expect(HALO.offset).toBeLessThan(0.02);
    expect(HALO.strength).toBeGreaterThan(0);
    expect(HALO.strength).toBeLessThan(1);
  });
});

describe('quality tiers and shader contract', () => {
  it('drops the web and the dust on low only', () => {
    expect(tierDefines('low')).toEqual({ PH_WEB: 0, PH_DUST: 0 });
    expect(tierDefines('medium')).toEqual({ PH_WEB: 1, PH_DUST: 1 });
    expect(tierDefines('high')).toEqual({ PH_WEB: 1, PH_DUST: 1 });
    expect(DEFAULT_DEFINES.PH_DUST).toBe(1);
    expect(haloOn('low')).toBe(false);
    expect(haloOn('medium')).toBe(true);
    expect(haloOn('high')).toBe(true);
  });

  it('uses a finer grid and web than the first build', () => {
    expect(GRID[0]).toBeGreaterThan(190);       // meridians
    expect(GRID[1]).toBeLessThan(0.018);        // latitude step
    expect(GRID[3]).toBeLessThan(0.022 * 0.6);  // web cell
  });

  it('declares every attribute and varying it reads', () => {
    for (const a of ['aRig0', 'aRig1', 'aAux', 'aCav', 'aShell', 'aExtra']) {
      expect(HEAD_VERT).toMatch(new RegExp(`attribute vec4 ${a}`));
    }
    expect(HALO_VERT).toMatch(/attribute vec4 aShell/);
    for (const v of ['vRest', 'vDef', 'vPos', 'vNrm', 'vAux', 'vCav', 'vShell', 'vExtra']) {
      expect(HEAD_FRAG).toMatch(new RegExp(`varying vec[34] ${v};`));
    }
    for (const v of ['vSN', 'vHPos', 'vHF']) expect(HALO_FRAG).toMatch(new RegExp(`varying vec[34] ${v};`));
  });

  it('keeps the lips gold: no specular blob, no stretch-based blackening', () => {
    expect(HEAD_FRAG).not.toMatch(/0\.8 \* spec/);
    expect(HEAD_FRAG).not.toMatch(/stretch/);
    // the halo writes no alpha (pure light on the desktop)
    expect(HALO_FRAG).toMatch(/vec4\(c, 0\.0\)/);
  });
});
