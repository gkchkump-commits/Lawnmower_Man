// Acoustic articulation (src/audio/acoustics.js): formants, loudness bands and voicing measured on
// synthetic voices with known answers, and the worker client's synchronous fallback.
import { describe, expect, it } from 'vitest';
import { AC_HOP, AcousticAnalysis, analyseAcoustics, polyRoots, trackAt, trackFrame } from '../../../src/audio/acoustics.js';
import { AcousticsClient } from '../../../src/audio/acoustics-client.js';
import { bytesToBase64, encodeWav } from '../../../src/audio/wav.js';

const SR = 24000;

/**
 * A synthetic vowel: a glottal pulse train (f0) through a cascade of formant resonators.
 * @param {number[]} formants Hz @param {number} dur s @param {{ f0?: number, amp?: number, bw?: number[] }} [o]
 */
function vowel(formants, dur, o = {}) {
  const f0 = o.f0 ?? 120, n = Math.round(dur * SR);
  let x = new Float64Array(n);
  for (let i = 0, next = 0; i < n; i++) if (i >= next) { x[i] = 1; next += SR / f0; }
  formants.forEach((f, k) => {
    const bw = (o.bw || [80, 100, 130])[k] ?? 150;
    const r = Math.exp((-Math.PI * bw) / SR), th = (2 * Math.PI * f) / SR;
    const a1 = -2 * r * Math.cos(th), a2 = r * r, g = 1 + a1 + a2;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = g * x[i] - a1 * (y[i - 1] || 0) - a2 * (y[i - 2] || 0);
    x = y;
  });
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return Float32Array.from(x, (v) => (v / peak) * (o.amp ?? 0.3));
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
/** Median of a track array over the voiced frames in [t0, t1] (non-zero values only). */
function med(tr, arr, t0, t1) {
  const v = [];
  for (let i = trackFrame(tr, t0); i <= trackFrame(tr, t1); i++) if (arr[i] > 0) v.push(arr[i]);
  return v.length ? median(v) : 0;
}

describe('acoustic analysis', () => {
  it('finds the formants of an open and a close vowel (F1 high for "ah", low for "ee")', () => {
    // (a low F1 next to a harmonic of the voice is pulled toward it: LPC's classic bias, up to
    // ~20 % for an "ee" at 120 Hz; the lip-sync normalises F1 per speaker, so a bias is harmless)
    const f1s = [];
    for (const [F, tol, tol1] of [[[750, 1250, 2600], 0.07, 0.07], [[300, 2250, 3000], 0.08, 0.2], [[450, 900, 2500], 0.08, 0.1]]) {
      const tr = analyseAcoustics(vowel(F, 0.5), SR);
      f1s.push(med(tr, tr.f1, 0.1, 0.4));
      expect(med(tr, tr.f1, 0.1, 0.4) / F[0], `F1 of ${F}`).toBeGreaterThan(1 - tol1);
      expect(med(tr, tr.f1, 0.1, 0.4) / F[0], `F1 of ${F}`).toBeLessThan(1 + tol1);
      expect(Math.abs(med(tr, tr.f2, 0.1, 0.4) / F[1] - 1), `F2 of ${F}`).toBeLessThan(tol);
      expect(Math.abs(med(tr, tr.f3, 0.1, 0.4) / F[2] - 1), `F3 of ${F}`).toBeLessThan(tol);
      expect(median(Array.from(tr.voiced.subarray(trackFrame(tr, 0.1), trackFrame(tr, 0.4))))).toBeGreaterThan(0.7);
    }
    expect(f1s[1]).toBeLessThan(0.6 * f1s[0]);    // "ee" well below "ah"
  });

  it('tells voice from noise and silence, and the low band from the high band', () => {
    const n = Math.round(0.6 * SR);
    const x = new Float32Array(n);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (t < 0.2) x[i] = 0.2 * Math.sin(2 * Math.PI * 180 * t);          // a hum (all low band)
      else if (t < 0.4) x[i] = 0.05 * rnd();                                // hiss (white noise)
      // then silence
    }
    const tr = analyseAcoustics(x, SR);
    const at = (arr, t) => trackAt(tr, arr, t);
    expect(at(tr.voiced, 0.1)).toBeGreaterThan(0.8);
    expect(at(tr.voiced, 0.3)).toBeLessThan(0.4);
    expect(at(tr.voiced, 0.5)).toBe(0);
    // the hum: the low band carries it all (0.2 amplitude sine: -17 dBFS), the high band nothing
    expect(at(tr.e, 0.1)).toBeCloseTo(20 * Math.log10(0.2 / Math.SQRT2), 0);
    expect(at(tr.e, 0.1) - at(tr.lo, 0.1)).toBeLessThan(1.5);
    expect(at(tr.e, 0.1) - at(tr.hi, 0.1)).toBeGreaterThan(40);
    // the hiss: most of white noise lies above 3 kHz (at 24 kHz), little below 400 Hz
    expect(at(tr.e, 0.3) - at(tr.hi, 0.3)).toBeLessThan(2);
    expect(at(tr.e, 0.3) - at(tr.lo, 0.3)).toBeGreaterThan(10);
    // silence is the floor
    expect(at(tr.e, 0.55)).toBe(-80);
    expect(tr.f1[trackFrame(tr, 0.55)]).toBe(0);
  });

  it('is incremental: a few frames at a time gives exactly the whole analysis; partial tracks say how far they go', () => {
    const x = vowel([600, 1700, 2700], 0.4);
    const whole = analyseAcoustics(x, SR);
    const a = new AcousticAnalysis(x, SR);
    const part = (a.advance(30), a.toTrack(true));
    expect(part.done).toBe(30);
    expect(part.n).toBe(whole.n);
    while (!a.complete) a.advance(17);
    const t = a.toTrack();
    for (const k of ['e', 'lo', 'hi', 'f1', 'f2', 'f3', 'voiced']) expect(Array.from(t[k]), k).toEqual(Array.from(whole[k]));
    // (the partial copy was not changed by the rest of the analysis)
    expect(part.f1.subarray(30).every((v) => v === 0)).toBe(true);
    expect(t.hop).toBe(AC_HOP);
  });

  it('works at the AudioContext rates too (48 kHz) and on a 16 kHz clip', () => {
    for (const sr of [48000, 16000]) {
      const n = Math.round(0.4 * sr);
      const x = new Float32Array(n);
      // (a two-formant buzz made at this rate)
      const v = vowel([700, 1200, 2500], 0.4);
      for (let i = 0; i < n; i++) x[i] = v[Math.min(v.length - 1, Math.floor((i * SR) / sr))];
      const tr = analyseAcoustics(x, sr);
      expect(Math.abs(med(tr, tr.f1, 0.1, 0.3) / 700 - 1), `F1 at ${sr}`).toBeLessThan(0.1);
    }
  });

  it('polyRoots finds the roots of a real polynomial (cold and warm-started)', () => {
    // (z - 0.5)(z + 0.3)(z^2 + 0.81) = z^4 - 0.2 z^3 + 0.66 z^2 - 0.162 z - 0.1215
    const a = Float64Array.from([1, -0.2, 0.66, -0.162, -0.1215]);
    const re = new Float64Array(4), im = new Float64Array(4);
    polyRoots(a, 4, re, im, false);
    const key = (p) => Math.round(p[0] * 1e4) * 10 + Math.sign(Math.round(p[1] * 1e4));
    const roots = Array.from(re, (r, k) => [r, im[k]]).sort((p, q) => key(p) - key(q));
    const want = [[-0.3, 0], [0, -0.9], [0, 0.9], [0.5, 0]];
    roots.forEach(([r, i], k) => { expect(r).toBeCloseTo(want[k][0], 6); expect(i).toBeCloseTo(want[k][1], 6); });
    const it = polyRoots(a, 4, re, im, true);
    expect(it).toBeLessThan(5);
  });
});

describe('acoustics client', () => {
  it('without a worker analyses synchronously, from samples or from the clip\'s WAV', async () => {
    const c = new AcousticsClient({ sync: true });
    const x = vowel([700, 1200, 2600], 0.3);
    const j1 = c.analyse({ samples: x, sampleRate: SR });
    expect(j1.final).toBe(true);
    expect(j1.track.n).toBe(Math.ceil(0.3 / AC_HOP));
    const j2 = c.analyse({ audioB64: bytesToBase64(encodeWav(x, SR)) });
    expect(await j2.promise).toBeTruthy();
    expect(Math.abs(j2.track.f1[30] - j1.track.f1[30])).toBeLessThan(15);   // (PCM16 rounding)
    const bad = c.analyse({ audioB64: 'not a wav' });
    expect(bad.failed).toBe(true);
  });

  it('with a worker: posts the job, takes the partial then the final track; a failing worker is given up', async () => {
    const posted = [];
    const fake = { postMessage: (m) => posted.push(m), terminate() {}, onmessage: null, onerror: null };
    const c = new AcousticsClient({ sync: false, createWorker: () => fake });
    const job = c.analyse({ audioB64: 'AAAA' });
    expect(posted[0]).toMatchObject({ type: 'analyse', audioB64: 'AAAA' });
    const id = posted[0].id;
    fake.onmessage({ data: { id, track: { n: 10, done: 4 }, final: false } });
    expect(job.track.done).toBe(4);
    expect(job.final).toBe(false);
    fake.onmessage({ data: { id, track: { n: 10, done: 10 }, final: true } });
    expect((await job.promise).done).toBe(10);
    // a crashed worker: pending jobs end, later ones fall back to nothing (the timeline alone)
    const j2 = c.analyse({ audioB64: 'BBBB' });
    const warn = console.warn;
    console.warn = () => {};
    fake.onerror({ message: 'boom' });
    console.warn = warn;
    expect(j2.failed).toBe(true);
    expect(await j2.promise).toBe(null);
    expect(c.analyse({ audioB64: 'CCCC' }).failed).toBe(true);
  });
});
