// VoiceSidecar: starts and supervises the local Python voice server (contract §6).
//
//  python -m lawnmower_voice --host 127.0.0.1 --port P --device D --stt-model M --tts-voice V
//  (cwd = voice/, env PYTHONUNBUFFERED=1, LAWNMOWER_VOICE_TOKEN=<random token>)
//
// The bearer token travels in the environment rather than on the command line, so other
// users on the machine cannot read it from the process list (the contract allows both).
// Lifecycle: locate python → free port → spawn → wait for the stdout line
// {"event":"ready","port":P} → poll GET /health → status 'ready' (url + token for the renderer).
// Crashes restart with exponential backoff (bounded); stop() kills the process tree.
//
// Status values (window.lawnmower.voice.info): 'disabled'|'starting'|'ready'|'error'|'stopped'.
// Events: 'status' (info).

/* global AbortSignal */
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonLineParser } from './stream-json.js';
import { spawnPortable, cleanChildEnv, killProcessTree, waitForExit, TextRingBuffer, backoffDelay } from './spawn-util.js';
import { expandUserPath } from './claude-path.js';

export const SETUP_HINT_WIN = 'scripts\\setup-voice.ps1';
export const SETUP_HINT_POSIX = 'scripts/setup-voice.sh';

/**
 * @typedef {object} VoiceSettings  settings.voice (contract §4)
 * @property {boolean} enabled
 * @property {string} pythonPath
 * @property {string} sttModel
 * @property {string} sttLanguage
 * @property {string} ttsVoice
 * @property {number} ttsSpeed
 * @property {'auto'|'cuda'|'cpu'} device
 */

/**
 * @typedef {object} VoiceInfo
 * @property {'disabled'|'starting'|'ready'|'error'|'stopped'} status
 * @property {string} [url]
 * @property {string} [token]
 * @property {string} [detail]
 * @property {Record<string, any>} [health]
 */

/**
 * Find the Python interpreter for the voice server.
 * @param {{ pythonPath?: string, venvDirs: string[], platform?: string, env?: Record<string,string|undefined>, homedir?: string, fs?: Pick<typeof nodeFs, 'statSync'> }} o
 * @returns {{ python: string|null, tried: string[], fromSettings: boolean }}
 */
export function locatePython(o) {
  const platform = o.platform || process.platform;
  const fs = o.fs || nodeFs;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const tried = [];
  const isFile = (/** @type {string} */ p) => {
    try {
      return /** @type {any} */ (fs).statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (o.pythonPath && o.pythonPath.trim()) {
    const p = expandUserPath(o.pythonPath, { env: o.env || process.env, platform, homedir: o.homedir || os.homedir() });
    tried.push(p);
    if (isFile(p)) return { python: p, tried, fromSettings: true };
  }
  for (const venv of o.venvDirs || []) {
    const candidates = platform === 'win32'
      ? [P.join(venv, 'Scripts', 'python.exe')]
      : [P.join(venv, 'bin', 'python'), P.join(venv, 'bin', 'python3')];
    for (const c of candidates) {
      tried.push(c);
      if (isFile(c)) return { python: c, tried, fromSettings: false };
    }
  }
  return { python: null, tried, fromSettings: false };
}

/**
 * Ask the OS for a free TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/**
 * Parse an extra-args string such as `--fake --log-level debug` (space separated, quotes allowed).
 * @param {string|undefined} s
 */
export function parseArgString(s) {
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * @typedef {object} VoiceSidecarOptions
 * @property {() => VoiceSettings} getSettings
 * @property {string} voiceDir                 folder containing the lawnmower_voice package
 * @property {string[]} [venvDirs]             default [<voiceDir>/.venv]
 * @property {{ file: string, args?: string[] }} [command]  replaces `python -m lawnmower_voice` (tests)
 * @property {string[]} [extraArgs]            appended to the server args (also env LAWNMOWER_VOICE_ARGS)
 * @property {boolean} [tokenOnCommandLine]    also pass --token (default false; env is used)
 * @property {string} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [readyTimeoutMs]         default 180000 (first CUDA import can be slow)
 * @property {number} [healthIntervalMs]       default 30000
 * @property {{ baseDelayMs?: number, maxDelayMs?: number, maxAttempts?: number, stableMs?: number }} [restart]
 * @property {typeof fetch} [fetchImpl]
 * @property {(level: 'debug'|'info'|'warn'|'error', msg: string) => void} [log]
 */

export class VoiceSidecar extends EventEmitter {
  /** @param {VoiceSidecarOptions} opts */
  constructor(opts) {
    super();
    if (!opts || typeof opts.getSettings !== 'function') throw new TypeError('getSettings is required');
    if (!opts.voiceDir) throw new TypeError('voiceDir is required');
    this._getSettings = opts.getSettings;
    this._voiceDir = opts.voiceDir;
    this._venvDirs = opts.venvDirs || [path.join(opts.voiceDir, '.venv')];
    this._command = opts.command || null;
    this._env = opts.env || process.env;
    this._extraArgs = [...(opts.extraArgs || []), ...parseArgString(this._env.LAWNMOWER_VOICE_ARGS)];
    this._tokenOnCommandLine = !!opts.tokenOnCommandLine;
    this._platform = opts.platform || process.platform;
    this._readyTimeoutMs = opts.readyTimeoutMs ?? 180000;
    this._healthIntervalMs = opts.healthIntervalMs ?? 30000;
    this._restartCfg = {
      baseDelayMs: opts.restart?.baseDelayMs ?? 2000,
      maxDelayMs: opts.restart?.maxDelayMs ?? 30000,
      maxAttempts: opts.restart?.maxAttempts ?? 5,
      stableMs: opts.restart?.stableMs ?? 120000,
    };
    this._fetch = opts.fetchImpl || globalThis.fetch;
    this._log = opts.log || (() => {});
    /** @type {VoiceInfo} */
    this._info = { status: 'stopped' };
    /** @type {any} */
    this._proc = null;
    this._failures = 0;
    /** @type {NodeJS.Timeout|null} */
    this._restartTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._healthTimer = null;
    this._stopped = true;
    this._spawnKey = '';
    /** @type {Promise<void>|null} */
    this._op = null;
  }

  /** @returns {VoiceInfo} */
  info() {
    return { ...this._info, health: this._info.health ? { ...this._info.health } : undefined };
  }

  /** Start (or report disabled). Resolves once ready, disabled, or failed. */
  start() {
    this._stopped = false;
    return this._serialize(() => this._start());
  }

  /** Stop then start, resetting the crash counter (tray "Restart voice", renderer). */
  restart() {
    this._stopped = false;
    this._failures = 0;
    // Kill right away (a start still waiting for "ready" then finishes), then start afresh.
    const killing = this._stopProc();
    return this._serialize(async () => {
      await killing;
      await this._stopProc();
      await this._start();
    });
  }

  /** Stop the server (app quit). Does not wait behind a slow startup. */
  stop() {
    this._stopped = true;
    const killing = this._stopProc();
    return this._serialize(async () => {
      await killing;
      await this._stopProc();
      this._set({ status: 'stopped' });
    });
  }

  /** Restart when a setting that affects the server process changed. */
  applySettings() {
    const key = this._keyFor(this._safeSettings());
    if (key === this._spawnKey) return Promise.resolve();
    if (this._stopped) return Promise.resolve();
    return this.restart();
  }

  // -------------------------------------------------------------------------------------------

  /** Run lifecycle operations one at a time. @param {() => Promise<void>} fn */
  _serialize(fn) {
    const prev = this._op || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._op = next.finally(() => {
      if (this._op === next) this._op = null;
    });
    return next.catch((err) => {
      this._log('error', `[voice] ${err && err.stack ? err.stack : err}`);
    });
  }

  _safeSettings() {
    /** @type {any} */
    let s = {};
    try {
      s = this._getSettings() || {};
    } catch {
      s = {};
    }
    return {
      enabled: s.enabled !== false,
      pythonPath: typeof s.pythonPath === 'string' ? s.pythonPath : '',
      sttModel: typeof s.sttModel === 'string' && s.sttModel ? s.sttModel : 'large-v3-turbo',
      ttsVoice: typeof s.ttsVoice === 'string' && s.ttsVoice ? s.ttsVoice : 'af_heart',
      device: s.device === 'cuda' || s.device === 'cpu' ? s.device : 'auto',
    };
  }

  /** @param {ReturnType<VoiceSidecar['_safeSettings']>} s */
  _keyFor(s) {
    return JSON.stringify([s.enabled, s.pythonPath, s.sttModel, s.ttsVoice, s.device]);
  }

  async _start() {
    if (this._stopped) return;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._proc) return; // already running
    const s = this._safeSettings();
    this._spawnKey = this._keyFor(s);
    const setupHint = this._platform === 'win32'
      ? `run ${SETUP_HINT_WIN} in PowerShell`
      : `run ${SETUP_HINT_POSIX}`;

    if (!s.enabled) {
      this._set({ status: 'disabled', detail: 'Local voice is turned off in Settings; using the browser voice.' });
      return;
    }

    /** @type {string} */
    let file;
    /** @type {string[]} */
    let args;
    if (this._command) {
      file = this._command.file;
      args = [...(this._command.args || [])];
    } else {
      const loc = locatePython({ pythonPath: s.pythonPath, venvDirs: this._venvDirs, platform: this._platform, env: this._env });
      if (!loc.python) {
        const custom = s.pythonPath ? ` The configured Python "${s.pythonPath}" was not found.` : '';
        this._set({
          status: 'disabled',
          detail: `Local GPU voice is not installed.${custom} To enable it, ${setupHint} once and restart voice from the tray menu. Using the browser voice until then.`,
        });
        return;
      }
      if (!nodeFs.existsSync(path.join(this._voiceDir, 'lawnmower_voice'))) {
        this._set({ status: 'disabled', detail: `Voice server files are missing (${path.join(this._voiceDir, 'lawnmower_voice')}).` });
        return;
      }
      file = loc.python;
      args = ['-m', 'lawnmower_voice'];
    }

    const port = await findFreePort();
    if (this._stopped || this._proc) return;
    const token = randomBytes(24).toString('hex');
    args.push('--host', '127.0.0.1', '--port', String(port), '--device', s.device, '--stt-model', s.sttModel, '--tts-voice', s.ttsVoice);
    if (this._tokenOnCommandLine) args.push('--token', token);
    args.push(...this._extraArgs);

    this._set({ status: 'starting', detail: 'Starting the local voice server…' });
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      ({ child } = spawnPortable(file, args, {
        cwd: this._voiceDir,
        env: cleanChildEnv(this._env, {
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          LAWNMOWER_VOICE_TOKEN: token,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        platform: this._platform,
        windowsHide: true,
      }));
    } catch (err) {
      this._set({ status: 'error', detail: `Could not start the voice server: ${/** @type {Error} */ (err).message}` });
      return;
    }
    this._log('info', `[voice] spawned pid ${child.pid} on port ${port}`);

    const proc = {
      child,
      port,
      token,
      ready: false,
      readyAt: 0,
      exited: false,
      expected: false,
      stderr: new TextRingBuffer(16 * 1024),
      /** @type {NodeJS.Timeout|null} */
      readyTimer: null,
      /** @type {() => void} */
      settle: () => {},
    };
    this._proc = proc;
    const settled = new Promise((resolve) => { proc.settle = () => resolve(undefined); });

    const parser = new JsonLineParser({
      onMessage: (m) => this._onStdoutMessage(proc, m),
      onError: (_err, line) => { if (line) this._log('debug', `[voice] ${line.slice(0, 300)}`); },
    });
    child.stdout?.on('data', (c) => parser.push(c));
    child.stderr?.on('data', (c) => {
      proc.stderr.push(c);
      const t = String(c).trim();
      if (t) this._log('debug', `[voice:stderr] ${t.slice(0, 500)}`);
    });
    child.once('error', (err) => {
      proc.stderr.push(`${err.message}\n`);
      if (child.pid === undefined) this._onExit(proc, null, null);
    });
    child.once('close', (code, signal) => {
      parser.end();
      this._onExit(proc, code, signal);
    });

    proc.readyTimer = setTimeout(() => {
      if (proc.ready || proc.exited) return;
      this._log('warn', `[voice] no ready line within ${this._readyTimeoutMs} ms`);
      proc.stderr.push(`(no ready signal within ${Math.round(this._readyTimeoutMs / 1000)}s)\n`);
      killProcessTree(child, { platform: this._platform }); // → _onExit (unexpected) → backoff
    }, this._readyTimeoutMs);

    await settled; // ready, or exited
  }

  /** @param {any} proc @param {Record<string, any>} m */
  _onStdoutMessage(proc, m) {
    if (proc !== this._proc) return;
    if (m.event === 'ready') {
      if (Number.isInteger(m.port) && m.port > 0 && m.port < 65536) proc.port = m.port;
      this._afterReadyLine(proc).catch((err) => this._log('warn', `[voice] ${err.message}`));
    } else if (m.event === 'status' && typeof m.detail === 'string' && !proc.ready) {
      this._set({ status: 'starting', detail: m.detail.slice(0, 300) });
    }
  }

  /** Poll /health until it answers, then report ready. @param {any} proc */
  async _afterReadyLine(proc) {
    const url = `http://127.0.0.1:${proc.port}`;
    let health = null;
    let lastErr = '';
    for (let i = 0; i < 20 && !proc.exited && proc === this._proc; i++) {
      try {
        health = await this._getHealth(url);
        break;
      } catch (err) {
        lastErr = /** @type {Error} */ (err).message;
        await new Promise((r) => setTimeout(r, 250 + i * 100));
      }
    }
    if (proc.exited || proc !== this._proc) return;
    if (!health) {
      proc.stderr.push(`(health check failed: ${lastErr})\n`);
      killProcessTree(proc.child, { platform: this._platform });
      return;
    }
    proc.ready = true;
    proc.readyAt = Date.now();
    if (proc.readyTimer) clearTimeout(proc.readyTimer);
    this._set({ status: 'ready', url, token: proc.token, detail: describeHealth(health), health });
    proc.settle();
    this._startHealthTimer(proc, url);
  }

  /** @param {string} url */
  async _getHealth(url) {
    const res = await this._fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`/health HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body !== 'object') throw new Error('/health returned no JSON object');
    return body;
  }

  /** @param {any} proc @param {string} url */
  _startHealthTimer(proc, url) {
    this._stopHealthTimer();
    if (!this._healthIntervalMs) return;
    let misses = 0;
    this._healthTimer = setInterval(async () => {
      if (proc !== this._proc || proc.exited) return this._stopHealthTimer();
      try {
        const health = await this._getHealth(url);
        misses = 0;
        const prev = this._info.health;
        const changed = !prev || prev.ok !== health.ok || JSON.stringify(prev.stt) !== JSON.stringify(health.stt) || JSON.stringify(prev.tts) !== JSON.stringify(health.tts);
        this._info = { ...this._info, health, detail: describeHealth(health) };
        if (changed || this._info.status !== 'ready') this._set({ ...this._info, status: 'ready' });
      } catch (err) {
        misses++;
        this._log('warn', `[voice] health check failed (${misses}): ${/** @type {Error} */ (err).message}`);
        if (misses >= 3) {
          proc.stderr.push('(stopped answering /health)\n');
          killProcessTree(proc.child, { platform: this._platform });
        }
      }
    }, this._healthIntervalMs);
    this._healthTimer.unref?.();
  }

  _stopHealthTimer() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = null;
  }

  /** @param {any} proc @param {number|null} code @param {NodeJS.Signals|null} signal */
  _onExit(proc, code, signal) {
    if (proc.exited) return;
    proc.exited = true;
    if (proc.readyTimer) clearTimeout(proc.readyTimer);
    proc.settle();
    if (proc !== this._proc) return;
    this._proc = null;
    this._stopHealthTimer();
    if (proc.expected || this._stopped) return;

    const how = code !== null && code !== undefined ? `code ${code}` : signal ? `signal ${signal}` : 'spawn failure';
    const tail = proc.stderr.tail(6);
    if (proc.readyAt && Date.now() - proc.readyAt > this._restartCfg.stableMs) this._failures = 0;
    this._failures++;
    const base = `Voice server exited (${how})${tail ? `: ${tail}` : ''}`;
    this._log('warn', `[voice] ${base}`);
    if (this._failures > this._restartCfg.maxAttempts) {
      this._set({ status: 'error', detail: `${base}. Gave up after ${this._restartCfg.maxAttempts} restarts; use "Restart voice" in the tray menu to try again.` });
      return;
    }
    const delay = backoffDelay(this._failures, this._restartCfg.baseDelayMs, this._restartCfg.maxDelayMs);
    this._set({ status: 'error', detail: `${base}. Restarting in ${Math.ceil(delay / 1000)}s (attempt ${this._failures}/${this._restartCfg.maxAttempts}).` });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._stopped) this._serialize(() => this._start());
    }, delay);
  }

  async _stopProc() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._stopHealthTimer();
    const proc = this._proc;
    if (!proc) return;
    proc.expected = true;
    this._proc = null;
    if (proc.readyTimer) clearTimeout(proc.readyTimer);
    if (!proc.exited) {
      await killProcessTree(proc.child, { platform: this._platform, graceMs: 2000 });
      await waitForExit(proc.child, 1000);
    }
    proc.settle();
  }

  /** @param {VoiceInfo} info */
  _set(info) {
    /** @type {VoiceInfo} */
    const next = { status: info.status };
    if (info.url) next.url = info.url;
    if (info.token) next.token = info.token;
    if (info.detail) next.detail = info.detail;
    if (info.health) next.health = info.health;
    this._info = next;
    try {
      this.emit('status', this.info());
    } catch (err) {
      this._log('error', `[voice] status listener threw: ${err}`);
    }
  }
}

/**
 * One-line human description of a /health payload.
 * @param {Record<string, any>} h
 */
export function describeHealth(h) {
  if (!h || typeof h !== 'object') return '';
  const d = h.device || {};
  const where = d.cuda ? `GPU: ${d.name || 'CUDA'}${d.vramTotalMB ? ` (${Math.round(d.vramTotalMB / 1024)} GB)` : ''}` : 'CPU mode';
  const part = (/** @type {any} */ x, /** @type {string} */ label) => {
    if (!x || typeof x !== 'object') return '';
    if (x.error) return `${label} error: ${String(x.error).slice(0, 120)}`;
    return `${label} ${x.loaded ? 'loaded' : 'not loaded yet'}`;
  };
  return [where, part(h.stt, 'speech recognition'), part(h.tts, 'voice')].filter(Boolean).join(' · ');
}
