// The earcons (ux.md A11Y-7): short, soft, at their specified levels; never an utterance.
import { describe, expect, it } from 'vitest';
import { EnergyVad } from '../../../src/audio/vad.js';
import { EARCONS, earconDurationMs, earconSamples, renderEarcon } from '../../../src/wake/earcons.js';

const peakDb = (x) => 20 * Math.log10(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0));

describe('earcons', () => {
  it.each(Object.keys(EARCONS))('%s: ≤ 200 ms, its peak level, no click at either end', (name) => {
    for (const rate of [48000, 44100, 16000]) {
      const x = renderEarcon(/** @type {any} */ (name), rate);
      const ms = (x.length / rate) * 1000;
      expect(ms).toBeLessThanOrEqual(200);
      expect(Math.abs(ms - earconDurationMs(/** @type {any} */ (name)))).toBeLessThan(1);
      expect(peakDb(x)).toBeCloseTo(EARCONS[/** @type {keyof typeof EARCONS} */ (name)].peakDb, 1);
      // soft attack and release: the first and last samples are (nearly) silent
      const edge = Math.round(rate * 0.001);
      for (let i = 0; i < edge; i++) {
        expect(Math.abs(x[i])).toBeLessThan(0.02);
        expect(Math.abs(x[x.length - 1 - i])).toBeLessThan(0.02);
      }
    }
  });

  it('wake rises (660 → 990 Hz) and is the loudest; done falls and is quieter', () => {
    const w = EARCONS.wake.notes;
    expect(w[1].f0).toBeGreaterThan(w[0].f0);
    const d = EARCONS.done.notes;
    expect(d[1].f0).toBeLessThan(d[0].f0);
    expect(EARCONS.wake.peakDb).toBe(-18);
    expect(EARCONS.done.peakDb).toBeLessThan(EARCONS.wake.peakDb);
    for (const e of Object.values(EARCONS)) for (const n of e.notes) {
      expect(n.f0).toBeGreaterThanOrEqual(380);
      expect(n.f0).toBeLessThanOrEqual(1200);
    }
  });

  it('is rendered once per name and rate', () => {
    expect(earconSamples('wake', 48000)).toBe(earconSamples('wake', 48000));
    expect(earconSamples('wake', 16000)).not.toBe(earconSamples('wake', 48000));
    expect(() => renderEarcon(/** @type {any} */ ('nope'))).toThrow(/unknown earcon/);
    expect(earconDurationMs(/** @type {any} */ ('nope'))).toBe(0);
  });

  it('an un-cancelled earcon reaching the mic is never an utterance (ACK-7)', () => {
    // 1 s of a quiet room, the earcon 10 dB down (speaker → mic), 1.5 s of room
    const sr = 16000;
    const e = renderEarcon('wake', sr);
    const sig = new Float32Array(sr + e.length + 1.5 * sr);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    for (let i = 0; i < sig.length; i++) sig[i] = 0.001 * rnd();
    for (let i = 0; i < e.length; i++) sig[sr + i] += e[i] * 10 ** (-10 / 20);
    const vad = new EnergyVad();
    const types = [];
    for (let i = 0; i < sig.length; i += 320) for (const ev of vad.process(sig.subarray(i, i + 320))) types.push(ev.type);
    expect(types).not.toContain('speechend');
    // it does start the VAD (hence Mic.ignoreSpeechStartUntil), then it is thrown away
    expect(types).toEqual(['speechstart', 'discard']);
  });
});
