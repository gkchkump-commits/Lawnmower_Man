// The "Hey Jade" engine bench in real Electron (contract-wake §11.7): createWake() with the real
// utilityProcess, the vendored addon and models, a sandboxed, context-isolated page that gets the
// audio port the way the app's preload forwards it, and the fixture stream played in real time.
// Measures the utility's CPU (app.getAppMetrics and the utility's own process.cpuUsage) in silence
// and during speech, the port's round trip, and the latency from the end of "Jade" to the hit
// arriving in the page.
//
//   xvfb-run -a node_modules/electron/dist/electron --no-sandbox tools/wake/bench/main.mjs [out.json]
//   env: BENCH_SILENCE_SEC (default 20), LAWNMOWER_WAKE_DIR, LAWNMOWER_WAKE_ZHEN_DIR

import { app, BrowserWindow, MessageChannelMain, ipcMain, powerMonitor, shell, systemPreferences, utilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWake } from '../../../electron/wake/index.js';
import { SettingsStore } from '../../../electron/settings.js';
import { buildStream, readManifest, FIXTURES, REPO, SR } from '../fixture-stream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv.find((a) => a.endsWith('.json')) || path.join(os.tmpdir(), 'wake-bench.json');
const silenceSec = Number(process.env.BENCH_SILENCE_SEC || 20);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-wake-bench-'));
app.setPath('userData', userData);

const logs = [];
const log = (level, msg) => {
  logs.push(`${level} ${msg}`);
  if (level !== 'debug') console.log(`${level} ${msg}`);
};

app.whenReady().then(async () => {
  const settings = new SettingsStore({ dir: userData, log });
  settings.load();
  settings.update({ wake: { enabled: true, explained: true } });
  /** @type {BrowserWindow|null} */
  let win = null;
  const wake = createWake({
    electron: { app, ipcMain, utilityProcess, MessageChannelMain, powerMonitor, systemPreferences, shell },
    settings, log, userData, appRoot: REPO, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged,
    env: { ...process.env, LAWNMOWER_WAKE_DIR: process.env.LAWNMOWER_WAKE_DIR || path.join(REPO, 'vendor', 'wake'), LAWNMOWER_E2E: '1' },
    voice: { voiceDir: path.join(REPO, 'voice'), venvDirs: [], getVoiceSettings: () => ({ enabled: false }) },
    isTrustedSender: (event) => {
      if (!win || event.sender !== win.webContents) throw new Error('IPC from an untrusted sender was rejected');
    },
    getAvatarWindow: () => win,
    sendToAvatar: (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); },
    showAvatar: () => {},
  });

  // the plan: silence (room noise at −60 dBFS), then the fixture stream
  const rows = readManifest(FIXTURES);
  const fixtures = buildStream(rows, { gapSec: 1.0, floorDb: -60, seed: 7 });
  const silence = buildStream([], { floorDb: -60, seed: 3, tailSec: silenceSec }).audio;
  const plan = { frame: 683, phases: [{ name: 'silence', audio: silence }, { name: 'speech', audio: fixtures.audio }] };

  // CPU of the utility from outside: getAppMetrics once a second, and (Linux) the kernel's own
  // utime + stime of the process at each phase boundary
  /** @type {Array<{ t: number, phase: string|null, cpu: number|null, cum: number|null, mem: number|null }>} */
  const samples = [];
  let phase = /** @type {string|null} */ (null);
  const metricsTimer = setInterval(() => {
    const rows2 = wake.e2e.metrics();
    const r = rows2[0];
    samples.push({ t: Date.now(), phase, cpu: r ? r.cpu : null, cum: r ? r.cumulativeCpuSec : null, mem: r ? r.memoryKB : null });
  }, 1000);
  /** @type {Record<string, { start?: { t: number, ticks: number|null }, end?: { t: number, ticks: number|null } }>} */
  const procCpu = {};
  ipcMain.on('bench:progress', (_e, p) => {
    phase = p.start ? p.phase : null;
    const ph = (procCpu[p.phase] ||= {});
    ph[p.start ? 'start' : 'end'] = { t: Date.now(), ticks: procTicks(wake.e2e.utilityPid()) };
    console.log(`bench: ${p.phase} ${p.start ? 'start' : 'end'}`);
  });

  const done = new Promise((resolve) => ipcMain.once('bench:done', (_e, r) => resolve(r)));
  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(here, 'bench.html'));
  const t0 = Date.now();
  // wait until the engine is up (model loading) before the plan starts
  for (let i = 0; i < 300 && wake.status().engine !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  const loadWaitMs = Date.now() - t0;
  win.webContents.send('bench:plan', plan);
  const r = await done;
  clearInterval(metricsTimer);
  const st = wake.status();
  const pid = wake.e2e.utilityPid();
  const report = { electron: process.versions.electron, node: process.versions.node, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, loadavg: os.loadavg(), status: st, loadWaitMs, utilityPid: pid, clkTck: 100, procCpu, samples, result: r, spans: fixtures.spans, logs: logs.slice(-50) };
  const t1 = Date.now();
  await wake.stop();
  report.stopMs = Date.now() - t1;
  await new Promise((res) => setTimeout(res, 500));
  report.utilityAfterStop = procState(pid); // null = gone
  fs.writeFileSync(out, JSON.stringify(report));
  console.log(`bench: wrote ${out}; stop took ${report.stopMs} ms; utility after stop: ${report.utilityAfterStop ?? 'gone'}`);
  app.quit();
});

/** utime + stime of a process in clock ticks (Linux), or null. @param {number|null} pid */
function procTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return Number(rest[11]) + Number(rest[12]);
  } catch {
    return null;
  }
}

/** The process state letter (R/S/Z…), or null when gone. @param {number|null} pid */
function procState(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return f.slice(f.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return null;
  }
}

app.on('window-all-closed', () => {});
void SR;
