import { describe, expect, it } from 'vitest';
import {
  AUDIO_BANDS, LipSync, SyllableOscillator, VISEME_SHAPES, countSyllables, mouthFromAudio, mouthFromVisemes,
  normalizeVisemes, visemeIndexAt, visemeShape,
} from '../../../src/audio/lipsync.js';
import { Emitter } from '../../../src/app/emitter.js';

const TL = [
  { start: 0, end: 0.1, viseme: 'sil' },
  { start: 0.1, end: 0.3, viseme: 'aa' },
  { start: 0.3, end: 0.36, viseme: 'PP' },
  { start: 0.36, end: 0.6, viseme: 'O' },
  { start: 0.6, end: 0.8, viseme: 'sil' },
];
const OPTS = { lead: 0, blend: 0.05 };

describe('viseme table', () => {
  it('covers all contract viseme ids with values in 0..1', () => {
    for (const id of ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'RR', 'aa', 'E', 'I', 'O', 'U']) {
      const s = visemeShape(id);
      for (const k of ['jaw', 'wide', 'round']) {
        expect(s[k]).toBeGreaterThanOrEqual(0);
        expect(s[k]).toBeLessThanOrEqual(1);
      }
    }
    expect(visemeShape('nope')).toEqual(VISEME_SHAPES.sil);
    expect(VISEME_SHAPES.aa.jaw).toBeGreaterThan(VISEME_SHAPES.I.jaw);
    expect(VISEME_SHAPES.U.round).toBeGreaterThan(0.8);
    expect(VISEME_SHAPES.I.wide).toBeGreaterThan(0.6);
    expect(VISEME_SHAPES.PP.jaw).toBe(0);
  });
});

describe('mouthFromVisemes', () => {
  it('finds segments by binary search', () => {
    expect(visemeIndexAt(TL, -1)).toBe(-1);
    expect(visemeIndexAt(TL, 0)).toBe(0);
    expect(visemeIndexAt(TL, 0.2)).toBe(1);
    expect(visemeIndexAt(TL, 0.3)).toBe(2);
    expect(visemeIndexAt(TL, 0.59)).toBe(3);
    expect(visemeIndexAt(TL, 5)).toBe(TL.length);
  });

  it('returns the pure shape in the middle of a segment', () => {
    expect(mouthFromVisemes(TL, 0.2, OPTS)).toEqual(VISEME_SHAPES.aa);
    expect(mouthFromVisemes(TL, 0.48, OPTS)).toEqual(VISEME_SHAPES.O);
  });

  it('cross-fades 50/50 at a boundary (coarticulation)', () => {
    const m = mouthFromVisemes(TL, 0.1 + 1e-9, OPTS);
    expect(m.jaw).toBeCloseTo((VISEME_SHAPES.sil.jaw + VISEME_SHAPES.aa.jaw) / 2, 3);
    const before = mouthFromVisemes(TL, 0.0999, OPTS);
    expect(before.jaw).toBeCloseTo(m.jaw, 1); // continuous across the boundary
  });

  it('keeps a bilabial closure visible', () => {
    const mid = mouthFromVisemes(TL, 0.33, OPTS);
    expect(mid.jaw).toBeLessThan(0.1);
  });

  it('the mouth leads the audio', () => {
    // at t=0.07 with a 40 ms lead we already see the opening of "aa"
    expect(mouthFromVisemes(TL, 0.07, { lead: 0.04 }).jaw).toBeGreaterThan(mouthFromVisemes(TL, 0.07, OPTS).jaw);
  });

  it('closes after the end and before the start', () => {
    expect(mouthFromVisemes(TL, 2, OPTS)).toEqual(VISEME_SHAPES.sil);
    expect(mouthFromVisemes([{ start: 0.5, end: 0.7, viseme: 'aa' }], 0, OPTS)).toEqual(VISEME_SHAPES.sil);
    expect(mouthFromVisemes([], 0.2)).toEqual(VISEME_SHAPES.sil);
  });

  it('normalizeVisemes drops malformed entries and sorts', () => {
    expect(normalizeVisemes(null)).toBeNull();
    expect(normalizeVisemes([{ start: 0.2, end: 0.1, viseme: 'aa' }, 'x'])).toBeNull();
    expect(normalizeVisemes([{ start: 0.2, end: 0.3, viseme: 'O' }, { start: 0, end: 0.2, viseme: 'aa' }]).map((s) => s.viseme)).toEqual(['aa', 'O']);
  });
});

describe('mouthFromAudio', () => {
  it('gates silence and opens with loudness', () => {
    expect(mouthFromAudio(0.0005, [1, 1, 1]).jaw).toBe(0);
    const quiet = mouthFromAudio(0.01, [1, 1, 1]);
    const loud = mouthFromAudio(0.2, [1, 1, 1]);
    expect(loud.jaw).toBeGreaterThan(quiet.jaw);
    expect(loud.jaw).toBeLessThanOrEqual(0.85);
  });

  it('dark spectrum → round, bright spectrum → wide', () => {
    const dark = mouthFromAudio(0.2, [1, 0.1, 0.02]);
    const bright = mouthFromAudio(0.2, [0.2, 0.5, 1]);
    expect(dark.round).toBeGreaterThan(0.5);
    expect(dark.wide).toBeLessThan(0.2);
    expect(bright.wide).toBeGreaterThan(0.5);
    expect(bright.round).toBe(0);
    expect(AUDIO_BANDS).toHaveLength(3);
  });
});

describe('syllables (Web Speech fallback)', () => {
  it('counts syllables roughly', () => {
    expect(countSyllables('hello')).toBe(2);
    expect(countSyllables('time')).toBe(1);
    expect(countSyllables('hologram')).toBe(3);
    expect(countSyllables('table')).toBe(2);
    expect(countSyllables('a')).toBe(1);
    expect(countSyllables('')).toBe(0);
    expect(countSyllables('42')).toBe(2);
  });

  it('opens and closes once per syllable after a word boundary', () => {
    const o = new SyllableOscillator({ syllablesPerSec: 5 });
    o.start(0);
    o.word(0, 'hello'); // 2 syllables → 0.4 s
    const open1 = o.sample(0.1).jaw;
    const closed = o.sample(0.2).jaw;
    const open2 = o.sample(0.3).jaw;
    expect(open1).toBeGreaterThan(closed + 0.2);
    expect(open2).toBeGreaterThan(closed + 0.2);
    // between words (after the word, recent boundary) the mouth rests
    expect(o.sample(0.5).jaw).toBe(0);
    o.stop(1);
    expect(o.sample(1.1)).toMatchObject({ jaw: 0, level: 0 });
  });

  it('free-runs when no boundary events arrive', () => {
    const o = new SyllableOscillator();
    o.start(0);
    const jaws = Array.from({ length: 40 }, (_, i) => o.sample(1 + i * 0.025).jaw);
    expect(Math.max(...jaws)).toBeGreaterThan(0.2);
    expect(Math.min(...jaws)).toBeLessThan(0.1);
  });
});

describe('LipSync driver', () => {
  const player = (current, level = 0.1) => {
    const p = new Emitter();
    p.current = current;
    p.level = () => level;
    p.spectrum = () => false;
    p.sampleRate = 48000;
    return p;
  };

  it('uses visemes when the clip has them', () => {
    const ls = new LipSync({ player: player({ kind: 'audio', time: 0.2, clip: { visemes: TL } }), now: () => 0 });
    let m;
    for (let i = 0; i < 30; i++) m = ls.update(1 / 60, i / 60);
    expect(m.source).toBe('visemes');
    expect(m.jaw).toBeGreaterThan(0.5);
    expect(m.level).toBeGreaterThan(0.3);
  });

  it('falls back to audio analysis without visemes, and relaxes when idle', () => {
    const p = player({ kind: 'audio', time: 0.2, clip: {} }, 0.2);
    const ls = new LipSync({ player: p, now: () => 0 });
    let m;
    for (let i = 0; i < 30; i++) m = ls.update(1 / 60, 0);
    expect(m.source).toBe('audio');
    expect(m.jaw).toBeGreaterThan(0.3);
    p.current = null;
    for (let i = 0; i < 60; i++) m = ls.update(1 / 60, 0);
    expect(m.source).toBe('none');
    expect(m.jaw).toBeLessThan(0.01);
  });

  it('drives the oscillator from player speech events', () => {
    let now = 0;
    const p = player(null);
    const ls = new LipSync({ player: p, now: () => now });
    const clip = { kind: 'speech', text: 'hello world', rate: 1 };
    p.current = { kind: 'speech', time: 0, clip };
    p.emit('start', clip);
    p.emit('boundary', { word: 'hello' });
    now = 0.1;
    let m;
    for (let i = 0; i < 6; i++) m = ls.update(1 / 60, now);
    expect(m.source).toBe('speech');
    expect(m.jaw).toBeGreaterThan(0.1);
    p.emit('end', clip);
    ls.dispose();
  });
});
