// Fusion of the viseme timeline with the clip's acoustics (src/audio/fusion.js): the timeline is
// warped onto the sound's landmarks, the vowels get their amounts from F1 / F2 and loudness.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyseAcoustics } from '../../../src/audio/acoustics.js';
import {
  JAW_RANGE, SpeakerFormants, acousticOnset, alignTimeline, findDip, fuseTimeline, landmarks, priorNorms, vowelAmounts, warmUpFusion, warpTime,
} from '../../../src/audio/fusion.js';
import { visemeTarget } from '../../../src/audio/articulation.js';
import { decodeWav } from '../../../src/audio/wav.js';

const HOP = 0.005;
/**
 * A synthetic acoustic track: loudness `e(t)` (dBFS), the low band 3 dB under it, formants from
 * `f1(t)`. @param {number} dur @param {(t: number) => number} e @param {(t: number) => number} [f1]
 */
function track(dur, e, f1 = () => 0) {
  const n = Math.ceil(dur / HOP);
  const tr = { hop: HOP, n, done: n, duration: dur, e: new Float32Array(n), lo: new Float32Array(n), hi: new Float32Array(n), f1: new Float32Array(n), f2: new Float32Array(n), f3: new Float32Array(n), voiced: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const t = i * HOP;
    tr.e[i] = e(t);
    tr.lo[i] = e(t) - 3;
    tr.hi[i] = -80;
    tr.f1[i] = f1(t);
    tr.f2[i] = f1(t) ? 1800 : 0;
    tr.voiced[i] = e(t) > -50 ? 0.9 : 0;
  }
  return tr;
}

describe('landmarks', () => {
  // sound from 0.2 s, a closure dip (m) at 0.50-0.56, voice until 0.9
  const dip = (t) => (t < 0.2 || t > 0.9 ? -80 : t >= 0.5 && t < 0.56 ? -42 : -20);
  const ac = track(1.1, dip, (t) => (t > 0.2 && t < 0.9 ? 650 : 0));

  it('findDip: the closure between its half-level crossings, never a dip beside the segment', () => {
    const d = findDip(ac, ac.e, 0.47, 0.52);
    expect(d.t0).toBeCloseTo(0.5, 2);
    expect(d.t1).toBeCloseTo(0.56, 2);
    expect(d.depth).toBeCloseTo(22, 0);
    // a segment beside the dip only sees its slope
    expect(findDip(ac, ac.e, 0.7, 0.75)).toBe(null);
    // too shallow
    expect(findDip(track(1, (t) => (t > 0.5 && t < 0.55 ? -24 : -20)), track(1, (t) => (t > 0.5 && t < 0.55 ? -24 : -20)).e, 0.5, 0.55)).toBe(null);
  });

  it('acousticOnset: where the phrase\'s sound starts', () => {
    expect(acousticOnset(ac, 0.0, 0.5)).toBeCloseTo(0.2, 2);
    expect(acousticOnset(track(1, () => -80), 0, 0.5)).toBeNaN();
  });

  it('anchors a closure between vowels and a phrase onset; not a closure in a cluster', () => {
    // the timeline starts the first vowel 70 ms early and puts the m 30 ms late
    const t1 = [{ start: 0, end: 0.13, viseme: 'sil' }, { start: 0.13, end: 0.53, viseme: 'aa' }, { start: 0.53, end: 0.58, viseme: 'PP' },
      { start: 0.58, end: 0.9, viseme: 'E' }, { start: 0.9, end: 1.1, viseme: 'sil' }];
    const { anchors, exact } = landmarks(t1, ac);
    expect(anchors[0][0]).toBeCloseTo(0.13, 6);
    expect(anchors[0][1]).toBeCloseTo(0.2 - 0.01, 2);
    expect(anchors.some((a) => Math.abs(a[0] - 0.53) < 1e-6 && Math.abs(a[1] - 0.5) < 0.006)).toBe(true);
    expect(anchors.some((a) => Math.abs(a[0] - 0.58) < 1e-6 && Math.abs(a[1] - 0.56) < 0.006)).toBe(true);
    expect([...exact]).toEqual([2]);
    // the same dip after a d (a cluster: "should move"): no anchor, the warp carries it
    const t2 = t1.map((s) => ({ ...s }));
    t2[1] = { start: 0.13, end: 0.45, viseme: 'aa' };
    t2.splice(2, 0, { start: 0.45, end: 0.53, viseme: 'DD' });
    expect(landmarks(t2, ac).exact.size).toBe(0);
  });

  it('warps the timeline monotonically onto the anchors, contiguous, the closure exact', () => {
    const t1 = [{ start: 0, end: 0.13, viseme: 'sil' }, { start: 0.13, end: 0.53, viseme: 'aa' }, { start: 0.53, end: 0.58, viseme: 'PP' },
      { start: 0.58, end: 0.9, viseme: 'E' }, { start: 0.9, end: 1.1, viseme: 'sil' }];
    const { tl: out } = alignTimeline(t1, ac);
    expect(out[1].start).toBeCloseTo(0.19, 2);
    expect(out[2].start).toBeCloseTo(0.5, 2);
    expect(out[2].end).toBeCloseTo(0.56, 2);
    expect(out[2].exact).toBe(true);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start).toBe(out[i - 1].end);
      expect(out[i].end).toBeGreaterThan(out[i].start);
    }
    // warpTime: identity without anchors, piecewise linear between them, offsets fade far outside
    expect(warpTime([], 0.3)).toBe(0.3);
    const A = [[0.2, 0.25], [0.6, 0.6]];
    expect(warpTime(A, 0.4)).toBeCloseTo(0.425, 9);
    expect(warpTime(A, 0.2)).toBeCloseTo(0.25, 9);
    expect(warpTime(A, -0.5)).toBeCloseTo(-0.5, 9);
  });

  it('a phrase that starts earlier than the timeline says does not drag the phrase before the pause', () => {
    // "Bob, pop": the first phrase's sound matches its timeline; the second starts 60 ms early
    const e2 = (t) => ((t >= 0.1 && t < 0.35) || (t >= 0.44 && t < 0.8) ? -20 : -80);
    const ac2 = track(1, e2);
    const t3 = [{ start: 0, end: 0.1, viseme: 'sil' }, { start: 0.1, end: 0.3, viseme: 'aa' }, { start: 0.3, end: 0.35, viseme: 'PP' },
      { start: 0.35, end: 0.5, viseme: 'sil' }, { start: 0.5, end: 0.8, viseme: 'aa' }, { start: 0.8, end: 1, viseme: 'sil' }];
    const { tl: out } = alignTimeline(t3, ac2);
    expect(out[4].start).toBeCloseTo(0.43, 2);                 // the second phrase moves to its sound
    expect(Math.abs(out[2].start - 0.3)).toBeLessThan(0.008);  // the first one's final b stays (it moved ~40 ms)
    expect(Math.abs(out[3].start - 0.35)).toBeLessThan(0.005);
  });
});

describe('vowel amounts', () => {
  const n = priorNorms(200);
  const clip = { e: -24, dur: 0.1 };
  const va = (f1, o = {}) => ({ f1, f2: o.f2 ?? 1800, q: 1, e: o.e ?? -24, dur: o.dur ?? 0.1 });

  it('the jaw follows F1: an open vowel opens 2-3x a close one; the category bounds it', () => {
    const open = vowelAmounts('aa', va(850), n, clip, visemeTarget('aa'));
    const mid = vowelAmounts('E', va(600), n, clip, visemeTarget('E'));
    const close = vowelAmounts('I', va(370), n, clip, visemeTarget('I'));
    expect(open.jaw).toBeGreaterThan(mid.jaw);
    expect(mid.jaw).toBeGreaterThan(close.jaw);
    expect(open.jaw / close.jaw).toBeGreaterThan(2.5);
    // a U whose "F1" reads high (F2 taken for it in a back vowel) is still a close vowel
    expect(vowelAmounts('U', va(800), n, clip, visemeTarget('U')).jaw).toBeLessThanOrEqual(JAW_RANGE.U[1] * 1.2);
    // no formants: the viseme's own target
    expect(vowelAmounts('aa', { ...va(0), q: 0 }, n, clip, visemeTarget('aa')).jaw).toBeCloseTo(visemeTarget('aa')[0] * 0.92, 2);
  });

  it('stressed (louder, longer) vowels open more; a reduced one less, and it is not spread', () => {
    const stressed = vowelAmounts('E', va(600, { e: -18, dur: 0.16 }), n, clip, visemeTarget('E'));
    const plain = vowelAmounts('E', va(600), n, clip, visemeTarget('E'));
    const reduced = vowelAmounts('E', va(600, { e: -30, dur: 0.05 }), n, clip, visemeTarget('E'));
    expect(stressed.jaw).toBeGreaterThan(plain.jaw * 1.15);
    expect(reduced.jaw).toBeLessThan(plain.jaw * 0.8);
    expect(reduced.wide).toBeLessThan(plain.wide * 0.75);
    // spread follows F2
    expect(vowelAmounts('I', va(370, { f2: 2600 }), n, clip, visemeTarget('I')).wide).toBeGreaterThan(vowelAmounts('I', va(370, { f2: 1500 }), n, clip, visemeTarget('I')).wide);
  });

  it('speaker norms: the prior by pitch, then the vowels heard', () => {
    expect(priorNorms(220).f1hi).toBeGreaterThan(priorNorms(110).f1hi);
    const sp = new SpeakerFormants();
    const fresh = sp.norms(110);
    sp.add(Array.from({ length: 60 }, (_, i) => ({ f1: 400 + 8 * i, f2: 1500 + 10 * i })));
    const learned = sp.norms(110);
    expect(learned.f1lo).toBeGreaterThan(fresh.f1lo);
    expect(learned.f1hi - learned.f1lo).toBeGreaterThan(220);
  });
});

describe('on a real Kokoro clip', () => {
  const dir = fileURLToPath(new URL('../../fixtures/kokoro/', import.meta.url));
  const meta = JSON.parse(readFileSync(`${dir}maybe_af_heart.json`, 'utf8'));
  const wav = decodeWav(new Uint8Array(readFileSync(`${dir}maybe_af_heart.wav`)));
  const ac = analyseAcoustics(wav.samples, wav.sampleRate);
  const f = fuseTimeline(meta.visemes, ac, null, 200, visemeTarget);

  it('the first phrase starts where its sound does; segments stay ordered and contiguous', () => {
    const first = f.tl.find((s) => s.viseme !== 'sil');
    const on = acousticOnset(ac, 0, 0.5);
    expect(first.start).toBeGreaterThan(on - 0.03);
    expect(first.start).toBeLessThan(on + 0.01);
    for (let i = 1; i < f.tl.length; i++) expect(f.tl[i].start).toBeCloseTo(f.tl[i - 1].end, 9);
  });

  it('gives the open vowels (aa) more jaw than the close ones (I, U), from their sound', () => {
    const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const jaw = (ids) => mean(f.tl.map((s, i) => (ids.includes(s.viseme) && f.amounts[i] ? f.amounts[i].jaw : NaN)).filter(Number.isFinite));
    expect(jaw(['aa'])).toBeGreaterThan(2 * jaw(['I', 'U']));
    expect(f.vowels.length).toBeGreaterThan(10);
  });

  it('warmUpFusion runs once (it only compiles the code; the results are unchanged)', () => {
    const first = warmUpFusion(visemeTarget);
    expect(warmUpFusion(visemeTarget)).toBe(false);
    expect(typeof first).toBe('boolean');
    expect(fuseTimeline(meta.visemes, ac, null, 200, visemeTarget)).toEqual(f);
  });
});
