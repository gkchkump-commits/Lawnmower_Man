// Procedural head rig math (src/avatar/heads/procedural/rig.js), checked against the committed
// model's weights: the jaw opens the lips cleanly and nothing else moves.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAnimState } from '../../../src/avatar/director.js';
import { RIG_CHANNELS, decodeModel } from '../../../src/avatar/heads/procedural/format.js';
import {
  PROC_LIMITS, buildProcRig, deformVertex, mulMat3Vec3, procRigUniforms, rotationX, rotationYPR,
} from '../../../src/avatar/heads/procedural/rig.js';

const dir = fileURLToPath(new URL('../../../public/assets/models/', import.meta.url));
const meta = JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8'));
const bin = readFileSync(join(dir, meta.buffer.uri));
const model = decodeModel(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const rig = buildProcRig(meta);

const det3 = (m) => m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2]);

describe('rotations', () => {
  it('rotationYPR is a proper rotation with the director conventions', () => {
    const m = rotationYPR(0.3, -0.2, 0.1, new Float32Array(9));
    expect(det3(m)).toBeCloseTo(1, 5);
    const nose = mulMat3Vec3(rotationYPR(0.3, 0, 0, new Float32Array(9)), [0, 0, 1], [0, 0, 0]);
    expect(nose[0]).toBeGreaterThan(0.2);                     // yaw > 0: toward screen right
    const up = mulMat3Vec3(rotationYPR(0, 0.3, 0, new Float32Array(9)), [0, 0, 1], [0, 0, 0]);
    expect(up[1]).toBeGreaterThan(0.2);                       // pitch > 0: looks up
    const roll = mulMat3Vec3(rotationYPR(0, 0, 0.3, new Float32Array(9)), [1, 0, 0], [0, 0, 0]);
    expect(roll[1]).toBeGreaterThan(0.2);                     // roll > 0: counter-clockwise
  });

  it('rotationX opens the jaw (points in front of the hinge move down and back)', () => {
    const m = rotationX(0.15, new Float32Array(9));
    const p = mulMat3Vec3(m, [0, -0.15, 0.38], [0, 0, 0]);
    expect(p[1]).toBeLessThan(-0.15 - 0.04);
    expect(p[2]).toBeLessThan(0.38);
  });
});

describe('procRigUniforms', () => {
  it('is the identity at rest and reuses its output object', () => {
    const a = createAnimState();
    const u = procRigUniforms(rig, a, {});
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    u.jawRot.forEach((v, k) => expect(v).toBeCloseTo(I[k], 9));
    u.headRot.forEach((v, k) => expect(v).toBeCloseTo(I[k], 9));
    expect(u.cornerL.every((v) => v === 0) && u.cornerR.every((v) => v === 0)).toBe(true);
    const jr = u.jawRot, g = u.gaze;
    const u2 = procRigUniforms(rig, { ...a, jawOpen: 0.5 }, u);
    expect(u2).toBe(u);
    expect(u2.jawRot).toBe(jr);
    expect(u2.gaze).toBe(g);
  });

  it('maps visemes and expressions to symmetric mouth motion', () => {
    const a = createAnimState();
    const smile = procRigUniforms(rig, { ...a, smile: 1 }, {});
    expect(smile.cornerL[0]).toBeLessThan(0);
    expect(smile.cornerR[0]).toBeGreaterThan(0);
    expect(smile.cornerL[1]).toBeGreaterThan(0);
    expect(smile.cornerL[1]).toBeCloseTo(smile.cornerR[1]);
    const round = procRigUniforms(rig, { ...a, mouthRound: 1 }, {});
    expect(round.cornerL[0]).toBeGreaterThan(0);              // corners move inward
    expect(round.lips[2]).toBeGreaterThan(0);                 // lips push forward
    const jaw = procRigUniforms(rig, { ...a, jawOpen: 2 }, {});   // clamped
    expect(jaw.jawAngle).toBeCloseTo(PROC_LIMITS.jawAngle);
  });

  it('produces unit gaze vectors that follow gazeX / gazeY', () => {
    const a = createAnimState();
    const rest = procRigUniforms(rig, a, {}).gaze.slice();
    const right = procRigUniforms(rig, { ...a, gazeX: 1 }, {}).gaze;
    const up = procRigUniforms(rig, { ...a, gazeY: 1 }, {}).gaze;
    for (let i = 0; i < 2; i++) {
      expect(Math.hypot(right[i * 3], right[i * 3 + 1], right[i * 3 + 2])).toBeCloseTo(1, 5);
      expect(right[i * 3]).toBeGreaterThan(rest[i * 3] + 0.2);
      expect(up[i * 3 + 1]).toBeGreaterThan(rest[i * 3 + 1] + 0.15);
    }
  });

  it('clamps blink and passes per-eye values', () => {
    const u = procRigUniforms(rig, { ...createAnimState(), blinkL: 1.5, blinkR: 0.25 }, {});
    expect(u.blink).toEqual([1, 0.25]);
  });
});

describe('rig weights of the committed model', () => {
  const C = RIG_CHANNELS.length;
  const n = model.skinVertexCount;
  const P = model.positions;
  const w = new Float32Array(C);
  const out = [0, 0, 0];
  const weightsOf = (i) => { for (let k = 0; k < C; k++) w[k] = model.rig[i * C + k] / 255; return w; };
  const near = (pt, r) => {
    const ids = [];
    for (let i = 0; i < n; i++) if (Math.hypot(P[i * 3] - pt[0], P[i * 3 + 1] - pt[1], P[i * 3 + 2] - pt[2]) < r) ids.push(i);
    return ids;
  };
  const dy = (ids, u) => ids.reduce((s, i) => s + (deformVertex(P.subarray(i * 3, i * 3 + 3), weightsOf(i), u, rig, out)[1] - P[i * 3 + 1]), 0) / ids.length;

  it('opens the mouth: lower lip drops, upper lip and eyes stay', () => {
    const u = procRigUniforms(rig, { ...createAnimState(), jawOpen: 1 }, {});
    const mc = meta.rig.mouthCenter, hw = meta.rig.mouthHalfWidth;
    // lip vertices (lips mask) in the middle half of the mouth, split by the seam height
    const lowerLip = [], upperLip = [];
    for (let i = 0; i < n; i++) {
      if (model.aux[i * 4 + 2] < 160 || Math.abs(P[i * 3] - mc[0]) > 0.5 * hw) continue;
      (P[i * 3 + 1] < mc[1] - 0.006 ? lowerLip : P[i * 3 + 1] > mc[1] + 0.006 ? upperLip : []).push(i);
    }
    expect(lowerLip.length).toBeGreaterThan(5);
    expect(upperLip.length).toBeGreaterThan(5);
    expect(dy(lowerLip, u)).toBeLessThan(-0.035);
    expect(Math.abs(dy(upperLip, u))).toBeLessThan(0.006);
    const eye = near(meta.eyes[0].center, 0.02);
    expect(Math.abs(dy(eye, u))).toBeLessThan(1e-4);
  });

  it('raises the brows only above the eyes', () => {
    const u = procRigUniforms(rig, { ...createAnimState(), browUp: 1 }, {});
    const e = meta.eyes[0];
    const brow = near([e.center[0], e.center[1] + 0.05, e.center[2]], 0.015);
    expect(dy(brow, u)).toBeGreaterThan(0.0025);
    const lid = near(e.center, 0.012);
    expect(Math.abs(dy(lid, u))).toBeLessThan(0.0015);
  });
});
