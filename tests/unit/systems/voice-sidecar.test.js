// VoiceSidecar tests with tests/fixtures/fake-voice.mjs standing in for `python -m lawnmower_voice`.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VoiceSidecar,
  describeHealth,
  healthSettling,
  locatePython,
  packagedVoiceHome,
  parseArgString,
  sttLanguageArg,
  voiceServerEnv,
  voiceVenvDirs,
} from '../../../electron/voice-sidecar.js';

const FAKE = path.resolve('tests/fixtures/fake-voice.mjs');
const live = [];
afterEach(async () => {
  while (live.length) {
    const h = live.pop();
    await h.sidecar.stop();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

function harness({ settings = {}, fakeArgs = [], opts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-voice-'));
  const logFile = path.join(dir, 'voice-argv.jsonl');
  const s = { enabled: true, pythonPath: '', sttModel: 'large-v3-turbo', sttLanguage: 'en', ttsVoice: 'af_heart', ttsSpeed: 1, device: 'cuda', ...settings };
  const statuses = [];
  const sidecar = new VoiceSidecar({
    getSettings: () => s,
    voiceDir: dir,
    command: { file: FAKE, args: ['--fake-log-file', logFile, ...fakeArgs] },
    restart: { baseDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 },
    readyTimeoutMs: 3000,
    healthIntervalMs: 0,
    ...opts,
  });
  const waiters = new Set();
  sidecar.on('status', (info) => {
    statuses.push(info);
    for (const w of [...waiters]) w(info);
  });
  const waitFor = (pred, timeout = 8000) =>
    new Promise((resolve, reject) => {
      const hit = statuses.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout; statuses: ${JSON.stringify(statuses.map((x) => [x.status, x.detail]))}`)), timeout);
      const w = (info) => {
        if (pred(info)) {
          clearTimeout(timer);
          waiters.delete(w);
          resolve(info);
        }
      };
      waiters.add(w);
    });
  const runs = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const h = { dir, s, sidecar, statuses, waitFor, runs };
  live.push(h);
  return h;
}

describe('locatePython', () => {
  const fsWith = (files) => ({
    statSync: (p) => {
      if (files.includes(p)) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  it('finds the Windows venv interpreter', () => {
    const r = locatePython({ venvDirs: ['C:\\app\\voice\\.venv'], platform: 'win32', fs: fsWith(['C:\\app\\voice\\.venv\\Scripts\\python.exe']) });
    expect(r).toMatchObject({ python: 'C:\\app\\voice\\.venv\\Scripts\\python.exe', fromSettings: false });
  });
  it('finds the POSIX venv interpreter (python3 fallback)', () => {
    const r = locatePython({ venvDirs: ['/a/.venv', '/b/.venv'], platform: 'linux', fs: fsWith(['/b/.venv/bin/python3']) });
    expect(r.python).toBe('/b/.venv/bin/python3');
    expect(r.tried).toEqual(['/a/.venv/bin/python', '/a/.venv/bin/python3', '/b/.venv/bin/python', '/b/.venv/bin/python3']);
  });
  it('prefers settings.voice.pythonPath', () => {
    const r = locatePython({ pythonPath: '~/py/bin/python', homedir: '/home/ada', venvDirs: ['/v'], platform: 'linux', fs: fsWith(['/home/ada/py/bin/python', '/v/bin/python']) });
    expect(r).toMatchObject({ python: '/home/ada/py/bin/python', fromSettings: true });
  });
  it('returns null when nothing is installed', () => {
    expect(locatePython({ venvDirs: ['/v'], platform: 'linux', fs: fsWith([]) }).python).toBeNull();
  });
});

describe('helpers', () => {
  it('parseArgString splits with quotes', () => {
    expect(parseArgString('--fake --name "two words" \'x y\'')).toEqual(['--fake', '--name', 'two words', 'x y']);
    expect(parseArgString('')).toEqual([]);
  });
  it('describeHealth summarises GPU and model state', () => {
    expect(describeHealth({ device: { cuda: true, name: 'RTX 5070', vramTotalMB: 8151 }, stt: { loaded: true }, tts: { loaded: false } }))
      .toBe('GPU: RTX 5070 (8 GB) · speech recognition loaded · voice not loaded yet');
    expect(describeHealth({ device: { cuda: false }, stt: { error: 'boom' } })).toBe('CPU mode · speech recognition error: boom');
  });
});

describe('VoiceSidecar', () => {
  it('is disabled when turned off in settings', async () => {
    const h = harness({ settings: { enabled: false } });
    await h.sidecar.start();
    expect(h.sidecar.info()).toMatchObject({ status: 'disabled' });
    expect(h.runs()).toEqual([]);
  });

  it('is disabled with setup instructions when python is not installed', async () => {
    for (const [platform, hint] of [['win32', 'setup-voice.ps1'], ['linux', 'setup-voice.sh']]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-voice-none-'));
      const sc = new VoiceSidecar({ getSettings: () => ({ enabled: true }), voiceDir: dir, platform });
      await sc.start();
      const info = sc.info();
      expect(info.status).toBe('disabled');
      expect(info.detail).toContain(hint);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts the server, waits for ready + /health and exposes url/token', async () => {
    const h = harness();
    await h.sidecar.start();
    const info = h.sidecar.info();
    expect(info.status).toBe('ready');
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(info.token).toMatch(/^[0-9a-f]{48}$/);
    expect(info.health).toMatchObject({ ok: true, stt: { model: 'large-v3-turbo', device: 'cuda' } });
    expect(info.detail).toMatch(/GPU: NVIDIA GeForce RTX 5070 Laptop GPU/);
    expect(h.statuses.map((x) => x.status)).toEqual(['starting', 'starting', 'ready']); // 2nd: server's own status line

    const [run] = h.runs();
    expect(run.argv).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', info.url.split(':').pop(), '--device', 'cuda', '--stt-model', 'large-v3-turbo', '--stt-language', 'en', '--tts-voice', 'af_heart']));
    // models load right after 'ready', not inside the user's first /stt (F3 / WIN-3)
    expect(run.argv.filter((a) => a === '--preload')).toHaveLength(1);
    expect(run.argv).not.toContain('--token'); // token travels in the environment
    expect(run.env).toEqual({ LAWNMOWER_VOICE_TOKEN: 'set', PYTHONUNBUFFERED: '1' });
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(h.dir));

    // The token authorises API calls; without it they are refused.
    const ok = await fetch(`${info.url}/voices`, { headers: { Authorization: `Bearer ${info.token}` } });
    expect(ok.status).toBe(200);
    const denied = await fetch(`${info.url}/voices`);
    expect(denied.status).toBe(401);
  });

  it('restarts after a crash with backoff and becomes ready again', async () => {
    const h = harness({ fakeArgs: ['--fake-crash-after', '150'] });
    await h.sidecar.start();
    const firstUrl = h.sidecar.info().url;
    await h.waitFor((x) => x.status === 'error' && /Restarting in/.test(x.detail || ''));
    await h.waitFor((x) => x.status === 'ready' && x.url !== firstUrl);
    expect(h.runs().length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after max attempts and surfaces stderr', async () => {
    const h = harness({ fakeArgs: ['--fake-exit', '3'] });
    await h.sidecar.start();
    const final = await h.waitFor((x) => x.status === 'error' && /Gave up/.test(x.detail || ''));
    expect(final.detail).toMatch(/code 3/);
    expect(final.detail).toMatch(/CUDA error/);
    expect(h.runs()).toHaveLength(3); // first try + 2 restarts
    // A manual restart resets the counter and tries again.
    h.sidecar.restart();
    await h.waitFor((x) => x.status === 'starting' && h.runs().length === 4);
  });

  it('kills a server that never reports ready', async () => {
    const h = harness({ fakeArgs: ['--fake-no-ready'], opts: { readyTimeoutMs: 300, restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 1 } } });
    await h.sidecar.start();
    const final = await h.waitFor((x) => x.status === 'error' && /Gave up/.test(x.detail || ''));
    expect(final.detail).toMatch(/no ready signal/);
  });

  it('restarts only for process-relevant settings and stops cleanly', async () => {
    const h = harness();
    await h.sidecar.start();
    // The voice is sent with every /tts request: picking another one must not kill the server
    // and its loaded models (F5).
    h.s.ttsVoice = 'bf_emma';
    await h.sidecar.applySettings();
    h.s.ttsSpeed = 1.3;
    h.s.sttLanguage = 'en-GB'; // still English: per request only
    await h.sidecar.applySettings();
    expect(h.runs()).toHaveLength(1);
    // English → German changes the server's CPU-fallback model (base.en → base): restart (F8)
    h.s.sttLanguage = 'de';
    await h.sidecar.applySettings();
    await h.waitFor((x) => x.status === 'ready' && h.runs().length === 2);
    expect(h.runs()[1].argv).toEqual(expect.arrayContaining(['--stt-language', 'de', '--tts-voice', 'bf_emma']));
    h.s.sttLanguage = 'fr'; // another non-English language: per request only
    await h.sidecar.applySettings();
    expect(h.runs()).toHaveLength(2);
    h.s.device = 'cpu';
    await h.sidecar.applySettings();
    await h.waitFor((x) => x.status === 'ready' && h.runs().length === 3);
    expect(h.runs()[2].argv).toEqual(expect.arrayContaining(['--device', 'cpu']));
    const url = h.sidecar.info().url;
    await h.sidecar.stop();
    expect(h.sidecar.info().status).toBe('stopped');
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it('takes extra args from LAWNMOWER_VOICE_ARGS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-voice-env-'));
    const logFile = path.join(dir, 'l.jsonl');
    const sc = new VoiceSidecar({
      getSettings: () => ({ enabled: true }),
      voiceDir: dir,
      command: { file: FAKE },
      env: { ...process.env, LAWNMOWER_VOICE_ARGS: `--fake-log-file "${logFile}" --fake` },
      healthIntervalMs: 0,
    });
    live.push({ dir, sidecar: sc });
    await sc.start();
    expect(sc.info().status).toBe('ready');
    const run = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(run.argv).toContain('--fake');
  });
});

describe('packaged layout, language, environment, loading', () => {
  it('packaged builds keep the venv in a per-user folder, not in the (wiped) install directory (WIN-1)', () => {
    expect(packagedVoiceHome({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, homedir: 'C:\\Users\\Ada' }))
      .toBe('C:\\Users\\Ada\\AppData\\Local\\LawnmowerMan\\voice');
    expect(packagedVoiceHome({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Ada' })).toBe('C:\\Users\\Ada\\AppData\\Local\\LawnmowerMan\\voice');
    expect(packagedVoiceHome({ platform: 'linux', env: {}, homedir: '/home/ada' })).toBe('/home/ada/.local/share/lawnmower-man/voice');
    expect(packagedVoiceHome({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homedir: '/home/ada' })).toBe('/data/lawnmower-man/voice');
    const res = 'C:\\Program Files\\Lawnmower Man\\resources\\voice';
    expect(voiceVenvDirs({ packaged: true, voiceDir: res, platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }))
      .toEqual(['C:\\L\\LawnmowerMan\\voice\\.venv', `${res}\\.venv`]);
    expect(voiceVenvDirs({ packaged: false, voiceDir: '/repo/voice', platform: 'linux' })).toEqual(['/repo/voice/.venv']);
  });

  it('maps settings.voice.sttLanguage to --stt-language', () => {
    expect(sttLanguageArg('en')).toBe('en');
    expect(sttLanguageArg('DE')).toBe('de');
    expect(sttLanguageArg('')).toBe('auto');
    expect(sttLanguageArg('auto')).toBe('auto');
    expect(sttLanguageArg('pt-BR')).toBe('pt-br');
    expect(sttLanguageArg('--evil')).toBe('en');
    expect(sttLanguageArg(undefined)).toBe('en');
  });

  it('sets KMP_DUPLICATE_LIB_OK for the server on Windows only (WIN-4)', () => {
    expect(voiceServerEnv({ platform: 'win32', env: {}, token: 't' })).toMatchObject({ KMP_DUPLICATE_LIB_OK: 'TRUE', LAWNMOWER_VOICE_TOKEN: 't', PYTHONUTF8: '1' });
    expect(voiceServerEnv({ platform: 'win32', env: { KMP_DUPLICATE_LIB_OK: 'FALSE' }, token: 't' }).KMP_DUPLICATE_LIB_OK).toBeUndefined();
    expect(voiceServerEnv({ platform: 'linux', env: {}, token: 't' }).KMP_DUPLICATE_LIB_OK).toBeUndefined();
  });

  it('healthSettling: loading engines, or not-yet-loaded ones after --preload', () => {
    expect(healthSettling({ stt: { loaded: false, loading: true }, tts: { loaded: true } }, false)).toBe(true);
    expect(healthSettling({ stt: { loaded: false }, tts: { loaded: true } }, true)).toBe(true);
    expect(healthSettling({ stt: { loaded: false }, tts: { loaded: true } }, false)).toBe(false);
    expect(healthSettling({ stt: { loaded: false, error: 'x' }, tts: { loaded: true } }, true)).toBe(false);
    expect(healthSettling(null, true)).toBe(false);
    expect(describeHealth({ device: { cuda: false }, stt: { loading: true }, tts: { loaded: true } })).toBe('CPU mode · speech recognition loading… · voice loaded');
  });

  it('polls /health quickly while the models load, then reports them loaded', async () => {
    const h = harness({ fakeArgs: ['--fake-loading-ms', '400'], opts: { healthIntervalMs: 60000, loadingPollMs: 80 } });
    await h.sidecar.start();
    expect(h.sidecar.info().health.stt).toMatchObject({ loading: true });
    const loaded = await h.waitFor((x) => x.status === 'ready' && x.health?.stt?.loaded === true, 4000);
    expect(loaded.health.tts.loaded).toBe(true);
    expect(loaded.detail).toMatch(/speech recognition loaded/);
  });
});
