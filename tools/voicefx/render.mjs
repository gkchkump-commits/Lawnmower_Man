#!/usr/bin/env node
// Render voice characters offline with the app's own DSP (src/audio/voicefx.js), e.g. to make
// demo files or to tune a preset on real Kokoro speech.
//
//   node tools/voicefx/render.mjs [--rate 48000] [--out DIR] [--characters synth,robot]
//                                 [--amounts 0.4,0.6,0.9] [--dry] in1.wav [in2.wav ...]
//
// Each input (any WAV the app can decode) is resampled to --rate (default 48 kHz, what the
// AudioContext runs at on Windows) and written as <out>/<name>.<character>-<amount>.wav,
// plus <name>.natural.wav with --dry. Prints the render time per second of audio.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { resample } from '../../src/audio/dsp.js';
import { decodeWav, encodeWav } from '../../src/audio/wav.js';
import { VOICE_CHARACTERS, renderVoiceFx } from '../../src/audio/voicefx.js';

const args = process.argv.slice(2);
const opt = { rate: 48000, out: '.', characters: VOICE_CHARACTERS.filter((c) => c !== 'natural'), amounts: [0.4, 0.6, 0.9], dry: false };
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--rate') opt.rate = Number(args[++i]);
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--characters') opt.characters = args[++i].split(',');
  else if (a === '--amounts') opt.amounts = args[++i].split(',').map(Number);
  else if (a === '--dry') opt.dry = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: node tools/voicefx/render.mjs [--rate 48000] [--out DIR] [--characters a,b] [--amounts 0.4,0.6,0.9] [--dry] in.wav ...');
    process.exit(0);
  } else inputs.push(a);
}
if (!inputs.length) {
  console.error('no input WAV files (see --help)');
  process.exit(2);
}
mkdirSync(opt.out, { recursive: true });

let audioSec = 0;
let renderMs = 0;
for (const file of inputs) {
  const d = decodeWav(readFileSync(file));
  const x = d.sampleRate === opt.rate ? d.samples : resample(d.samples, d.sampleRate, opt.rate);
  const name = path.basename(file).replace(/\.wav$/i, '');
  if (opt.dry) writeFileSync(path.join(opt.out, `${name}.natural.wav`), Buffer.from(encodeWav(x, opt.rate)));
  for (const character of opt.characters) {
    for (const amount of opt.amounts) {
      const t0 = performance.now();
      const y = renderVoiceFx(x, opt.rate, { character: /** @type {any} */ (character), amount });
      renderMs += performance.now() - t0;
      audioSec += x.length / opt.rate;
      writeFileSync(path.join(opt.out, `${name}.${character}-${amount}.wav`), Buffer.from(encodeWav(y, opt.rate)));
    }
  }
}
if (audioSec) console.log(`rendered ${audioSec.toFixed(1)} s of audio in ${renderMs.toFixed(0)} ms (${(renderMs / audioSec).toFixed(1)} ms per second of audio at ${opt.rate} Hz)`);
