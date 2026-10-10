// TapoService: one home camera, end to end (contract §8.11). It composes the ONVIF client, PTZ,
// camera events, go2rtc + the stream relay, the recorder, the security engine, the event store
// and the worker port, and turns everything into one TapoStatus. No Electron import: windows,
// notifications, MessageChannelMain and shell are injected (index.js).
//
// Lifecycle: enabled + host + Camera Account + password → resolve the host (LAN only, pinned) →
// ONVIF connect (the sign-in check) → PTZ probe → go2rtc (only after ONVIF accepted the sign-in)
// → the stream while it is needed (§2.3) → the camera's events while armed.
// A sign-in failure stops everything that talks to the camera until the credentials or the
// address change, or a connection test passes (camera lockouts). Unreachable → retry with
// backoff 2, 5, 10, 30, 60 s.

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import path from 'node:path';

import { HostError, resolveLanHost } from './host.js';
import { OnvifClient } from './onvif-client.js';
import { OnvifError } from './onvif-soap.js';
import { PtzController, noCaps, PRIVACY_HINT } from './ptz.js';
import { CalibrationWizard } from './calibration.js';
import { PullPointMonitor } from './events.js';
import { Go2rtcSidecar } from './go2rtc.js';
import { RtspAuthProxy } from './rtsp-auth-proxy.js';
import { StreamRelay } from './stream-relay.js';
import { ClipRecorder } from './recorder.js';
import { EventStore, newEventId, eventBase, toSummary } from './event-store.js';
import { runRetention } from './retention.js';
import { SecurityEngine, inQuietHours } from './security-engine.js';
import { buildAvatarAlert } from './alerts.js';
import { createCameraMcp, qualifiedToolName, SERVER_NAME } from './camera-mcp.js';
import { createMcpHttpServer } from './mcp-http.js';
import { connectionTest, HINTS, tcpCheck } from './connection-test.js';
import { diagnosticReport } from './diagnostics.js';
import { discover } from './discovery.js';
import { redact, validatePassword } from './credentials.js';
import { validateWorkerMessage } from './validate.js';

export { HINTS, tcpCheck };

export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000, 30000, 60000]);
const STATUS_MIN_MS = 250; // ≤ 4 status messages a second
const TICK_MS = 500;
const SNAPSHOT_STREAM_MS = 30_000;
const DET_PER_SEC = 10;
/** How often the camera's health is looked at. */
/**
 * How much longer than its own timeout main waits for the worker's calibration measurement. The
 * worker can stall for many seconds where frame readback is slow (software GL on a loaded PC:
 * 16 s measured in tapo-e2e) and then still measure correctly; the wizard shows its progress and
 * a Stop button meanwhile.
 */
export const SHIFT_SLACK_MS = 25_000;
/** How long main waits for the worker's still reference picture before moving anyway. */
export const SHIFT_REF_TIMEOUT_MS = 30_000;
/**
 * Video chunks the worker may be behind before main stops sending (≈ 1.6 s at 15 fps). A PC that
 * cannot decode in real time would otherwise queue chunks without bound in the MessagePort: the
 * live view, the detector and calibration then run seconds (tapo-e2e: 14 s) behind the camera.
 * Main skips to the next key frame instead (the worker acknowledges what it has handled).
 */
export const MAX_CHUNKS_BEHIND = 24;
export const HEALTH_EVERY_MS = 2000;
/** The video gone this long (while it is wanted), or the camera's events failing: is the camera still there? */
export const PROBE_AFTER_MS = 10_000;
/** Armed but not watching (camera offline, no video) for this long: shown as such. */
export const BLIND_GRACE_MS = 30_000;
/** … and for this long: one notification and an avatar line. */
export const BLIND_ALERT_MS = 60_000;

/** @param {number} at */
const iso = (at) => new Date(at).toISOString();

/**
 * @typedef {object} TapoDeps   everything injectable (tests use fakes)
 * @property {(host: string, o: { allowLoopback: boolean }) => Promise<{ ip: string, family: number }>} [resolveHost]
 * @property {(o: any) => any} [createClient]
 * @property {string} [go2rtcBinary]
 * @property {(o: any) => any} [createSidecar]
 * @property {(o: any) => any} [createRelay]
 * @property {(o: any) => any} [createRtspProxy]
 * @property {typeof import('./rtsp-probe.js').rtspDescribe} [rtspDescribe]
 * @property {typeof discover} [discover]
 * @property {any} [MessageChannelMain]
 * @property {{ notify: (o: any) => boolean }} [alerts]
 * @property {(p: string) => Promise<string>} [openPath]
 * @property {'mediapipe'|'stub'} [detector]
 * @property {{ wasmBase: string, modelUrl: string }} [assets]
 * @property {(o: { host: string, port: number, timeoutMs: number }) => Promise<boolean>} [tcpCheck]
 */

/** What a connection depends on. @param {any} t */
const connKey = (t) => JSON.stringify([t.host, t.onvifPort, t.username]);

/** @param {Buffer} b */
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

export class TapoService extends EventEmitter {
  /**
   * @param {{ settings: { get: () => any, update: (p: any) => any }, credentials: import('./credentials.js').CredentialStore,
   *   paths: { configDir: string, defaultClipsDir: string }, deps?: TapoDeps, log?: (level: string, msg: string) => void,
   *   env?: Record<string, string|undefined>, appVersion?: string, now?: () => number, mono?: () => number }} o
   *   mono: main's monotonic clock (performance.now()): the video samples' arrival stamps and the
   *   calibration's "only pictures that arrived after the last move" gate
   */
  constructor(o) {
    super();
    this._settings = o.settings;
    this._cred = o.credentials;
    this._paths = o.paths;
    this._deps = o.deps || {};
    this._log = o.log || (() => {});
    this._env = o.env || process.env;
    this._now = o.now || (() => Date.now());
    this._mono = o.mono || (() => performance.now());
    this._allowLoopback = this._env.LAWNMOWER_TAPO_ALLOW_LOOPBACK === '1';
    this._appVersion = o.appVersion || '0.0.0';

    /** @type {{ state: string, detail: string }} */
    this._conn = { state: 'off', detail: 'The home camera is turned off.' };
    this._gen = 0;
    this._attempt = 0;
    /** @type {NodeJS.Timeout|null} */
    this._retryTimer = null;
    /** @type {OnvifClient|null} */
    this.client = null;
    /** @type {PtzController|null} */
    this.ptzCtl = null;
    /** @type {PullPointMonitor|null} */
    this.monitor = null;
    this._ip = '';
    this._authFailed = false;
    this._videoAuthFailed = false;
    /** @type {string[]} */
    this._topics = [];
    this._eventsState = 'off';
    this._viewVisible = false;
    this._snapshotUntil = 0;
    this._streamWanted = false;
    /** the address/port/account the current connection was made with @type {string} */
    this._connKey = '';
    this._started = false;
    this._stopping = false;
    /** @type {string[]} */
    this._warnings = [];
    this._storage = { bytes: 0, clips: 0 };

    // video: go2rtc pulls the camera's RTSP through main's auth proxy (it never has the password)
    /** @type {Promise<void>} */
    this._videoChain = Promise.resolve();
    this.rtspProxy = (this._deps.createRtspProxy || ((/** @type {any} */ x) => new RtspAuthProxy(x)))({ log: this._log });
    this.rtspProxy.on('auth-failed', () => this._onVideoAuthFailed());
    this.rtspProxy.on('insecure', () => this._onVideoInsecure());
    this.sidecar = (this._deps.createSidecar || ((/** @type {any} */ x) => new Go2rtcSidecar(x)))({
      binary: this._deps.go2rtcBinary || '', configDir: this._paths.configDir, log: this._log, env: this._env,
    });
    this.sidecar.on('status', () => this._statusSoon());
    this.sidecar.on('auth-failed', () => this._onVideoAuthFailed());
    this.sidecar.on('restarted', () => this.relay.kick());
    this.relay = (this._deps.createRelay || ((/** @type {any} */ x) => new StreamRelay(x)))({
      getEndpoint: () => this.sidecar.endpoint(), log: this._log, now: this._now, mono: this._mono, redact: (/** @type {string} */ t) => redact(t, [this.rtspProxy.token]),
    });
    this.relay.on('state', (/** @type {string} */ s) => this._onRelayState(s));
    this.relay.on('auth-failed', () => this._onVideoAuthFailed());
    this.relay.on('init', (/** @type {any} */ init) => {
      this.recorder.onInit(init);
      this._post({ t: 'config', gen: init.gen, codec: init.codec, description: toArrayBuffer(init.description), width: init.width, height: init.height });
    });
    this.relay.on('reset', (/** @type {any} */ r) => this._post({ t: 'reset', gen: r.gen }));
    this.relay.on('sample', (/** @type {any} */ s) => this._onSample(s));
    this.relay.on('stats', () => this._statusSoon());

    // recording and events
    this.store = new EventStore({ getDir: () => this.clipsDir(), log: this._log, now: this._now });
    this.recorder = new ClipRecorder({ getDir: () => this.clipsDir(), getSettings: () => this._sec(), log: this._log, now: this._now });
    this.recorder.on('clip-start', (/** @type {any} */ c) => this._onClipStart(c));
    this.recorder.on('clip-end', (/** @type {any} */ c) => this._onClipEnd(c));
    this.recorder.on('error', (/** @type {Error} */ err) => this._warn(`A clip could not be saved (${err.message}).`));
    this.engine = new SecurityEngine({ settings: this._sec(), now: this._now, newId: (at) => newEventId(at) });
    /** @type {Map<string, string>} the kind each event started as (its file names) */
    this._eventKinds = new Map();
    /** @type {Map<string, Promise<string|null>>} alert snapshot files per event */
    this._alertSnaps = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._tick = null;
    /** @type {NodeJS.Timeout|null} */
    this._retention = null;

    // the worker in the camera window
    /** @type {any} */
    this._port = null;
    this._detector = 'off';
    /** @type {any} */
    this._workerStats = null;
    this._detTimes = /** @type {number[]} */ ([]);
    this._reqSeq = 0;
    /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this._pending = new Map();

    // calibration
    this._calibrating = false;
    this.calibration = new CalibrationWizard({
      ptz: { rawMove: (x, y) => this._ptzOrThrow().rawMove(x, y), stopAll: (r) => this.ptzCtl?.stopAll(r) || Promise.resolve() },
      vision: { ref: (r) => this._shiftRef(r.after), measure: (m) => this._shiftMeasure(m.timeoutMs, !!m.expectMove, m.after) },
      clock: () => this._mono(),
      canStart: () => this._calibrationBlocker(),
      current: () => {
        const t = this._tapo();
        return { invertPan: t.invertPan, invertTilt: t.invertTilt, viewUnitsX: t.viewUnitsX, viewUnitsY: t.viewUnitsY, minStep: t.minStep, msPerUnit: t.msPerUnit };
      },
      save: (r) => this._settings.update({ tapo: { ...r } }),
      log: this._log,
      now: this._now,
    });
    this.calibration.on('state', (/** @type {any} */ st) => {
      this._calibrating = this.calibration.running;
      this._updateStream();
      this.emit('calibration', st);
    });

    // Claude
    this._mcp = createCameraMcp({ service: this._mcpAdapter(), getSettings: () => ({ tapo: this._tapo(), security: this._sec() }), appVersion: this._appVersion, log: this._log, now: this._now });
    this._mcpHttp = createMcpHttpServer({ handle: (m) => this._mcp.handle(m), log: this._log });

    /** @type {NodeJS.Timeout|null} */
    /** main → worker video chunks: sent, acknowledged, skipping to a key frame @type {{ seq: number, acked: number, acks: boolean, skipping: boolean, dropped: number }} */
    this._flow = { seq: 0, acked: 0, acks: false, skipping: false, dropped: 0 };
    this._shiftSlackMs = SHIFT_SLACK_MS;
    this._shiftRefTimeoutMs = SHIFT_REF_TIMEOUT_MS;
    this._statusTimer = null;
    this._lastStatusAt = 0;

    // health: the camera dropping off mid-session, an armed camera that stopped watching
    /** @type {NodeJS.Timeout|null} */
    this._healthTimer = null;
    this._streamDownSince = 0;
    this._lastProbeAt = 0;
    this._probing = false;
    /** armed but not watching: why and since when @type {{ why: ''|'offline'|'no-video', since: number, alerted: boolean }} */
    this._blind = { why: '', since: 0, alerted: false };
    this._lastWatching = 'yes';
  }

  // -------------------------------------------------------------------------------------------
  // settings

  _tapo() {
    return this._settings.get().tapo;
  }

  _sec() {
    return this._settings.get().security;
  }

  /** The clips folder (security.clipsDir or <Videos>/Lawnmower Man/Security). */
  clipsDir() {
    return this._sec().clipsDir || this._paths.defaultClipsDir;
  }

  cameraName() {
    return (this._tapo().name || 'camera').trim() || 'camera';
  }

  /** Host, Camera Account and a password for that host. */
  configured() {
    const t = this._tapo();
    return !!(t.host && t.username && this._cred.hasPassword(t.host));
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle

  async start() {
    this._started = true;
    await this._cred.load();
    await this.store.scan().catch(() => {});
    this._runRetention();
    this._retention = setInterval(() => this._runRetention(), 60 * 60 * 1000);
    this._retention.unref?.();
    this._healthTimer = setInterval(() => this._checkHealth(), HEALTH_EVERY_MS);
    this._healthTimer.unref?.();
    // an armed app re-arms right after a restart (no exit delay)
    if (this._sec().armed) this._apply(this.engine.arm(true, { immediate: true }));
    this._syncTick();
    if (this._tapo().enabled) await this._connect('start');
    else this._setConn('off', 'The home camera is turned off.');
  }

  /** Bounded (≈4 s): Stop the motor, Unsubscribe, finish the clip, stop go2rtc. */
  async stop() {
    this._stopping = true;
    this._started = false;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._tick) clearInterval(this._tick);
    if (this._retention) clearInterval(this._retention);
    if (this._statusTimer) clearTimeout(this._statusTimer);
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._tick = this._retention = this._statusTimer = this._retryTimer = this._healthTimer = null;
    const work = Promise.allSettled([
      this.ptzCtl ? this.ptzCtl.stopAll('quit', { force: true }) : null,
      this.monitor ? this.monitor.stop() : null,
      this.recorder.close(),
      this._mcpHttp.stop(),
    ]).then(() => {
      this.relay.stop();
      return this._stopVideo();
    });
    await Promise.race([work, new Promise((r) => setTimeout(r, 4000))]);
    this.client?.close();
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
    try { this._port?.close(); } catch { /* closed */ }
    this._port = null;
  }

  /**
   * React to a settings change (main.js onSettingsChanged).
   * @param {any} next @param {any} prev
   */
  applySettings(next, prev) {
    const t = next.tapo;
    const p = prev?.tapo || {};
    const s = next.security;
    const ps = prev?.security || {};
    this._apply(this.engine.setSettings(s));
    if (s.armed !== this.engine.state.armed) this._apply(this.engine.arm(s.armed, { immediate: false }));
    this._syncTick();
    // (setCredentials may already have reconnected with the new account)
    const reconnect = t.enabled !== p.enabled || connKey(t) !== this._connKey;
    if (!t.enabled) {
      if (p.enabled) this._disconnect('off', 'The home camera is turned off.');
    } else if (reconnect) {
      this._connect('settings').catch(() => {});
    } else if (t.rtspPort !== p.rtspPort || t.stream !== p.stream) {
      this._restartVideo().catch(() => {});
    } else if (t.ptz !== p.ptz && this.ptzCtl) {
      this.ptzCtl.probe().then(() => this._statusSoon()).catch(() => {});
    }
    if (s.cameraEvents !== ps.cameraEvents) this._syncMonitor();
    if (s.clipsDir !== ps.clipsDir) this.store.scan().then(() => this._runRetention()).catch(() => {});
    if (s.retentionDays !== ps.retentionDays || s.maxStorageGB !== ps.maxStorageGB) this._runRetention();
    if (s.people !== ps.people || s.sensitivity !== ps.sensitivity) this._postArmed();
    this._statusSoon();
  }

  /** @param {string} state @param {string} detail */
  _setConn(state, detail) {
    if (this._conn.state === state && this._conn.detail === detail) return;
    this._conn = { state, detail };
    this._log('info', `[tapo] ${state}: ${detail}`);
    if (this._started) this._checkBlind(this._now());
    this._statusSoon();
  }

  /**
   * Turned off, or the password forgotten. The camera is let go of at once, but its client stays
   * open until the last Stop (a camera moving right now — switching it off is a natural panic
   * action) and the Unsubscribe have gone out, ≤ 3.5 s.
   * @param {string} state @param {string} detail @returns {Promise<void>} when the client is closed
   */
  _disconnect(state, detail) {
    this._gen++;
    this._connKey = '';
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    const ptz = this.ptzCtl;
    this.ptzCtl = null;
    const monitor = this.monitor;
    this.monitor = null;
    this._eventsState = 'off';
    const client = this.client;
    this.client = null;
    this.relay.stop();
    this._stopVideo();
    this._setConn(state, detail);
    const last = Promise.allSettled([ptz?.dispose(), monitor?.stop()]);
    return Promise.race([last, new Promise((r) => setTimeout(r, 3500))]).then(() => client?.close());
  }

  /** (Re)connect from scratch. @param {string} why */
  async _connect(why) {
    const gen = ++this._gen;
    this._connKey = connKey(this._tapo());
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._authFailed = false;
    this._videoAuthFailed = false;
    const old = this.ptzCtl;
    this.ptzCtl = null;
    await old?.dispose().catch(() => {});
    await this.monitor?.stop().catch(() => {});
    this.monitor = null;
    this.relay.stop();
    this.client?.close();
    this.client = null;
    const t = this._tapo();
    if (!t.enabled) return this._setConn('off', 'The home camera is turned off.');
    if (!t.host || !t.username) return this._setConn('not-configured', 'Enter the camera\'s address and its Camera Account in the setup.');
    if (!this._cred.hasPassword(t.host)) {
      return this._setConn('not-configured', this._cred.hasPassword() ? 'The saved password belongs to another camera address. Enter it again.' : 'Enter the Camera Account password in the setup.');
    }
    this._setConn('connecting', `Connecting to ${t.host}…`);
    this._log('debug', `[tapo] connect (${why})`);
    let ip;
    try {
      ip = (await (this._deps.resolveHost || resolveLanHost)(t.host, { allowLoopback: this._allowLoopback })).ip;
    } catch (err) {
      if (gen !== this._gen) return undefined;
      if (err instanceof HostError) return this._setConn('error', err.message);
      return this._scheduleRetry(gen, `The camera address could not be resolved (${/** @type {Error} */ (err).message}).`);
    }
    if (gen !== this._gen) return undefined;
    this._ip = ip;
    const client = (this._deps.createClient || ((/** @type {any} */ x) => new OnvifClient(x)))({
      host: ip, port: t.onvifPort, username: t.username, getPassword: () => this._cred.getPassword({ host: t.host }), log: this._log, now: this._now,
    });
    this.client = client;
    client.on('auth-failed', () => this._onAuthFailed());
    client.on('clock', () => this._statusSoon());
    try {
      await client.connect();
    } catch (err) {
      if (gen !== this._gen) return undefined;
      if (err instanceof OnvifError && err.kind === 'auth') return this._onAuthFailed();
      const unreachable = err instanceof OnvifError && ['timeout', 'reset', 'refused', 'unreachable'].includes(err.kind);
      return this._scheduleRetry(gen, unreachable ? `${t.host} does not answer on port ${t.onvifPort}. ${HINTS.unreachable}` : `The camera answered unexpectedly (${/** @type {Error} */ (err).message}).`);
    }
    if (gen !== this._gen) return undefined;
    this._attempt = 0;
    const ptz = new PtzController({ client, getSettings: () => this._tapo(), saveSettings: (p) => this._settings.update({ tapo: p }), log: this._log, now: this._now });
    ptz.on('moving', (moving, settleUntil) => {
      this._apply(this.engine.onPtz({ moving, settleUntil }));
      this._post({ t: 'ptz', moving, settleUntil: settleUntil || 0 });
      this._statusSoon();
    });
    for (const ev of ['position', 'privacy', 'caps']) ptz.on(ev, () => this._statusSoon());
    this.ptzCtl = ptz;
    await ptz.probe().catch((err) => this._log('info', `[tapo] PTZ probe: ${err.message}`));
    if (gen !== this._gen) return undefined;
    this._setConn('online', `Connected to ${client.device?.model || 'the camera'}.`);
    this._syncMonitor();
    await this._restartVideo();
    return undefined;
  }

  /** @param {number} gen @param {string} detail */
  _scheduleRetry(gen, detail) {
    if (gen !== this._gen) return;
    const delay = RETRY_DELAYS_MS[Math.min(this._attempt, RETRY_DELAYS_MS.length - 1)];
    this._attempt++;
    this._setConn('unreachable', `${detail} Trying again in ${Math.round(delay / 1000)} s.`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (gen === this._gen && this._tapo().enabled) this._connect('retry').catch(() => {});
    }, delay);
    this._retryTimer.unref?.();
  }

  _onAuthFailed() {
    if (this._authFailed) return;
    this._authFailed = true;
    this._gen++;
    this.monitor?.stop().catch(() => {});
    this.monitor = null;
    this.relay.stop();
    this._stopVideo();
    this._setConn('auth-failed', HINTS.auth);
  }

  _onVideoAuthFailed() {
    if (this._videoAuthFailed) return;
    this._videoAuthFailed = true;
    this.relay.stop();
    this._stopVideo();
    this._setConn('auth-failed', `The camera refused the video sign-in. ${HINTS.auth}`);
  }

  /**
   * go2rtc off, and with it the camera's RTSP session: the proxy ends whatever session is still
   * open with TEARDOWN (≤ 800 ms) before go2rtc is stopped.
   * @returns {Promise<void>}
   */
  _stopVideo() {
    return this._videoStep(async () => {
      await this.rtspProxy.stop().catch(() => {});
      await this.sidecar.stop().catch(() => {});
    });
  }

  /**
   * Starting and stopping the video take turns (a stop that is still sending its TEARDOWN must
   * not end the video started after it). @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  _videoStep(fn) {
    const run = this._videoChain.then(fn, fn);
    this._videoChain = run.then(() => {}, () => {});
    return run;
  }

  /** The camera's RTSP server asked for an unencrypted sign-in: no video until Retry. */
  _onVideoInsecure() {
    if (this._videoAuthFailed) return;
    this._videoAuthFailed = true;
    this.relay.stop();
    this._stopVideo();
    this._setConn('error', 'The camera asked for an unencrypted video sign-in, so the password was not sent. Check that the address belongs to your camera (something on the network may be answering in its place), then press Retry.');
  }

  /** (Re)start go2rtc with the current settings — only after ONVIF accepted the sign-in. */
  async _restartVideo() {
    if (!this.client || this._authFailed || this._videoAuthFailed || this._conn.state !== 'online') return;
    const t = this._tapo();
    const password = await this._cred.getPassword({ host: t.host });
    if (!password) return;
    const ip = this._ip;
    try {
      await this._videoStep(async () => {
        const src = await this.rtspProxy.start({ ip, port: t.rtspPort, username: t.username, password });
        await this.sidecar.start({ sourcePort: src.port, sourceToken: src.token, stream: t.stream });
      });
    } catch (err) {
      this._log('warn', `[tapo] video component: ${/** @type {Error} */ (err).message}`);
      this._statusSoon();
      return;
    }
    this.relay.kick();
    this._updateStream();
  }

  // -------------------------------------------------------------------------------------------
  // health (review: a camera that drops off mid-session was never shown as offline, and an armed
  // camera that stopped watching looked protected)

  /** Why an armed camera is not watching right now ('' when it is, or is not armed). */
  _blindWhy() {
    if (!this.engine.state.armed || !this._tapo().enabled) return '';
    if (this._conn.state !== 'online') return 'offline';
    if (this._streamWanted && this.relay.state !== 'live') return 'no-video';
    return '';
  }

  /**
   * 'yes', or why an armed camera is not watching (shown after BLIND_GRACE_MS; at once for a
   * camera that does not answer). Computed from the state now, not from the last health tick.
   */
  _watching() {
    const why = this._blindWhy();
    if (!why) return 'yes';
    if (why === 'offline' && ['unreachable', 'auth-failed', 'error', 'off', 'not-configured'].includes(this._conn.state)) return why;
    const since = this._blind.why ? this._blind.since : this._now();
    return this._now() - since >= BLIND_GRACE_MS ? why : 'yes';
  }

  /** Every HEALTH_EVERY_MS: is the camera still there, and is an armed camera watching? */
  _checkHealth() {
    if (!this._started) return;
    const now = this._now();
    const rs = this.relay.state;
    const videoDown = this._streamWanted && (rs === 'stalled' || rs === 'error');
    if (!videoDown) this._streamDownSince = 0;
    else if (!this._streamDownSince) this._streamDownSince = now;
    // the video gone for a while, or the camera's events failing: is the camera still there?
    const suspicious = (this._streamDownSince && now - this._streamDownSince >= PROBE_AFTER_MS) || this._eventsState === 'failing';
    if (suspicious && this._conn.state === 'online' && this.client && !this._probing && now - this._lastProbeAt >= PROBE_AFTER_MS) {
      this._lastProbeAt = now;
      this._probing = true;
      const gen = this._gen;
      const client = this.client;
      // GetSystemDateAndTime needs no sign-in (no lockout risk)
      client.syncClock().catch((err) => {
        if (gen !== this._gen || this.client !== client || this._conn.state !== 'online') return;
        if (err instanceof OnvifError && ['timeout', 'reset', 'refused', 'unreachable'].includes(err.kind)) this._lostCamera(gen);
      }).finally(() => { this._probing = false; });
    }
    this._checkBlind(now);
  }

  /** The camera stopped answering mid-session: offline, everything that talks to it stops, retry with backoff. @param {number} gen */
  _lostCamera(gen) {
    const t = this._tapo();
    this._log('warn', '[tapo] the camera stopped answering');
    this._scheduleRetry(gen, `${t.host} stopped answering. ${HINTS.unreachable}`);
    this._syncMonitor();
    this._updateStream();
  }

  /** Track how long an armed camera has not been watching; tell the user once after a minute. @param {number} now */
  _checkBlind(now) {
    const why = /** @type {''|'offline'|'no-video'} */ (this._blindWhy());
    const b = this._blind;
    // offline ↔ no video: still the same stretch without watching
    if (why !== b.why) this._blind = { why, since: why ? (b.why ? b.since : now) : 0, alerted: why ? b.alerted : false };
    const w = this._watching();
    if (w !== this._lastWatching) {
      this._lastWatching = w;
      this._statusSoon();
    }
    if (why && !this._blind.alerted && now - this._blind.since >= BLIND_ALERT_MS) {
      this._blind.alerted = true;
      this._troubleAlert(why);
    }
  }

  /** One notification and an avatar line: the armed camera stopped watching. @param {'offline'|'no-video'} why */
  _troubleAlert(why) {
    const name = this.cameraName();
    const s = this._sec();
    const quiet = inQuietHours(s.quietHours, this._now());
    const text = why === 'offline' ? `The ${name} stopped answering while armed: nothing is being watched.` : `The ${name} stopped sending video while armed: nothing is being recorded.`;
    this._log('warn', `[tapo] ${text}`);
    this._deps.alerts?.notifyTrouble?.({ title: `The ${name} is not watching`, body: `${text} Click to open the camera window.`, silent: quiet });
    const line = why === 'offline' ? `I lost the ${name}.` : `The ${name} stopped sending video.`;
    this.emit('alert', { id: `trouble-${this._now()}`, kind: 'trouble', at: this._now(), cameraName: name, line, quiet, describe: false }, { showAvatar: !quiet && s.showOnAlert !== false });
  }

  /** The PC woke up: the connection is stale, connect again at once. */
  onResume() {
    if (!this._started || !this._tapo().enabled) return;
    this._log('info', '[tapo] the PC woke up: reconnecting to the camera');
    this._attempt = 0;
    this._connect('resume').catch(() => {});
  }

  /**
   * The camera window's Retry: reconnect now (offline or a problem). A refused sign-in is not
   * retried here (camera lockouts): the user types the password again.
   */
  async retry() {
    const c = this._conn.state;
    if (c === 'auth-failed') return { ok: false, needsPassword: true };
    if (!['unreachable', 'error', 'connecting'].includes(c) && !this._videoAuthFailed && this.relay.state !== 'error') return { ok: true, connection: c };
    this.sidecar.resetFailures?.();
    this._attempt = 0;
    this._connect('retry').catch(() => {});
    return { ok: true, connection: 'connecting' };
  }

  /**
   * The redacted diagnostic report ("Copy diagnostic report"): the connection test, the probe's
   * read-only steps and the status. Never moves the camera.
   */
  async diagnostics() {
    const t = this._tapo();
    const password = (await this._cred.getPassword({ host: t.host })) || '';
    return diagnosticReport({
      host: t.host, onvifPort: t.onvifPort, rtspPort: t.rtspPort, username: t.username, password, allowLoopback: this._allowLoopback,
      status: this.status(), appVersion: this._appVersion, ptzSettings: () => this._tapo(), log: this._log, now: this._now, deps: this._deps,
    });
  }

  // -------------------------------------------------------------------------------------------
  // the stream (§2.3)

  streamNeeded() {
    if (!this._tapo().enabled || this._conn.state !== 'online' || this._videoAuthFailed) return false;
    const st = this.engine.state;
    return st.armed || this._viewVisible || this._calibrating || this._now() < this._snapshotUntil || this.recorder.recording;
  }

  _updateStream() {
    const needed = this.streamNeeded();
    this.relay.setNeeded(needed, needed ? 'needed' : 'idle');
    if (!needed && this._streamWanted) this._post({ t: 'idle' });
    this._streamWanted = needed;
    this._statusSoon();
  }

  /** @param {string} s */
  _onRelayState(s) {
    // no fresh frames: the pre-roll ring is history now (a clip of an event during the outage
    // must not be made of the minutes before it)
    if (s !== 'live') this.recorder.onStreamDown();
    this._apply(this.engine.onStream(s === 'live' ? 'live' : 'down'));
    this._statusSoon();
  }

  /** @param {any} s */
  _onSample(s) {
    this.recorder.onSample(s);
    if (!this._port) return;
    // flow control (only with a worker that acknowledges): behind → drop up to the next key frame
    const f = this._flow;
    if (f.acks) {
      const behind = f.seq - f.acked;
      if (behind > MAX_CHUNKS_BEHIND) f.skipping = true;
      if (f.skipping) {
        if (!s.key || behind > MAX_CHUNKS_BEHIND / 2) {
          f.dropped++;
          return;
        }
        f.skipping = false;
      }
    }
    const ts = this.relay.init?.timescale || 90000;
    // rx: when main received the sample (monotonic; the relay stamps it): the worker keeps it per
    // frame, so calibration uses only pictures that arrived after the camera's last move
    const rx = typeof s.rx === 'number' && Number.isFinite(s.rx) ? s.rx : this._mono();
    this._post({ t: 'chunk', seq: ++f.seq, gen: s.gen, key: s.key, ts: Math.round((s.pts * 1e6) / ts), dur: Math.round((s.duration * 1e6) / ts), rx, data: toArrayBuffer(s.data) });
  }

  /**
   * The camera window's canvas is visible (shown and not minimized). The worker is told too
   * ({ t: 'view' }): the page cannot see that its window is hidden (backgroundThrottling is off),
   * and a hidden window need not draw frames while an armed camera keeps decoding.
   * @param {boolean} visible
   */
  setViewVisible(visible) {
    const v = !!visible;
    const changed = v !== this._viewVisible;
    this._viewVisible = v;
    if (changed) this._post({ t: 'view', visible: v });
    this._updateStream();
  }

  // -------------------------------------------------------------------------------------------
  // the worker (camera window) over a MessagePort

  /**
   * Hand a new MessagePort to the camera window (its preload forwards it to the page, which
   * transfers it to the worker). A new port replaces the old one.
   * @param {any} webContents
   */
  attachWorker(webContents) {
    const MCM = this._deps.MessageChannelMain;
    if (!MCM || !webContents || webContents.isDestroyed?.()) return false;
    try { this._port?.close(); } catch { /* closed */ }
    const { port1, port2 } = new MCM();
    this._port = port1;
    this._flow = { seq: 0, acked: 0, acks: false, skipping: false, dropped: 0 };
    this._detector = 'loading';
    port1.on('message', (/** @type {any} */ e) => this._onWorkerMessage(port1, e.data));
    port1.on('close', () => {
      if (this._port !== port1) return;
      this._port = null;
      this._detector = 'off';
      this._statusSoon();
    });
    port1.start();
    webContents.postMessage('lm:tapo:port', null, [port2]);
    const a = this._deps.assets || { wasmBase: '', modelUrl: '' };
    this._post({ t: 'hello', detector: this._deps.detector === 'stub' ? 'stub' : 'mediapipe', wasmBase: a.wasmBase, modelUrl: a.modelUrl });
    this._postArmed();
    this._post({ t: 'view', visible: this._viewVisible });
    if (this.ptzCtl) this._post({ t: 'ptz', moving: this.ptzCtl.moving, settleUntil: this.ptzCtl.settleUntil });
    const init = this.relay.init;
    if (init && this.relay.state === 'live') this._post({ t: 'config', gen: this.relay.gen, codec: init.codec, description: toArrayBuffer(init.description), width: init.width, height: init.height });
    else if (!this.streamNeeded()) this._post({ t: 'idle' });
    this._statusSoon();
    return true;
  }

  /** @param {object} msg */
  _post(msg) {
    if (!this._port) return;
    try {
      this._port.postMessage(msg);
    } catch (err) {
      this._log('debug', `[tapo] worker port: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * The worker's duty cycle. It runs from the moment the user arms (the exit delay included), so
   * the local detector is known to be alive — and has samples — when watching starts; the engine
   * only counts evidence from then on.
   */
  _postArmed() {
    const s = this._sec();
    this._post({ t: 'armed', on: this.engine.state.armed, people: s.people !== false, sensitivity: s.sensitivity });
  }

  /** @param {any} port @param {any} raw */
  _onWorkerMessage(port, raw) {
    if (port !== this._port) return;
    const m = validateWorkerMessage(raw);
    if (!m) {
      const what = typeof raw?.t === 'string' ? raw.t.slice(0, 20) : raw && typeof raw === 'object' ? `fields: ${Object.keys(raw).slice(0, 6).join(', ') || 'none'}` : typeof raw;
      this._log('debug', `[tapo] dropped an invalid worker message (${what})`);
      return;
    }
    switch (m.t) {
      case 'ready':
        this._detector = m.detector;
        if (m.error) this._log('warn', `[tapo] detector: ${m.error}`);
        this._statusSoon();
        return;
      case 'det': {
        const now = this._now();
        this._detTimes = this._detTimes.filter((x) => now - x < 1000);
        if (this._detTimes.length >= DET_PER_SEC) return; // over the rate: dropped
        this._detTimes.push(now);
        // persons only from a detector run (the motion samples in between say nothing about people)
        this._apply(this.engine.onLocal({ at: now, motion: m.motion, persons: m.detected ? m.persons : undefined, detector: this._detector === 'stub' ? 'on' : this._detector }));
        return;
      }
      case 'snap-ok':
      case 'snap-err':
      case 'shift-ref-ok':
      case 'shift': {
        const p = this._pending.get(m.id);
        if (!p) return;
        this._pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.t === 'snap-err') p.reject(new Error(m.message || 'No picture.'));
        else p.resolve(m);
        return;
      }
      case 'stats':
        this._workerStats = m;
        this._statusSoon();
        return;
      case 'ack':
        // the newest chunk the worker has handled (it can only move forward)
        this._flow.acks = true;
        if (m.seq <= this._flow.seq) this._flow.acked = Math.max(this._flow.acked, m.seq);
        return;
      case 'error':
        this._log(m.fatal ? 'warn' : 'debug', `[tapo] worker: ${m.message}`);
        if (m.fatal) this._detector = 'failed';
        this._statusSoon();
        return;
      default:
    }
  }

  /** @param {object} msg @param {number} timeoutMs @returns {Promise<any>} */
  _request(msg, timeoutMs) {
    if (!this._port) return Promise.reject(new Error('The camera window is not running, so there is no picture.'));
    const id = `r${++this._reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('The camera picture did not arrive in time.'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._post({ ...msg, id });
    });
  }

  /** Wait until the stream is live (it is turned on for snapshots). @param {number} timeoutMs */
  async _waitLive(timeoutMs) {
    const until = this._now() + timeoutMs;
    while (this.relay.state !== 'live' && this._now() < until) await new Promise((r) => setTimeout(r, 100));
    return this.relay.state === 'live';
  }

  /**
   * A JPEG of the live picture (MCP camera_snapshot, alerts). Turns the stream on for up to 30 s.
   * @param {{ maxSide?: number, quality?: number }} [o]
   * @returns {Promise<{ mediaType: 'image/jpeg', data: string, width: number, height: number, at: number, jpeg: Buffer }>}
   */
  async snapshot(o = {}) {
    if (this._conn.state !== 'online') throw new Error('The camera is not connected right now.');
    if (!this._port) throw new Error('The camera window is not running, so there is no picture.');
    this._snapshotUntil = this._now() + SNAPSHOT_STREAM_MS;
    this._updateStream();
    const t = setTimeout(() => this._updateStream(), SNAPSHOT_STREAM_MS + 50);
    t.unref?.();
    if (!(await this._waitLive(8000))) throw new Error('No picture from the camera right now.');
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await this._request({ t: 'snap', maxSide: o.maxSide ?? 640, quality: o.quality ?? 0.75 }, 6000);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((res) => setTimeout(res, 700)); // no decoded frame yet
      }
    }
    return { mediaType: 'image/jpeg', data: r.jpeg.toString('base64'), width: r.width, height: r.height, at: this._now(), jpeg: r.jpeg };
  }

  // -------------------------------------------------------------------------------------------
  // calibration

  _ptzOrThrow() {
    if (!this.ptzCtl) throw new Error('Pan and tilt are not available.');
    return this.ptzCtl;
  }

  _calibrationBlocker() {
    if (this._conn.state !== 'online') return 'The camera must be online to calibrate.';
    if (!this.ptzCtl || !this.ptzCtl.caps.available) return 'This camera does not offer pan and tilt over ONVIF, so there is nothing to calibrate.';
    if (this.ptzCtl.privacySuspected) return PRIVACY_HINT;
    if (!this._port) return 'Open the camera window to calibrate (it needs the live picture).';
    return null;
  }

  /**
   * The calibration's reference picture, from frames that reached main after `after` (main's
   * monotonic clock: when the camera's last move ended). The worker answers once it has a still
   * one, and the camera moves only then. Only a gated answer with a reference counts: a timeout,
   * the worker's "none" or an older worker's bare answer (which says nothing about how current its
   * picture is) are no reference, and the wizard does not measure against nothing.
   * @param {number} [after]
   * @returns {Promise<{ ok: true, at: number, still: boolean } | { ok: false, reason: string }>}
   */
  async _shiftRef(after) {
    this._calibrating = true;
    this._updateStream();
    if (!(await this._waitLive(10000))) throw new Error('No live picture, so the camera cannot be calibrated.');
    await new Promise((r) => setTimeout(r, 300));
    const gate = typeof after === 'number' && Number.isFinite(after) ? after : this._mono();
    let r;
    try {
      r = await this._request({ t: 'shift-ref', after: gate }, this._shiftRefTimeoutMs);
    } catch (err) {
      return { ok: false, reason: /** @type {Error} */ (err).message };
    }
    if (r.gated !== true) return { ok: false, reason: 'the camera window is out of date and cannot say how current its picture is; restart the app' };
    if (r.ok !== true || typeof r.at !== 'number' || !(r.at > gate)) return { ok: false, reason: 'no picture arrived after the camera\'s last move' };
    return { ok: true, at: r.at, still: r.still === true };
  }

  /**
   * The worker's picture shift, measured on frames that reached main after `after` (the end of
   * the move). A worker that answers too late (a busy PC: its frames queue up) is "not
   * measurable", and so is an answer without the gate (an older worker or page: its picture may be
   * from before the move): score 0, so the wizard asks the user instead of trusting it.
   * @param {number} timeoutMs @param {boolean} [expectMove] @param {number} [after]
   * @returns {Promise<{ dx: number, dy: number, score: number, settledMs: number, at?: number, refAt?: number, moved?: boolean, frames?: number }>}
   */
  async _shiftMeasure(timeoutMs, expectMove = false, after = undefined) {
    if (!this._port) throw new Error('The camera window is not running, so there is no picture.');
    const gate = typeof after === 'number' && Number.isFinite(after) ? after : this._mono();
    try {
      const r = await this._request({ t: 'shift-measure', timeoutMs, expectMove, after: gate }, timeoutMs + this._shiftSlackMs);
      if (r.gated !== true) {
        this._log('warn', '[tapo] calibration: the camera window\'s measurement does not say how current its picture is (an older version): not used');
        return { dx: r.dx, dy: r.dy, score: 0, settledMs: r.settledMs };
      }
      return {
        dx: r.dx, dy: r.dy, score: r.score, settledMs: r.settledMs, moved: r.moved, frames: r.frames,
        ...(typeof r.at === 'number' ? { at: r.at } : {}), ...(typeof r.refAt === 'number' ? { refAt: r.refAt } : {}),
      };
    } catch (err) {
      this._log('info', `[tapo] calibration: no picture measurement (${/** @type {Error} */ (err).message})`);
      return { dx: 0, dy: 0, score: 0, settledMs: 0 };
    }
  }

  /** @param {{ action: 'start'|'answer'|'cancel', answer?: string }} req */
  calibrate(req) {
    return this.calibration.request(req);
  }

  // -------------------------------------------------------------------------------------------
  // the security engine's actions

  _syncTick() {
    const want = this.engine.state.armed || !!this.engine.state.active;
    if (want && !this._tick) {
      this._tick = setInterval(() => this._apply(this.engine.tick(this._now())), TICK_MS);
      this._tick.unref?.();
    } else if (!want && this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  }

  _syncMonitor() {
    const want = this._conn.state === 'online' && this.engine.state.armed && this._sec().cameraEvents && this.client && !this._authFailed;
    if (want && !this.monitor) {
      const m = new PullPointMonitor({ client: /** @type {any} */ (this.client), log: this._log, now: this._now });
      m.on('state', (/** @type {string} */ s) => {
        this._eventsState = s;
        this._statusSoon();
      });
      m.on('topics', (/** @type {string[]} */ t) => {
        this._topics = t;
        this._statusSoon();
      });
      m.on('event', (/** @type {any} */ e) => this._apply(this.engine.onCamera(e)));
      this.monitor = m;
      m.start().catch(() => {});
    } else if (!want && this.monitor) {
      const m = this.monitor;
      this.monitor = null;
      this._eventsState = 'off';
      m.stop().catch(() => {});
    }
  }

  /** @param {import('./security-engine.js').Action[]} actions */
  _apply(actions) {
    if (!actions || !actions.length) return;
    const describeIds = new Set(actions.filter((a) => a.type === 'describe').map((a) => /** @type {any} */ (a).event.id));
    for (const a of actions) {
      try {
        this._act(a, describeIds);
      } catch (err) {
        this._log('warn', `[tapo] ${a.type}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  /** @param {any} a @param {Set<string>} describeIds */
  _act(a, describeIds) {
    switch (a.type) {
      case 'armed-changed': {
        const s = this._sec();
        if (s.armed !== a.armed) this._settings.update({ security: { armed: a.armed } });
        this._postArmed();
        this._syncTick();
        this._syncMonitor();
        this._updateStream();
        if (!a.armed) this.ptzCtl?.stopAll('disarm').catch(() => {});
        this._statusSoon();
        return;
      }
      case 'event-start': {
        this._eventKinds.set(a.event.id, a.event.kind);
        // a motion that may turn out to be a person: its clip then starts preRollSec before the
        // event, not before the upgrade (released by record-start / event-end)
        this.recorder.holdPreRoll(true);
        const pos = this.ptzCtl?.position || null;
        this.store.upsert({ ...this._record(a.event), base: eventBase(a.event.id, a.event.kind), ptz: pos }).catch(() => {});
        this.emit('security-event', { phase: 'start', event: this._withUrls(a.event) });
        this._syncTick();
        this._statusSoon();
        return;
      }
      case 'event-update':
        this.store.upsert(this._record(a.event)).catch(() => {});
        this.emit('security-event', { phase: 'update', event: this._withUrls(a.event) });
        this._statusSoon();
        return;
      case 'event-end': {
        const ev = a.event;
        const durationSec = Math.round(((ev.endedAt - ev.startedAt) / 1000) * 10) / 10;
        this.store.upsert({ ...this._record(ev), durationSec }).catch(() => {});
        // (the list row and the player show the duration: review)
        this.emit('security-event', { phase: 'end', event: { ...this._withUrls(ev), durationSec } });
        this.recorder.holdPreRoll(false);
        this._alertSnaps.delete(ev.id);
        this._syncTick();
        this._statusSoon();
        return;
      }
      case 'record-start': {
        const kind = /** @type {any} */ (this._eventKinds.get(a.eventId) || 'motion');
        if (!this.recorder.start(a.eventId, { kind })) this._log('info', '[tapo] no clip: the stream is not running');
        this.recorder.holdPreRoll(false);
        this._updateStream();
        return;
      }
      case 'record-stop':
        this.recorder.stop(a.eventId, { reason: 'event end' }).then(() => {
          this._updateStream();
          this._runRetention();
        }).catch(() => {});
        return;
      case 'record-extend':
        this.recorder.extend(a.eventId);
        return;
      case 'snapshot':
        this._eventSnapshot(a.eventId, a.purpose);
        return;
      case 'boost':
        this._post({ t: 'boost', untilMs: a.untilMs });
        return;
      case 'notify':
        this._notify(a.event, a.silent).catch(() => {});
        return;
      case 'announce':
        this._announce(a.event, a.quiet, describeIds.has(a.event.id)).catch(() => {});
        return;
      case 'describe':
        // with an announcement it rides along; on its own it is a quiet alert with a picture
        if (!this._sec().announce) this._announce(a.event, true, true).catch(() => {});
        return;
      default:
    }
  }

  /** The EventRecord fields from an engine summary. @param {any} e */
  _record(e) {
    /** @type {any} */
    const r = {
      id: e.id, camera: this.cameraName(), kind: e.kind, startedAt: iso(e.startedAt), sources: e.sources, unconfirmed: !!e.unconfirmed,
      notified: !!e.notified, announced: !!e.announced,
    };
    if (e.endedAt) r.endedAt = iso(e.endedAt);
    if (typeof e.maxScore === 'number') r.maxScore = e.maxScore;
    return r;
  }

  /** The engine summary + the clip/snapshot URLs the store knows. @param {any} e */
  _withUrls(e) {
    const rec = this.store.get(e.id);
    return rec ? { ...toSummary(rec), ...e, ...(rec.clip ? { clipUrl: toSummary(rec).clipUrl } : {}), ...(rec.snapshot ? { snapshotUrl: toSummary(rec).snapshotUrl } : {}) } : e;
  }

  /** @param {{ id: string, rel: string }} c */
  _onClipStart(c) {
    const rec = this.store.get(c.id);
    const clips = [...new Set([...(rec?.clips || []), c.rel])];
    this.store.upsert({ id: c.id, clip: rec?.clip || c.rel, clips }).catch(() => {});
    this._statusSoon();
  }

  /** @param {any} c */
  _onClipEnd(c) {
    if (c.empty) {
      const rec = this.store.get(c.id);
      if (rec) {
        const clips = (rec.clips || []).filter((x) => x !== c.rel);
        this.store.upsert({ id: c.id, clips, clip: clips[0] || undefined }).catch(() => {});
      }
      return;
    }
    const rec = this.store.get(c.id);
    const bytes = (rec?.bytes || 0) + c.bytes;
    this.store.upsert({ id: c.id, bytes }).catch(() => {});
    // the clip usually finishes after its event ended: that is no new "update" of a live event
    // (which the camera window would toast as "seen just now" again)
    const live = this.engine.state.active?.id === c.id;
    this.emit('security-event', { phase: live ? 'update' : 'end', event: { ...this._withUrls(rec ? toSummary(rec) : { id: c.id }), bytes } });
    this._statusSoon();
  }

  /** @param {string} id @param {'best'|'alert'} purpose */
  _eventSnapshot(id, purpose) {
    const p = (async () => {
      try {
        // the worker's newest frame is from before the outage while the stream is down
        if (this.relay.state !== 'live') throw new Error('no live picture');
        const snap = await this._request({ t: 'snap', maxSide: 1280, quality: 0.8 }, 3000);
        return await this.store.writeSnapshot(id, snap.jpeg);
      } catch (err) {
        this._log('debug', `[tapo] event snapshot (${purpose}): ${/** @type {Error} */ (err).message}`);
        return null;
      }
    })();
    if (purpose === 'alert' && !this._alertSnaps.has(id)) this._alertSnaps.set(id, p);
    return p;
  }

  /** @param {any} event @param {boolean} silent */
  async _notify(event, silent) {
    const snap = this._alertSnaps.get(event.id);
    const file = snap ? await Promise.race([snap, new Promise((r) => setTimeout(() => r(null), 1500))]) : null;
    this._deps.alerts?.notify({ event, cameraName: this.cameraName(), snapshotPath: file, silent });
    this.store.upsert({ id: event.id, notified: true }).catch(() => {});
  }

  /** @param {any} event @param {boolean} quiet @param {boolean} describe */
  async _announce(event, quiet, describe) {
    let snapshot = null;
    if (describe) {
      try {
        const s = await this.snapshot({ maxSide: 640 });
        snapshot = { mediaType: /** @type {'image/jpeg'} */ ('image/jpeg'), data: s.data };
      } catch (err) {
        this._log('info', `[tapo] no picture to describe: ${/** @type {Error} */ (err).message}`);
      }
    }
    const alert = buildAvatarAlert({ event, cameraName: this.cameraName(), quiet, describe, snapshot });
    this.emit('alert', alert, { showAvatar: !quiet && this._sec().showOnAlert !== false });
    if (!quiet) this.store.upsert({ id: event.id, announced: true }).catch(() => {});
  }

  /** @param {string} msg */
  _warn(msg) {
    this._warnings = [...this._warnings.filter((w) => w !== msg).slice(-2), msg];
    this._statusSoon();
  }

  _runRetention() {
    const keep = new Set();
    const active = this.recorder.activeBase;
    if (active) keep.add(active);
    const ev = this.engine.state.active;
    if (ev) keep.add(eventBase(ev.id, /** @type {any} */ (this._eventKinds.get(ev.id) || ev.kind)));
    const s = this._sec();
    runRetention({ dir: this.clipsDir(), settings: s, log: this._log, keep, now: this._now() }).then((r) => {
      this._storage = { bytes: r.bytes, clips: r.clips };
      if (r.deleted.length) this.store.scan().catch(() => {});
      this._statusSoon();
    }).catch((err) => this._log('warn', `[tapo] retention: ${err.message}`));
  }

  // -------------------------------------------------------------------------------------------
  // the IPC surface

  /** @param {{ username: string, password: string }} c */
  async setCredentials(c) {
    validatePassword(c.password);
    const t = this._tapo();
    const r = await this._cred.setPassword(c.password, { host: t.host || undefined });
    if (c.username !== t.username) this._settings.update({ tapo: { username: c.username } });
    this.client?.resetAuth();
    this.sidecar.resetFailures?.();
    if (this._tapo().enabled) this._connect('credentials').catch(() => {});
    return { ok: true, persistence: r.persisted ? 'encrypted' : 'memory' };
  }

  async clearCredentials() {
    // the last Stop/Unsubscribe still need the password: let go of the camera first
    await this._disconnect('not-configured', 'Enter the Camera Account password in the setup.');
    await this._cred.clear();
    this._statusSoon();
    return { ok: true };
  }

  /** @param {import('./ptz.js').PtzCommand} cmd @returns {Promise<import('./ptz.js').PtzResult>} */
  async ptz(cmd) {
    if (!this._tapo().enabled) return { ok: false, code: 'not-configured', error: 'The home camera is turned off.' };
    if (this._authFailed) return { ok: false, code: 'auth', error: HINTS.auth };
    if (!this.ptzCtl) return { ok: false, code: this.configured() ? 'offline' : 'not-configured', error: this.configured() ? 'The camera is not connected.' : 'Set up the camera first.' };
    return this.ptzCtl.command(cmd);
  }

  /** The window lost focus or its renderer went away: end a press-and-hold. @param {string} why */
  stopHold(why) {
    if (this.ptzCtl?.holding) this.ptzCtl.stopAll(why).catch(() => {});
  }

  /** @param {number} timeoutMs */
  waitPtzIdle(timeoutMs) {
    return this.ptzCtl ? this.ptzCtl.waitIdle(timeoutMs, { settle: true }) : Promise.resolve(true);
  }

  /** @param {{ refresh?: boolean }} [o] */
  async presets(o = {}) {
    return this.ptzCtl ? this.ptzCtl.presets(o) : [];
  }

  /** @param {{ name: string, token?: string }} o */
  async savePreset(o) {
    if (!this.ptzCtl) return { ok: false, error: 'The camera is not connected.' };
    return this.ptzCtl.savePreset(o.name, o.token);
  }

  /** @param {{ token: string }} o */
  async removePreset(o) {
    if (!this.ptzCtl) return { ok: false, error: 'The camera is not connected.' };
    return this.ptzCtl.removePreset(o.token);
  }

  /** @param {{ armed: boolean, immediate?: boolean }} o */
  arm(o) {
    if (o.armed && !this._tapo().enabled) throw new Error('Turn the home camera on first.');
    this._apply(this.engine.arm(o.armed, { immediate: !!o.immediate }));
    const st = this.engine.state;
    return st.arming ? { armed: st.armed, arming: true, armingEndsAt: st.armingEndsAt } : { armed: st.armed, arming: false };
  }

  /** @param {{ beforeMs?: number, sinceMs?: number, kinds?: string[], limit?: number }} [q] */
  listEvents(q = {}) {
    return this.store.list(q);
  }

  /** @param {string} id */
  async removeEvent(id) {
    if (this.recorder.eventId === id || this.engine.state.active?.id === id) return { ok: false, error: 'This event is still going on.' };
    return { ok: await this.store.remove(id) };
  }

  /** @param {string} id */
  async ackEvent(id) {
    return { ok: await this.store.ack(id) };
  }

  async openClips() {
    const dir = this.clipsDir();
    try {
      nodeFs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, path: dir, error: `The clips folder could not be created: ${/** @type {Error} */ (err).message}` };
    }
    const err = this._deps.openPath ? await this._deps.openPath(dir) : '';
    return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
  }

  discover() {
    return (this._deps.discover || discover)({ timeoutMs: 3000, allowLoopback: this._allowLoopback, log: this._log });
  }

  /**
   * The connection test (§8.11): every step, with unsaved values allowed. Stops at a failed
   * sign-in (never retries it). A passing test reconnects a failed connection.
   * @param {{ host?: string, onvifPort?: number, rtspPort?: number, username?: string, password?: string }} [ov]
   */
  async test(ov = {}) {
    const t = this._tapo();
    const report = await connectionTest({
      host: ov.host ?? t.host,
      onvifPort: ov.onvifPort ?? t.onvifPort,
      rtspPort: ov.rtspPort ?? t.rtspPort,
      username: ov.username ?? t.username,
      getPassword: async (host) => ov.password ?? (await this._cred.getPassword({ host })),
      allowLoopback: this._allowLoopback,
      ptzSettings: () => this._tapo(),
      log: this._log,
      now: this._now,
      deps: this._deps,
    });
    // a working sign-in fixes a failed connection (this is the Retry)
    if (report.steps.find((/** @type {any} */ x) => x.id === 'auth')?.ok && !ov.password && ['auth-failed', 'unreachable', 'error'].includes(this._conn.state)) {
      this._connect('test passed').catch(() => {});
    }
    return report;
  }

  // -------------------------------------------------------------------------------------------
  // Claude

  _mcpAdapter() {
    return {
      status: () => this.status(),
      presets: (/** @type {any} */ o) => this.presets(o),
      ptz: (/** @type {any} */ c) => this.ptz(c),
      waitPtzIdle: (/** @type {number} */ ms) => this.waitPtzIdle(ms),
      snapshot: async (/** @type {any} */ o) => {
        const s = await this.snapshot(o);
        return { mediaType: s.mediaType, data: s.data, width: s.width, height: s.height, at: s.at };
      },
      listEvents: (/** @type {any} */ q) => this.listEvents(q),
      // Claude can arm (with the exit delay), never disarm
      arm: () => this.arm({ armed: true, immediate: false }),
    };
  }

  /** The in-process MCP server (G1) with its loopback HTTP fallback (G2). */
  mcpServer() {
    return {
      name: SERVER_NAME,
      handle: (/** @type {object} */ m) => this._mcp.handle(m),
      startHttp: () => this._mcpHttp.start(),
      stopHttp: () => this._mcpHttp.stop(),
    };
  }

  /** Pre-approved / refused camera tools (§10.2). */
  toolPermissions() {
    if (!this._tapo().enabled || !this.configured()) return { allow: [], deny: [] };
    const s = this._sec();
    const allow = [qualifiedToolName('camera_status'), qualifiedToolName('camera_events')];
    const deny = [];
    if (s.claudeSee === 'always') allow.push(qualifiedToolName('camera_snapshot'));
    if (s.claudeSee === 'never') deny.push(qualifiedToolName('camera_snapshot'));
    // turning an ARMED camera away from its view always shows a card (it would stop watching it)
    if (s.claudeMove === 'always' && !this.engine.state.armed) allow.push(qualifiedToolName('camera_look'));
    if (s.claudeMove === 'never') deny.push(qualifiedToolName('camera_look'));
    return { allow, deny };
  }

  personaContext() {
    if (!this._tapo().enabled || !this.configured()) return {};
    const s = this._sec();
    return { camera: { name: this.cameraName(), canSee: s.claudeSee !== 'never', canMove: s.claudeMove !== 'never' } };
  }

  // -------------------------------------------------------------------------------------------
  // status

  _statusSoon() {
    if (this._statusTimer) return;
    const wait = Math.max(0, STATUS_MIN_MS - (this._now() - this._lastStatusAt));
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this._lastStatusAt = this._now();
      this.emit('status', this.status());
    }, wait);
    this._statusTimer.unref?.();
  }

  /** @returns {any} TapoStatus (§6.3) */
  status() {
    const t = this._tapo();
    const s = this._sec();
    const g = this.sidecar.info();
    const rs = this.relay.stats();
    const ptz = this.ptzCtl;
    const caps = ptz?.caps || noCaps();
    const eng = this.engine.state;
    const counts = this.store.counts();
    const c = this.client;
    const watching = this._watching();
    /** @type {any} */
    const st = {
      enabled: !!t.enabled,
      configured: this.configured(),
      hasPassword: this._cred.hasPassword(t.host || undefined),
      persistence: this._cred.hasPassword() ? this._cred.persistence : 'none',
      name: this.cameraName(),
      host: t.host,
      connection: this._conn.state,
      detail: this._conn.detail,
      go2rtc: { state: g.state, ...(g.detail ? { detail: g.detail } : {}) },
      stream: { state: this.relay.state, ...(this.relay.detail && this.relay.state !== 'live' ? { detail: this.relay.detail } : {}) },
      ptz: {
        available: !!caps.available, mode: caps.mode, moving: !!ptz?.moving, canStatus: caps.canStatus, canAbsolute: caps.canAbsolute,
        canSetPreset: caps.canSetPreset, position: ptz?.position || null, privacySuspected: !!ptz?.privacySuspected, calibrated: !!t.calibratedAt,
      },
      events: { onvif: this._eventsState, topics: this._topics },
      detector: { state: this._detector, ...(this._workerStats?.detectorHz ? { rateHz: this._workerStats.detectorHz } : {}), ...(this._workerStats?.detectorMs ? { lastMs: this._workerStats.detectorMs } : {}) },
      security: {
        armed: eng.armed, arming: eng.arming, ...(eng.arming ? { armingEndsAt: eng.armingEndsAt } : {}),
        active: eng.active ? this._withUrls(eng.active) : null, recording: this.recorder.recording, todayCount: counts.todayCount,
        ...(counts.lastEventAt ? { lastEventAt: counts.lastEventAt } : {}),
        storage: { bytes: this._storage.bytes, clips: this._storage.clips, dir: this.clipsDir() }, warnings: [...this._warnings],
        // armed but not watching: 'offline' (the camera does not answer) or 'no-video'
        watching,
        ...(watching !== 'yes' ? { notWatchingSince: this._blind.since || this._now() } : {}),
      },
    };
    if (c?.device) st.device = { manufacturer: c.device.manufacturer, model: c.device.model, firmware: c.device.firmware, hardwareId: c.device.hardwareId };
    if (c?.clock) st.clock = { offsetSec: Math.round(c.clock.offsetMs / 1000), ntp: c.clock.ntp, warn: c.clock.warn };
    if (this.relay.state !== 'off') {
      Object.assign(st.stream, {
        ...(rs.codec ? { codec: rs.codec } : {}), ...(rs.width ? { width: rs.width, height: rs.height } : {}), fps: rs.fps, kbps: rs.kbps,
        ...(rs.keyIntervalSec ? { keyIntervalSec: rs.keyIntervalSec } : {}), ...(rs.lastFrameAgoMs !== null ? { lastFrameAgoMs: rs.lastFrameAgoMs } : {}),
      });
    }
    if (s.cameraEvents === false) st.events.onvif = 'off';
    return st;
  }

  /** The worker's last stats (e2e). */
  workerStats() {
    return this._workerStats ? { ...this._workerStats } : null;
  }
}

/** Default clips folder: <Videos>/Lawnmower Man/Security. @param {string} videosDir */
export function defaultClipsDir(videosDir) {
  return path.join(videosDir, 'Lawnmower Man', 'Security');
}
