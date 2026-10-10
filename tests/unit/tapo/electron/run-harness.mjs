#!/usr/bin/env node
// Run the lane A Electron harness (harness-main.mjs) in the real Electron binary.
//
//   xvfb-run -a node tests/unit/tapo/electron/run-harness.mjs [--screenshot out.png] [--verbose]
//
// Needs vendor/go2rtc (npm run fetch:go2rtc) and a display (xvfb-run on headless Linux).
// Exit code: 0 all checks passed, 1 a check failed, 2 cannot run here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { go2rtcBinaryPath } from '../../../../electron/tapo/go2rtc.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const argv = process.argv.slice(2);
const shotIdx = argv.indexOf('--screenshot');
const shot = shotIdx >= 0 ? path.resolve(argv[shotIdx + 1]) : '';

const go2rtc = go2rtcBinaryPath({ isPackaged: false, appRoot: root, env: process.env });
if (!fs.existsSync(go2rtc)) {
  console.error(`go2rtc is missing (${go2rtc}); run npm run fetch:go2rtc first.`);
  process.exit(2);
}
let electron = process.env.ELECTRON_PATH;
try {
  electron ||= require('electron');
} catch (err) {
  console.error(`Electron is not installed (${err.message}).`);
  process.exit(2);
}
const args = [path.join(here, 'harness-main.mjs')];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
const env = { ...process.env, HARNESS_SCREENSHOT: shot, ...(argv.includes('--verbose') ? { HARNESS_VERBOSE: '1' } : {}) };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
const timer = setTimeout(() => {
  console.error('harness timed out (180 s)');
  child.kill('SIGKILL');
}, 180_000);
child.on('close', (code) => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.startsWith('HARNESS_RESULT '));
  if (!line) {
    console.error(`no result from the harness (exit ${code})\n${out.slice(-4000)}`);
    process.exit(1);
  }
  const r = JSON.parse(line.slice('HARNESS_RESULT '.length));
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed) console.log(r.logTail.join('\n'));
  process.exit(r.failed ? 1 : 0);
});
