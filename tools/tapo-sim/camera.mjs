// The simulated camera's shared state: identity, credentials, clock, quirk switches, the scenario
// (what happens in front of it), the PTZ motor, presets, the event hub and a log of every request.
// The ONVIF and RTSP servers and the control API all work on one SimCamera.

import { PtzModel } from './ptz-model.mjs';
import { EventHub } from './events-model.mjs';

/**
 * Quirk presets (contract §11.2). `tapo` is what the research found on Tapo firmware; `ideal` is
 * a well-behaved ONVIF camera (distinct service paths, honest tokens, standard axes), useful to
 * tell a client bug from a camera workaround.
 */
export const QUIRK_PRESETS = Object.freeze({
  tapo: Object.freeze({
    mirrorPan: true, // +x turns the lens LEFT (robotricks C211)
    invertTilt: true, // +y tilts DOWN (gladys-tapo)
    minEffectiveStep: 0.05, // smaller RelativeMove translations: 200 OK, no motion
    relativeActsContinuous: false, // C260: RelativeMove runs like ContinuousMove until Stop
    stopIgnoredOnPan: false, // C520WS: Stop ignored on the pan axis
    getStatusFails: false, // GetStatus answers HTTP 500 (C500, C210 2023)
    homeSupported: false,
    setPresetFails: false,
    absoluteFails: false,
    noPtz: false, // a firmware without ONVIF PTZ (unverified 1.5.x report)
    noEvents: false, // WSPullPointSupport=false
    pullDropAfterMs: 10000, // PullMessages: Timeout ignored, dropped badly after ~10 s
    rejectInitialTerminationTime: true, // C500: ter:InvalidArgVal
    maxSubscriptions: 3,
    concurrent401: false, // two overlapping control requests: the second gets HTTP 401
    latencyMs: 40, // the camera takes a moment per request (so requests can overlap)
    eventFlood: true, // 18 duplicates/s while on, one false blip every 60
    noFallingEdge: false,
    subscriptionLifetimeSec: 600,
    clockToleranceSec: 10, // WS-Security Created vs camera clock
    replayCheck: true, // a reused nonce is refused
    xaddrHost: null, // host advertised in XAddrs (null: the address the request came to)
    servicePaths: 'tapo', // every service at /onvif/service
    tokens: 'tapo', // profile_1 / PTZConfiguration_1
    sessionTimeoutSec: 15, // RTSP: no request for this long → the session is dropped
    maxRtspSessions: 2, // the camera's two-stream budget (Tapo app viewers count: scenario.viewers)
    // Session header carries ;timeout=15 (the C220 "reports" a 15 s timeout). go2rtc 1.9.14 sends
    // its keepalive at that value − 5 s; without it, its default interval is longer than 15 s and
    // the session is dropped and re-established every ~15 s (false = that camera)
    rtspAdvertiseTimeout: true,
    rtspAcceptBasic: false,
    privacyKillsStream: false, // privacy mode: placeholder picture (false) or no frames at all (true)
    // the picture shows where the lens pointed this long ago (a video that lags the motor before
    // it reaches the app: the camera's encoder, Wi-Fi, go2rtc on a busy PC); GetStatus is current
    videoLagMs: 0,
    rebootMs: 3000,
  }),
  ideal: Object.freeze({
    mirrorPan: false,
    invertTilt: false,
    minEffectiveStep: 0,
    relativeActsContinuous: false,
    stopIgnoredOnPan: false,
    getStatusFails: false,
    homeSupported: true,
    setPresetFails: false,
    absoluteFails: false,
    noPtz: false,
    noEvents: false,
    pullDropAfterMs: 0,
    rejectInitialTerminationTime: false,
    maxSubscriptions: 10,
    concurrent401: false,
    latencyMs: 0,
    eventFlood: false,
    noFallingEdge: false,
    subscriptionLifetimeSec: 600,
    clockToleranceSec: 10,
    replayCheck: true,
    xaddrHost: null,
    servicePaths: 'split', // /onvif/media_service, /onvif/ptz_service, …
    tokens: 'ideal', // MainStream / PtzConfigMain: catches hard-coded tokens
    sessionTimeoutSec: 60,
    maxRtspSessions: 4,
    rtspAdvertiseTimeout: true,
    rtspAcceptBasic: false,
    privacyKillsStream: false,
    videoLagMs: 0,
    rebootMs: 3000,
  }),
});

export const DEFAULT_SCENARIO = Object.freeze({
  motion: false,
  person: false,
  tamper: false,
  privacy: false,
  offline: false,
  clockSkewSec: 0,
  viewers: 0, // other viewers (the Tapo app on a phone) using the camera's stream slots
});

export const DEVICE = Object.freeze({
  manufacturer: 'tp-link',
  model: 'Tapo C211',
  firmware: '1.5.4 Build 260702 Rel.43n', // illustrative
  serial: '4c4e9a1b',
  hardwareId: '2.0',
});

const DEFAULT_PRESETS = () => [
  { token: '1', name: 'Door', x: 0.3, y: -0.2 },
  { token: '2', name: 'Window', x: -0.25, y: 0.2 },
];

export const MAX_PRESETS = 8;

/**
 * @typedef {{ t: number, service: string, op: string, args: Record<string, any>, status: number|string, why?: string }} Call
 */

export class SimCamera {
  /**
   * @param {{ username: string, password: string, quirks?: 'tapo'|'ideal'|Record<string, any>,
   *           log?: (level: string, msg: string) => void, now?: () => number }} o
   */
  constructor(o) {
    this.username = o.username;
    this.password = o.password;
    this._now = o.now || Date.now;
    this.log = o.log || (() => {});
    const preset = typeof o.quirks === 'string' ? o.quirks : 'tapo';
    if (!(preset in QUIRK_PRESETS)) throw new Error(`unknown quirk preset ${preset}`);
    this.preset = preset;
    this.quirks = { ...QUIRK_PRESETS[/** @type {'tapo'|'ideal'} */ (preset)], ...(typeof o.quirks === 'object' ? o.quirks : {}) };
    this.scenario = { ...DEFAULT_SCENARIO };
    /** @type {Call[]} */
    this.calls = [];
    this.ptz = new PtzModel({ now: this._now, getQuirks: () => this.quirks });
    this.presets = DEFAULT_PRESETS();
    /** Set by the ONVIF server once it knows its port. */
    this.eventPath = (/** @type {number} */ n) => `/event-${n}`;
    this.events = new EventHub({
      now: this._now,
      cameraNow: () => this.cameraNow(),
      getQuirks: () => this.quirks,
      pathFor: (n) => this.eventPath(n),
      log: this.log,
    });
    this.authFailures = { onvif: 0, rtsp: 0 };
    this.bootCount = 1;
    /** Listeners for online/offline changes (the servers close and reopen their sockets). @type {Set<(offline: boolean) => void>} */
    this.onOffline = new Set();
    /** @type {NodeJS.Timeout|null} */
    this._rebootTimer = null;
  }

  now() {
    return this._now();
  }

  /** The camera's own clock (scenario.clockSkewSec off the real one). */
  cameraNow() {
    return this._now() + (Number(this.scenario.clockSkewSec) || 0) * 1000;
  }

  /** @param {Omit<Call, 't'>} c */
  record(c) {
    const entry = { t: this._now(), ...c };
    this.calls.push(entry);
    if (this.calls.length > 5000) this.calls.splice(0, 1000);
    return entry;
  }

  /** @param {Record<string, any>} patch */
  setQuirks(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'privacy') this.setScenario({ privacy: !!v }); // listed with the quirks in §11.2
      else if (k in this.quirks) this.quirks[k] = v;
      else throw new Error(`unknown quirk ${k}`);
    }
    this.events.setSuppressed(this.scenario.privacy);
  }

  /** @param {Record<string, any>} patch */
  setScenario(patch) {
    const p = patch || {};
    for (const k of Object.keys(p)) if (!(k in DEFAULT_SCENARIO) && k !== 'reboot') throw new Error(`unknown scenario key ${k}`);
    if ('clockSkewSec' in p) this.scenario.clockSkewSec = Number(p.clockSkewSec) || 0;
    if ('viewers' in p) this.scenario.viewers = Math.max(0, Math.min(4, Math.round(Number(p.viewers) || 0)));
    if ('privacy' in p) {
      this.scenario.privacy = !!p.privacy;
      this.events.setSuppressed(this.scenario.privacy);
    }
    for (const kind of /** @type {const} */ (['motion', 'person', 'tamper'])) {
      if (kind in p) {
        this.scenario[kind] = !!p[kind];
        this.events.set(kind, this.scenario[kind]);
      }
    }
    if ('offline' in p && !!p.offline !== this.scenario.offline) {
      this.scenario.offline = !!p.offline;
      this.log('info', `[sim] camera ${this.scenario.offline ? 'offline' : 'back online'}`);
      for (const l of this.onOffline) l(this.scenario.offline);
    }
    if (p.reboot) this.reboot();
  }

  /** Power cycle: offline for rebootMs, subscriptions and RTSP sessions lost, motion stops. */
  reboot() {
    this.log('info', '[sim] rebooting');
    this.ptz.halt();
    this.events.clear();
    this.setScenario({ offline: true });
    if (this._rebootTimer) clearTimeout(this._rebootTimer);
    this._rebootTimer = setTimeout(() => {
      this._rebootTimer = null;
      this.bootCount++;
      this.setScenario({ offline: false });
    }, Number(this.quirks.rebootMs) || 3000);
  }

  /** Back to the initial state (quirk preset, centre position, default presets, empty log). */
  reset() {
    if (this._rebootTimer) clearTimeout(this._rebootTimer);
    this._rebootTimer = null;
    this.setScenario({ ...DEFAULT_SCENARIO });
    this.quirks = { ...QUIRK_PRESETS[/** @type {'tapo'|'ideal'} */ (this.preset)] };
    this.ptz.place(0, 0);
    this.ptz.counts = {};
    this.presets = DEFAULT_PRESETS();
    this.events.clear();
    this.events.created = 0;
    this.events.refused = 0;
    this.calls.length = 0;
    this.authFailures = { onvif: 0, rtsp: 0 };
  }

  /** Tokens of the media profiles (honest per preset: a client must read them). */
  get tokens() {
    return this.quirks.tokens === 'ideal'
      ? { main: 'MainStream', sub: 'SubStream', ptzConfig: 'PtzConfigMain', node: 'PtzNodeMain', video: 'VideoSourceMain' }
      : { main: 'profile_1', sub: 'profile_2', ptzConfig: 'PTZConfiguration_1', node: 'PTZNodeToken', video: 'vsconf' };
  }

  stop() {
    if (this._rebootTimer) clearTimeout(this._rebootTimer);
    this.events.stop();
  }
}
