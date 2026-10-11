import { afterAll, describe, it, expect, vi } from 'vitest';

// every temporary folder made here is removed at the end (each holds tens of MB of stand-in files)
const madeDirs = [];
afterAll(() => {
  for (const d of madeDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});
const mkdtemp = (/** @type {string} */ prefix) => {
  const d = fs.mkdtempSync(prefix);
  madeDirs.push(d);
  return d;
};
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWake } from '../../../electron/wake/index.js';
import { SettingsStore } from '../../../electron/settings.js';
import { ADDON_FILES, MODEL_FILES } from '../../../electron/wake/config.js';
import { fakeChannel, fakeUtilityProcess, fakeWebContents } from './fakes.js';

/** A complete fake wake folder (pinned sizes) for linux-x64, optionally with the dev zh-en model. */
function wakeDir({ zhen = false, broken = false } = {}) {
  const dir = mkdtemp(path.join(os.tmpdir(), 'lm-wakeidx-'));
  const put = (rel, size) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(size));
  };
  for (const f of ADDON_FILES['linux-x64']) if (!(broken && f.name === 'sherpa-onnx.node')) put(`sherpa-onnx/linux-x64/${f.name}`, f.size);
  for (const f of MODEL_FILES.giga) put(`models/gigaspeech-3.3m/${f.name}`, f.size);
  put('models/silero_vad.onnx', MODEL_FILES.vad.size);
  if (zhen) for (const f of MODEL_FILES.zhen) put(`dev-models/zh-en-3m/${f.name}`, f.size);
  return dir;
}

class FakeZhen extends EventEmitter {
  constructor(o = {}) {
    super();
    this.state = 'unknown';
    this.modelsDir = null;
    this.checks = 0;
    this.downloads = [];
    this._check = o.check || (async () => { this.state = 'missing'; return null; });
  }

  async check() { this.checks++; return this._check(); }
  download(o = {}) { this.downloads.push(o); this.state = 'downloading'; return { ok: true, started: true }; }
  useDir(d) { this.dir = d; this.state = 'ok'; }
  stop() {}
}

function make({ enabled = true, zhen = false, broken = false, zhenMgr, env = {}, voice = {} } = {}) {
  const userData = mkdtemp(path.join(os.tmpdir(), 'lm-wakeud-'));
  const settings = new SettingsStore({ dir: userData, platform: 'linux' });
  settings.load();
  if (enabled) settings.update({ wake: { enabled: true } });
  const ipc = { handlers: new Map(), listeners: new Map() };
  const ipcMain = {
    handle: (ch, fn) => ipc.handlers.set(ch, fn),
    removeHandler: (ch) => ipc.handlers.delete(ch),
    on: (ch, fn) => ipc.listeners.set(ch, fn),
    removeListener: (ch) => ipc.listeners.delete(ch),
  };
  const up = fakeUtilityProcess();
  const sent = [];
  const pm = new EventEmitter();
  const trusted = vi.fn();
  const z = zhenMgr || new FakeZhen();
  const wake = createWake({
    electron: { app: { getPath: () => path.join(userData, 'docs'), getVersion: () => '0.5.0', getAppMetrics: () => [{ pid: up.forks[0]?.child.pid, type: 'Utility', serviceName: 'Jade wake word', cpu: { percentCPUUsage: 1.5 } }] },
      ipcMain, utilityProcess: up, MessageChannelMain: fakeChannel(), powerMonitor: pm, systemPreferences: { getMediaAccessStatus: () => 'granted' }, shell: { openPath: async () => '', openExternal: async () => {} } },
    settings, log: () => {}, userData, appRoot: '/app', isPackaged: false,
    env: { LAWNMOWER_WAKE_DIR: wakeDir({ zhen, broken }), LAWNMOWER_E2E: '1', ...env },
    voice: { voiceDir: '/app/voice', venvDirs: [], getVoiceSettings: () => settings.get().voice, ...voice },
    isTrustedSender: trusted, getAvatarWindow: () => null, sendToAvatar: (ch, p) => sent.push({ ch, p }), showAvatar: () => {},
    platform: 'linux', arch: 'x64', zhen: z,
  });
  return { wake, settings, up, ipc, sent, pm, trusted, z };
}
const until = async (fn) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  return fn();
};

describe('createWake (contract §3.2, §7.1)', () => {
  it('starts the utility when the wake word is on, with A when the dev model is there', async () => {
    const { wake, up, z } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    const init = up.last.posted[0].m;
    expect(init.t).toBe('init');
    expect(init.models.zhen).toBeTruthy();
    expect(init.addon).toMatch(/sherpa-onnx[\\/]linux-x64[\\/]sherpa-onnx\.node$/);
    expect(init.params).toEqual({ sensitivity: 'normal', phrase: 'hey-jade' });
    expect(z.checks).toBe(0); // no Python needed
    up.last.ready(['zhen', 'giga']);
    await until(() => wake.status().engine === 'ready');
    expect(wake.status()).toMatchObject({ engine: 'ready', models: { giga: 'ok', zhen: 'ok', vad: 'ok' }, version: '1.13.8', platform: 'linux-x64', loadMs: 2000, restarts: 0 });
    await wake.stop();
  });

  it('is off (no utility) while settings.wake.enabled is off; turning it on starts it, off stops it', async () => {
    const { wake, up, settings } = make({ enabled: false, zhen: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(up.forks).toHaveLength(0);
    expect(wake.status().engine).toBe('off');
    const prev = settings.get();
    settings.update({ wake: { enabled: true } });
    wake.applySettings(settings.get(), prev);
    await until(() => up.forks.length === 1);
    up.last.ready();
    up.last.onStop = () => up.last.emit('exit', 0);
    const prev2 = settings.get();
    settings.update({ wake: { enabled: false } });
    wake.applySettings(settings.get(), prev2);
    await until(() => wake.status().engine === 'off');
    expect(up.last.posted.some((p) => p.m.t === 'stop')).toBe(true);
    await wake.stop();
  });

  it('without model A it starts on B alone and downloads A once; when A is ready it restarts with it', async () => {
    const z = new FakeZhen();
    const { wake, up } = make({ zhenMgr: z });
    await until(() => up.forks.length === 1);
    expect(up.last.posted[0].m.models.zhen).toBeNull();
    await until(() => z.downloads.length === 1);
    expect(z.downloads[0]).toEqual({ auto: true });
    up.last.ready(['giga']);
    await until(() => wake.status().engine === 'ready');
    expect(wake.status().models.zhen).toBe('downloading');
    expect(wake.status().detail).toMatch(/basic wake-word model; the extra one is downloading/);
    // the download finished: a model A folder with the pinned sizes
    const d = mkdtemp(path.join(os.tmpdir(), 'lm-zhen-'));
    for (const f of MODEL_FILES.zhen) fs.writeFileSync(path.join(d, f.name), Buffer.alloc(f.size));
    z.state = 'ok';
    z.emit('ready', d);
    await until(() => up.forks.length === 2);
    expect(up.last.posted[0].m.models.zhen.encoder).toBe(path.join(d, 'encoder.int8.onnx'));
    await wake.stop();
  });

  it('missing engine files → engine "missing", no utility', async () => {
    const { wake, up } = make({ broken: true });
    await until(() => wake.status().engine === 'missing');
    expect(wake.status().detail).toBe('The wake-word engine is not installed; reinstall Lawnmower Man.');
    expect(up.forks).toHaveLength(0);
    expect(wake.trayState()).toMatchObject({ enabled: true, state: 'unavailable' });
    await wake.stop();
  });

  it('registers the lm:wake:* channels (avatar only) and hands out ports', async () => {
    const { wake, up, ipc, trusted } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    expect([...ipc.handlers.keys()].sort()).toEqual(['lm:wake:download', 'lm:wake:mic-access', 'lm:wake:open-mic-settings', 'lm:wake:request-port', 'lm:wake:restart', 'lm:wake:save-clip', 'lm:wake:status'] /* (restart added on purpose) */);
    const wc = fakeWebContents();
    const r = await ipc.handlers.get('lm:wake:request-port')({ sender: wc });
    expect(r).toEqual({ ok: true, gen: 1 });
    expect(trusted).toHaveBeenLastCalledWith({ sender: wc }, ['avatar']);
    expect(wc.sent[0]).toMatchObject({ channel: 'lm:wake:port', payload: { gen: 1 } });
    await expect(ipc.handlers.get('lm:wake:status')({ sender: wc }, 'x')).rejects.toThrow(/no arguments/);
    expect(await ipc.handlers.get('lm:wake:mic-access')({ sender: wc })).toBe('unknown'); // linux
    const clip = await ipc.handlers.get('lm:wake:save-clip')({ sender: wc }, { wav: new ArrayBuffer(10) });
    expect(clip.ok).toBe(false);
    // an untrusted sender is refused by main's isTrustedSender (which throws)
    trusted.mockImplementationOnce(() => { throw new Error('IPC from an untrusted sender was rejected'); });
    await expect(ipc.handlers.get('lm:wake:status')({ sender: {} })).rejects.toThrow(/untrusted/);
    await wake.stop();
    expect(ipc.handlers.size).toBe(0);
  });

  it('the renderer\'s state reaches the tray (coalesced), and the tray toggles the setting', async () => {
    const { wake, ipc, settings } = make({ zhen: true });
    const statusEvents = [];
    wake.on('status', () => statusEvents.push(1));
    ipc.listeners.get('lm:wake:state')({ sender: {} }, { state: 'waiting' });
    ipc.listeners.get('lm:wake:state')({ sender: {} }, { state: 'attention' });
    ipc.listeners.get('lm:wake:state')({ sender: {} }, { state: 'bogus' }); // refused, logged
    expect(wake.trayState()).toEqual({ enabled: true, state: 'attention', reason: '' });
    await until(() => statusEvents.length > 0);
    wake.trayActions.setWakeWord(false);
    expect(settings.get().wake.enabled).toBe(false);
    expect(wake.trayState()).toEqual({ enabled: false, state: 'off', reason: '' });
    await wake.stop();
  });

  it('lm:wake:restart ("Retry"): a new utility with a fresh restart budget; nothing while the wake word is off', async () => {
    const { wake, up, ipc, settings } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    up.last.ready();
    expect(await ipc.handlers.get('lm:wake:restart')({ sender: {} })).toEqual({ ok: true });
    expect(up.forks).toHaveLength(2);
    settings.update({ wake: { enabled: false } });
    expect(await ipc.handlers.get('lm:wake:restart')({ sender: {} })).toEqual({ ok: false });
    await wake.stop();
  });

  it('the utility stops when the local voice has been unusable a while, and starts again with it', async () => {
    let vs = 'ready';
    const { wake, up, settings, ipc } = make({ zhen: true, voice: { status: () => vs, parkMs: 40 } });
    await until(() => up.forks.length === 1);
    up.last.ready();
    up.last.onStop = () => up.last.emit('exit', 0);
    // a restart blip of the voice (error → starting) is shorter than the grace: nothing happens
    vs = 'error';
    wake.voiceChanged();
    vs = 'starting';
    wake.voiceChanged();
    await new Promise((r) => setTimeout(r, 80));
    expect(up.last.posted.some((p) => p.m.t === 'stop')).toBe(false);
    // gone for good (not installed, turned off): the utility stops
    vs = 'disabled';
    wake.voiceChanged();
    await until(() => up.last.posted.some((p) => p.m.t === 'stop'));
    expect(up.last.posted.some((p) => p.m.t === 'stop')).toBe(true);
    await until(() => /local voice/.test(wake.status().detail));
    expect(wake.status()).toMatchObject({ engine: 'starting', detail: expect.stringMatching(/Waiting for the local voice/) });
    expect(await ipc.handlers.get('lm:wake:restart')({ sender: {} })).toEqual({ ok: false });
    // turning the wake word off and on meanwhile starts nothing
    let prev = settings.get();
    settings.update({ wake: { enabled: false } });
    wake.applySettings(settings.get(), prev);
    prev = settings.get();
    settings.update({ wake: { enabled: true } });
    wake.applySettings(settings.get(), prev);
    await new Promise((r) => setTimeout(r, 30));
    expect(up.forks).toHaveLength(1);
    // the voice is back: so is the utility
    vs = 'starting';
    wake.voiceChanged();
    await until(() => up.forks.length === 2);
    expect(up.forks).toHaveLength(2);
    await wake.stop();
  });

  it('a voice that is not there at the start: the utility runs only for the grace period', async () => {
    const { wake, up } = make({ zhen: true, voice: { status: () => 'disabled', parkMs: 40 } });
    await until(() => up.forks.length === 1);
    up.last.ready();
    up.last.onStop = () => up.last.emit('exit', 0);
    await until(() => up.last.posted.some((p) => p.m.t === 'stop'));
    expect(up.last.posted.some((p) => p.m.t === 'stop')).toBe(true);
    await wake.stop();
  });

  it('test clips are bounded: one per 25 s, the folder opened at most once a minute (main cannot see the click)', async () => {
    const { wake, ipc } = make({ zhen: true });
    const pcm = new Int16Array(16000);
    const wav = new ArrayBuffer(44 + pcm.byteLength);
    const v = new DataView(wav);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    const save = () => ipc.handlers.get('lm:wake:save-clip')({ sender: {} }, { wav, hits: [] });
    const a = await save();
    expect(a.ok).toBe(true);
    const b = await save();
    expect(b).toMatchObject({ ok: false, error: expect.stringMatching(/a moment ago/) });
    await wake.stop();
  });

  it('forwards lock/unlock/suspend/resume to the avatar; e2e.emitPower fakes them', async () => {
    // (changed on purpose: 'resumed' comes about 1 s after the PC woke; each event has a seq)
    const { wake, pm, sent } = make({ zhen: true });
    pm.emit('lock-screen');
    pm.emit('resume');
    const power = () => sent.filter((s) => s.ch === 'lm:wake:power').map((s) => s.p.state);
    expect(power()).toEqual(['locked']);
    await until(() => power().length === 2);
    wake.e2e.emitPower('unlocked');
    expect(power()).toEqual(['locked', 'resumed', 'unlocked']);
    expect(sent.filter((s) => s.ch === 'lm:wake:power').map((s) => s.p.seq)).toEqual([1, 2, 3]);
    await wake.stop();
    pm.emit('lock-screen');
    expect(sent.filter((s) => s.ch === 'lm:wake:power')).toHaveLength(3);
  });

  it('the status carries the lock state, read from the OS when the window asks (a reload while locked starts locked)', async () => {
    const { wake, pm, ipc } = make({ zhen: true });
    pm.emit('lock-screen');
    pm.emit('suspend');
    pm.emit('resume'); // woke at the lock screen: still locked
    await new Promise((r) => setTimeout(r, 1100));
    expect(wake.status().power).toEqual({ locked: true, suspended: false, seq: 3 });
    await wake.stop();
    // a fresh main (the app restarted at the lock screen): the OS says so at the first request
    const b = make({ zhen: true });
    b.pm.getSystemIdleState = () => 'locked';
    const st = await b.ipc.handlers.get('lm:wake:status')({ sender: {} });
    expect(st.power).toMatchObject({ locked: true, suspended: false });
    await b.wake.stop();
    void ipc;
  });

  it('sends status changes to the avatar (≤ 4/s, deduplicated)', async () => {
    const { wake, up, sent } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    up.last.ready();
    await until(() => sent.some((s) => s.ch === 'lm:wake:status' && s.p.engine === 'ready'));
    const n = sent.filter((s) => s.ch === 'lm:wake:status').length;
    expect(n).toBeLessThanOrEqual(3);
    await wake.stop();
  });

  it('sensitivity / phrase changes go to the running utility', async () => {
    const { wake, up, settings } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    up.last.ready();
    const prev = settings.get();
    settings.update({ wake: { sensitivity: 'high', phrase: 'jade' } });
    wake.applySettings(settings.get(), prev);
    expect(up.last.posted.at(-1).m).toEqual({ t: 'settings', params: { sensitivity: 'high', phrase: 'jade' } });
    await wake.stop();
  });

  it('personaContext: only while the wake word is on', async () => {
    const { wake, settings } = make({ zhen: true });
    expect(wake.personaContext()).toEqual({ wake: { enabled: true, followUp: true, bargeIn: true } });
    settings.update({ wake: { followUpSec: 0, bargeIn: false } });
    expect(wake.personaContext()).toEqual({ wake: { enabled: true, followUp: false, bargeIn: false } });
    settings.update({ wake: { enabled: false } });
    expect(wake.personaContext()).toEqual({});
    await wake.stop();
  });

  it('e2e hooks: pid, metrics rows of the utility, a crash that supervision recovers', async () => {
    const { wake, up } = make({ zhen: true });
    await until(() => up.forks.length === 1);
    up.last.ready();
    expect(wake.e2e.utilityPid()).toBe(up.last.pid);
    expect(wake.e2e.metrics()).toEqual([{ pid: up.last.pid, type: 'Utility', serviceName: 'Jade wake word', name: undefined, cpu: 1.5, cumulativeCpuSec: null, memoryKB: null }]);
    wake.e2e.restartUtility();
    await until(() => wake.status().engine === 'starting');
    expect(wake.status().restarts).toBe(1);
    await wake.stop();
  });
});
