#!/usr/bin/env node
// Launch the REAL Electron app (electron/main.js) with Playwright's Electron driver and verify
// the whole main-process stack end to end: window flags, app:// + CSP, the preload bridge
// (window.lawnmower), settings IPC, a Claude turn streamed back to the renderer, voice status,
// and a clean shutdown of child processes.
//
//   node scripts/electron-e2e.mjs                 # fake Claude CLI (free, deterministic)
//   node scripts/electron-e2e.mjs --live          # the real logged-in `claude` CLI (one tiny turn)
//   node scripts/electron-e2e.mjs --screenshot out.png
//   ELECTRON_PATH=/path/to/electron node scripts/electron-e2e.mjs
//
// Needs the Electron binary (npm install downloads it) and a display (on headless Linux run it
// under `xvfb-run -a`). Uses a throwaway userData folder; never touches your real settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const shotIdx = argv.indexOf('--screenshot');
const screenshot = shotIdx >= 0 ? path.resolve(argv[shotIdx + 1]) : null;

let executablePath = process.env.ELECTRON_PATH;
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

const env = { ...process.env, LAWNMOWER_USER_DATA: userData };
if (!live) env.LAWNMOWER_CLAUDE_CLI = path.join(root, 'tests/fixtures/fake-claude.mjs');
delete env.ELECTRON_RUN_AS_NODE;

const args = [root];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');

/** @type {Record<string, any>} */
const report = { ok: false, live, checks: {} };
const check = (name, cond, detail) => {
  report.checks[name] = cond ? 'ok' : `FAILED${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`;
  if (!cond) report.failed = (report.failed || 0) + 1;
};

const app = await electron.launch({ executablePath, args, env, timeout: 60000 });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  report.url = page.url();
  check('loads app://lawnmower/index.html', report.url === 'app://lawnmower/index.html', report.url);

  // Main-process view of the window.
  const winInfo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { bounds: w.getBounds(), alwaysOnTop: w.isAlwaysOnTop(), resizable: w.isResizable(), visible: w.isVisible(), bg: w.getBackgroundColor() };
  });
  report.window = winInfo;
  check('window 400x840 (medium + chat)', winInfo.bounds.width === 400 && winInfo.bounds.height === 840, winInfo.bounds);
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
  check('bridge shape', JSON.stringify(shape.top) === JSON.stringify(['app', 'claude', 'onHotkey', 'settings', 'voice', 'window'])
    && JSON.stringify(shape.claude) === JSON.stringify(['interrupt', 'onEvent', 'reset', 'respondPermission', 'send', 'status']), shape);
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

  if (screenshot) await page.screenshot({ path: screenshot });
  report.mainLog = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8').split('\n').filter((l) => /\[gpu\]|\[claude\] using|ERROR/.test(l)).slice(0, 10);
  report.ok = !report.failed;
} finally {
  const pidBefore = await app.evaluate(() => process.pid).catch(() => null);
  await app.close().catch(() => {});
  report.closed = pidBefore !== null;
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
