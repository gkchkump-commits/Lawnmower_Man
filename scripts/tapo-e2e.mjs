#!/usr/bin/env node
// End-to-end test of the Home camera in the REAL Electron app (electron/main.js) against the
// camera simulator (tools/tapo-sim), with the real go2rtc, the real camera window and worker
// (WebCodecs decode, the stub person detector) and the fake Claude CLI (contract §12.3):
//
//   1. setup through the camera window's form (real clicks): Test connection, then Save → online,
//      go2rtc ready, live video
//   2. security: nothing leaves loopback, go2rtc listens on 127.0.0.1 only, the password is in no
//      file, log or command line
//   3. pan/tilt: Calibrate (mirrored pan + inverted tilt found, view units near the truth), D-pad,
//      press-and-hold, click-to-center, a preset, home, and the same from the keyboard
//   4. arm → a person walks in → event, notification, the avatar's line, a clip with pre-roll that
//      parses, its .jpg/.json, the events list and the player over app://…/__clips (Range)
//   4b. the camera's own events off → the local detector alone confirms a person (notification, clip)
//   4c. disarmed while the camera saw someone, re-armed with nobody there → no event, no alert
//   5. "describe" on → the next alert sends Claude a hidden turn with one picture
//   6. Claude's camera tools: approval card for a snapshot and for turning the camera,
//      pre-approved with claudeSee 'always', unavailable with claudeMove 'never'
//   7. privacy mode (PTZ "privacy", never "unsupported"; it clears by itself), the camera going
//      offline mid-session (shown as offline, the tray does not say plain "Armed") and coming back
//   8. quit: Unsubscribe, the RTSP session ends, go2rtc is gone
//
//   npx vite build && xvfb-run -a node scripts/tapo-e2e.mjs [--shots <dir>] [--report <file.json>] [--keep] [--verbose]
//   ELECTRON_PATH=…  LAWNMOWER_GO2RTC=<go2rtc binary>  (default: vendor/go2rtc/<platform>-<arch>/)
//
// Needs the Electron binary, the go2rtc binary (`npm run fetch:go2rtc`), a renderer build (dist/)
// and a display (xvfb-run on headless Linux). Prints a JSON report; exit 0 = every check passed,
// 1 = a check failed, 2 = cannot run here. Uses a throwaway userData folder.
/* global localStorage */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startSim, SIM_TRUTH } from '../tools/tapo-sim/index.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');
const shotsIdx = argv.indexOf('--shots');
const shotsDir = shotsIdx >= 0 ? path.resolve(argv[shotsIdx + 1]) : '';
const reportIdx = argv.indexOf('--report');
const reportFile = reportIdx >= 0 ? path.resolve(argv[reportIdx + 1]) : '';
const PASSWORD = 'se&cret';

/** @param {string} msg */
function cannotRun(msg) {
  console.error(`tapo-e2e: ${msg}`);
  process.exit(2);
}

let executablePath = process.env.ELECTRON_PATH;
if (!executablePath) {
  try {
    executablePath = require('electron');
  } catch (err) {
    cannotRun(`Electron binary not available (${/** @type {Error} */ (err).message}). Set ELECTRON_PATH.`);
  }
}
const go2rtc = process.env.LAWNMOWER_GO2RTC || path.join(root, 'vendor/go2rtc', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc');
if (!fs.existsSync(go2rtc)) cannotRun(`go2rtc not found at ${go2rtc}: run \`npm run fetch:go2rtc\` (or set LAWNMOWER_GO2RTC).`);
if (!fs.existsSync(path.join(root, 'dist/tapo/index.html'))) cannotRun('dist/tapo/index.html is missing: run `npx vite build` first.');
if (!fs.existsSync(path.join(root, 'electron/tapo/index.js'))) cannotRun('electron/tapo is missing (the Home camera is not merged in this checkout).');

const { _electron: electron } = require('@playwright/test');

/** @type {Record<string, any>} */
const report = { ok: false, checks: {}, timings: {} };
/** @param {string} name @param {unknown} cond @param {unknown} [detail] */
function check(name, cond, detail) {
  report.checks[name] = cond ? 'ok' : `FAILED${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`;
  if (!cond) report.failed = (report.failed || 0) + 1;
  if (verbose || !cond) console.error(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  return !!cond;
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Poll fn until it returns something truthy (or ms pass): the value, or null on timeout.
 * @template T @param {() => T|Promise<T>} fn @param {number} ms @returns {Promise<T|null>}
 */
async function until(fn, ms, interval = 200) {
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
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    check(`${label}: ran to the end`, false, String(/** @type {Error} */ (err).stack || err).slice(0, 800));
  }
  report.timings[label] = Date.now() - t0;
}

// ---------------------------------------------------------------------------------------------

const sim = await startSim({ log: verbose ? (l, m) => console.error(`[sim] ${l} ${m}`) : undefined });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-tapo-e2e-'));
const clipsDir = path.join(userData, 'clips');
const mcpLog = path.join(userData, 'fake-claude-mcp.jsonl');
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  claude: { workdir: path.join(userData, 'work') },
  tapo: { enabled: true, host: '127.0.0.1', onvifPort: sim.onvifPort, rtspPort: sim.rtspPort, username: 'camacct' },
  security: { armDelaySec: 0, preRollSec: 3, postRollSec: 3, cooldownSec: 10, clipsDir },
}));
const env = {
  ...process.env,
  LAWNMOWER_USER_DATA: userData,
  LAWNMOWER_E2E: '1',
  LAWNMOWER_CLAUDE_CLI: path.join(root, 'tests/fixtures/fake-claude.mjs'),
  LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1',
  LAWNMOWER_TAPO_FAKE_DETECTOR: '1',
  LAWNMOWER_GO2RTC: go2rtc,
  FAKE_CLAUDE_MCP_LOG: mcpLog,
};
delete env.ELECTRON_RUN_AS_NODE;
const args = [root];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');

/** @type {any} */
let app = null;
/** @type {any} */
let avatar = null;
/** @type {any} */
let cam = null;
/** @type {string[]} */
const consoleErrors = [];
let go2rtcPid = 0;

/** @param {any} page @param {string} name */
async function shot(page, name) {
  if (!shotsDir || !page) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {});
}
const e2e = (/** @type {string} */ fn, /** @type {any} */ arg) => app.evaluate((_e, [f, a]) => {
  const t = /** @type {any} */ (globalThis).__lawnmowerE2E?.tapo;
  return t && typeof t[f] === 'function' ? t[f](a) : null;
}, [fn, arg]);
const status = () => e2e('status');
const settingsOf = () => avatar.evaluate(() => window.lawnmower.settings.get());
const setSettings = (/** @type {any} */ patch) => avatar.evaluate((p) => window.lawnmower.settings.set(p), patch);

/** Mean brightness of the middle of the live view (from a screenshot decoded in the page). */
async function liveBrightness() {
  const png = await cam.locator('#live').screenshot();
  return cam.evaluate(async (/** @type {string} */ b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.round(img.width * 0.2), Math.round(img.height * 0.3), Math.round(img.width * 0.4), Math.round(img.height * 0.3)).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

/** Text of the avatar's chat transcript. */
const transcript = () => avatar.locator('#transcript').innerText().catch(() => '');

/** Send a typed message from the avatar's chat box. @param {string} text */
async function say(text) {
  await avatar.locator('#input').fill(text);
  await avatar.locator('#input').press('Enter');
}

/** The listening sockets of a process, from /proc (Linux) or netstat (Windows). @param {number} pid */
function listeningAddresses(pid) {
  if (process.platform === 'linux') {
    const inodes = new Set();
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`, { encoding: 'utf8' }) || '');
      if (m) inodes.add(m[1]);
    }
    const out = [];
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols[3] !== '0A' || !inodes.has(cols[9])) continue; // 0A = LISTEN
        out.push(cols[1]); // hex ip:port
      }
    }
    return out.map((hex) => {
      const [ip, port] = hex.split(':');
      const addr = ip.length === 8 ? ip.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.') : ip;
      return `${addr}:${parseInt(port, 16)}`;
    });
  }
  if (process.platform === 'win32') {
    const { execFileSync } = require('node:child_process');
    const text = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    return text.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && l.trim().endsWith(` ${pid}`)).map((l) => l.trim().split(/\s+/)[1]);
  }
  return [];
}

/** Every file under a folder (bounded). @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && out.length < 5000) out.push(p); // not Chromium's Singleton* symlinks
    }
  };
  walk(dir);
  return out;
}

try {
  app = await electron.launch({ executablePath, args, env, timeout: 60000 });
  // two windows open at start (the camera window hidden): pick them by URL
  avatar = await until(() => app.windows().find((/** @type {any} */ w) => w.url() === 'app://lawnmower/index.html'), 30000);
  if (!avatar) throw new Error(`no avatar window: ${app.windows().map((/** @type {any} */ w) => w.url()).join(', ')}`);
  avatar.on('console', (/** @type {any} */ m) => { if (m.type() === 'error') consoleErrors.push(`avatar: ${m.text()}`); });
  avatar.on('pageerror', (/** @type {any} */ e) => consoleErrors.push(`avatar pageerror: ${e.message}`));
  await avatar.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });

  // ---- 1. setup through the camera window ---------------------------------------------------
  await step('1 setup', async () => {
    await avatar.evaluate(() => window.lawnmower.tapo.openWindow());
    cam = await until(() => app.windows().find((/** @type {any} */ w) => /\/tapo\/index\.html/.test(w.url())), 20000);
    if (!check('camera window opens (app://lawnmower/tapo/index.html)', cam && cam.url() === 'app://lawnmower/tapo/index.html', cam && cam.url())) throw new Error('no camera window');
    cam.on('console', (/** @type {any} */ m) => { if (m.type() === 'error') consoleErrors.push(`camera: ${m.text()}`); });
    cam.on('pageerror', (/** @type {any} */ e) => consoleErrors.push(`camera pageerror: ${e.message}`));
    await cam.waitForFunction(() => document.body.dataset.boot === 'ready', null, { timeout: 30000 });
    check('camera window: no window.lawnmower (no Claude API), window.lawnmowerCamera present',
      await cam.evaluate(() => typeof window.lawnmower === 'undefined' && typeof window.lawnmowerCamera === 'object'));
    const st0 = await status();
    check('not configured before a password is stored', st0 && st0.configured === false && st0.hasPassword === false, st0 && { configured: st0.configured, connection: st0.connection });
    await cam.locator('#setup').waitFor({ state: 'visible', timeout: 10000 });
    check('the setup form is pre-filled from the settings', (await cam.locator('#tapo-set-host').inputValue()) === '127.0.0.1' && (await cam.locator('#tapo-set-username').inputValue()) === 'camacct');
    await shot(cam, '1-setup');
    await cam.locator('#tapo-set-password').fill(PASSWORD);
    // Test connection first (with the typed, unsaved password): every step passes, nothing moves
    const movesBefore = sim.calls.filter((c) => c.service === 'ptz' && /Move|GotoPreset/.test(c.op)).length;
    await cam.locator('#setup').getByRole('button', { name: 'Test connection', exact: true }).click();
    const report = cam.locator('#setup .report');
    const tested = await until(async () => {
      const cls = (await report.getAttribute('class').catch(() => '')) || '';
      return /\b(ok|fail)\b/.test(cls) ? cls : null;
    }, 30000);
    const steps = await report.locator('.report-step').evaluateAll((els) => els.map((e) => `${/** @type {HTMLElement} */ (e).dataset.step}:${e.className.replace('report-step', '').trim()}`)).catch(() => []);
    check('Test connection: every step passes', /\bok\b/.test(tested || '') && ['host', 'auth', 'profiles', 'ptz', 'rtsp'].every((id) => steps.includes(`${id}:ok`)), { tested, steps });
    check('…and the camera did not move during the test', sim.calls.filter((c) => c.service === 'ptz' && /Move|GotoPreset/.test(c.op)).length === movesBefore);
    await shot(cam, '1-tested');
    await cam.locator('#setup').getByRole('button', { name: 'Save', exact: true }).click();
    const online = await until(async () => (await status())?.connection === 'online', 30000);
    check('status online after Save', online, (await status())?.detail);
    const ready = await until(async () => {
      const s = await status();
      return s?.go2rtc?.state === 'ready' && s?.stream?.state === 'live' ? s : null;
    }, 30000);
    check('go2rtc ready, stream live', ready, (await status())?.stream);
    const st = await status();
    check('device: Tapo C211 (serial not exposed)', st?.device?.model === 'Tapo C211' && !JSON.stringify(st).includes('4c4e9a1b'), st?.device);
    const fps = await until(async () => {
      const w = await e2e('workerStats');
      return w && w.fps >= 8 ? w.fps : null;
    }, 30000);
    check('worker decodes ≥ 8 fps', fps, await e2e('workerStats'));
    const bright = await until(async () => {
      const b = await liveBrightness();
      return b > 30 ? b : null;
    }, 20000);
    check('the live view shows the picture (not black)', bright, await liveBrightness().catch((err) => String(err)));
    await shot(cam, '1-live');
    go2rtcPid = await e2e('go2rtcPid');
    check('go2rtc runs as a child process', go2rtcPid > 0, go2rtcPid);
    check('one RTSP session at the camera', sim.state.rtspSessions.live.length === 1, sim.state.rtspSessions.live.length);
  });

  // ---- 2. security ----------------------------------------------------------------------------
  await step('2 security', async () => {
    const blocked = await app.evaluate(() => /** @type {any} */ (globalThis).__lawnmowerE2E.blockedRequests());
    check('no blocked requests so far (nothing tried to leave the PC)', blocked.length === 0, blocked);
    const lan = await cam.evaluate(async () => {
      try {
        await fetch('http://192.168.77.1:2020/onvif/device_service', { method: 'POST' });
        return 'reached';
      } catch (err) {
        return `refused: ${String(err && /** @type {any} */ (err).message)}`;
      }
    });
    check('the camera window cannot reach the LAN itself', lan.startsWith('refused'), lan);
    if (go2rtcPid) {
      const addrs = listeningAddresses(go2rtcPid);
      check('go2rtc listens on 127.0.0.1 only (no RTSP/WebRTC servers)', process.platform !== 'linux' || (addrs.length >= 1 && addrs.every((a) => a.startsWith('127.0.0.1:'))), addrs);
      if (process.platform === 'linux') {
        const cmdline = fs.readFileSync(`/proc/${go2rtcPid}/cmdline`, 'utf8');
        check('the password is not on go2rtc\'s command line', !cmdline.includes(PASSWORD) && !cmdline.includes(encodeURIComponent(PASSWORD)));
        // go2rtc reaches the camera through main's RTSP auth proxy: it never has the password
        const environ = String(await e2e('go2rtcEnviron') || '');
        check('go2rtc never has the password (not in its environment either: main\'s RTSP proxy signs in)', environ.length > 0 && !environ.includes(PASSWORD) && !environ.includes(encodeURIComponent(PASSWORD)) && !/LM_CAM_/.test(environ), environ.split('\0').map((l) => l.split('=')[0]).filter((k) => k.startsWith('LM_')));
      }
    }
    await sleep(500);
    const leaks = filesUnder(userData).filter((f) => !f.startsWith(path.join(userData, 'work')) && !f.startsWith(clipsDir)).filter((f) => {
      const text = fs.readFileSync(f).toString('latin1');
      return text.includes(PASSWORD) || text.includes(encodeURIComponent(PASSWORD));
    });
    check('the password is in no file of the app (settings, credentials, logs, go2rtc config)', leaks.length === 0, leaks.map((f) => path.relative(userData, f)));
    const credFile = await e2e('credentialsFile');
    const st = await status();
    check('the password is stored encrypted, or kept in memory when this system cannot encrypt', (st.persistence === 'encrypted' && fs.existsSync(credFile)) || (st.persistence === 'memory' && !fs.existsSync(credFile)), { persistence: st.persistence, exists: fs.existsSync(credFile) });
    const settingsFile = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
    check('settings.json holds the user name but no password field', settingsFile.includes('camacct') && !/"password"/.test(settingsFile));
  });

  // ---- 3. pan / tilt ----------------------------------------------------------------------------
  await step('3 ptz', async () => {
    // Calibrate from the banner the window shows until it is done
    const banner = cam.locator('.banner[data-banner="calibrate"]');
    if (await banner.isVisible().catch(() => false)) await banner.getByRole('button', { name: 'Calibrate…' }).click();
    else {
      await cam.locator('#btn-settings').click();
      await cam.getByRole('button', { name: 'Calibrate…' }).first().click();
    }
    const dlg = cam.locator('dialog#calibrate');
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    await dlg.getByRole('button', { name: 'Start', exact: true }).click();
    const done = await until(async () => {
      const s = await dlg.getAttribute('data-step');
      return s === 'done' || s === 'failed' || s === 'ask' ? s : null;
    }, 120000, 500);
    await shot(cam, '3-calibrated');
    check('calibration finishes on its own (no question)', done === 'done', { step: done, text: await dlg.innerText().catch(() => '') });
    const t = (await settingsOf()).tapo;
    check('calibration found the mirrored pan and the inverted tilt', t.invertPan === true && t.invertTilt === true, { invertPan: t.invertPan, invertTilt: t.invertTilt });
    const within = (/** @type {number} */ v, /** @type {number} */ truth) => v > truth * 0.6 && v < truth * 1.4;
    report.calibration = { invertPan: t.invertPan, invertTilt: t.invertTilt, viewUnitsX: t.viewUnitsX, viewUnitsY: t.viewUnitsY, minStep: t.minStep, msPerUnit: t.msPerUnit, truth: SIM_TRUTH };
    check(`view units within ±40 % of the truth (${SIM_TRUTH.viewUnitsX} / ${SIM_TRUTH.viewUnitsY.toFixed(1)})`, within(t.viewUnitsX, SIM_TRUTH.viewUnitsX) && within(t.viewUnitsY, SIM_TRUTH.viewUnitsY), report.calibration);
    check('calibratedAt is set', !!t.calibratedAt, t.calibratedAt);
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click().catch(() => {});
    const idle = () => until(() => !sim.state.ptz.moving, 10000);
    await idle();
    await sleep(1600); // the settle time after a move

    // D-pad right → the mirrored camera gets a negative x
    let t0 = Date.now();
    await cam.locator('.dpad-right').click();
    const rel = await until(() => sim.callsOf('RelativeMove', t0)[0], 5000);
    check('D-pad right → RelativeMove with x < 0 (mirrored pan, after calibration)', rel && rel.args.x < 0 && rel.args.y === 0, rel && rel.args);
    await idle();

    // press and hold left for 1 s → ContinuousMove(s), then a Stop (or the hold's own timeout)
    t0 = Date.now();
    const b = await cam.locator('.dpad-left').boundingBox();
    await cam.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await cam.mouse.down();
    await sleep(1000);
    await cam.mouse.up();
    await until(() => !sim.state.ptz.moving, 4000);
    const cont = sim.callsOf('ContinuousMove', t0).filter((c) => c.args.x !== 0);
    check('hold left 1 s → ContinuousMove x > 0 (mirrored), then it stops', cont.length >= 1 && cont[0].args.x > 0 && !sim.state.ptz.moving, cont.map((c) => c.args));
    check('…with a Stop after the release', sim.callsOf('Stop', t0).length >= 1, sim.calls.filter((c) => c.t >= t0 && c.service === 'ptz').map((c) => c.op));
    await idle();
    await sleep(1600);

    // click-to-center: three quarters across the picture → about 0.25 view widths
    t0 = Date.now();
    const box = await cam.locator('#live').boundingBox();
    const st = await status();
    const vw0 = st.stream.width || 640;
    const vh0 = st.stream.height || 360;
    const k = Math.min(box.width / vw0, box.height / vh0);
    const vx = box.x + (box.width - vw0 * k) / 2;
    const vy = box.y + (box.height - vh0 * k) / 2;
    await cam.mouse.click(vx + vw0 * k * 0.75, vy + vh0 * k * 0.5);
    const centre = await until(() => sim.callsOf('RelativeMove', t0)[0], 5000);
    const want = -0.25 * t.viewUnitsX;
    check('click-to-center → a proportional RelativeMove', centre && Math.abs(centre.args.x - want) < Math.max(0.03, Math.abs(want) * 0.2) && centre.args.y === 0, { got: centre && centre.args, want });
    await idle();

    // a preset, then home
    t0 = Date.now();
    await cam.locator('.preset-go', { hasText: 'Door' }).click();
    const go = await until(() => sim.callsOf('GotoPreset', t0)[0], 5000);
    check('preset "Door" → GotoPreset 1', go && go.args.token === '1', go && go.args);
    await idle();
    t0 = Date.now();
    await cam.locator('.dpad-home').click();
    const home = await until(() => sim.callsOf('AbsoluteMove', t0)[0], 5000);
    check('home → AbsoluteMove(0, 0)', home && home.args.x === 0 && home.args.y === 0, home && home.args);
    await idle();
    await sleep(1600);

    // the same from the keyboard (the window focused, not in a text field)
    await cam.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.());
    t0 = Date.now();
    await cam.keyboard.press('ArrowRight');
    const keyRel = await until(() => sim.callsOf('RelativeMove', t0)[0], 5000);
    check('key → : RelativeMove with x < 0 (like the D-pad)', keyRel && keyRel.args.x < 0 && keyRel.args.y === 0, keyRel && keyRel.args);
    await idle();
    await sleep(1600);
    t0 = Date.now();
    await cam.keyboard.press('1');
    const keyPreset = await until(() => sim.callsOf('GotoPreset', t0)[0], 5000);
    check('key 1: the first saved position (GotoPreset 1)', keyPreset && keyPreset.args.token === '1', keyPreset && keyPreset.args);
    await idle();
    await sleep(1600);
    t0 = Date.now();
    await cam.keyboard.press('h');
    const keyHome = await until(() => sim.callsOf('AbsoluteMove', t0)[0], 5000);
    check('key H: home (AbsoluteMove 0, 0)', keyHome && keyHome.args.x === 0 && keyHome.args.y === 0, keyHome && keyHome.args);
    await idle();
    check('the motor never pushed against an end stop', sim.state.ptz.endStopMs === 0, sim.state.ptz.endStopMs);
    await sleep(1600);
    // F: full screen (the live view), and back
    const camFull = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => /\/tapo\/index\.html/.test(x.webContents.getURL()));
      return w ? w.isFullScreen() : null;
    });
    await cam.keyboard.press('f');
    // (the page's own state: the window reports full screen a moment before the page does, and
    // an F pressed in between would ask again instead of leaving)
    const full = await until(() => cam.evaluate(() => !!document.fullscreenElement || document.body.dataset.full === '1'), 5000);
    check('key F: the live view goes full screen', full, { page: await cam.evaluate(() => !!document.fullscreenElement), window: await camFull() });
    await cam.keyboard.press('f');
    const left = await until(async () => {
      const p = await cam.evaluate(() => ({ page: !!document.fullscreenElement, filled: document.body.dataset.full === '1' }));
      return !p.page && !p.filled && !(await camFull());
    }, 5000);
    check('…and F again leaves it (the window too, no window-filling fallback left over)', left, { page: await cam.evaluate(() => ({ full: !!document.fullscreenElement, filled: document.body.dataset.full })), window: await camFull() });
  });

  // ---- 4. arm, a person, the clip --------------------------------------------------------------
  /** @type {any} */
  let event = null;
  await step('4 security', async () => {
    await cam.locator('.arm').click();
    const armed = await until(async () => (await status())?.security?.armed && !(await status())?.security?.arming, 10000);
    check('armed (no exit delay in this test)', armed, (await status())?.security);
    await until(async () => (await status())?.events?.onvif === 'subscribed', 15000);
    check('subscribed to the camera\'s events', (await status())?.events?.onvif === 'subscribed', (await status())?.events);
    await sleep(4500); // the pre-roll ring fills (3 s at GOP granularity)
    sim.set({ person: true });
    // the figure walking in is local motion at once; the stub detector needs 2 of 3 samples, so
    // the event may start as motion and upgrade to person (contract §8.8 event-update)
    const first = await until(async () => (await status())?.security?.active, 20000);
    report.firstEventKind = first?.kind;
    event = await until(async () => {
      const a = (await status())?.security?.active;
      return a && a.kind === 'person' && a.sources?.includes('local-person') ? a : null;
    }, 20000);
    check('a person event starts (camera event + the local stub detector)', event && event.kind === 'person', event || first);
    check('…confirmed by the local detector', event && event.sources?.includes('local-person') && !event.unconfirmed, (event || first)?.sources);
    await until(() => avatar.locator('#transcript').getByText('Someone is at the camera.').count(), 15000);
    check('the avatar says "Someone is at the camera."', (await transcript()).includes('Someone is at the camera.'), (await transcript()).slice(-300));
    // …and looks toward the camera window (lm:tapo:look → the gaze holds that point for a few seconds)
    const where = await app.evaluate(({ BrowserWindow }) => {
      const ws = BrowserWindow.getAllWindows();
      const c = (/** @type {any} */ w) => { const b = w.getBounds(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const av = ws.find((w) => w.webContents.getURL() === 'app://lawnmower/index.html');
      const cw = ws.find((w) => /\/tapo\/index\.html/.test(w.webContents.getURL()));
      return av && cw ? { avatar: c(av), camera: c(cw) } : null;
    });
    const gaze = await avatar.evaluate(() => ({ source: window.__app?.gaze?.source ?? null, target: window.__app?.gaze?.target ?? null }));
    const wantSign = where ? Math.sign(where.camera.x - where.avatar.x) : 0;
    check('the avatar looks toward the camera window', gaze.source === 'cursor' && Array.isArray(gaze.target) && (wantSign === 0 || Math.sign(gaze.target[0]) === wantSign), { gaze, where });
    await shot(avatar, '4-avatar-alert');
    const notes = await until(async () => {
      const n = await e2e('notifications');
      return n && n.length ? n : null;
    }, 10000);
    check('a Windows notification is shown ("Person at the camera")', notes && /Person at the camera/.test(notes[0].title), notes);
    await shot(cam, '4-person');
    sim.set({ person: false });
    const ended = await until(async () => !(await status())?.security?.active, 20000);
    check('the event ends after the post-roll', ended);
    const list = await until(async () => {
      const r = await cam.evaluate(() => window.lawnmowerCamera.tapo.events.list({ limit: 5 }));
      const e = r.events.find((/** @type {any} */ x) => x.kind === 'person' && x.clipUrl);
      return e || null;
    }, 15000);
    check('the event is listed with a clip and a snapshot', list && list.clipUrl && list.snapshotUrl, list);
    event = list || event;
    report.event = event;
    const dir = await e2e('clipsDir');
    const files = filesUnder(dir);
    // the file keeps the kind the event started with (a motion event upgraded to person keeps -motion-)
    const base = event?.clipUrl ? path.basename(String(event.clipUrl)) : '';
    const mp4 = files.find((f) => (base ? path.basename(f) === base : /\d{6}-(person|motion)-[a-z0-9]{4}\.mp4$/.test(f)));
    check('clip, .jpg and .json are on disk', mp4 && fs.existsSync(mp4.replace(/\.mp4$/, '.jpg')) && fs.existsSync(mp4.replace(/\.mp4$/, '.json')), files.map((f) => path.relative(dir, f)));
    if (mp4) {
      const { Fmp4Parser } = await import(pathToFileURL(path.join(root, 'electron/tapo/fmp4.js')).href);
      const parser = new Fmp4Parser();
      /** @type {any[]} */
      const samples = [];
      /** @type {any} */
      let init = null;
      parser.on('init', (/** @type {any} */ i) => { init = i; });
      parser.on('sample', (/** @type {any} */ s) => samples.push(s));
      parser.push(fs.readFileSync(mp4));
      parser.end();
      const last = samples.at(-1);
      const dur = init && last ? (last.dts + last.duration) / init.timescale : 0;
      report.clip = { file: path.relative(dir, mp4), bytes: fs.statSync(mp4).size, samples: samples.length, durationSec: dur };
      check('the clip parses: first sample a keyframe, ≥ 3 s, timeline from 0', init && samples[0]?.key && samples[0]?.dts === 0 && dur >= 3, report.clip);
      const rec = JSON.parse(fs.readFileSync(mp4.replace(/\.mp4$/, '.json'), 'utf8'));
      check('the event record has its sources and no host or password', rec.kind === 'person' && Array.isArray(rec.sources) && !JSON.stringify(rec).includes(PASSWORD) && !JSON.stringify(rec).includes('127.0.0.1:'), rec);
    }
    // the events list → the player loads the clip over app:// (Range)
    await cam.locator('.event', { hasText: /person/i }).first().click();
    const dlg = cam.locator('dialog#player');
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    const src = await dlg.locator('video').getAttribute('src');
    check('the player plays app://lawnmower/__clips/…', /^app:\/\/lawnmower\/__clips\/\d{4}-\d{2}-\d{2}\/\d{6}-(person|motion)-[a-z0-9]{4}\.mp4$/.test(src || ''), src);
    const ready = await until(() => dlg.locator('video').evaluate((/** @type {HTMLVideoElement} */ v) => (v.readyState >= 1 ? v.duration : 0)), 15000);
    check('…and the <video> reads it (H.264 in Electron)', ready && ready >= 3, ready);
    const ranged = await cam.evaluate(async (/** @type {string} */ u) => {
      const r = await fetch(u, { headers: { Range: 'bytes=0-99' } });
      return { status: r.status, range: r.headers.get('content-range'), len: (await r.arrayBuffer()).byteLength };
    }, src);
    check('the clip is served with Range (206)', ranged.status === 206 && ranged.len === 100 && /^bytes 0-99\//.test(ranged.range || ''), ranged);
    await shot(cam, '4-player');
    await dlg.getByRole('button', { name: 'Close', exact: true }).last().click().catch(() => {});
  });

  // ---- 4b. the camera's events off: the local detector alone (1 Hz) confirms a person ------------
  await step('4b local only', async () => {
    await setSettings({ security: { cameraEvents: false } });
    await until(async () => (await status())?.events?.onvif === 'off', 10000);
    await sleep(11_000); // past the 10 s cooldown of the last person alert
    const n0 = ((await e2e('notifications')) || []).length;
    sim.set({ person: true });
    const ev = await until(async () => {
      const a = (await status())?.security?.active;
      return a && a.kind === 'person' && a.sources?.includes('local-person') ? a : null;
    }, 30000);
    check('camera events off: the local detector alone confirms the person (armed rate, no boost)', ev && !ev.sources.some((/** @type {string} */ x) => x.startsWith('camera-')), ev || (await status())?.security?.active);
    const notes = await until(async () => {
      const n = (await e2e('notifications')) || [];
      return n.length > n0 ? n : null;
    }, 10000);
    check('…a notification is shown', notes && /Person at the camera/.test(notes.at(-1).title), notes && notes.slice(n0));
    check('…and it is recorded', (await status())?.security?.recording === true, (await status())?.security);
    sim.set({ person: false });
    await until(async () => !(await status())?.security?.active, 20000);
    const clip = await until(async () => {
      const r = await cam.evaluate(() => window.lawnmowerCamera.tapo.events.list({ limit: 5 }));
      return r.events.find((/** @type {any} */ x) => x.id === ev?.id && x.clipUrl) || null;
    }, 15000);
    check('…with a clip', !!clip, clip);
    await setSettings({ security: { cameraEvents: true } });
    await until(async () => (await status())?.events?.onvif === 'subscribed', 15000);
  });

  // ---- 4c. disarmed while the camera saw someone, re-armed with nobody there: nothing --------------
  await step('4c re-arm', async () => {
    await sleep(11_000); // past the cooldown
    sim.set({ person: true });
    await until(async () => (await status())?.security?.active, 20000);
    await cam.locator('.arm').click(); // disarm while the camera still reports the person
    await until(async () => !(await status())?.security?.armed, 5000);
    sim.set({ person: false });
    await sleep(3000);
    const n0 = ((await e2e('notifications')) || []).length;
    const total0 = (await cam.evaluate(() => window.lawnmowerCamera.tapo.events.list({ limit: 1 }))).total;
    await cam.locator('.arm').click();
    await until(async () => (await status())?.security?.armed && (await status())?.events?.onvif === 'subscribed', 15000);
    await sleep(10_000);
    const total1 = (await cam.evaluate(() => window.lawnmowerCamera.tapo.events.list({ limit: 1 }))).total;
    const n1 = ((await e2e('notifications')) || []).length;
    check('re-armed with nobody there: no event and no notification (the old camera state ended with the subscription)', total1 === total0 && n1 === n0 && !(await status())?.security?.active, { events: total1 - total0, notifications: n1 - n0, active: (await status())?.security?.active });
  });

  // ---- 5. Claude describes the next alert --------------------------------------------------------
  await step('5 describe', async () => {
    await setSettings({ security: { describe: true } });
    await avatar.evaluate(() => { try { localStorage.setItem('lawnmower.tapo.describe-consent.v1', 'yes'); } catch { /* */ } });
    await sleep(11000); // past the 10 s cooldown of this test
    sim.set({ person: true });
    const saw = await until(async () => /\[saw 1 image: image\/jpeg \d+x\d+, \d+ bytes\]/.test(await transcript()), 30000);
    check('the alert sends Claude one picture in a hidden turn (the fake CLI saw it)', saw, (await transcript()).slice(-400));
    sim.set({ person: false });
    await until(async () => !(await status())?.security?.active, 20000);
    await setSettings({ security: { describe: false } });
  });

  // ---- 6. Claude's camera tools -------------------------------------------------------------------
  await step('6 mcp', async () => {
    await until(async () => (await avatar.evaluate(() => window.lawnmower.claude.status())).status === 'ready', 30000);
    const initTools = await until(() => {
      const lines = fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
      const inits = lines.filter((l) => l.kind === 'initialize');
      return inits.length && inits.at(-1).request.sdkMcpServers ? inits.at(-1).request.sdkMcpServers : null;
    }, 20000);
    check('the CLI is offered the in-process camera server', Array.isArray(initTools) && initTools.includes('lawnmower-camera'), initTools);
    await say('camera camera_snapshot {}');
    const card = avatar.locator('.perm-card');
    const shown = await until(() => card.isVisible(), 20000);
    check('camera_snapshot on "ask" shows an approval card', shown);
    const cardText = shown ? { tool: await card.locator('.perm-tool').textContent(), all: await card.textContent() } : null;
    check('…the card says "Camera: snapshot", and the app\'s own words are not "Claude says"', !!cardText && cardText.tool === 'Camera: snapshot' && !/Claude says|mcp__/.test(cardText.all), cardText);
    await shot(avatar, '6-approval');
    if (shown) {
      await sleep(1200); // cards ignore clicks for a moment after they appear
      await card.locator('.perm-allow').click();
    }
    const img = await until(async () => /Tool camera_snapshot returned 1 image \(image\/jpeg \d+x\d+, \d+ bytes\)/.test(await transcript()), 30000);
    check('…allowed: Claude gets a JPEG from the camera', img, (await transcript()).slice(-400));

    // turning the camera on "ask": a card too; allowed, the camera turns and Claude is told
    await until(async () => !(await card.isVisible().catch(() => false)), 10000);
    await sleep(1600);
    const beforeLook = (await transcript()).length;
    const tLook = Date.now();
    await say('camera camera_look {"direction":"left"}');
    const lookCard = await until(() => card.isVisible(), 20000);
    check('camera_look on "ask" shows an approval card', lookCard);
    await shot(avatar, '6-approval-look');
    if (lookCard) {
      await sleep(1200);
      await card.locator('.perm-allow').click();
    }
    const turned = await until(async () => /Tool camera_look returned text: Turned left\./.test((await transcript()).slice(beforeLook)), 30000);
    const lookMove = sim.calls.find((c) => c.t >= tLook && c.service === 'ptz' && /RelativeMove|ContinuousMove/.test(c.op));
    check('…allowed: the camera turns left (mirrored: x > 0) and Claude hears "Turned left."', turned && lookMove && lookMove.args.x > 0, { move: lookMove && { op: lookMove.op, args: lookMove.args }, text: (await transcript()).slice(beforeLook).slice(-300) });
    await until(() => !sim.state.ptz.moving, 10000);

    await setSettings({ security: { claudeSee: 'always', claudeMove: 'never' } });
    await until(async () => (await avatar.evaluate(() => window.lawnmower.claude.status())).status === 'ready', 30000);
    await sleep(500);
    const before = (await transcript()).length;
    await say('camera camera_snapshot {}');
    const again = await until(async () => /Tool camera_snapshot returned 1 image/.test((await transcript()).slice(before)), 30000);
    check('claudeSee "always": no card, the picture arrives', again && !(await card.isVisible().catch(() => false)), (await transcript()).slice(before));
    const before2 = (await transcript()).length;
    await say('camera camera_look {"direction":"left"}');
    const unavailable = await until(async () => (await transcript()).slice(before2).includes('Tool unavailable.'), 30000);
    check('claudeMove "never": camera_look is not offered at all', unavailable, (await transcript()).slice(before2));
    await setSettings({ security: { claudeSee: 'ask', claudeMove: 'ask' } });
  });

  // ---- 7. privacy mode, offline --------------------------------------------------------------------
  await step('7 privacy-offline', async () => {
    sim.set({ privacy: true });
    await cam.locator('.dpad-left').click().catch(() => {});
    await cam.locator('.dpad-left').click().catch(() => {});
    const priv = await until(async () => (await status())?.ptz?.privacySuspected, 10000);
    check('privacy mode suspected after PTZ answers malformed / 500', priv, (await status())?.ptz);
    check('…and PTZ is not marked unsupported', (await status())?.ptz?.available === true);
    const hint = await until(async () => /privacy mode/i.test(await cam.locator('body').innerText()), 5000);
    check('the camera window says to turn privacy mode off', hint);
    await shot(cam, '7-privacy');
    sim.set({ privacy: false });
    // the suspicion is re-checked every 5 s: it clears once the camera answers normally again
    const cleared = await until(async () => !(await status())?.ptz?.privacySuspected, 20000, 500);
    check('privacy mode off → the suspicion clears by itself (no 60 s wait)', cleared, (await status())?.ptz);

    sim.set({ offline: true });
    // armed: the video stops, the app asks the camera (no sign-in), and calls it offline
    const down = await until(async () => (await status())?.connection === 'unreachable', 45000, 500);
    check('the camera going offline mid-session is shown as offline (not "Online")', down, { connection: (await status())?.connection, stream: (await status())?.stream?.state });
    const { tapoLabel } = await import(pathToFileURL(path.join(root, 'electron/tray-menu.js')).href);
    const tray = await e2e('trayState');
    check('…and the tray does not say plain "Armed"', !tray?.armed || tapoLabel(tray) === 'Armed · camera offline', { tray, label: tray && tapoLabel(tray) });
    // (the window renders main's status a moment later: wait for it, as a user would see it)
    await until(async () => (await cam.locator('.badge-text').innerText().catch(() => '')) === 'Offline', 10000, 250);
    const badge = await cam.locator('.badge-text').innerText().catch(() => '');
    check('…nor the camera window ("Offline")', badge === 'Offline', badge);
    await until(() => cam.evaluate(() => /camera offline/.test(document.querySelector('.arm')?.textContent || '')), 10000, 250);
    const armBox = await cam.evaluate(() => ({ arm: document.querySelector('.arm')?.getBoundingClientRect().right ?? 1e9, inner: window.innerWidth, label: document.querySelector('.arm')?.textContent || '' }));
    check('…its arm button (to disarm) stays in the window, saying "Armed · camera offline"', armBox.arm <= armBox.inner && /camera offline/.test(armBox.label), armBox);
    await shot(cam, '7-offline');
    sim.set({ offline: false });
    const back = await until(async () => {
      const s = await status();
      return s?.connection === 'online' && s?.stream?.state === 'live';
    }, 120000, 500);
    check('…and it recovers when the camera is back', back, { connection: (await status())?.connection, stream: (await status())?.stream });
    // (quit checks the Unsubscribe of a subscription made after the outage)
    if ((await status())?.security?.armed) await until(async () => (await status())?.events?.onvif === 'subscribed', 30000, 500);
  });

  // the LAN fetch of step 2 is refused by the CSP on purpose, which Chromium logs as an error
  const unexpected = consoleErrors.filter((m) => !m.includes('192.168.77.1'));
  report.consoleErrors = consoleErrors;
  check('no console errors in either window (besides the refused LAN probe)', unexpected.length === 0, unexpected.slice(0, 10));
  await shot(cam, '9-final');

  // ---- 8. quit ----------------------------------------------------------------------------------------
  await step('8 quit', async () => {
    const pid = go2rtcPid || (await e2e('go2rtcPid'));
    const armed = (await status())?.security?.armed;
    const t0 = Date.now();
    await app.close();
    app = null;
    report.quitMs = Date.now() - t0;
    if (armed) check('quit: the event subscription is cancelled (Unsubscribe)', sim.callsOf('Unsubscribe', t0).length >= 1, sim.calls.filter((c) => c.t >= t0).map((c) => c.op));
    check('quit: no RTSP session is left at the camera', sim.state.rtspSessions.live.length === 0, sim.state.rtspSessions.live);
    check('quit: the RTSP session was ended with TEARDOWN', sim.callsOf('TEARDOWN', t0).length >= 1, sim.state.rtspSessions.ended.slice(-2).map((s) => s.endReason));
    const gone = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    check('quit: the go2rtc process is gone', gone, pid);
  });
} catch (err) {
  check('the run did not crash', false, String(/** @type {Error} */ (err).stack || err).slice(0, 1500));
} finally {
  if (app) await app.close().catch(() => {});
  report.sim = { calls: sim.calls.length, authFailures: sim.state.authFailures, subscriptions: sim.state.subscriptions.created };
  check('the app never sent a wrong password to the camera', sim.state.authFailures.onvif === 0 && sim.state.authFailures.rtsp === 0, sim.state.authFailures);
  await sim.close();
  report.ok = !report.failed;
  report.userData = keep ? userData : undefined;
  if (!report.ok) {
    const logFile = path.join(userData, 'logs', 'main.log');
    if (fs.existsSync(logFile)) report.mainLogTail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-60);
  }
  if (!keep) fs.rmSync(userData, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
  console.error(`tapo-e2e: ${Object.values(report.checks).filter((v) => v === 'ok').length} passed, ${report.failed || 0} failed`);
  process.exit(report.ok ? 0 : 1);
}
