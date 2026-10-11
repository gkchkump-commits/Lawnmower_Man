#!/usr/bin/env node
// Launch the REAL Electron app (electron/main.js) with Playwright's Electron driver and verify
// the whole main-process stack end to end: window flags, app:// + CSP, the preload bridge
// (window.lawnmower), settings IPC, a Claude turn streamed back to the renderer, voice status,
// the Home camera window (its own preload, sandbox, settings limits; no camera needed),
// "Hey Jade" (the "Jade wake word" utility process with the real sherpa-onnx addon: off by
// default, ready when turned on, gone when turned off), a complete renderer boot without console
// errors, and a clean shutdown of child processes.
//
//   node scripts/electron-e2e.mjs                 # fake Claude CLI (free, deterministic)
//   node scripts/electron-e2e.mjs --live          # the real logged-in `claude` CLI (one tiny turn)
//   node scripts/electron-e2e.mjs --screenshot out.png
//   ELECTRON_PATH=/path/to/electron node scripts/electron-e2e.mjs
//   ELECTRON_PATH="C:\…\Lawnmower Man.exe" node scripts/electron-e2e.mjs --packaged
//   ELECTRON_PATH=release/linux-unpacked/lawnmower-man xvfb-run -a node scripts/electron-e2e.mjs --packaged
//   … --software-webgl   (machines without a GPU, e.g. CI runners: WebGL through SwiftShader)
//
// --packaged launches a BUILT app (the installed exe, or electron-builder's linux-unpacked binary)
// without an app path and additionally checks what an installer must deliver: app.isPackaged,
// resources/{app.asar, voice/, scripts/setup-voice.*, tapo/go2rtc(.exe) (it runs, and is the
// pinned 1.9.14)}, the camera page and the person detector model in app.asar, the per-user voice folder the sidecar looks
// in, and — through the real "Set up local voice…" launcher, in -CheckOnly mode — that the bundled
// setup script reports exactly that folder (--no-setup-check skips it; on Linux without a terminal
// emulator, --fake-terminal puts a stand-in "xterm" on PATH so the script really runs), and the
// wake-word engine in resources/wake/ (this platform's addon, model B, the VAD and the licences,
// byte for byte the pinned files; never the zh-en model). The fake CLI and the
// throwaway userData folder reach the packaged app through LAWNMOWER_CLAUDE_CLI /
// LAWNMOWER_USER_DATA, which packaged builds honour on purpose (threat model: electron/main.js);
// LAWNMOWER_E2E=1 exposes a few main-process helpers to app.evaluate().
//
// Needs the Electron binary (npm install downloads it) and a display (on headless Linux run it
// under `xvfb-run -a`). Uses a throwaway userData folder; never touches your real settings.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { windowLayout } from '../electron/window-manager.js';
import { ADDON_FILES, LAYOUT, MODEL_FILES } from '../electron/wake/config.js';
import { READY_CAP_MS } from '../electron/wake/host.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const packaged = argv.includes('--packaged');
const setupCheck = !argv.includes('--no-setup-check');
const fakeTerminal = argv.includes('--fake-terminal') && process.platform === 'linux';
// GPU-less CI machines (windows-latest): render WebGL with SwiftShader, as playwright.config.js does
const softwareWebgl = argv.includes('--software-webgl');
const shotIdx = argv.indexOf('--screenshot');
const screenshot = shotIdx >= 0 ? path.resolve(argv[shotIdx + 1]) : null;

let executablePath = process.env.ELECTRON_PATH;
if (packaged && !executablePath) {
  console.error('--packaged needs ELECTRON_PATH: the installed "Lawnmower Man.exe" or release/linux-unpacked/lawnmower-man.');
  process.exit(2);
}
if (!executablePath) {
  try {
    executablePath = require('electron'); // the npm package exports the binary path
  } catch (err) {
    console.error(`Electron binary not available (${err.message}). Set ELECTRON_PATH.`);
    process.exit(2);
  }
}

const { _electron: electron } = require('@playwright/test');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-e2e-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ claude: { workdir: path.join(userData, 'work') } }));

// (the wake word's engine waits for the local voice a minute after the start; this run has none,
// and the engine check below comes later than that on a slow runner)
const env = { ...process.env, LAWNMOWER_USER_DATA: userData, LAWNMOWER_E2E: '1', LAWNMOWER_WAKE_PARK_MS: '600000' };
const loginFile = path.join(userData, 'fake-claude-logged-in');
if (!live) {
  env.LAWNMOWER_CLAUDE_CLI = path.join(root, 'tests/fixtures/fake-claude.mjs');
  env.FAKE_CLAUDE_AUTH_FILE = loginFile; // "not logged in" until the test creates it
}
// Linux: keep the per-user voice folder of this run out of the real home (check mode writes nothing there anyway)
if (packaged && process.platform === 'linux') env.XDG_DATA_HOME = path.join(userData, 'xdg-data');
if (fakeTerminal) {
  // "xterm -e cmd args…" → runs cmd args… without a window
  const bin = path.join(userData, 'fake-terminal');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xterm'), '#!/bin/sh\n[ "$1" = "-e" ] && shift\nexec "$@"\n', { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${env.PATH || ''}`;
}
delete env.ELECTRON_RUN_AS_NODE;

const args = packaged ? [] : [root];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
if (softwareWebgl) args.unshift('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
// Chromium's built-in fake camera (a moving test pattern): the camera checks need a device, and
// the permission policy (not a UI flag) must decide whether the page may use it
args.unshift('--use-fake-device-for-media-stream');

/** @type {Record<string, any>} */
const report = { ok: false, live, packaged, checks: {} };
const check = (name, cond, detail) => {
  report.checks[name] = cond ? 'ok' : `FAILED${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`;
  if (!cond) report.failed = (report.failed || 0) + 1;
};

const app = await electron.launch({ executablePath, args, env, timeout: 60000 });
const launchedAt = Date.now();
try {
  const page = await app.firstWindow();
  /** @type {string[]} */
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  // The first window can be reported before its first navigation (about:blank → app://).
  await page.waitForURL((u) => u.protocol === 'app:', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  report.url = page.url();
  check('loads app://lawnmower/index.html', report.url === 'app://lawnmower/index.html', report.url);

  // Main-process view of the window.
  const winInfo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { bounds: w.getBounds(), workArea: screen.getPrimaryDisplay().workArea, alwaysOnTop: w.isAlwaysOnTop(), resizable: w.isResizable(), visible: w.isVisible(), bg: w.getBackgroundColor() };
  });
  report.window = winInfo;
  // 400x840 (medium + chat); on a small screen (CI runners: 1024x768) the chat strip shrinks to fit
  const want = windowLayout('medium', true, winInfo.workArea);
  check(`window ${want.width}x${want.height} (medium + chat)`, winInfo.bounds.width === want.width && winInfo.bounds.height === want.height, winInfo);
  check('always on top, not resizable', winInfo.alwaysOnTop && !winInfo.resizable, winInfo);

  // Renderer isolation and the exact bridge shape.
  const shape = await page.evaluate(() => {
    const lm = /** @type {any} */ (window).lawnmower;
    const keys = (o) => Object.keys(o).sort();
    return {
      top: keys(lm), claude: keys(lm.claude), voice: keys(lm.voice), settings: keys(lm.settings), window: keys(lm.window), app: keys(lm.app), tapo: keys(lm.tapo), wake: keys(lm.wake),
      nodeLeak: typeof (/** @type {any} */ (window).require) !== 'undefined' || typeof (/** @type {any} */ (window).process) !== 'undefined',
      ipcLeak: typeof (/** @type {any} */ (window).ipcRenderer) !== 'undefined',
    };
  });
  report.bridge = shape;
  check('bridge shape', JSON.stringify(shape.top) === JSON.stringify(['app', 'claude', 'onCursor', 'onHotkey', 'settings', 'tapo', 'voice', 'wake', 'window'])
    && JSON.stringify(shape.claude) === JSON.stringify(['cancel', 'interrupt', 'onEvent', 'reset', 'respondPermission', 'retry', 'send', 'status'])
    && JSON.stringify(shape.voice) === JSON.stringify(['info', 'onStatus', 'openSetupLog', 'restart', 'setup'])
    && JSON.stringify(shape.tapo) === JSON.stringify(['arm', 'events', 'onAlert', 'onLook', 'onStatus', 'openClips', 'openWindow', 'presets', 'ptz', 'status'])
    // "Hey Jade" (contract-wake §6.2): the wake namespace and window.show
    && JSON.stringify(shape.wake) === JSON.stringify(['download', 'micAccess', 'onPower', 'onStatus', 'openMicSettings', 'report', 'requestPort', 'restart', 'saveClip', 'status'])
    && shape.window.includes('show'), shape);
  check('no Node/ipcRenderer in the page', !shape.nodeLeak && !shape.ipcLeak, shape);

  // CSP: inline script and remote fetch are blocked, the local voice range is allowed.
  const csp = await page.evaluate(async () => {
    let inline = false;
    try {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.head.appendChild(s);
      inline = !!(/** @type {any} */ (window).__inlineRan);
    } catch { /* blocked */ }
    let remote = 'blocked';
    try {
      await fetch('https://example.com/');
      remote = 'allowed';
    } catch { /* blocked by CSP */ }
    return { inline, remote };
  });
  check('CSP blocks inline script and remote fetch', !csp.inline && csp.remote === 'blocked', csp);

  const appInfo = await page.evaluate(() => /** @type {any} */ (window).lawnmower.app.info());
  report.appInfo = appInfo;
  check('app.info', typeof appInfo.version === 'string' && appInfo.electron && appInfo.chrome, appInfo);

  // Settings round trip + change event.
  const settings = await page.evaluate(async () => {
    const lm = /** @type {any} */ (window).lawnmower;
    const changes = [];
    const off = lm.settings.onChange((s) => changes.push(s.avatar.bloom));
    const after = await lm.settings.set({ avatar: { bloom: 1.5 } });
    await new Promise((r) => setTimeout(r, 200));
    off();
    return { bloom: after.avatar.bloom, changes };
  });
  check('settings.set + onChange', settings.bloom === 1.5 && settings.changes.includes(1.5), settings);

  if (!live) {
    // First run with a CLI that is not logged in: the problem event (→ the sign-in card), then
    // "log in" and Retry without restarting the app.
    const auth = await page.evaluate(async () => {
      const lm = /** @type {any} */ (window).lawnmower;
      const events = [];
      const off = lm.claude.onEvent((e) => events.push(e));
      const { turnId } = await lm.claude.send('hi before login');
      for (let i = 0; i < 300 && !events.some((e) => e.type === 'turn_end' && e.turnId === turnId); i++) await new Promise((r) => setTimeout(r, 50));
      off();
      return { problem: events.find((e) => e.type === 'problem')?.problem || null, end: events.find((e) => e.type === 'turn_end') || null, status: await lm.claude.status() };
    });
    check('not logged in → problem "auth" before the failed turn', auth.problem?.kind === 'auth' && auth.end?.isError === true && auth.status.problem?.kind === 'auth', auth);
    await page.waitForFunction(() => !!document.querySelector('.setup-card[data-setup="auth"]'), null, { timeout: 10000 }).then(
      () => check('sign-in card shown', true),
      () => check('sign-in card shown', false),
    );
    fs.writeFileSync(loginFile, 'ok'); // the user ran `claude` and signed in
    const retried = await page.evaluate(async () => {
      const lm = /** @type {any} */ (window).lawnmower;
      await lm.claude.retry();
      return lm.claude.status();
    });
    check('Retry after login clears the problem', retried.status === 'ready' && !retried.problem, retried);
    await page.waitForFunction(() => !document.querySelector('.setup-card[data-setup="auth"]'), null, { timeout: 10000 }).then(
      () => check('sign-in card hidden after Retry', true),
      () => check('sign-in card hidden after Retry', false),
    );
  }

  // A Claude turn, streamed into the renderer.
  const turn = await page.evaluate(async (isLive) => {
    const lm = /** @type {any} */ (window).lawnmower;
    const events = [];
    let resolveEnd;
    const ended = new Promise((r) => { resolveEnd = r; });
    const off = lm.claude.onEvent((e) => {
      events.push(e);
      if (e.type === 'turn_end') resolveEnd(e);
    });
    const { turnId } = await lm.claude.send(isLive ? 'Say hi in at most six words.' : 'hello from electron');
    const end = await Promise.race([ended, new Promise((r) => setTimeout(() => r(null), 120000))]);
    off();
    const text = events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join('');
    return { turnId, end, text, types: [...new Set(events.map((e) => e.type))], status: await lm.claude.status() };
  }, live);
  report.turn = { text: turn.text, types: turn.types, isError: turn.end && turn.end.isError, cli: turn.status.cliPath, cliVersion: turn.status.cliVersion };
  check('Claude turn streamed to renderer', !!turn.end && !turn.end.isError && turn.text.length > 0 && (live || turn.text === 'You said: hello from electron'), turn);

  if (!live) {
    // A webcam snapshot travels with the turn as an image content block after the text; the fake
    // CLI checks it like the API would and says what it saw. Malformed images never reach it.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0]).toString('base64');
    const img = await page.evaluate(async (data) => {
      const lm = /** @type {any} */ (window).lawnmower;
      const events = [];
      const off = lm.claude.onEvent((e) => events.push(e));
      const { turnId } = await lm.claude.send('look at me', { images: [{ mediaType: 'image/jpeg', data }] });
      for (let i = 0; i < 300 && !events.some((e) => e.type === 'turn_end' && e.turnId === turnId); i++) await new Promise((r) => setTimeout(r, 50));
      off();
      let rejected = '';
      try {
        await lm.claude.send('x', { images: [{ mediaType: 'image/png', data }] });
      } catch (err) {
        rejected = String(err && err.message);
      }
      return { text: events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join(''), rejected };
    }, jpeg);
    report.image = img;
    check('fake CLI receives the image block of a turn', img.text === 'You said: look at me [saw 1 image: image/jpeg 640x480, 24 bytes]', img);
    check('a mislabelled image is refused by main', /not really image\/png/.test(img.rejected), img);
  }

  // The camera: denied while camera.enabled is off (the permission policy in main), allowed once
  // it is on; in the app the privacy card comes first, then face tracking loads its wasm runtime
  // and model from app:// in a worker (CSP, asar) and processes frames.
  const camOff = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const t of s.getTracks()) t.stop();
      return 'allowed';
    } catch (err) {
      return /** @type {any} */ (err).name;
    }
  });
  check('camera denied while camera.enabled is off', camOff === 'NotAllowedError', camOff);
  await page.waitForFunction(() => /** @type {any} */ (window).__app?.ready, null, { timeout: 60000 });
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ camera: { enabled: true } }));
  const consent = await page.waitForSelector('.camera-card .camera-accept', { timeout: 10000 }).then(() => true, () => false);
  check('privacy card before the camera is used', consent);
  if (consent) await page.click('.camera-card .camera-accept');
  const cam = await page.waitForFunction(() => {
    const st = /** @type {any} */ (window).__app?.camera?.status;
    return st && st.state === 'on' && st.tracking === 'on' && st.frames >= 3 ? st : (st && (st.state === 'error' || st.tracking === 'failed') ? st : null);
  }, null, { timeout: 60000 }).then((h) => h.jsonValue(), async () => page.evaluate(() => /** @type {any} */ (window).__app?.camera?.status));
  report.camera = cam && { state: cam.state, tracking: cam.tracking, mode: cam.mode, delegate: cam.delegate, frames: cam.frames, lastMs: cam.lastMs, error: cam.error?.kind, trackingError: cam.trackingError };
  check('camera on: face tracking runs in a worker (wasm + model over app://)', cam?.state === 'on' && cam?.tracking === 'on' && cam?.mode === 'worker' && cam?.frames >= 3, report.camera);
  // Offline means offline: the face-tracker worker runs under the CSP too (a worker takes it from
  // its script's response, not from the page), so MediaPipe's built-in usage metrics — sent at
  // once when the landmarker closes — and any other remote request never reach the network.
  const trackerWorker = page.workers().find((w) => /face-worker/.test(w.url()));
  const workerFetch = trackerWorker
    ? await trackerWorker.evaluate(() => new Promise((resolve) => {
      let violated = '';
      const onViolation = (/** @type {any} */ e) => { violated = e.violatedDirective; };
      globalThis.addEventListener('securitypolicyviolation', onViolation);
      const done = (/** @type {string} */ how) => setTimeout(() => {
        globalThis.removeEventListener('securitypolicyviolation', onViolation);
        resolve(violated ? `blocked by CSP (${violated})` : how);
      }, 100);
      fetch('https://example.com/').then(() => done('allowed'), () => done('failed without a CSP violation'));
    })).catch((err) => `error: ${err.message}`)
    : 'no face-tracker worker';
  check('the face-tracker worker runs under the CSP (no remote fetch)', /^blocked by CSP \(connect-src/.test(workerFetch), workerFetch);
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ camera: { enabled: false } }));
  const released = await page.waitForFunction(() => document.body.dataset.camera === 'off' && !(/** @type {any} */ (window).__app.camera.camera.running), null, { timeout: 10000 }).then(() => true, () => false);
  check('camera off releases the device', released);
  await new Promise((r) => setTimeout(r, 1500)); // the landmarker's close() flushes its metrics now
  const leaked = await app.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.blockedRequests());
  check('no request left the app (CSP stopped them before the network)', Array.isArray(leaked) && leaked.length === 0, leaked);

  const voice = await page.evaluate(() => /** @type {any} */ (window).lawnmower.voice.info());
  report.voice = voice;
  check('voice status reported', ['disabled', 'starting', 'ready', 'error'].includes(voice.status), voice);

  // The local voice's character (default synth) is an AudioWorklet module loaded over app:// under
  // the CSP; a refused module would only leave a warning and an unprocessed voice. A short clip
  // through the real player must come out processed by the audio thread.
  const fx = await page.waitForFunction(() => {
    const v = /** @type {any} */ (window).__app?.player?.voiceFx;
    return v && v.state !== 'loading' ? v : null;
  }, null, { timeout: 15000 }).then((h) => h.jsonValue(), () => null);
  report.voiceFx = fx;
  check('voice character effect loaded (AudioWorklet over app:// under the CSP)', fx?.state === 'ready' && fx.character === 'synth' && fx.active, fx);
  const fxRun = await page.evaluate(async () => {
    const p = /** @type {any} */ (window).__app.player;
    const rate = 24000;
    const samples = new Float32Array(rate * 0.6);
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      samples[i] = 0.25 * Math.sin(2 * Math.PI * 160 * t) + 0.12 * Math.sin(2 * Math.PI * 320 * t) + 0.06 * Math.sin(2 * Math.PI * 640 * t);
    }
    const before = await p.fxStats();
    const res = await Promise.race([p.enqueue({ kind: 'audio', samples, sampleRate: rate, text: 'e2e' }), new Promise((r) => setTimeout(() => r({ timeout: true }), 5000))]);
    const after = await p.fxStats();
    return { res, blocks: after ? after.blocks - before.blocks : -1, changed: after ? (after.diffSq - before.diffSq) / Math.max(1e-9, after.inSq - before.inSq) : -1, failed: after?.failed };
  });
  report.voiceFxRun = fxRun;
  check('a clip is processed on the audio thread', fxRun.res?.stopped === false && fxRun.blocks > 50 && fxRun.changed > 0.01 && fxRun.failed === false, fxRun);

  await homeCameraChecks(app, page);

  await wakeChecks(app, page);

  if (packaged) await packagedChecks(app);

  // The renderer booted completely (UI wired, hologram created) and logged no errors on the way.
  const booted = await page.waitForFunction(() => /** @type {any} */ (window).__app?.ready && /** @type {any} */ (window).__app?.avatarReady, null, { timeout: 60000 })
    .then(() => page.evaluate(() => /** @type {any} */ (window).__app.avatar?.renderer || 'none'), () => null);
  report.renderer = booted;
  check('renderer booted (UI + avatar)', !!booted, booted);
  // (the CSP probe above logs its own, expected, violations)
  const unexpected = consoleErrors.filter((t) => !/example\.com|Executing inline script violates/.test(t));
  report.consoleErrors = unexpected;
  check('no console errors', unexpected.length === 0, unexpected);

  if (screenshot) await page.screenshot({ path: screenshot });
  report.mainLog = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n').filter((l) => /\[gpu\]|\[claude\] using|ERROR/.test(l)).slice(0, 10);
  report.ok = !report.failed;
} finally {
  const pidBefore = await app.evaluate(() => process.pid).catch(() => null);
  await app.close().catch(() => {});
  report.closed = pidBefore !== null;
  // Windows: Chromium's helper processes and the CLI can hold files in userData for a moment
  // after the app exited (EBUSY/EPERM); a leftover temp folder must not fail the run or swallow
  // the report.
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    report.cleanupWarning = `could not delete ${userData}: ${err.message}`;
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

/**
 * The Home camera window (docs/TAPO.md) without a camera: off by default there is no window; turned
 * on (not set up, so nothing talks to a camera) main opens it hidden — app://lawnmower/tapo/index.html,
 * sandboxed and isolated, its own preload exposing exactly window.lawnmowerCamera — and its page
 * boots without errors; it may change only the camera's settings groups; turned off, it is gone.
 * @param {import('@playwright/test').ElectronApplication} electronApp @param {import('@playwright/test').Page} page
 */
async function homeCameraChecks(electronApp, page) {
  const windowCount = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const st0 = await page.evaluate(async () => {
    const st = await /** @type {any} */ (window).lawnmower.tapo.status();
    return { enabled: st.enabled, connection: st.connection, go2rtc: st.go2rtc?.state };
  });
  check('home camera off by default: status "off", no camera window', st0.enabled === false && st0.connection === 'off' && (await windowCount()) === 1, st0);
  const hook = await electronApp.evaluate(() => {
    const t = /** @type {any} */ (globalThis).__lawnmowerE2E?.tapo;
    return t ? Object.keys(t).sort() : null;
  });
  check('LAWNMOWER_E2E: the home camera hooks', Array.isArray(hook) && ['clipsDir', 'go2rtcPid', 'notifications', 'setPassword', 'status', 'workerStats'].every((k) => hook.includes(k)), hook);

  /** @type {string[]} */
  const camErrors = [];
  const opened = electronApp.waitForEvent('window', { timeout: 30000 });
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ tapo: { enabled: true } }));
  const cam = await opened.catch(() => null);
  check('turning the home camera on opens its window', !!cam);
  if (!cam) return;
  cam.on('console', (m) => { if (m.type() === 'error') camErrors.push(m.text()); });
  cam.on('pageerror', (e) => camErrors.push(`pageerror: ${e.message}`));
  await cam.waitForURL(/\/tapo\/index\.html/, { timeout: 30000 }).catch(() => {});
  const win = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => /\/tapo\/index\.html/.test(x.webContents.getURL()));
    if (!w) return null;
    const p = /** @type {any} */ (w.webContents).getLastWebPreferences();
    return { url: w.webContents.getURL(), title: w.getTitle(), visible: w.isVisible(), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity };
  });
  report.cameraWindow = win;
  // (its preload is checked below by what the page sees: window.lawnmowerCamera, no window.lawnmower)
  check('camera window: app://lawnmower/tapo/index.html, hidden, sandboxed, isolated', win?.url === 'app://lawnmower/tapo/index.html' && win.visible === false
    && win.sandbox === true && win.contextIsolation === true && win.nodeIntegration === false && win.webSecurity !== false && /^Home camera\b/.test(win.title), win);
  const booted = await cam.waitForFunction(() => document.body?.dataset.boot === 'ready', null, { timeout: 30000 }).then(() => true, () => false);
  check('camera page booted (the setup, since no camera is set up)', booted);
  const camShape = await cam.evaluate(() => {
    const c = /** @type {any} */ (window).lawnmowerCamera;
    const keys = (/** @type {any} */ o) => Object.keys(o || {}).sort();
    return {
      top: keys(c), tapo: keys(c?.tapo), events: keys(c?.tapo?.events), settings: keys(c?.settings), app: keys(c?.app),
      avatarApi: typeof (/** @type {any} */ (window).lawnmower),
      nodeLeak: typeof (/** @type {any} */ (window).require) !== 'undefined' || typeof (/** @type {any} */ (window).process) !== 'undefined',
      ipcLeak: typeof (/** @type {any} */ (window).ipcRenderer) !== 'undefined',
    };
  });
  report.cameraBridge = camShape;
  check('camera preload: exactly window.lawnmowerCamera { app, settings, tapo }, no Claude API, no Node',
    JSON.stringify(camShape.top) === JSON.stringify(['app', 'settings', 'tapo']) && camShape.avatarApi === 'undefined' && !camShape.nodeLeak && !camShape.ipcLeak
    && JSON.stringify(camShape.events) === JSON.stringify(['ack', 'list', 'openFolder', 'remove'])
    && ['arm', 'calibrate', 'clearCredentials', 'discover', 'onCalibration', 'onEvent', 'onOpenEvent', 'onStatus', 'presets', 'ptz', 'removePreset', 'requestPort', 'savePreset', 'setCredentials', 'setViewVisible', 'status', 'test'].every((k) => camShape.tapo.includes(k)), camShape);
  const limits = await cam.evaluate(async () => {
    const c = /** @type {any} */ (window).lawnmowerCamera;
    let refused = '';
    try {
      await c.settings.set({ window: { alwaysOnTop: false } });
    } catch (err) {
      refused = String(/** @type {any} */ (err)?.message || err);
    }
    const after = await c.settings.set({ tapo: { name: 'e2e camera' } });
    const info = await c.app.info();
    const st = await c.tapo.status();
    return { refused, name: after.tapo.name, version: info.version, connection: st.connection };
  });
  check('camera window: changes its own settings only; app info and status work', /only change the camera settings/.test(limits.refused) && limits.name === 'e2e camera' && !!limits.version && limits.connection === 'not-configured', limits);
  const title = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).find((t) => /^Home camera/.test(t)));
  check('the camera window title follows the name', title === 'Home camera — e2e camera', title);
  const avatarSaw = await page.evaluate(async () => (await /** @type {any} */ (window).lawnmower.settings.get()).tapo.name);
  check('the avatar window sees the camera window\'s change', avatarSaw === 'e2e camera', avatarSaw);
  // nothing the camera page loaded (MediaPipe's runtime and model included) left the app
  await new Promise((r) => setTimeout(r, 2500));
  const leaked = await electronApp.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.blockedRequests());
  check('no request left the camera window', Array.isArray(leaked) && leaked.length === 0, leaked);
  report.cameraConsoleErrors = camErrors;
  check('camera page: no console errors', camErrors.length === 0, camErrors);
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ tapo: { enabled: false, name: 'camera' } }));
  let left = await windowCount();
  for (let i = 0; i < 50 && left !== 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
    left = await windowCount();
  }
  check('turning the home camera off closes its window', left === 1, left);
}

// ---- "Hey Jade" (wake word; docs/WAKE.md; contract-wake §3.2) ----
/**
 * "Hey Jade" without a microphone test (scripts/wake-e2e.mjs does that): off by default there is
 * no "Jade wake word" process; turned on, main forks it (from app.asar when packaged) with this
 * platform's sherpa-onnx addon, model B and the VAD (resources/wake when packaged, vendor/wake
 * otherwise) and it reports ready; turned off, the process is gone. Unpackaged without
 * `npm run fetch:wake` the engine part is skipped (with WAKE_ENGINE_REQUIRED=1 it fails).
 * @param {import('@playwright/test').ElectronApplication} electronApp @param {import('@playwright/test').Page} page
 */
async function wakeChecks(electronApp, page) {
  const e2e = () => electronApp.evaluate(() => {
    const w = /** @type {any} */ (globalThis).__lawnmowerE2E?.wake;
    return w ? { keys: Object.keys(w).sort(), status: w.status(), rows: w.metrics(), pid: w.utilityPid(), host: w.host?.(), wakeDir: w.wakeDir(), addon: w.addonPath(), zhenDir: w.zhenDir(), resources: process.resourcesPath } : null;
  });
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  const dataWake = () => page.evaluate(() => document.body.dataset.wake || '');
  const w0 = await e2e();
  check('LAWNMOWER_E2E: the wake-word hooks', !!w0 && ['addonPath', 'emitPower', 'lastHits', 'metrics', 'restartUtility', 'stats', 'status', 'utilityPid', 'wakeDir', 'zhenDir'].every((k) => w0.keys.includes(k)), w0?.keys);
  if (!w0) return;
  const st0 = await page.evaluate(() => /** @type {any} */ (window).lawnmower.wake.status());
  const chip0 = await dataWake();
  check('"Hey Jade" off by default: engine "off", no "Jade wake word" process, state "off"', st0.engine === 'off' && st0.version === '1.13.8' && w0.rows.length === 0 && !w0.pid && chip0 === 'off', { st0, rows: w0.rows, chip0 });
  /** @type {Record<string, any>} */
  const out = { wakeDir: w0.wakeDir, addon: w0.addon };
  report.wake = out;
  if (packaged) check('packaged: the wake-word engine comes from resources/wake', w0.wakeDir === path.join(w0.resources, 'wake'), w0.wakeDir);
  if (!fs.existsSync(w0.addon)) {
    if (packaged || process.env.WAKE_ENGINE_REQUIRED === '1') check('the wake-word engine is installed', false, w0.addon);
    else out.skipped = `the wake-word engine is not fetched (${w0.addon}): npm run fetch:wake`;
    return;
  }
  const t0 = Date.now();
  // (without the local voice the engine parks a minute after the app started: VOICE_PARK_MS)
  out.enabledAfterLaunchMs = t0 - launchedAt;
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ wake: { enabled: true, explained: true } }));
  let w = await e2e();
  // how the utility starts: its CPU time and memory over time, and the stage it reported
  /** @type {any[]} */
  const trace = [];
  out.trace = trace;
  // (the whole machine's CPU use between samples: a starved utility on a saturated runner)
  let cpuPrev = cpuTimes();
  const sample = () => {
    const r = w?.rows.find((x) => x.pid === w.pid);
    const now = cpuTimes();
    const busy = now.total > cpuPrev.total ? Math.round((100 * (now.busy - cpuPrev.busy)) / (now.total - cpuPrev.total)) : null;
    cpuPrev = now;
    trace.push({ ms: Date.now() - t0, pid: w?.pid ?? null, stage: w?.host?.stage, cpuSec: r?.cumulativeCpuSec ?? null, memKB: r?.memoryKB ?? null, prio: priorityOf(w?.pid), machineBusyPct: busy, engine: w?.status.engine });
  };
  sample();
  /** @type {Promise<any>|null} */
  let probe = null;
  // An engine in 'error' after a timeout gets one restart after 1 s: wait for that one too (each
  // attempt may take up to READY_CAP_MS). A fatal start error is never retried: stop at once.
  const until = t0 + 2 * READY_CAP_MS + 15000;
  const settled = () => w.status.engine === 'ready' || w.status.engine === 'missing'
    || (w.status.engine === 'error' && ((w.host?.restarts ?? 0) > 0 || w.host?.noRestart));
  for (let i = 0; w && !settled() && Date.now() < until; i++) {
    await sleep(500);
    w = await e2e();
    if (i % 2 === 1) sample();
    if (i === 3) {
      // every process of the app with its priority (os.getPriority: 0 normal, 10 below normal, 19 idle)
      const procs = await electronApp.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '' })));
      out.priorities = procs.map((x) => ({ ...x, prio: priorityOf(x.pid) }));
    }
    if (i === 15 && w?.status.engine !== 'ready' && w?.pid && process.platform === 'win32') probe = probeWindowsProcess(w.pid);
  }
  if (probe) out.probe = await probe;
  out.readyMs = Date.now() - t0;
  out.status = w?.status;
  out.host = w?.host;
  // the engine's own lines (the utility's output included): why it did or did not start
  try {
    out.log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split(/\r?\n/).filter((l) => l.includes('[wake]')).slice(-40);
  } catch (err) {
    out.log = [`(main.log: ${/** @type {Error} */ (err).message})`];
  }
  check('turned on: the engine is ready with model B and the VAD', w?.status.engine === 'ready' && w.status.models.giga === 'ok' && w.status.models.vad === 'ok' && typeof w.status.loadMs === 'number', w?.status);
  // (Electron reports the serviceName as the row's name; serviceName is the Mojo service)
  const row = w?.rows.find((r) => r.pid === w.pid);
  out.utility = row || null;
  out.zhen = w?.zhenDir ? 'zh-en + GigaSpeech' : 'GigaSpeech alone';
  check('a "Jade wake word" utility process is running', !!row && row.type === 'Utility' && (row.name === 'Jade wake word' || row.serviceName === 'Jade wake word'), w?.rows);
  if (packaged) check('packaged: no zh-en model is used (it is never installed)', !w?.zhenDir, w?.zhenDir);
  // the renderer's state follows (without the local voice it keeps the microphone closed)
  await sleep(1500);
  out.dataWake = await dataWake();
  check('the renderer shows a "Hey Jade" state', !!out.dataWake && out.dataWake !== 'off', out.dataWake);
  const pid = w?.pid;
  await page.evaluate(() => /** @type {any} */ (window).lawnmower.settings.set({ wake: { enabled: false } }));
  let gone = false;
  let st = null;
  for (let i = 0; i < 50 && !gone; i++) {
    await sleep(100);
    const x = await e2e();
    st = x?.status;
    let alive = false;
    try {
      if (pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch { /* gone */ }
    gone = !!x && x.status.engine === 'off' && x.rows.length === 0 && !alive;
  }
  check('turned off: the "Jade wake word" process is gone', gone, st);
}
/** The machine's CPU time so far (ms, all cores): busy and total. */
function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** os.getPriority() of a process, or null. @param {number|null|undefined} pid */
function priorityOf(pid) {
  if (!pid) return null;
  try {
    return os.getPriority(pid);
  } catch {
    return null;
  }
}

/**
 * Windows: what a utility that is still starting is doing (priority class, threads and their wait
 * reasons, CPU, the engine's DLLs it has loaded). Runs alongside the trace; at most 90 s.
 * @param {number} pid
 * @returns {Promise<any>}
 */
function probeWindowsProcess(pid) {
  const ps = `$ErrorActionPreference='SilentlyContinue'
$p = Get-Process -Id ${Number(pid)}
$a = [pscustomobject]@{ cpu = $p.CPU; threads = $p.Threads.Count; priority = "$($p.PriorityClass)"; basePriority = $p.BasePriority; ws = $p.WorkingSet64 }
Start-Sleep -Seconds 2
$p.Refresh()
$waits = $p.Threads | Group-Object { "$($_.ThreadState)/$($_.WaitReason)/$($_.CurrentPriority)" } | ForEach-Object { "$($_.Name)=$($_.Count)" }
[pscustomobject]@{
  first = $a
  cpuAfter2s = $p.CPU
  waits = @($waits)
  modules = @($p.Modules | Where-Object { $_.ModuleName -match 'onnx|sherpa|dxcore|dxgi|d3d|setupapi|cfgmgr' } | ForEach-Object { $_.FileName })
} | ConvertTo-Json -Depth 4 -Compress`;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 90000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ tookMs: Date.now() - t0, ...JSON.parse(stdout.trim()) });
      } catch {
        resolve({ tookMs: Date.now() - t0, code, error: (stderr || stdout).slice(0, 500) });
      }
    });
  });
}
// ---- end "Hey Jade" ----

// ---- "Hey Jade" (wake word; contract-wake §3.1 gate 5, §5.1) ----
/**
 * resources/wake/ of a built app: this platform's sherpa-onnx addon, model B (GigaSpeech), the
 * Silero VAD and the licence texts, each byte for byte the file pinned in electron/wake/config.js,
 * the utility's entry in app.asar — and no zh-en model anywhere (licence gate), nor another
 * platform's addon.
 * @param {string} res process.resourcesPath of the packaged app
 */
function packagedWakeChecks(res) {
  const key = `${process.platform}-${process.arch}`;
  const wake = path.join(res, 'wake');
  const sha = (/** @type {string} */ f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  /** @type {Array<{ rel: string, sha256?: string }>} */
  const want = [
    ...(/** @type {any} */ (ADDON_FILES)[key] || []).map((/** @type {any} */ f) => ({ rel: `${LAYOUT.addonDir(key)}/${f.name}`, sha256: f.sha256 })),
    ...MODEL_FILES.giga.map((f) => ({ rel: `${LAYOUT.gigaDir}/${f.name}`, sha256: f.sha256 })),
    { rel: `${LAYOUT.gigaDir}/MODEL_CARD.md` },
    { rel: LAYOUT.vad, sha256: MODEL_FILES.vad.sha256 },
    ...['sherpa-onnx-LICENSE.txt', 'onnxruntime-LICENSE.txt', 'silero-vad-LICENSE.txt'].map((n) => ({ rel: `${LAYOUT.licensesDir}/${n}` })),
  ];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const wrong = [];
  for (const f of want) {
    const file = path.join(wake, ...f.rel.split('/'));
    if (!fs.existsSync(file)) missing.push(f.rel);
    else if (f.sha256 && sha(file) !== f.sha256) wrong.push(f.rel);
  }
  /** @type {string[]} */
  const all = [];
  const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else all.push(r);
    }
  };
  walk(wake, '');
  // an allowlist: anything else (the zh-en model, another platform's addon, a stray file) fails
  const unexpected = all.filter((r) => !want.some((f) => f.rel === r));
  report.packagedWake = { files: all.length, missing, wrong, unexpected };
  check(`resources/wake: the ${key} addon, model B, the VAD and the licences`, missing.length === 0, missing);
  check('resources/wake: the engine files are the pinned ones (SHA-256)', wrong.length === 0, wrong);
  check('resources/wake: nothing else (no zh-en model: it is downloaded on the user\'s PC; no other platform\'s addon)', unexpected.length === 0, unexpected);
}
// ---- end "Hey Jade" ----

/**
 * What the installer has to deliver, checked inside the running packaged app.
 * @param {import('@playwright/test').ElectronApplication} electronApp
 */
async function packagedChecks(electronApp) {
  const info = await electronApp.evaluate(() => {
    const t = /** @type {any} */ (globalThis).__lawnmowerE2E;
    if (!t) return null;
    const fsm = process.getBuiltinModule('node:fs');
    const pathm = process.getBuiltinModule('node:path');
    const res = t.resourcesPath();
    const files = ['app.asar', 'voice/lawnmower_voice/__main__.py', 'voice/pyproject.toml', 'scripts/setup-voice.ps1', 'scripts/setup-voice.sh', 'scripts/setup-voice.cmd', 'THIRD_PARTY_NOTICES.md',
      // the camera's face tracker (Electron's fs reads inside app.asar)
      'app.asar/dist/assets/vision/face_landmarker.task', 'app.asar/dist/assets/vision/wasm/vision_wasm_module_internal.js', 'app.asar/dist/assets/vision/wasm/vision_wasm_module_internal.wasm',
      // the home camera: its page, preload, person detector model, and go2rtc + its license
      'app.asar/dist/tapo/index.html', 'app.asar/electron/preload-camera.cjs', 'app.asar/electron/tapo/index.js', 'app.asar/dist/assets/security/efficientdet_lite0_int8.tflite',
      // "Hey Jade": the utility's entry (forked from inside app.asar; resources/wake: packagedWakeChecks)
      'app.asar/electron/wake/utility/main.js', 'app.asar/electron/wake/utility/sherpa.js',
      process.platform === 'win32' ? 'tapo/go2rtc.exe' : 'tapo/go2rtc', 'tapo/go2rtc-LICENSE.txt'];
    const unwanted = ['voice/tests', 'voice/.venv', 'voice/models', 'app.asar.unpacked/node_modules', 'app.asar/dist/dev', 'app.asar/tools', 'app.asar/vendor',
      // "Hey Jade": the zh-en model (no stated licence) is downloaded on the user's PC, never shipped
      'wake/dev-models', 'wake/models/zh-en-3m', 'wake/models/kws'];
    // the bundled go2rtc runs here and is the pinned release (docs/TAPO.md, scripts/fetch-go2rtc.mjs)
    let go2rtcVersion = '';
    try {
      const bin = pathm.join(res, 'tapo', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc');
      go2rtcVersion = String(process.getBuiltinModule('node:child_process').execFileSync(bin, ['-version'], { timeout: 15000, windowsHide: true })).trim();
    } catch (err) {
      go2rtcVersion = `failed: ${/** @type {Error} */ (err).message}`;
    }
    return {
      go2rtcVersion,
      packaged: t.packaged(),
      resourcesPath: res,
      missing: files.filter((f) => !fsm.existsSync(pathm.join(res, f))),
      unwanted: unwanted.filter((f) => fsm.existsSync(pathm.join(res, f))),
      venvDirs: t.voiceVenvDirs(),
      setupScript: t.setupScript(),
      env: { LOCALAPPDATA: process.env.LOCALAPPDATA || '', XDG_DATA_HOME: process.env.XDG_DATA_HOME || '', HOME: process.env.HOME || '' },
    };
  });
  report.packagedInfo = info;
  check('LAWNMOWER_E2E hook present', !!info, info);
  if (!info) return;
  check('app.isPackaged', info.packaged === true, info.packaged);
  check('resources complete', info.missing.length === 0, info.missing);
  check('no tests / venv / models in resources', info.unwanted.length === 0, info.unwanted);
  check('the bundled go2rtc runs and is 1.9.14', /^go2rtc version 1\.9\.14\b/.test(info.go2rtcVersion), info.go2rtcVersion);
  packagedWakeChecks(info.resourcesPath);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const expectedHome = process.platform === 'win32'
    ? [info.env.LOCALAPPDATA, 'LawnmowerMan', 'voice'].join(sep)
    : [info.env.XDG_DATA_HOME || `${info.env.HOME}/.local/share`, 'lawnmower-man', 'voice'].join(sep);
  check('sidecar looks in the per-user voice folder first', info.venvDirs[0] === `${expectedHome}${sep}.venv`, { venvDirs: info.venvDirs, expectedHome });
  check('setup script is the bundled one', info.setupScript === [info.resourcesPath, 'scripts', process.platform === 'win32' ? 'setup-voice.ps1' : 'setup-voice.sh'].join(sep), info.setupScript);
  if (!setupCheck) return;

  // The real "Set up local voice…" launcher in check mode: Windows opens a console window with
  // the bundled setup-voice.ps1 (path with spaces); Linux uses a terminal emulator when there is one.
  const started = await electronApp.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.voiceSetupCheck());
  report.voiceSetupStart = started;
  if (started.state === 'manual') {
    // no terminal emulator (headless Linux): the command must point at the bundled script
    check('voice setup: manual command for the bundled script', process.platform !== 'win32' && started.command.includes(info.setupScript.split(sep).slice(-2).join('/')) && started.command.includes('--check-only'), started);
    return;
  }
  let st = started;
  for (let i = 0; i < 240 && st && st.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    st = await electronApp.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.voiceSetupState());
  }
  report.voiceSetupResult = st;
  check('voice setup check ran in its own window', st?.state === 'done' && st.result?.check === true, st);
  check('setup script and sidecar agree on the voice folder', st?.result?.voiceHome === expectedHome && st?.result?.venv === info.venvDirs[0], { result: st?.result, venvDirs: info.venvDirs });
  check('setup script detected the installed app', st?.result?.packaged === true, st?.result);
}
