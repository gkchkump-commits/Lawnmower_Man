// Audio prosody (src/audio/prosody.js) on synthetic signals: pitch accuracy on tones and glides,
// voiced / unvoiced decisions, the loudness envelope, accent picking, final falls and rises,
// pauses and breaths, and phrase-final trimming.
import { describe, expect, it } from 'vitest';
import {
  ACCENT_MIN, ClipProsody, HOP, VoiceAnalysis, audibleEnd, endFor, energyEnvelope, finalContour, phrasesOf,
  prominence, semitones, trimPhraseEnds,
} from '../../../src/audio/prosody.js';

const SR = 24000;

/**
 * A voice-like signal: harmonics 1..8 with a 1/k roll-off (a glottal buzz), pitch f(t) Hz and
 * amplitude amp(t), so the phase follows a changing pitch smoothly.
 * @param {number} dur @param {(t: number) => number} f @param {(t: number) => number} [amp]
 */
function buzz(dur, f, amp = () => 0.3) {
  const n = Math.round(dur * SR);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * f(t)) / SR;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * ph) / k;
    x[i] = amp(t) * 0.5 * v;
  }
  return x;
}

/** Deterministic white noise. */
function noise(dur, amp = 0.2) {
  let s = 12345;
  const x = new Float32Array(Math.round(dur * SR));
  for (let i = 0; i < x.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    x[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return x;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const silence = (dur) => new Float32Array(Math.round(dur * SR));
const voicedF0 = (a, t0, t1) => {
  const v = [];
  for (let i = a.frame(t0); i <= a.frame(t1); i++) if (a.f0[i] > 0) v.push(a.f0[i]);
  return v;
};
const median = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];

describe('pitch (YIN)', () => {
  for (const f of [85, 120, 200, 310, 440]) {
    it(`finds ${f} Hz within 1 % and calls it voiced`, () => {
      const a = new VoiceAnalysis(buzz(0.6, () => f), SR);
      a.advance();
      const v = voicedF0(a, 0.05, 0.55);
      expect(v.length).toBeGreaterThan(40);                  // ~all frames voiced
      expect(Math.abs(median(v) / f - 1)).toBeLessThan(0.01);
      // and no octave slips anywhere
      for (const x of v) expect(Math.abs(semitones(x, f))).toBeLessThan(1);
    });
  }

  it('follows a glide (120 -> 240 Hz in 1 s) frame by frame', () => {
    const f = (t) => 120 * 2 ** t;
    const a = new VoiceAnalysis(buzz(1, f), SR);
    a.advance();
    let n = 0;
    for (let i = a.frame(0.05); i <= a.frame(0.95); i++) {
      expect(a.f0[i]).toBeGreaterThan(0);
      expect(Math.abs(semitones(a.f0[i], f(i * HOP)))).toBeLessThan(0.35);
      n++;
    }
    expect(n).toBeGreaterThan(80);
  });

  it('noise and silence are unvoiced', () => {
    const a = new VoiceAnalysis(concat(noise(0.5), silence(0.3)), SR);
    a.advance();
    const nv = voicedF0(a, 0.05, 0.45).length;
    expect(nv).toBeLessThan(0.2 * 40);
    expect(voicedF0(a, 0.55, 0.75)).toEqual([]);
    expect(a.f0[a.frame(0.6)]).toBe(0);
  });

  it('analyses in bounded steps, ahead of a playback time', () => {
    const a = new VoiceAnalysis(buzz(2, () => 150), SR);
    expect(a.done).toBe(0);
    expect(Number.isNaN(a.f0[10])).toBe(true);             // not analysed yet
    expect(a.advance(25)).toBe(25);
    expect(a.done).toBe(25);
    a.advanceTo(0.5, 10);                                   // a budget smaller than the need
    expect(a.done).toBe(35);
    a.advanceTo(0.5);
    expect(a.readyTo(0.5)).toBe(true);
    expect(a.readyTo(0.9)).toBe(false);
    a.advance();
    expect(a.complete).toBe(true);
    expect(Math.abs(a.medianPitch() / 150 - 1)).toBeLessThan(0.01);
  });

  it('works at other sample rates (48 kHz)', () => {
    const n = 0.5 * 48000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / 48000) + 0.1 * Math.sin((4 * Math.PI * 180 * i) / 48000);
    const a = new VoiceAnalysis(x, 48000);
    a.advance();
    expect(Math.abs(a.medianPitch() / 180 - 1)).toBeLessThan(0.01);
  });
});

describe('loudness envelope', () => {
  it('is 0 dB at the loudest frame, tracks a 12 dB step and floors silence', () => {
    const x = concat(buzz(0.3, () => 150, () => 0.075), buzz(0.3, () => 150, () => 0.3), silence(0.2));
    const e = energyEnvelope(x, SR, Math.ceil(0.8 / HOP));
    expect(Math.max(...e)).toBeCloseTo(0, 5);
    expect(e[Math.round(0.45 / HOP)]).toBeGreaterThan(-1);
    expect(Math.abs(e[Math.round(0.15 / HOP)] + 12)).toBeLessThan(1);   // (+- the ripple of a 30 ms window)
    expect(e[Math.round(0.75 / HOP)]).toBe(-80);
    const a = new VoiceAnalysis(x, SR);
    expect(Math.abs(a.energyAt(0.15) + 12)).toBeLessThan(1);
    expect(audibleEnd(a, 0.3, 0.8)).toBeCloseTo(0.6, 1);   // the voice stops at 0.6 s
  });
});

/** Timeline of vowels (aa) with rests: [[start, end], ...] → visemes. */
function timeline(spans, dur) {
  const tl = [];
  let t = 0;
  for (const [a, b] of spans) {
    if (a > t) tl.push({ start: t, end: a, viseme: 'sil' });
    tl.push({ start: a, end: b, viseme: 'aa' });
    t = b;
  }
  if (dur > t) tl.push({ start: t, end: dur, viseme: 'sil' });
  return tl;
}

describe('speech events (ClipProsody)', () => {
  // five syllables of 0.12 s with 0.04 s consonant gaps; the third one higher and louder
  const sylls = [0.2, 0.36, 0.52, 0.68, 0.84];
  const make = (accent) => {
    const parts = [silence(0.2)];
    for (let k = 0; k < sylls.length; k++) {
      const hi = k === accent;
      parts.push(buzz(0.12, () => (hi ? 150 * 2 ** (4 / 12) : 150), () => (hi ? 0.4 : 0.2)), silence(0.04));
    }
    parts.push(silence(0.4));
    return concat(...parts);
  };
  const spans = sylls.map((s) => [s, s + 0.12]);

  it('puts an accent on the syllable that is higher and louder than its neighbours, not on the flat ones', () => {
    const x = make(2);
    const a = new VoiceAnalysis(x, SR);
    a.advance();
    const tl = timeline(spans, x.length / SR);
    const cp = new ClipProsody(a, tl, { ref: () => 150 });
    const cues = cp.take(10, Infinity);
    const accents = cues.filter((c) => c.type === 'accent');
    expect(accents.map((c) => c.t)).toEqual([0.52]);
    expect(accents[0].strength).toBeGreaterThan(0.5);
    // the flat version has no accent standing out above ACCENT_MIN... except by length / loudness ties
    const flat = new VoiceAnalysis(make(-1), SR);
    flat.advance();
    const fc = new ClipProsody(flat, tl, { ref: () => 150 }).take(10, Infinity).filter((c) => c.type === 'accent');
    expect(fc.length).toBeLessThanOrEqual(1);
  });

  it('scores prominence from pitch, rise, loudness and length', () => {
    const base = prominence({ st: 0, rise: 0 }, 0, 1);
    expect(prominence({ st: 4, rise: 3 }, 0, 1)).toBeGreaterThan(base + 0.3);
    expect(prominence({ st: 0, rise: 0 }, 5, 1)).toBeGreaterThan(base + 0.1);
    expect(prominence({ st: 0, rise: 0 }, 0, 2)).toBeGreaterThan(base);
    expect(prominence({ st: 5, rise: 3 }, 4, 1.5)).toBeGreaterThan(ACCENT_MIN);
    expect(prominence({ st: NaN, rise: NaN }, 4, 1.8)).toBeGreaterThan(prominence({ st: NaN, rise: NaN }, -4, 0.8));
  });

  it('a phrase-final fall and a final rise (question) are measured in semitones', () => {
    const fall = new VoiceAnalysis(concat(buzz(0.6, (t) => 200 * 2 ** (-(Math.max(0, t - 0.2) / 0.4) * 5 / 12)), silence(0.2)), SR);
    fall.advance();
    const f = finalContour(fall, 0.6, 200);
    expect(f.fall).toBeGreaterThan(3.5);
    expect(f.rise).toBeLessThan(1);
    const rise = new VoiceAnalysis(concat(buzz(0.6, (t) => 200 * 2 ** ((Math.max(0, t - 0.2) / 0.4) * 6 / 12)), silence(0.2)), SR);
    rise.advance();
    const r = finalContour(rise, 0.6, 200);
    expect(r.rise).toBeGreaterThan(4);
    expect(r.fall).toBeLessThan(1);
  });

  it('breathes before the first phrase and in a long pause, and reports the pause after a phrase', () => {
    const x = concat(silence(0.15), buzz(0.5, () => 160), silence(0.45), buzz(0.4, () => 160), silence(0.2));
    const a = new VoiceAnalysis(x, SR);
    a.advance();
    const tl = timeline([[0.15, 0.65], [1.1, 1.5]], x.length / SR);
    expect(phrasesOf(tl).map((p) => [p.start, p.end])).toEqual([[0.15, 0.65], [1.1, 1.5]]);
    const cp = new ClipProsody(a, tl, { ref: () => 160, ends: [{ punct: ',', friendly: 0, pos: 0.5 }, { punct: '.', friendly: 0.7, pos: 1 }] });
    const cues = cp.take(10, Infinity);
    const types = cues.map((c) => `${c.type}@${c.t.toFixed(2)}`);
    expect(types).toContain('inhale@0.00');
    expect(types).toContain('inhale@0.69');
    expect(types).toContain('phrase-start@0.15');
    const ends = cues.filter((c) => c.type === 'phrase-end');
    expect(ends.map((c) => [c.punct, c.friendly])).toEqual([[',', 0], ['.', 0.7]]);
    expect(ends[0].pause).toBeCloseTo(0.45, 6);
    expect(ends[1].pause).toBe(Infinity);
  });

  it('hands cues out in time order and drops the long overdue ones', () => {
    const x = concat(silence(0.15), buzz(0.5, () => 160), silence(0.3));
    const a = new VoiceAnalysis(x, SR);
    a.advance();
    const cp = new ClipProsody(a, timeline([[0.15, 0.65]], 0.95), { ref: () => 160 });
    expect(cp.take(0.1)?.map((c) => c.type)).toEqual(['inhale']);
    expect(cp.take(0.1)).toBeNull();
    // a stall: everything due more than 0.4 s ago is skipped
    expect(cp.take(5)).toBeNull();
  });

  it('maps the text\'s phrase ends onto the audio phrases', () => {
    const P = [{ start: 0, end: 1, rest: 0.3 }, { start: 1.3, end: 2.4, rest: Infinity }];
    const ends = [{ punct: '!', pos: 0.125 }, { punct: '.', pos: 0.375 }, { punct: '?', pos: 1 }];
    expect(endFor(ends, P, 0).punct).toBe('.');             // "Hello! I'm Claude." is one phrase
    expect(endFor(ends, P, 1).punct).toBe('?');
    expect(endFor(ends.slice(1), P, 0).punct).toBe('.');    // same count: one each
    expect(endFor([], P, 0)).toBeNull();
  });
});

describe('phrase-final trimming', () => {
  it('cuts a final sound where the voice stops and rests for the remainder', () => {
    // the voice stops at 0.5 s but the timeline holds a "d" until 0.7 s
    const x = concat(silence(0.1), buzz(0.4, () => 150), silence(0.4));
    const a = new VoiceAnalysis(x, SR);
    const tl = [
      { start: 0, end: 0.1, viseme: 'sil' }, { start: 0.1, end: 0.4, viseme: 'aa' }, { start: 0.4, end: 0.7, viseme: 'DD' },
      { start: 0.7, end: 0.9, viseme: 'sil' },
    ];
    const out = trimPhraseEnds(tl, a);
    expect(out[2].viseme).toBe('DD');
    expect(out[2].end).toBeGreaterThan(0.48);
    expect(out[2].end).toBeLessThan(0.53);
    expect(out[3]).toEqual({ start: out[2].end, end: 0.9, viseme: 'sil' });
    expect(tl[2].end).toBe(0.7);                            // the input is not changed
    // contiguous, no overlaps
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end, 9);
  });
});
