// PullPointMonitor: the camera's own motion / person / tamper events over ONVIF PullPoint
// (contract §8.9). Pure Node.
//
// Tapo quirks it is built around:
//  * PullMessages' Timeout is not honoured: the camera drops the request after ~10 s, often with
//    bytes after "Connection: close". That is a normal (empty) pull — keep the subscription.
//  * subscriptions live ~10 minutes: Renew every 480 s; a refused Renew → Unsubscribe and
//    subscribe again. Never more than one subscription (cameras cap them, ~3).
//  * ~18 duplicate "true" messages a second while something is in view, single "false" blips in
//    the middle, and some firmwares never send the falling edge: duplicates are dropped, a fall is
//    held 2 s (a "true" inside cancels it), and a state with no refresh for 3 minutes falls.
//  * the state is read from Message/Data only (onvif-client parseNotifications).

import { EventEmitter } from 'node:events';

import { ACTIONS, BODIES, OnvifError, isBenignPullError } from './onvif-soap.js';

export const RENEW_MS = 480_000;
export const FALL_HOLD_MS = 2000;
export const STALE_MS = 180_000;
export const BENIGN_RETRY_MS = 250;
export const MAX_BACKOFF_MS = 60_000;

/** @typedef {'motion'|'person'|'tamper'} EventKind */
/** @typedef {'off'|'subscribing'|'subscribed'|'failing'|'unsupported'} MonitorState */

/** Data item name → kind (others — IsVehicle, IsPet, IsLineCross, IsIntrusion — are ignored in v1). */
const ITEM_KINDS = /** @type {Record<string, EventKind>} */ ({ IsPeople: 'person', IsPerson: 'person', IsMotion: 'motion', IsTamper: 'tamper' });

/** @param {string} v */
function truthy(v) {
  return /^(true|1)$/i.test(String(v).trim());
}

/**
 * @typedef {object} MonitorOptions
 * @property {import('./onvif-client.js').OnvifClient} client
 * @property {(level: string, msg: string) => void} [log]
 * @property {() => number} [now]
 * @property {typeof setTimeout} [setTimeout]
 * @property {typeof clearTimeout} [clearTimeout]
 * @property {number} [renewMs]
 */

export class PullPointMonitor extends EventEmitter {
  /** @param {MonitorOptions} o */
  constructor(o) {
    super();
    this.client = o.client;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._setTimeout = o.setTimeout || setTimeout;
    this._clearTimeout = o.clearTimeout || clearTimeout;
    this._renewMs = o.renewMs ?? RENEW_MS;
    /** @type {MonitorState} */
    this._state = 'off';
    this._running = false;
    /** @type {{ address: string, renewAt: number }|null} */
    this._sub = null;
    /** @type {string[]|null} */
    this.topics = null;
    this._failures = 0;
    /** @type {Promise<void>|null} */
    this._loop = null;
    /** per kind: active, the fall-hold timer, the last refresh @type {Record<string, { active: boolean, fall: any, stale: any, lastTrueAt: number }>} */
    this._kinds = {};
    /** @type {{ timer: any, resolve: () => void }|null} */
    this._sleep = null;
  }

  /** @returns {MonitorState} */
  get state() {
    return this._state;
  }

  get running() {
    return this._running;
  }

  /** @param {MonitorState} s */
  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  /**
   * Start the subscribe/pull loop. Resolves after the first subscription attempt.
   * @returns {Promise<void>}
   */
  start() {
    if (this._running) return Promise.resolve();
    if (this.client.authFailed) {
      this._setState('off');
      return Promise.resolve();
    }
    if (this.client.pullPointSupport === false || !this.client.serviceUrl('events')) {
      this._setState('unsupported');
      return Promise.resolve();
    }
    this._running = true;
    this._failures = 0;
    /** @type {() => void} */
    let firstAttempt = () => {};
    const first = new Promise((r) => { firstAttempt = () => r(undefined); });
    this._loop = this._run(firstAttempt).catch((err) => {
      this._log('warn', `[tapo] event loop ended: ${/** @type {Error} */ (err).message}`);
    }).finally(() => {
      firstAttempt();
      this._loop = null;
    });
    return first;
  }

  /**
   * Unsubscribe (best effort, ≤ 3 s) and stop. Every state that is still active falls first
   * (synchronously, before the first await): nobody watches it any more, so it must not stay
   * "active" in the security engine.
   */
  async stop() {
    const wasRunning = this._running;
    this._running = false;
    this._wake();
    const kinds = this._kinds;
    this._kinds = {};
    for (const [kind, k] of Object.entries(kinds)) {
      this._clearTimeout(k.fall);
      this._clearTimeout(k.stale);
      k.fall = null;
      k.stale = null;
      if (k.active) {
        k.active = false;
        this.emit('event', { kind, active: false, at: this._now(), topic: '', reason: 'stopped' });
      }
    }
    const sub = this._sub;
    this._sub = null;
    if (sub) await this._unsubscribe(sub.address);
    if (wasRunning || this._state !== 'unsupported') this._setState('off');
  }

  /** @param {string} address */
  async _unsubscribe(address) {
    // the control lane: the pull lane may be busy with a pull for up to 15 s
    await Promise.race([
      this.client.call('events', BODIES.unsubscribe(), { op: 'Unsubscribe', url: address, action: ACTIONS.unsubscribe, to: address, timeoutMs: 3000 }).catch((err) => this._log('debug', `[tapo] Unsubscribe: ${/** @type {Error} */ (err).message}`)),
      new Promise((r) => this._setTimeout(r, 3100)),
    ]);
  }

  /** @param {number} ms */
  _wait(ms) {
    return new Promise((resolve) => {
      const s = { timer: /** @type {any} */ (null), resolve: () => resolve(undefined) };
      s.timer = this._setTimeout(() => {
        if (this._sleep === s) this._sleep = null;
        resolve(undefined);
      }, ms);
      this._sleep = s;
    });
  }

  _wake() {
    const s = this._sleep;
    this._sleep = null;
    if (s) {
      this._clearTimeout(s.timer);
      s.resolve();
    }
  }

  /** A sign-in failure ends the loop for good (no retries: camera lockouts). @param {unknown} err */
  _isAuth(err) {
    if (!(err instanceof OnvifError) || err.kind !== 'auth') return false;
    this._running = false;
    this._setState('off');
    return true;
  }

  /** @param {() => void} firstAttempt */
  async _run(firstAttempt) {
    while (this._running) {
      if (this.client.authFailed) {
        this._running = false;
        this._setState('off');
        break;
      }
      if (!this._sub) {
        this._setState(this._failures >= 3 ? 'failing' : 'subscribing');
        if (!this.topics) {
          try {
            this.topics = await this.client.getEventProperties();
            this.emit('topics', this.topics);
          } catch (err) {
            if (this._isAuth(err)) break;
            this._log('info', `[tapo] GetEventProperties failed: ${/** @type {Error} */ (err).message}`);
            this.topics = [];
            this.emit('topics', this.topics);
          }
        }
        if (!this._running) break;
        try {
          const sub = await this.client.createPullPoint();
          if (!this._running) {
            await this._unsubscribe(sub.address);
            break;
          }
          this._sub = { address: sub.address, renewAt: this._now() + this._renewMs };
          this._failures = 0;
          this._setState('subscribed');
          this._log('info', '[tapo] subscribed to the camera\'s events');
        } catch (err) {
          firstAttempt();
          if (this._isAuth(err)) break;
          await this._failed(err, 'CreatePullPointSubscription');
          continue;
        }
        firstAttempt();
      }
      if (!this._sub) continue;
      if (this._now() >= this._sub.renewAt) {
        try {
          await this.client.renew(this._sub.address);
          this._sub.renewAt = this._now() + this._renewMs;
        } catch (err) {
          if (this._isAuth(err)) break;
          this._log('info', `[tapo] Renew refused (${/** @type {Error} */ (err).message}); subscribing again`);
          const old = this._sub;
          this._sub = null;
          await this._unsubscribe(old.address);
          continue;
        }
      }
      try {
        const msgs = await this.client.pullMessages(this._sub.address, 5, 32, { socketTimeoutMs: 15000 });
        if (!this._running) break;
        this._failures = 0;
        this._setState('subscribed');
        for (const m of msgs) this._onNotification(m);
      } catch (err) {
        if (!this._running) break;
        if (isBenignPullError(err)) {
          await this._wait(BENIGN_RETRY_MS);
          continue;
        }
        if (this._isAuth(err)) break;
        const old = this._sub;
        this._sub = null;
        if (old) await this._unsubscribe(old.address);
        await this._failed(err, 'PullMessages');
      }
    }
  }

  /** A real failure: back off 2 s × n (≤ 60 s); "failing" after three in a row. @param {unknown} err @param {string} what */
  async _failed(err, what) {
    this._failures++;
    if (this._failures >= 3) this._setState('failing');
    const delay = Math.min(MAX_BACKOFF_MS, 2000 * this._failures);
    this._log('info', `[tapo] ${what} failed (${/** @type {Error} */ (err).message}); retrying in ${delay / 1000} s`);
    await this._wait(delay);
  }

  /** @param {import('./onvif-client.js').Notification} m */
  _onNotification(m) {
    for (const [name, value] of Object.entries(m.data)) {
      const kind = ITEM_KINDS[name];
      if (!kind) {
        this._log('debug', `[tapo] camera event ${name}=${value} (${m.topic}) ignored`);
        continue;
      }
      this._update(kind, truthy(value), m.operation, m.topic);
    }
  }

  /**
   * @param {EventKind} kind @param {boolean} value @param {string} operation @param {string} topic
   */
  _update(kind, value, operation, topic) {
    const now = this._now();
    let k = this._kinds[kind];
    if (!k) {
      k = { active: false, fall: null, stale: null, lastTrueAt: 0 };
      this._kinds[kind] = k;
    }
    if (operation === 'Initialized') {
      // A (new) subscription's baseline. Unchanged: no edge. A state that ended while nobody was
      // subscribed (a reboot, a Wi-Fi drop) falls now — or the event would never end. A state that
      // is already active is reported as a baseline: the engine keeps it ignored until it falls.
      this._clearTimeout(k.fall);
      k.fall = null;
      if (value) {
        k.lastTrueAt = now;
        this._armStale(kind, k, topic);
        if (!k.active) {
          k.active = true;
          this.emit('event', { kind, active: true, at: now, topic, baseline: true });
        }
      } else if (k.active) {
        this._fall(kind, k, topic);
      }
      return;
    }
    if (value) {
      k.lastTrueAt = now;
      if (k.fall) {
        this._clearTimeout(k.fall); // a blip inside the hold: still active
        k.fall = null;
      }
      this._armStale(kind, k, topic);
      if (!k.active) {
        k.active = true;
        this.emit('event', { kind, active: true, at: now, topic });
      }
      return;
    }
    if (!k.active || k.fall) return;
    k.fall = this._setTimeout(() => {
      k.fall = null;
      this._fall(kind, k, topic);
    }, FALL_HOLD_MS);
  }

  /** @param {EventKind} kind @param {{ active: boolean, fall: any, stale: any, lastTrueAt: number }} k @param {string} topic */
  _armStale(kind, k, topic) {
    this._clearTimeout(k.stale);
    k.stale = this._setTimeout(() => {
      k.stale = null;
      if (k.active) {
        this._log('debug', `[tapo] camera ${kind} event without a falling edge for 3 minutes; ending it`);
        this._fall(kind, k, topic);
      }
    }, STALE_MS);
  }

  /** @param {EventKind} kind @param {{ active: boolean, fall: any, stale: any, lastTrueAt: number }} k @param {string} topic */
  _fall(kind, k, topic) {
    if (!k.active) return;
    k.active = false;
    this._clearTimeout(k.stale);
    k.stale = null;
    this.emit('event', { kind, active: false, at: this._now(), topic });
  }
}
