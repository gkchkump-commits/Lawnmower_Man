// ClipRecorder: stream-copied event clips with pre-roll (contract §8.7). Pure Node.
//
// A ring of whole GOPs (go2rtc's fragments, untouched) is kept so a clip can start a few
// seconds BEFORE the event: the newest GOPs while (newest dts − start of the second-oldest GOP)
// ≥ preRollSec, at most 32 MB. A clip = the init segment (ftyp+moov) + the fragments, each
// renumbered (mfhd 1..n) and shifted to start at 0 (tfdt); default-base-is-moof keeps the data
// offsets valid. It is written as <base>.mp4.part and renamed to .mp4 when done. At maxClipSec
// (or when the stream reconnects) it rolls over, on a keyframe and without a gap, to a
// follow-up clip of the same event. Disk errors end the clip; the event is still listed.

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import path from 'node:path';

import { rewriteFragment } from './fmp4.js';
import { eventBase } from './event-store.js';

export const MAX_RING_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {{ id: string, rel: string, file: string, bytes: number, durationSec: number, reason: string, incomplete?: boolean }} ClipInfo
 * @typedef {{ startDts: number, endDts: number, bytes: number, fragments: Buffer[] }} Gop
 */

export class ClipRecorder extends EventEmitter {
  /**
   * @param {{ getDir: () => string, getSettings: () => { preRollSec: number, maxClipSec: number }, fs?: typeof nodeFs,
   *   log?: (level: string, msg: string) => void, now?: () => number, maxRingBytes?: number }} o
   */
  constructor(o) {
    super();
    this._getDir = o.getDir;
    this._getSettings = o.getSettings;
    this._fs = o.fs || nodeFs;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._maxRing = o.maxRingBytes ?? MAX_RING_BYTES;
    /** @type {import('./fmp4.js').TrackInit|null} */
    this._init = null;
    /** @type {Gop[]} */
    this._ring = [];
    this._ringBytes = 0;
    /** @type {any} the clip being written */
    this._clip = null;
  }

  get recording() {
    return !!this._clip;
  }

  /** The event being recorded, if any. */
  get eventId() {
    return this._clip?.id || null;
  }

  /** The base path of the clip being written (retention must not touch it). */
  get activeBase() {
    return this._clip ? this._clip.rel.replace(/\.mp4$/, '') : null;
  }

  /** A new stream generation: fresh ring; a running clip continues in a follow-up file. @param {import('./fmp4.js').TrackInit} init */
  onInit(init) {
    this._init = init;
    this._ring = [];
    this._ringBytes = 0;
    if (this._clip) this._rollover('reconnect');
  }

  /** @param {import('./fmp4.js').Sample} s */
  onSample(s) {
    if (!this._init || s.fragIndex !== 0) return; // a fragment is handled once, with its first sample
    const ts = this._init.timescale;
    // --- the pre-roll ring (whole GOPs, starting at a keyframe)
    if (s.key) this._ring.push({ startDts: s.dts, endDts: s.dts + s.duration, bytes: 0, fragments: [] });
    const gop = this._ring[this._ring.length - 1];
    if (gop) {
      gop.fragments.push(s.fragment);
      gop.bytes += s.fragment.length;
      gop.endDts = Math.max(gop.endDts, s.dts + s.duration);
      this._ringBytes += s.fragment.length;
      const pre = Math.max(0, Number(this._getSettings()?.preRollSec ?? 5)) * ts;
      while (this._ring.length >= 2 && gop.endDts - this._ring[1].startDts >= pre) this._dropOldest();
      while (this._ringBytes > this._maxRing && this._ring.length > 1) this._dropOldest();
    }
    // --- the clip
    const c = this._clip;
    if (!c || c.failed) return;
    if (c.waitingKey) {
      if (!s.key) return;
      c.waitingKey = false;
      c.firstDts = s.dts;
    }
    const maxSec = Math.max(1, Number(this._getSettings()?.maxClipSec ?? 120)); // settings keep it ≥ 10
    if (s.key && c.fragments > 0 && (s.dts - c.firstDts) / ts >= maxSec) {
      this._rollover('max-length', s);
      return;
    }
    this._writeFragment(c, s.fragment, s.dts, s.duration);
  }

  _dropOldest() {
    const g = this._ring.shift();
    if (g) this._ringBytes -= g.bytes;
  }

  /**
   * Start recording an event (pre-roll from the ring). null when there is no stream yet or the
   * file cannot be created.
   * @param {string} eventId @param {{ kind: 'person'|'motion'|'tamper', startedAt?: number }} o
   * @returns {{ file: string, rel: string }|null}
   */
  start(eventId, o) {
    if (this._clip && this._clip.id === eventId) return { file: this._clip.file, rel: this._clip.rel };
    if (this._clip) this.stop(this._clip.id, { reason: 'new event' }).catch(() => {});
    if (!this._init) return null;
    const clip = this._open(eventId, o.kind, eventBase(eventId, o.kind), this._init);
    if (!clip) return null;
    this._clip = clip;
    if (this._ring.length) {
      clip.firstDts = this._ring[0].startDts;
      clip.waitingKey = false;
      for (const g of this._ring) {
        let dts = g.startDts;
        for (const f of g.fragments) {
          this._writeFragment(clip, f, dts, 0);
          dts = g.endDts;
        }
      }
      clip.lastEnd = this._ring[this._ring.length - 1].endDts;
    }
    return { file: clip.file, rel: clip.rel };
  }

  /** More evidence: keep recording (the recorder records until stop(); kept for the contract). @param {string} _eventId */
  extend(_eventId) {}

  /**
   * Finish the event's clip.
   * @param {string} eventId @param {{ reason?: string }} [o]
   * @returns {Promise<ClipInfo|null>}
   */
  async stop(eventId, o = {}) {
    const c = this._clip;
    if (!c || c.id !== eventId) return null;
    this._clip = null;
    return this._finish(c, o.reason || 'stop');
  }

  /**
   * End the current file and continue the same event in a new one (on this keyframe `s`, or on
   * the next one after a reconnect).
   * @param {string} reason @param {import('./fmp4.js').Sample} [s]
   */
  _rollover(reason, s) {
    const c = this._clip;
    if (!c || !this._init) return;
    const at = this._now();
    let rel = eventBase(c.id, c.kind, at);
    if (rel === c.rel.replace(/\.mp4$/, '')) rel = eventBase(c.id, c.kind, at + 1000);
    const next = this._open(c.id, c.kind, rel, this._init);
    this._clip = next;
    this._finish(c, reason).catch(() => {});
    if (!next) return;
    if (s) {
      next.waitingKey = false;
      next.firstDts = s.dts;
      this._writeFragment(next, s.fragment, s.dts, s.duration);
    }
  }

  /**
   * @param {string} id @param {'person'|'motion'|'tamper'} kind @param {string} base @param {import('./fmp4.js').TrackInit} init
   */
  _open(id, kind, base, init) {
    const rel = `${base}.mp4`;
    const file = path.join(this._getDir(), ...rel.split('/'));
    const part = `${file}.part`;
    let fd;
    try {
      this._fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = this._fs.openSync(part, 'w');
    } catch (err) {
      this._log('warn', `[tapo] cannot create the clip ${rel}: ${/** @type {Error} */ (err).message}`);
      this.emit('error', err);
      return null;
    }
    const clip = {
      id, kind, rel, file, part, fd, timescale: init.timescale, seq: 0, firstDts: 0, lastEnd: 0, bytes: 0, fragments: 0,
      waitingKey: true, failed: false, incomplete: false, pending: 0, queue: /** @type {Promise<void>} */ (Promise.resolve()),
    };
    this._enqueue(clip, init.initSegment);
    this.emit('clip-start', { id, file, rel });
    this._log('info', `[tapo] recording ${rel}`);
    return clip;
  }

  /** @param {any} c @param {Buffer} fragment @param {number} dts @param {number} duration */
  _writeFragment(c, fragment, dts, duration) {
    let out;
    try {
      out = rewriteFragment(fragment, { seq: ++c.seq, baseTime: c.firstDts });
    } catch (err) {
      this._log('debug', `[tapo] clip: skipping a fragment (${/** @type {Error} */ (err).message})`);
      return;
    }
    c.fragments++;
    c.lastEnd = Math.max(c.lastEnd, dts + duration);
    this._enqueue(c, out);
  }

  /** Sequential async writes; a disk that cannot keep up (or fails) ends the clip. @param {any} c @param {Buffer} buf */
  _enqueue(c, buf) {
    if (c.failed) return;
    if (c.pending + buf.length > MAX_PENDING_BYTES) {
      this._fail(c, new Error('the disk is not keeping up'));
      return;
    }
    c.pending += buf.length;
    c.queue = c.queue.then(() => new Promise((resolve) => {
      if (c.failed) return resolve(undefined);
      this._fs.write(c.fd, buf, 0, buf.length, null, (err) => {
        c.pending -= buf.length;
        if (err) this._fail(c, err);
        else c.bytes += buf.length;
        resolve(undefined);
      });
    }));
  }

  /** @param {any} c @param {Error} err */
  _fail(c, err) {
    if (c.failed) return;
    c.failed = true;
    c.incomplete = true;
    this._log('warn', `[tapo] recording ${c.rel} failed: ${err.message}`);
    this.emit('error', err);
  }

  /** @param {any} c @param {string} reason @returns {Promise<ClipInfo|null>} */
  async _finish(c, reason) {
    await c.queue;
    await new Promise((resolve) => this._fs.close(c.fd, () => resolve(undefined)));
    if (c.bytes === 0 || c.fragments === 0) {
      // nothing but (at most) the header: no clip
      try { this._fs.rmSync(c.part, { force: true }); } catch { /* ignore */ }
      this.emit('clip-end', { id: c.id, file: c.file, rel: c.rel, bytes: 0, durationSec: 0, reason, empty: true });
      return null;
    }
    try {
      this._fs.renameSync(c.part, c.file);
    } catch (err) {
      this._log('warn', `[tapo] could not finish ${c.rel}: ${/** @type {Error} */ (err).message}`);
      this.emit('error', err);
      return null;
    }
    /** @type {ClipInfo} */
    const info = { id: c.id, rel: c.rel, file: c.file, bytes: c.bytes, durationSec: Math.round(((c.lastEnd - c.firstDts) / c.timescale) * 10) / 10, reason };
    if (c.incomplete) info.incomplete = true;
    this._log('info', `[tapo] clip ${c.rel}: ${info.durationSec} s, ${Math.round(info.bytes / 1024)} KB (${reason})`);
    this.emit('clip-end', info);
    return info;
  }

  /** Finish whatever is being written (quit). */
  async close() {
    const c = this._clip;
    this._clip = null;
    if (c) await this._finish(c, 'quit').catch(() => {});
  }
}
