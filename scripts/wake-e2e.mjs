#!/usr/bin/env node
// End-to-end test of "Hey Jade" in the REAL Electron app (contract-wake §11.6): the real
// "Jade wake word" utility process with the real sherpa-onnx addon and both keyword models, the
// renderer's real microphone path (Chromium's fake capture device playing the committed Kokoro
// fixtures through getUserMedia → AEC/NS/AGC → AudioWorklet → 16 kHz tap → MessagePort), stage 2 on
// the fake voice server (/stt answers from LAWNMOWER_VOICE_FAKE_TEXTS), the real controller, state
// machine and UI, and the fake Claude CLI:
//
//    1. the engine: ready with both models and the VAD; a "Jade wake word" utility row in
//       app.getAppMetrics(); the persona the CLI gets names Jade and has the wake-word section
//    2. silence: the utility's CPU ≤ 3 % of one core over 20 s, no /stt call
//    3. "Hey Jade, what time is it?": a real stage-1 hit → attention → listening (one chime) → one
//       message "what time is it?" → the fake CLI's reply → a ~6 s follow-up window → waiting;
//       /stt saw only the wake segment (≤ 2.65 s) and the command
//    4. follow-up: an utterance without her name inside the window is sent; one after it closed
//       is never transcribed
//    5. "Hey Jude, don't make it bad." / "Hey Jude.": nothing is sent, no chime
//    6. self-mask: stage 1 fires on her own line "Just say hey Jade…" while she says it → ignored
//       ("my own voice"): no attention, no duck, no /stt
//    7. barge-in: "Hey Jade, …" while she reads a long reply → her voice ducks (≥ 10 dB) → stops
//       after the check; "stop" interrupts locally (nothing sent to Claude)
//    8. hidden: the window hidden in the tray → "Hey Jade." → the window is shown again
//    9. PC locked: the microphone track ends within 1 s; unlocked → waiting again
//   10. the utility crashes → it restarts, the renderer takes the new port, a wake works again
//   11. speech without her name, looped: the utility's CPU is reported (≤ 15 % of one core)
//   12. no request left the PC, the utility has no TCP/UDP socket (Linux), no audio file was
//       written, no console errors; quitting ends the utility and the voice server
//
// One launch serves every scenario: each one writes a new fake-capture WAV and a new /stt queue,
// then reopens the microphone (Chromium reads the file afresh for every capture stream, so the
// clip plays from its start). Silence in the WAVs is seeded white noise at -60 dBFS.
//
//   npx vite build && xvfb-run -a node scripts/wake-e2e.mjs [--shots <dir>] [--report <file.json>]
//        [--keep | --work <dir>] [--verbose] [--only engine,positive,…] [--b-only]
//   ELECTRON_PATH=…  LAWNMOWER_WAKE_DIR=<wake dir> (default vendor/wake)
//   LAWNMOWER_WAKE_ZHEN_DIR=<zh-en model dir> (default vendor/wake/dev-models/zh-en-3m)
//   LAWNMOWER_E2E_PYTHON=<python with fastapi, uvicorn, numpy> (default: python3 / python on PATH)
//
// Needs lanes A and B of the wake word (electron/wake/, src/wake/, their wiring in main.js and the
// preload), the engine (`npm run fetch:wake -- --with-zhen`), a renderer build (dist/), the
// Electron binary, a Python for the fake voice server and a display (xvfb-run on headless Linux).
// When something is missing it prints why and exits 0 ("skipped"); with WAKE_ENGINE_REQUIRED=1
// (CI) a missing piece exits 2 instead. Prints a JSON report; exit 1 = a check failed.
// Uses throwaway folders; never touches your settings.
/* global MutationObserver, PerformanceObserver */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Resampler } from '../src/audio/dsp.js';
import { decodeWav, encodeWav } from '../src/audio/wav.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');
const argOf = (/** @type {string} */ name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const shotsDir = argOf('--shots') ? path.resolve(argOf('--shots')) : '';
const reportFile = argOf('--report') ? path.resolve(argOf('--report')) : '';
const only = argOf('--only') ? new Set(argOf('--only').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const required = process.env.WAKE_ENGINE_REQUIRED === '1';
// --b-only: as on a PC where the extra zh-en model is not downloaded yet (GigaSpeech alone)
const bOnly = argv.includes('--b-only');

/** @type {Record<string, any>} */
const report = { ok: false, checks: {}, measure: {}, timings: {} };

/** A prerequisite is missing: skip (exit 0), or exit 2 when the wake word is required (CI). @param {string} why */
function cannotRun(why) {
  report.skipped = why;
  report.ok = !required;
  console.log(JSON.stringify(report, null, 2));
  console.error(`wake-e2e: ${required ? 'cannot run' : 'skipped'}: ${why}`);
  process.exit(required ? 2 : 0);
}

// ---------------------------------------------------------------------------------------------
// prerequisites

const has = (/** @type {string} */ rel) => fs.existsSync(path.join(root, rel));
const read = (/** @type {string} */ rel) => (has(rel) ? fs.readFileSync(path.join(root, rel), 'utf8') : '');
if (!has('electron/wake/index.js') || !has('electron/wake/utility/main.js')) cannotRun('electron/wake/ (the wake-word engine, lane A) is not in this checkout');
if (!has('src/wake/feature.js')) cannotRun('src/wake/ (the wake word in the renderer, lane B) is not in this checkout');
if (!/createWake\(/.test(read('electron/main.js'))) cannotRun('electron/main.js does not call createWake() yet (the orchestrator wiring, contract-wake §3.2)');
if (!/lm:wake:request-port/.test(read('electron/preload.cjs'))) cannotRun('electron/preload.cjs has no wake namespace yet (contract-wake §6.2)');
const FIXTURES = path.join(root, 'tests/fixtures/wake');
if (!fs.existsSync(path.join(FIXTURES, 'manifest.tsv'))) cannotRun('tests/fixtures/wake/manifest.tsv is missing (lane A fixtures)');
if (!has('dist/index.html')) cannotRun('dist/index.html is missing: run `npx vite build` first');
const distAssets = path.join(root, 'dist/assets');
const distHasWake = fs.existsSync(distAssets) && fs.readdirSync(distAssets).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(distAssets, f), 'utf8').includes('lm:wake:port'));
if (!distHasWake) cannotRun('dist/ was built without the wake word: run `npx vite build` again');

const platformKey = `${process.platform}-${process.arch}`;
const wakeDir = path.resolve(process.env.LAWNMOWER_WAKE_DIR || path.join(root, 'vendor/wake'));
const addon = path.join(wakeDir, 'sherpa-onnx', platformKey, 'sherpa-onnx.node');
if (!fs.existsSync(addon)) cannotRun(`the wake-word engine is not fetched for ${platformKey} (${addon}): run \`npm run fetch:wake -- --with-zhen\``);
const zhenDir = path.resolve(process.env.LAWNMOWER_WAKE_ZHEN_DIR || path.join(wakeDir, 'dev-models/zh-en-3m'));
const hasZhen = !bOnly && fs.existsSync(path.join(zhenDir, 'tokens.txt'));
if (!hasZhen && !bOnly && required) cannotRun(`the zh-en model is missing (${zhenDir}): run \`npm run fetch:wake -- --with-zhen\``);

let executablePath = process.env.ELECTRON_PATH;
if (!executablePath) {
  try {
    executablePath = require('electron');
  } catch (err) {
    cannotRun(`Electron binary not available (${/** @type {Error} */ (err).message}); set ELECTRON_PATH`);
  }
}

/** A Python that can run the fake voice server (voice/: fastapi, uvicorn, numpy). */
function findPython() {
  const candidates = [process.env.LAWNMOWER_E2E_PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(/** @type {string} */ (c), ['-c', 'import sys, fastapi, uvicorn, numpy; print(sys.executable)'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/).pop();
  }
  return '';
}
const python = findPython();
if (!python) cannotRun('no Python with fastapi, uvicorn and numpy for the fake voice server (pip install -e "./voice[dev]", or set LAWNMOWER_E2E_PYTHON)');

const { _electron: electron } = require('@playwright/test');

// ---------------------------------------------------------------------------------------------
// report helpers

/** @param {string} name @param {unknown} cond @param {unknown} [detail] */
function check(name, cond, detail) {
  report.checks[name] = cond ? 'ok' : `FAILED${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`;
  if (!cond) report.failed = (report.failed || 0) + 1;
  if (verbose || !cond) console.error(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  return !!cond;
}
/** @param {string} key @param {unknown} value */
function measure(key, value) {
  report.measure[key] = value;
  if (verbose) console.error(`[measure] ${key}: ${JSON.stringify(value)}`);
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Poll fn until it returns something truthy (or ms pass): the value, or null on timeout.
 * @template T @param {() => T|Promise<T>} fn @param {number} ms @returns {Promise<T|null>}
 */
async function until(fn, ms, interval = 100) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(interval);
  }
}
/** @param {string} label @param {() => Promise<void>} fn */
async function step(label, fn) {
  if (only && !only.has(label) && label !== 'engine') return;
  const t0 = Date.now();
  if (verbose) console.error(`--- ${label}`);
  try {
    await fn();
  } catch (err) {
    check(`${label}: ran to the end`, false, String(/** @type {Error} */ (err).stack || err).slice(0, 900));
  }
  report.timings[label] = Date.now() - t0;
}

// ---------------------------------------------------------------------------------------------
// audio: the committed Kokoro fixtures (16 kHz) → 48 kHz WAVs for Chromium's fake capture device

const RATE = 48000;
const KWS_RATE = 16000;
/** @type {Map<string, { id: string, cls: string, text: string, jadeEndSec: number }>} */
const manifest = new Map();
for (const line of fs.readFileSync(path.join(FIXTURES, 'manifest.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  const [id, cls, text, , , jadeEnd] = line.split('\t');
  if (id) manifest.set(id, { id, cls, text, jadeEndSec: Number(jadeEnd) });
}
/** @type {Map<string, Float32Array>} */
const clipCache = new Map();
/** A fixture at 48 kHz (the app's own Resampler). @param {string} id */
function clip(id) {
  if (!clipCache.has(id)) {
    const d = decodeWav(new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${id}.wav`))));
    const r = new Resampler(d.sampleRate, RATE);
    const a = r.process(d.samples);
    const b = r.flush();
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    clipCache.set(id, out);
  }
  return /** @type {Float32Array} */ (clipCache.get(id));
}
const clipSec = (/** @type {string} */ id) => clip(id).length / RATE;
let noiseSeed = 0x9e3779b9;
/** Seeded white noise at -60 dBFS RMS (a quiet room; exact zeros would look like a dead mic). @param {number} sec */
function noise(sec) {
  const n = Math.max(0, Math.round(sec * RATE));
  const out = new Float32Array(n);
  const amp = 0.001 * Math.sqrt(3); // uniform in [-a, a] has RMS a/√3
  for (let i = 0; i < n; i++) {
    noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0;
    out[i] = ((noiseSeed / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}
/**
 * Parts → one WAV: a number is seconds of room noise, a string a fixture id (on the noise floor).
 * Returns where each fixture starts (s).
 * @param {string} file @param {Array<number|string>} parts
 */
function writeMicWav(file, parts) {
  const pieces = [];
  /** @type {Array<{ id: string, at: number }>} */
  const at = [];
  let t = 0;
  for (const p of parts) {
    if (typeof p === 'number') {
      pieces.push(noise(p));
      t += p;
    } else {
      const c = clip(p);
      const floor = noise(c.length / RATE);
      const mixed = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) mixed[i] = c[i] + floor[i];
      pieces.push(mixed);
      at.push({ id: p, at: t });
      t += c.length / RATE;
    }
  }
  const out = new Float32Array(pieces.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of pieces) {
    out.set(a, o);
    o += a.length;
  }
  fs.writeFileSync(file, new Uint8Array(encodeWav(out, RATE)));
  return { at, sec: t };
}

// ---------------------------------------------------------------------------------------------
// the app

// --work <dir>: put the run's folders there and keep them (CI uploads the app's logs from it)
const workArg = argOf('--work') ? path.resolve(argOf('--work')) : '';
if (workArg) {
  fs.rmSync(workArg, { recursive: true, force: true });
  fs.mkdirSync(workArg, { recursive: true });
}
const work = workArg || fs.mkdtempSync(path.join(os.tmpdir(), 'lm-wake-e2e-'));
const userData = path.join(work, 'user-data');
fs.mkdirSync(userData);
const noZhen = path.join(work, 'no-zh-en'); // --b-only: model A's folder, empty
fs.mkdirSync(noZhen);
const micFile = path.join(work, 'mic.wav');
const queueFile = path.join(work, 'stt-queue.json');
const sttLog = path.join(work, 'stt-calls.jsonl');
const cliLog = path.join(work, 'fake-claude.jsonl');
writeMicWav(micFile, [10]);
fs.writeFileSync(queueFile, JSON.stringify(['(nothing was queued)']));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  claude: { workdir: path.join(work, 'work'), resumeLastSession: false },
  voice: { enabled: true, pythonPath: python },
  wake: { enabled: true, explained: true },
}));
const env = {
  ...process.env,
  LAWNMOWER_USER_DATA: userData,
  LAWNMOWER_E2E: '1',
  LAWNMOWER_CLAUDE_CLI: path.join(root, 'tests/fixtures/fake-claude.mjs'),
  FAKE_CLAUDE_LOG: cliLog,
  LAWNMOWER_VOICE_ARGS: '--fake',
  // every fake /stt and /tts call takes 200 ms, about what the GPU's Whisper takes for a short
  // segment: with an instant check, the barge-in would stop her before the 60 ms duck ramp ends
  LAWNMOWER_VOICE_FAKE_DELAY_MS: '200',
  LAWNMOWER_VOICE_FAKE_TEXTS: queueFile,
  LAWNMOWER_VOICE_FAKE_STT_LOG: sttLog,
  LAWNMOWER_WAKE_DIR: wakeDir,
  LAWNMOWER_WAKE_ZHEN_DIR: hasZhen ? zhenDir : noZhen,
  // the zh-en download the app starts when model A is missing (python -m lawnmower_voice.download
  // --kws-only) goes to a closed loopback port and a throwaway models folder: no network in tests
  LAWNMOWER_VOICE_KWS_URL: 'http://127.0.0.1:9/',
  LAWNMOWER_VOICE_MODELS: path.join(work, 'voice-models'),
};
delete env.ELECTRON_RUN_AS_NODE;
const args = ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, root];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');

/** @type {any} */
let app = null;
/** @type {any} */
let page = null;
/** @type {string[]} */
const consoleErrors = [];

const e2e = (/** @type {string} */ fn, /** @type {any} */ arg) => app.evaluate((_e, [f, a]) => {
  const w = /** @type {any} */ (globalThis).__lawnmowerE2E?.wake;
  return w && typeof w[f] === 'function' ? w[f](a) : null;
}, [fn, arg]);
const engineStatus = () => e2e('status');
const hits = async () => /** @type {any[]} */ ((await e2e('lastHits')) || []);
/** @param {any[]} list */
const maxHitId = (list) => list.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
const userTexts = () => page.evaluate(() => [...document.querySelectorAll('.msg-user .msg-text')].map((e) => e.textContent || ''));
const replyTexts = () => page.evaluate(() => [...document.querySelectorAll('.msg-claude')].map((e) => e.textContent || ''));
const wakeLog = () => page.evaluate(() => (window.__app.wake?.log || []).map((/** @type {any} */ e) => e.text || e.reason));
const cues = () => page.evaluate(() => window.__app.player.cues);
const sttCalls = () => (fs.existsSync(sttLog) ? fs.readFileSync(sttLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wakeState = () => page.evaluate(() => document.body.dataset.wake);
const settled = () => page.evaluate(() => document.body.dataset.wake === 'waiting' && document.body.dataset.state === 'idle'
  && !window.__app.controller.speech.busy && !window.__app.controller.activeTurnId);
/**
 * Waiting for her name, nothing running, and still so 1.2 s later: right after a reply the state
 * reads "waiting" for the 350 ms tail before the follow-up window opens (contract-wake §8.3 T10).
 */
async function waitSettled(ms = 30000) {
  const end = Date.now() + ms;
  let since = 0;
  while (Date.now() < end) {
    if (await settled().catch(() => false)) {
      if (!since) since = Date.now();
      else if (Date.now() - since >= 1200) return true;
    } else {
      since = 0;
    }
    await sleep(100);
  }
  return false;
}
/** The data-wake changes recorded in the page since index `from`: [state, perf ms, mic sample]. */
const wakesSince = (/** @type {number} */ from) => page.evaluate((f) => window.__wakes.slice(f), from);
const wakeCount = () => page.evaluate(() => window.__wakes.length);
/** @param {string} name */
async function shot(name) {
  if (!shotsDir || !page) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {});
}

let scenarioNo = 0;
/**
 * Start a scenario: write its microphone WAV and /stt queue, then reopen the microphone so the
 * clip plays from its start. The queue restarts whenever the file's bytes change, so each
 * scenario's copy is made unique with JSON whitespace.
 * @param {Array<number|string>} parts @param {string[]} queue
 */
async function scenario(parts, queue) {
  scenarioNo++;
  const wav = writeMicWav(micFile, parts);
  fs.writeFileSync(queueFile, `${JSON.stringify(queue)}${' '.repeat(scenarioNo)}\n`);
  const mark = {
    wakes: await wakeCount(),
    users: (await userTexts()).length,
    replies: (await replyTexts()).length,
    stt: sttCalls().length,
    hitId: maxHitId(await hits()),
    cues: await cues(),
    log: (await wakeLog()).length,
    t: Date.now(),
  };
  const startIdx = await page.evaluate(async () => {
    await window.__app.mic.reopen();
    return window.__app.mic.samplesSeen;
  });
  /** file position (s) of a mic sample index */
  const pos = (/** @type {number} */ idx) => (idx - startIdx) / KWS_RATE;
  return { ...mark, startIdx, pos, wav };
}

/** A user utterance while the window is closed must not be transcribed: the stt calls since mark. @param {{ stt: number }} m */
const newStt = (m) => sttCalls().slice(m.stt);

// ---------------------------------------------------------------------------------------------

const t0 = Date.now();
let utilityPid = 0;
let voicePid = 0;
/** where the follow-up window opened in scenario 3, in seconds of its WAV (for scenario 4) */
let followUpOpenPos = 0;
let followUpCloseAfter = 0;
let testClipsDir = '';
/** @type {string[]} */
let testClipsBefore = [];

try {
  app = await electron.launch({ executablePath, args, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('console', (/** @type {any} */ m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    if (verbose && /\[wake\]/.test(m.text())) console.error(`[renderer] ${m.text()}`);
  });
  page.on('pageerror', (/** @type {Error} */ e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.waitForURL((/** @type {URL} */ u) => u.protocol === 'app:', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  await page.evaluate(() => {
    const rec = () => [document.body.dataset.wake, performance.now(), window.__app.mic?.samplesSeen ?? 0];
    window.__wakes = [rec()];
    new MutationObserver(() => {
      if (window.__wakes.at(-1)[0] !== document.body.dataset.wake) window.__wakes.push(rec());
    }).observe(document.body, { attributes: true, attributeFilter: ['data-wake'] });
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push([e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
  });

  // "Record a test clip" is the only thing that may write audio: <Documents>/Lawnmower Man/Hey Jade tests
  testClipsDir = path.join(String(await app.evaluate(({ app: a }) => a.getPath('documents'))), 'Lawnmower Man', 'Hey Jade tests');
  testClipsBefore = fs.existsSync(testClipsDir) ? fs.readdirSync(testClipsDir) : [];

  await step('engine', async () => {
    const ready = await until(async () => {
      const st = await engineStatus();
      return st && st.engine === 'ready' ? st : null;
    }, 60000, 250);
    report.engine = ready || (await engineStatus());
    check('1 · the wake-word engine is ready', !!ready, report.engine);
    const models = ready?.models || {};
    check(`1 · both keyword models and the VAD loaded (giga ${models.giga}, zh-en ${models.zhen}, vad ${models.vad})`, models.giga === 'ok' && models.vad === 'ok' && (models.zhen === 'ok' || !hasZhen), models);
    if (!hasZhen) {
      report.note = 'without the zh-en model: the GigaSpeech model alone';
      check('1 · without the zh-en model she runs on the basic one and says so', models.zhen !== 'ok' && /basic wake-word model/.test(ready?.detail || ''), ready);
    }
    measure('engine load (ms)', ready?.loadMs ?? null);
    const metrics = /** @type {any[]} */ ((await e2e('metrics')) || []);
    const row = metrics.find((r) => r.name === 'Jade wake word' || r.serviceName === 'Jade wake word');
    check('1 · app.getAppMetrics() lists the "Jade wake word" utility process', !!row && row.type === 'Utility', metrics);
    utilityPid = Number(await e2e('utilityPid')) || row?.pid || 0;
    const waiting = await until(async () => (await wakeState()) === 'waiting', 30000);
    check('1 · the avatar window listens for her name (data-wake = waiting)', !!waiting, await wakeState());
    report.echo = await page.evaluate(() => ({ attr: document.body.dataset.wakeEcho || '', track: window.__app.mic.echoCancellation ?? null }));
    measure('echo cancellation on the track', report.echo);
    await shot('1-waiting');
  });

  await step('silence', async () => {
    const m = await scenario([45], ['(nothing should be transcribed)']);
    await sleep(3000);
    const a = /** @type {any[]} */ ((await e2e('metrics')) || []).find((r) => r.pid === utilityPid);
    const ta = Date.now();
    await sleep(20000);
    const b = /** @type {any[]} */ ((await e2e('metrics')) || []).find((r) => r.pid === utilityPid);
    const tb = Date.now();
    const pct = a && b && a.cumulativeCpuSec != null ? (100 * (b.cumulativeCpuSec - a.cumulativeCpuSec)) / ((tb - ta) / 1000) : null;
    measure('utility CPU in silence (% of one core, 20 s)', pct === null ? null : Number(pct.toFixed(2)));
    check('2 · in silence the utility uses ≤ 3 % of one core', pct !== null && pct <= 3, { pct, a, b });
    check('2 · nothing is transcribed while nobody speaks (0 /stt calls)', newStt(m).length === 0, newStt(m));
    check('2 · no stage-1 hit on room noise', maxHitId(await hits()) === m.hitId, await hits());
    const stats = await e2e('stats');
    if (stats) measure('utility stats after silence', { fedSec: stats.fedSec, speechSec: stats.speechSec, cpuMsPerSecAll: stats.cpuMsPerSecAll, cpuMsPerSecSpeech: stats.cpuMsPerSecSpeech });
  });

  await step('positive', async () => {
    check('positive: the app is quiet before the scenario', await waitSettled());
    const lt0 = await page.evaluate(() => window.__longTasks.length);
    const m = await scenario([1.0, 'pos_cmd_af_bella', 30], ['Hey Jade.', 'what time is it?']);
    const sent = await until(async () => ((await userTexts()).length > m.users ? await userTexts() : null), 20000);
    check('3 · "Hey Jade, what time is it?" sends one message: "what time is it?"', !!sent && sent.slice(m.users).join('|') === 'what time is it?', sent);
    const newHits = (await hits()).filter((h) => h.id > m.hitId);
    const hit = newHits.find((h) => h.keyword === 'HEY_JADE');
    check('3 · a real stage-1 hit (HEY_JADE) from the utility', !!hit, newHits);
    const replied = await until(async () => (await replyTexts()).slice(m.replies).find((t) => t.includes('You said: what time is it?')), 30000);
    check('3 · the fake Claude CLI answers', !!replied, await replyTexts());
    const fup = await until(async () => (await wakesSince(m.wakes)).find((w) => w[0] === 'followup'), 60000);
    await shot('3-followup');
    const back = await until(async () => {
      const ws = await wakesSince(m.wakes);
      const i = ws.findIndex((w) => w[0] === 'followup');
      return i >= 0 && ws.slice(i + 1).find((w) => w[0] === 'waiting');
    }, 15000);
    const ws = await wakesSince(m.wakes);
    const seq = ws.map((w) => w[0]);
    const order = ['attention', 'listening', 'busy', 'followup', 'waiting'];
    let k = 0;
    for (const s of seq) if (s === order[k]) k++;
    check('3 · data-wake: waiting → attention → listening → busy → followup → waiting', k === order.length, seq);
    check('3 · one chime (when she starts listening), none at the follow-up', (await cues()) - m.cues === 1, (await cues()) - m.cues);
    const calls = newStt(m);
    check('3 · /stt heard the wake segment (≤ 2.65 s) and then the command, nothing else', calls.length === 2 && calls[0].durationSec <= 2.65 && calls[0].text === 'Hey Jade.' && calls[1].text === 'what time is it?', calls);
    if (fup && back) {
      followUpOpenPos = m.pos(fup[2]);
      const lasted = back[1] - fup[1];
      measure('follow-up window (ms; followUpSec 6)', Math.round(lasted));
      check('3 · the follow-up window lasts about 6 s', lasted > 5500 && lasted < 6800, lasted);
    } else {
      check('3 · the follow-up window opened and closed', false, seq);
    }
    const att = ws.find((w) => w[0] === 'attention');
    const lis = ws.find((w) => w[0] === 'listening');
    if (att && lis) measure('attention → listening, the stage-2 check (ms; fake /stt)', Math.round(lis[1] - att[1]));
    if (hit) {
      const fx = manifest.get('pos_cmd_af_bella');
      const jadeEndIdx = m.startIdx + Math.round((1.0 + (fx?.jadeEndSec ?? 0)) * KWS_RATE);
      measure('stage-1 hit after the end of "Jade" (ms; emit time in the utility)', Math.round(((hit.emitAt ?? hit.endAt) - jadeEndIdx) / 16));
      measure('keyword end vs the acoustic end of "Jade" (ms)', Math.round((hit.endAt - jadeEndIdx) / 16));
      if (att) measure('end of "Jade" → attention shown (ms; via the tap clock)', Math.round((att[2] - jadeEndIdx) / 16));
      measure('stage-1 model', hit.model);
    }
    followUpCloseAfter = back ? m.pos(back[2]) : 0;
    const lts = await page.evaluate((f) => window.__longTasks.slice(f), lt0);
    measure('renderer long tasks during the positive scenario (count, max ms)', [lts.length, Math.round(Math.max(0, ...lts.map((/** @type {number[]} */ x) => x[1])))]);
    // the persona the CLI got: Jade, with the wake-word section (main's personaContext wiring)
    const runs = fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const last = runs.at(-1)?.argv || [];
    const i = last.indexOf('--system-prompt-file');
    const persona = i >= 0 && fs.existsSync(last[i + 1]) ? fs.readFileSync(last[i + 1], 'utf8') : '';
    check('1 · the persona names Jade, runs on Claude, and has the "How the user calls you" section', /Your name is Jade\./.test(persona) && /runs on Claude, an AI model made by Anthropic/.test(persona) && persona.includes('How the user calls you'), persona.slice(0, 200));
    // the utility talks only to its ports: no TCP/UDP socket of its own (Linux /proc)
    if (process.platform === 'linux' && utilityPid) {
      const inodes = new Set();
      for (const fd of fs.readdirSync(`/proc/${utilityPid}/fd`)) {
        const l = (() => {
          try {
            return fs.readlinkSync(`/proc/${utilityPid}/fd/${fd}`);
          } catch {
            return '';
          }
        })();
        const mm = /^socket:\[(\d+)\]$/.exec(l);
        if (mm) inodes.add(mm[1]);
      }
      const inet = [];
      for (const t of ['tcp', 'tcp6', 'udp', 'udp6']) {
        const f = `/proc/${utilityPid}/net/${t}`;
        if (!fs.existsSync(f)) continue;
        for (const row of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
          const cols = row.trim().split(/\s+/);
          if (cols.length > 9 && inodes.has(cols[9])) inet.push(`${t} ${cols[1]} ${cols[2]}`);
        }
      }
      check('12 · the utility has no TCP or UDP socket', inet.length === 0, inet);
    }
  });

  await step('followup', async () => {
    check('followup: the app is quiet before the scenario', await waitSettled());
    // the same wake and reply as in scenario 3, then "and tomorrow?" 2 s into the follow-up window
    const open = followUpOpenPos || 7.5;
    const lead = 1.0;
    const gap = Math.max(0.5, open + 2.0 - lead - clipSec('pos_cmd_af_bella'));
    const m = await scenario([lead, 'pos_cmd_af_bella', gap, 'neg_meeting', 30], ['Hey Jade.', 'what time is it?', 'and tomorrow?']);
    const sent = await until(async () => ((await userTexts()).length >= m.users + 2 ? await userTexts() : null), 45000);
    check('4 · a follow-up without her name inside the window is sent ("and tomorrow?")', !!sent && sent.slice(m.users).join('|') === 'what time is it?|and tomorrow?', { sent: sent || (await userTexts()).slice(m.users), plannedAt: lead + clipSec('pos_cmd_af_bella') + gap, windowOpenedAt: open, seq: (await wakesSince(m.wakes)).map((w) => [w[0], Number(m.pos(w[2]).toFixed(2))]) });
    const newHits = (await hits()).filter((h) => h.id > m.hitId);
    check('4 · …without a second wake-word hit', newHits.filter((h) => h.keyword === 'HEY_JADE').length === 1, newHits);
    // each reply opens a new window (FUP-5)
    const second = await until(async () => {
      const ws = await wakesSince(m.wakes);
      return ws.filter((w) => w[0] === 'followup').length >= 2;
    }, 60000);
    check('4 · the reply to the follow-up opens another window', !!second, (await wakesSince(m.wakes)).map((w) => w[0]));
    await waitSettled(20000);

    // an utterance after the window closed: never transcribed, never sent
    const closeAt = followUpCloseAfter || (open + 6.0);
    const late = Math.max(0.5, closeAt + 1.5 - lead - clipSec('pos_cmd_af_bella'));
    const m2 = await scenario([lead, 'pos_cmd_af_bella', late, 'neg_meeting', 20], ['Hey Jade.', 'what time is it?', 'this must not be sent']);
    await until(async () => (await userTexts()).length > m2.users, 20000);
    await until(async () => (await wakesSince(m2.wakes)).some((w) => w[0] === 'followup'), 60000);
    await until(async () => {
      const ws = await wakesSince(m2.wakes);
      const i = ws.findIndex((w) => w[0] === 'followup');
      return i >= 0 && ws.slice(i + 1).some((w) => w[0] === 'waiting');
    }, 15000);
    await sleep(Math.max(0, m2.t + (lead + clipSec('pos_cmd_af_bella') + late + clipSec('neg_meeting') + 2) * 1000 - Date.now())); // past the late utterance
    const texts = (await userTexts()).slice(m2.users);
    check('4 · speech after the window closed is not sent', texts.join('|') === 'what time is it?', texts);
    check('4 · …and not even transcribed (only the wake segment and the command)', newStt(m2).length === 2, newStt(m2));
  });

  await step('jude', async () => {
    check('jude: the app is quiet before the scenario', await waitSettled());
    const m = await scenario([1.0, 'judesong_af_heart', 1.2, 'jude_am_michael', 12], ["Hey Jude, don't make it bad.", 'Hey Jude.']);
    await sleep((1.0 + clipSec('judesong_af_heart') + 1.2 + clipSec('jude_am_michael') + 3) * 1000);
    await waitSettled(10000);
    const newHits = (await hits()).filter((h) => h.id > m.hitId);
    const seq = (await wakesSince(m.wakes)).map((w) => w[0]);
    measure('stage-1 hits on the two "Hey Jude" clips', newHits.map((h) => `${h.keyword}/${h.model}`));
    check('5 · "Hey Jude": no message', (await userTexts()).length === m.users, (await userTexts()).slice(m.users));
    check('5 · …no chime and never "listening"', (await cues()) === m.cues && !seq.includes('listening'), { seq, cues: (await cues()) - m.cues });
    const log = (await wakeLog()).slice(m.log);
    check('5 · every stage-1 hit is accounted for as ignored ("Hey Jude")', newHits.length === log.filter((t) => /Jude/.test(t)).length, { log, newHits });
    check('5 · /stt only checked a HEY_JADE hit, if any (HEY_JUDE is dropped without a check)', newStt(m).length === newHits.filter((h) => h.keyword === 'HEY_JADE').length, { stt: newStt(m), newHits });
  });

  await step('self', async () => {
    check('self: the app is quiet before the scenario', await waitSettled());
    // her own forbidden line through the "speakers" while she says it: the text mask must hold
    const line = 'Just say hey Jade whenever you need me.';
    await page.evaluate(() => {
      window.__gain = [];
      window.__gainTimer = setInterval(() => window.__gain.push([performance.now(), window.__app.player.masterGainDb]), 10);
    });
    const mark = { hitId: maxHitId(await hits()) };
    await page.evaluate((t) => window.__app.controller.say(t), line);
    await until(() => page.evaluate(() => document.body.dataset.state === 'speaking'), 5000, 20);
    const m = await scenario([0.2, 'selfbad_1.0', 10], ['(her own voice must not be checked)']);
    await sleep((0.2 + clipSec('selfbad_1.0') + 1.5) * 1000);
    await waitSettled(15000);
    const gain = await page.evaluate(() => {
      clearInterval(window.__gainTimer);
      return window.__gain;
    });
    const newHits = (await hits()).filter((h) => h.id > mark.hitId);
    const seq = (await wakesSince(m.wakes)).map((w) => w[0]);
    const log = (await wakeLog()).slice(m.log);
    measure('stage-1 hits on her own "Just say hey Jade…" line', newHits.map((h) => `${h.keyword}/${h.model}`));
    check('6 · stage 1 fires on her own forbidden line (so the mask is really tested)', newHits.some((h) => h.keyword === 'HEY_JADE'), newHits);
    check('6 · …and the hit is ignored as her own voice', log.some((t) => /own voice/.test(t)), log);
    check('6 · no attention, no barge-in, no duck, no /stt, no message', !seq.includes('attention') && !seq.includes('barge') && Math.min(0, ...gain.map((g) => g[1])) > -1 && newStt(m).length === 0 && (await userTexts()).length === m.users, { seq, minGainDb: Math.min(0, ...gain.map((g) => g[1])), stt: newStt(m) });
  });

  await step('barge', async () => {
    check('barge: the app is quiet before the scenario', await waitSettled());
    const long = Array.from({ length: 8 }, (_, i) => `This is sentence number ${i + 1} of a long story about holograms, lawnmowers and the people who build them.`).join(' ');
    const before = { users: (await userTexts()).length };
    await page.evaluate((t) => window.__app.controller.sendText(t), long);
    const speaking = await until(() => page.evaluate(() => document.body.dataset.state === 'speaking' && window.__app.controller.speech.busy), 20000, 50);
    check('7 · she reads the long reply aloud', !!speaking);
    await sleep(1500);
    await page.evaluate(() => {
      window.__gain = [];
      window.__gainTimer = setInterval(() => window.__gain.push([performance.now(), window.__app.player.masterGainDb, window.__app.controller.speech.busy, window.__app.player.duckDb]), 10);
    });
    const m = await scenario([0.5, 'pos_cmd_bm_lewis', 15], ['Hey Jade.', 'stop']);
    const barged = await until(async () => (await wakesSince(m.wakes)).find((w) => w[0] === 'barge'), 15000, 50);
    check('7 · "Hey Jade" while she speaks → barge (her voice ducks while it is checked)', !!barged, (await wakesSince(m.wakes)).map((w) => w[0]));
    const listening = await until(async () => (await wakesSince(m.wakes)).find((w) => w[0] === 'listening'), 15000, 50);
    await shot('7-barge-listening');
    await until(async () => (await wakesSince(m.wakes)).some((w, i, a) => w[0] === 'waiting' && a.slice(0, i).some((x) => x[0] === 'listening')), 20000);
    await sleep(500);
    const gain = await page.evaluate(() => {
      clearInterval(window.__gainTimer);
      return window.__gain;
    });
    const minDb = Math.min(0, ...gain.map((g) => g[1]));
    measure('her voice while "Hey Jade" was checked (min master gain, dB)', Number(minDb.toFixed(1)));
    check('7 · the player was told to duck her voice by 15 dB', gain.some((g) => g[3] === -15), [...new Set(gain.map((g) => g[3]))]);
    check('7 · ducked by ≥ 10 dB', minDb <= -10, minDb);
    if (barged) {
      const firstDuck = gain.find((g) => g[0] >= barged[1] - 50 && g[1] <= -10);
      if (firstDuck) measure('barge state → voice 10 dB down (ms)', Math.round(firstDuck[0] - barged[1]));
    }
    if (listening) {
      const stopped = gain.find((g) => g[0] >= listening[1] && !g[2]);
      measure('verified → she stopped speaking (ms)', stopped ? Math.round(stopped[0] - listening[1]) : null);
      check('7 · she stops speaking once the call is verified', !!stopped, gain.slice(-5));
    } else {
      check('7 · the call was verified (listening)', false, (await wakesSince(m.wakes)).map((w) => w[0]));
    }
    const users = (await userTexts()).slice(before.users);
    check('7 · "Hey Jade, stop" is handled locally: no message to Claude', users.length === 1 && !users.includes('stop'), users);
    const reply = (await replyTexts()).at(-1) || '';
    check('7 · the reply stays in the chat panel', reply.includes('sentence number 8'), reply.slice(-120));
    check('7 · one chime (verified), from the cue path', (await cues()) - m.cues === 1, (await cues()) - m.cues);
    await waitSettled(20000);
  });

  await step('hidden', async () => {
    check('hidden: the app is quiet before the scenario', await waitSettled());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await sleep(800);
    const hiddenState = await wakeState();
    check('8 · hidden in the tray, she keeps listening (Listen while hidden)', hiddenState === 'waiting', hiddenState);
    const m = await scenario([1.0, 'pos_hey_am_michael', 14], ['Hey Jade.']);
    const shown = await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 15000, 100);
    const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
    check('8 · "Hey Jade." brings the window back', !!shown);
    measure('window focused after it came back (expected: no)', focused);
    if (process.platform === 'win32') check('8 · …without taking the focus', !focused, focused);
    check('8 · …and she listens', (await wakesSince(m.wakes)).some((w) => w[0] === 'listening'), (await wakesSince(m.wakes)).map((w) => w[0]));
    await waitSettled(20000); // no command: back to waiting after 8 s
    const log = (await wakeLog()).slice(m.log);
    check('8 · a call without a command ends silently ("no command")', log.some((t) => /no command/.test(t)) && (await userTexts()).length === m.users, log);
  });

  await step('lock', async () => {
    check('lock: the app is quiet before the scenario', await waitSettled());
    await scenario([30], ['(locked)']);
    await sleep(500);
    await page.evaluate(() => { window.__lockTrack = window.__app.mic._stream?.getAudioTracks?.()[0] || null; });
    const tl = Date.now();
    await e2e('emitPower', 'locked');
    const ended = await until(() => page.evaluate(() => !window.__lockTrack || window.__lockTrack.readyState === 'ended'), 3000, 20);
    const ms = Date.now() - tl;
    measure('PC locked → microphone track ended (ms)', ms);
    check('9 · PC locked: the microphone is released within 1 s', !!ended && ms <= 1000, { ms, state: await wakeState() });
    check('9 · …and the state says locked', (await until(async () => (await wakeState()) === 'locked', 2000)) !== null, await wakeState());
    await e2e('emitPower', 'unlocked');
    const back = await until(async () => (await wakeState()) === 'waiting' && (await page.evaluate(() => window.__app.mic.isOpen)), 5000);
    check('9 · unlocked: listening for her name again', !!back, await wakeState());
  });

  await step('crash', async () => {
    check('crash: the app is quiet before the scenario', await waitSettled());
    const st0 = await engineStatus();
    const pid0 = Number(await e2e('utilityPid')) || 0;
    await e2e('restartUtility');
    const ready = await until(async () => {
      const st = await engineStatus();
      return st && st.engine === 'ready' && st.restarts > st0.restarts && st.portGen > st0.portGen ? st : null;
    }, 45000, 250);
    check('10 · the utility restarts after a crash, with a new port for the renderer', !!ready, { before: st0, after: await engineStatus() });
    utilityPid = Number(await e2e('utilityPid')) || 0;
    check('10 · …as a new process', utilityPid > 0 && utilityPid !== pid0, { pid0, utilityPid });
    await until(async () => (await wakeState()) === 'waiting', 20000);
    const m = await scenario([1.0, 'pos_cmd_bf_lily', 25], ['Hey Jade.', 'what time is it?']);
    const sent = await until(async () => ((await userTexts()).length > m.users ? await userTexts() : null), 25000);
    check('10 · after the restart a wake works again', !!sent && sent.slice(m.users).join('|') === 'what time is it?', sent);
    await waitSettled(45000);
  });

  await step('speech-cpu', async () => {
    check('speech-cpu: the app is quiet before the scenario', await waitSettled());
    const parts = [];
    for (let r = 0; r < 3; r++) for (const id of ['neg_siri', 'neg_commits', 'neg_meeting', 'neg_ship']) parts.push(id, 0.5);
    const m = await scenario([0.5, ...parts, 10], ['(no wake expected)']);
    await sleep(1500);
    const a = /** @type {any[]} */ ((await e2e('metrics')) || []).find((r) => r.pid === utilityPid);
    const ta = Date.now();
    await sleep(15000);
    const b = /** @type {any[]} */ ((await e2e('metrics')) || []).find((r) => r.pid === utilityPid);
    const pct = a && b ? (100 * (b.cumulativeCpuSec - a.cumulativeCpuSec)) / ((Date.now() - ta) / 1000) : null;
    measure('utility CPU while people talk without her name (% of one core, 15 s)', pct === null ? null : Number(pct.toFixed(2)));
    check('11 · while people talk, the utility stays ≤ 15 % of one core', pct !== null && pct <= 15, pct);
    await sleep(3000);
    check('11 · talk without her name sends nothing', (await userTexts()).length === m.users, (await userTexts()).slice(m.users));
    const stats = await e2e('stats');
    if (stats) measure('utility stats (cpu ms per second of speech)', stats.cpuMsPerSecSpeech);
  });

  await step('privacy', async () => {
    const blocked = /** @type {any[]} */ (await app.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.blockedRequests()));
    check('12 · no request left the PC', blocked.length === 0, blocked);
    /** @param {string} dir @returns {string[]} */
    const audioFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(wav|pcm|webm|ogg|flac|mp3)$/i.test(f)) : []);
    const clipsNow = testClipsDir && fs.existsSync(testClipsDir) ? fs.readdirSync(testClipsDir).filter((f) => !testClipsBefore.includes(f)) : [];
    const written = [...audioFiles(userData), ...clipsNow];
    check('12 · no audio was written anywhere (no test clip was asked for)', written.length === 0, written);
    measure('wake log at the end', await wakeLog());
  });

  const info = await app.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.voiceInfo?.());
  voicePid = Number(info?.health?.pid) || 0;
} catch (err) {
  check('the run completed', false, String(/** @type {Error} */ (err).stack || err).slice(0, 1200));
} finally {
  report.consoleErrors = consoleErrors.slice(0, 20);
  if (page) check('12 · no console errors in the avatar window', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  if (app) {
    const tq = Date.now();
    await Promise.race([app.close().catch(() => {}), sleep(15000)]);
    const alive = (/** @type {number} */ pid) => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = await until(() => !alive(utilityPid) && !alive(voicePid), 5000);
    if (!only || only.has('privacy')) check('12 · quitting ends the utility and the voice server', !!gone, { utilityPid, voicePid, alive: [alive(utilityPid), alive(voicePid)] });
    measure('quit (ms)', Date.now() - tq);
  }
  report.timings.total = Date.now() - t0;
  report.ok = !report.failed && !!app;
  if (!keep && !workArg) fs.rmSync(work, { recursive: true, force: true });
  else report.workDir = work;
  const text = JSON.stringify(report, null, 2);
  if (reportFile) fs.writeFileSync(reportFile, text);
  console.log(text);
  process.exit(report.ok ? 0 : 1);
}
