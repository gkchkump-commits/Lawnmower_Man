#!/usr/bin/env node
// Frame sequence (and an MP4 with the sound) of the avatar harness's deterministic speech runs:
// loads the page once, steps the simulation with window.__seek(t) and saves one PNG per frame.
//
//   system voice (say=<text>, a scripted voice with word boundaries):
//   node tools/visual/film.mjs --url "http://127.0.0.1:5173/dev/avatar.html?ui=0&idle=0&caption=1" \
//        --say "Hello! I'm Claude. How are you feeling today?" --fps 30 --dur 4 --out out/film
//
//   local voice (real /tts clips: name.json with text + visemes [+ audioB64], name.wav next to it):
//   node tools/visual/film.mjs --url "http://127.0.0.1:5173/dev/avatar.html?ui=0&caption=1" \
//        --clip a.json,b.json --fps 30 --t0 -0.6 --out out/film --mp4 out/film.mp4
//
// --clip serves the files to the page itself (no copy into public/), --dur defaults to the clips'
// length plus 0.8 s, and --mp4 muxes the clips' audio in at the same times (ffmpeg on PATH or
// /usr/bin/ffmpeg). Options: --t0 <s> (start), --w/--h (canvas CSS px), --selector (#avatarView).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { bytesToBase64, decodeWav, encodeWav } from '../../src/audio/wav.js';

const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function parseArgs(argv) {
  const a = { w: 392, h: 584, fps: 30, t0: 0, selector: '#avatarView' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1];
    i++;
  }
  for (const k of ['w', 'h', 'fps', 'dur', 't0']) if (a[k] !== undefined) a[k] = Number(a[k]);
  if (!a.url || !(a.say || a.clip) || !a.out) {
    throw new Error('usage: film.mjs --url <harness url> (--say <text> | --clip a.json,b.json) --out <dir> [--fps 30 --dur 4 --t0 0 --mp4 out.mp4]');
  }
  return a;
}

/** A clip's /tts JSON with the WAV next to it inlined as audioB64. @param {string} path */
function loadClip(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const wavPath = path.replace(/\.json$/, '.wav');
  const wav = j.audioB64 ? Buffer.from(j.audioB64, 'base64') : readFileSync(wavPath);
  return { json: { ...j, audioB64: j.audioB64 || bytesToBase64(new Uint8Array(wav)) }, wav: decodeWav(new Uint8Array(wav)) };
}

const a = parseArgs(process.argv.slice(2));
const out = resolve(a.out);
mkdirSync(out, { recursive: true });
const url = new URL(a.url);
const clips = a.clip ? String(a.clip).split(',').map((p) => loadClip(resolve(p))) : [];
if (a.say) url.searchParams.set('say', a.say);
if (clips.length) url.searchParams.set('clip', clips.map((_, i) => `__clips/${i}.json`).join(','));
url.searchParams.set('t', String(a.t0));
url.searchParams.set('w', String(a.w));
url.searchParams.set('h', String(a.h));
const browser = await chromium.launch({ args: GL_ARGS });
let schedule = null;
let n = 0;
try {
  const page = await browser.newPage({ viewport: { width: a.w, height: a.h } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.route('**/__clips/*.json', (route) => {
    const i = Number(route.request().url().match(/__clips\/(\d+)\.json/)?.[1]);
    const c = clips[i];
    return c ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(c.json) }) : route.fulfill({ status: 404, body: '' });
  });
  await page.goto(url.href);
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(err);
  schedule = await page.evaluate(() => window.__schedule || null);
  const dur = Number.isFinite(a.dur) ? a.dur : (schedule?.length ? schedule[schedule.length - 1].end + 0.8 - a.t0 : 4);
  const el = await page.$(a.selector);
  n = Math.round(dur * a.fps);
  for (let i = 0; i < n; i++) {
    const t = a.t0 + i / a.fps;
    await page.evaluate((tt) => window.__seek(tt), t);
    await el.screenshot({ path: `${out}/${String(i).padStart(4, '0')}.png` });
  }
  console.log(`saved ${n} frames to ${out}`);
} finally {
  await browser.close();
}

if (a.mp4) {
  const ffmpeg = existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
  const args = ['-y', '-loglevel', 'error', '-framerate', String(a.fps), '-i', `${out}/%04d.png`];
  if (clips.length && schedule) {
    // the clips' audio at the times the harness played them (frame i shows time t0 + i / fps)
    const sr = clips[0].wav.sampleRate;
    if (clips.some((c) => c.wav.sampleRate !== sr)) throw new Error('--mp4: the clips must share one sample rate');
    const mix = new Float32Array(Math.ceil((n / a.fps) * sr));
    clips.forEach((c, k) => {
      const at = Math.round((schedule[k].start - a.t0) * sr);
      const s = c.wav.samples;
      for (let i = 0; i < s.length; i++) if (at + i >= 0 && at + i < mix.length) mix[at + i] += s[i];
    });
    const wavPath = `${out}/audio.wav`;
    writeFileSync(wavPath, Buffer.from(encodeWav(mix, sr)));
    args.push('-i', wavPath, '-c:a', 'aac', '-b:a', '160k');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', '-shortest', resolve(a.mp4));
  execFileSync(ffmpeg, args, { stdio: 'inherit' });
  console.log(`wrote ${resolve(a.mp4)}`);
}
