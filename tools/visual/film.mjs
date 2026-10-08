#!/usr/bin/env node
// Frame sequence of the avatar harness's speech simulation (say=<text>): loads the page once,
// steps the deterministic simulation with window.__seek(t) and saves one PNG per frame, e.g.
//
//   node tools/visual/film.mjs --url "http://127.0.0.1:5173/dev/avatar.html?ui=0&idle=0&caption=1" \
//        --say "Hello! I'm Claude. How are you feeling today?" --fps 30 --dur 4 --out out/film
//   ffmpeg -framerate 30 -i out/film/%04d.png -pix_fmt yuv420p out/film.mp4
//
// Options: --t0 <s> (start), --w/--h (canvas CSS px), --selector (default #avatarView).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function parseArgs(argv) {
  const a = { w: 392, h: 584, fps: 30, dur: 4, t0: 0, selector: '#avatarView' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1];
    i++;
  }
  for (const k of ['w', 'h', 'fps', 'dur', 't0']) a[k] = Number(a[k]);
  if (!a.url || !a.say || !a.out) throw new Error('usage: film.mjs --url <harness url> --say <text> --out <dir> [--fps 30 --dur 4 --t0 0]');
  return a;
}

const a = parseArgs(process.argv.slice(2));
const out = resolve(a.out);
mkdirSync(out, { recursive: true });
const url = new URL(a.url);
url.searchParams.set('say', a.say);
url.searchParams.set('t', String(a.t0));
url.searchParams.set('w', String(a.w));
url.searchParams.set('h', String(a.h));
const browser = await chromium.launch({ args: GL_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: a.w, height: a.h } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(url.href);
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(err);
  const el = await page.$(a.selector);
  const n = Math.round(a.dur * a.fps);
  for (let i = 0; i < n; i++) {
    const t = a.t0 + i / a.fps;
    await page.evaluate((tt) => window.__seek(tt), t);
    await el.screenshot({ path: `${out}/${String(i).padStart(4, '0')}.png` });
  }
  console.log(`saved ${n} frames to ${out}`);
} finally {
  await browser.close();
}
