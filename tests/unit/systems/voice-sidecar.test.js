// VoiceSidecar tests with tests/fixtures/fake-voice.mjs standing in for `python -m lawnmower_voice`.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT_NOT_INSTALLED,
  HELD_DETAIL,
  VoiceSidecar,
  describeHealth,
  healthSettling,
  locatePython,
  notInstalledPackages,
  packagedVoiceHome,
  parseArgString,
  sentence,
  sttLanguageArg,
  voiceServerEnv,
  voiceVenvDirs,
} from '../../../electron/voice-sidecar.js';
import { findOnPath } from '../../../electron/claude-path.js';

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

// ------------------------------------------------------------------------------------------
// A half-installed venv (a setup that failed halfway: Python runs, uvicorn is missing) must not be
// restarted over and over; and nothing may start the server while a setup run installs into the
// venv (Windows locks the files a running server uses).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('not fully installed: no restart loop', () => {
  it('notInstalledPackages: exit 2 plus the protocol line or the server message — not any exit 2', () => {
    expect(EXIT_NOT_INSTALLED).toBe(2);
    expect(notInstalledPackages(2, ['uvicorn', 'fastapi', 'uvicorn'], '')).toEqual(['uvicorn', 'fastapi']);
    expect(notInstalledPackages(2, null, 'ERROR lawnmower_voice: Local voice is not fully installed (missing: uvicorn, numpy). Run the setup script again')).toEqual(['uvicorn', 'numpy']);
    expect(notInstalledPackages(2, null, "ERROR lawnmower_voice: uvicorn is not installed (No module named 'uvicorn'). Run the setup script.")).toEqual(['uvicorn']);
    expect(notInstalledPackages(2, null, 'usage: python -m lawnmower_voice [-h]\nerror: unrecognized arguments: --bogus')).toBeNull(); // argparse
    expect(notInstalledPackages(1, ['uvicorn'], 'Local voice is not fully installed (missing: uvicorn)')).toBeNull();
    expect(notInstalledPackages(null, ['uvicorn'], '')).toBeNull();
    expect(notInstalledPackages(2, ['<script>', '../x y'], '')).toBeNull(); // only package-like names
    // 0.1.0 also said "uvicorn is not installed" when a dependency of uvicorn was missing
    expect(notInstalledPackages(2, null, "uvicorn is not installed (No module named 'click'). Run the setup script.")).toEqual(['click']);
    // an engine's own message (the server keeps running after it) does not make an exit 2 "not installed"
    expect(notInstalledPackages(2, null, "WARNING lawnmower_voice: kokoro-onnx is not installed (No module named 'kokoro_onnx'). Run scripts/setup-voice.sh\nFatal: exit 2")).toBeNull();
    expect(notInstalledPackages(2, null, "faster-whisper is not installed (No module named 'faster_whisper')")).toBeNull();
  });

  it('sentence() never doubles the final full stop ("Run the setup script.. Restarting")', () => {
    expect(sentence('Run the setup script.')).toBe('Run the setup script.');
    expect(sentence('Run the setup script')).toBe('Run the setup script.');
    expect(sentence('loading…')).toBe('loading…');
  });

  for (const [name, flag] of [['the protocol line', '--fake-not-installed'], ['the 0.1.0 stderr message only', '--fake-not-installed-legacy']]) {
    it(`exit 2 with ${name}: status 'disabled' with the missing packages, and no restarts`, async () => {
      const h = harness({ fakeArgs: [flag] });
      await h.sidecar.start();
      const info = await h.waitFor((x) => x.status === 'disabled');
      expect(info).toMatchObject({ status: 'disabled', installed: true, missing: ['uvicorn'] });
      expect(info.detail).toBe('Local voice is not fully installed (missing: uvicorn). Choose "Set up local voice again…" in the tray menu or in Settings › Voice.');
      await sleep(250); // the backoff here is 30-60 ms: a restart loop would have run several times
      expect(h.runs()).toHaveLength(1);
      expect(h.statuses.some((x) => x.status === 'error' || /Restarting in/.test(x.detail || ''))).toBe(false);
      expect(h.sidecar.info()).toMatchObject({ status: 'disabled', missing: ['uvicorn'] });
      // "Restart voice" tries again (once), and so does a process-relevant settings change
      await h.sidecar.restart();
      expect(h.runs()).toHaveLength(2);
      h.s.device = 'cpu';
      await h.sidecar.applySettings();
      expect(h.runs()).toHaveLength(3);
      await sleep(150);
      expect(h.runs()).toHaveLength(3);
    });
  }

  for (const [name, fakeArgs] of [
    ['a usage error', ['--fake-exit2-usage']],
    ['an engine that is not installed', ['--fake-exit', '2', '--fake-stderr', "WARNING lawnmower_voice: kokoro-onnx is not installed (No module named 'kokoro_onnx'). Run the setup script."]],
  ]) {
    it(`an exit 2 that is not "not installed" (${name}) still restarts with backoff, without ".."`, async () => {
      const h = harness({ fakeArgs });
      await h.sidecar.start();
      const final = await h.waitFor((x) => x.status === 'error' && /Gave up/.test(x.detail || ''));
      expect(h.runs()).toHaveLength(3);
      expect(final.detail).toMatch(/code 2/);
      expect(final.detail).not.toMatch(/\.\./);
      expect(final.missing).toBeUndefined();
    });
  }

  it('a stderr tail ending in a full stop is not followed by another one', async () => {
    const h = harness({ fakeArgs: ['--fake-exit', '3', '--fake-stderr', 'CUDA failed to initialise. Run the setup script.'] });
    await h.sidecar.start();
    const st = await h.waitFor((x) => x.status === 'error' && /Restarting in/.test(x.detail || ''));
    expect(st.detail).toMatch(/^Voice server exited \(code 3\): CUDA failed to initialise\. Run the setup script\. Restarting in \d+s \(attempt 1\/2\)\.$/);
    const final = await h.waitFor((x) => x.status === 'error' && /Gave up/.test(x.detail || ''));
    expect(final.detail).toMatch(/Run the setup script\. Gave up after 2 restarts/);
  });

  // The real server (voice/lawnmower_voice) in a venv whose uvicorn is missing, found by
  // locatePython like in the app: .venv/bin/python runs the system Python with uvicorn blocked.
  const python3 = process.platform !== 'win32' ? findOnPath('python3').found : null;
  const serverRuns = !!python3 && spawnSync(python3, ['-c', 'import fastapi, numpy'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!serverRuns)('the real server in a half-installed venv: disabled after one run, the message without ".."', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-voice-venv-'));
    const bin = path.join(dir, '.venv', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const block = path.join(dir, 'block');
    fs.mkdirSync(block);
    fs.writeFileSync(path.join(block, 'sitecustomize.py'), [
      'import sys',
      'class _Block:',
      '    def find_spec(self, name, path=None, target=None):',
      '        if name.split(".")[0] == "uvicorn":',
      '            raise ModuleNotFoundError(f"No module named {name!r}", name=name)',
      '        return None',
      'sys.meta_path.insert(0, _Block())',
      '',
    ].join('\n'));
    const count = path.join(dir, 'runs.txt');
    fs.writeFileSync(path.join(bin, 'python'), `#!/bin/sh\necho run >> '${count}'\nPYTHONPATH='${block}' exec '${python3}' "$@"\n`, { mode: 0o755 });
    const statuses = [];
    const sc = new VoiceSidecar({
      getSettings: () => ({ enabled: true, device: 'cpu' }),
      voiceDir: path.resolve('voice'),
      venvDirs: [path.join(dir, '.venv')],
      restart: { baseDelayMs: 30, maxDelayMs: 60, maxAttempts: 3 },
      healthIntervalMs: 0,
    });
    live.push({ dir, sidecar: sc });
    sc.on('status', (x) => statuses.push(x));
    await sc.start();
    for (let i = 0; i < 100 && sc.info().status !== 'disabled'; i++) await sleep(50);
    await sleep(300);
    const info = sc.info();
    expect(info).toMatchObject({ status: 'disabled', installed: true });
    expect(info.missing).toContain('uvicorn');
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(statuses.map((x) => x.detail || '').join('\n')).not.toMatch(/\.\./);
  });
});

describe('hold while a setup run installs into the venv', () => {
  it('hold() stops the server; nothing starts it until release(), which starts it afresh', async () => {
    const h = harness();
    await h.sidecar.start();
    const url = h.sidecar.info().url;
    expect(h.sidecar.held).toBe(false);
    await h.sidecar.hold('setup');
    expect(h.sidecar.held).toBe(true);
    expect(h.sidecar.info()).toMatchObject({ status: 'stopped', detail: HELD_DETAIL });
    await expect(fetch(`${url}/health`)).rejects.toThrow(); // the process (and its venv files) is gone
    expect(h.sidecar.stopped).toBe(false); // not an app quit: release() starts it again

    // "Restart voice", a settings change, start(): all deferred
    await h.sidecar.restart();
    h.s.device = 'cpu';
    await h.sidecar.applySettings();
    await h.sidecar.start();
    await sleep(150);
    expect(h.runs()).toHaveLength(1);
    expect(h.sidecar.info()).toMatchObject({ status: 'stopped', detail: HELD_DETAIL });

    expect(h.sidecar.release('other')).toBe(false); // not held for that
    expect(h.sidecar.held).toBe(true);
    expect(h.sidecar.release('setup')).toBe(true);
    expect(h.sidecar.held).toBe(false);
    await h.waitFor((x) => x.status === 'ready' && h.runs().length === 2);
    expect(h.runs()[1].argv).toEqual(expect.arrayContaining(['--device', 'cpu'])); // the settings changed meanwhile
    expect(h.sidecar.release('setup')).toBe(false);
  });

  it('a crash backoff pending when the hold starts does not start the server', async () => {
    const h = harness({ fakeArgs: ['--fake-exit', '3'], opts: { restart: { baseDelayMs: 120, maxDelayMs: 120, maxAttempts: 5 } } });
    await h.sidecar.start();
    await h.waitFor((x) => x.status === 'error' && /Restarting in/.test(x.detail || ''));
    await h.sidecar.hold('setup');
    await sleep(300);
    expect(h.runs()).toHaveLength(1);
    expect(h.sidecar.info().status).toBe('stopped');
  });

  it('a hold during start-up keeps the starting server from coming up', async () => {
    const h = harness({ fakeArgs: ['--fake-ready-delay', '200'] });
    const starting = h.sidecar.start();
    await h.waitFor((x) => x.status === 'starting');
    await h.sidecar.hold('setup');
    await starting;
    await sleep(300);
    expect(h.sidecar.info().status).toBe('stopped');
    expect(h.statuses.some((x) => x.status === 'ready')).toBe(false);
  });

  it('release() after the app began quitting does not start anything', async () => {
    const h = harness();
    await h.sidecar.start();
    await h.sidecar.hold('setup');
    await h.sidecar.stop(); // app quit
    expect(h.sidecar.release('setup')).toBe(true);
    await sleep(150);
    expect(h.runs()).toHaveLength(1);
    expect(h.sidecar.info().status).toBe('stopped');
  });
});
