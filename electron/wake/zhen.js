// Model A (the zh-en keyword model) on the user's PC (contract-wake §5.3). It has no stated
// licence, so the installer does not carry it: the voice package's downloader fetches it from
// k2-fsa's GitHub release into the user's voice models folder (<models>/kws/zh-en-3m), with pinned
// SHA-256 hashes. New installs get it from the setup script; for existing installs main runs
//   <voice python> -m lawnmower_voice.download --kws-only --check --json      (when wake mode starts)
//   <voice python> -m lawnmower_voice.download --kws-only --json              (once per app run, if absent)
// with cwd = the shipped voice folder (so its package shadows the venv's copy) and the sidecar's
// environment, so the models folder resolves exactly like the voice server's. Until it is there,
// Jade runs on model B alone. Nothing runs while the local voice is off or has no Python.

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import { cleanChildEnv } from '../spawn-util.js';

export const ZHEN_KEY = 'zh-en-3m';
export const CHECK_TIMEOUT_MS = 60000;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** @typedef {'unknown'|'ok'|'missing'|'downloading'|'failed'|'unavailable'} ZhenState */

/**
 * The last JSON object on stdout, or null.
 * @param {string} stdout @returns {any}
 */
export function lastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch { /* not JSON */ }
  }
  return null;
}

/**
 * The downloader's report on model A: `{"kws":{"zh-en-3m":{"dir","present","downloaded","error?"}}}`.
 * @param {any} report
 * @returns {{ dir: string, present: boolean, downloaded: boolean, error?: string, modelsDir?: string }|null}
 */
export function parseKwsReport(report) {
  const k = report?.kws?.[ZHEN_KEY];
  if (!k || typeof k.dir !== 'string' || !k.dir) return null;
  return {
    dir: k.dir,
    present: k.present === true,
    downloaded: k.downloaded === true,
    ...(typeof k.error === 'string' && k.error ? { error: k.error.slice(0, 300) } : {}),
    ...(typeof report.modelsDir === 'string' ? { modelsDir: report.modelsDir } : {}),
  };
}

export class ZhenManager extends EventEmitter {
  /**
   * @param {{ locate: () => ({ python: string|null, cwd: string }|null), voiceEnabled: () => boolean,
   *   env?: Record<string, string|undefined>, spawn?: typeof nodeSpawn, log?: (level: string, msg: string) => void,
   *   checkTimeoutMs?: number, downloadTimeoutMs?: number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} o
   */
  constructor(o) {
    super();
    this._o = o;
    this._spawn = o.spawn || nodeSpawn;
    this._log = o.log || (() => {});
    this._set = o.setTimeout || setTimeout;
    this._clear = o.clearTimeout || clearTimeout;
    /** @type {ZhenState} */
    this.state = 'unknown';
    /** model A's folder when complete @type {string|null} */
    this.dir = null;
    /** the voice models folder the downloader reported @type {string|null} */
    this.modelsDir = null;
    this.detail = '';
    this.autoTried = false;
    /** @type {Promise<any>|null} */
    this._running = null;
    /** @type {any} */
    this._child = null;
  }

  /** @param {ZhenState} state @param {string} [detail] */
  _setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('change', state);
  }

  /** Python and the voice are there? @returns {{ python: string, cwd: string }|null} */
  _target() {
    if (!this._o.voiceEnabled()) {
      this._setState('unavailable', 'The local voice is off.');
      return null;
    }
    const t = this._o.locate();
    if (!t || !t.python) {
      this._setState('unavailable', 'The local voice is not installed.');
      return null;
    }
    return /** @type {any} */ (t);
  }

  /**
   * Run the downloader. @param {string[]} extra @param {number} timeoutMs
   * @returns {Promise<{ code: number|null, report: ReturnType<typeof parseKwsReport>, stderr: string }>}
   */
  _run(extra, timeoutMs) {
    const t = this._target();
    if (!t) return Promise.resolve({ code: null, report: null, stderr: '' });
    const args = ['-m', 'lawnmower_voice.download', '--kws-only', ...extra, '--json'];
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      /** @type {any} */
      let child;
      const finish = (/** @type {number|null} */ code) => {
        if (done) return;
        done = true;
        this._clear(timer);
        this._child = null;
        resolve({ code, report: parseKwsReport(lastJsonLine(out)), stderr: err.slice(-2000) });
      };
      const timer = this._set(() => {
        this._log('warn', `[wake] the zh-en model ${extra.includes('--check') ? 'check' : 'download'} timed out after ${Math.round(timeoutMs / 1000)} s`);
        try { child?.kill(); } catch { /* gone */ }
        finish(null);
      }, timeoutMs);
      try {
        child = this._spawn(t.python, args, {
          cwd: t.cwd,
          env: cleanChildEnv(this._o.env || process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        err = /** @type {Error} */ (e).message;
        finish(null);
        return;
      }
      this._child = child;
      child.stdout?.on('data', (/** @type {Buffer} */ d) => { if (out.length < 1e6) out += d.toString('utf8'); });
      child.stderr?.on('data', (/** @type {Buffer} */ d) => { if (err.length < 1e6) err += d.toString('utf8'); });
      child.on('error', (/** @type {Error} */ e) => {
        err += e.message;
        finish(null);
      });
      child.on('close', (/** @type {number|null} */ code) => finish(code));
    });
  }

  /**
   * Is model A on the user's PC? Downloads nothing. Resolves the folder or null.
   * @returns {Promise<string|null>}
   */
  async check() {
    const r = await this._run(['--check'], this._o.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
    if (!r.report) {
      if (this.state !== 'unavailable') {
        this._log('warn', `[wake] the zh-en model check gave no report (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
        this._setState('failed', 'The extra wake-word model could not be checked.');
      }
      return null;
    }
    if (r.report.modelsDir) this.modelsDir = r.report.modelsDir;
    if (r.report.present) {
      this.dir = r.report.dir;
      this._setState('ok');
      return this.dir;
    }
    this._setState('missing', 'The extra wake-word model is not downloaded yet.');
    return null;
  }

  /**
   * Download model A now (if it is not running already). `auto`: the once-per-run attempt.
   * @param {{ auto?: boolean }} [o]
   * @returns {{ ok: boolean, started: boolean }}
   */
  download(o = {}) {
    if (this._running) return { ok: true, started: false };
    if (o.auto) {
      if (this.autoTried) return { ok: true, started: false };
      this.autoTried = true;
    }
    if (!this._target()) return { ok: false, started: false };
    this._setState('downloading', 'The extra wake-word model is downloading.');
    this._log('info', '[wake] downloading the zh-en wake-word model (python -m lawnmower_voice.download --kws-only)');
    this._running = this._run([], this._o.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS).then((r) => {
      this._running = null;
      if (r.report?.modelsDir) this.modelsDir = r.report.modelsDir;
      if (r.code === 0 && r.report?.present) {
        this.dir = r.report.dir;
        this._log('info', `[wake] the zh-en wake-word model is in ${this.dir}`);
        this._setState('ok');
        this.emit('ready', this.dir);
        return;
      }
      const why = r.report?.error || r.stderr.trim().split('\n').slice(-1)[0] || `exit ${r.code}`;
      this._log('warn', `[wake] the zh-en wake-word model could not be downloaded: ${why}`);
      this._setState('failed', 'The extra wake-word model could not be downloaded; Jade uses the basic one.');
    });
    return { ok: true, started: true };
  }

  /**
   * When wake mode starts: check, and download once per run when absent.
   * @returns {Promise<string|null>} the folder when present now
   */
  async ensure() {
    const dir = await this.check();
    if (!dir && this.state === 'missing') this.download({ auto: true });
    return dir;
  }

  /** Mark it present from elsewhere (LAWNMOWER_WAKE_ZHEN_DIR, the dev models). @param {string} dir */
  useDir(dir) {
    this.dir = dir;
    this._setState('ok');
  }

  /** Stop a running download (app quit). */
  stop() {
    try { this._child?.kill(); } catch { /* gone */ }
  }
}
