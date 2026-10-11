// Helpers for tests/e2e/wake.spec.js: speech clips and a scripted microphone.
//
// The clips are cut at test time from the Kokoro recordings already committed for the lip-sync
// tests (tests/fixtures/kokoro*), resampled to 48 kHz with the app's own Resampler. The mock
// spotter (src/bridge/mock-wake.js) decides from energy onsets and the fake /stt answers from a
// queue, so the words do not matter here, only the timing (the real engine on the "Hey Jade"
// fixtures is lane A's engine test and lane C's Electron e2e).
//
// The scripted microphone replaces getUserMedia() with a MediaStream from an AudioContext that
// plays a quiet room and, on command, a clip (window.__mic.say(name)): the test decides exactly
// when the user speaks (the follow-up window's 2 s / 6.5 s). Everything after getUserMedia — the
// Mic's AudioContext, worklet, resampler, VAD, tap, ring — is the app's real code. The tests that
// need the device itself (the track, Chromium's fake capture file) use the real path.
/* global AudioContext, DOMException */

import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resampler } from '../../src/audio/dsp.js';
import { decodeWav, encodeWav } from '../../src/audio/wav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RATE = 48000;

/** @param {string} rel @returns {Float32Array} 48 kHz mono */
function load(rel) {
  const d = decodeWav(new Uint8Array(readFileSync(path.join(ROOT, rel))));
  const r = new Resampler(d.sampleRate, RATE);
  const a = r.process(d.samples);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** [t0, t1) seconds of x, with 20 ms fades @param {Float32Array} x @param {number} t0 @param {number} t1 */
function cut(x, t0, t1) {
  const y = x.slice(Math.round(t0 * RATE), Math.round(t1 * RATE));
  const f = Math.round(0.02 * RATE);
  for (let i = 0; i < f && i < y.length; i++) {
    y[i] *= i / f;
    y[y.length - 1 - i] *= i / f;
  }
  return y;
}

/** @param {...(Float32Array|number)} parts clips and seconds of silence */
function join(...parts) {
  const arrs = parts.map((p) => (typeof p === 'number' ? new Float32Array(Math.round(p * RATE)) : p));
  const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

let cached = null;

/**
 * The clips (48 kHz):
 *   oneBreath  2.0 s of continuous speech: "Hey Jade, what time is it?"
 *   heyJade    0.7 s: "Hey Jade."
 *   command    2.0 s: "What's the weather tomorrow?"
 *   pause      heyJade + 1.5 s + command (the contract's `pause` fixture)
 *   followUp   1.4 s: "And tomorrow?"
 */
export function clips() {
  if (cached) return cached;
  const a = load('tests/fixtures/kokoro-af_heart.wav');
  const maybe = load('tests/fixtures/kokoro/maybe_af_heart.wav');
  const line = load('tests/fixtures/kokoro/testline_af_heart.wav');
  const heyJade = cut(maybe, 0, 0.72);
  const command = cut(maybe, 0, 2.05);
  cached = {
    oneBreath: cut(a, 0, 2.0),
    heyJade,
    command,
    pause: join(heyJade, 1.5, command),
    followUp: cut(line, 1.72, 3.15),
  };
  return cached;
}

/** A WAV file for Chromium's fake capture device: silence, speech, silence (it loops). */
export function fakeCaptureFile() {
  const c = clips();
  let seed = 3;
  const noise = (sec) => {
    const x = new Float32Array(Math.round(sec * RATE));
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      x[i] = ((seed / 4294967296) * 2 - 1) * 0.0008;
    }
    return x;
  };
  const x = join(noise(1.5), c.oneBreath, noise(2.5), c.command, noise(2));
  const file = path.join(os.tmpdir(), `lawnmower-e2e-wake-${process.pid}.wav`);
  writeFileSync(file, Buffer.from(encodeWav(x, RATE)));
  return file;
}

/** Runs in the page before the app: getUserMedia → the scripted microphone (window.__mic). */
export function scriptedMicInit() {
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  /** @type {any} */
  const st = { calls: 0, constraints: [], tracks: [], ctx: null, dest: null, bed: null, clips: {}, scripted: true, fail: '', said: [] };
  // @ts-ignore
  window.__mic = st;
  md.getUserMedia = async (c) => {
    st.calls++;
    st.constraints.push(JSON.parse(JSON.stringify(c)));
    if (!st.scripted) return real(c);
    // a microphone that cannot be opened, the way Chromium says so (e.g. 'NotReadableError')
    if (st.fail) throw new DOMException('Could not start audio source', st.fail);
    if (!st.ctx) {
      st.ctx = new AudioContext({ sampleRate: 48000 });
      // a quiet room at about -62 dBFS (a real mic is never digital silence)
      const n = st.ctx.sampleRate * 2;
      const buf = st.ctx.createBuffer(1, n, st.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 1;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = ((seed / 4294967296) * 2 - 1) * 0.0008;
      }
      const bed = st.ctx.createBufferSource();
      bed.buffer = buf;
      bed.loop = true;
      st.bed = st.ctx.createGain();
      bed.connect(st.bed);
      bed.start();
    }
    await st.ctx.resume();
    const dest = st.ctx.createMediaStreamDestination();
    st.bed.connect(dest);
    st.dest = dest;
    st.tracks.push(dest.stream.getAudioTracks()[0]);
    return dest.stream;
  };
  /** @param {string} name @param {string} b64 Float32 PCM at 48 kHz */
  st.load = (name, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    st.clips[name] = new Float32Array(bytes.buffer);
  };
  /** play a clip into the microphone; resolves when it has been played @param {string} name */
  st.say = (name) => new Promise((resolve, reject) => {
    const x = st.clips[name];
    if (!x || !st.ctx || !st.dest) {
      reject(new Error(`cannot say ${name}: ${!x ? 'no such clip' : 'the microphone is not open'}`));
      return;
    }
    const buf = st.ctx.createBuffer(1, x.length, 48000);
    buf.copyToChannel(x, 0);
    const src = st.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(st.dest);
    src.onended = () => resolve(true);
    st.said.push({ name, at: performance.now() });
    src.start();
  });
}

/** Load every clip into the page's scripted microphone. @param {import('@playwright/test').Page} page */
export async function loadClips(page) {
  for (const [name, x] of Object.entries(clips())) {
    const b64 = Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64');
    await page.evaluate(([n, b]) => window.__mic.load(n, b), [name, b64]);
  }
}

/** Requests that leave the PC are recorded and refused. @param {import('@playwright/test').Page} page */
export async function loopbackOnly(page) {
  const blocked = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  return blocked;
}
