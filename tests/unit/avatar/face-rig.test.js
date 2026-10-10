// Rig uniforms of the face that moves with the mouth (cheeks / nasolabial folds, the chin boss,
// the nostril wings, lip fullness, the upper lip with the jaw) and of the jaw hinge, on the relief
// and the procedural head; neutral at rest.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAnimState } from '../../../src/avatar/director.js';
import { RIG_LIMITS, buildRig, faceAnchors, rigUniforms } from '../../../src/avatar/heads/relief/rig.js';
import { RIG_CHUNK } from '../../../src/avatar/heads/relief/shaders.js';
import { PROC_LIMITS, buildProcRig, deformVertex, procRigUniforms } from '../../../src/avatar/heads/procedural/rig.js';

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const pack = read('../../../public/assets/avatars/reference/pack.json');
const mesh = read('../../../public/assets/avatars/reference/mesh.json');
const meta = JSON.parse(readFileSync(join(fileURLToPath(new URL('../../../public/assets/models/', import.meta.url)), 'head.json'), 'utf8'));
const pose = (o) => Object.assign(createAnimState(), o);

describe('relief: face regions', () => {
  const rig = buildRig(pack, mesh);
  const wy = (y) => (pack.plate.height / 2 - y) / pack.plate.height;
  const lm = pack.landmarks;

  it('finds the cheeks, the chin boss and the nostril wings from the mesh landmarks', () => {
    const f = rig.face;
    const [mx, my] = rig.mouthCenter;
    // cheeks: one each side, above the mouth and below the eyes, about mirror images
    expect(f.cheekL[0]).toBeLessThan(mx - rig.mouthHalfW);
    expect(f.cheekR[0]).toBeGreaterThan(mx + rig.mouthHalfW);
    for (const c of [f.cheekL, f.cheekR]) {
      expect(c[1]).toBeGreaterThan(my);
      expect(c[1]).toBeLessThan(rig.eyes.L.center[1] - 0.05);
    }
    expect(Math.abs((f.cheekL[0] + f.cheekR[0]) / 2 - mx)).toBeLessThan(0.02);
    // chin boss between the lower lip and the chin
    expect(f.chin[1]).toBeLessThan(wy(lm.lipLower[1]));
    expect(f.chin[1]).toBeGreaterThan(wy(lm.chin[1]));
    // nostril wings beside the nose tip, level with it
    expect(Math.abs(f.alaL[1] - wy(lm.noseTip[1]))).toBeLessThan(0.02);
    expect(f.alaL[0]).toBeLessThan(f.alaR[0]);
    // hinge: the centre line, half the jaw width, the slit above the chin
    expect(rig.hinge[1]).toBeGreaterThan(1.5 * rig.mouthHalfW);
    expect(rig.hinge[2]).toBeGreaterThan(rig.hinge[3]);
  });

  it('estimates the regions for a mesh without landmark vertices', () => {
    const e = faceAnchors(pack, { positions: [] });
    const f = rig.face;
    for (const k of ['cheekL', 'cheekR', 'chin', 'alaL', 'alaR']) {
      expect(Math.hypot(e[k][0] - f[k][0], e[k][1] - f[k][1]), k).toBeLessThan(0.08);
    }
  });

  it('is neutral at rest and moves each region with its channel', () => {
    const r = rigUniforms(rig, createAnimState(), {});
    expect(r.faceMove).toEqual([0, 0, 0, 0]);
    const fh = rig.faceH;
    const c = rigUniforms(rig, pose({ cheekRaise: 1 }), {});
    expect(c.faceMove[0]).toBeCloseTo(RIG_LIMITS.cheekLiftFh * fh, 9);
    expect(c.faceMove[3]).toBeCloseTo(RIG_LIMITS.cheekOutFh * fh, 9);
    expect(rigUniforms(rig, pose({ chinRaise: 0.5 }), {}).faceMove[1]).toBeCloseTo(0.5 * RIG_LIMITS.chinLiftFh * fh, 9);
    expect(rigUniforms(rig, pose({ nostrilFlare: 1 }), {}).faceMove[2]).toBeCloseTo(RIG_LIMITS.nostrilPx / pack.plate.height, 9);
    expect(rigUniforms(rig, pose({ cheekRaise: 3 }), {}).faceMove[0]).toBeCloseTo(RIG_LIMITS.cheekLiftFh * fh, 9); // clamped
  });

  it('rounded lips fill out, pressed ones thin; the upper lip rises with the jaw', () => {
    const round = rigUniforms(rig, pose({ mouthRound: 1 }), {});
    expect(round.lipWarp[0]).toBeLessThan(0);                // negative thinning = fuller
    expect(round.lipWarp[3]).toBeLessThan(0);
    const press = rigUniforms(rig, pose({ mouthRound: 1, mouthPress: 1 }), {});
    expect(press.lipWarp[0]).toBeCloseTo(RIG_LIMITS.pressThin, 9); // a closure wins
    const open = rigUniforms(rig, pose({ jawOpen: 0.6 }), {});
    expect(open.upperLift).toBeCloseTo(0.6 * RIG_LIMITS.jawUpperLipFh * rig.faceH, 9);
    // about a fifth of the lower lip's drop (the upper incisors show on open vowels; v0.4: it was a
    // third, which opened every vowel alike)
    expect(open.upperLift).toBeGreaterThan(0.15 * open.jawDrop);
    expect(open.upperLift).toBeLessThan(0.3 * open.jawDrop);
    expect(rigUniforms(rig, pose({ jawOpen: 0.6, mouthPress: 1 }), {}).upperLift).toBe(0);
  });

  it('the opening is a lens: it spans the corners where they are now, narrow for O / U', () => {
    const rest = rigUniforms(rig, pose({}), {});
    expect(rest.lens[0]).toBe(1);
    expect(rest.lens[1]).toBe(RIG_LIMITS.cornerJawShare);
    expect(rigUniforms(rig, pose({ mouthRound: 1 }), {}).lens[0]).toBeCloseTo(1 - RIG_LIMITS.roundCornerHw, 9);
    expect(rigUniforms(rig, pose({ mouthWide: 1 }), {}).lens[0]).toBeGreaterThan(1);
    expect(RIG_CHUNK).toMatch(/uniform vec4 uLens;/);
    // its outline: a slender almond at rest and for a rounded opening, fuller toward the corners
    // (a smaller profile exponent) for an open or a spread vowel
    expect([rest.lens[2], rest.lens[3]]).toEqual([0.75, 0.55]);
    const openE = rigUniforms(rig, pose({ jawOpen: 0.7 }), {}), roundE = rigUniforms(rig, pose({ jawOpen: 0.7, mouthRound: 1 }), {});
    expect(openE.lens[2]).toBeLessThan(0.6);
    expect(openE.lens[3]).toBeLessThan(rest.lens[3]);
    expect(roundE.lens[2]).toBeCloseTo(0.75, 9);
    expect(RIG_CHUNK).toMatch(/\(1\.0 - fLo\) \* nearLo/); // the lower lip's jaw share tapers at the corners
  });

  it('the shader rig declares the hinge and face uniforms and skips them at rest', () => {
    for (const u of ['uHinge', 'uHingeK', 'uFaceMove', 'uCheekC', 'uChinC', 'uAlaC', 'uFaceR', 'uMouth', 'uLens']) {
      expect(RIG_CHUNK).toMatch(new RegExp(`uniform \\w+ ${u};`));
    }
    expect(RIG_CHUNK).toMatch(/if \(uFaceMove\.x \+ uFaceMove\.y \+ uFaceMove\.z > 0\.0\)/);
    expect(RIG_CHUNK).toMatch(/uHingeK\.x \* side/);
  });
});

describe('procedural: face regions', () => {
  const rig = buildProcRig(meta);

  it('is neutral at rest; chin and nostrils move only their regions', () => {
    const r = procRigUniforms(rig, createAnimState(), {});
    expect(r.face).toEqual([0, 0, 0, 0]);
    const u = procRigUniforms(rig, pose({ chinRaise: 1, nostrilFlare: 1 }), {});
    expect(u.face[0]).toBeCloseTo(PROC_LIMITS.chinLiftFh * rig.faceH, 9);
    expect(u.face[1]).toBeCloseTo(PROC_LIMITS.nostrilFh * rig.faceH, 9);
    const w = (jaw, lower) => [jaw, 0, lower, 0, 0, 0, 0, 0];
    // the chin boss (on the jaw) rises; the same point on the lower lip does not
    const chin = [rig.chin[0], rig.chin[1], 0.3];
    expect(deformVertex(chin, w(1, 0), u, rig, [0, 0, 0])[1]).toBeGreaterThan(chin[1] + 0.5 * u.face[0]);
    expect(deformVertex(chin, w(1, 1), { ...u, jawRot: u.jawRot }, rig, [0, 0, 0])[1]).toBeCloseTo(chin[1] - u.lips[1], 6);
    // a nostril wing on the front of the face moves outward
    const ala = [rig.ala[0], rig.ala[1], rig.ala[3]];
    expect(deformVertex(ala, w(0, 0), u, rig, [0, 0, 0])[0]).toBeGreaterThan(ala[0] + 0.5 * u.face[1]);
    const alaL = [-rig.ala[0], rig.ala[1], rig.ala[3]];
    expect(deformVertex(alaL, w(0, 0), u, rig, [0, 0, 0])[0]).toBeLessThan(alaL[0] - 0.5 * u.face[1]);
    // ... and the back of the head does not
    const back = [rig.ala[0], rig.ala[1], -0.1];
    expect(deformVertex(back, w(0, 0), u, rig, [0, 0, 0])[0]).toBeCloseTo(back[0], 9);
  });

  it('cheeks lift with the spread vowels of speech as with smiles; the upper lip with the jaw', () => {
    const s = procRigUniforms(rig, pose({ smile: 0.5 }), {});
    const c = procRigUniforms(rig, pose({ cheekRaise: 0.8 }), {});
    expect(c.lips[3]).toBeGreaterThan(s.lips[3]);
    expect(procRigUniforms(rig, pose({ jawOpen: 0.5 }), {}).lips[0]).toBeCloseTo(0.5 * PROC_LIMITS.jawUpperLipFh * rig.faceH, 9);
  });
});
