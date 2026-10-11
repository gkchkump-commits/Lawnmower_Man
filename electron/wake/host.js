// WakeHost: starts and supervises the "Jade wake word" utility process and hands out the audio
// ports (contract-wake §7.2). Electron objects are injected (utilityProcess, MessageChannelMain),
// so the tests drive it with fakes.
//
// * fork(entry, [], { serviceName: 'Jade wake word', stdio: 'pipe', env: minimal }) + { t:'init' };
//   `ready` is expected within 15 s, otherwise the status is error ("did not start").
// * Unexpected exits restart after 1 s, 5 s, then 30 s; at most 5 restarts in 10 minutes, then the
//   status stays error ("keeps stopping"). A fatal init error (the addon or a model will not
//   load) is not retried: it would fail the same way.
// * connect(webContents) makes a fresh MessageChannelMain: port1 to the avatar window
//   (lm:wake:port { gen }), port2 to the utility ({ t:'port', gen }); `gen` grows with every
//   port. After a restart the renderer that asked before gets a new port by itself.
// * stop() is bounded: { t:'stop' }, then kill after 2 s.
// * Liveness: once ready, main pings the utility every 10 s ({ t:'ping', n } → { t:'pong', n });
//   any message counts. Nothing heard for 30 s (a frozen process, not a crashed one) is handled
//   like a crash: it is killed (SIGKILL after 2 s if it does not go) and restarted with the
//   backoff, so she never shows "listening" while deaf.
// * retry() (the user's "Retry", turning the wake word on) starts over with a fresh restart budget.

import { EventEmitter } from 'node:events';

export const SERVICE_NAME = 'Jade wake word';
export const READY_TIMEOUT_MS = 15000;
export const STOP_TIMEOUT_MS = 2000;
export const RESTART_BACKOFF_MS = Object.freeze([1000, 5000, 30000]);
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
export const PING_EVERY_MS = 10000;
export const LIVENESS_MS = 30000;
export const KILL_GRACE_MS = 2000;
const LOG_LINES_PER_WINDOW = 40;
const LOG_WINDOW_MS = 10000;

/**
 * The utility's environment: PATH, SystemRoot, TEMP/TMP and LAWNMOWER_* (no secrets: nothing
 * named like a token, key, secret or password), so no Claude or camera credentials reach it.
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string>}
 */
export function minimalEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) continue;
    const K = k.toUpperCase();
    const keep = K === 'PATH' || K === 'SYSTEMROOT' || K === 'TEMP' || K === 'TMP'
      || (K.startsWith('LAWNMOWER_') && !/TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED/.test(K));
    if (keep) out[k] = String(v);
  }
  return out;
}

/**
 * @typedef {object} InitMessage
 * @property {string} addon
 * @property {{ zhen?: object|null, giga: object, vad: string }} models
 * @property {{ sensitivity: string, phrase: string }} params
 * @property {object} [config]
 */

export class WakeHost extends EventEmitter {
  /**
   * @param {{ utilityProcess: any, MessageChannelMain: any, entry: string, env?: Record<string, string|undefined>,
   *   log?: (level: string, msg: string) => void, now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout,
   *   readyTimeoutMs?: number, stopTimeoutMs?: number, backoffMs?: readonly number[], maxRestarts?: number, restartWindowMs?: number,
   *   pingEveryMs?: number, livenessMs?: number, killPid?: (pid: number) => void }} o
   */
  constructor(o) {
    super();
    this._o = o;
    this._log = o.log || (() => {});
    this._now = o.now || Date.now;
    this._set = o.setTimeout || setTimeout;
    this._clear = o.clearTimeout || clearTimeout;
    /** @type {'off'|'starting'|'ready'|'error'} */
    this.state = 'off';
    this.detail = '';
    /** @type {any} */
    this.child = null;
    /** @type {InitMessage|null} */
    this._init = null;
    this.gen = 0;
    this.restarts = 0;
    /** @type {number[]} */
    this._restartTimes = [];
    this.loadMs = /** @type {number|undefined} */ (undefined);
    /** @type {string[]} */
    this.models = [];
    /** @type {any} */
    this.stats = null;
    /** @type {any[]} */
    this.lastHits = [];
    /** @type {any} */
    this._wc = null;
    /** @type {any} */
    this._timer = null; // ready timeout or restart delay
    this._stopping = false;
    this._noRestart = false;
    this._logWindow = { start: 0, lines: 0, dropped: 0 };
    /** when the running utility was last heard from (any message) */
    this._heardAt = 0;
    /** @type {any} */
    this._liveTimer = null;
    this._pingN = 0;
    /** frozen processes killed by the liveness watchdog */
    this.hung = 0;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  /** @param {'off'|'starting'|'ready'|'error'} state @param {string} [detail] */
  _setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('status');
  }

  /** Start (or restart with new model paths). @param {InitMessage} init */
  start(init) {
    this._init = init;
    this._stopping = false;
    this._noRestart = false;
    // a start the user asked for (the wake word turned on) gets a fresh restart budget
    this._restartTimes = [];
    this._clearTimer();
    if (this.child) {
      this._replace();
      return;
    }
    this._fork();
  }

  /** A deliberate restart (new models, the e2e hook): not counted against the restart cap. @param {InitMessage} [init] */
  restart(init) {
    if (init) this._init = init;
    if (!this._init) return;
    this._stopping = false;
    this._noRestart = false;
    this._clearTimer();
    if (this.child) this._replace();
    else this._fork();
  }

  /**
   * The user's "Retry" after "keeps stopping" or "could not start": a fresh restart budget and a
   * new process. @param {InitMessage} [init]
   */
  retry(init) {
    this._restartTimes = [];
    this.restart(init);
  }

  /** Kill the process as if it crashed (tests, the e2e hook): supervision restarts it. */
  crash() {
    try {
      this.child?.kill();
      return true;
    } catch {
      return false;
    }
  }

  /** Kill the running child and start a new one when it is gone. */
  _replace() {
    const old = this.child;
    this.child = null;
    old.__replaced = true;
    this._stopLiveness();
    this._kill(old);
    this._fork();
  }

  /** kill(), then SIGKILL after KILL_GRACE_MS (a stopped or frozen process ignores SIGTERM). @param {any} child */
  _kill(child) {
    try { child.kill(); } catch { /* gone */ }
    let exited = false;
    child.once?.('exit', () => { exited = true; });
    this._set(() => {
      if (exited || !child.pid) return;
      try { (this._o.killPid || ((pid) => process.kill(pid, 'SIGKILL')))(child.pid); } catch { /* gone */ }
    }, KILL_GRACE_MS);
  }

  _startLiveness(child) {
    this._stopLiveness();
    this._heardAt = this._now();
    const every = this._o.pingEveryMs ?? PING_EVERY_MS;
    const limit = this._o.livenessMs ?? LIVENESS_MS;
    const check = () => {
      this._liveTimer = null;
      if (this.child !== child || this.state !== 'ready') return;
      if (this._now() - this._heardAt > limit) {
        // frozen, not crashed: handle it like a crash (killed → exit → the backoff restart)
        this.hung++;
        this._log('warn', `[wake] the wake-word process has not answered for ${Math.round((this._now() - this._heardAt) / 1000)} s; restarting it`);
        this._setState('starting', 'The wake-word engine stopped answering; restarting it.');
        this._kill(child);
        return;
      }
      try { child.postMessage({ t: 'ping', n: ++this._pingN }); } catch { /* exiting */ }
      this._liveTimer = this._set(check, every);
    };
    this._liveTimer = this._set(check, every);
  }

  _stopLiveness() {
    if (this._liveTimer) this._clear(this._liveTimer);
    this._liveTimer = null;
  }

  _fork() {
    const init = /** @type {InitMessage} */ (this._init);
    this._setState('starting', 'The wake-word engine is starting.');
    let child;
    try {
      child = this._o.utilityProcess.fork(this._o.entry, [], { serviceName: SERVICE_NAME, stdio: 'pipe', env: minimalEnv(this._o.env || {}) });
    } catch (err) {
      this._log('error', `[wake] could not start the wake-word process: ${/** @type {Error} */ (err).message}`);
      this._noRestart = true;
      this._setState('error', 'The wake-word engine could not start; see the log.');
      return;
    }
    this.child = child;
    this.models = [];
    child.stdout?.on?.('data', (/** @type {Buffer} */ d) => this._childLog('info', d));
    child.stderr?.on?.('data', (/** @type {Buffer} */ d) => this._childLog('warn', d));
    child.on('message', (/** @type {any} */ m) => this._onMessage(child, m));
    child.on('exit', (/** @type {number} */ code) => this._onExit(child, code));
    child.postMessage({ t: 'init', ...init });
    this._timer = this._set(() => {
      this._timer = null;
      if (this.child !== child || this.state === 'ready') return;
      this._log('warn', `[wake] the wake-word process did not report ready within ${Math.round((this._o.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} s`);
      this._setState('error', 'The wake-word engine did not start.');
      try { child.kill(); } catch { /* gone */ } // exit → restart with backoff
    }, this._o.readyTimeoutMs ?? READY_TIMEOUT_MS);
    // the renderer that asked before gets a port to the new process (it queues until loaded)
    if (this._wc && !this._wc.isDestroyed?.()) this.connect(this._wc);
  }

  /** @param {any} child @param {any} m */
  _onMessage(child, m) {
    if (child !== this.child || !m || typeof m !== 'object') return;
    this._heardAt = this._now();
    if (m.t === 'ready') {
      this._clearTimer();
      this._startLiveness(child);
      this.loadMs = Number(m.loadMs) || undefined;
      this.models = Array.isArray(m.models) ? m.models.map(String) : [];
      this._log('info', `[wake] wake-word engine ready (${this.models.join(' + ')}, ${this.loadMs} ms; pid ${child.pid})`);
      this._setState('ready');
    } else if (m.t === 'error') {
      const msg = String(m.message || '').slice(0, 500);
      if (m.fatal) {
        this._log('error', `[wake] wake-word engine failed: ${msg}`);
        if (this.state !== 'ready') this._noRestart = true; // the addon or a model does not load: retrying cannot help
        this._setState('error', `The wake-word engine could not start: ${msg}`.slice(0, 300));
      } else this._log('warn', `[wake] ${msg}`);
    } else if (m.t === 'stats') {
      this.stats = m;
      if (Array.isArray(m.hits)) this.lastHits = m.hits.slice(-20);
      this.emit('stats', m);
    }
  }

  /** @param {any} child @param {number} code */
  _onExit(child, code) {
    if (child.__replaced) return;
    if (child !== this.child) return;
    this.child = null;
    this._clearTimer();
    this._stopLiveness();
    if (this._stopping) {
      this._setState('off');
      return;
    }
    this._log('warn', `[wake] the wake-word process exited (code ${code})`);
    if (this._noRestart) {
      if (this.state !== 'error') this._setState('error', 'The wake-word engine could not start; see the log.');
      return;
    }
    const now = this._now();
    const windowMs = this._o.restartWindowMs ?? RESTART_WINDOW_MS;
    this._restartTimes = this._restartTimes.filter((t) => now - t < windowMs);
    if (this._restartTimes.length >= (this._o.maxRestarts ?? MAX_RESTARTS)) {
      this._log('error', '[wake] the wake-word process keeps stopping; not restarting it again');
      this._setState('error', 'The wake-word engine keeps stopping; see the log.');
      return;
    }
    const backoff = this._o.backoffMs ?? RESTART_BACKOFF_MS;
    const delay = backoff[Math.min(this._restartTimes.length, backoff.length - 1)];
    this._restartTimes.push(now);
    this.restarts++;
    this._setState('starting', 'The wake-word engine stopped; restarting it.');
    this._timer = this._set(() => {
      this._timer = null;
      if (!this._stopping && !this.child && this._init) this._fork();
    }, delay);
  }

  /** @param {'info'|'warn'} level @param {Buffer} data */
  _childLog(level, data) {
    const now = this._now();
    const w = this._logWindow;
    if (now - w.start > LOG_WINDOW_MS) {
      if (w.dropped) this._log('warn', `[wake] (${w.dropped} more lines from the wake-word process not logged)`);
      w.start = now;
      w.lines = 0;
      w.dropped = 0;
    }
    for (const line of String(data).split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      if (w.lines >= LOG_LINES_PER_WINDOW) {
        w.dropped++;
        continue;
      }
      w.lines++;
      this._log(level, l.startsWith('[wake]') ? l.slice(0, 500) : `[wake] ${l.slice(0, 500)}`);
    }
  }

  /**
   * A new audio port for the avatar window (lm:wake:request-port).
   * @param {any} webContents
   * @returns {{ ok: boolean, gen: number }}
   */
  connect(webContents) {
    this._wc = webContents;
    const child = this.child;
    if (!child || (this.state !== 'starting' && this.state !== 'ready')) return { ok: false, gen: this.gen };
    if (!webContents || webContents.isDestroyed?.()) return { ok: false, gen: this.gen };
    const gen = ++this.gen;
    const { port1, port2 } = new this._o.MessageChannelMain();
    try {
      webContents.postMessage('lm:wake:port', { gen }, [port1]);
      child.postMessage({ t: 'port', gen }, [port2]);
    } catch (err) {
      this._log('warn', `[wake] handing out the audio port failed: ${/** @type {Error} */ (err).message}`);
      try { port1.close(); } catch { /* sent */ }
      try { port2.close(); } catch { /* sent */ }
      return { ok: false, gen };
    }
    return { ok: true, gen };
  }

  /** sensitivity / phrase changed. @param {{ sensitivity: string, phrase: string }} params */
  sendSettings(params) {
    if (this._init) this._init = { ...this._init, params };
    try {
      this.child?.postMessage({ t: 'settings', params });
    } catch { /* restarting: init carries it */ }
  }

  /** Stop the process (bounded): { t:'stop' }, then kill. */
  async stop() {
    this._stopping = true;
    this._clearTimer();
    this._stopLiveness();
    const child = this.child;
    if (!child) {
      this._setState('off');
      return;
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._clear(t);
        resolve(undefined);
      };
      child.once?.('exit', finish);
      const t = this._set(() => {
        try { child.kill(); } catch { /* gone */ }
        finish();
      }, this._o.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      try { child.postMessage({ t: 'stop' }); } catch { finish(); }
    });
    if (this.child === child) this.child = null;
    this._setState('off');
  }

  _clearTimer() {
    if (this._timer) this._clear(this._timer);
    this._timer = null;
  }
}
