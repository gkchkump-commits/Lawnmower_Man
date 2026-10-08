// src/vision/attention.js on synthetic landmarker results (tests/unit/vision/helpers.js).
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_DEFAULTS,
  AttentionTracker,
  BLENDSHAPES,
  KEY_POINTS,
  estimateDistanceCm,
  faceGeometry,
  summarizeFaceResult,
} from '../../../src/vision/attention.js';
import { faceResult, noFace } from './helpers.js';

const deg = (r) => (r * 180) / Math.PI;
const obs = (o = {}) => summarizeFaceResult(faceResult(o), o.width ?? 320, o.height ?? 240);

/** Feed `n` frames every `dt` ms starting at `t0`; returns the end time. */
function feed(tr, make, { t0 = 0, n = 10, dt = 83 } = {}) {
  let t = t0;
  for (let i = 0; i < n; i++, t += dt) tr.update(make(i, t), t);
  return t - dt;
}

describe('summarizeFaceResult', () => {
  it('keeps the key points and blendshapes of the first face', () => {
    const o = obs({ blend: { jawOpen: 0.4, mouthSmileLeft: 0.7, cheekPuff: 0.9 } });
    expect(Object.keys(o.points).sort()).toEqual(Object.keys(KEY_POINTS).sort());
    expect(o.points.noseTip).toHaveLength(3);
    expect(o.blend).toMatchObject({ jawOpen: 0.4, mouthSmileLeft: 0.7 });
    expect(o.blend.cheekPuff).toBeUndefined(); // not one we use
    expect(Object.keys(o.blend).every((k) => BLENDSHAPES.includes(k))).toBe(true);
    expect(o).toMatchObject({ width: 320, height: 240 });
  });
  it('returns null without a (complete) face and survives junk', () => {
    expect(summarizeFaceResult(noFace(), 320, 240)).toBeNull();
    expect(summarizeFaceResult(null, 320, 240)).toBeNull();
    expect(summarizeFaceResult({ faceLandmarks: [[{ x: 1, y: 1, z: 0 }]] }, 320, 240)).toBeNull();
    const r = faceResult();
    r.faceLandmarks[0][1] = { x: NaN, y: 'x', z: undefined };
    r.faceBlendshapes = [{ categories: [{ categoryName: 'jawOpen', score: 7 }] }];
    const o = summarizeFaceResult(r, 0, -5);
    expect(o.points.noseTip).toEqual([0, 0, 0]);
    expect(o.blend.jawOpen).toBe(1);
    expect(o.width).toBe(1);
  });
});

describe('faceGeometry', () => {
  it('recovers centre and size', () => {
    const g = faceGeometry(obs({ cx: 0.3, cy: 0.6, size: 0.25 }));
    expect(g.cx).toBeCloseTo(0.3, 1);
    expect(g.cy).toBeCloseTo(0.6 + 0.035 * 0.25 * (320 / 240), 2); // forehead/chin midpoint
    expect(g.size).toBeCloseTo(0.25, 2);
  });
  it.each([
    [0, 0], [20, 0], [-35, 0], [0, 15], [0, -25], [25, -15], [-15, 20],
  ])('recovers yaw %d° / pitch %d°', (yawDeg, pitchDeg) => {
    const g = faceGeometry(obs({ yawDeg, pitchDeg }));
    expect(deg(g.yaw)).toBeCloseTo(yawDeg, 0);
    expect(deg(g.pitch)).toBeCloseTo(pitchDeg, 0);
  });
  it('recovers roll and works on non-square frames', () => {
    expect(deg(faceGeometry(obs({ rollDeg: 12 })).roll)).toBeCloseTo(12, 0);
    const wide = faceGeometry(obs({ yawDeg: 18, width: 320, height: 180 }));
    expect(deg(wide.yaw)).toBeCloseTo(18, 0);
    expect(faceGeometry({ width: 1, height: 1, points: {}, blend: {} })).toBeNull();
  });
});

describe('estimateDistanceCm', () => {
  it('a bigger face is closer; a typical laptop distance comes out plausible', () => {
    const near = estimateDistanceCm(0.4);
    const mid = estimateDistanceCm(0.2);
    const far = estimateDistanceCm(0.1);
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    expect(mid).toBeGreaterThan(45);
    expect(mid).toBeLessThan(80);
    expect(estimateDistanceCm(0)).toBe(Infinity);
  });
});

describe('AttentionTracker', () => {
  it('becomes present after two frames over 200 ms, not after a single frame', () => {
    const tr = new AttentionTracker();
    tr.update(obs(), 0);
    expect(tr.state.present).toBe(false);
    tr.update(obs(), 100);
    expect(tr.state.present).toBe(false); // < presentAfterMs
    tr.update(obs(), 250);
    expect(tr.state.present).toBe(true);
    expect(tr.state.changedAt).toBe(250);
    // a single stray detection after an absence does not count
    const t2 = new AttentionTracker();
    t2.update(obs(), 0);
    t2.update(null, 300);
    t2.update(obs(), 600);
    expect(t2.state.present).toBe(false);
  });

  it('stays present through short dropouts and becomes absent after 1.5 s without a face', () => {
    const tr = new AttentionTracker();
    let t = feed(tr, () => obs(), { n: 6 });
    expect(tr.state.present).toBe(true);
    tr.update(null, (t += 83));
    tr.update(null, (t += 83));
    tr.update(obs(), (t += 83)); // blink of a dropout
    expect(tr.state.present).toBe(true);
    const lastSeen = t;
    for (let i = 0; i < 17; i++) tr.update(null, (t += 83));
    expect(t - lastSeen).toBeLessThan(ATTENTION_DEFAULTS.absentAfterMs);
    expect(tr.state.present).toBe(true); // 17 frames without a face, but not 1.5 s yet
    tr.update(null, lastSeen + 1600);
    expect(tr.state.present).toBe(false);
    expect(tr.state.looking).toBe(false);
  });

  it('also works at the slow "searching" rate (4 detections per second)', () => {
    const tr = new AttentionTracker();
    tr.update(obs(), 0);
    tr.update(obs(), 250);
    expect(tr.state.present).toBe(true);
    tr.update(null, 500);
    tr.update(null, 750);
    expect(tr.state.present).toBe(true);
    tr.update(null, 2000);
    expect(tr.state.present).toBe(false);
  });

  it('mirrors the centre like a selfie view and smooths it', () => {
    const tr = new AttentionTracker();
    feed(tr, () => obs({ cx: 0.2, cy: 0.3 }), { n: 3 });
    // the face is on the image's left = the screen's right in a mirror view; up is +y
    expect(tr.state.x).toBeCloseTo(0.6, 1);
    expect(tr.state.y).toBeGreaterThan(0.3);
    // a jump to the other side is smoothed (time constant ~150 ms)
    tr.update(obs({ cx: 0.8, cy: 0.3 }), 300);
    expect(tr.state.x).toBeGreaterThan(-0.6);
    expect(tr.state.x).toBeLessThan(0.6);
    feed(tr, () => obs({ cx: 0.8, cy: 0.3 }), { t0: 383, n: 12 });
    expect(tr.state.x).toBeCloseTo(-0.6, 1);
    expect(tr.state.yaw).toBeCloseTo(0, 1);
    expect(tr.state.distanceCm).toBeGreaterThan(30);
  });

  it('jumps (no glide) to where the face is after it was gone', () => {
    const tr = new AttentionTracker();
    feed(tr, () => obs({ cx: 0.2 }), { n: 4 });
    feed(tr, () => null, { t0: 400, n: 3, dt: 1000 });
    tr.update(obs({ cx: 0.8 }), 5000);
    expect(tr.state.x).toBeCloseTo(-0.6, 1);
  });

  it('"looking at the screen": head toward it and eyes not aside, with hysteresis', () => {
    const tr = new AttentionTracker();
    let t = feed(tr, () => obs({ pitchDeg: -10 }), { n: 6 }); // camera above the screen: a little down
    expect(tr.state.looking).toBe(true);
    // turned away 40°: off after lookOffMs, not at once
    tr.update(obs({ yawDeg: 40 }), (t += 83));
    expect(tr.state.looking).toBe(true);
    t = feed(tr, () => obs({ yawDeg: 40 }), { t0: t + 83, n: 10 });
    expect(tr.state.looking).toBe(false);
    expect(tr.state.yaw).toBeLessThan(0); // mirrored: turned toward the screen's left
    t = feed(tr, () => obs(), { t0: t + 83, n: 6 });
    expect(tr.state.looking).toBe(true);
    // eyes turned aside (both eyes toward the same side), head straight
    t = feed(tr, () => obs({ blend: { eyeLookOutLeft: 0.8, eyeLookInRight: 0.75 } }), { t0: t + 83, n: 12 });
    expect(tr.state.looking).toBe(false);
    t = feed(tr, () => obs(), { t0: t + 83, n: 6 });
    // looking far down (at the keyboard)
    feed(tr, () => obs({ pitchDeg: -45 }), { t0: t + 83, n: 12 });
    expect(tr.state.looking).toBe(false);
  });

  it('smile: on after a moment above the threshold, off below the lower one', () => {
    const tr = new AttentionTracker();
    let t = feed(tr, () => obs(), { n: 4 });
    t = feed(tr, () => obs({ blend: { mouthSmileLeft: 0.8, mouthSmileRight: 0.7 } }), { t0: t + 83, n: 3 });
    expect(tr.state.smiling).toBe(false); // not yet (smileOnMs)
    t = feed(tr, () => obs({ blend: { mouthSmileLeft: 0.8, mouthSmileRight: 0.7 } }), { t0: t + 83, n: 8 });
    expect(tr.state.smiling).toBe(true);
    expect(tr.state.smile).toBeGreaterThan(0.6);
    t = feed(tr, () => obs({ blend: { mouthSmileLeft: 0.4, mouthSmileRight: 0.35 } }), { t0: t + 83, n: 10 });
    expect(tr.state.smiling).toBe(true); // between the thresholds: keeps smiling
    feed(tr, () => obs(), { t0: t + 83, n: 12 });
    expect(tr.state.smiling).toBe(false);
  });

  it('talking: a jaw that keeps opening and closing, not one held open', () => {
    const tr = new AttentionTracker();
    let t = feed(tr, () => obs(), { n: 4 });
    // speech: jaw 0.05..0.45 at ~4 syllables per second
    t = feed(tr, (i, tt) => obs({ blend: { jawOpen: 0.25 + 0.2 * Math.sin(tt / 40) } }), { t0: t + 83, n: 18 });
    expect(tr.state.talking).toBe(true);
    // a yawn: open and held
    feed(tr, () => obs({ blend: { jawOpen: 0.7 } }), { t0: t + 83, n: 20 });
    expect(tr.state.talking).toBe(false);
    expect(tr.state.jaw).toBeGreaterThan(0.6);
    // the same speech at a slower detection rate still counts
    const slow = new AttentionTracker();
    feed(slow, (i, tt) => obs({ blend: { jawOpen: 0.25 + 0.2 * Math.sin(tt / 40) } }), { n: 10, dt: 160 });
    expect(slow.state.talking).toBe(true);
  });

  it('reset forgets everything', () => {
    const tr = new AttentionTracker();
    feed(tr, () => obs(), { n: 6 });
    tr.reset(1000);
    expect(tr.state).toMatchObject({ present: false, looking: false, changedAt: 1000, lastSeen: -Infinity });
  });
});
