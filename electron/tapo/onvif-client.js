// OnvifClient: one camera's ONVIF services over hand-written SOAP (contract §8.3). Pure Node.
//
// Rules that protect the camera (and the user from a lockout):
//  * Control calls go through ONE serialized queue (Tapo answers overlapping requests with 401s);
//    a Stop jumps the queue. The PullPoint loop has its own single in-flight lane, so at most two
//    requests are open at once.
//  * The WS-Security `Created` stamp follows the CAMERA's clock (GetSystemDateAndTime, re-read
//    every 10 minutes and once after a sign-in fault). The camera clock is never written.
//  * A sign-in that still fails after that one resync marks the client `authFailed`: every later
//    call fails at once, without touching the network, until resetAuth() (new credentials or
//    host, or the user pressing Retry). Failed logins can lock an IP out on Tapo cameras.
//  * XAddrs the camera reports are rewritten to the configured host and port (firmwares report
//    names the LAN cannot resolve); the PTZ and Events addresses come from their own sections of
//    GetCapabilities, never from the first XAddr in the document (that is Analytics on Tapo).

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { ACTIONS, BODIES, OnvifError, envelope, parseSoapResponse, postSoap, wsseHeader } from './onvif-soap.js';
import { child, children, findAll, path, textOf, toNumber } from './xml.js';
import { hostPort } from './host.js';

export const RESYNC_MS = 10 * 60 * 1000;
export const CLOCK_WARN_MS = 5000;
/** A clock read this recently cannot explain a refused sign-in (no resync-and-retry then). */
export const FRESH_CLOCK_MS = 60_000;

const NS_MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const NS_PTZ = 'http://www.onvif.org/ver20/ptz/wsdl';
const NS_EVENTS = 'http://www.onvif.org/ver10/events/wsdl';

/**
 * @typedef {{ manufacturer: string, model: string, firmware: string, serialNumber: string, hardwareId: string }} DeviceInfo
 * @typedef {{ x: { min: number, max: number }, y: { min: number, max: number } }} Ranges
 * @typedef {{ token: string, name: string, encoding: string, width: number|null, height: number|null, fps: number|null,
 *             ptzConfigToken: string|null, relativeSpace: string|null, continuousSpace: string|null, ranges: Ranges|null }} Profile
 * @typedef {{ token: string, name: string, position: { x: number, y: number }|null }} CameraPreset
 * @typedef {{ topic: string, utcTime: string, operation: string, data: Record<string, string> }} Notification
 */

/** A FIFO of async jobs, one at a time; `front` puts a job first (Stop). */
export class SerialQueue {
  constructor() {
    /** @type {Array<{ fn: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void }>} */
    this._jobs = [];
    this._running = false;
  }

  get busy() {
    return this._running;
  }

  get length() {
    return this._jobs.length;
  }

  /** @template T @param {() => Promise<T>} fn @param {{ front?: boolean }} [o] @returns {Promise<T>} */
  run(fn, o = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject };
      if (o.front) this._jobs.unshift(job);
      else this._jobs.push(job);
      this._pump();
    });
  }

  /** Reject every job that has not started. @param {Error} err */
  clear(err) {
    const jobs = this._jobs.splice(0);
    for (const j of jobs) j.reject(err);
  }

  _pump() {
    if (this._running) return;
    const job = this._jobs.shift();
    if (!job) return;
    this._running = true;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this._running = false;
        this._pump();
      });
  }
}

/**
 * Keep the path and query of an address the camera reported, on the configured host and port.
 * @param {string|null|undefined} xaddr @param {string} host @param {number} port
 * @returns {string|null}
 */
export function rewriteXaddr(xaddr, host, port) {
  if (!xaddr) return null;
  try {
    const u = new URL(String(xaddr).trim().split(/\s+/)[0]);
    return `http://${hostPort(host, port)}${u.pathname || '/'}${u.search}`;
  } catch {
    return null;
  }
}

/** @param {import('./xml.js').XmlNode|null} r @returns {{ min: number, max: number }|null} */
function range(r) {
  const min = toNumber(textOf(r, 'Min'));
  const max = toNumber(textOf(r, 'Max'));
  return min !== null && max !== null && max > min ? { min, max } : null;
}

/** @param {import('./xml.js').XmlNode|null} space @returns {Ranges|null} */
function ranges(space) {
  const x = range(child(space, 'XRange'));
  const y = range(child(space, 'YRange'));
  return x && y ? { x, y } : null;
}

/** @param {import('./xml.js').XmlNode} resp @returns {{ cameraUtcMs: number|null, ntp: boolean|null }} */
export function parseSystemDateAndTime(resp) {
  const sdt = child(resp, 'SystemDateAndTime');
  const type = textOf(sdt, 'DateTimeType');
  const ntp = type === 'NTP' ? true : type === 'Manual' ? false : null;
  const utc = child(sdt, 'UTCDateTime');
  const n = (/** @type {string} */ p) => toNumber(textOf(utc, p));
  const y = n('Date/Year');
  const mo = n('Date/Month');
  const d = n('Date/Day');
  const h = n('Time/Hour');
  const mi = n('Time/Minute');
  const s = n('Time/Second');
  if ([y, mo, d, h, mi, s].some((v) => v === null)) return { cameraUtcMs: null, ntp };
  const ms = Date.UTC(/** @type {number} */ (y), /** @type {number} */ (mo) - 1, /** @type {number} */ (d), /** @type {number} */ (h), /** @type {number} */ (mi), /** @type {number} */ (s));
  return { cameraUtcMs: Number.isFinite(ms) ? ms : null, ntp };
}

/** @param {import('./xml.js').XmlNode} resp @returns {Profile[]} */
export function parseProfiles(resp) {
  return children(resp, 'Profiles').map((p) => {
    const enc = child(p, 'VideoEncoderConfiguration');
    const ptz = child(p, 'PTZConfiguration');
    return {
      token: p.attrs.token || '',
      name: textOf(p, 'Name') || '',
      encoding: (textOf(enc, 'Encoding') || '').toUpperCase(),
      width: toNumber(textOf(enc, 'Resolution/Width')),
      height: toNumber(textOf(enc, 'Resolution/Height')),
      fps: toNumber(textOf(enc, 'RateControl/FrameRateLimit')),
      ptzConfigToken: ptz ? ptz.attrs.token || '' : null,
      relativeSpace: ptz ? textOf(ptz, 'DefaultRelativePanTiltTranslationSpace') : null,
      continuousSpace: ptz ? textOf(ptz, 'DefaultContinuousPanTiltVelocitySpace') : null,
      ranges: ptz ? ranges(path(ptz, 'PanTiltLimits/Range')) : null,
    };
  }).filter((p) => p.token);
}

/** The profile PTZ works with: the first one with a PTZConfiguration, else the first. @param {Profile[]} profiles */
export function pickProfile(profiles) {
  return profiles.find((p) => p.ptzConfigToken !== null) || profiles[0] || null;
}

/**
 * Pan/tilt spaces from a PTZNode's SupportedPTZSpaces or a configuration's Spaces.
 * @param {import('./xml.js').XmlNode|null} spaces
 */
export function parseSpaces(spaces) {
  const pick = (/** @type {string} */ name) => children(spaces, name).map((s) => ({ uri: textOf(s, 'URI') || '', ranges: ranges(s) }));
  return {
    absolute: pick('AbsolutePanTiltPositionSpace'),
    relative: pick('RelativePanTiltTranslationSpace'),
    continuous: pick('ContinuousPanTiltVelocitySpace'),
  };
}

/** @param {import('./xml.js').XmlNode} resp */
export function parseNodes(resp) {
  return children(resp, 'PTZNode').map((n) => ({
    token: n.attrs.token || '',
    spaces: parseSpaces(child(n, 'SupportedPTZSpaces')),
    maxPresets: toNumber(textOf(n, 'MaximumNumberOfPresets')),
    homeSupported: textOf(n, 'HomeSupported') === 'true',
  }));
}

/** @param {import('./xml.js').XmlNode} resp @returns {{ position: { x: number, y: number }|null, moveStatus: string|null }} */
export function parseStatus(resp) {
  const st = child(resp, 'PTZStatus');
  const pt = path(st, 'Position/PanTilt');
  const x = toNumber(pt?.attrs.x);
  const y = toNumber(pt?.attrs.y);
  const move = textOf(st, 'MoveStatus/PanTilt') ?? textOf(st, 'MoveStatus');
  return { position: x !== null && y !== null ? { x, y } : null, moveStatus: move ? move.toUpperCase() : null };
}

/** @param {import('./xml.js').XmlNode} resp @returns {CameraPreset[]} */
export function parsePresets(resp) {
  return children(resp, 'Preset').map((p) => {
    const pt = path(p, 'PTZPosition/PanTilt');
    const x = toNumber(pt?.attrs.x);
    const y = toNumber(pt?.attrs.y);
    return { token: p.attrs.token || '', name: textOf(p, 'Name') || '', position: x !== null && y !== null ? { x, y } : null };
  }).filter((p) => p.token);
}

/**
 * Topic paths of a GetEventProperties TopicSet (elements marked topic="true"):
 * "tns1:RuleEngine/CellMotionDetector/Motion".
 * @param {import('./xml.js').XmlNode} resp @returns {string[]}
 */
export function parseTopicSet(resp) {
  const set = child(resp, 'TopicSet');
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {import('./xml.js').XmlNode} */ n, /** @type {string[]} */ trail, /** @type {number} */ depth) => {
    if (depth > 12) return;
    for (const c of n.children) {
      if (c.name === 'MessageDescription' || c.name === 'Documentation') continue;
      const seg = trail.length === 0 && c.prefix ? `${c.prefix}:${c.name}` : c.name;
      const next = [...trail, seg];
      if (c.attrs.topic === 'true') out.push(next.join('/'));
      walk(c, next, depth + 1);
    }
  };
  if (set) walk(set, [], 0);
  return [...new Set(out)];
}

/**
 * NotificationMessages of a PullMessages answer. The state is read from Message/Data only — the
 * Source items come first and are not the state.
 * @param {import('./xml.js').XmlNode} resp @returns {Notification[]}
 */
export function parseNotifications(resp) {
  return children(resp, 'NotificationMessage').map((nm) => {
    const msg = path(nm, 'Message/Message');
    /** @type {Record<string, string>} */
    const data = {};
    for (const item of children(child(msg, 'Data'), 'SimpleItem')) {
      if (item.attrs.Name) data[item.attrs.Name] = item.attrs.Value ?? '';
    }
    return { topic: textOf(nm, 'Topic') || '', utcTime: msg?.attrs.UtcTime || '', operation: msg?.attrs.PropertyOperation || '', data };
  });
}

/**
 * @typedef {object} OnvifClientOptions
 * @property {string} host                 the resolved LAN IP (pinned)
 * @property {number} [port]               ONVIF port (2020 on Tapo)
 * @property {string} username             the Tapo Camera Account
 * @property {() => Promise<string|null>} getPassword
 * @property {(level: string, msg: string) => void} [log]
 * @property {() => number} [now]
 * @property {typeof postSoap} [post]      transport (tests)
 */

export class OnvifClient extends EventEmitter {
  /** @param {OnvifClientOptions} o */
  constructor(o) {
    super();
    if (!o || !o.host) throw new TypeError('host is required');
    this.host = o.host;
    this.port = o.port || 2020;
    this.username = o.username || '';
    this._getPassword = o.getPassword;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._post = o.post || postSoap;
    this._queue = new SerialQueue();
    this._pullQueue = new SerialQueue();
    /** @type {DeviceInfo|null} */
    this.device = null;
    /** @type {{ device: string, media: string|null, ptz: string|null, events: string|null }} */
    this.xaddr = { device: `http://${hostPort(this.host, this.port)}/onvif/device_service`, media: null, ptz: null, events: null };
    /** @type {Profile|null} */
    this.profile = null;
    /** @type {Profile[]} */
    this.profiles = [];
    /** GetCapabilities Events/WSPullPointSupport (null = not stated) @type {boolean|null} */
    this.pullPointSupport = null;
    /** @type {{ offsetMs: number, ntp: boolean|null, syncedAt: number, warn: boolean }|null} */
    this.clock = null;
    this._offsetMs = 0;
    /** @type {OnvifError|null} */
    this._authError = null;
    this._closed = false;
    /** the camera refused InitialTerminationTime once (C500): send the bare request */
    this._noInitialTermination = false;
    /** @type {string} the PullMessages action that worked after an Action fault ('' = the WSDL one) */
    this._pullAction = '';
  }

  /** A sign-in failed for good: nothing is sent until resetAuth(). */
  get authFailed() {
    return !!this._authError;
  }

  /** New credentials/host or the user pressed Retry. */
  resetAuth() {
    this._authError = null;
  }

  /** Stop: reject queued calls (a running one finishes). */
  close() {
    this._closed = true;
    const err = new OnvifError('unreachable', 'The camera connection was closed.');
    this._queue.clear(err);
    this._pullQueue.clear(err);
  }

  /** @param {'device'|'media'|'ptz'|'events'} service */
  serviceUrl(service) {
    return this.xaddr[service] || null;
  }

  /**
   * Send one request.
   * @param {'device'|'media'|'ptz'|'events'} service
   * @param {string} body
   * @param {{ timeoutMs?: number, action?: string, to?: string, url?: string, lane?: 'control'|'pull', priority?: boolean, auth?: boolean, op?: string }} [o]
   * @returns {Promise<import('./xml.js').XmlNode>}
   */
  call(service, body, o = {}) {
    const url = o.url || this.serviceUrl(service);
    if (!url) return Promise.reject(new OnvifError('fault', `The camera does not offer the ${service} service.`, { codes: ['unsupported'] }));
    const lane = o.lane || 'control';
    const job = () => this._exec(url, body, { ...o, lane });
    return lane === 'pull' ? this._pullQueue.run(job) : this._queue.run(job, { front: !!o.priority });
  }

  /** @param {string} url @param {string} body @param {{ timeoutMs?: number, action?: string, to?: string, lane: 'control'|'pull', auth?: boolean, op?: string }} o */
  async _exec(url, body, o) {
    if (this._closed) throw new OnvifError('unreachable', 'The camera connection was closed.');
    if (this._authError) throw this._authError;
    const auth = o.auth !== false;
    if (auth && (!this.clock || this._now() - this.clock.syncedAt > RESYNC_MS)) await this._resync(o.lane);
    try {
      return await this._send(url, body, o, auth);
    } catch (err) {
      if (!(err instanceof OnvifError) || err.kind !== 'auth' || !auth) throw err;
      // The clock may have jumped (a camera without NTP): resync once and retry once — except for
      // the sign-in check itself right after the clock was read (connect, the connection test):
      // there a retry is only a second refused sign-in, and cameras lock an address out after a
      // few. (Other operations keep the retry: a 401 can also be a busy camera.)
      const fresh = o.op === 'GetDeviceInformation' && !!this.clock && this._now() - this.clock.syncedAt < FRESH_CLOCK_MS;
      if (!fresh) {
        this._log('info', '[tapo] ONVIF sign-in fault: re-reading the camera clock and retrying once');
        await this._resync(o.lane);
      }
      try {
        if (fresh) throw err;
        return await this._send(url, body, o, auth);
      } catch (err2) {
        if (!(err2 instanceof OnvifError) || err2.kind !== 'auth') throw err2;
        // A refusal of one operation is not proof of a wrong password: check the sign-in
        // itself once (GetDeviceInformation) unless that is what just failed.
        if (o.op !== 'GetDeviceInformation' && o.lane === 'control') {
          try {
            await this._send(this.xaddr.device, BODIES.getDeviceInformation(), { ...o, op: 'GetDeviceInformation' }, true);
            throw new OnvifError('fault', 'The camera does not allow this operation for the Camera Account.', { codes: err2.codes, text: err2.text, status: err2.status });
          } catch (err3) {
            if (!(err3 instanceof OnvifError) || err3.kind !== 'auth') throw err3;
          }
        }
        this._authError = new OnvifError('auth', 'The camera refused the Camera Account user name or password.', { codes: err2.codes, text: err2.text, status: err2.status });
        this._log('warn', `[tapo] ONVIF sign-in failed (${err2.text || err2.codes.join(' ') || err2.status}); not retrying until the credentials change or Retry`);
        this.emit('auth-failed', this._authError);
        throw this._authError;
      }
    }
  }

  /** @param {string} url @param {string} body @param {{ timeoutMs?: number, action?: string, to?: string }} o @param {boolean} auth */
  async _send(url, body, o, auth) {
    let security = '';
    if (auth) {
      const password = await this._getPassword();
      if (password === null || password === undefined) throw new OnvifError('auth', 'No camera password is stored.');
      security = wsseHeader({
        username: this.username,
        password,
        createdIso: new Date(this._now() + this._offsetMs).toISOString(),
        nonce: crypto.randomBytes(16),
      });
    }
    const xml = envelope(body, { security, action: o.action, to: o.to });
    const res = await this._post(url, xml, { timeoutMs: o.timeoutMs ?? 5000 });
    return parseSoapResponse(res);
  }

  /** Re-read the clock from inside a lane (the control lane runs it inline). @param {'control'|'pull'} lane */
  _resync(lane) {
    return lane === 'pull' ? this._queue.run(() => this._syncNow()) : this._syncNow();
  }

  /**
   * GetSystemDateAndTime without a security header; on a fault or 401 once with one (offset 0).
   * offset = camera UTC − the middle of the request.
   * @returns {Promise<{ offsetMs: number, ntp: boolean|null }>}
   */
  async _syncNow() {
    const url = this.xaddr.device;
    const t0 = this._now();
    /** @type {import('./xml.js').XmlNode} */
    let resp;
    try {
      resp = await this._send(url, BODIES.getSystemDateAndTime(), { timeoutMs: 5000 }, false);
    } catch (err) {
      if (!(err instanceof OnvifError) || !['auth', 'fault', 'http'].includes(err.kind)) throw err;
      this._offsetMs = 0;
      resp = await this._send(url, BODIES.getSystemDateAndTime(), { timeoutMs: 5000 }, true);
    }
    const t1 = this._now();
    const { cameraUtcMs, ntp } = parseSystemDateAndTime(resp);
    const offsetMs = cameraUtcMs === null ? 0 : Math.round(cameraUtcMs - (t0 + t1) / 2);
    // the camera reports whole seconds: ignore sub-second noise
    this._offsetMs = Math.abs(offsetMs) < 1000 ? 0 : offsetMs;
    this.clock = { offsetMs: this._offsetMs, ntp, syncedAt: t1, warn: Math.abs(offsetMs) >= CLOCK_WARN_MS };
    if (this.clock.warn) this._log('info', `[tapo] camera clock is ${Math.round(offsetMs / 1000)} s off; compensating`);
    this.emit('clock', this.clock);
    return { offsetMs: this._offsetMs, ntp };
  }

  /** Public: re-read the camera clock (queued like any control call). */
  syncClock() {
    return this._queue.run(() => this._syncNow());
  }

  /**
   * clock → GetDeviceInformation (the sign-in check) → GetCapabilities (→ GetServices) → GetProfiles.
   * @returns {Promise<DeviceInfo>}
   */
  async connect() {
    this._closed = false;
    await this.syncClock();
    const device = await this.getDeviceInformation();
    this.device = device;
    let haveCaps = false;
    try {
      const caps = await this.getCapabilities();
      this.xaddr.media = caps.media;
      this.xaddr.ptz = caps.ptz;
      this.xaddr.events = caps.events;
      this.pullPointSupport = caps.pullPoint;
      haveCaps = !!caps.media;
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'auth') throw err;
      this._log('info', `[tapo] GetCapabilities failed (${/** @type {Error} */ (err).message}); trying GetServices`);
    }
    if (!haveCaps) {
      try {
        const svc = await this.getServices();
        this.xaddr.media = svc.media;
        this.xaddr.ptz = svc.ptz;
        this.xaddr.events = svc.events;
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'auth') throw err;
        // Both refused: current Tapo firmware serves everything at /onvif/service.
        const fallback = `http://${hostPort(this.host, this.port)}/onvif/service`;
        this._log('info', `[tapo] GetServices failed too (${/** @type {Error} */ (err).message}); assuming ${fallback}`);
        this.xaddr.media = fallback;
        this.xaddr.ptz = fallback;
        this.xaddr.events = fallback;
      }
    }
    this.profiles = await this.getProfiles();
    this.profile = pickProfile(this.profiles);
    return device;
  }

  // --- device -------------------------------------------------------------------------------

  /** @returns {Promise<DeviceInfo>} */
  async getDeviceInformation() {
    const r = await this.call('device', BODIES.getDeviceInformation(), { op: 'GetDeviceInformation' });
    return {
      manufacturer: textOf(r, 'Manufacturer') || '',
      model: textOf(r, 'Model') || '',
      firmware: textOf(r, 'FirmwareVersion') || '',
      serialNumber: textOf(r, 'SerialNumber') || '',
      hardwareId: textOf(r, 'HardwareId') || '',
    };
  }

  /** @returns {Promise<{ media: string|null, ptz: string|null, events: string|null, pullPoint: boolean|null }>} */
  async getCapabilities() {
    const r = await this.call('device', BODIES.getCapabilities(), { op: 'GetCapabilities' });
    const caps = child(r, 'Capabilities');
    const x = (/** @type {string} */ section) => rewriteXaddr(textOf(caps, `${section}/XAddr`), this.host, this.port);
    const pp = textOf(caps, 'Events/WSPullPointSupport');
    return { media: x('Media'), ptz: x('PTZ'), events: x('Events'), pullPoint: pp === 'true' ? true : pp === 'false' ? false : null };
  }

  /** @returns {Promise<{ media: string|null, ptz: string|null, events: string|null }>} */
  async getServices() {
    const r = await this.call('device', BODIES.getServices(), { op: 'GetServices' });
    /** @type {Record<string, string|null>} */
    const by = {};
    for (const s of children(r, 'Service')) {
      const ns = textOf(s, 'Namespace');
      if (ns) by[ns] = rewriteXaddr(textOf(s, 'XAddr'), this.host, this.port);
    }
    return { media: by[NS_MEDIA] || null, ptz: by[NS_PTZ] || null, events: by[NS_EVENTS] || null };
  }

  // --- media --------------------------------------------------------------------------------

  /** @returns {Promise<Profile[]>} */
  async getProfiles() {
    return parseProfiles(await this.call('media', BODIES.getProfiles(), { op: 'GetProfiles' }));
  }

  /** Informational only: the RTSP URL itself is built from the settings. @param {string} token */
  async getStreamUri(token, protocol = 'RTSP') {
    return textOf(await this.call('media', BODIES.getStreamUri(token, protocol), { op: 'GetStreamUri' }), 'MediaUri/Uri') || '';
  }

  // --- PTZ ----------------------------------------------------------------------------------

  _token() {
    if (this._authError) throw this._authError;
    if (!this.profile) throw new OnvifError('fault', 'The camera has no media profile.', { codes: ['unsupported'] });
    return this.profile.token;
  }

  async getNodes() {
    return parseNodes(await this.call('ptz', BODIES.getNodes(), { op: 'GetNodes' }));
  }

  /** @param {string} configToken */
  async getConfigurationOptions(configToken) {
    const r = await this.call('ptz', BODIES.getConfigurationOptions(configToken), { op: 'GetConfigurationOptions' });
    return { spaces: parseSpaces(path(r, 'PTZConfigurationOptions/Spaces')) };
  }

  async getStatus() {
    return parseStatus(await this.call('ptz', BODIES.getStatus(this._token()), { op: 'GetStatus', timeoutMs: 3000 }));
  }

  /** @param {number} x @param {number} y */
  async relativeMove(x, y) {
    await this.call('ptz', BODIES.relativeMove(this._token(), x, y), { op: 'RelativeMove' });
  }

  /** @param {number} x @param {number} y @param {number} timeoutSec */
  async continuousMove(x, y, timeoutSec = 1) {
    await this.call('ptz', BODIES.continuousMove(this._token(), x, y, timeoutSec), { op: 'ContinuousMove' });
  }

  /** Stop pan/tilt; jumps the queue. @param {{ minimal?: boolean }} [o] */
  async stop(o = {}) {
    const body = o.minimal ? BODIES.stopMinimal(this._token()) : BODIES.stop(this._token());
    await this.call('ptz', body, { op: 'Stop', priority: true, timeoutMs: 3000 });
  }

  /** Zero-velocity ContinuousMove: the ONVIF equivalent of Stop (last resort); jumps the queue too. */
  async zeroVelocity() {
    await this.call('ptz', BODIES.continuousMove(this._token(), 0, 0, 1), { op: 'ContinuousMove', priority: true, timeoutMs: 3000 });
  }

  /** @param {number} x @param {number} y */
  async absoluteMove(x, y) {
    await this.call('ptz', BODIES.absoluteMove(this._token(), x, y), { op: 'AbsoluteMove' });
  }

  async getPresets() {
    return parsePresets(await this.call('ptz', BODIES.getPresets(this._token()), { op: 'GetPresets' }));
  }

  /** @param {string} token */
  async gotoPreset(token) {
    await this.call('ptz', BODIES.gotoPreset(this._token(), token), { op: 'GotoPreset' });
  }

  /** @param {string} name @param {string} [token] @returns {Promise<string>} the preset token */
  async setPreset(name, token) {
    const r = await this.call('ptz', BODIES.setPreset(this._token(), name, token), { op: 'SetPreset' });
    return textOf(r, 'PresetToken') || token || '';
  }

  /** @param {string} token */
  async removePreset(token) {
    await this.call('ptz', BODIES.removePreset(this._token(), token), { op: 'RemovePreset' });
  }

  // --- events (the pull lane) ---------------------------------------------------------------

  // GetEventProperties and CreatePullPointSubscription go to the device's shared service address,
  // so they take the control lane (one request at a time there: some firmwares refuse concurrent
  // requests with a 401). Only the subscription's own address has a lane of its own.
  async getEventProperties() {
    return parseTopicSet(await this.call('events', BODIES.getEventProperties(), { op: 'GetEventProperties' }));
  }

  /**
   * CreatePullPointSubscription with InitialTerminationTime PT10M; a camera that refuses it
   * (ter:InvalidArgVal on the C500) gets the bare request, remembered for next time.
   * @returns {Promise<{ address: string, terminationTime: string, currentTime: string }>}
   */
  async createPullPoint() {
    const attempt = async (/** @type {boolean} */ withTermination) => {
      const r = await this.call('events', BODIES.createPullPointSubscription(withTermination), { op: 'CreatePullPointSubscription' });
      const address = rewriteXaddr(textOf(r, 'SubscriptionReference/Address'), this.host, this.port);
      if (!address) throw new OnvifError('malformed', 'The camera sent no subscription address.');
      return { address, terminationTime: textOf(r, 'TerminationTime') || '', currentTime: textOf(r, 'CurrentTime') || '' };
    };
    if (this._noInitialTermination) return attempt(false);
    try {
      return await attempt(true);
    } catch (err) {
      if (!(err instanceof OnvifError) || err.kind !== 'fault' || !/InvalidArg/i.test(`${err.codes.join(' ')} ${err.text}`)) throw err;
      this._noInitialTermination = true;
      return attempt(false);
    }
  }

  /**
   * One PullMessages on the subscription. The WSDL action first; after a fault that mentions the
   * Action, gladys' value (kept from then on).
   * @param {string} address @param {number} [timeoutSec] @param {number} [limit] @param {{ socketTimeoutMs?: number }} [o]
   * @returns {Promise<Notification[]>}
   */
  async pullMessages(address, timeoutSec = 5, limit = 32, o = {}) {
    const send = (/** @type {string} */ action) => this.call('events', BODIES.pullMessages(timeoutSec, limit), {
      op: 'PullMessages', lane: 'pull', url: address, action, to: address, timeoutMs: o.socketTimeoutMs ?? 15000,
    });
    let r;
    try {
      r = await send(this._pullAction || ACTIONS.pull);
    } catch (err) {
      if (this._pullAction || !(err instanceof OnvifError) || err.kind !== 'fault' || !/action/i.test(`${err.codes.join(' ')} ${err.text}`)) throw err;
      this._pullAction = ACTIONS.pullAlt;
      this._log('info', '[tapo] PullMessages: the camera wants the other WS-Addressing action; switching');
      r = await send(this._pullAction);
    }
    return parseNotifications(r);
  }

  /** @param {string} address */
  async renew(address) {
    const r = await this.call('events', BODIES.renew(), { op: 'Renew', lane: 'pull', url: address, action: ACTIONS.renew, to: address });
    return { terminationTime: textOf(r, 'TerminationTime') || '', currentTime: textOf(r, 'CurrentTime') || '' };
  }

  /** @param {string} address @param {{ timeoutMs?: number }} [o] */
  async unsubscribe(address, o = {}) {
    await this.call('events', BODIES.unsubscribe(), { op: 'Unsubscribe', lane: 'pull', url: address, action: ACTIONS.unsubscribe, to: address, timeoutMs: o.timeoutMs ?? 3000 });
  }
}

/** Every XAddr-looking value in a document (diagnostics only). @param {import('./xml.js').XmlNode} n */
export function allXaddrs(n) {
  return findAll(n, 'XAddr').map((x) => x.text.trim());
}
