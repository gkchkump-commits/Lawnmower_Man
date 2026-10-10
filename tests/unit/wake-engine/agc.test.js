import { describe, it, expect } from 'vitest';
import { LevelNormalizer, dbToGain, rmsDb } from '../../../electron/wake/agc.js';

const SR = 16000;
const BLOCK = 320;

/** A block of a sine (440 Hz) whose RMS is `db` dBFS. @param {number} db @param {number} [phase] */
function tone(db, phase = 0) {
  const a = dbToGain(db) * Math.SQRT2;
  const x = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) x[i] = a * Math.sin((2 * Math.PI * 440 * (phase + i)) / SR);
  return x;
}

/** Feed `ms` of speech at `db` dBFS; return the output level of the last block. */
function run(agc, db, ms, speaking = true) {
  let out = null;
  for (let t = 0, n = 0; t < ms; t += 20, n += BLOCK) {
    const x = tone(db, n);
    agc.observe(x, speaking);
    out = agc.apply(x);
  }
  return rmsDb(out);
}

describe('LevelNormalizer', () => {
  it('brings −35 dBFS speech to about −20 dBFS within 300 ms', () => {
    const agc = new LevelNormalizer();
    expect(run(agc, -35, 300)).toBeCloseTo(-20, 0);
    expect(agc.gainDb).toBeCloseTo(15, 0);
  });

  it('follows a level change with the 300 ms time constant, not at once', () => {
    const agc = new LevelNormalizer();
    run(agc, -20, 1000);
    expect(agc.gainDb).toBeCloseTo(0, 1);
    // the mean square falls exponentially: after 100 ms (1/3 tau) only part of the way …
    run(agc, -30, 100);
    expect(agc.gainDb).toBeGreaterThan(1);
    expect(agc.gainDb).toBeLessThan(5);
    // … after 1 s most of it, after 2 s all of it
    run(agc, -30, 900);
    expect(agc.gainDb).toBeGreaterThan(8);
    run(agc, -30, 1000);
    expect(agc.gainDb).toBeCloseTo(10, 0);
  });

  it('freezes the gain outside speech (each utterance starts with the previous gain)', () => {
    const agc = new LevelNormalizer();
    run(agc, -32, 600);
    const g = agc.gainDb;
    run(agc, -60, 2000, false); // room noise between utterances
    expect(agc.gainDb).toBe(g);
    agc.observe(new Float32Array(BLOCK), true); // digital zeros say nothing about the level
    expect(agc.gainDb).toBe(g);
  });

  it('clamps the gain to [−6, +24] dB', () => {
    const quiet = new LevelNormalizer();
    run(quiet, -60, 600);
    expect(quiet.gainDb).toBe(24);
    const loud = new LevelNormalizer();
    run(loud, -3, 600);
    expect(loud.gainDb).toBe(-6);
  });

  it('beginUtterance(): the next utterance is measured on its own first blocks', () => {
    const agc = new LevelNormalizer();
    run(agc, -20, 1500);
    agc.beginUtterance();
    expect(agc.gainDb).toBeCloseTo(0, 1); // unchanged until speech arrives
    agc.observe(tone(-38), true);
    expect(agc.gainDb).toBeCloseTo(18, 0); // the first block of the new utterance sets it
  });

  it('apply() returns a gained copy and leaves the input alone; a loud block is limited, not clipped', () => {
    const agc = new LevelNormalizer();
    run(agc, -50, 600); // +24 dB
    const quiet = Float32Array.of(0.01, -0.02, 0.03);
    expect(agc.apply(quiet)[1]).toBeCloseTo(-0.02 * dbToGain(24), 4);
    const x = Float32Array.of(0.01, -0.01, 0.5, -0.5);
    const y = agc.apply(x);
    expect(Array.from(x)).toEqual([0.01, -0.01, 0.5, -0.5].map((v) => Math.fround(v)));
    // the block's peak sets its gain: 0.5 → 0.99, the rest in proportion (no clipped samples)
    expect(y[2]).toBeCloseTo(0.99, 5);
    expect(y[0] / y[2]).toBeCloseTo(0.02, 5);
    // without the limiter it would clip
    const hard = new LevelNormalizer({ limit: null });
    run(hard, -50, 600);
    const z = hard.apply(x);
    expect(z[2]).toBe(1);
    expect(z[3]).toBe(-1);
    expect(z[0]).toBeCloseTo(0.01 * dbToGain(24), 4);
  });
});
