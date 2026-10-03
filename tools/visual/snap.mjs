#!/usr/bin/env node
// Headless Chromium screenshot tool (SwiftShader WebGL) for visual checks — usable by every lane.
//
//   node tools/visual/snap.mjs --url http://127.0.0.1:5181/dev/avatar.html?fixedTime=1&ui=0 \
//        --out shot.png [--w 392 --h 584] [--wait-ready] [--selector '#stage'] [--timeout 90000]
//        [--dpr 1] [--delay 0] [--quiet]
//   node tools/visual/snap.mjs --batch shots.json [--wait-ready]
//        shots.json = [{ "url": "...", "out": "a.png", "w": 392, "h": 584, "selector": "#stage" }, ...]
//
// --wait-ready waits for window.__ready === true (pages set window.__error to fail fast).
// Exit code: 0 ok, 1 usage / navigation / timeout error, 2 page reported an error.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function parseArgs(argv) {
  const a = { w: 392, h: 584, dpr: 1, timeout: 90000, delay: 0, waitReady: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${k}`);
      return argv[++i];
    };
    switch (k) {
      case '--url': a.url = next(); break;
      case '--out': a.out = next(); break;
      case '--w': a.w = Number(next()); break;
      case '--h': a.h = Number(next()); break;
      case '--dpr': a.dpr = Number(next()); break;
      case '--selector': a.selector = next(); break;
      case '--timeout': a.timeout = Number(next()); break;
      case '--delay': a.delay = Number(next()); break;
      case '--batch': a.batch = next(); break;
      case '--wait-ready': a.waitReady = true; break;
      case '--quiet': a.quiet = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

async function shoot(browser, job, defaults) {
  const w = job.w ?? defaults.w, h = job.h ?? defaults.h;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: job.dpr ?? defaults.dpr });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    else if (!defaults.quiet && (m.type() === 'warning' || m.type() === 'warn')) process.stderr.write(`[page warn] ${m.text()}\n`);
  });
  const t0 = Date.now();
  try {
    await page.goto(job.url, { waitUntil: 'load', timeout: defaults.timeout });
    if (job.waitReady ?? defaults.waitReady) {
      await page.waitForFunction(() => window.__ready === true || !!window.__error, null,
        { timeout: defaults.timeout, polling: 100 });
      const err = await page.evaluate(() => window.__error || null);
      if (err) throw Object.assign(new Error(`page reported: ${err}`), { code: 2 });
    }
    const delay = job.delay ?? defaults.delay;
    if (delay > 0) await page.waitForTimeout(delay);
    mkdirSync(dirname(resolve(job.out)), { recursive: true });
    const selector = job.selector ?? defaults.selector;
    if (selector) await page.locator(selector).first().screenshot({ path: job.out, animations: 'disabled' });
    else await page.screenshot({ path: job.out, animations: 'disabled' });
    if (!defaults.quiet) console.log(`saved ${job.out} (${w}x${h}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    for (const e of errors) process.stderr.write(`[${job.out}] ${e}\n`);
  } finally {
    await context.close();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  if (args.help || (!args.batch && (!args.url || !args.out))) {
    console.log('usage: node tools/visual/snap.mjs --url <url> --out <png> [--w 392 --h 584] [--wait-ready] [--selector css] [--batch jobs.json]');
    process.exit(args.help ? 0 : 1);
  }
  const jobs = args.batch ? JSON.parse(await readFile(args.batch, 'utf8')) : [{ url: args.url, out: args.out }];
  const browser = await chromium.launch({ args: GL_ARGS });
  let code = 0;
  try {
    for (const job of jobs) {
      try {
        await shoot(browser, job, args);
      } catch (e) {
        console.error(`failed ${job.out}: ${e.message || e}`);
        code = e.code === 2 ? 2 : 1;
      }
    }
  } finally {
    await browser.close();
  }
  process.exit(code);
}

main();
