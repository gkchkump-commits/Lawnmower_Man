// The simulated camera's ONVIF event source (contract §11.2): PullPoint subscriptions with
// lifetimes, Initialized messages after subscribing, Changed messages on every edge of the
// scenario's motion / person / tamper states, and the Tapo misbehaviour switches:
//   eventFlood       while a detection is on: 18 duplicate `true` messages per second, with one
//                    single `false` blip every 60 messages (C500 measurements in gladys-tapo)
//   noFallingEdge    the falling edge is never sent (some firmwares)
//   maxSubscriptions the n+1-th CreatePullPointSubscription is refused with Fault "error"
//   subscriptionLifetimeSec, rejectInitialTerminationTime (C500: ter:InvalidArgVal)

import { EventEmitter } from 'node:events';

export const TOPICS = Object.freeze({
  motion: { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', item: 'IsMotion', rule: 'MyMotionDetectorRule' },
  person: { topic: 'tns1:RuleEngine/PeopleDetector/People', item: 'IsPeople', rule: 'MyPeopleDetectorRule' },
  tamper: { topic: 'tns1:RuleEngine/TamperDetector/Tamper', item: 'IsTamper', rule: 'MyTamperDetectorRule' },
});
/** @typedef {keyof typeof TOPICS} EventKind */

const FLOOD_PER_SEC = 18;
const BLIP_EVERY = 60;
const QUEUE_MAX = 2048;

/**
 * @typedef {{ kind: EventKind, value: boolean, op: 'Initialized'|'Changed', utc: string, seq: number }} SimMessage
 * @typedef {{ n: number, path: string, createdAt: number, expiresAt: number, queue: SimMessage[],
 *             pulls: number, renews: number, delivered: number, dropped: number, emitter: EventEmitter }} Subscription
 */

export class SubscriptionError extends Error {
  /** @param {string} message @param {{ code: string, sender?: boolean }} o */
  constructor(message, o) {
    super(message);
    this.code = o.code;
    this.sender = o.sender !== false;
  }
}

export class EventHub {
  /**
   * @param {{ now?: () => number, cameraNow?: () => number, getQuirks: () => Record<string, any>,
   *           pathFor: (n: number) => string, log?: (level: string, msg: string) => void }} o
   */
  constructor(o) {
    this._now = o.now || Date.now;
    this._cameraNow = o.cameraNow || this._now;
    this._quirks = o.getQuirks;
    this._pathFor = o.pathFor;
    this._log = o.log || (() => {});
    /** @type {Map<string, Subscription>} by path */
    this._subs = new Map();
    this._counter = 0;
    this._seq = 0;
    /** @type {Record<EventKind, boolean>} */
    this.active = { motion: false, person: false, tamper: false };
    this._flood = { motion: 0, person: 0, tamper: 0 };
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    this.created = 0;
    this.refused = 0;
    this.suppressed = false; // privacy mode: the camera's detection is off
  }

  /**
   * CreatePullPointSubscription.
   * @param {{ initialTerminationSec?: number|null }} o null = not given
   * @returns {Subscription}
   */
  create(o) {
    this._expire();
    const q = this._quirks();
    if (o.initialTerminationSec !== null && o.initialTerminationSec !== undefined && q.rejectInitialTerminationTime) {
      throw new SubscriptionError('InitialTerminationTime not supported', { code: 'ter:InvalidArgVal' });
    }
    const max = Number(q.maxSubscriptions) || Infinity;
    if (this._subs.size >= max) {
      this.refused++;
      // what the camera says when its "MD threads" are used up (HA #91661, tapo-onvif-events)
      throw new SubscriptionError('error', { code: '', sender: false });
    }
    const lifetime = (o.initialTerminationSec ?? Number(q.subscriptionLifetimeSec)) || 600;
    const n = this._counter++;
    const now = this._now();
    /** @type {Subscription} */
    const sub = {
      n, path: this._pathFor(n), createdAt: now, expiresAt: now + lifetime * 1000, queue: [],
      pulls: 0, renews: 0, delivered: 0, dropped: 0, emitter: new EventEmitter(),
    };
    sub.emitter.setMaxListeners(50);
    this._subs.set(sub.path, sub);
    this.created++;
    // Initialized: the current state of every topic, without an edge
    for (const kind of /** @type {EventKind[]} */ (Object.keys(TOPICS))) this._push(sub, kind, this.active[kind], 'Initialized');
    this._log('info', `[sim] subscription ${sub.path} created (${this._subs.size} active)`);
    return sub;
  }

  /** @param {string} path @returns {Subscription|null} */
  get(path) {
    this._expire();
    return this._subs.get(path) || null;
  }

  /** @param {Subscription} sub @param {number|null} sec */
  renew(sub, sec) {
    sub.renews++;
    const lifetime = (sec ?? Number(this._quirks().subscriptionLifetimeSec)) || 600;
    sub.expiresAt = this._now() + lifetime * 1000;
  }

  /** @param {Subscription} sub */
  unsubscribe(sub) {
    this._subs.delete(sub.path);
    sub.emitter.emit('gone');
    this._log('info', `[sim] subscription ${sub.path} removed (${this._subs.size} active)`);
  }

  /** Reboot: every subscription is lost. */
  clear() {
    for (const sub of this._subs.values()) sub.emitter.emit('gone');
    this._subs.clear();
  }

  /**
   * Take up to `limit` queued messages (empty when none).
   * @param {Subscription} sub @param {number} limit @returns {SimMessage[]}
   */
  take(sub, limit) {
    const out = sub.queue.splice(0, Math.max(1, limit));
    sub.delivered += out.length;
    return out;
  }

  /**
   * The scenario changed: emit edges (and run the flood while something is on).
   * @param {EventKind} kind @param {boolean} on
   */
  set(kind, on) {
    const v = !!on;
    if (this.active[kind] === v) return;
    this.active[kind] = v;
    this._flood[kind] = 0;
    if (!this.suppressed && (v || !this._quirks().noFallingEdge)) this._broadcast(kind, v);
    this._syncTimer();
  }

  /** Privacy mode on/off: no detection messages while on. @param {boolean} on */
  setSuppressed(on) {
    this.suppressed = !!on;
    this._syncTimer();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.clear();
  }

  snapshot() {
    this._expire();
    const now = this._now();
    return {
      active: { ...this.active },
      created: this.created,
      refused: this.refused,
      list: [...this._subs.values()].map((s) => ({
        path: s.path, ageMs: now - s.createdAt, expiresInMs: s.expiresAt - now, queued: s.queue.length,
        pulls: s.pulls, renews: s.renews, delivered: s.delivered, dropped: s.dropped,
      })),
    };
  }

  _syncTimer() {
    const want = !this.suppressed && !!this._quirks().eventFlood && Object.values(this.active).some(Boolean);
    if (want && !this._timer) {
      this._timer = setInterval(() => this._floodTick(), Math.round(1000 / FLOOD_PER_SEC));
      this._timer.unref?.();
    } else if (!want && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _floodTick() {
    if (!this._quirks().eventFlood) return this._syncTimer();
    for (const kind of /** @type {EventKind[]} */ (Object.keys(TOPICS))) {
      if (!this.active[kind]) continue;
      const k = ++this._flood[kind];
      this._broadcast(kind, k % BLIP_EVERY !== 0); // one lone `false` in the middle of the run
    }
    return undefined;
  }

  /** @param {EventKind} kind @param {boolean} value */
  _broadcast(kind, value) {
    this._expire();
    for (const sub of this._subs.values()) this._push(sub, kind, value, 'Changed');
  }

  /** @param {Subscription} sub @param {EventKind} kind @param {boolean} value @param {'Initialized'|'Changed'} op */
  _push(sub, kind, value, op) {
    sub.queue.push({ kind, value, op, utc: new Date(this._cameraNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'), seq: ++this._seq });
    if (sub.queue.length > QUEUE_MAX) {
      sub.queue.shift();
      sub.dropped++;
    }
    sub.emitter.emit('message');
  }

  _expire() {
    const now = this._now();
    for (const [p, s] of this._subs) {
      if (s.expiresAt <= now) {
        this._subs.delete(p);
        s.emitter.emit('gone');
        this._log('info', `[sim] subscription ${p} expired`);
      }
    }
  }
}
