import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_BANDS, BOUNDARY_LEAD, CHANNELS, LIP_CLOSE_EARLY, LipSync, SpeechTrack, VISEME_SHAPES, countSyllables, cuesFromVisemes, mixShapes,
  mouthFromAudio, mouthFromVisemes, normalizeVisemes, planSpeech, visemeIndexAt, visemeShape,
} from '../../../src/audio/lipsync.js';
import { LEAD_IN, REST } from '../../../src/audio/articulation.js';
import { AudioPlayer } from '../../../src/audio/player.js';
import { WebSpeechTTS } from '../../../src/speech/web-speech.js';
import { Emitter } from '../../../src/app/emitter.js';

const TL = [
  { start: 0, end: 0.1, viseme: 'sil' },
  { start: 0.1, end: 0.3, viseme: 'aa' },
  { start: 0.3, end: 0.36, viseme: 'PP' },
  { start: 0.36, end: 0.6, viseme: 'O' },
  { start: 0.6, end: 0.8, viseme: 'sil' },
];
const OPTS = { lead: 0 };

describe('viseme table', () => {
  it('covers all contract viseme ids with values in 0..1', () => {
    for (const id of ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'RR', 'aa', 'E', 'I', 'O', 'U']) {
      const s = visemeShape(id);
      for (const k of CHANNELS) {
        expect(s[k]).toBeGreaterThanOrEqual(0);
        expect(s[k]).toBeLessThanOrEqual(1);
      }
    }
    expect(visemeShape('nope')).toEqual(VISEME_SHAPES.sil);
    expect(VISEME_SHAPES.aa.jaw).toBeGreaterThan(VISEME_SHAPES.I.jaw);
    expect(VISEME_SHAPES.U.round).toBeGreaterThan(0.8);
    expect(VISEME_SHAPES.I.wide).toBeGreaterThan(0.6);
    expect(VISEME_SHAPES.PP.jaw).toBe(0);
    expect(mixShapes(VISEME_SHAPES.sil, VISEME_SHAPES.PP, 0.5).press).toBeCloseTo(0.5, 9);
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

  it('is (close to) the viseme\'s own shape in the middle of a segment', () => {
    // (behaviour change: neighbours now blend by dominance, so a target is approached, not copied)
    const mid = mouthFromVisemes(TL, 0.2, OPTS);
    for (const k of ['wide', 'round', 'press', 'tuck', 'tongue']) expect(mid[k]).toBeCloseTo(VISEME_SHAPES.aa[k], 1);
    expect(mid.jaw).toBeGreaterThan(0.6);
    const o = mouthFromVisemes(TL, 0.48, OPTS);
    expect(o.round).toBeGreaterThan(0.6);
    expect(o.jaw).toBeGreaterThan(0.4);
  });

  it('cross-fades smoothly at a boundary (coarticulation)', () => {
    const m = mouthFromVisemes(TL, 0.1 + 1e-9, OPTS);
    expect(m.jaw).toBeGreaterThan(0.05);
    expect(m.jaw).toBeLessThan(VISEME_SHAPES.aa.jaw);
    const before = mouthFromVisemes(TL, 0.0999, OPTS);
    expect(before.jaw).toBeCloseTo(m.jaw, 2); // continuous across the boundary
  });

  it('keeps a bilabial closure visible', () => {
    const mid = mouthFromVisemes(TL, 0.33, OPTS);
    expect(mid.jaw).toBeLessThan(0.06);
    expect(mid.press).toBeGreaterThan(0.8);
  });

  it('shows a closure passed between two frames', () => {
    // frames at 0.31 and 0.345 straddle the PP centre (0.33): the second shows the closure
    expect(mouthFromVisemes(TL, 0.345, { ...OPTS, prevT: 0.31 }).press).toBeGreaterThan(0.9);
  });

  it('the lips start closing sooner than they part (LIP_CLOSE_EARLY); the rest keeps its time', () => {
    const at = (t, closeEarly) => mouthFromVisemes(TL, t, { ...OPTS, closeEarly });
    // before the closure: the press is already rising, as it would LIP_CLOSE_EARLY later
    expect(at(0.26).press).toBeCloseTo(at(0.26 + LIP_CLOSE_EARLY, 0).press, 9);
    expect(at(0.26).press).toBeGreaterThan(at(0.26, 0).press + 0.05);
    // after it: the release is where it was
    expect(at(0.39).press).toBeCloseTo(at(0.39, 0).press, 9);
    // the jaw, spread and rounding are not moved
    for (const k of ['jaw', 'wide', 'round']) expect(at(0.26)[k]).toBe(at(0.26, 0)[k]);
    expect(LIP_CLOSE_EARLY).toBeGreaterThan(0.015);
    expect(LIP_CLOSE_EARLY).toBeLessThan(0.05);
  });

  it('the mouth leads the audio', () => {
    // at t=0.07 with a 40 ms lead we already see the opening of "aa"
    expect(mouthFromVisemes(TL, 0.07, { lead: 0.04 }).jaw).toBeGreaterThan(mouthFromVisemes(TL, 0.07, OPTS).jaw);
  });

  it('closes after the end and before the start', () => {
    expect(mouthFromVisemes(TL, 2, OPTS)).toEqual(VISEME_SHAPES.sil);
    expect(mouthFromVisemes([{ start: 0.5, end: 0.7, viseme: 'aa' }], 0, OPTS).jaw).toBeLessThan(0.01);
    expect(mouthFromVisemes([], 0.2)).toEqual(VISEME_SHAPES.sil);
  });

  it('normalizeVisemes drops malformed entries and sorts', () => {
    expect(normalizeVisemes(null)).toBeNull();
    expect(normalizeVisemes([{ start: 0.2, end: 0.1, viseme: 'aa' }, 'x'])).toBeNull();
    expect(normalizeVisemes([{ start: 0.2, end: 0.3, viseme: 'O' }, { start: 0, end: 0.2, viseme: 'aa' }]).map((s) => s.viseme)).toEqual(['aa', 'O']);
  });

  it('derives prosody cues from a server timeline and its text', () => {
    const tl = [
      { start: 0, end: 0.05, viseme: 'kk' }, { start: 0.05, end: 0.25, viseme: 'O' }, { start: 0.25, end: 0.5, viseme: 'sil' },
      { start: 0.5, end: 0.55, viseme: 'DD' }, { start: 0.55, end: 0.62, viseme: 'E' }, { start: 0.62, end: 0.7, viseme: 'SS' },
    ];
    const cues = cuesFromVisemes(tl, 'Hello! Yes?');
    expect(cues.filter((c) => c.type === 'phrase-start').map((c) => c.t)).toEqual([0, 0.5]);
    expect(cues.filter((c) => c.type === 'phrase-end').map((c) => c.punct)).toEqual(['!', '?']);
    expect(cues.filter((c) => c.type === 'accent').map((c) => c.t)).toEqual([0.05]);
    expect(cuesFromVisemes([], 'x')).toEqual([]);
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

  it('dark spectrum → round, bright spectrum → wide, quiet hiss → teeth', () => {
    const dark = mouthFromAudio(0.2, [1, 0.1, 0.02]);
    const bright = mouthFromAudio(0.2, [0.2, 0.5, 1]);
    expect(dark.round).toBeGreaterThan(0.5);
    expect(dark.wide).toBeLessThan(0.2);
    expect(bright.wide).toBeGreaterThan(0.5);
    expect(bright.round).toBe(0);
    const hiss = mouthFromAudio(0.012, [0.05, 0.2, 1]);
    expect(hiss.teeth).toBeGreaterThan(hiss.jaw);
    expect(AUDIO_BANDS).toHaveLength(3);
    for (const k of CHANNELS) expect(Number.isFinite(dark[k])).toBe(true);
  });
});

describe('countSyllables', () => {
  it('counts syllables roughly', () => {
    expect(countSyllables('hello')).toBe(2);
    expect(countSyllables('time')).toBe(1);
    expect(countSyllables('hologram')).toBe(3);
    expect(countSyllables('table')).toBe(2);
    expect(countSyllables('a')).toBe(1);
    expect(countSyllables('')).toBe(0);
    expect(countSyllables('42')).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// System voice driver
// ---------------------------------------------------------------------------------------------
const SENTENCE = "Hello! I'm Claude. How are you feeling today?";

/** Run a SpeechTrack at 60 fps from t0 to t1 (s), calling at(t) each frame. */
function runTrack(tr, t0, t1, each = () => {}) {
  for (let t = t0; t < t1; t += 1 / 60) {
    tr.update(1 / 60, t);
    each(t);
  }
}

describe('SpeechTrack (Web Speech timing)', () => {
  const plan = planSpeech(SENTENCE);
  const words = plan.words;

  it('rests until the voice starts, then plays the plan at its speed without boundaries', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    runTrack(tr, 0, 0.3);
    expect(tr.mode).toBe('waiting');
    expect(tr.p).toBe(0);
    tr.begin(0.3);
    runTrack(tr, 0.3, 1.3);
    expect(tr.mode).toBe('free');
    // after ~1 s of speech we are ~1 s into the plan (after the lead-in), the same mouth as the plan
    expect(tr.p).toBeGreaterThan(LEAD_IN + 0.9);
    expect(tr.p).toBeLessThan(LEAD_IN + 1.1);
    const s = tr.sample();
    expect(s.every(Number.isFinite)).toBe(true);
    runTrack(tr, 1.3, 6);
    expect(tr.finished).toBe(true);
    expect(tr.sample()).toEqual(new Array(CHANNELS.length).fill(0));
  });

  it('a voice that never reports its start still gets a mouth after a moment', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    runTrack(tr, 0, 1);
    expect(tr.mode).toBe('free');
    expect(tr.p).toBeGreaterThan(LEAD_IN);
  });

  it('anchors each word at its boundary and waits for the next one (no running ahead)', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0);
    tr.boundary(0, { charIndex: words[0].start });
    expect(tr.mode).toBe('boundary');
    // a slow voice: the next boundary comes 1.5 s later; meanwhile we hold before "I'm"
    runTrack(tr, 0, 1.0);
    expect(tr.p).toBeLessThan(words[1].t0);
    expect(tr.p).toBeGreaterThan(words[0].t1);
    // ...resting the mouth in the pause after "Hello!"
    const m = tr.sample();
    expect(m[0]).toBeLessThan(0.05);
    tr.boundary(1.0, { charIndex: words[1].start });
    runTrack(tr, 1.0, 1.08);
    expect(tr.p).toBeGreaterThan(words[1].t0);
  });

  it('compresses the rest of a word when the next boundary arrives early', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0);
    tr.boundary(0, { charIndex: words[3].start }); // "How"
    runTrack(tr, 0, 0.06);
    const p0 = tr.p;
    // "are" arrives long before "How" is over in the plan
    tr.boundary(0.06, { charIndex: words[4].start });
    let caught = NaN;
    runTrack(tr, 0.06, 0.4, (t) => { if (!Number.isFinite(caught) && tr.p >= words[4].t0) caught = t; });
    expect(p0).toBeLessThan(words[3].t1);
    expect(caught - 0.06).toBeLessThan(0.1);  // caught up within ~100 ms, not a whole word later
  });

  it('never runs plan time backwards and gives up waiting for a skipped boundary', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0);
    tr.boundary(0, { charIndex: words[3].start });   // "How"
    let last = -1, back = false;
    // "are", "you" never arrive; "feeling" comes 1.2 s later
    runTrack(tr, 0, 1.2, () => { if (tr.p < last) back = true; last = tr.p; });
    expect(tr.p).toBeGreaterThan(words[4].t0);   // did not wait forever before "are"
    tr.boundary(1.2, { word: 'feeling', charIndex: words[6].start });
    runTrack(tr, 1.2, 1.5, () => { if (tr.p < last) back = true; last = tr.p; });
    expect(back).toBe(false);
    expect(tr.p).toBeGreaterThan(words[6].t0);
  });

  it('maps boundaries without charIndex by word order and ignores repeats', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    expect(tr.wordIndex({ word: 'Hello' })).toBe(0);
    tr.boundary(0, { word: 'Hello' });
    expect(tr.wordIndex({ word: "I'm" })).toBe(1);
    tr.boundary(0.4, { word: "I'm" });
    tr.boundary(0.45, { word: "I'm", charIndex: words[1].start }); // repeated: same word
    expect(tr.confirmed).toBe(1);
    expect(tr.wordIndex({ charIndex: 9999 })).toBe(words.length - 1);
    expect(tr.wordIndex({ charIndex: words[2].start - 1 })).toBe(2); // the space before "Claude"
  });

  it('learns how fast the voice speaks from consecutive boundaries', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0);
    // "How are you feeling" at twice the plan's tempo
    const base = words[3].t0;
    for (const k of [3, 4, 5, 6]) tr.boundary((words[k].t0 - base) / 2, { charIndex: words[k].start });
    expect(tr.speedSamples.length).toBe(3);
    for (const s of tr.speedSamples) expect(s).toBeCloseTo(2, 1);
  });

  it('emits the plan\'s prosody cues as it passes them', () => {
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0);
    const got = [];
    runTrack(tr, 0, plan.duration + 0.5, () => { const c = tr.takeCues(); if (c) got.push(...c); });
    expect(got.map((c) => c.type)).toEqual(plan.cues.map((c) => c.type));
    expect(tr.takeCues()).toBeNull();
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

  it('uses visemes when the clip has them, with every mouth channel', () => {
    // (mid-"aa", clear of the PP's anticipation even with the visual lead)
    const ls = new LipSync({ player: player({ kind: 'audio', time: 0.17, clip: { visemes: TL } }), now: () => 0 });
    let m;
    for (let i = 0; i < 30; i++) m = ls.update(1 / 60, i / 60);
    expect(m.source).toBe('visemes');
    expect(m.jaw).toBeGreaterThan(0.5);
    expect(m.level).toBeGreaterThan(0.3);
    for (const k of CHANNELS) expect(Number.isFinite(m[k])).toBe(true);
  });

  it('a server clip\'s closure comes through, scaled by loudness elsewhere', () => {
    const p = player({ kind: 'audio', time: 0, clip: { visemes: TL, text: 'Ah, oh.' } }, 0.2);
    const ls = new LipSync({ player: p, now: () => 0 });
    let minJaw = 1, maxPress = 0;
    for (let t = 0; t < 0.6; t += 1 / 60) {
      p.current.time = t;
      const m = ls.update(1 / 60, t);
      if (t > 0.25 && t < 0.33) { minJaw = Math.min(minJaw, m.jaw); maxPress = Math.max(maxPress, m.press); }
    }
    expect(maxPress).toBeGreaterThan(0.8);
    expect(minJaw).toBeLessThan(0.06);
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

  it('drives the system-voice timeline from player speech events', () => {
    let now = 0;
    const p = player(null);
    const ls = new LipSync({ player: p, now: () => now });
    const clip = { kind: 'speech', text: SENTENCE, rate: 1 };
    p.current = { kind: 'speech', time: 0, clip };
    p.emit('start', clip);
    expect(ls.track).not.toBeNull();
    p.emit('speechstart', clip);
    p.emit('boundary', { word: 'Hello', charIndex: 0, clip });
    let m;
    const cues = [];
    for (let i = 0; i < 20; i++) { now += 1 / 60; m = ls.update(1 / 60, now); if (m.cues) cues.push(...m.cues); }
    expect(m.source).toBe('speech');
    expect(m.jaw).toBeGreaterThan(0.1);
    expect(cues.some((c) => c.type === 'phrase-start')).toBe(true);
    p.emit('end', clip, { stopped: false });
    expect(ls.track).toBeNull();
    ls.dispose();
  });

  it('ignores boundaries of another clip and learns the voice tempo across utterances', () => {
    let now = 0;
    const p = player(null);
    const ls = new LipSync({ player: p, now: () => now });
    const clip = { kind: 'speech', text: 'how are you feeling today my friend', rate: 1 };
    const plan = planSpeech(clip.text);
    p.current = { kind: 'speech', time: 0, clip };
    p.emit('start', clip);
    p.emit('speechstart', clip);
    p.emit('boundary', { word: 'x', charIndex: 0, clip: { other: true } });
    expect(ls.track.boundaries).toBe(0);
    // the voice speaks at 0.8x the plan's tempo
    for (const [k, w] of plan.words.entries()) {
      while (now < (w.t0 - plan.words[0].t0) / 0.8) { now += 1 / 60; ls.update(1 / 60, now); }
      p.emit('boundary', { word: w.text, charIndex: w.start, clip });
      expect(ls.track.confirmed).toBe(k);
    }
    expect(ls.speedFactor(1)).toBeLessThan(0.92);
    expect(ls.speedFactor(1)).toBeGreaterThan(0.7);
    expect(ls.speedFactor(1.5)).toBe(1); // per utterance rate
  });
});

describe('sync with a voice at its own tempo', () => {
  /** Speak `text` with a scripted voice (word onsets at `tempo` × the plan, ±jitter per word) and
   * return |plan position the mouth shows − where the voice is| per frame (s, plan time). */
  function speak(ls, text, tempo, bounds, seed) {
    const plan = planSpeech(text);
    const w = plan.words;
    const on = [];
    let tv = 0;
    w.forEach((x, k) => {
      on.push(tv);
      const span = (k + 1 < w.length ? w[k + 1].t0 : x.t1) - x.t0;
      tv += span * tempo * (1 + 0.15 * Math.sin(k * 2.3 + seed));
    });
    const voiceAt = (x) => {
      for (let k = w.length - 1; k >= 0; k--) {
        if (x >= on[k]) {
          const nOn = k + 1 < w.length ? on[k + 1] : tv;
          const nP = k + 1 < w.length ? w[k + 1].t0 : w[k].t1;
          return w[k].t0 + ((x - on[k]) / (nOn - on[k])) * (nP - w[k].t0);
        }
      }
      return null;
    };
    const p = ls.player;
    const clip = { kind: 'speech', text, rate: 1 };
    const t0 = ls._t;
    p.current = { kind: 'speech', clip, time: 0 };
    p.emit('start', clip);
    p.emit('speechstart', clip);
    const errs = [];
    let k = 0;
    for (let t = 0; t < tv; t += 1 / 60) {
      ls._t = t0 + t;
      while (bounds && k < w.length && on[k] <= t) { p.emit('boundary', { word: w[k].text, charIndex: w[k].start, clip }); k++; }
      ls.update(1 / 60, ls._t);
      if (t > 0.1) errs.push(Math.abs(ls.track.p - 0.035 - voiceAt(t)));
    }
    p.current = null;
    p.emit('end', clip, { stopped: false });
    ls._t += 0.5;
    errs.sort((a, b) => a - b);
    return { median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)] };
  }
  const make = () => {
    const player = Object.assign(new Emitter(), { current: null, level: () => 0, spectrum: () => false, sampleRate: 48000 });
    const ls = new LipSync({ player, now: () => ls._t });
    ls._t = 0;
    return ls;
  };
  const TEXT = 'I can help you write code, answer questions about your files, or just talk about your day.';

  for (const tempo of [0.8, 1.25]) {
    it(`with word boundaries: within a few tens of ms (voice at ${tempo}x the plan's length)`, () => {
      const ls = make();
      speak(ls, SENTENCE, tempo, true, 1);           // the first utterance teaches the tempo
      const r = speak(ls, TEXT, tempo, true, 2);
      expect(r.median).toBeLessThan(0.04);
      expect(r.p90).toBeLessThan(0.09);
      expect(Math.abs(Math.log(ls.speedFactor(1) * tempo))).toBeLessThan(0.1); // learned within 10 %
    });
  }

  it('without boundaries: the learned tempo brings later utterances into step', () => {
    const ls = make();
    const first = speak(ls, TEXT, 1.25, false, 3);
    speak(ls, TEXT, 1.25, false, 4);
    speak(ls, TEXT, 1.25, false, 5);
    const later = speak(ls, TEXT, 1.25, false, 6);
    expect(later.median).toBeLessThan(first.median / 2);
  });
});

describe('a voice that starts late (after the 0.6 s fallback)', () => {
  const TEXT = 'I can help you write code, answer questions about your files, or just talk about your day.';

  it('its real onstart re-anchors the guessed start: the mouth follows the voice, not the guess', () => {
    const tr = new SpeechTrack(planSpeech(TEXT), { speed: 1, now: 0 });
    runTrack(tr, 0, 1.5);
    expect(tr.mode).toBe('free'); // the fallback guessed at 0.6 s
    expect(tr.p).toBeGreaterThan(LEAD_IN + 0.5);
    tr.begin(1.5); // the voice really starts now
    runTrack(tr, 1.5, 2.0);
    expect(Math.abs(tr.p - (LEAD_IN + 0.035 + 0.5))).toBeLessThan(0.06);
    // a second onstart, or one on time, changes nothing
    const p = tr.p;
    tr.begin(2.0);
    expect(tr.p).toBe(p);
  });

  it('its first boundary pulls a guessed run back to that word, without a long freeze', () => {
    const plan = planSpeech(TEXT);
    const w = plan.words;
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    runTrack(tr, 0, 1.5);
    // the voice starts at 1.5 s (no onstart) and reports every word at the plan's tempo
    const onsets = w.map((x, k) => ({ t: 1.5 + x.t0 - w[0].t0, ci: x.start, k }));
    tr.boundary(onsets[0].t, { charIndex: onsets[0].ci });
    tr.update(1 / 60, 1.5 + 1 / 60);
    expect(Math.abs(tr.p - (w[0].t0 + BOUNDARY_LEAD))).toBeLessThan(0.03);
    let next = 1;
    let frozen = 0;
    let longest = 0;
    runTrack(tr, 1.5 + 2 / 60, 3.5, (t) => {
      for (; next < onsets.length && onsets[next].t <= t; next++) tr.boundary(onsets[next].t, { charIndex: onsets[next].ci });
      const vp = w[0].t0 + (t - 1.5); // where the voice is in the plan
      const talking = w.some((x) => vp >= x.t0 && vp < x.t1);
      frozen = talking && tr.p === tr.pPrev ? frozen + 1 : 0;
      longest = Math.max(longest, frozen);
    });
    expect(longest).toBeLessThanOrEqual(6); // the guess had run ahead: it froze while the voice talked
  });

  it('no tempo is learned from a start that was only guessed', () => {
    const player = Object.assign(new Emitter(), { current: null, level: () => 0, spectrum: () => false, sampleRate: 48000 });
    let t = 0;
    const ls = new LipSync({ player, now: () => t });
    const clip = { kind: 'speech', text: TEXT, rate: 1 };
    player.current = { kind: 'speech', clip, time: 0 };
    player.emit('start', clip);
    for (; t < 3; t += 1 / 60) ls.update(1 / 60, t); // never an onstart, never a boundary
    player.current = null;
    player.emit('end', clip, { stopped: false });
    expect(ls.speedFactor(1)).toBe(1);
  });
});

describe('a file name in a sentence', () => {
  it('the mouth keeps moving through "package dot json" (one boundary per space-separated token)', () => {
    const text = 'Open package.json and add a start script.';
    const voice = planSpeech('Open package dot json and add a start script.').words; // what the voice says
    const plan = planSpeech(text);
    // the voice reports a boundary per whitespace token: "Open", "package.json", "and", …
    const tokens = [...text.matchAll(/\S+/g)].map((m) => m.index);
    const spokenIndex = [0, 1, 4, 5, 6, 7, 8];
    const onsets = tokens.map((ci, i) => ({ t: 0.05 + voice[spokenIndex[i]].t0 - LEAD_IN, ci }));
    const tr = new SpeechTrack(plan, { speed: 1, now: 0 });
    tr.begin(0.05);
    let k = 0;
    let run = 0;
    let longest = 0;
    for (let f = 1; f < 60 * 4; f++) {
      const t = f / 60;
      for (; k < onsets.length && onsets[k].t <= t; k++) tr.boundary(onsets[k].t, { charIndex: onsets[k].ci });
      tr.update(1 / 60, t);
      const [jaw, , , press, tuck] = tr.sample();
      const vp = LEAD_IN + (t - 0.05);
      const talking = voice.some((w) => vp >= w.t0 && vp < w.t1);
      run = talking && jaw < 0.03 && press < 0.2 && tuck < 0.2 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest / 60).toBeLessThan(0.1); // was 0.65 s: a planned sentence pause inside the name
  });
});

describe('Web Speech → player → lip-sync (fake timers)', () => {
  afterEach(() => vi.useRealTimers());

  /** A fake speechSynthesis that "speaks" with setTimeout: onstart after `latency`, a word
   * boundary per word at `wordGap` s intervals (unless boundaries are off), onend after the last. */
  function fakeSynth({ latency = 0.05, wordGap = 0.3, boundaries = true } = {}) {
    return {
      paused: false,
      getVoices: () => [{ name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true }],
      addEventListener() {},
      cancel() {},
      speak(u) {
        const text = u.text;
        const re = /\S+/g;
        const starts = [];
        let m;
        while ((m = re.exec(text))) starts.push(m.index);
        setTimeout(() => u.onstart?.(), latency * 1000);
        if (boundaries) {
          starts.forEach((ci, i) => setTimeout(() => u.onboundary?.({ name: 'word', charIndex: ci, charLength: 0 }), (latency + i * wordGap) * 1000));
        }
        setTimeout(() => u.onend?.(), (latency + starts.length * wordGap) * 1000);
      },
    };
  }
  class U { constructor(text) { this.text = text; } }

  async function speakAndWatch(synthOpts, text) {
    vi.useFakeTimers();
    const tts = new WebSpeechTTS({ synth: /** @type {any} */ (fakeSynth(synthOpts)), Utterance: /** @type {any} */ (U) });
    await tts.init();
    const now = () => Date.now() / 1000;
    const player = new AudioPlayer({ createContext: () => { throw new Error('no audio'); }, speech: tts, now });
    const ls = new LipSync({ player, now });
    const t0 = now();
    const done = player.enqueue({ kind: 'speech', text, rate: 1 });
    const frames = [];
    let after = 0;
    for (let i = 0; i < 400 && after < 20; i++) {
      await vi.advanceTimersByTimeAsync(16);
      const m = ls.update(0.016, now());
      frames.push({ t: now() - t0, ...m });
      if (!player.current && i > 5) after++;   // a few frames after the voice ended
    }
    await done;
    return { frames, ls };
  }

  it('boundary-driven: the m of "I\'m" closes right after its word starts', async () => {
    const text = "Hello! I'm Claude.";
    const { frames } = await speakAndWatch({ latency: 0.05, wordGap: 0.45 }, text);
    // "I'm" starts at 0.05 + 0.45 = 0.5 s: its closure comes within ~0.25 s
    const im = frames.filter((f) => f.t > 0.5 && f.t < 0.8);
    expect(Math.max(...im.map((f) => f.press))).toBeGreaterThan(0.8);
    // before the voice starts the mouth rests; during speech it moves; it closes at the end
    expect(frames.filter((f) => f.t < 0.04).every((f) => f.jaw < 0.02)).toBe(true);
    expect(Math.max(...frames.map((f) => f.jaw))).toBeGreaterThan(0.3);
    expect(frames.at(-1).jaw).toBeLessThan(0.05);
    expect(frames.some((f) => f.source === 'speech')).toBe(true);
  });

  it('boundary-less: the whole utterance plays from the words (no random vowels)', async () => {
    const text = "Hello! I'm Claude.";
    const a = await speakAndWatch({ latency: 0.05, wordGap: 0.6, boundaries: false }, text);
    const b = await speakAndWatch({ latency: 0.05, wordGap: 0.6, boundaries: false }, text);
    // deterministic: the same text gives the same mouth
    expect(a.frames.map((f) => f.jaw.toFixed(4))).toEqual(b.frames.map((f) => f.jaw.toFixed(4)));
    // and it is this text's mouth: the planned closure of "I'm" shows up at the planned time
    const plan = planSpeech(text);
    const mSeg = plan.segs.find((s) => s.ph === 'M');
    const tM = 0.05 + (mSeg.start + mSeg.end) / 2 - LEAD_IN;
    const near = a.frames.filter((f) => Math.abs(f.t - tM) < 0.08);
    expect(Math.max(...near.map((f) => f.press))).toBeGreaterThan(0.8);
    // the voice took longer than the plan: the next utterance plays slower
    expect(a.ls.speedFactor(1)).toBeLessThan(1);
  });
});

describe('rest output', () => {
  it('is all zeros', () => {
    for (const k of CHANNELS) expect(REST[k]).toBe(0);
  });
});
