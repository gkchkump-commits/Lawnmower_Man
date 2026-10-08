// VoiceSidecar: starts and supervises the local Python voice server (contract §6).
//
//  python -m lawnmower_voice --host 127.0.0.1 --port P --device D --stt-model M
//         --stt-language L --tts-voice V --preload
//  (cwd = voice/, env PYTHONUNBUFFERED=1, LAWNMOWER_VOICE_TOKEN=<random token>)
//
// The bearer token travels in the environment rather than on the command line, so other
// users on the machine cannot read it from the process list (the contract allows both).
// Lifecycle: locate python → free port → spawn → wait for the stdout line
// {"event":"ready","port":P} → poll GET /health → status 'ready' (url + token for the renderer).
// --preload makes the server load both engines right after 'ready' (the first Whisper GPU run
// on RTX 50-series JIT-compiles kernels, which must not happen inside the user's first /stt);
// /health is polled every couple of seconds until loading settles, so the UI sees it finish.
// Crashes restart with exponential backoff (bounded); stop() kills the process tree.
//
// Not restarted:
//  * a half-installed venv: the server exits with EXIT_NOT_INSTALLED (2) after reporting the
//    missing packages (stdout {"event":"not-installed","missing":[…]}, and on stderr). Restarting
//    cannot help, so the status becomes 'disabled' ("not fully installed") until something
//    changes: a process-relevant setting, restart() ("Restart voice"), or a setup run that ends;
//  * while held (hold('setup')): a setup run is installing into the venv, which a running server
//    would lock (Windows). Nothing starts the server — not start(), restart(), a settings change
//    or the crash backoff — until release('setup'), which then starts it afresh.
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

/** Exit code of `python -m lawnmower_voice` when its Python packages are missing (voice/lawnmower_voice/__main__.py). */
export const EXIT_NOT_INSTALLED = 2;

/** Status detail while a setup run holds the server. */
export const HELD_DETAIL = 'The local voice setup is running; the voice server starts again when it has finished.';

/**
 * Which packages a server that exited with EXIT_NOT_INSTALLED reported missing, or null when the
 * exit was something else (argparse also exits with 2, so the code alone is not enough).
 * @param {number|null} code
 * @param {string[]|null|undefined} reported  from the {"event":"not-installed"} line
 * @param {string} stderr                      the end of the server's stderr
 * @returns {string[]|null}
 */
export function notInstalledPackages(code, reported, stderr) {
  if (code !== EXIT_NOT_INSTALLED) return null;
  const clean = (/** @type {unknown[]} */ xs) => [...new Set(xs.map((x) => String(x).trim()).filter((x) => /^[A-Za-z0-9_.-]{1,64}$/.test(x)))].slice(0, 8);
  if (Array.isArray(reported) && reported.length) {
    const r = clean(reported);
    if (r.length) return r;
  }
  const text = String(stderr || '');
  // "Local voice is not fully installed (missing: uvicorn, fastapi)" (this version of the server)
  const m = /not fully installed \(missing: ([^)]*)\)/.exec(text);
  if (m) {
    const r = clean(m[1].split(','));
    if (r.length) return r;
  }
  // "uvicorn is not installed (No module named 'uvicorn')" (the server of the 0.1.0 release). Only
  // that message: the engines log "kokoro-onnx is not installed (No module named …)" while the
  // server keeps running, which says nothing about a later exit.
  const old = /\buvicorn is not installed \(No module named '([A-Za-z0-9_.-]+)'\)/.exec(text);
  return old ? clean([old[1].split('.')[0]]) : null;
}

/** "…the setup script" + ". Restarting…" without doubling a final full stop. @param {string} s */
export function sentence(s) {
  const t = String(s).trimEnd();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

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
 * @property {boolean} [installed]  is there a voice venv (Python) to start? (unknown until checked)
 * @property {string[]} [missing]   the venv lacks these Python packages (a setup that failed halfway)
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
 * Per-user folder for the voice venv (and, through the setup script's pointer file, the models)
 * of a PACKAGED app. The install directory is wiped by every update/uninstall (NSIS) or is a
 * read-only/temporary mount (AppImage, portable), so nothing large may live there.
 *   win32  %LOCALAPPDATA%\LawnmowerMan\voice
 *   darwin ~/Library/Application Support/LawnmowerMan/voice
 *   other  ${XDG_DATA_HOME:-~/.local/share}/lawnmower-man/voice
 * Must match scripts/setup-voice.ps1 / setup-voice.sh.
 * @param {{ platform?: string, env?: Record<string, string|undefined>, homedir?: string }} [o]
 */
export function packagedVoiceHome(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const home = o.homedir || os.homedir();
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'LawnmowerMan', 'voice');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'LawnmowerMan', 'voice');
  const base = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
  return path.posix.join(base, 'lawnmower-man', 'voice');
}

/**
 * Where to look for the voice venv. Packaged: the per-user voice home first (setup-voice.* puts
 * it there), then a legacy venv inside the resources folder. Unpackaged (git clone): voice/.venv.
 * @param {{ packaged: boolean, voiceDir: string, platform?: string, env?: Record<string, string|undefined>, homedir?: string }} o
 */
export function voiceVenvDirs(o) {
  const P = (o.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const local = P.join(o.voiceDir, '.venv');
  return o.packaged ? [P.join(packagedVoiceHome(o), '.venv'), local] : [local];
}

/**
 * The value for --stt-language: the user's language, 'auto' for detection ('' means detect too).
 * @param {unknown} lang
 */
export function sttLanguageArg(lang) {
  const s = typeof lang === 'string' ? lang.trim().toLowerCase() : 'en';
  if (!s || s === 'auto' || s === 'detect') return 'auto';
  return /^[a-z]{2,3}([-_][a-z0-9]{2,8})?$/.test(s) ? s : 'en';
}

/**
 * Coarse language class for the restart key: the server picks its CPU-fallback Whisper model
 * from the language (English-only `base.en` vs multilingual `base`), so only switching between
 * English and another language needs a restart; everything else is sent per request.
 * @param {string} langArg  result of sttLanguageArg()
 */
function languageClass(langArg) {
  return langArg === 'en' || langArg.startsWith('en-') || langArg.startsWith('en_') ? 'en' : 'multi';
}

/**
 * Environment additions for the server process.
 * @param {{ platform: string, env: Record<string, string|undefined>, token: string }} o
 * @returns {Record<string, string>}
 */
export function voiceServerEnv(o) {
  /** @type {Record<string, string>} */
  const extra = {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LAWNMOWER_VOICE_TOKEN: o.token,
  };
  // Windows: CTranslate2 and torch each ship their own Intel OpenMP (libiomp5md.dll); a second
  // copy initialising in the same process aborts it ("OMP: Error #15") unless this is set. The
  // server sets it as well; setting it here also covers anything imported before that.
  if (o.platform === 'win32' && !o.env.KMP_DUPLICATE_LIB_OK) extra.KMP_DUPLICATE_LIB_OK = 'TRUE';
  return extra;
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
 * @property {number} [loadingPollMs]          /health interval while an engine is loading (default 2000)
 * @property {boolean} [preload]               pass --preload (default true)
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
    this._loadingPollMs = opts.loadingPollMs ?? 2000;
    this._preload = opts.preload !== false;
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
    /** @type {boolean|undefined} */
    this._installed = undefined;
    this._spawnKey = '';
    /** @type {Promise<void>|null} */
    this._op = null;
    /** @type {Set<string>} reasons the server must not run (a setup run installing into the venv) */
    this._holds = new Set();
  }

  /** stop() was called (app quit) and no start since. */
  get stopped() {
    return this._stopped;
  }

  /** A hold() is in effect: nothing starts the server. */
  get held() {
    return this._holds.size > 0;
  }

  /**
   * Stop the server and keep it stopped — no start(), restart(), settings change or crash backoff
   * starts it — until release(reason). For a setup run: the running server locks venv files.
   * Resolves once the process is gone.
   * @param {string} [reason]
   */
  hold(reason = 'setup') {
    this._holds.add(reason);
    const killing = this._stopProc();
    return this._serialize(async () => {
      await killing;
      await this._stopProc();
      if (this.held) this._set({ status: 'stopped', detail: HELD_DETAIL });
    });
  }

  /**
   * End a hold(). When it was the last one (and the app is not quitting), the server is started
   * afresh — with the crash counter reset — so a new install is picked up at once.
   * @param {string} [reason]
   * @returns {boolean} whether there was such a hold
   */
  release(reason = 'setup') {
    if (!this._holds.delete(reason)) return false;
    if (!this.held && !this._stopped) this.restart();
    else if (!this.held) this._set({ status: 'stopped' });
    return true;
  }

  /** @returns {VoiceInfo} */
  info() {
    const i = { ...this._info, health: this._info.health ? { ...this._info.health } : undefined };
    if (i.missing) i.missing = [...i.missing];
    return i;
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
    if (this.held) {
      this._log('info', '[voice] restart deferred: a voice setup is running');
      this._set({ status: 'stopped', detail: HELD_DETAIL });
      return Promise.resolve();
    }
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

  /** Restart when a setting that affects the server process changed (not while held: release() starts it). */
  applySettings() {
    const key = this._keyFor(this._safeSettings());
    if (key === this._spawnKey) return Promise.resolve();
    if (this._stopped || this.held) return Promise.resolve();
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
      sttLanguage: sttLanguageArg(s.sttLanguage ?? 'en'),
      ttsVoice: typeof s.ttsVoice === 'string' && s.ttsVoice ? s.ttsVoice : 'af_heart',
      device: s.device === 'cuda' || s.device === 'cpu' ? s.device : 'auto',
    };
  }

  /**
   * Fields that need a new server process. ttsVoice is NOT one: the renderer sends the voice
   * with every /tts request (--tts-voice is only the server's default), so changing it must not
   * drop the loaded models. The language only matters as English vs. other (CPU model choice).
   * @param {ReturnType<VoiceSidecar['_safeSettings']>} s
   */
  _keyFor(s) {
    return JSON.stringify([s.enabled, s.pythonPath, s.sttModel, languageClass(s.sttLanguage), s.device]);
  }

  async _start() {
    if (this._stopped) return;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.held) {
      this._set({ status: 'stopped', detail: HELD_DETAIL });
      return;
    }
    if (this._proc) return; // already running
    const s = this._safeSettings();
    this._spawnKey = this._keyFor(s);
    const script = this._platform === 'win32' ? SETUP_HINT_WIN : SETUP_HINT_POSIX;
    const setupHint = `choose "Set up local voice…" in the tray menu or in Settings › Voice (it runs ${script} for you)`;

    if (!s.enabled) {
      if (!this._command) this._installed = !!locatePython({ pythonPath: s.pythonPath, venvDirs: this._venvDirs, platform: this._platform, env: this._env }).python;
      this._set({ status: 'disabled', detail: 'Local voice is turned off in Settings; using the system voice.' });
      return;
    }

    /** @type {string} */
    let file;
    /** @type {string[]} */
    let args;
    if (this._command) {
      file = this._command.file;
      args = [...(this._command.args || [])];
      this._installed = true;
    } else {
      const loc = locatePython({ pythonPath: s.pythonPath, venvDirs: this._venvDirs, platform: this._platform, env: this._env });
      this._installed = !!loc.python;
      if (!loc.python) {
        const custom = s.pythonPath ? ` The configured Python "${s.pythonPath}" was not found.` : '';
        this._set({
          status: 'disabled',
          detail: `Local voice is not installed.${custom} To install it, ${setupHint}. Using the system voice until then.`,
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
    if (this._stopped || this._proc || this.held) return;
    const token = randomBytes(24).toString('hex');
    args.push(
      '--host', '127.0.0.1', '--port', String(port), '--device', s.device,
      '--stt-model', s.sttModel, '--stt-language', s.sttLanguage, '--tts-voice', s.ttsVoice,
    );
    if (this._preload && !this._extraArgs.includes('--preload')) args.push('--preload');
    if (this._tokenOnCommandLine) args.push('--token', token);
    args.push(...this._extraArgs);

    this._set({ status: 'starting', detail: 'Starting the local voice server…' });
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      ({ child } = spawnPortable(file, args, {
        cwd: this._voiceDir,
        env: cleanChildEnv(this._env, voiceServerEnv({ platform: this._platform, env: this._env, token })),
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
      /** @type {string[]|null} packages the server reported missing ({"event":"not-installed"}) */
      notInstalled: null,
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
    } else if (m.event === 'not-installed') {
      proc.notInstalled = Array.isArray(m.missing) ? m.missing.slice(0, 16) : [];
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

  /**
   * Periodic /health: every `healthIntervalMs`, or every `loadingPollMs` while the engines are
   * still loading (so the renderer learns quickly when speech recognition becomes usable).
   * A server that stops answering is killed (→ restart) — but only after a generous silence,
   * since a model load can keep it busy for a while (first RTX 50-series run: kernel JIT).
   * @param {any} proc @param {string} url
   */
  _startHealthTimer(proc, url) {
    this._stopHealthTimer();
    let misses = 0;
    let lastOk = Date.now();
    const schedule = () => {
      const settling = this._loadingPollMs > 0 && healthSettling(this._info.health, this._preload);
      const ms = settling ? this._loadingPollMs : this._healthIntervalMs;
      if (!ms) return;
      this._healthTimer = setTimeout(tick, ms);
      this._healthTimer.unref?.();
    };
    const tick = async () => {
      this._healthTimer = null;
      if (proc !== this._proc || proc.exited) return;
      const settling = healthSettling(this._info.health, this._preload);
      try {
        const health = await this._getHealth(url);
        if (proc !== this._proc || proc.exited) return;
        misses = 0;
        lastOk = Date.now();
        const prev = this._info.health;
        const changed = !prev || prev.ok !== health.ok || JSON.stringify(prev.stt) !== JSON.stringify(health.stt) || JSON.stringify(prev.tts) !== JSON.stringify(health.tts);
        this._info = { ...this._info, health, detail: describeHealth(health) };
        if (changed || this._info.status !== 'ready') this._set({ ...this._info, status: 'ready' });
      } catch (err) {
        if (proc !== this._proc || proc.exited) return;
        misses++;
        this._log('warn', `[voice] health check failed (${misses}): ${/** @type {Error} */ (err).message}`);
        const graceMs = settling ? 300000 : Math.max(3 * this._healthIntervalMs, 90000);
        if (misses >= 3 && Date.now() - lastOk >= graceMs) {
          proc.stderr.push('(stopped answering /health)\n');
          killProcessTree(proc.child, { platform: this._platform });
          return;
        }
      }
      schedule();
    };
    schedule();
  }

  _stopHealthTimer() {
    if (this._healthTimer) clearTimeout(this._healthTimer);
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
    const base = `Voice server exited (${how})${tail ? `: ${tail}` : ''}`;
    this._log('warn', `[voice] ${base}`);

    // The venv's Python runs, but the packages are not (all) there: a setup that failed halfway.
    // Restarting cannot fix that — wait for a new setup run, "Restart voice" or a settings change.
    const missing = notInstalledPackages(code, proc.notInstalled, proc.stderr.tail(40));
    if (missing) {
      this._failures = 0;
      this._set({
        status: 'disabled',
        missing,
        detail: `Local voice is not fully installed (missing: ${missing.join(', ')}). Choose "Set up local voice again…" in the tray menu or in Settings › Voice.`,
      });
      return;
    }

    if (proc.readyAt && Date.now() - proc.readyAt > this._restartCfg.stableMs) this._failures = 0;
    this._failures++;
    if (this._failures > this._restartCfg.maxAttempts) {
      this._set({ status: 'error', detail: `${sentence(base)} Gave up after ${this._restartCfg.maxAttempts} restarts; use "Restart voice" in the tray menu to try again.` });
      return;
    }
    const delay = backoffDelay(this._failures, this._restartCfg.baseDelayMs, this._restartCfg.maxDelayMs);
    this._set({ status: 'error', detail: `${sentence(base)} Restarting in ${Math.ceil(delay / 1000)}s (attempt ${this._failures}/${this._restartCfg.maxAttempts}).` });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._stopped && !this.held) this._serialize(() => this._start());
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
    if (typeof this._installed === 'boolean') next.installed = this._installed;
    if (info.missing && info.missing.length) next.missing = [...info.missing];
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
 * Are the engines still on their way to being usable? True while either reports `loading`, or,
 * when the server was started with --preload, while either is neither loaded nor failed.
 * @param {Record<string, any>|undefined|null} h  /health payload
 * @param {boolean} preload
 */
export function healthSettling(h, preload) {
  if (!h || typeof h !== 'object') return false;
  return ['stt', 'tts'].some((k) => {
    const e = h[k];
    if (!e || typeof e !== 'object') return false;
    if (e.loading) return true;
    return preload && !e.loaded && !e.error;
  });
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
    if (x.loading) return `${label} loading…`;
    return `${label} ${x.loaded ? 'loaded' : 'not loaded yet'}`;
  };
  return [where, part(h.stt, 'speech recognition'), part(h.tts, 'voice')].filter(Boolean).join(' · ');
}
