// PtzController: pan/tilt for one camera over ONVIF (contract §8.4). Pure Node.
//
// Motor safety comes first. The camera's motor must never be left running against its end stop:
//  * every move is followed by a watchdog: poll MoveStatus (GetStatus) every 300 ms until IDLE,
//    or — when GetStatus does not work, or the poll runs past the bound — send the Stop chain at
//    min(8 s, 1.5 s + |t| × msPerUnit). Some firmwares turn a RelativeMove into a continuous one.
//    A preset/home move that GetStatus shows still converging on its target gets more time (≤ 30 s).
//  * a move whose request failed gets the timed Stop chain too: a lost or timed-out answer says
//    nothing about the motor (only a clear refusal — a SOAP fault — ends it at once).
//  * the Stop chain: Stop → (fault) minimal Stop → (still MOVING 600 ms later, or Stop errored)
//    zero-velocity ContinuousMove (the ONVIF equivalent of Stop; some firmwares ignore Stop on pan).
//  * press-and-hold re-sends ContinuousMove (Timeout PT1S, so the camera stops by itself too) every
//    500 ms only while heartbeats arrive; 700 ms without one → Stop chain.
//  * stopAll() on window blur, renderer gone, disarm-while-moving and quit.
//  * one request in flight; a newer move replaces a queued one; Stop jumps the queue (client).
// The camera in privacy mode answers PTZ with a malformed response, then HTTP 500: that suspends
// PTZ for 60 s with a hint, and never marks it unsupported.

import { EventEmitter } from 'node:events';

import { OnvifError } from './onvif-soap.js';

export const HEARTBEAT_TIMEOUT_MS = 700;
export const HOLD_RESEND_MS = 500;
export const HOLD_NUDGE_MS = 700;
export const POLL_MS = 300;
export const SETTLE_MS = 1500;
export const STOP_CHECK_MS = 600;
export const MAX_WATCHDOG_MS = 8000;
/** A preset/home move the camera reports progress on may take this long at most. */
export const MAX_LONG_MOVE_MS = 30_000;
/** While such a move runs past its estimate: re-checked this often, and it must have moved this far. */
export const PROGRESS_CHECK_MS = 1000;
export const PROGRESS_EPS = 0.01;
/** A hold ends this close to the end of the travel (the absolute position space is −1..1). */
export const HOLD_LIMIT_EPS = 0.01;
export const PRIVACY_MS = 60_000;
export const CENTER_DEADBAND = 0.04;

export const PRIVACY_HINT = 'The camera seems to be in privacy mode. Turn privacy mode off in the Tapo app.';
const DIRS = /** @type {const} */ ({ left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] });

/**
 * @typedef {'left'|'right'|'up'|'down'} Dir
 * @typedef {{ op: 'nudge', dir: Dir, amount: 'small'|'medium'|'large' } | { op: 'hold', dir: Dir } | { op: 'heartbeat' }
 *   | { op: 'release' } | { op: 'stop' } | { op: 'center', u: number, v: number } | { op: 'preset', token: string }
 *   | { op: 'preset-name', name: string } | { op: 'home' }} PtzCommand
 * @typedef {{ ok: boolean, moved?: boolean, error?: string, code?: 'unsupported'|'privacy'|'busy'|'offline'|'auth'|'not-configured'|'no-preset',
 *   position?: { x: number, y: number } | null, candidates?: string[], preset?: string }} PtzResult
 * @typedef {{ token: string, name: string, source: 'camera'|'local', home?: boolean }} Preset
 * @typedef {{ units?: number, msPerUnit?: number, stopAfterMs?: number, blind?: boolean, long?: boolean, target?: { x: number, y: number }|null }} WatchOptions
 * @typedef {{ min: number, max: number }} Range
 * @typedef {{ available: boolean, mode: 'relative'|'continuous'|'none', canStatus: boolean, canAbsolute: boolean, canContinuous: boolean,
 *   canSetPreset: boolean|null, xRange: Range, yRange: Range, maxPresets: number|null, homeSupported: boolean }} PtzCaps
 */

/** The PTZ part of settings.tapo. @typedef {object} PtzSettings
 * @property {'auto'|'relative'|'continuous'|'off'} ptz
 * @property {boolean} invertPan @property {boolean} invertTilt
 * @property {number} stepSmall @property {number} stepMedium @property {number} stepLarge
 * @property {number} viewUnitsX @property {number} viewUnitsY @property {number} minStep
 * @property {number} holdSpeed @property {number} msPerUnit @property {string} homePreset
 * @property {Array<{ name: string, x: number, y: number }>} localPresets
 */

const UNIT = { min: -1, max: 1 };

/** @returns {PtzCaps} */
export function noCaps() {
  return { available: false, mode: 'none', canStatus: false, canAbsolute: false, canContinuous: false, canSetPreset: null, xRange: { ...UNIT }, yRange: { ...UNIT }, maxPresets: null, homeSupported: false };
}

/** @param {number} v @param {Range} r */
const clampTo = (v, r) => Math.max(r.min, Math.min(r.max, v));

/** A non-zero axis is raised to at least `min` (firmwares ignore tiny translations). @param {number} t @param {number} min */
export function roundUpToMin(t, min) {
  if (t === 0 || !Number.isFinite(t)) return 0;
  return Math.abs(t) < min ? Math.sign(t) * min : t;
}

/**
 * The translation for a nudge: a fraction of the view in ONVIF units, minStep, then the inversion.
 * @param {Dir} dir @param {'small'|'medium'|'large'} amount @param {PtzSettings} s
 * @returns {{ x: number, y: number }}
 */
export function nudgeTranslation(dir, amount, s) {
  const [sx, sy] = DIRS[dir];
  const f = amount === 'small' ? s.stepSmall : amount === 'large' ? s.stepLarge : s.stepMedium;
  const x = roundUpToMin(sx * f * s.viewUnitsX, s.minStep);
  const y = roundUpToMin(sy * f * s.viewUnitsY, s.minStep);
  return { x: (s.invertPan ? -x : x) + 0, y: (s.invertTilt ? -y : y) + 0 };
}

/**
 * Click-to-center: (u, v) in the live view (0..1, u right, v down) → a translation that brings
 * that point to the middle. Clicking above the centre turns up. A small deadband around it.
 * @param {number} u @param {number} v @param {PtzSettings} s
 */
export function centerTranslation(u, v, s) {
  let dx = u - 0.5;
  let dy = v - 0.5;
  if (Math.abs(dx) < CENTER_DEADBAND) dx = 0;
  if (Math.abs(dy) < CENTER_DEADBAND) dy = 0;
  const x = roundUpToMin(dx * s.viewUnitsX, s.minStep);
  const y = roundUpToMin(-dy * s.viewUnitsY, s.minStep);
  return { x: (s.invertPan ? -x : x) + 0, y: (s.invertTilt ? -y : y) + 0 };
}

/** lowercase, no articles/punctuation, single spaces. @param {string} s */
export function normalizePresetName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !['the', 'a', 'an', 'my', 'our'].includes(w)).join(' ');
}

/** @param {string} a @param {string} b */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Find a preset by a spoken/typed name: exact (normalized), then prefix, then Levenshtein ≤ 2
 * for names of 4+ characters. Several at the same stage → ambiguous.
 * @template {{ name: string }} P
 * @param {string} query @param {P[]} presets
 * @returns {{ preset: P } | { ambiguous: string[] } | { none: true }}
 */
export function matchPresetName(query, presets) {
  const q = normalizePresetName(query);
  if (!q) return { none: true };
  const named = presets.map((p) => ({ p, n: normalizePresetName(p.name) })).filter((x) => x.n);
  const stages = [
    named.filter((x) => x.n === q),
    named.filter((x) => x.n.startsWith(q) || q.startsWith(x.n)),
    q.length >= 4 ? named.filter((x) => x.n.length >= 4 && levenshtein(x.n, q) <= 2) : [],
  ];
  for (const hits of stages) {
    if (hits.length === 1) return { preset: hits[0].p };
    if (hits.length > 1) {
      const names = [...new Set(hits.map((h) => h.p.name))];
      if (names.length === 1) return { preset: hits[0].p };
      return { ambiguous: names };
    }
  }
  return { none: true };
}

/** @param {unknown} err */
function isPrivacySymptom(err) {
  return err instanceof OnvifError && (err.kind === 'malformed' || (err.kind === 'http' && err.status === 500));
}

/**
 * @typedef {object} PtzOptions
 * @property {import('./onvif-client.js').OnvifClient} client
 * @property {() => PtzSettings} getSettings
 * @property {(tapoPatch: Partial<PtzSettings>) => void} [saveSettings]  persists local presets
 * @property {(level: string, msg: string) => void} [log]
 * @property {() => number} [now]
 * @property {typeof setTimeout} [setTimeout]
 * @property {typeof clearTimeout} [clearTimeout]
 */

export class PtzController extends EventEmitter {
  /** @param {PtzOptions} o */
  constructor(o) {
    super();
    this.client = o.client;
    this._getSettings = o.getSettings;
    this._saveSettings = o.saveSettings || (() => {});
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._setTimeout = o.setTimeout || setTimeout;
    this._clearTimeout = o.clearTimeout || clearTimeout;
    /** @type {PtzCaps} */
    this.caps = noCaps();
    this._probed = false;
    /** @type {import('./onvif-client.js').CameraPreset[]} */
    this._cameraPresets = [];
    this.moving = false;
    this.settleUntil = 0;
    /** @type {{ x: number, y: number }|null} */
    this.position = null;
    this._privacyUntil = 0;
    this._disposed = false;
    /** watchdog of the current move @type {{ seq: number, timers: Array<any>, deadline: number, checkPos: { x: number, y: number }|null, pollOk: boolean }|null} */
    this._watch = null;
    this._moveSeq = 0;
    /** how the last move ended: MoveStatus IDLE or a Stop @type {{ seq: number, by: 'idle'|'stop' }|null} */
    this._lastEnd = null;
    /** press-and-hold @type {{ dir: Dir, lastBeat: number, resend: any, beat: any, mode: 'continuous'|'relative' }|null} */
    this._hold = null;
    /** the "still MOVING 600 ms after Stop?" check @type {{ timer: any, resolve: () => void, done: Promise<void> }|null} */
    this._stopCheck = null;
    /** a move being sent @type {Promise<void>|null} */
    this._inflight = null;
    /** the last probe ran during suspected privacy mode: probe again before the next command */
    this._reprobe = false;
    /** the next move, replaced by newer ones @type {{ run: () => Promise<PtzResult>, resolve: (r: PtzResult) => void }|null} */
    this._pending = null;
  }

  /** @returns {PtzSettings} */
  _s() {
    const s = /** @type {any} */ (this._getSettings() || {});
    const n = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return {
      ptz: ['auto', 'relative', 'continuous', 'off'].includes(s.ptz) ? s.ptz : 'auto',
      invertPan: !!s.invertPan,
      invertTilt: !!s.invertTilt,
      stepSmall: n(s.stepSmall, 0.15),
      stepMedium: n(s.stepMedium, 0.35),
      stepLarge: n(s.stepLarge, 0.75),
      viewUnitsX: n(s.viewUnitsX, 0.5),
      viewUnitsY: n(s.viewUnitsY, 1.4),
      minStep: n(s.minStep, 0.05),
      holdSpeed: Math.max(0.1, Math.min(1, n(s.holdSpeed, 0.5))),
      msPerUnit: Math.max(500, Math.min(20000, n(s.msPerUnit, 6000))),
      homePreset: typeof s.homePreset === 'string' ? s.homePreset : '',
      localPresets: Array.isArray(s.localPresets) ? s.localPresets : [],
    };
  }

  get privacySuspected() {
    if (this._privacyUntil && this._now() >= this._privacyUntil) {
      this._privacyUntil = 0;
      this.emit('privacy', false);
    }
    return this._privacyUntil > 0;
  }

  /** @param {unknown} err */
  _notePrivacy(err) {
    if (!isPrivacySymptom(err)) return false;
    const was = this._privacyUntil > 0;
    this._privacyUntil = this._now() + PRIVACY_MS;
    if (!was) {
      this._log('info', '[tapo] PTZ answers look like privacy mode; pausing pan/tilt for 60 s');
      this.emit('privacy', true);
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Capabilities

  /**
   * Find out what the camera can do. Never moves it. A probe taken while privacy mode is
   * suspected does not replace earlier capabilities.
   * @returns {Promise<PtzCaps>}
   */
  async probe() {
    const s = this._s();
    const c = this.client;
    const profile = c.profile;
    if (s.ptz === 'off' || !c.serviceUrl('ptz') || !profile || profile.ptzConfigToken === null) {
      this.caps = noCaps();
      this._probed = true;
      this.emit('caps', this.caps);
      return this.caps;
    }
    let privacy = false;
    const attempt = async (/** @type {() => Promise<any>} */ fn, /** @type {string} */ what) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'auth') throw err;
        if (this._notePrivacy(err)) privacy = true;
        this._log('info', `[tapo] PTZ probe: ${what} failed (${/** @type {Error} */ (err).message})`);
        return null;
      }
    };
    const nodes = await attempt(() => c.getNodes(), 'GetNodes');
    const options = profile.ptzConfigToken ? await attempt(() => c.getConfigurationOptions(/** @type {string} */ (profile.ptzConfigToken)), 'GetConfigurationOptions') : null;
    const status = await attempt(() => c.getStatus(), 'GetStatus');
    const presets = await attempt(() => c.getPresets(), 'GetPresets');

    const node = nodes && nodes[0];
    const spaces = { absolute: [...(node?.spaces.absolute || [])], relative: [...(node?.spaces.relative || []), ...(options?.spaces.relative || [])], continuous: [...(node?.spaces.continuous || []), ...(options?.spaces.continuous || [])] };
    const hasRelative = spaces.relative.length > 0 || !!profile.relativeSpace;
    const hasContinuous = spaces.continuous.length > 0 || !!profile.continuousSpace;
    let mode = /** @type {'relative'|'continuous'|'none'} */ ('none');
    if (s.ptz === 'relative') mode = 'relative';
    else if (s.ptz === 'continuous') mode = 'continuous';
    else if (hasRelative) mode = 'relative';
    else if (hasContinuous) mode = 'continuous';
    const rel = spaces.relative.find((sp) => sp.ranges)?.ranges || null;
    /** @type {PtzCaps} */
    const caps = {
      available: mode !== 'none',
      mode,
      canStatus: !!(status && status.position),
      canContinuous: hasContinuous || mode === 'continuous',
      canAbsolute: spaces.absolute.length > 0,
      canSetPreset: this.caps.canSetPreset,
      xRange: rel ? { ...rel.x } : { ...UNIT },
      yRange: rel ? { ...rel.y } : { ...UNIT },
      maxPresets: node?.maxPresets ?? null,
      homeSupported: !!node?.homeSupported,
    };
    if (presets) this._cameraPresets = presets;
    if (status?.position) this._setPosition(status.position);
    if (privacy && this._probed && this.caps.available) {
      this._log('info', '[tapo] PTZ probe during suspected privacy mode: keeping the earlier capabilities');
      return this.caps;
    }
    if (privacy && !this._probed) {
      // nothing better known yet: keep PTZ usable (commands answer "privacy" until it clears)
      caps.available = mode !== 'none' || !!c.serviceUrl('ptz');
      if (caps.mode === 'none' && caps.available) caps.mode = 'relative';
      this._reprobe = true;
    } else {
      this._reprobe = false;
    }
    this.caps = caps;
    this._probed = true;
    this.emit('caps', caps);
    return caps;
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  /**
   * @param {PtzCommand} cmd
   * @returns {Promise<PtzResult>}
   */
  async command(cmd) {
    if (this._disposed) return { ok: false, code: 'offline', error: 'The camera is not connected.' };
    if (cmd.op === 'stop') {
      await this.stopAll('stop', { force: true });
      return { ok: true, moved: false, position: this.position };
    }
    if (cmd.op === 'heartbeat') {
      if (this._hold) this._beat();
      return { ok: true, moved: false };
    }
    if (cmd.op === 'release') {
      if (this._hold) await this._endHold('release');
      return { ok: true, moved: false };
    }
    if (this.client.authFailed) return { ok: false, code: 'auth', error: 'The camera refused the sign-in. Check the Camera Account in the setup.' };
    if (!this.caps.available) return { ok: false, code: 'unsupported', error: 'This camera does not offer pan and tilt over ONVIF (or it is turned off in the settings).' };
    if (this.privacySuspected) return { ok: false, code: 'privacy', error: PRIVACY_HINT };
    if (this._reprobe) await this.probe().catch(() => {});

    if (cmd.op === 'hold') return this._startHold(cmd.dir);
    // any other move ends a hold first
    if (this._hold) await this._endHold('new command');

    const s = this._s();
    switch (cmd.op) {
      case 'nudge': {
        const t = nudgeTranslation(cmd.dir, cmd.amount, s);
        return this._queueMove(() => this._translate(t, s));
      }
      case 'center': {
        const t = centerTranslation(cmd.u, cmd.v, s);
        if (t.x === 0 && t.y === 0) return { ok: true, moved: false, position: this.position };
        return this._queueMove(() => this._translate(t, s));
      }
      case 'preset':
        return this._queueMove(() => this._gotoPresetToken(cmd.token));
      case 'preset-name': {
        const list = await this.presets({ refresh: false });
        const m = matchPresetName(cmd.name, list);
        if ('ambiguous' in m) return { ok: false, code: 'no-preset', candidates: m.ambiguous, error: `Which position do you mean: ${m.ambiguous.join(' or ')}?` };
        if ('none' in m) return { ok: false, code: 'no-preset', candidates: list.map((p) => p.name), error: `There is no saved position called "${String(cmd.name).slice(0, 40)}".` };
        const r = await this._queueMove(() => this._gotoPresetToken(m.preset.token));
        return { ...r, preset: m.preset.name };
      }
      case 'home':
        return this._queueMove(() => this._home(s));
      default:
        return { ok: false, error: 'Unknown camera command.' };
    }
  }

  /**
   * One move in flight; a newer one replaces the queued one (whose caller gets moved:false).
   * @param {() => Promise<PtzResult>} run
   * @returns {Promise<PtzResult>}
   */
  _queueMove(run) {
    if (!this._inflight) return this._runMove(run);
    return new Promise((resolve) => {
      if (this._pending) this._pending.resolve({ ok: true, moved: false });
      this._pending = { run, resolve };
    });
  }

  /** Wait for the move slot, then run (hold steps and calibration moves are never replaced). @param {() => Promise<PtzResult>} run */
  async _runExclusive(run) {
    while (this._inflight) await this._inflight;
    return this._runMove(run);
  }

  /** @param {() => Promise<PtzResult>} run @returns {Promise<PtzResult>} */
  async _runMove(run) {
    /** @type {(v?: any) => void} */
    let done = () => {};
    this._inflight = new Promise((r) => { done = r; });
    try {
      return await run();
    } catch (err) {
      return this._errorResult(err);
    } finally {
      this._inflight = null;
      done();
      const next = this._pending;
      this._pending = null;
      if (next && !this._disposed) this._runExclusive(next.run).then(next.resolve);
      else if (next) next.resolve({ ok: false, code: 'offline', error: 'The camera is not connected.' });
    }
  }

  /** @param {unknown} err @returns {PtzResult} */
  _errorResult(err) {
    if (this._notePrivacy(err)) return { ok: false, code: 'privacy', error: PRIVACY_HINT };
    if (err instanceof OnvifError) {
      if (err.kind === 'auth') return { ok: false, code: 'auth', error: err.message };
      if (['timeout', 'reset', 'refused', 'unreachable'].includes(err.kind)) return { ok: false, code: 'offline', error: 'The camera did not answer. Is it switched on and on the network?' };
      return { ok: false, error: err.message };
    }
    this._log('warn', `[tapo] PTZ: ${/** @type {Error} */ (err)?.message || err}`);
    return { ok: false, error: 'The camera could not move.' };
  }

  /**
   * Send a translation in the active mode, then arm the watchdog.
   * @param {{ x: number, y: number }} t @param {PtzSettings} s
   * @returns {Promise<PtzResult>}
   */
  async _translate(t, s) {
    const x = clampTo(t.x, this.caps.xRange) + 0;
    const y = clampTo(t.y, this.caps.yRange) + 0;
    if (x === 0 && y === 0) return { ok: true, moved: false, position: this.position };
    const units = Math.max(Math.abs(x), Math.abs(y));
    if (this.caps.mode === 'continuous') {
      const ms = Math.max(150, Math.min(4000, units * s.msPerUnit));
      const vx = Math.sign(x) * s.holdSpeed;
      const vy = Math.sign(y) * s.holdSpeed;
      // whole seconds (xs:duration as Tapo's own traffic sends it); the watchdog stops it on time
      await this._sendMove(() => this.client.continuousMove(vx, vy, Math.ceil(ms / 1000)), { stopAfterMs: ms });
    } else {
      await this._sendMove(() => this.client.relativeMove(x, y), { units, msPerUnit: s.msPerUnit });
    }
    return { ok: true, moved: true, position: this.position };
  }

  /** @param {string} token @returns {Promise<PtzResult>} */
  async _gotoPresetToken(token) {
    const local = /^local-(\d+)$/.exec(token);
    if (local) {
      const p = this._s().localPresets[Number(local[1])];
      if (!p || !this.caps.canAbsolute) return { ok: false, code: 'no-preset', error: 'That saved position no longer exists.' };
      const target = { x: clampTo(p.x, UNIT), y: clampTo(p.y, UNIT) };
      await this._sendMove(() => this.client.absoluteMove(target.x, target.y), { units: this._distanceTo(p), long: true, target });
      return { ok: true, moved: true, preset: p.name, position: this.position };
    }
    const known = this._cameraPresets.find((p) => p.token === token);
    await this._sendMove(() => this.client.gotoPreset(token), { units: this._distanceTo(known?.position || null), long: true, target: known?.position || null });
    return { ok: true, moved: true, preset: known?.name, position: this.position };
  }

  /** Travel to a known target in units (the watchdog bound); 2 (= the cap) when unknown. @param {{ x: number, y: number }|null} target */
  _distanceTo(target) {
    if (!target || !this.position) return 2;
    return Math.min(2, Math.max(Math.abs(target.x - this.position.x), Math.abs(target.y - this.position.y)) + 0.1);
  }

  /** @param {PtzSettings} s @returns {Promise<PtzResult>} */
  async _home(s) {
    if (s.homePreset) return this._gotoPresetToken(s.homePreset);
    if (this.caps.canAbsolute) {
      await this._sendMove(() => this.client.absoluteMove(0, 0), { units: this._distanceTo({ x: 0, y: 0 }), long: true, target: { x: 0, y: 0 } });
      return { ok: true, moved: true, position: this.position };
    }
    const named = (await this.presets({ refresh: false })).find((p) => normalizePresetName(p.name) === 'home');
    if (named) return this._gotoPresetToken(named.token);
    return { ok: false, code: 'unsupported', error: 'This camera has no home position. Save a position called "Home" in the Tapo app, or pick one as home.' };
  }

  /**
   * A move used by calibration: raw ONVIF intent (no inversion, no minStep), then wait until it
   * has settled (MoveStatus, else the time estimate). The watchdog still applies. `measured`:
   * the camera reported the end (MoveStatus IDLE), so `settledMs` is its travel time; otherwise it
   * is only the app's own Stop estimate (msPerUnit) and must not be fed back into msPerUnit.
   * @param {number} x @param {number} y @param {{ maxWaitMs?: number }} [o]
   * @returns {Promise<{ settledMs: number, measured: boolean }>}
   */
  async rawMove(x, y, o = {}) {
    if (!this.caps.available) throw new Error('Pan and tilt are not available.');
    if (this.privacySuspected) throw new Error(PRIVACY_HINT);
    const s = this._s();
    const t0 = this._now();
    let seq = -1;
    const r = await this._runExclusive(async () => {
      await this._sendMove(() => {
        seq = this._moveSeq;
        return this.client.relativeMove(clampTo(x, this.caps.xRange), clampTo(y, this.caps.yRange));
      }, { units: Math.max(Math.abs(x), Math.abs(y)), msPerUnit: s.msPerUnit });
      return { ok: true, moved: true };
    });
    if (!r.ok) throw new Error(r.error || 'The camera could not move.');
    await this.waitIdle(o.maxWaitMs ?? 6000);
    const measured = !!this._lastEnd && this._lastEnd.seq === seq && this._lastEnd.by === 'idle';
    return { settledMs: this._now() - t0, measured };
  }

  /**
   * Resolves when the camera is not moving (true), or after `timeoutMs` (false).
   * @param {number} timeoutMs @param {{ settle?: boolean }} [o] settle: also wait out the settle time
   */
  waitIdle(timeoutMs, o = {}) {
    const ready = () => !this.moving && (!o.settle || this._now() >= this.settleUntil);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      /** @type {any} */
      let timer = null;
      /** @type {any} */
      let settleTimer = null;
      const finish = (/** @type {boolean} */ v) => {
        this._clearTimeout(timer);
        this._clearTimeout(settleTimer);
        this.off('moving', onMoving);
        resolve(v);
      };
      const onMoving = (/** @type {boolean} */ moving) => {
        if (moving) return;
        if (!o.settle) finish(true);
        else {
          this._clearTimeout(settleTimer);
          settleTimer = this._setTimeout(() => ready() && finish(true), Math.max(0, this.settleUntil - this._now()) + 5);
        }
      };
      this.on('moving', onMoving);
      timer = this._setTimeout(() => finish(ready()), timeoutMs);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Moving state and the watchdog

  _beginMove() {
    this._cancelWatchdog();
    this._cancelStopCheck();
    this._moveSeq++;
    if (!this.moving) {
      this.moving = true;
      this.emit('moving', true, 0);
    }
  }

  /**
   * Send one move request and arm its watchdog — whatever the request's fate:
   *  * no answer (timeout, reset, unreachable): the motor's state is unknown — the camera may have
   *    acted on a request whose answer was lost, and a RelativeMove may run on as a continuous
   *    one — so the timed Stop chain always comes, "blind" (no early end on an IDLE poll, which can
   *    come before the motor starts);
   *  * an odd answer (HTTP 5xx, malformed: privacy mode looks like this): the usual watchdog, so
   *    MoveStatus IDLE ends it as soon as the camera reports it, or the timed Stop does;
   *  * a clear refusal (a SOAP fault, a refused sign-in, a connection that never opened): the
   *    camera did not move, the move ends at once.
   * The error is passed on (the caller maps it to a result).
   * @param {() => Promise<unknown>} send @param {WatchOptions} watch
   */
  async _sendMove(send, watch) {
    this._beginMove();
    try {
      await send();
    } catch (err) {
      const kind = err instanceof OnvifError ? err.kind : 'unknown';
      if (['fault', 'auth', 'refused'].includes(kind)) this._endMove(`move refused (${kind})`);
      else if (['http', 'malformed'].includes(kind)) this._armWatchdog(watch);
      else this._armWatchdog({ ...watch, blind: true });
      throw err;
    }
    this._armWatchdog(watch);
  }

  /** @param {string} why @param {'idle'|'stop'} [by] how the end is known */
  _endMove(why, by = 'stop') {
    this._cancelWatchdog();
    this._lastEnd = { seq: this._moveSeq, by };
    this.settleUntil = this._now() + SETTLE_MS;
    if (this.moving) {
      this.moving = false;
      this._log('debug', `[tapo] PTZ idle (${why})`);
      this.emit('moving', false, this.settleUntil);
    }
  }

  /**
   * After a move request: poll MoveStatus (when GetStatus works) until IDLE; otherwise — or when
   * the poll runs past the bound — the Stop chain. `stopAfterMs` = a timed continuous nudge, which
   * always ends with the Stop chain; `blind` = the request failed, so the Stop always comes at the
   * bound. A `long` move (preset, home) that the polls show still converging on its `target` (or
   * still moving, when the target is unknown) is re-checked every second instead, up to 30 s.
   * @param {WatchOptions} o
   */
  _armWatchdog(o) {
    this._cancelWatchdog();
    const seq = this._moveSeq;
    const bound = o.stopAfterMs !== undefined ? o.stopAfterMs : Math.min(MAX_WATCHDOG_MS, 1500 + (o.units ?? 2) * (o.msPerUnit ?? this._s().msPerUnit));
    const startedAt = this._now();
    const watch = { seq, timers: /** @type {any[]} */ ([]), deadline: startedAt + bound, checkPos: this.position, pollOk: false };
    this._watch = watch;
    const polling = o.stopAfterMs === undefined && !o.blind && this.caps.canStatus;
    const extendable = polling && !!o.long;
    const onBound = () => {
      if (this._watch !== watch) return;
      if (extendable && this._now() - startedAt < MAX_LONG_MOVE_MS && this._progressing(watch, o.target || null)) {
        watch.checkPos = this.position;
        watch.deadline = this._now() + PROGRESS_CHECK_MS;
        watch.timers.push(this._setTimeout(onBound, PROGRESS_CHECK_MS));
        return;
      }
      this._log('debug', `[tapo] PTZ watchdog: Stop after ${Math.round(this._now() - startedAt)} ms${o.blind ? ' (the move request failed)' : ''}`);
      this._stopChain('watchdog').catch(() => {});
    };
    watch.timers.push(this._setTimeout(onBound, bound));
    if (polling) {
      const poll = async () => {
        if (this._watch !== watch) return;
        try {
          const st = await this.client.getStatus();
          if (this._watch !== watch) return;
          if (st.position) this._setPosition(st.position);
          watch.pollOk = !!st.position;
          if (st.moveStatus === 'IDLE') {
            this._endMove('MoveStatus IDLE', 'idle');
            return;
          }
        } catch (err) {
          if (this._watch !== watch) return;
          watch.pollOk = false;
          this._notePrivacy(err);
          // GetStatus stopped working: the timed Stop at the bound still comes
          return;
        }
        watch.timers.push(this._setTimeout(poll, POLL_MS));
      };
      watch.timers.push(this._setTimeout(poll, POLL_MS));
    }
  }

  /**
   * Did the camera move since the last check — and, with a target, get closer to it?
   * @param {{ checkPos: { x: number, y: number }|null, pollOk: boolean }} watch @param {{ x: number, y: number }|null} target
   */
  _progressing(watch, target) {
    const p = this.position;
    const q = watch.checkPos;
    if (!p || !q || !watch.pollOk) return false;
    if (Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) < PROGRESS_EPS) return false;
    if (!target) return true;
    const dist = (/** @type {{ x: number, y: number }} */ a) => Math.max(Math.abs(target.x - a.x), Math.abs(target.y - a.y));
    return dist(p) < dist(q);
  }

  _cancelWatchdog() {
    const w = this._watch;
    this._watch = null;
    if (w) for (const t of w.timers) this._clearTimeout(t);
  }

  _cancelStopCheck() {
    const c = this._stopCheck;
    this._stopCheck = null;
    if (!c) return;
    this._clearTimeout(c.timer);
    c.resolve();
  }

  /**
   * Stop → minimal Stop on a fault → zero-velocity ContinuousMove when Stop errored, or when the
   * camera still reports MOVING 600 ms later (checked in the background; `stopAll(…, { force })`
   * waits for it). Never throws; resolves once the Stop has been answered.
   * @param {string} why
   */
  async _stopChain(why) {
    this._cancelWatchdog();
    this._cancelStopCheck();
    const seq = this._moveSeq;
    let errored = false;
    try {
      await this.client.stop();
    } catch (err) {
      this._notePrivacy(err);
      try {
        await this.client.stop({ minimal: true });
      } catch (err2) {
        this._notePrivacy(err2);
        errored = true;
        this._log('info', `[tapo] Stop failed (${/** @type {Error} */ (err2).message}); sending zero velocity`);
      }
    }
    // Without GetStatus nothing can confirm that the Stop worked (some firmwares ignore Stop on
    // pan): a zero-velocity ContinuousMove too, the ONVIF equivalent of Stop. Cheap and harmless.
    if (errored || (!this.caps.canStatus && this.caps.canContinuous)) await this._zeroVelocity();
    if (this._moveSeq !== seq) return; // a new move started meanwhile: it has its own watchdog
    this._endMove(`stopped (${why})`);
    if (!errored && this.caps.canStatus) this._scheduleStopCheck(seq);
  }

  /**
   * Still turning 600 ms after Stop (Stop ignored on pan on some firmwares)? Then zero velocity.
   * A new move cancels the check: its own motion would read MOVING and be stopped.
   * @param {number} seq
   */
  _scheduleStopCheck(seq) {
    /** @type {() => void} */
    let resolve = () => {};
    const done = new Promise((r) => { resolve = () => r(undefined); });
    const check = { resolve, done, timer: /** @type {any} */ (null) };
    check.timer = this._setTimeout(async () => {
      if (this._stopCheck !== check) return;
      try {
        const st = await this.client.getStatus();
        if (st.position) this._setPosition(st.position);
        if (st.moveStatus === 'MOVING' && this._moveSeq === seq && this._stopCheck === check) {
          this._log('info', '[tapo] still MOVING after Stop; sending zero velocity');
          await this._zeroVelocity();
          if (this._moveSeq === seq) this._endMove('zero velocity');
        }
      } catch { /* GetStatus failing is no reason for more */ }
      if (this._stopCheck === check) this._stopCheck = null;
      resolve();
    }, STOP_CHECK_MS);
    this._stopCheck = check;
  }

  async _zeroVelocity() {
    try {
      await this.client.zeroVelocity();
    } catch (err) {
      this._notePrivacy(err);
      this._log('warn', `[tapo] zero-velocity stop failed too: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Stop everything: a hold, the queued move, the watchdog — and the motor (when it may be
   * moving, or always with `force`). Used on blur, renderer gone, disarm and quit.
   * @param {string} reason @param {{ force?: boolean }} [o]
   */
  async stopAll(reason, o = {}) {
    const wasHolding = !!this._hold;
    this._clearHold();
    if (this._pending) {
      this._pending.resolve({ ok: true, moved: false });
      this._pending = null;
    }
    const mayMove = this.moving || wasHolding || !!this._watch || !!this._inflight;
    if (!this.caps.available || (!mayMove && !o.force)) return;
    while (this._inflight) await this._inflight;
    this._log('debug', `[tapo] PTZ stopAll (${reason})`);
    await this._stopChain(reason);
    // quitting: give the "still moving?" check its 600 ms (zero velocity for an ignored Stop)
    if (o.force && this._stopCheck) await /** @type {any} */ (this._stopCheck).done;
  }

  // -------------------------------------------------------------------------------------------
  // Press-and-hold

  /** @param {Dir} dir @returns {Promise<PtzResult>} */
  async _startHold(dir) {
    if (this._hold && this._hold.dir === dir) {
      this._beat();
      return { ok: true, moved: true };
    }
    if (this._hold) this._clearHold();
    while (this._inflight) await this._inflight;
    // ContinuousMove whenever the camera has a velocity space (unless the user chose relative
    // moves only); a relative-only camera gets a small nudge every 700 ms instead
    const mode = this.caps.canContinuous && this._s().ptz !== 'relative' ? 'continuous' : 'relative';
    const hold = { dir, lastBeat: this._now(), resend: /** @type {any} */ (null), beat: /** @type {any} */ (null), mode };
    this._hold = hold;
    this._armBeat(hold);
    const r = await this._holdStep(hold);
    if (!r.ok) {
      if (this._hold === hold) this._clearHold();
      return r;
    }
    return { ok: true, moved: true };
  }

  _beat() {
    const hold = this._hold;
    if (!hold) return;
    hold.lastBeat = this._now();
    this._armBeat(hold);
  }

  /** 700 ms without a heartbeat → stop. @param {NonNullable<PtzController['_hold']>} hold */
  _armBeat(hold) {
    this._clearTimeout(hold.beat);
    hold.beat = this._setTimeout(() => {
      if (this._hold !== hold) return;
      this._log('info', '[tapo] PTZ hold: no heartbeat for 700 ms; stopping');
      this._endHold('heartbeat missed').catch(() => {});
    }, HEARTBEAT_TIMEOUT_MS);
  }

  /** One continuous re-send (or a small nudge on relative-only cameras). @param {NonNullable<PtzController['_hold']>} hold */
  async _holdStep(hold) {
    if (this._hold !== hold) return { ok: true };
    if (this._now() - hold.lastBeat > HEARTBEAT_TIMEOUT_MS) {
      await this._endHold('heartbeat missed');
      return { ok: true };
    }
    const s = this._s();
    const [sx, sy] = DIRS[hold.dir];
    let r;
    if (hold.mode === 'continuous') {
      const vx = (s.invertPan ? -sx : sx) * s.holdSpeed + 0;
      const vy = (s.invertTilt ? -sy : sy) * s.holdSpeed + 0;
      r = await this._runExclusive(async () => {
        // the camera's own Timeout (PT1S) stops it too; this bound covers a lost hold
        await this._sendMove(() => this.client.continuousMove(vx, vy, 1), { stopAfterMs: 1500 });
        return { ok: true, moved: true };
      });
    } else {
      r = await this._runExclusive(() => this._translate(nudgeTranslation(hold.dir, 'small', s), s));
    }
    if (this._hold === hold && r.ok) {
      hold.resend = this._setTimeout(() => this._holdStep(hold).catch(() => {}), hold.mode === 'continuous' ? HOLD_RESEND_MS : HOLD_NUDGE_MS);
      if (hold.mode === 'continuous') this._checkHoldLimit(hold);
    }
    return r;
  }

  /**
   * While a hold drives the motor: read the position (when GetStatus works) and end the hold at
   * the end of the travel in the held direction, instead of pushing against the end stop.
   * @param {NonNullable<PtzController['_hold']>} hold
   */
  _checkHoldLimit(hold) {
    if (!this.caps.canStatus) return;
    const s = this._s();
    const [sx, sy] = DIRS[hold.dir];
    const vx = s.invertPan ? -sx : sx;
    const vy = s.invertTilt ? -sy : sy;
    this.client.getStatus().then((st) => {
      if (this._hold !== hold || !st.position) return;
      this._setPosition(st.position);
      const at = (/** @type {number} */ v, /** @type {number} */ p) => (v > 0 ? p >= UNIT.max - HOLD_LIMIT_EPS : v < 0 ? p <= UNIT.min + HOLD_LIMIT_EPS : true);
      if (at(vx, st.position.x) && at(vy, st.position.y)) {
        this._log('info', '[tapo] PTZ hold: the end of the travel; stopping');
        this._endHold('end of travel').catch(() => {});
      }
    }, (err) => this._notePrivacy(err));
  }

  _clearHold() {
    const hold = this._hold;
    this._hold = null;
    if (!hold) return;
    this._clearTimeout(hold.resend);
    this._clearTimeout(hold.beat);
  }

  /** @param {string} why */
  async _endHold(why) {
    const hold = this._hold;
    this._clearHold();
    if (!hold) return;
    if (this._inflight) await this._inflight;
    await this._stopChain(`hold ended: ${why}`);
  }

  get holding() {
    return !!this._hold;
  }

  // -------------------------------------------------------------------------------------------
  // Presets

  /** @param {{ x: number, y: number }} p */
  _setPosition(p) {
    const prev = this.position;
    this.position = { x: p.x, y: p.y };
    if (!prev || Math.abs(prev.x - p.x) > 1e-4 || Math.abs(prev.y - p.y) > 1e-4) this.emit('position', this.position);
  }

  /**
   * Camera presets (made in the Tapo app or here) + local positions (when the camera can report
   * and go to a position).
   * @param {{ refresh?: boolean }} [o]
   * @returns {Promise<Preset[]>}
   */
  async presets(o = {}) {
    if (!this.caps.available) return [];
    if (o.refresh && !this.privacySuspected) {
      try {
        this._cameraPresets = await this.client.getPresets();
      } catch (err) {
        if (!this._notePrivacy(err)) this._log('info', `[tapo] GetPresets failed: ${/** @type {Error} */ (err).message}`);
      }
    }
    const s = this._s();
    /** @type {Preset[]} */
    const out = this._cameraPresets.map((p) => ({ token: p.token, name: p.name || `Position ${p.token}`, source: /** @type {const} */ ('camera') }));
    if (this.caps.canStatus && this.caps.canAbsolute) {
      s.localPresets.forEach((p, i) => out.push({ token: `local-${i}`, name: p.name, source: 'local' }));
    }
    for (const p of out) if (s.homePreset && p.token === s.homePreset) p.home = true;
    return out;
  }

  /**
   * Save the current position: ONVIF SetPreset (tried once; remembered whether it works), else a
   * local position when the camera reports and goes to positions.
   * @param {string} name @param {string} [token]
   * @returns {Promise<{ ok: boolean, token?: string, error?: string }>}
   */
  async savePreset(name, token) {
    if (!this.caps.available) return { ok: false, error: 'Pan and tilt are not available.' };
    if (this.privacySuspected) return { ok: false, error: PRIVACY_HINT };
    if (this.caps.canSetPreset !== false) {
      try {
        const t = await this.client.setPreset(name, token);
        this.caps = { ...this.caps, canSetPreset: true };
        await this.presets({ refresh: true });
        return { ok: true, token: t || token };
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'auth') return { ok: false, error: err.message };
        if (this._notePrivacy(err)) return { ok: false, error: PRIVACY_HINT };
        this.caps = { ...this.caps, canSetPreset: false };
        this._log('info', `[tapo] SetPreset is not supported here (${/** @type {Error} */ (err).message})`);
      }
    }
    if (this.caps.canStatus && this.caps.canAbsolute) {
      try {
        const st = await this.client.getStatus();
        if (!st.position) throw new Error('no position');
        const list = this._s().localPresets.filter((p) => normalizePresetName(p.name) !== normalizePresetName(name)).slice(0, 15);
        list.push({ name: String(name).slice(0, 40), x: st.position.x, y: st.position.y });
        this._saveSettings({ localPresets: list });
        return { ok: true, token: `local-${list.length - 1}` };
      } catch (err) {
        this._log('info', `[tapo] could not save a local position: ${/** @type {Error} */ (err).message}`);
      }
    }
    return { ok: false, error: 'Save positions in the Tapo app, then press Refresh.' };
  }

  /** @param {string} token @returns {Promise<{ ok: boolean, error?: string }>} */
  async removePreset(token) {
    const local = /^local-(\d+)$/.exec(token);
    if (local) {
      const list = this._s().localPresets.slice();
      if (!list[Number(local[1])]) return { ok: false, error: 'That saved position no longer exists.' };
      list.splice(Number(local[1]), 1);
      this._saveSettings({ localPresets: list, ...(this._s().homePreset === token ? { homePreset: '' } : {}) });
      return { ok: true };
    }
    try {
      await this.client.removePreset(token);
      await this.presets({ refresh: true });
      return { ok: true };
    } catch (err) {
      if (this._notePrivacy(err)) return { ok: false, error: PRIVACY_HINT };
      return { ok: false, error: 'The camera did not remove it. Remove the position in the Tapo app, then press Refresh.' };
    }
  }

  /** The camera is going away (disconnect/disable): stop timers; send a last Stop if moving. */
  async dispose() {
    await this.stopAll('dispose').catch(() => {});
    this._disposed = true;
    this._cancelWatchdog();
    this._cancelStopCheck();
  }
}
