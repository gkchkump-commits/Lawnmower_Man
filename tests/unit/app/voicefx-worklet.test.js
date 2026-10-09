// The voice character's AudioWorklet processor (src/audio/voicefx-worklet.js): its warm-up runs a
// scratch effect while the node idles, so the first real clip of a session does not run the DSP
// cold on the audio thread. The warm-up must never be heard and never change the real effect.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resample } from '../../../src/audio/dsp.js';
import { decodeWav } from '../../../src/audio/wav.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIP = decodeWav(readFileSync(path.join(here, '../../fixtures/kokoro/maybe_af_heart.wav')));
const SR = 48000;

/** @type {any} */
let Processor = null;

beforeAll(async () => {
  // the AudioWorkletGlobalScope the module expects
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { postMessage: () => {}, onmessage: null }; }
  };
  globalThis.registerProcessor = (name, cls) => { if (name === 'lawnmower-voicefx') Processor = cls; };
  globalThis.sampleRate = SR;
  globalThis.currentFrame = 0;
  await import('../../../src/audio/voicefx-worklet.js');
});

/** Run one render quantum; returns the output block. */
function block(p, input, frame) {
  globalThis.currentFrame = frame;
  const out = new Float32Array(128);
  p.process([input ? [input] : []], [[out]]);
  return out;
}

describe('voicefx worklet: warm-up', () => {
  it('stays silent while it warms up, finishes, and never changes the real effect', () => {
    expect(Processor).toBeTypeOf('function');
    const opts = { character: 'synth', amount: 0.6 };
    const warm = new Processor({ processorOptions: opts });
    const cold = new Processor({ processorOptions: { ...opts, warmUp: false } });
    expect(warm._warm).not.toBeNull();
    expect(cold._warm).toBeNull();
    let frame = 0;
    // idle: the real effect's start-up tail (~0.25 s) then the warm-up (~450 blocks)
    let maxAbs = 0;
    let warmBlocks = 0;
    for (let i = 0; i < 700; i++) {
      const before = warm._warm?.blocks ?? -1;
      const o1 = block(warm, null, frame);
      const o2 = block(cold, null, frame);
      if (warm._warm && warm._warm.blocks > before) warmBlocks++;
      for (let k = 0; k < 128; k++) maxAbs = Math.max(maxAbs, Math.abs(o1[k]), Math.abs(o2[k]));
      frame += 128;
    }
    expect(maxAbs).toBe(0); // exactly silent throughout
    expect(warm._warmStarted).toBe(true);
    expect(warm._warm).toBeNull(); // done and dropped
    expect(warmBlocks).toBeGreaterThan(400);
    // a real clip through both: bit-identical (the warm-up ran on its own scratch effect)
    const x = resample(CLIP.samples, CLIP.sampleRate, SR);
    for (const p of [warm, cold]) p.onMessage({ type: 'clip', samples: CLIP.samples.slice(), rate: CLIP.sampleRate, startTime: frame / SR });
    let diff = 0;
    let wet = 0;
    for (let i = 0; i + 128 <= x.length + 128 * 40; i += 128) {
      const inp = new Float32Array(128);
      if (i < x.length) inp.set(x.subarray(i, Math.min(x.length, i + 128)));
      const a = block(warm, inp, frame);
      const b = block(cold, inp, frame);
      for (let k = 0; k < 128; k++) {
        if (a[k] !== b[k]) diff++;
        wet += Math.abs(a[k] - inp[k]);
      }
      frame += 128;
    }
    expect(diff).toBe(0);
    expect(wet).toBeGreaterThan(1); // (the effect really processed the clip)
  });

  it('stops at once when a clip arrives during the warm-up', () => {
    const p = new Processor({ processorOptions: { character: 'natural', amount: 0 } });
    let frame = 0;
    // natural: the real effect is a bypass, so the warm-up starts immediately
    for (let i = 0; i < 20; i++) { block(p, null, frame); frame += 128; }
    expect(p._warmStarted).toBe(true);
    expect(p._warm).not.toBeNull();
    p.onMessage({ type: 'clip', samples: new Float32Array(2400), rate: 24000, startTime: frame / SR });
    block(p, new Float32Array(128), frame);
    expect(p._warm).toBeNull();
  });
});
