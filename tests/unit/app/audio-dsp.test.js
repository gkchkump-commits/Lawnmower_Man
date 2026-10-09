import { describe, expect, it } from 'vitest';
import { Resampler, bandEnergies, dbToUnit, resample, rms, toDb } from '../../../src/audio/dsp.js';
import { EnergyVad, trimSilence } from '../../../src/audio/vad.js';
import { base64ToBytes, bytesToBase64, decodeWav, encodeWav } from '../../../src/audio/wav.js';

const sine = (freq, rate, seconds, amp = 0.5) => {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
/** deterministic white-ish noise */
const noise = (n, amp, seed = 1) => {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return out;
};
const cat = (...parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const addNoise = (x, amp) => { const nz = noise(x.length, amp, 7); return x.map((v, i) => v + nz[i]); };

describe('wav', () => {
  it('round-trips PCM16 mono', () => {
    const x = sine(440, 16000, 0.1, 0.8);
    const wav = encodeWav(x, 16000);
    expect(wav.byteLength).toBe(44 + x.length * 2);
    const d = decodeWav(wav);
    expect(d.sampleRate).toBe(16000);
    expect(d.channels).toBe(1);
    expect(d.samples.length).toBe(x.length);
    expect(d.durationSec).toBeCloseTo(0.1, 5);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(d.samples[i] - x[i]));
    expect(maxErr).toBeLessThan(1 / 16000);
  });

  it('clamps out-of-range samples', () => {
    const d = decodeWav(encodeWav(new Float32Array([2, -2, 0]), 8000));
    expect(d.samples[0]).toBeCloseTo(32767 / 32768, 4);
    expect(d.samples[1]).toBe(-1);
  });

  it('decodes stereo float32 with extra chunks, mixing to mono', () => {
    const frames = 4;
    const buf = new ArrayBuffer(12 + 8 + 4 + 8 + 16 + 8 + frames * 8);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); w(8, 'WAVE');
    w(12, 'LIST'); v.setUint32(16, 4, true); w(20, 'INFO');
    w(24, 'fmt '); v.setUint32(28, 16, true); v.setUint16(32, 3, true); v.setUint16(34, 2, true);
    v.setUint32(36, 48000, true); v.setUint32(40, 48000 * 8, true); v.setUint16(44, 8, true); v.setUint16(46, 32, true);
    w(48, 'data'); v.setUint32(52, frames * 8, true);
    for (let f = 0; f < frames; f++) { v.setFloat32(56 + f * 8, 0.5, true); v.setFloat32(60 + f * 8, -0.25, true); }
    const d = decodeWav(buf);
    expect(d.channels).toBe(2);
    expect(d.sampleRate).toBe(48000);
    expect(Array.from(d.samples)).toEqual([0.125, 0.125, 0.125, 0.125]);
  });

  it('rejects garbage', () => {
    expect(() => decodeWav(new ArrayBuffer(10))).toThrow(/not a WAV/);
  });

  it('base64 helpers round-trip (and accept URL-safe input)', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64 = bytesToBase64(bytes);
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    expect(Array.from(base64ToBytes(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')))).toEqual(Array.from(bytes));
  });

  it('uses the native base64 decoder when there is one, and falls back for input it rejects', () => {
    const had = Object.prototype.hasOwnProperty.call(Uint8Array, 'fromBase64');
    const saved = /** @type {any} */ (Uint8Array).fromBase64;
    const calls = [];
    // a strict stand-in for Uint8Array.fromBase64 (standard alphabet only)
    /** @type {any} */ (Uint8Array).fromBase64 = (s, o) => {
      calls.push(o);
      if (/[^A-Za-z0-9+/=\s]/.test(s)) throw new SyntaxError('bad base64');
      return new Uint8Array(Buffer.from(s, 'base64'));
    };
    try {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      const b64 = bytesToBase64(bytes);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
      expect(calls).toEqual([{ lastChunkHandling: 'loose' }]);
      expect(Array.from(base64ToBytes(b64.replace(/\+/g, '-').replace(/\//g, '_')))).toEqual(Array.from(bytes));
      expect(calls).toHaveLength(2);
    } finally {
      if (had) /** @type {any} */ (Uint8Array).fromBase64 = saved;
      else delete /** @type {any} */ (Uint8Array).fromBase64;
    }
  });

  it('16-bit mono (what the voice server sends) decodes through a typed view to the very same values', () => {
    const x = noise(4801, 0.9, 11);
    const wav = new Uint8Array(encodeWav(x, 24000));
    const fast = decodeWav(wav).samples;
    // the same file at an odd byte offset cannot use the Int16 view: the generic reader
    const shifted = new Uint8Array(wav.length + 1);
    shifted.set(wav, 1);
    const slow = decodeWav(shifted.subarray(1)).samples;
    expect(fast.length).toBe(4801);
    expect(Buffer.from(fast.buffer).equals(Buffer.from(slow.buffer))).toBe(true);
    expect(fast[100]).toBeCloseTo(x[100], 3);
  });
});

describe('dsp', () => {
  it('rms / toDb / dbToUnit', () => {
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(toDb(1)).toBe(0);
    expect(toDb(0)).toBe(-100);
    expect(toDb(0.1)).toBeCloseTo(-20, 6);
    expect(dbToUnit(-60)).toBe(0);
    expect(dbToUnit(0)).toBe(1);
  });

  it('resamples 48k → 16k with the right length, amplitude and frequency', () => {
    const x = sine(440, 48000, 0.5, 0.5);
    const y = resample(x, 48000, 16000);
    expect(y.length).toBe(8000);
    // compare against an ideal 16 kHz sine away from the edges
    let err = 0;
    for (let i = 200; i < 7800; i++) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000)));
    expect(err).toBeLessThan(0.01);
  });

  it('attenuates content above the new Nyquist (anti-aliasing)', () => {
    const x = sine(11000, 48000, 0.5, 0.5); // would alias to 5 kHz at 16 kHz
    const y = resample(x, 48000, 16000);
    expect(rms(y, 200, y.length - 200)).toBeLessThan(0.01);
  });

  it('handles non-integer ratios (44.1k → 16k) and upsampling', () => {
    const x = sine(300, 44100, 0.3, 0.4);
    const y = resample(x, 44100, 16000);
    expect(y.length).toBe(Math.round(x.length * 16000 / 44100));
    expect(rms(y, 100, y.length - 100)).toBeCloseTo(0.4 / Math.SQRT2, 2);
    const up = resample(sine(300, 8000, 0.2, 0.4), 8000, 16000);
    expect(up.length).toBe(3200);
    expect(rms(up, 100, up.length - 100)).toBeCloseTo(0.4 / Math.SQRT2, 2);
  });

  it('streaming in odd block sizes equals one-shot processing', () => {
    const x = cat(sine(250, 48000, 0.2), noise(4800, 0.2));
    const one = resample(x, 48000, 16000);
    const r = new Resampler(48000, 16000);
    const parts = [];
    for (let i = 0; i < x.length; i += 333) parts.push(r.process(x.subarray(i, i + 333)));
    parts.push(r.flush());
    const streamed = cat(...parts).subarray(0, one.length);
    let maxErr = 0;
    for (let i = 0; i < one.length; i++) maxErr = Math.max(maxErr, Math.abs(one[i] - streamed[i]));
    expect(maxErr).toBeLessThan(1e-6);
  });

  it('identity rate passes samples through', () => {
    const x = new Float32Array([0.1, 0.2]);
    expect(Array.from(new Resampler(16000, 16000).process(x))).toEqual(Array.from(x));
  });

  it('bandEnergies averages linear magnitude per band', () => {
    const db = new Float32Array(512).fill(-100);
    db[20] = 0; // bin 20 of 512 at 16 kHz → 312.5 Hz
    const [low, high] = bandEnergies(db, 16000, [[250, 400], [3000, 4000]]);
    expect(low).toBeGreaterThan(0.05);
    expect(high).toBeLessThan(1e-4);
  });
});

describe('EnergyVad', () => {
  const RATE = 16000;
  const silence = (s) => noise(Math.round(RATE * s), 0.001, 3); // ~ -65 dBFS
  /** speech-like: a tone with a 4 Hz syllable envelope (energy swings by > 10 dB) */
  const speech = (s, amp = 0.3) => {
    const x = sine(220, RATE, s, amp);
    for (let i = 0; i < x.length; i++) x[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / RATE);
    return addNoise(x, 0.001);
  };

  const run = (vad, signal, block = 512) => {
    const ev = [];
    for (let i = 0; i < signal.length; i += block) ev.push(...vad.process(signal.subarray(i, i + block)));
    return ev;
  };

  it('detects one utterance with pre-roll and trims the trailing silence', () => {
    const vad = new EnergyVad();
    const ev = run(vad, cat(silence(1), speech(1.2), silence(1.2)));
    expect(ev.map((e) => e.type)).toEqual(['speechstart', 'speechend']);
    const end = /** @type {any} */ (ev[1]);
    expect(end.reason).toBe('silence');
    // ~1.2 s of speech + ≤ 0.36 s pre-roll + 0.15 s tail
    expect(end.durationMs).toBeGreaterThan(1200);
    expect(end.durationMs).toBeLessThan(1800);
    expect(end.samples.length).toBe(Math.round(end.durationMs * RATE / 1000));
    expect(vad.speaking).toBe(false);
  });

  it('keeps short pauses inside the utterance (hangover)', () => {
    const vad = new EnergyVad({ hangoverMs: 500 });
    const ev = run(vad, cat(silence(0.5), speech(0.5), silence(0.3), speech(0.5), silence(1)));
    expect(ev.filter((e) => e.type === 'speechend')).toHaveLength(1);
  });

  it('discards blips that are too short', () => {
    const vad = new EnergyVad();
    const ev = run(vad, cat(silence(0.5), speech(0.12), silence(1)));
    expect(ev.map((e) => e.type)).toEqual(['speechstart', 'discard']);
  });

  it('cuts utterances at the maximum length', () => {
    const vad = new EnergyVad({ maxUtteranceMs: 1000 });
    const ev = run(vad, cat(silence(0.3), speech(2.5)));
    const end = ev.find((e) => e.type === 'speechend');
    expect(end && /** @type {any} */ (end).reason).toBe('maxlength');
  });

  it('adapts to a constant noise floor (no false trigger from steady noise)', () => {
    const vad = new EnergyVad();
    const steady = noise(RATE * 3, 0.02, 9); // ~ -39 dBFS
    const ev = run(vad, steady);
    // the first frames may look loud before the floor adapts, but no full utterance is produced
    expect(ev.filter((e) => e.type === 'speechend')).toHaveLength(0);
    expect(vad.floorDb).toBeGreaterThan(-45);
    // speech well above that noise still triggers
    const ev2 = run(vad, cat(speech(1), noise(RATE, 0.02, 11)));
    expect(ev2.map((e) => e.type)).toContain('speechend');
  });

  it('learns a noise source that starts mid-session (steady loudness is not speech)', () => {
    const vad = new EnergyVad();
    const ev = run(vad, cat(silence(1), noise(RATE * 4, 0.05, 5)));
    expect(ev.filter((e) => e.type === 'speechend')).toHaveLength(0);
    expect(ev.find((e) => e.type === 'discard')).toMatchObject({ reason: 'steady-noise' });
    expect(vad.speaking).toBe(false);
    expect(vad.floorDb).toBeGreaterThan(-40);
  });

  it('end() forces the end of an utterance in progress', () => {
    const vad = new EnergyVad();
    run(vad, cat(silence(0.3), speech(0.6)));
    expect(vad.speaking).toBe(true);
    const ev = vad.end();
    expect(ev[0].type).toBe('speechend');
    expect(/** @type {any} */ (ev[0]).reason).toBe('forced');
  });

  it('exposes a 0..1 level', () => {
    const vad = new EnergyVad();
    vad.process(speech(0.1));
    expect(vad.level).toBeGreaterThan(0.6);
    vad.process(silence(0.1));
    expect(vad.level).toBe(0);
  });
});

describe('trimSilence', () => {
  it('trims silence around speech with padding', () => {
    const RATE = 16000;
    const x = cat(noise(RATE, 0.001), sine(220, RATE, 0.5, 0.3), noise(RATE, 0.001));
    const { samples, speechMs } = trimSilence(x, RATE, { padMs: 100 });
    expect(speechMs).toBeGreaterThanOrEqual(480);
    expect(samples.length / RATE).toBeGreaterThan(0.6);
    expect(samples.length / RATE).toBeLessThan(0.8);
  });

  it('returns nothing for pure silence and keeps all-speech recordings', () => {
    expect(trimSilence(noise(16000, 0.001), 16000).speechMs).toBe(0);
    const all = sine(200, 16000, 1, 0.3);
    expect(trimSilence(all, 16000).samples.length).toBe(16000);
  });
});
