#!/usr/bin/env node
// Launch the REAL Electron app (electron/main.js) with Playwright's Electron driver and verify
// the whole main-process stack end to end: window flags, app:// + CSP, the preload bridge
// (window.lawnmower), settings IPC, a Claude turn streamed back to the renderer, voice status,
// a complete renderer boot without console errors, and a clean shutdown of child processes.
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
// resources/{app.asar, voice/, scripts/setup-voice.*}, the per-user voice folder the sidecar looks
// in, and — through the real "Set up local voice…" launcher, in -CheckOnly mode — that the bundled
// setup script reports exactly that folder (--no-setup-check skips it; on Linux without a terminal
// emulator, --fake-terminal puts a stand-in "xterm" on PATH so the script really runs). The fake CLI and the
// throwaway userData folder reach the packaged app through LAWNMOWER_CLAUDE_CLI /
// LAWNMOWER_USER_DATA, which packaged builds honour on purpose (threat model: electron/main.js);
// LAWNMOWER_E2E=1 exposes a few main-process helpers to app.evaluate().
//
// Needs the Electron binary (npm install downloads it) and a display (on headless Linux run it
// under `xvfb-run -a`). Uses a throwaway userData folder; never touches your real settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { windowLayout } from '../electron/window-manager.js';

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

const env = { ...process.env, LAWNMOWER_USER_DATA: userData, LAWNMOWER_E2E: '1' };
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

/** @type {Record<string, any>} */
const report = { ok: false, live, packaged, checks: {} };
const check = (name, cond, detail) => {
  report.checks[name] = cond ? 'ok' : `FAILED${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`;
  if (!cond) report.failed = (report.failed || 0) + 1;
};

const app = await electron.launch({ executablePath, args, env, timeout: 60000 });
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
      top: keys(lm), claude: keys(lm.claude), voice: keys(lm.voice), settings: keys(lm.settings), window: keys(lm.window), app: keys(lm.app),
      nodeLeak: typeof (/** @type {any} */ (window).require) !== 'undefined' || typeof (/** @type {any} */ (window).process) !== 'undefined',
      ipcLeak: typeof (/** @type {any} */ (window).ipcRenderer) !== 'undefined',
    };
  });
  report.bridge = shape;
  check('bridge shape', JSON.stringify(shape.top) === JSON.stringify(['app', 'claude', 'onCursor', 'onHotkey', 'settings', 'voice', 'window'])
    && JSON.stringify(shape.claude) === JSON.stringify(['cancel', 'interrupt', 'onEvent', 'reset', 'respondPermission', 'retry', 'send', 'status'])
    && JSON.stringify(shape.voice) === JSON.stringify(['info', 'onStatus', 'restart', 'setup']), shape);
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

  const voice = await page.evaluate(() => /** @type {any} */ (window).lawnmower.voice.info());
  report.voice = voice;
  check('voice status reported', ['disabled', 'starting', 'ready', 'error'].includes(voice.status), voice);

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
    const files = ['app.asar', 'voice/lawnmower_voice/__main__.py', 'voice/pyproject.toml', 'scripts/setup-voice.ps1', 'scripts/setup-voice.sh', 'scripts/setup-voice.cmd', 'THIRD_PARTY_NOTICES.md'];
    const unwanted = ['voice/tests', 'voice/.venv', 'voice/models', 'app.asar.unpacked/node_modules'];
    return {
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
