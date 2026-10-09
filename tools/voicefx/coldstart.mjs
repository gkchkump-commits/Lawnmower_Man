#!/usr/bin/env node
// Cold start of the voice character worklet (non-gating benchmark): the CPU time the effect needs
// for the first 75 blocks (200 ms at 48 kHz) of the first clip of a session vs the second, with
// and without the processor's warm-up. Each run is a fresh Node process (a fresh V8: nothing
// compiled yet), like the audio thread of a fresh app start.
//
//   node tools/voicefx/coldstart.mjs [--runs 3] [--rate 48000] [clip.wav]
//
// Expect "first / second" close to 1 with the warm-up (the target is <= 1.5) and well above it
// without, and no block of the first clip over the 2.7 ms budget. Times are wall-clock in Node,
// so they are only comparable within one machine (a shared vCPU adds noise of its own).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);

if (process.env.LM_COLDSTART_CHILD) {
  // ---- child: one fresh "audio thread"
  const rate = Number(process.env.LM_COLDSTART_RATE);
  const warmUp = process.env.LM_COLDSTART_WARM === '1';
  const { decodeWav } = await import(pathToFileURL(path.join(root, 'src/audio/wav.js')).href);
  const { resample } = await import(pathToFileURL(path.join(root, 'src/audio/dsp.js')).href);
  let Processor = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
  globalThis.registerProcessor = (_n, cls) => { Processor = cls; };
  globalThis.sampleRate = rate;
  globalThis.currentFrame = 0;
  await import(pathToFileURL(path.join(root, 'src/audio/voicefx-worklet.js')).href);
  const clip = decodeWav(readFileSync(process.env.LM_COLDSTART_CLIP));
  const x = resample(clip.samples, clip.sampleRate, rate);
  const p = new Processor({ processorOptions: { character: 'synth', amount: 0.6, warmUp } });
  let frame = 0;
  const out = new Float32Array(128);
  const step = (inp) => { globalThis.currentFrame = frame; p.process([inp ? [inp] : []], [[out]]); frame += 128; };
  // 3 s of idle (the app waiting for the first reply)
  for (let i = 0; i < Math.round((3 * rate) / 128); i++) step(null);
  const res = [];
  for (let c = 0; c < 2; c++) {
    p.onMessage({ type: 'clip', samples: clip.samples.slice(), rate: clip.sampleRate, startTime: frame / rate });
    let ms = 0;
    let over = 0;
    let worst = 0;
    const budget = (128 / rate) * 1000;
    const inp = new Float32Array(128);
    for (let i = 0, b = 0; i < x.length; i += 128, b++) {
      inp.fill(0);
      inp.set(x.subarray(i, Math.min(x.length, i + 128)));
      const t0 = performance.now();
      step(inp);
      const d = performance.now() - t0;
      if (b < 75) ms += d;
      if (d > budget) over++;
      worst = Math.max(worst, d);
    }
    res.push([ms, over, worst]);
    for (let i = 0; i < Math.round((0.8 * rate) / 128); i++) step(null); // the gap to the next clip
  }
  process.stdout.write(JSON.stringify(res));
  process.exit(0);
}

const runs = Number(opt('runs', 3));
const rate = Number(opt('rate', 48000));
const clipPath = path.resolve(args.find((a, i) => a.endsWith('.wav') && args[i - 1] !== '--rate') || path.join(root, 'tests/fixtures/kokoro/maybe_af_heart.wav'));
for (const warm of [false, true]) {
  const rows = [];
  for (let r = 0; r < runs; r++) {
    const outp = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, LM_COLDSTART_CHILD: '1', LM_COLDSTART_RATE: String(rate), LM_COLDSTART_WARM: warm ? '1' : '0', LM_COLDSTART_CLIP: clipPath },
    }).toString();
    rows.push(JSON.parse(outp));
  }
  const fmt = rows.map(([a, b]) => `${a[0].toFixed(1)} / ${b[0].toFixed(1)} ms (x${(a[0] / b[0]).toFixed(2)}; over budget ${a[1]} / ${b[1]}, worst ${a[2].toFixed(1)} / ${b[2].toFixed(1)} ms)`).join('\n    ');
  console.log(`${warm ? 'with warm-up' : 'without warm-up'}: first 75 blocks of clip 1 / clip 2:\n    ${fmt}`);
}
