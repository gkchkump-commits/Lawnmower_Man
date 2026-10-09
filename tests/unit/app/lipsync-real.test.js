// The local-voice lip-sync on REAL speech: a Kokoro clip (tests/fixtures/kokoro, the voice
// server's /tts output for "Maybe we should move the meeting to Friday? I think five people can
// make it then.") played through the real LipSync and Director at 60 Hz. Guards the timing that
// was measured and tuned on real clips (docs/RENDERER.md, Lip-sync): the lips close on m / b / p
// at the sound's level dip, slightly ahead of it, never after; the jaw follows the syllables;
// the audio prosody finds the question's rise and the statement's fall.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
import { LipSync } from '../../../src/audio/lipsync.js';
import { bytesToBase64, decodeWav } from '../../../src/audio/wav.js';
import { Director } from '../../../src/avatar/director.js';
import { rigUniforms } from '../../../src/avatar/heads/relief/rig.js';

const dir = fileURLToPath(new URL('../../fixtures/kokoro/', import.meta.url));
const meta = JSON.parse(readFileSync(`${dir}maybe_af_heart.json`, 'utf8'));
const bytes = readFileSync(`${dir}maybe_af_heart.wav`);
const wav = decodeWav(new Uint8Array(bytes));

/** Play the clip (as the app's clip: base64 WAV + visemes) and record the director's output. */
function play() {
  const clip = { kind: 'audio', audioB64: bytesToBase64(new Uint8Array(bytes)), visemes: meta.visemes, text: meta.text };
  const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, level: () => 0.05, spectrum: () => false });
  let now = 0;
  const ls = new LipSync({ player, now: () => now });
  const dr = new Director({ seed: 1, idleMotion: 0 });
  dr.setState('speaking');
  const rec = [], cues = [];
  const dt = 1 / 60;
  for (let f = 0; f * dt < wav.durationSec + 0.6; f++) {
    now = f * dt;
    player.current = now < wav.durationSec ? { clip, kind: 'audio', time: now } : null;
    const m = ls.update(dt, now);
    if (m.cues) cues.push(...m.cues);
    dr.setMouth(m);
    dr.setSpeechLevel(m.level);
    if (m.cues) dr.setProsody(m.cues);
    dr.setIntonation(m.intonation);
    const a = dr.update(dt, now);
    rec.push({ t: now, jaw: a.jawOpen, press: a.mouthPress, chin: a.chinRaise, pitch: m.intonation.pitch, ap: aperturePx(a) });
  }
  return { rec, cues, ls };
}

// the reference pack's relief rig (plate 1168 px tall, face 652 px): the lip opening at the mouth's
// centre in plate px
const RIG = { faceH: 651.945 / 1168, mouthHalfW: 100.261 / 1168, px: 1 / 1168, plateW: 784 / 1168, lidTravel: 0,
  eyes: { L: { height: 0.02, irisR: 0.02 }, R: { height: 0.02, irisR: 0.02 } } };
const U = {};
/** @param {any} a */
function aperturePx(a) {
  rigUniforms(RIG, a, U);
  return (Math.max(0, U.upperLift) + Math.max(0, U.jawDrop + U.lowerDrop)) / RIG.px;
}

/** dB level of the clip in 20 ms windows, every 5 ms (0 dB = its loudest). */
function levels() {
  const x = wav.samples, sr = wav.sampleRate, h = Math.round(sr * 0.005), n = Math.round(sr * 0.02);
  const out = [];
  for (let i = 0; i * h < x.length; i++) {
    let acc = 0, c = 0;
    for (let j = i * h - (n >> 1); j < i * h + (n >> 1); j++) if (j >= 0 && j < x.length) { acc += x[j] * x[j]; c++; }
    out.push(10 * Math.log10(acc / Math.max(1, c) + 1e-12));
  }
  const peak = Math.max(...out);
  return out.map((v) => v - peak);
}

describe('lip-sync on a real Kokoro clip', () => {
  const { rec, cues, ls } = play();
  const db = levels();
  const VOW = new Set(['aa', 'E', 'I', 'O', 'U', 'RR']);
  const tl = meta.visemes;

  it('closes the lips on every m / b / p between vowels at the sound\'s dip, a little ahead of it', () => {
    const offsets = [];
    for (let i = 1; i + 1 < tl.length; i++) {
      const s = tl[i];
      if (s.viseme !== 'PP' || !VOW.has(tl[i - 1].viseme) || !VOW.has(tl[i + 1].viseme)) continue;
      // the level dip of this closure (the quietest moment near the segment)
      let ta = NaN, lo = Infinity;
      for (let k = Math.round((s.start - 0.05) / 0.005); k <= Math.round((s.end + 0.05) / 0.005); k++) if (db[k] < lo) { lo = db[k]; ta = k * 0.005; }
      // the rendered mouth's fullest closure near it
      let tm = NaN, best = -Infinity;
      for (const q of rec) if (Math.abs(q.t - ta) <= 0.12 && q.press - q.jaw > best) { best = q.press - q.jaw; tm = q.t; }
      expect(best, `closure at ${s.start}`).toBeGreaterThan(0.6);   // really closed
      offsets.push(tm - ta);
    }
    expect(offsets.length).toBeGreaterThanOrEqual(3);
    const sorted = [...offsets].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    // the mouth leads by a few tens of ms (the display adds its own frame or two); never late
    expect(median).toBeLessThan(0.005);
    expect(median).toBeGreaterThan(-0.07);
    for (const o of offsets) expect(o).toBeLessThan(0.03);
  });

  it('the relief lips stay sealed through each m / b / p for at least 50 ms; the chin moves with them', () => {
    let n = 0;
    for (let i = 1; i + 1 < tl.length; i++) {
      const s = tl[i];
      if (s.viseme !== 'PP' || tl[i - 1].viseme === 'sil' || tl[i + 1].viseme === 'sil' || s.start < 0.08) continue;
      // the longest run of frames near the segment where the lip opening is under 1 plate px
      let run = 0, best = 0;
      for (const q of rec) {
        if (q.t < s.start - 0.1 || q.t > s.end + 0.1) continue;
        run = q.ap < 1 ? run + 1 : 0;
        best = Math.max(best, run);
      }
      expect(best, `closure at ${s.start}`).toBeGreaterThanOrEqual(3);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(4);
    // the mentalis follows the press closely (it used to trail the lips by ~70 ms and was still
    // rising when they reopened)
    const z = (k) => {
      const x = rec.map((q) => q[k]);
      const m = x.reduce((a, b) => a + b, 0) / x.length;
      const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length);
      return x.map((v) => (v - m) / sd);
    };
    const zp = z('press'), zc = z('chin');
    let lag = 0, r = -1;
    for (let L = 0; L < 12; L++) {
      let c = 0;
      for (let k = L; k < zc.length; k++) c += zc[k] * zp[k - L];
      c /= zc.length - L;
      if (c > r) { r = c; lag = L; }
    }
    expect(r).toBeGreaterThan(0.7);
    expect(lag / 60).toBeLessThanOrEqual(0.05);
  });

  it('the jaw opens with the syllables and rests in the silence after the voice', () => {
    const max = Math.max(...rec.map((q) => q.jaw));
    expect(max).toBeGreaterThan(0.5);
    const tail = rec.filter((q) => q.t > wav.durationSec - 0.05);
    expect(Math.max(...tail.map((q) => q.jaw))).toBeLessThan(0.05);
    // stressed syllables open wider than unstressed ones: a wide spread of vowel peaks
    const peaks = [];
    for (const s of tl) {
      if (!['aa', 'E', 'O'].includes(s.viseme)) continue;
      peaks.push(Math.max(...rec.filter((q) => q.t >= s.start && q.t <= s.end + 0.05).map((q) => q.jaw)));
    }
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeGreaterThan(1.6);
  });

  it('hears the question rise and the statement fall, accents, and breathes before each sentence', () => {
    const ends = cues.filter((c) => c.type === 'phrase-end');
    expect(ends.map((c) => c.punct)).toEqual(['?', '.']);
    expect(ends[0].rise).toBeGreaterThan(2);                 // "Friday?" goes up...
    expect(ends[0].rise).toBeGreaterThan(ends[1].rise + 1);   // ...far more than "then." does
    const accents = cues.filter((c) => c.type === 'accent').length;
    expect(accents).toBeGreaterThanOrEqual(3);
    expect(accents).toBeLessThanOrEqual(9);
    expect(cues.filter((c) => c.type === 'inhale').length).toBe(2);
    // the speaker's pitch is learned (af_heart speaks around 195 Hz), the intonation centred on it
    expect(ls.f0Ref).toBeGreaterThan(170);
    expect(ls.f0Ref).toBeLessThan(230);
    const voiced = rec.filter((q) => q.pitch !== 0).map((q) => q.pitch).sort((a, b) => a - b);
    expect(Math.abs(voiced[voiced.length >> 1])).toBeLessThan(1.5);
  });
});
