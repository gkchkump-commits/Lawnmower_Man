// SecurityEngine: decides when something is happening (contract §8.8). Pure: inputs in,
// actions out, time passed in — no timers, no I/O (tapo-service runs tick() and the effects).
//
// Two independent sources: the camera's own ONVIF events (after events.js de-noising) and the
// local detector in the camera window's worker (motion + person). A person alert needs the local
// detector to agree (confirmLocally) — unless it is down, then the camera alone counts after
// 6 s ("unconfirmed"). Nothing is evaluated unless armed (after the exit delay). Our own pan/tilt
// moves, a stream (re)start and global picture changes (IR switch, exposure) are suppressed.
//
// Clip roll-over at maxClipSec happens in the recorder (keyframe-aligned, gapless); an event
// itself ends postRollSec after its last evidence, or at once when disarmed.

export const SENSITIVITY = Object.freeze({
  low: { personScore: 0.65, motionFraction: 0.03 },
  medium: { personScore: 0.5, motionFraction: 0.015 },
  high: { personScore: 0.4, motionFraction: 0.008 },
});
export const PERSON_MIN_AREA = 0.002; // 0.2 % of the frame
export const STREAM_SUPPRESS_MS = 10_000;
export const GLOBAL_SUPPRESS_MS = 3000;
export const UNCONFIRMED_AFTER_MS = 6000;
export const BOOST_MS = 10_000;
export const LOCAL_STALE_MS = 5000;
export const BEST_SNAPSHOT_EVERY_MS = 2000;
export const EXTEND_EVERY_MS = 5000;

/**
 * @typedef {'person'|'motion'|'tamper'} Kind
 * @typedef {{ id: string, kind: Kind, startedAt: number, endedAt?: number, sources: string[], unconfirmed?: boolean,
 *   maxScore?: number, notified: boolean, announced: boolean, acknowledged: boolean }} EventSummary
 * @typedef {{ type: 'event-start'|'event-update'|'event-end', event: EventSummary }
 *   | { type: 'record-start'|'record-stop'|'record-extend', eventId: string }
 *   | { type: 'notify', event: EventSummary, silent: boolean }
 *   | { type: 'announce', event: EventSummary, quiet: boolean }
 *   | { type: 'describe', event: EventSummary }
 *   | { type: 'snapshot', eventId: string, purpose: 'best'|'alert' }
 *   | { type: 'boost', untilMs: number }
 *   | { type: 'armed-changed', armed: boolean, arming: boolean, armingEndsAt?: number }} Action
 * @typedef {object} SecuritySettings   settings.security (contract §4)
 */

const RANK = { motion: 0, tamper: 1, person: 2 };

/**
 * Is `at` inside "HH:MM-HH:MM" (local time; may wrap midnight)? '' = never.
 * @param {string} spec @param {number} at
 */
export function inQuietHours(spec, at) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(spec || ''));
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (start === end) return false;
  const d = new Date(at);
  const now = d.getHours() * 60 + d.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Which kinds a 'person' | 'motion' | 'off' level covers. @param {string} level @param {Kind} kind */
function covers(level, kind) {
  if (level === 'off') return false;
  if (level === 'motion') return true;
  return kind === 'person' || kind === 'tamper';
}

/** @param {any} s */
function normalize(s = {}) {
  const n = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    armDelaySec: n(s.armDelaySec, 30),
    people: s.people !== false,
    motion: s.motion !== false,
    notify: ['person', 'motion', 'off'].includes(s.notify) ? s.notify : 'person',
    record: ['person', 'motion', 'off'].includes(s.record) ? s.record : 'person',
    postRollSec: n(s.postRollSec, 10),
    sensitivity: /** @type {'low'|'medium'|'high'} */ (['low', 'medium', 'high'].includes(s.sensitivity) ? s.sensitivity : 'medium'),
    confirmLocally: s.confirmLocally !== false,
    cooldownSec: n(s.cooldownSec, 60),
    quietHours: typeof s.quietHours === 'string' ? s.quietHours : '',
    announce: s.announce !== false,
    describe: !!s.describe,
  };
}

export class SecurityEngine {
  /**
   * @param {{ settings?: object, now?: () => number, newId?: (at: number) => string }} [o]
   */
  constructor(o = {}) {
    this._s = normalize(o.settings);
    this._now = o.now || (() => Date.now());
    let n = 0;
    this._newId = o.newId || ((/** @type {number} */ at) => `${at}-${(n++).toString(36).padStart(4, '0').slice(-4)}`);
    this._armed = false;
    this._arming = false;
    this._armingEndsAt = 0;
    /** when watching last started (the end of the exit delay, or an immediate arm) */
    this._watchingSince = 0;
    /** @type {Record<Kind, { active: boolean, since: number, ignored: boolean }>} */
    this._cam = { motion: { active: false, since: 0, ignored: false }, person: { active: false, since: 0, ignored: false }, tamper: { active: false, since: 0, ignored: false } };
    this._ptz = { moving: false, settleUntil: 0 };
    this._streamLive = false;
    this._localSuppressUntil = 0;
    this._detector = 'off';
    this._lastLocalAt = 0;
    /** @type {boolean[]} qualifying person boxes in the last detector samples */
    this._personHist = [];
    this._localPerson = false;
    this._localMotion = false;
    this._localBestScore = 0;
    /** @type {any} */
    this._active = null;
    /** @type {Record<Kind, number>} */
    this._cooldownUntil = { person: 0, motion: 0, tamper: 0 };
  }

  get state() {
    return {
      armed: this._armed,
      arming: this._arming,
      armingEndsAt: this._arming ? this._armingEndsAt : undefined,
      active: this._active ? this._summary(this._active) : null,
      cooldownUntil: { ...this._cooldownUntil },
    };
  }

  /** Watching (armed and past the exit delay). */
  get watching() {
    return this._armed && !this._arming;
  }

  /** @param {object} s @returns {Action[]} */
  setSettings(s) {
    this._s = normalize(s);
    const at = this._now();
    const out = [];
    if (this._active && this._active.kind === 'motion' && !this._s.motion) out.push(...this._end(at, 'motion events turned off'));
    return out;
  }

  /**
   * @param {boolean} armed @param {{ immediate?: boolean, at?: number }} [o]
   * @returns {Action[]}
   */
  arm(armed, o = {}) {
    const at = o.at ?? this._now();
    if (armed) {
      if (this._armed) {
        if (this._arming && o.immediate) {
          this._arming = false;
          this._startWatching(at);
          return [this._armedChanged(), ...this._evaluate(at)];
        }
        return [];
      }
      this._armed = true;
      this._clearLocal();
      // the camera's event state from before (the monitor only runs while armed) is not evidence
      this._resetCam();
      const delay = Math.max(0, this._s.armDelaySec) * 1000;
      this._arming = !o.immediate && delay > 0;
      this._armingEndsAt = this._arming ? at + delay : 0;
      const out = [this._armedChanged()];
      if (!this._arming) {
        this._startWatching(at);
        out.push(...this._evaluate(at));
      }
      return out;
    }
    if (!this._armed) return [];
    const out = this._active ? this._end(at, 'disarmed') : [];
    this._armed = false;
    this._arming = false;
    this._armingEndsAt = 0;
    this._resetCam();
    out.push(this._armedChanged());
    return out;
  }

  /**
   * The camera's event subscription stopped or was replaced (disarm, reconnect, sign-in
   * failure, the monitor restarting): its states are unknown now, so none of them is active.
   * @param {number} [at] @returns {Action[]}
   */
  resetCamera(at = this._now()) {
    this._resetCam();
    return this._evaluate(at);
  }

  _resetCam() {
    for (const c of Object.values(this._cam)) {
      c.active = false;
      c.ignored = false;
      c.since = 0;
    }
  }

  /**
   * Watching starts (the exit delay ended, or an immediate arm). Only evidence from now on counts:
   * camera states that are already active (the user walking out; firmwares that never send the
   * falling edge) are a baseline, ignored until they fall — like the episode of a PTZ move — and
   * the local person history starts again (the detector keeps running, so it stays "alive").
   * @param {number} at
   */
  _startWatching(at) {
    this._watchingSince = at;
    for (const c of Object.values(this._cam)) if (c.active) c.ignored = true;
    this._clearLocal();
  }

  /** @returns {Action} */
  _armedChanged() {
    /** @type {any} */
    const a = { type: 'armed-changed', armed: this._armed, arming: this._arming };
    if (this._arming) a.armingEndsAt = this._armingEndsAt;
    return a;
  }

  /**
   * A de-noised camera event edge. `baseline`: the state a new subscription started with
   * (ONVIF "Initialized"), not a change: active but ignored until it falls.
   * @param {{ kind: Kind, active: boolean, at?: number, baseline?: boolean }} e
   * @returns {Action[]}
   */
  onCamera(e) {
    const at = e.at ?? this._now();
    const c = this._cam[e.kind];
    if (!c) return [];
    const out = [];
    if (e.active && !c.active) {
      c.active = true;
      c.since = at;
      // our own pan/tilt move triggers the camera's motion detection: ignore that whole episode
      c.ignored = !!e.baseline || this._ptzSuppressed(at);
      if (!c.ignored && this.watching && e.kind !== 'tamper') out.push({ type: 'boost', untilMs: at + BOOST_MS });
    } else if (!e.active) {
      c.active = false;
      c.ignored = false;
    }
    out.push(...this._evaluate(at));
    return /** @type {Action[]} */ (out);
  }

  /**
   * A local detector sample from the worker (≤ 6/s).
   * @param {{ at?: number, motion?: { active: boolean, score?: number, global?: boolean }, persons?: Array<{ score: number, box: number[] }>, detector?: string }} d
   * @returns {Action[]}
   */
  onLocal(d) {
    const at = d.at ?? this._now();
    if (d.detector) this._detector = d.detector;
    this._lastLocalAt = at;
    if (d.motion?.global) {
      this._localSuppressUntil = Math.max(this._localSuppressUntil, at + GLOBAL_SUPPRESS_MS);
      this._clearLocal();
      return this._evaluate(at);
    }
    if (this._localSuppressed(at)) {
      this._clearLocal();
      return this._evaluate(at);
    }
    const thr = SENSITIVITY[this._s.sensitivity].personScore;
    const persons = Array.isArray(d.persons) ? d.persons : null;
    if (persons) {
      const good = persons.filter((p) => p.score >= thr && Array.isArray(p.box) && p.box[2] * p.box[3] >= PERSON_MIN_AREA);
      this._personHist = [...this._personHist.slice(-2), good.length > 0];
      this._localPerson = this._personHist.filter(Boolean).length >= 2;
      this._localBestScore = good.reduce((m, p) => Math.max(m, p.score), 0);
    }
    this._localMotion = !!d.motion?.active;
    return this._evaluate(at);
  }

  /** @param {{ moving: boolean, settleUntil?: number, at?: number }} p @returns {Action[]} */
  onPtz(p) {
    const at = p.at ?? this._now();
    this._ptz = { moving: !!p.moving, settleUntil: p.settleUntil || 0 };
    if (p.moving) this._clearLocal();
    return this._evaluate(at);
  }

  /** @param {'live'|'down'} state @param {number} [at] @returns {Action[]} */
  onStream(state, at = this._now()) {
    const live = state === 'live';
    if (live && !this._streamLive) this._localSuppressUntil = Math.max(this._localSuppressUntil, at + STREAM_SUPPRESS_MS);
    this._streamLive = live;
    this._clearLocal();
    return this._evaluate(at);
  }

  /** Time passes: the exit delay, the 6 s unconfirmed rule, post-roll ends. @param {number} [at] @returns {Action[]} */
  tick(at = this._now()) {
    const out = [];
    if (this._arming && at >= this._armingEndsAt) {
      this._arming = false;
      this._armingEndsAt = 0;
      this._startWatching(at);
      out.push(this._armedChanged());
    }
    out.push(...this._evaluate(at));
    return out;
  }

  // -------------------------------------------------------------------------------------------

  _clearLocal() {
    this._personHist = [];
    this._localPerson = false;
    this._localMotion = false;
    this._localBestScore = 0;
  }

  /** @param {number} at */
  _ptzSuppressed(at) {
    return this._ptz.moving || at < this._ptz.settleUntil;
  }

  /** @param {number} at */
  _localSuppressed(at) {
    return this._ptzSuppressed(at) || at < this._localSuppressUntil || !this._streamLive;
  }

  /** The local detector is running and recent. @param {number} at */
  _localAlive(at) {
    return this._detector === 'on' && this._streamLive && at - this._lastLocalAt < LOCAL_STALE_MS;
  }

  /** @param {number} at @returns {Action[]} */
  _evaluate(at) {
    if (!this.watching) return [];
    const s = this._s;
    const camSup = this._ptzSuppressed(at);
    const locSup = this._localSuppressed(at);
    const fresh = at - this._lastLocalAt < LOCAL_STALE_MS;
    const cam = (/** @type {Kind} */ k) => this._cam[k].active && !this._cam[k].ignored && !camSup;
    const camPerson = cam('person');
    const camMotion = cam('motion');
    const camTamper = cam('tamper');
    const locPerson = this._localPerson && !locSup && fresh;
    const locMotion = this._localMotion && !locSup && fresh;
    const localAlive = this._localAlive(at);
    let person = false;
    let unconfirmed = false;
    if (s.people) {
      if (locPerson) person = true;
      else if (camPerson && !s.confirmLocally) person = true;
      else if (camPerson && !localAlive && at - Math.max(this._cam.person.since, this._watchingSince) >= UNCONFIRMED_AFTER_MS) {
        person = true;
        unconfirmed = true;
      }
    }
    const motion = locMotion || camMotion || (!s.people && (locPerson || camPerson));
    const sources = [];
    if (camPerson) sources.push('camera-person');
    if (camMotion) sources.push('camera-motion');
    if (camTamper) sources.push('camera-tamper');
    if (locPerson) sources.push('local-person');
    if (locMotion) sources.push('local-motion');

    /** @type {Action[]} */
    const out = [];
    let ev = this._active;
    if (!ev) {
      /** @type {Kind|null} */
      const kind = person ? 'person' : camTamper ? 'tamper' : motion && s.motion ? 'motion' : null;
      if (!kind) return out;
      ev = {
        id: this._newId(at), kind, startedAt: at, sources: new Set(), unconfirmed: kind === 'person' && unconfirmed,
        maxScore: 0, notified: false, announced: false, alerted: new Set(), recording: false,
        lastPersonAt: 0, lastMotionAt: 0, lastTamperAt: 0, lastSnapAt: at, lastExtendAt: at,
      };
      this._active = ev;
      this._note(ev, at, { person, motion, tamper: camTamper, sources });
      out.push({ type: 'event-start', event: this._summary(ev) });
      if (covers(s.record, kind)) {
        ev.recording = true;
        out.push({ type: 'record-start', eventId: ev.id });
      }
      out.push({ type: 'snapshot', eventId: ev.id, purpose: 'alert' });
      out.push(...this._alert(ev, at));
      return out;
    }

    const before = JSON.stringify(this._summary(ev));
    const prevMax = ev.maxScore;
    this._note(ev, at, { person, motion, tamper: camTamper, sources });
    /** @type {Kind|null} */
    const upgrade = person && RANK.person > RANK[ev.kind] ? 'person' : camTamper && RANK.tamper > RANK[ev.kind] ? 'tamper' : null;
    if (upgrade) {
      ev.kind = upgrade;
      ev.unconfirmed = upgrade === 'person' && unconfirmed;
    } else if (ev.kind === 'person' && person && !unconfirmed && ev.unconfirmed) {
      ev.unconfirmed = false; // the local detector came back and agrees
    }
    if (upgrade) {
      out.push({ type: 'event-update', event: this._summary(ev) });
      if (!ev.recording && covers(s.record, upgrade)) {
        ev.recording = true;
        out.push({ type: 'record-start', eventId: ev.id });
      }
      out.push({ type: 'snapshot', eventId: ev.id, purpose: 'alert' });
      out.push(...this._alert(ev, at));
    } else if (JSON.stringify(this._summary(ev)) !== before) {
      out.push({ type: 'event-update', event: this._summary(ev) });
    }
    // a better picture of the person: a new "best" snapshot (at most every 2 s)
    if (locPerson && this._localBestScore > prevMax + 0.02 && at - ev.lastSnapAt >= BEST_SNAPSHOT_EVERY_MS) {
      ev.lastSnapAt = at;
      out.push({ type: 'snapshot', eventId: ev.id, purpose: 'best' });
    }
    // the end: no evidence of its kind for postRollSec
    const last = ev.kind === 'person' ? ev.lastPersonAt : ev.kind === 'tamper' ? Math.max(ev.lastTamperAt, ev.lastPersonAt) : ev.lastMotionAt;
    if (at - last >= s.postRollSec * 1000) {
      out.push(...this._end(at, 'post-roll'));
    } else if (ev.recording && at - ev.lastExtendAt >= EXTEND_EVERY_MS && (person || motion)) {
      ev.lastExtendAt = at;
      out.push({ type: 'record-extend', eventId: ev.id });
    }
    return out;
  }

  /** @param {any} ev @param {number} at @param {{ person: boolean, motion: boolean, tamper: boolean, sources: string[] }} e */
  _note(ev, at, e) {
    if (e.person) ev.lastPersonAt = at;
    if (e.motion || e.person) ev.lastMotionAt = at;
    if (e.tamper) ev.lastTamperAt = at;
    for (const src of e.sources) ev.sources.add(src);
    if (e.person && this._localBestScore) ev.maxScore = Math.max(ev.maxScore, this._localBestScore);
  }

  /**
   * notify / announce / describe, once per kind per event, when the kind's cooldown has passed;
   * the cooldown starts at the first of them.
   * @param {any} ev @param {number} at @returns {Action[]}
   */
  _alert(ev, at) {
    const s = this._s;
    /** @type {Kind} */
    const kind = ev.kind;
    const worthy = kind !== 'motion' || s.notify === 'motion';
    if (!worthy || ev.alerted.has(kind)) return [];
    ev.alerted.add(kind);
    if (at < this._cooldownUntil[kind]) return [];
    const quiet = inQuietHours(s.quietHours, at);
    /** @type {Action[]} */
    const out = [];
    if (covers(s.notify, kind)) {
      ev.notified = true;
      out.push({ type: 'notify', event: this._summary(ev), silent: quiet });
    }
    if (s.announce) {
      ev.announced = true;
      out.push({ type: 'announce', event: this._summary(ev), quiet });
    }
    if (s.describe && kind === 'person' && !quiet) out.push({ type: 'describe', event: this._summary(ev) });
    if (out.length) this._cooldownUntil[kind] = at + s.cooldownSec * 1000;
    return out;
  }

  /** @param {number} at @param {string} _why @returns {Action[]} */
  _end(at, _why) {
    const ev = this._active;
    if (!ev) return [];
    this._active = null;
    ev.endedAt = at;
    /** @type {Action[]} */
    const out = [];
    if (ev.recording) out.push({ type: 'record-stop', eventId: ev.id });
    out.push({ type: 'event-end', event: this._summary(ev) });
    return out;
  }

  /** @param {any} ev @returns {EventSummary} */
  _summary(ev) {
    /** @type {EventSummary} */
    const s = { id: ev.id, kind: ev.kind, startedAt: ev.startedAt, sources: [...ev.sources].sort(), notified: ev.notified, announced: ev.announced, acknowledged: false };
    if (ev.endedAt) s.endedAt = ev.endedAt;
    if (ev.unconfirmed) s.unconfirmed = true;
    if (ev.maxScore > 0) s.maxScore = Math.round(ev.maxScore * 100) / 100;
    return s;
  }
}
