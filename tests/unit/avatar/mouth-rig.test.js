// Rig uniforms for the speech channels (press, tuck, teeth, tongue, asymmetry) of the relief
// and procedural heads, plus a guard that every uniform a shader uses is declared in it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAnimState } from '../../../src/avatar/director.js';
import { RIG_LIMITS, buildRig, rigUniforms } from '../../../src/avatar/heads/relief/rig.js';
import { cavityLowerTeeth, cavityTeeth, slitDistances } from '../../../src/avatar/heads/relief/index.js';
import { incisorBand } from '../../../src/avatar/heads/relief/rig.js';
import * as reliefShaders from '../../../src/avatar/heads/relief/shaders.js';
import * as procShaders from '../../../src/avatar/heads/procedural/shaders.js';
import { PROC_LIMITS, buildProcRig, deformVertex, procRigUniforms } from '../../../src/avatar/heads/procedural/rig.js';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/assets/avatars/reference/pack.json', import.meta.url)), 'utf8'));
const modelDir = fileURLToPath(new URL('../../../public/assets/models/', import.meta.url));
const meta = JSON.parse(readFileSync(join(modelDir, 'head.json'), 'utf8'));

const pose = (o) => Object.assign(createAnimState(), o);

describe('relief rig: speech channels', () => {
  const rig = buildRig(pack);
  const fh = rig.faceH;
  /** Lip slit opening at the centre (world units): upper lip up + lower lip down + jaw. */
  const opening = (u) => u.upperLift + u.lowerDrop + u.jawDrop;

  it('is neutral at rest (no warp, no tongue, no teeth shift)', () => {
    const u = rigUniforms(rig, createAnimState(), {});
    expect(u.lipWarp).toEqual([0, 0, 0, 0]);
    expect(u.tongue).toBe(0);
    expect(u.teethShift).toBe(0);
    expect(u.upperLift).toBe(0);
    expect(u.lowerDrop).toBe(0);
    expect(rig.mouthCenter[1]).toBeLessThan(0);   // below the plate centre
  });

  it('press closes the lips over a slightly open jaw and thins them', () => {
    const u = rigUniforms(rig, pose({ jawOpen: 0.1, mouthWide: 0.3, mouthPress: 1 }), {});
    expect(u.jawDrop).toBeGreaterThan(0);            // the chin stays down...
    expect(opening(u)).toBeCloseTo(0, 9);            // ...but the lips meet
    expect(u.lipWarp[0]).toBeCloseTo(RIG_LIMITS.pressThin, 9);
    expect(u.lipWarp[1]).toBeCloseTo(RIG_LIMITS.pressContactPx, 9);
    expect(cavityTeeth(pose({ jawOpen: 0.4, mouthPress: 1 }))).toBe(0);
    // half pressed: half way
    const h = rigUniforms(rig, pose({ jawOpen: 0.1, mouthPress: 0.5 }), {});
    expect(opening(h)).toBeGreaterThan(0);
    expect(opening(h)).toBeLessThan(u.jawDrop + 0.5 * RIG_LIMITS.jawDropFh * fh);
  });

  it('tuck lifts the upper lip a little and brings the lower lip up to the teeth', () => {
    const u = rigUniforms(rig, pose({ jawOpen: 0.07, mouthTuck: 1 }), {});
    // (plus the little the upper lip rises with the jaw)
    expect(u.upperLift).toBeCloseTo((RIG_LIMITS.tuckLiftFh + 0.07 * RIG_LIMITS.jawUpperLipFh) * fh, 9);
    expect(u.lowerDrop).toBeLessThan(-u.jawDrop);    // the lower lip rises above its rest place
    expect(opening(u)).toBeGreaterThan(0);           // a small opening: the incisor edge shows
    expect(opening(u)).toBeLessThan(0.012 * fh);
    expect(u.lipWarp[2]).toBeGreaterThan(0);         // the lower lip rolls in
    expect(u.lipWarp[3]).toBeGreaterThan(0);
    expect(u.teethShift).toBeGreaterThan(0);
    expect(cavityTeeth(pose({ mouthTuck: 1 }))).toBeGreaterThan(0.5);
    // a closure wins over a tuck
    const pt = rigUniforms(rig, pose({ mouthPress: 1, mouthTuck: 1 }), {});
    expect(opening(pt)).toBeCloseTo(0, 9);
  });

  it('the lower teeth ride on the jaw: hidden by a closed jaw, a tuck (f v) or rounded lips', () => {
    expect(cavityLowerTeeth(pose({}))).toBe(0);
    expect(cavityLowerTeeth(pose({ jawOpen: 0.12 }))).toBe(0);            // behind the lower lip
    expect(cavityLowerTeeth(pose({ jawOpen: 0.7 }))).toBeGreaterThan(0.9); // an open "ah"
    expect(cavityLowerTeeth(pose({ jawOpen: 0.12, mouthWide: 0.8, mouthTeeth: 0.8 }))).toBeGreaterThan(0.3); // "ee": lips drawn back
    expect(cavityLowerTeeth(pose({ jawOpen: 0.7, mouthTuck: 1 }))).toBe(0);
    expect(cavityLowerTeeth(pose({ jawOpen: 0.45, mouthRound: 1 }))).toBeLessThan(0.15);
    // the upper ones: shown by parted lips, hidden by rounded ones more than before
    expect(cavityTeeth(pose({ jawOpen: 0.45, mouthRound: 1 }))).toBeLessThan(0.2);
    expect(cavityTeeth(pose({ jawOpen: 0.45 }))).toBeCloseTo(0.45, 9);
  });

  it('locates the incisors in the mouth texture (the brightest band across its middle)', () => {
    const w = 40, h = 80, px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = y >= 12 && y < 17 ? 230 : 20;
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    const b = incisorBand(px, w, h);
    expect(b.top).toBeCloseTo(12 / h, 9);
    expect(b.bottom).toBeCloseTo(17 / h, 9);
    expect(incisorBand(new Uint8ClampedArray(w * h * 4), w, h)).toBe(null);
  });

  it('teeth raise the upper lip and the incisors follow part of the way', () => {
    const u = rigUniforms(rig, pose({ mouthTeeth: 1 }), {});
    expect(u.upperLift).toBeCloseTo(RIG_LIMITS.teethLiftFh * fh, 9);
    expect(u.lowerDrop).toBeCloseTo(RIG_LIMITS.teethDropFh * fh, 9);
    expect(u.teethShift).toBeCloseTo(RIG_LIMITS.teethShift * u.upperLift, 9);
    expect(cavityTeeth(pose({ mouthTeeth: 0.8 }))).toBeCloseTo(0.8, 9);
  });

  it('tongue and asymmetry', () => {
    const t = rigUniforms(rig, pose({ jawOpen: 0.2, mouthTongue: 0.7 }), {});
    expect(t.tongue).toBeCloseTo(0.7, 9);
    expect(rigUniforms(rig, pose({ mouthTongue: 1, mouthPress: 1 }), {}).tongue).toBe(0); // lips closed
    const a = rigUniforms(rig, pose({ jawOpen: 0.3, mouthAsym: 1 }), {});
    expect(a.cornerL[1]).toBeCloseTo(RIG_LIMITS.asymFh * fh, 9);   // screen-left corner up
    expect(a.cornerR[1]).toBeCloseTo(-RIG_LIMITS.asymFh * fh, 9);
    const n = rigUniforms(rig, pose({ jawOpen: 0.3, mouthAsym: -3 }), {});
    expect(n.cornerL[1]).toBeCloseTo(-RIG_LIMITS.asymFh * fh, 9);  // clamped to -1
  });

  it('round pulls the corners in and leaves a small orifice (the jaw sets how open it is)', () => {
    const u = rigUniforms(rig, pose({ mouthRound: 1 }), {});
    expect(-u.cornerR[0]).toBeCloseTo(RIG_LIMITS.roundCornerHw * rig.mouthHalfW, 9);
    // (v0.4: rounding alone used to part the lips by 0.052 fh, so an "oo" gaped wider than an "ah")
    expect(opening(u)).toBeGreaterThan(0.012 * fh);
    expect(opening(u)).toBeLessThan(0.025 * fh);
    const oh = rigUniforms(rig, pose({ mouthRound: 0.8, jawOpen: 0.45 }), {});
    expect(opening(oh)).toBeGreaterThan(2 * opening(u));
  });

  it('reuses its output arrays', () => {
    const u = rigUniforms(rig, pose({ mouthPress: 0.4 }), {});
    const w = u.lipWarp;
    rigUniforms(rig, pose({ mouthTuck: 0.4 }), u);
    expect(u.lipWarp).toBe(w);
  });

  it('measures vertex distances from the closed-mouth slit', () => {
    const slit = [0, 100, 100, 110];
    const d = slitDistances([50, 120, 0, 50, 90, 0, -10, 100, 0, 200, 100, 0], 4, slit);
    expect(Array.from(d)).toEqual([15, -15, 0, -10]);
  });
});

describe('procedural rig: speech channels', () => {
  const rig = buildProcRig(meta);
  const fh = rig.faceH;

  it('is neutral at rest', () => {
    const u = procRigUniforms(rig, createAnimState(), {});
    expect(u.mouthX).toEqual([0, 0, 0, 0]);
    expect(u.lips[0]).toBe(0);
    expect(u.lips[1]).toBe(0);
  });

  it('press cancels the lip opening of the jaw and thins / rolls in the lips', () => {
    const u = procRigUniforms(rig, pose({ jawOpen: 0.1, mouthPress: 1 }), {});
    // the lower lip comes back up by about the jaw's drop
    expect(u.lips[1]).toBeCloseTo(-PROC_LIMITS.jawLipK * u.jawAngle, 9);
    expect(u.mouthX[0]).toBeCloseTo(PROC_LIMITS.pressThinFh * fh, 9);
    expect(u.mouthX[1]).toBeCloseTo(PROC_LIMITS.pressInFh * fh, 9);
    expect(u.mouthX[3]).toBe(0);
    // CPU mirror: an upper-lip vertex away from the seam moves down, a lower-lip one up
    const w = (up, lo) => [0, up, lo, 0, 0, 0, 0, 0];
    const up = deformVertex([0, 0, 0], w(1, 0), u, rig, [0, 0, 0], 0);
    const lo = deformVertex([0, 0, 0], w(0, 1), u, rig, [0, 0, 0], 0);
    expect(up[1]).toBeLessThan(0);
    expect(lo[1]).toBeGreaterThan(0);
    // the seam itself stays where it is (the lips stay closed, the cavity hidden)
    const seam = deformVertex([0, 0, 0], w(1, 0), u, rig, [0, 0, 0], 1);
    expect(seam[1]).toBeCloseTo(0, 9);
    expect(seam[2]).toBeCloseTo(0, 9);
    expect(up[2]).toBeLessThan(0);                   // the rest of the lip flattens
  });

  it('tuck lifts the upper lip, raises and draws back the lower lip; teeth lift; asymmetry tilts', () => {
    const t = procRigUniforms(rig, pose({ mouthTuck: 1 }), {});
    expect(t.lips[0]).toBeCloseTo(PROC_LIMITS.tuckLiftFh * fh, 9);
    expect(t.lips[1]).toBeLessThan(0);
    expect(t.mouthX[2]).toBeCloseTo(PROC_LIMITS.tuckBackFh * fh, 9);
    const e = procRigUniforms(rig, pose({ mouthTeeth: 1 }), {});
    expect(e.lips[0]).toBeCloseTo(PROC_LIMITS.teethLiftFh * fh, 9);
    const a = procRigUniforms(rig, pose({ mouthAsym: 0.5 }), {});
    expect(a.cornerL[1]).toBeCloseTo(0.5 * PROC_LIMITS.asymFh * fh, 9);
    expect(a.cornerR[1]).toBeCloseTo(-0.5 * PROC_LIMITS.asymFh * fh, 9);
    expect(procRigUniforms(rig, pose({ mouthTongue: 0.6 }), {}).mouthX[3]).toBeCloseTo(0.6, 9);
  });
});

describe('shaders declare every uniform they use', () => {
  /** uniforms referenced (uXxx) but not declared in a GLSL source */
  function undeclared(src) {
    const used = new Set(src.match(/\bu[A-Z]\w*/g) || []);
    const declared = new Set([...src.matchAll(/uniform\s+\w+\s+(u[A-Z]\w*)/g)].map((m) => m[1]));
    return [...used].filter((u) => !declared.has(u));
  }

  for (const [name, src] of Object.entries({ ...reliefShaders, ...procShaders })) {
    if (typeof src !== 'string' || !/void main/.test(src)) continue;
    it(name, () => expect(undeclared(src)).toEqual([]));
  }
});

describe('heads give every uniform their shaders declare a value', () => {
  // a declared uniform without a value in the material compiles but reads 0 (or warns): a new
  // face channel whose uniform is never set would silently do nothing
  const headSource = (name) => readFileSync(fileURLToPath(new URL(`../../../src/avatar/heads/${name}/index.js`, import.meta.url)), 'utf8');
  const given = (src) => new Set([...src.matchAll(/\b(u[A-Z]\w*)\s*:/g)].map((m) => m[1]));
  const declared = (src) => [...src.matchAll(/uniform\s+\w+\s+(u[A-Z]\w*)/g)].map((m) => m[1]);
  for (const [head, shaders] of [['relief', reliefShaders], ['procedural', procShaders]]) {
    const have = given(headSource(head));
    for (const [name, src] of Object.entries(shaders)) {
      if (typeof src !== 'string' || !/void main/.test(src)) continue;
      it(`${head} ${name}`, () => expect(declared(src).filter((u) => !have.has(u))).toEqual([]));
    }
  }
});
