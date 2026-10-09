// Coarticulation model and speech plans (src/audio/articulation.js): dominance blending, crisp
// closures, anticipatory rounding, timing.
import { describe, expect, it } from 'vitest';
import {
  CHANNELS, LEAD_IN, PAUSES, REST, VISEME_IDS, VISEME_SHAPES, closureCentreIn, makeSegment, planSpeech,
  sampleSegments, segmentsFromVisemes, sentenceFriendliness, toShape, visemeSegment,
} from '../../../src/audio/articulation.js';
import { textToWords } from '../../../src/audio/g2p.js';
import { Director } from '../../../src/avatar/director.js';

const ch = (name) => CHANNELS.indexOf(name);
const at = (segs, t) => toShape(sampleSegments(segs, t));

/** Contiguous server-style timeline → segments. [[viseme, durationSec], ...] starting at 0. */
function timeline(spec) {
  let t = 0;
  return spec.map(([viseme, d]) => {
    const s = { start: t, end: t + d, viseme };
    t += d;
    return s;
  });
}

describe('viseme shapes', () => {
  it('cover every contract viseme id with channels in 0..1', () => {
    expect(VISEME_IDS).toEqual(['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'RR', 'aa', 'E', 'I', 'O', 'U']);
    for (const id of VISEME_IDS) {
      for (const k of CHANNELS) {
        expect(VISEME_SHAPES[id][k]).toBeGreaterThanOrEqual(0);
        expect(VISEME_SHAPES[id][k]).toBeLessThanOrEqual(1);
      }
    }
    expect(VISEME_SHAPES.sil).toEqual(REST);
    expect(VISEME_SHAPES.PP.press).toBe(1);
    expect(VISEME_SHAPES.FF.tuck).toBe(1);
    expect(VISEME_SHAPES.TH.tongue).toBe(1);
    expect(VISEME_SHAPES.SS.teeth).toBeGreaterThan(0.8);
    expect(VISEME_SHAPES.U.round).toBeGreaterThan(0.9);
    expect(VISEME_SHAPES.aa.jaw).toBeGreaterThan(VISEME_SHAPES.E.jaw);
  });
});

describe('dominance blending', () => {
  it('returns the target in the middle of a long segment and rest far outside', () => {
    const segs = segmentsFromVisemes(timeline([['sil', 0.2], ['aa', 0.3], ['sil', 0.3]]));
    const mid = at(segs, 0.35);
    expect(mid.jaw).toBeCloseTo(VISEME_SHAPES.aa.jaw * segs[2].T[0] / VISEME_SHAPES.aa.jaw, 2);
    expect(at(segs, -5)).toEqual(REST);
    expect(at(segs, 50)).toEqual(REST);
    expect(at([], 0.1)).toEqual(REST);
  });

  it('is continuous and finite everywhere, including exactly at segment edges', () => {
    const tl = timeline([['sil', 0.1], ['aa', 0.12], ['PP', 0.05], ['O', 0.15], ['FF', 0.06], ['I', 0.1], ['sil', 0.2]]);
    const segs = segmentsFromVisemes(tl);
    const edges = tl.flatMap((s) => [s.start, s.end]);
    for (const t of [...edges, ...edges.map((e) => e + 1e-12), ...edges.map((e) => e - 1e-12), -0.3, -1e-9, 0.78, 10]) {
      const v = sampleSegments(segs, t);
      for (const x of v) {
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
      }
    }
    // no jumps: 1 ms steps change no channel by more than a few percent
    let prev = sampleSegments(segs, -0.1).slice();
    for (let t = -0.1; t < 1; t += 0.001) {
      const v = sampleSegments(segs, t);
      for (let c = 0; c < v.length; c++) expect(Math.abs(v[c] - prev[c])).toBeLessThan(0.08);
      prev = v.slice();
    }
    expect(sampleSegments(segs, NaN)).toEqual(new Array(CHANNELS.length).fill(0));
  });

  it('closes a 50 ms bilabial between two open vowels (press >= 0.8, jaw <= 0.06)', () => {
    for (const vowel of ['aa', 'E', 'O']) {
      const tl = timeline([['sil', 0.2], [vowel, 0.14], ['PP', 0.05], [vowel, 0.14], ['sil', 0.2]]);
      const m = at(segmentsFromVisemes(tl), 0.2 + 0.14 + 0.025);
      expect(m.press, vowel).toBeGreaterThanOrEqual(0.8);
      expect(m.jaw, vowel).toBeLessThanOrEqual(0.06);
      expect(m.teeth, vowel).toBeLessThan(0.1);
      // and the vowels around it still open
      expect(at(segmentsFromVisemes(tl), 0.27).jaw).toBeGreaterThan(0.3);
    }
  });

  it('tucks a 50 ms f/v and gives the tongue to a th', () => {
    const tl = timeline([['sil', 0.2], ['aa', 0.14], ['FF', 0.05], ['I', 0.14], ['TH', 0.06], ['E', 0.14], ['sil', 0.2]]);
    const segs = segmentsFromVisemes(tl);
    const f = at(segs, 0.2 + 0.14 + 0.025);
    expect(f.tuck).toBeGreaterThanOrEqual(0.8);
    expect(f.jaw).toBeLessThan(0.15);
    const th = at(segs, 0.2 + 0.14 + 0.05 + 0.14 + 0.03);
    expect(th.tongue).toBeGreaterThan(0.6);
  });

  it('rounds the lips ahead of an O / U (anticipation up to ~120 ms)', () => {
    // "s t r oo": consonants before a rounded vowel start rounding early...
    const rounded = segmentsFromVisemes(timeline([['sil', 0.3], ['SS', 0.08], ['DD', 0.06], ['U', 0.18], ['sil', 0.3]]));
    // ... but not before a spread vowel
    const spread = segmentsFromVisemes(timeline([['sil', 0.3], ['SS', 0.08], ['DD', 0.06], ['I', 0.18], ['sil', 0.3]]));
    const onset = 0.3 + 0.14;
    expect(at(rounded, onset - 0.1).round).toBeGreaterThan(0.25);
    expect(at(rounded, onset - 0.05).round).toBeGreaterThan(at(rounded, onset - 0.1).round);
    expect(at(spread, onset - 0.1).round).toBeLessThan(0.05);
    // far ahead (> 200 ms) nothing yet
    expect(at(rounded, onset - 0.25).round).toBeLessThan(0.05);
    // a spread vowel in between blocks the anticipation: "s ee t oo"
    const blocked = segmentsFromVisemes(timeline([['sil', 0.3], ['SS', 0.08], ['I', 0.14], ['DD', 0.06], ['U', 0.18], ['sil', 0.3]]));
    expect(at(blocked, 0.3 + 0.08 + 0.07).round).toBeLessThan(at(rounded, 0.3 + 0.08 + 0.03).round);
  });

  it('lets h and schwa take their neighbours\' shape', () => {
    const h = makeSegment(0.1, 0.16, 'kk', 'HH', 'HH');
    const o = makeSegment(0.16, 0.36, 'O', 'OH', 'rounded');
    const m = at([makeSegment(-0.3, 0.1, 'sil', 'sil', 'sil'), h, o], 0.13);
    expect(m.round).toBeGreaterThan(0.3); // the h of "ho" is already rounded
  });

  it('stress scales the jaw (and teeth) of a vowel', () => {
    const strong = visemeSegment(0, 0.2, 'aa', 1.05);
    const weak = visemeSegment(0, 0.2, 'aa', 0.7);
    expect(strong.T[ch('jaw')]).toBeGreaterThan(weak.T[ch('jaw')]);
    expect(strong.T[ch('teeth')]).toBeGreaterThan(weak.T[ch('teeth')]);
  });

  it('finds a closure centre passed between two frames (never skipped at 30 fps)', () => {
    const segs = segmentsFromVisemes(timeline([['aa', 0.1], ['PP', 0.05], ['aa', 0.1]]));
    expect(closureCentreIn(segs, 0.11, 0.14)).toBeCloseTo(0.125, 9);
    expect(closureCentreIn(segs, 0.13, 0.16)).toBeNaN();
    expect(closureCentreIn(segs, 0.0, 0.5)).toBeNaN(); // a jump, not a frame step
  });
});

describe('server timelines', () => {
  it('adds rest around the timeline and estimates prominence from vowel length', () => {
    const tl = timeline([['aa', 0.06], ['DD', 0.05], ['aa', 0.2], ['sil', 0.1]]);
    const segs = segmentsFromVisemes(tl);
    expect(segs[0].viseme).toBe('sil');
    expect(segs.at(-1).viseme).toBe('sil');
    expect(segs).toHaveLength(tl.length + 2);
    expect(segs[3].T[ch('jaw')]).toBeGreaterThan(segs[1].T[ch('jaw')]); // the long vowel opens wider
    expect(segmentsFromVisemes([])).toEqual([]);
    expect(segmentsFromVisemes(null)).toEqual([]);
    // unknown ids rest
    expect(visemeSegment(0, 1, 'nope').viseme).toBe('sil');
  });
});

describe('speech plans (system voice)', () => {
  const text = "Hello! I'm Claude. How are you feeling today?";
  const plan = planSpeech(text);

  it('times every word in order with a rest lead-in, pauses at punctuation and a rest tail', () => {
    expect(plan.words.map((w) => w.text)).toEqual(textToWords(text).map((w) => w.text));
    expect(plan.words[0].t0).toBeCloseTo(LEAD_IN, 9);
    for (let i = 1; i < plan.words.length; i++) {
      expect(plan.words[i].t0).toBeCloseTo(plan.words[i - 1].t1 + plan.words[i - 1].pause, 9);
    }
    expect(plan.words[0].pause).toBeCloseTo(PAUSES['!'], 9);
    expect(plan.words[2].pause).toBeCloseTo(PAUSES['.'], 9);
    expect(plan.words.at(-1).pause).toBe(0);         // the utterance ends: no pause after the last word
    expect(plan.segs[0].viseme).toBe('sil');
    expect(plan.segs.at(-1).viseme).toBe('sil');
    // contiguous, sorted, positive
    for (let i = 1; i < plan.segs.length; i++) {
      expect(plan.segs[i].start).toBeCloseTo(plan.segs[i - 1].end, 9);
      expect(plan.segs[i].end).toBeGreaterThan(plan.segs[i].start);
    }
    // the pause after "Hello!" rests the mouth
    const pauseMid = plan.words[0].t1 + plan.words[0].pause / 2;
    expect(at(plan.segs, pauseMid).jaw).toBeLessThan(0.02);
  });

  it('speaks ordinary prose at a natural rate (~150-210 words per minute)', () => {
    const prose = [
      'The quick brown fox jumps over the lazy dog, and then it runs back home to sleep.',
      'I can help you write code, answer questions about your files, or just talk about your day.',
      "That's a great question. Let me think about it for a moment before I answer.",
    ];
    let words = 0, dur = 0;
    for (const s of prose) {
      const p = planSpeech(s);
      words += p.words.length;
      dur += p.duration - LEAD_IN;
    }
    const wpm = (words / dur) * 60;
    expect(wpm).toBeGreaterThan(150);
    expect(wpm).toBeLessThan(210);
  });

  it('makes stressed vowels long, unstressed ones short, closures >= 50 ms, phrase ends longer', () => {
    const vowels = plan.segs.filter((s) => s.ph && /^[AEIOU]/.test(s.ph));
    const stressed = vowels.filter((s) => s.stress === 1).map((s) => s.end - s.start);
    const unstressed = vowels.filter((s) => s.stress === 0).map((s) => s.end - s.start);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(stressed)).toBeGreaterThan(1.4 * mean(unstressed));
    for (const s of plan.segs.filter((x) => x.viseme === 'PP')) expect(s.end - s.start).toBeGreaterThanOrEqual(0.05);
    // phrase-final lengthening: "Claude." vs the same word mid-phrase
    const fin = planSpeech('Claude.').words[0];
    const mid = planSpeech('Claude said').words[0];
    expect(fin.t1 - fin.t0).toBeGreaterThan(1.15 * (mid.t1 - mid.t0));
  });

  it('closes the lips for the m of "I\'m" and tucks for the f of "feeling"', () => {
    const m = plan.segs.find((s) => s.ph === 'M');
    const f = plan.segs.find((s) => s.ph === 'F');
    const atM = at(plan.segs, (m.start + m.end) / 2);
    expect(atM.press).toBeGreaterThanOrEqual(0.8);
    expect(atM.jaw).toBeLessThanOrEqual(0.06);
    expect(at(plan.segs, (f.start + f.end) / 2).tuck).toBeGreaterThanOrEqual(0.8);
    const l = plan.segs.find((s) => s.ph === 'L');
    expect(at(plan.segs, (l.start + l.end) / 2).tongue).toBeGreaterThan(0.5);
    const ao = plan.segs.find((s) => s.ph === 'AO');
    expect(at(plan.segs, (ao.start + ao.end) / 2).round).toBeGreaterThan(0.4);
  });

  it('cues phrase starts, accents on content words, phrase ends with punctuation and friendliness', () => {
    const types = plan.cues.map((c) => c.type);
    expect(types.filter((t) => t === 'phrase-start')).toHaveLength(3);
    const ends = plan.cues.filter((c) => c.type === 'phrase-end');
    expect(ends.map((c) => c.punct)).toEqual(['!', '.', '?']);
    expect(ends[0].friendly).toBeGreaterThan(0.5);     // "Hello!"
    expect(ends[2].friendly).toBeGreaterThan(0);       // "How are you feeling today?"
    const accents = plan.cues.filter((c) => c.type === 'accent');
    expect(accents.map((c) => plan.words[c.word].text)).toEqual(['Hello', 'Claude', 'feeling', 'today']);
    // the last content word of a phrase gets the strongest (nuclear) accent
    expect(accents[3].strength).toBeGreaterThan(accents[2].strength);
    for (let i = 1; i < plan.cues.length; i++) expect(plan.cues[i].t).toBeGreaterThanOrEqual(plan.cues[i - 1].t);
  });

  it('rates friendliness', () => {
    const w = (s) => textToWords(s);
    expect(sentenceFriendliness(w('Thanks so much'), '!')).toBeGreaterThan(0.8);
    expect(sentenceFriendliness(w('The file is here'), '.')).toBe(0);
    expect(sentenceFriendliness(w('Sorry, that failed'), '!')).toBe(0);
  });

  it('copes with empty and symbol-only text', () => {
    for (const t of ['', '   ', '…', '★ →']) {
      const p = planSpeech(t);
      expect(p.words).toEqual([]);
      expect(at(p.segs, 0.2)).toEqual(REST);
    }
  });
});

describe('through the director (what the head shows)', () => {
  /** Drive a director with the dominance output of `segs` at `fps`; return the AnimState samples. */
  function drive(segs, fps, t0, t1) {
    const d = new Director({ seed: 3, idleMotion: 0 });
    d.setState('speaking');
    const out = [];
    let prev = NaN;
    for (let t = t0 - 0.5; t < t1; t += 1 / fps) {
      const c = closureCentreIn(segs, prev, t);
      d.setMouth(toShape(sampleSegments(segs, Number.isFinite(c) ? c : t)));
      prev = t;
      const a = d.update(1 / fps, t);
      out.push({ t, press: a.mouthPress, jaw: a.jawOpen, tuck: a.mouthTuck });
    }
    return out;
  }

  it('a 50 ms closure between open vowels really closes on screen at 60 and 30 fps', () => {
    const tl = timeline([['sil', 0.5], ['aa', 0.15], ['PP', 0.05], ['aa', 0.15], ['sil', 0.3]]);
    const segs = segmentsFromVisemes(tl);
    for (const fps of [60, 30]) {
      const frames = drive(segs, fps, 0, 1.2).filter((f) => f.t > 0.6 && f.t < 0.8);
      const closed = frames.filter((f) => f.press >= 0.8 && f.jaw <= 0.06);
      expect(closed.length, `${fps} fps`).toBeGreaterThanOrEqual(1);
    }
  });

  it('a 50 ms f/v tucks on screen at 30 fps', () => {
    const segs = segmentsFromVisemes(timeline([['sil', 0.5], ['aa', 0.15], ['FF', 0.05], ['I', 0.15], ['sil', 0.3]]));
    const frames = drive(segs, 30, 0, 1.2).filter((f) => f.t > 0.6 && f.t < 0.8);
    expect(Math.max(...frames.map((f) => f.tuck))).toBeGreaterThanOrEqual(0.75);
  });
});

describe('marks inside a token', () => {
  it('"github.com" plans no pause and no phrase end mid-sentence', () => {
    const plan = planSpeech('See github.com for the full source.');
    expect(plan.words.map((w) => w.text)).toEqual(['See', 'github', 'dot', 'com', 'for', 'the', 'full', 'source']);
    expect(plan.words.filter((w) => w.pause > 0)).toEqual([]);
    expect(plan.cues.filter((c) => c.type === 'phrase-end')).toHaveLength(1);
    expect(plan.cues.filter((c) => c.type === 'phrase-start')).toHaveLength(1);
    const ten = planSpeech('Meet me at 10:30 with version 1.2.3 please.');
    expect(ten.words.filter((w) => w.pause > 0)).toEqual([]);
  });
});
