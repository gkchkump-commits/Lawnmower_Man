// The playback clock the mouth samples (src/audio/lipsync.js PlaybackClock, src/audio/player.js
// current.time): on Windows AudioContext time advances in ~10 ms callback blocks, so per frame it
// steps 10 / 20 ms at 60 Hz and freezes in a third of the frames at 144 Hz. The mouth must see a
// smooth clock that still follows the audio.
import { describe, expect, it } from 'vitest';
import { PlaybackClock, smoothMax } from '../../../src/audio/lipsync.js';
import { AudioPlayer } from '../../../src/audio/player.js';

/** Audio time as JS sees it: floor to `q`-second blocks, with a callback phase. */
const blocks = (x, q = 0.01, phase = 0.0037) => Math.floor((x + phase) / q) * q - phase;

describe('PlaybackClock', () => {
  for (const fps of [60, 144]) {
    it(`smooths 10 ms audio-clock blocks at ${fps} Hz: steady steps, never backwards, close to the audio`, () => {
      const c = new PlaybackClock();
      const clip = {};
      const dt = 1 / fps;
      let prev = 0, maxErr = 0, worstStep = 0;
      for (let i = 1; i < 4 * fps; i++) {
        const truth = i * dt;
        const t = c.sample(clip, Math.max(0, blocks(truth)), dt);
        expect(t).toBeGreaterThanOrEqual(prev);
        if (i > fps / 2) {
          maxErr = Math.max(maxErr, Math.abs(t - truth));
          worstStep = Math.max(worstStep, Math.abs((t - prev) - dt));
        }
        prev = t;
      }
      expect(maxErr).toBeLessThan(0.012); // within a block of the true time
      expect(worstStep).toBeLessThan(0.0025); // at most ~2 ms of correction per frame (raw: 10 ms)
    });
  }

  it('re-syncs when far behind, waits instead of stepping back when far ahead, restarts per clip', () => {
    const c = new PlaybackClock();
    const a = {}, b = {};
    expect(c.sample(a, 0, 1 / 60)).toBe(0); // not started yet: follows the report
    expect(c.sample(a, 0.01, 1 / 60)).toBeCloseTo(0.01, 9);
    // a big jump forward (frames dropped): re-sync at once
    expect(c.sample(a, 0.5, 1 / 60)).toBeCloseTo(0.5, 9);
    // the audio stalls: the clock runs on at most one block ahead, then waits
    let t = 0;
    for (let i = 0; i < 10; i++) t = c.sample(a, 0.5, 1 / 60);
    expect(t).toBeLessThanOrEqual(0.512 + 1e-9);
    expect(t).toBeGreaterThanOrEqual(0.5);
    // a new clip starts from its own time
    expect(c.sample(b, 0.002, 1 / 60)).toBeCloseTo(0.002, 9);
  });
});

describe('smoothMax', () => {
  it('is the max far apart and smooth (no corner) where the values cross', () => {
    expect(Math.abs(smoothMax(-10, -30) + 10)).toBeLessThan(0.55);
    expect(smoothMax(-30, -10)).toBeCloseTo(smoothMax(-10, -30), 12);
    expect(smoothMax(-20, -20)).toBeCloseTo(-20, 9);
    // its slope in a changes continuously through the crossing
    const d = (a) => (smoothMax(a + 1e-4, -20) - smoothMax(a - 1e-4, -20)) / 2e-4;
    expect(Math.abs(d(-20.05) - d(-19.95))).toBeLessThan(0.1);
  });
});

describe('AudioPlayer playback time', () => {
  /** A fake AudioContext with a block clock and an output timestamp. */
  function ctxAt(env) {
    return {
      get currentTime() { return blocks(env.time); },
      outputLatency: env.latency,
      baseLatency: 0,
      sampleRate: 48000,
      state: 'running',
      getOutputTimestamp: env.ts ? () => ({ contextTime: blocks(env.time) - env.latency, performanceTime: env.perfAt }) : undefined,
    };
  }

  it('uses the output timestamp extrapolated to now (no callback-block steps, latency included)', () => {
    const p = new AudioPlayer({ createContext: () => null });
    const env = { time: 1.0, latency: 0.04, ts: true, perfAt: 0 };
    p.ctx = /** @type {any} */ (ctxAt(env));
    const realNow = globalThis.performance.now.bind(globalThis.performance);
    try {
      // the timestamp was taken at the last block; 7 ms have passed since
      const block = blocks(1.0);
      env.perfAt = 5000;
      globalThis.performance.now = () => 5007;
      const heard = p._heardTime();
      expect(heard).toBeCloseTo(block - 0.04 + 0.007, 6);
    } finally {
      globalThis.performance.now = realNow;
    }
  });

  it('without it: currentTime minus a smoothed latency (a jumpy estimate does not jolt the clock)', () => {
    const p = new AudioPlayer({ createContext: () => null });
    const env = { time: 2.0, latency: 0.04, ts: false };
    const ctx = ctxAt(env);
    p.ctx = /** @type {any} */ (ctx);
    const out = [];
    for (let i = 0; i < 40; i++) {
      env.time = 2 + i * 0.07;
      ctx.outputLatency = i === 20 ? 0.2 : 0.04; // one wild re-estimate
      out.push(p._heardTime() - blocks(env.time));
    }
    expect(Math.max(...out.map((x) => -x))).toBeLessThan(0.05);
  });
});
