// Voice character DSP (src/audio/voicefx.js): bypass exactness, robustness (no NaN, no
// clipping), the vocoder following the voice, pitch tracking, loudness matching and the speech
// band on a real Kokoro clip, tails, click-free changes, sleeping, cost.
//
// tests/fixtures/kokoro-af_heart.wav: "It's easy to tell the depth of a well." spoken by
// Kokoro-82M (Apache-2.0) with the af_heart voice, 24 kHz PCM16, as the voice server returns it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resample } from '../../../src/audio/dsp.js';
import { decodeWav } from '../../../src/audio/wav.js';
import {
  ClipPitch, DEFAULT_CHARACTER, DEFAULT_FX_AMOUNT, LIMIT, PitchTracker, TAIL_SEC, VOICE_CHARACTERS, VoiceFx,
  foldOctave, normalizeFx, presetParams, renderVoiceFx,
} from '../../../src/audio/voicefx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KOKORO = decodeWav(readFileSync(path.join(here, '../../fixtures/kokoro-af_heart.wav')));
const SR = 48000;
// what the AudioContext gets on Windows: the 24 kHz clip resampled to 48 kHz
const SPEECH = resample(KOKORO.samples, KOKORO.sampleRate, SR);
const FX_CHARACTERS = VOICE_CHARACTERS.filter((c) => c !== 'natural');

/** Harmonic tone (1/n partials) with a pitch contour f(t). */
function harmonic(f, seconds, rate = SR, amp = 0.3, partials = 12) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const fi = typeof f === 'function' ? f(i / rate) : f;
    ph += fi / rate;
    let s = 0;
    for (let k = 1; k <= partials && k * fi < rate / 2; k++) s += Math.sin(2 * Math.PI * k * ph) / k;
    out[i] = amp * s * 0.6;
  }
  return out;
}
const noise = (n, amp, seed = 3) => {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return out;
};
const rms = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};
const db = (r) => 20 * Math.log10(r);
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** 4th-order band-pass energy via two RBJ biquads (test-side reference filter). */
function bandRms(x, lo, hi, rate = SR) {
  const f = Math.sqrt(lo * hi);
  const q = f / (hi - lo);
  const w = (2 * Math.PI * f) / rate;
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  const b0 = al / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - al) / a0;
  let y = Float64Array.from(x);
  for (let s = 0; s < 2; s++) {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    const o = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] - b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v;
    }
    y = o;
  }
  return rms(y);
}
/**
 * Syllabic amplitude envelope (|x| smoothed over 25 ms, sampled every 5 ms): the modulations
 * below ~10 Hz that carry intelligibility; a robot's 55 Hz ring tremolo is not part of it.
 */
function envelope(x, rate = SR) {
  const hop = Math.round(rate * 0.005);
  const out = [];
  let e = 0;
  const a = 1 - Math.exp(-1 / (0.025 * rate));
  for (let i = 0; i < x.length; i++) {
    e += a * (Math.abs(x[i]) - e);
    if (i % hop === 0) out.push(e);
  }
  return out;
}
const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};
/** Process `x` through `fx` in 128-sample blocks (the AudioWorklet's render quantum). */
function run(fx, x, block = 128) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += block) {
    const n = Math.min(block, x.length - i);
    const o = new Float32Array(n);
    fx.process(x.subarray(i, i + n), o);
    out.set(o, i);
  }
  return out;
}

describe('voicefx: characters and parameters', () => {
  it('defaults to the synth character at ~0.6 and validates its input', () => {
    expect(DEFAULT_CHARACTER).toBe('synth');
    expect(DEFAULT_FX_AMOUNT).toBeCloseTo(0.6, 5);
    expect(VOICE_CHARACTERS).toEqual(expect.arrayContaining(['natural', 'synth', 'robot']));
    expect(normalizeFx({ character: 'robot', amount: 0.3 })).toEqual({ character: 'robot', amount: 0.3 });
    expect(normalizeFx({ character: 'nonsense', amount: 7 })).toEqual({ character: 'synth', amount: 1 });
    expect(normalizeFx({ character: 'natural', amount: Number.NaN })).toEqual({ character: 'natural', amount: DEFAULT_FX_AMOUNT });
    expect(normalizeFx({ amount: -1 }).amount).toBe(0);
  });

  it('every character at amount 0 is the dry voice; the amount scales the wet mix', () => {
    const natural = presetParams('natural', 1);
    for (const c of VOICE_CHARACTERS) {
      const p = presetParams(c, 0);
      expect(p.voc * p.vocGate + p.chorus + p.comb + p.ring + p.crush + Math.abs(p.air), c).toBeLessThanOrEqual(c === 'synth' ? 0 : 1);
    }
    expect(natural).toMatchObject({ dry: 1, voc: 0, chorus: 0, comb: 0, ring: 0, crush: 0, air: 0 });
    const lo = presetParams('synth', 0.4);
    const hi = presetParams('synth', 0.9);
    expect(hi.voc).toBeGreaterThan(lo.voc);
    expect(hi.dry).toBeLessThan(lo.dry);
    expect(hi.chorus).toBeGreaterThan(lo.chorus);
    // the synth keeps the dry voice as its strongest layer at the default amount
    const def = presetParams('synth', DEFAULT_FX_AMOUNT);
    expect(def.dry).toBeGreaterThan(def.voc);
    // robot: monotone and ring-modulated; vocoder: snapped pitch, no dry voice at full amount
    expect(presetParams('robot', 0.6)).toMatchObject({ mono: 1, snap: 1 });
    expect(presetParams('robot', 0.6).ring).toBeGreaterThan(0.3);
    expect(presetParams('vocoder', 1).dry).toBe(0);
  });
});

describe('voicefx: bypass and robustness', () => {
  it("'natural' (and amount 0) is a bit-exact copy, in blocks of any size", () => {
    const x = noise(10000, 0.8);
    for (const o of [{ character: 'natural', amount: 1 }, { character: 'synth', amount: 0 }, { character: 'robot', amount: 0 }]) {
      const fx = new VoiceFx(SR, /** @type {any} */ (o));
      expect(fx.idle).toBe(true);
      const y = new Float32Array(x.length);
      let i = 0;
      for (const n of [128, 1, 77, 128, 4000]) {
        const o2 = new Float32Array(Math.min(n, x.length - i));
        fx.process(x.subarray(i, i + o2.length), o2);
        y.set(o2, i);
        i += o2.length;
      }
      const rest = new Float32Array(x.length - i);
      fx.process(x.subarray(i), rest);
      y.set(rest, i);
      expect(Buffer.from(y.buffer).equals(Buffer.from(x.buffer)), JSON.stringify(o)).toBe(true);
    }
    const out = renderVoiceFx(x, SR, { character: 'natural' });
    expect(out.length).toBe(x.length);
    expect(Buffer.from(out.buffer).equals(Buffer.from(x.buffer))).toBe(true);
  });

  it('mono in → mono out; a processed clip keeps its length plus the tail', () => {
    for (const c of FX_CHARACTERS) {
      const y = renderVoiceFx(SPEECH, SR, { character: c, amount: 0.6 });
      expect(y).toBeInstanceOf(Float32Array);
      expect(y.length).toBe(SPEECH.length + Math.round(TAIL_SEC * SR));
    }
  });

  it('never produces NaN or clips, whatever comes in (all characters, full amount, several rates)', () => {
    const n = 12000;
    const square = new Float32Array(n).map((_, i) => (Math.floor(i / 240) % 2 ? 1 : -1));
    const impulses = new Float32Array(n).map((_, i) => (i % 997 === 0 ? 1 : 0));
    const nyquist = new Float32Array(n).map((_, i) => (i % 2 ? 1 : -1));
    const inputs = {
      silence: new Float32Array(n), noise: noise(n, 1), square, impulses, nyquist,
      dc: new Float32Array(n).fill(0.9), tiny: new Float32Array(n).fill(1e-30), loudVoice: SPEECH.map((v) => Math.max(-1, Math.min(1, v * 3))),
    };
    for (const rate of [SR, 44100, 24000, 16000]) {
      for (const c of FX_CHARACTERS) {
        for (const [name, x0] of Object.entries(inputs)) {
          const x = rate === SR ? x0 : x0.subarray(0, Math.round((n * rate) / SR));
          const y = renderVoiceFx(x, rate, { character: c, amount: 1 });
          let bad = 0;
          for (const v of y) if (!Number.isFinite(v)) bad++;
          expect(bad, `${c} ${name} @${rate}`).toBe(0);
          expect(peak(y), `${c} ${name} @${rate}`).toBeLessThanOrEqual(LIMIT + 1e-6);
        }
      }
    }
  });

  it('is deterministic (seeded noise carrier)', () => {
    const a = renderVoiceFx(SPEECH.subarray(0, 30000), SR, { character: 'robot', amount: 0.7 });
    const b = renderVoiceFx(SPEECH.subarray(0, 30000), SR, { character: 'robot', amount: 0.7 });
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});

describe('voicefx: the vocoder follows the voice', () => {
  it('band envelopes rise and fall with the input, in the right band', () => {
    // 1 kHz tone bursts: 150 ms on, 150 ms off
    const on = 0.15 * SR;
    const x = new Float32Array(Math.round(1.2 * SR)).map((_, i) => (Math.floor(i / on) % 2 === 0 ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0));
    const fx = new VoiceFx(SR, { character: 'vocoder', amount: 1 });
    const k1k = fx.fc.reduce((best, f, k) => (Math.abs(Math.log(f / 1000)) < Math.abs(Math.log(fx.fc[best] / 1000)) ? k : best), 0);
    const trace = [];
    for (let i = 0; i < x.length; i += 128) {
      fx.process(x.subarray(i, i + 128), new Float32Array(128));
      trace.push({ t: (i + 128) / SR, pm: Array.from(fx.pm) });
    }
    const at = (t) => trace.find((r) => r.t >= t).pm;
    const during = at(0.1);
    const after = at(0.25);
    // the loudest band during the burst is the one around 1 kHz
    expect(during.indexOf(Math.max(...during))).toBe(k1k);
    // it follows the input: > 40 dB down 100 ms after the burst ended, back up in the next one
    expect(10 * Math.log10(during[k1k] / Math.max(1e-30, after[k1k]))).toBeGreaterThan(40);
    expect(at(0.4)[k1k]).toBeGreaterThan(0.1 * during[k1k]);
    // a band two octaves away stays > 30 dB below
    const kFar = fx.fc.findIndex((f) => f > 4000);
    expect(10 * Math.log10(during[k1k] / during[kFar])).toBeGreaterThan(30);
  });

  it('the output follows the input envelope (output silent between bursts)', () => {
    const on = 0.15 * SR;
    const x = harmonic(140, 1.2).map((v, i) => (Math.floor(i / on) % 2 === 0 ? v : 0));
    for (const c of FX_CHARACTERS) {
      const y = renderVoiceFx(x, SR, { character: c, amount: 1 });
      const burst = rms(y, 0.03 * SR, 0.14 * SR);
      const gap = rms(y, 0.22 * SR, 0.29 * SR);
      expect(db(burst / gap), c).toBeGreaterThan(35);
    }
  });
});

describe('voicefx: pitch', () => {
  it('the live YIN tracker finds the F0 of harmonic tones (within 1%) and calls noise unvoiced', () => {
    for (const f0 of [95, 140, 220, 330]) {
      const tr = new PitchTracker(SR);
      for (const v of harmonic(f0, 0.4)) tr.push(v);
      expect(tr.voiced, `${f0} Hz`).toBe(true);
      expect(Math.abs(tr.f0 / f0 - 1), `${f0} Hz`).toBeLessThan(0.01);
    }
    const tr = new PitchTracker(SR);
    let voiced = 0;
    let frames = 0;
    for (const v of noise(SR, 0.3)) if (tr.push(v)) { frames++; if (tr.voiced) voiced++; }
    expect(voiced / frames).toBeLessThan(0.05);
  });

  it('the clip look-ahead analysis follows a chirp with no lag', () => {
    const f = (t) => 100 + 200 * t; // 100 → 300 Hz in 1 s
    const rate = 24000;
    const x = harmonic(f, 1, rate);
    const cp = new ClipPitch(x, rate);
    cp.step(1e6);
    const errs = [];
    for (let t = 0.05; t < 0.95; t += 0.01) {
      expect(cp.covers(t)).toBe(true);
      errs.push(Math.abs(cp.at(t) / f(t) - 1));
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(0.01); // median error < 1% at zero lag
    expect(errs[errs.length - 1]).toBeLessThan(0.04);
    // a live tracker on the same chirp lags: its error at the same instants is larger
    const tr = new PitchTracker(rate);
    const live = [];
    for (let i = 0; i < x.length; i++) {
      tr.push(x[i]);
      if (i % 240 === 0 && i / rate > 0.05 && tr.voiced) live.push(Math.abs(tr.f0 / f(i / rate) - 1));
    }
    live.sort((a, b) => a - b);
    expect(live[live.length >> 1]).toBeGreaterThan(errs[errs.length >> 1]);
  });

  it('analyses incrementally (a bounded number of frames per call) and only what it is asked to', () => {
    const cp = new ClipPitch(harmonic(150, 1, 24000), 24000);
    expect(cp.step(5)).toBe(5);
    expect(cp.covers(0.5)).toBe(false);
    cp.step(1000, 0.2);
    expect(cp.done).toBeLessThan(50);
    expect(cp.covers(0.1)).toBe(true);
    cp.step(1e6);
    expect(cp.done).toBe(cp.count);
    expect(cp.at(-0.1)).toBe(0);
    expect(cp.at(5)).toBe(0);
  });

  it('octave errors fold toward the speaker’s pitch', () => {
    expect(foldOctave(100, 210)).toBe(200);
    expect(foldOctave(440, 210)).toBe(220);
    expect(foldOctave(260, 210)).toBe(260);
    expect(foldOctave(150, 0)).toBe(150);
  });

  it('the carrier is in tune with the voice: from the clip analysis, or later from the live tracker', () => {
    const x = harmonic(150, 0.6);
    const withClip = new VoiceFx(SR, { character: 'synth', amount: 0.6 });
    withClip.setClip(x, SR, 0);
    run(withClip, x.subarray(0, 0.3 * SR));
    expect(withClip.pitchSource).toBe('clip');
    expect(Math.abs(withClip.freq / 150 - 1)).toBeLessThan(0.01);
    const live = new VoiceFx(SR, { character: 'synth', amount: 0.6 });
    run(live, x.subarray(0, 0.3 * SR));
    expect(live.pitchSource).toBe('live');
    expect(Math.abs(live.freq / 150 - 1)).toBeLessThan(0.02);
  });

  it('a clip scheduled to start later is analysed on its own clock', () => {
    const x = harmonic(200, 0.5);
    const fx = new VoiceFx(SR, { character: 'synth', amount: 0.6 });
    const delay = 0.2 * SR;
    fx.setClip(x, SR, delay);
    run(fx, new Float32Array(Math.round(0.1 * SR)));
    expect(fx.pitchSource).not.toBe('clip'); // not playing yet
    const padded = new Float32Array(Math.round(0.1 * SR + x.length));
    padded.set(x, Math.round(0.1 * SR));
    run(fx, padded.subarray(0, Math.round(0.35 * SR)));
    expect(fx.pitchSource).toBe('clip');
    expect(Math.abs(fx.freq / 200 - 1)).toBeLessThan(0.01);
  });

  it('robot is monotone: the carrier stays on one note while the voice glides an octave', () => {
    const glide = (t) => 120 * 2 ** (t / 2); // one octave in 2 s
    const x = harmonic(glide, 2);
    const fx = new VoiceFx(SR, { character: 'robot', amount: 0.6 });
    fx.setClip(x, SR, 0);
    const st = [];
    for (let i = 0; i < x.length; i += 128) {
      fx.process(x.subarray(i, i + 128), new Float32Array(128));
      if (i > 0.5 * SR) st.push(12 * Math.log2(fx.freq / 440));
    }
    const range = Math.max(...st) - Math.min(...st);
    expect(range).toBeLessThan(4); // the voice moved 9 semitones in the same time
    // ...on semitones
    const off = st.map((s) => Math.abs(s - Math.round(s)));
    expect(off.filter((d) => d < 0.1).length / off.length).toBeGreaterThan(0.85);
  });
});

describe('voicefx on real Kokoro speech', () => {
  const dryRms = rms(SPEECH);
  const dryBand = bandRms(SPEECH, 300, 3400);
  const dryEnv = envelope(SPEECH);

  for (const c of FX_CHARACTERS) {
    for (const amount of [0.4, 0.6, 0.9]) {
      it(`${c} @ ${amount}: as loud as the dry voice, speech band and envelope kept, no clipping`, () => {
        const y = renderVoiceFx(SPEECH, SR, { character: c, amount }).subarray(0, SPEECH.length);
        expect(Math.abs(db(rms(y) / dryRms))).toBeLessThan(2);
        expect(Math.abs(db(bandRms(y, 300, 3400) / dryBand))).toBeLessThan(2.5);
        // measured on this clip: synth 0.89-0.95, vocoder ~0.88, robot ~0.80 (its monotone
        // cannot follow a female voice's low phrase ends exactly)
        expect(corr(envelope(y), dryEnv)).toBeGreaterThan({ synth: 0.85, vocoder: 0.8, robot: 0.75 }[c] ?? 0.75);
        expect(peak(y)).toBeLessThanOrEqual(LIMIT);
      });
    }
  }

  it('each character changes the voice, the heavier ones more than synth', () => {
    const diff = (c) => {
      const y = renderVoiceFx(SPEECH, SR, { character: c, amount: 0.6 });
      let d = 0;
      for (let i = 0; i < SPEECH.length; i++) d += (y[i] - SPEECH[i]) ** 2;
      return db(Math.sqrt(d / SPEECH.length) / dryRms);
    };
    const synth = diff('synth');
    expect(synth).toBeGreaterThan(-15); // clearly audible, not a subtle EQ
    expect(diff('vocoder')).toBeGreaterThan(synth);
    expect(diff('robot')).toBeGreaterThan(synth);
  });

  it('the tail rings out instead of being cut, and dies away', () => {
    const y = renderVoiceFx(SPEECH, SR, { character: 'synth', amount: 0.9 });
    const end = SPEECH.length;
    // the last 20 ms of the clip and the first 10 ms after it: no step down to silence
    const before = rms(y, end - 0.02 * SR, end);
    const justAfter = rms(y, end, end + 0.01 * SR);
    if (before > 1e-4) expect(justAfter).toBeGreaterThan(0.01 * before);
    expect(db(rms(y, y.length - 0.02 * SR, y.length) / dryRms)).toBeLessThan(-60);
  });
});

describe('voicefx: changes are smooth; idle costs nothing', () => {
  it('switching characters or the amount mid-voice never clicks, and natural is exact again after the ramp', () => {
    const x = harmonic(160, 1.5);
    const fx = new VoiceFx(SR, { character: 'natural' });
    const y = new Float32Array(x.length);
    const plan = new Map([[0.2, { character: 'synth', amount: 0.6 }], [0.5, { character: 'robot' }], [0.8, { amount: 1 }], [1.1, { character: 'natural' }]]);
    for (let i = 0; i < x.length; i += 128) {
      for (const [t, o] of plan) if (Math.abs(i / SR - t) < 64 / SR) fx.configure(/** @type {any} */ (o));
      const o = new Float32Array(Math.min(128, x.length - i));
      fx.process(x.subarray(i, i + o.length), o);
      y.set(o, i);
    }
    let maxStep = 0;
    let dryStep = 0;
    for (let i = 1; i < x.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
      dryStep = Math.max(dryStep, Math.abs(x[i] - x[i - 1]));
    }
    expect(maxStep).toBeLessThan(4 * dryStep);
    // 100 ms after the switch back: exact again
    const tail = Math.round(1.25 * SR);
    expect(Buffer.from(y.buffer, tail * 4).equals(Buffer.from(x.buffer, tail * 4))).toBe(true);
  });

  it('falls asleep after the tail has died away and wakes up on the next clip', () => {
    const fx = new VoiceFx(SR, { character: 'synth', amount: 0.6 });
    run(fx, SPEECH.subarray(0, 0.5 * SR));
    expect(fx.idle).toBe(false);
    const silent = run(fx, new Float32Array(Math.round(0.6 * SR)));
    expect(fx.idle).toBe(true);
    expect(peak(silent.subarray(silent.length - 128))).toBe(0);
    const again = run(fx, SPEECH.subarray(0, 0.5 * SR));
    expect(fx.idle).toBe(false);
    expect(rms(again)).toBeGreaterThan(0.3 * rms(SPEECH.subarray(0, 0.5 * SR)));
  });

  it('a character chosen between replies starts the next one at its own loudness (AGC re-seeded)', () => {
    const W = Math.round(0.3 * SR);
    const level = (y) => db(rms(y, 0, W) / rms(SPEECH, 0, W));
    const fresh = (c) => {
      const fx = new VoiceFx(SR, { character: c, amount: 0.6 });
      fx.setClip(SPEECH, SR, 0);
      return level(run(fx, SPEECH));
    };
    const switched = (from, to) => {
      const fx = new VoiceFx(SR, { character: from, amount: 0.6 });
      fx.setClip(SPEECH, SR, 0);
      run(fx, SPEECH);
      run(fx, new Float32Array(SR)); // the reply ends; the effect falls asleep
      expect(fx.idle).toBe(true);
      fx.configure({ character: to });
      fx.setClip(SPEECH, SR, 0);
      return level(run(fx, SPEECH));
    };
    expect(Math.abs(switched('robot', 'synth') - fresh('synth'))).toBeLessThan(1);
    expect(Math.abs(switched('synth', 'robot') - fresh('robot'))).toBeLessThan(1);
    expect(Math.abs(switched('vocoder', 'robot') - fresh('robot'))).toBeLessThan(1);
  });

  it('keeps up with real time easily (one core, all characters)', () => {
    const x = SPEECH;
    const seconds = x.length / SR;
    for (const c of FX_CHARACTERS) {
      const t0 = performance.now();
      renderVoiceFx(x, SR, { character: c, amount: 0.6 });
      const msPerSec = (performance.now() - t0) / seconds;
      // ~40 ms per second of audio on a laptop core; fail only on a gross regression
      expect(msPerSec, c).toBeLessThan(250);
    }
  });
});
