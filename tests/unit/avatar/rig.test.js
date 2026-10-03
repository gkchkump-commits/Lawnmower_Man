import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAnimState } from '../../../src/avatar/director.js';
import { RIG_LIMITS, buildRig, headRotation, rigUniforms } from '../../../src/avatar/heads/relief/rig.js';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/assets/avatars/reference/pack.json', import.meta.url)), 'utf8'));

function apply(m, v) {
  // column-major 3x3
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

describe('headRotation', () => {
  it('is the identity at rest and orthonormal otherwise', () => {
    const m = headRotation(0, 0, 0, new Float32Array(9));
    Array.from(m).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 12));
    const r = headRotation(0.2, -0.1, 0.05, new Float64Array(9));
    const cols = [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 6);
      }
    }
  });
  it('follows the AnimState sign conventions', () => {
    const nose = [0, 0, 1];
    expect(apply(headRotation(0.3, 0, 0, new Float64Array(9)), nose)[0]).toBeGreaterThan(0.25);  // yaw + -> right
    expect(apply(headRotation(0, 0.3, 0, new Float64Array(9)), nose)[1]).toBeGreaterThan(0.25);  // pitch + -> up
    const up = apply(headRotation(0, 0, 0.3, new Float64Array(9)), [0, 1, 0]);
    expect(up[0]).toBeLessThan(-0.25);                                                           // roll + -> CCW
  });
});

describe('relief rig uniforms', () => {
  const rig = buildRig(pack);
  it('builds a sane world-space rig from the committed pack', () => {
    expect(rig.faceH).toBeGreaterThan(0.3);
    expect(rig.faceH).toBeLessThan(0.9);
    expect(rig.eyes.L.center[0]).toBeLessThan(0);   // screen-left eye
    expect(rig.eyes.R.center[0]).toBeGreaterThan(0);
    expect(rig.eyes.L.irisR).toBeGreaterThan(0.005);
    expect(rig.plateW).toBeCloseTo(pack.plate.width / pack.plate.height, 6);
  });
  it('is neutral at rest', () => {
    const u = rigUniforms(rig, createAnimState(), {});
    expect(u.jawDrop).toBe(0);
    expect(u.lids).toEqual([0, 0, 0, 0]);
    expect(u.gaze).toEqual([0, 0]);
    expect(Math.abs(u.cornerL[0]) + Math.abs(u.cornerR[0])).toBe(0);
    Array.from(u.headRot).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 12));
  });
  it('maps controls to bounded, correctly signed displacements', () => {
    const a = createAnimState();
    Object.assign(a, { jawOpen: 1, mouthWide: 1, smile: 0, blinkL: 1, blinkR: 0.5, browUp: 1, gazeX: 1, gazeY: -1 });
    const u = rigUniforms(rig, a, {});
    expect(u.jawDrop).toBeCloseTo(RIG_LIMITS.jawDropFh * rig.faceH, 9);
    expect(u.cornerL[0]).toBeLessThan(0);       // wide: corners move outward
    expect(u.cornerR[0]).toBeGreaterThan(0);
    // the committed pack has a lid map: the blink is a texture wipe, no geometric lid travel
    expect(rig.lidTravel).toBe(0);
    expect(u.lids).toEqual([0, 0, 0, 0]);
    expect(u.brows[0]).toBeGreaterThan(0);
    expect(u.gaze[0]).toBeGreaterThan(0);
    expect(u.gaze[1]).toBeLessThan(0);
    // the iris never moves more than an iris radius
    expect(u.gaze[0] * rig.plateW).toBeLessThan(rig.eyes.L.irisR);
  });
  it('round pulls corners in, smile lifts them', () => {
    const a = createAnimState();
    a.mouthRound = 1;
    const r = rigUniforms(rig, a, {});
    expect(r.cornerL[0]).toBeGreaterThan(0);
    expect(r.lipPush).toBeGreaterThan(0);
    const b = createAnimState();
    b.smile = 1;
    const s = rigUniforms(rig, b, {});
    expect(s.cornerL[1]).toBeGreaterThan(0);
    expect(s.lids[1]).toBeGreaterThan(0);     // smile squint
  });
  it('does not allocate after the first call', () => {
    const u = {};
    rigUniforms(rig, createAnimState(), u);
    const refs = [u.cornerL, u.cornerR, u.lids, u.brows, u.gaze, u.blink, u.headRot];
    rigUniforms(rig, { ...createAnimState(), jawOpen: 0.5 }, u);
    expect([u.cornerL, u.cornerR, u.lids, u.brows, u.gaze, u.blink, u.headRot]).toEqual(refs);
    refs.forEach((r, i) => expect(r).toBe([u.cornerL, u.cornerR, u.lids, u.brows, u.gaze, u.blink, u.headRot][i]));
  });
});

describe('relief rig: lid wipe, round, neck', () => {
  it('keeps the geometric lid squash for legacy packs without masks_c', () => {
    const legacy = structuredClone(pack);
    delete legacy.files.masksC;
    const rig = buildRig(legacy);
    expect(rig.lidTravel).toBe(1);
    const a = createAnimState();
    Object.assign(a, { blinkL: 1, blinkR: 0.5 });
    const u = rigUniforms(rig, a, {});
    expect(u.lids[0]).toBeCloseTo(rig.eyes.L.height, 9);
    expect(u.lids[2]).toBeCloseTo(rig.eyes.R.height * 0.5, 9);
    expect(u.blink).toEqual([1, 0.5]);
  });
  it('still squints the lower lids on a smile with the lid map', () => {
    const rig = buildRig(pack);
    const a = createAnimState();
    a.smile = 1;
    const u = rigUniforms(rig, a, {});
    expect(u.lids[0]).toBe(0);
    expect(u.lids[1]).toBeCloseTo(RIG_LIMITS.smileLidFrac * rig.eyes.L.height, 9);
  });
  it('parts the lips at the centre for a rounded O / U', () => {
    const rig = buildRig(pack);
    const a = createAnimState();
    a.mouthRound = 1;
    const u = rigUniforms(rig, a, {});
    expect(u.upperLift).toBeCloseTo(RIG_LIMITS.roundLipFh * rig.faceH, 9);
    expect(u.lowerDrop).toBeCloseTo(RIG_LIMITS.roundLipFh * rig.faceH, 9);
    expect(u.cornerL[0]).toBeCloseTo(RIG_LIMITS.roundCornerHw * rig.mouthHalfW, 9);   // corners in
  });
  it('turns the bust but not the lower neck (band just under the chin)', () => {
    const rig = buildRig(pack);
    const chinW = (pack.plate.height / 2 - pack.framing.chinY) / pack.plate.height;
    expect(rig.neckBand[0]).toBeLessThan(rig.neckBand[1]);
    expect(rig.neckBand[1]).toBeLessThan(chinW);              // the chin itself turns fully
    expect(rig.neckBand[0]).toBeGreaterThan(chinW - 0.25);
  });
});
