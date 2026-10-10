// Go2rtcSidecar: the bundled go2rtc (MIT) that pulls the camera's ONE RTSP session and serves
// it as fragmented MP4 on loopback (contract §8.5). Pure Node (child_process + http).
//
// go2rtc's API can run commands when misconfigured, so it is locked down:
//  * modules api, mp4, rtsp only (no exec/echo/expr/ffmpeg/webrtc/…); its RTSP server is off;
//  * the API listens on 127.0.0.1:<random> with random Basic credentials and local_auth (loopback
//    requests must authenticate too); allow_paths limits it to /api/streams and /api/stream.mp4;
//  * go2rtc never gets the Camera Account: its source is main's RTSP auth proxy on loopback
//    (rtsp-auth-proxy.js), which signs in to the camera itself (Digest only, never Basic). The
//    proxy's secret path token comes from the environment (${LM_SRC_TOKEN}), so the config file
//    holds no secret; go2rtc masks substituted values in its API output and its log lines go
//    through redact() anyway.
// The RTSP session to the camera only exists while main reads /api/stream.mp4 (stream-relay.js):
// go2rtc tears it down when the last consumer leaves, freeing one of the camera's two streams.

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { backoffDelay, cleanChildEnv, killProcessTree, spawnPortable, waitForExit } from '../spawn-util.js';
import { findFreePort } from '../voice-sidecar.js';
import { hostPort } from './host.js';
import { redact } from './credentials.js';

export const GO2RTC_STREAM = 'lm_main';
export const MISSING_DETAIL = 'The video component is missing. Reinstall Lawnmower Man (or run `npm run fetch:go2rtc` in a source checkout).';
/**
 * The camera refused the Camera Account: go2rtc 1.9.14 logs `error="streams: wrong user/pass"`
 * (after one DESCRIBE retry of its own) and answers /api/stream.mp4 with HTTP 500 and that text.
 */
export const AUTH_LINE = /wrong user(?:\/| or )pass(?:word)?|\b401 Unauthorized\b/i;

/**
 * Where the binary is: LAWNMOWER_GO2RTC → packaged resources/tapo/ → vendor/go2rtc/<platform>-<arch>/.
 * @param {{ isPackaged: boolean, resourcesPath?: string, appRoot: string, platform?: string, arch?: string, env?: Record<string, string|undefined> }} o
 */
export function go2rtcBinaryPath(o) {
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const exe = platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
  const P = platform === 'win32' ? path.win32 : path.posix;
  const env = o.env || process.env;
  if (env.LAWNMOWER_GO2RTC) return env.LAWNMOWER_GO2RTC;
  if (o.isPackaged && o.resourcesPath) return P.join(o.resourcesPath, 'tapo', exe);
  return P.join(o.appRoot, 'vendor', 'go2rtc', `${platform}-${arch}`, exe);
}

/**
 * go2rtc's config: JSON (valid YAML, so nothing needs YAML escaping). No secrets: ${LM_*} come
 * from the environment. The source is main's RTSP auth proxy on loopback (`sourcePort`).
 * @param {{ sourcePort: number, stream: 'stream1'|'stream2' }} o
 */
export function buildGo2rtcConfig(o) {
  const stream = o.stream === 'stream2' ? 'stream2' : 'stream1';
  const port = Math.max(1, Math.min(65535, Math.round(Number(o.sourcePort) || 0)));
  if (!port) throw new Error('go2rtc needs the RTSP proxy port');
  const config = {
    app: { modules: ['api', 'mp4', 'rtsp'] },
    api: {
      listen: '127.0.0.1:${LM_G2R_PORT}',
      username: '${LM_G2R_USER}',
      password: '${LM_G2R_PASS}',
      local_auth: true,
      allow_paths: ['/api/streams', '/api/stream.mp4'],
    },
    rtsp: { listen: '' },
    log: { format: 'text', level: 'info', output: 'stdout' },
    streams: { [GO2RTC_STREAM]: `rtsp://${hostPort('127.0.0.1', port)}/\${LM_SRC_TOKEN}/${stream}` },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The child's extra environment (no camera credentials: go2rtc never has them).
 * @param {{ port: number, apiUser: string, apiPass: string, sourceToken: string }} o
 * @returns {Record<string, string>}
 */
export function go2rtcEnv(o) {
  if (!/^[A-Za-z0-9]{8,64}$/.test(String(o.sourceToken || ''))) throw new Error('go2rtc needs the RTSP proxy token');
  return {
    LM_G2R_PORT: String(o.port),
    LM_G2R_USER: o.apiUser,
    LM_G2R_PASS: o.apiPass,
    LM_SRC_TOKEN: o.sourceToken,
  };
}

/**
 * GET with Basic auth on loopback (no proxy, short timeout).
 * @param {string} url @param {string} auth @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: string }>}
 */
export function loopbackGet(url, auth, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Authorization: auth }, agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * @typedef {{ state: 'stopped'|'starting'|'ready'|'error'|'missing', detail?: string, url?: string, port?: number }} Go2rtcInfo
 * @typedef {{ sourcePort: number, sourceToken: string, stream: 'stream1'|'stream2' }} Go2rtcParams  the RTSP proxy (rtsp-auth-proxy.js)
 */

export class Go2rtcSidecar extends EventEmitter {
  /**
   * @param {{ binary: string, configDir: string, log?: (level: string, msg: string) => void, env?: NodeJS.ProcessEnv,
   *   platform?: string, spawn?: typeof import('node:child_process').spawn, fs?: typeof nodeFs, readyTimeoutMs?: number,
   *   restart?: { baseDelayMs?: number, maxDelayMs?: number, maxAttempts?: number, stableMs?: number } }} o
   */
  constructor(o) {
    super();
    this._binary = o.binary;
    this._configDir = o.configDir;
    this._log = o.log || (() => {});
    this._env = o.env || process.env;
    this._platform = o.platform || process.platform;
    this._spawn = o.spawn;
    this._fs = o.fs || nodeFs;
    this._readyTimeoutMs = o.readyTimeoutMs ?? 10000;
    this._restart = { baseDelayMs: o.restart?.baseDelayMs ?? 2000, maxDelayMs: o.restart?.maxDelayMs ?? 30000, maxAttempts: o.restart?.maxAttempts ?? 5, stableMs: o.restart?.stableMs ?? 120000 };
    /** @type {Go2rtcInfo} */
    this._info = { state: 'stopped' };
    /** @type {any} */
    this._proc = null;
    /** @type {Go2rtcParams|null} */
    this._params = null;
    /** @type {string[]} */
    this._secrets = [];
    this._failures = 0;
    /** @type {NodeJS.Timeout|null} */
    this._restartTimer = null;
    this._stopped = true;
    this._authFailed = false;
    /** @type {{ url: string, auth: string }|null} */
    this._endpoint = null;
  }

  /** @returns {Go2rtcInfo} */
  info() {
    return { ...this._info };
  }

  /** The API endpoint while ready: { url, auth } (never sent to a renderer). */
  endpoint() {
    return this._info.state === 'ready' ? this._endpoint : null;
  }

  get pid() {
    return this._proc?.child?.pid ?? null;
  }

  /** Does the binary exist? */
  hasBinary() {
    try {
      return this._fs.statSync(this._binary).isFile();
    } catch {
      return false;
    }
  }

  /** @param {Go2rtcInfo} info */
  _set(info) {
    this._info = info;
    this.emit('status', this.info());
  }

  /** Retry after an error (user pressed Retry): the crash counter starts again. */
  resetFailures() {
    this._failures = 0;
    this._authFailed = false;
  }

  /**
   * Start (or restart with new parameters). Resolves with the API endpoint once go2rtc answers.
   * @param {Go2rtcParams} params
   * @returns {Promise<{ url: string, auth: string }>}
   */
  async start(params) {
    this._stopped = false;
    this._authFailed = false;
    this._params = { ...params };
    this._secrets = [params.sourceToken];
    await this._kill();
    return this._launch();
  }

  async _launch() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const p = this._params;
    if (!p || this._stopped) throw new Error('go2rtc is stopped');
    if (!this.hasBinary()) {
      this._set({ state: 'missing', detail: MISSING_DETAIL });
      throw new Error(MISSING_DETAIL);
    }
    this._set({ state: 'starting', detail: 'Starting the video component…' });
    const port = await findFreePort();
    const apiUser = randomBytes(6).toString('hex');
    const apiPass = randomBytes(12).toString('hex');
    this._secrets = [p.sourceToken, apiPass];
    const configFile = path.join(this._configDir, 'go2rtc.yaml');
    this._fs.mkdirSync(this._configDir, { recursive: true });
    this._fs.writeFileSync(configFile, buildGo2rtcConfig(p), { mode: 0o600 });
    const env = cleanChildEnv(this._env, go2rtcEnv({ port, apiUser, apiPass, sourceToken: p.sourceToken }));
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      ({ child } = spawnPortable(this._binary, ['-config', configFile], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, platform: this._platform, cwd: this._configDir, ...(this._spawn ? { spawnImpl: this._spawn } : {}),
      }));
    } catch (err) {
      this._set({ state: 'error', detail: `The video component could not start: ${/** @type {Error} */ (err).message}` });
      throw err;
    }
    const proc = { child, exited: false, expected: false, startedAt: Date.now(), readyAt: 0 };
    this._proc = proc;
    this._log('info', `[go2rtc] spawned pid ${child.pid} on 127.0.0.1:${port}`);
    const onLine = (/** @type {string} */ line) => {
      const clean = redact(line, this._secrets).slice(0, 500);
      if (!clean.trim() || /zerolog: could not write event/.test(clean)) return;
      this._log(/\b(ERR|WRN|error|warn)/.test(clean) ? 'info' : 'debug', `[go2rtc] ${clean}`);
      if (AUTH_LINE.test(line)) this._onAuthFailed(clean);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream?.on('data', (d) => {
        const text = rest + String(d);
        const lines = text.split(/\r?\n/);
        rest = lines.pop() || '';
        if (rest.length > 4096) rest = '';
        for (const l of lines) onLine(l);
      });
    }
    child.once('error', (err) => {
      this._log('warn', `[go2rtc] ${redact(err.message, this._secrets)}`);
      if (child.pid === undefined) this._onExit(proc, null, null);
    });
    child.once('exit', (code, signal) => this._onExit(proc, code, signal));

    const url = `http://127.0.0.1:${port}`;
    const auth = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
    const deadline = Date.now() + this._readyTimeoutMs;
    while (!proc.exited && this._proc === proc) {
      try {
        const r = await loopbackGet(`${url}/api/streams`, auth, 1000);
        if (r.status === 200) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        this._log('warn', '[go2rtc] did not answer within 10 s');
        await killProcessTree(child, { platform: this._platform });
        throw new Error('The video component did not start in time.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (proc.exited || this._proc !== proc) throw new Error('The video component stopped while starting.');
    proc.readyAt = Date.now();
    this._endpoint = { url, auth };
    this._set({ state: 'ready', url, port });
    return this._endpoint;
  }

  /** @param {string} line */
  _onAuthFailed(line) {
    if (this._authFailed) return;
    this._authFailed = true;
    this._log('warn', `[go2rtc] the camera refused the RTSP sign-in (${line.slice(0, 200)}); stopping the video component`);
    this.emit('auth-failed');
    this._set({ state: 'error', detail: 'The camera refused the video sign-in (Camera Account user name or password).' });
    this._kill().catch(() => {});
  }

  /** @param {any} proc @param {number|null} code @param {string|null} signal */
  _onExit(proc, code, signal) {
    if (proc.exited) return;
    proc.exited = true;
    if (this._proc !== proc) return;
    this._proc = null;
    this._endpoint = null;
    if (proc.expected || this._stopped || this._authFailed) {
      if (!this._authFailed && this._info.state !== 'missing') this._set({ state: 'stopped' });
      return;
    }
    const how = code !== null ? `code ${code}` : signal ? `signal ${signal}` : 'spawn failure';
    if (proc.readyAt && Date.now() - proc.readyAt > this._restart.stableMs) this._failures = 0;
    this._failures++;
    if (this._failures > this._restart.maxAttempts) {
      this._set({ state: 'error', detail: `The video component stopped (${how}) and was restarted ${this._restart.maxAttempts} times. Press Retry.` });
      return;
    }
    const delay = backoffDelay(this._failures, this._restart.baseDelayMs, this._restart.maxDelayMs);
    this._log('warn', `[go2rtc] exited (${how}); restarting in ${Math.round(delay / 1000)} s`);
    this._set({ state: 'error', detail: `The video component stopped (${how}); restarting…` });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._stopped) this._launch().then(() => this.emit('restarted')).catch((err) => this._log('warn', `[go2rtc] restart failed: ${err.message}`));
    }, delay);
  }

  async _kill() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const proc = this._proc;
    if (!proc) return;
    proc.expected = true;
    this._proc = null;
    this._endpoint = null;
    if (!proc.exited) {
      await killProcessTree(proc.child, { platform: this._platform, graceMs: 1500 });
      await waitForExit(proc.child, 1000);
    }
  }

  async stop() {
    this._stopped = true;
    await this._kill();
    if (this._info.state !== 'missing') this._set({ state: 'stopped' });
  }
}
