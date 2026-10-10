// Security events on disk (contract §8.7/§8.8): one JSON record per event next to its clip(s)
// and snapshot, under <clips dir>/<YYYY-MM-DD>/<HHMMSS>-<kind>-<id4>.{json,mp4,jpg}. The index
// is built by scanning the .json files (cached in memory, updated on every write), so there is
// no database. Pure Node.
//
// Names use local time (what the user sees in Explorer); the kind in the name is the kind the
// event started as (a motion event that turns out to be a person keeps its file names).

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLIP_URL_BASE = 'app://lawnmower/__clips/';
export const BASE_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{6})-(person|motion|tamper)-([a-z0-9]{4})$/;

/** @param {number} n @param {number} [w] */
const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * "20261010-140312-a1b2" (local time + 4 random [a-z0-9]).
 * @param {number} at @param {() => string} [rand4]
 */
export function newEventId(at, rand4 = () => crypto.randomBytes(4).toString('hex').slice(0, 4)) {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand4()}`;
}

/**
 * The relative base path of an event's files (no extension). A follow-up clip (`at` given) gets
 * its own time of day.
 * @param {string} id @param {'person'|'motion'|'tamper'} kind @param {number} [at]
 */
export function eventBase(id, kind, at) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{6})-([a-z0-9]{4})$/.exec(id);
  if (!m) throw new Error(`bad event id ${id}`);
  let time = m[4];
  let date = `${m[1]}-${m[2]}-${m[3]}`;
  if (at !== undefined) {
    const d = new Date(at);
    date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  return `${date}/${time}-${kind}-${m[5]}`;
}

/** @param {string} rel posix relative path @returns {string} */
export function clipUrl(rel) {
  return CLIP_URL_BASE + rel.split('/').map(encodeURIComponent).join('/');
}

/**
 * @typedef {object} EventRecord   the <base>.json file (contract §8.8)
 * @property {1} v
 * @property {string} id
 * @property {string} camera
 * @property {'person'|'motion'|'tamper'} kind
 * @property {string} startedAt ISO
 * @property {string} [endedAt]
 * @property {number} [durationSec]
 * @property {string[]} sources
 * @property {boolean} unconfirmed
 * @property {number} [maxScore]
 * @property {{ x: number, y: number }|null} [ptz]
 * @property {string} [preset]
 * @property {string} [clip]       relative path of the first clip
 * @property {string[]} [clips]    all clips (a long event rolls over)
 * @property {string} [snapshot]
 * @property {number} [bytes]
 * @property {boolean} notified
 * @property {boolean} announced
 * @property {string} described     reserved ("" in v1)
 * @property {boolean} acknowledged
 * @property {string} base          relative base path of the record
 */

/** @param {EventRecord} r */
export function toSummary(r) {
  const startedAt = Date.parse(r.startedAt);
  /** @type {Record<string, any>} */
  const s = {
    id: r.id,
    kind: r.kind,
    startedAt,
    sources: [...(r.sources || [])],
    notified: !!r.notified,
    announced: !!r.announced,
    acknowledged: !!r.acknowledged,
  };
  if (r.endedAt) s.endedAt = Date.parse(r.endedAt);
  if (r.unconfirmed) s.unconfirmed = true;
  if (typeof r.maxScore === 'number') s.maxScore = Math.round(r.maxScore * 100) / 100;
  if (r.preset) s.preset = r.preset;
  if (r.ptz !== undefined) s.ptz = r.ptz;
  if (r.clip) s.clipUrl = clipUrl(r.clip);
  if (r.snapshot) s.snapshotUrl = clipUrl(r.snapshot);
  if (typeof r.durationSec === 'number') s.durationSec = r.durationSec;
  if (typeof r.bytes === 'number') s.bytes = r.bytes;
  if (r.described) s.described = r.described;
  return s;
}

export class EventStore extends EventEmitter {
  /**
   * @param {{ getDir: () => string, fs?: typeof nodeFs, log?: (level: string, msg: string) => void, now?: () => number }} o
   */
  constructor(o) {
    super();
    this._getDir = o.getDir;
    this._fs = o.fs || nodeFs;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    /** @type {Map<string, EventRecord>} */
    this._index = new Map();
    this._scannedDir = '';
    /** serialize writes per event @type {Map<string, Promise<void>>} */
    this._writes = new Map();
    /** @type {Promise<void>|null} */
    this._scanning = null;
    /** ids written during the running scan @type {Set<string>|null} */
    this._touched = null;
    this._tmpSeq = 0;
  }

  get dir() {
    return this._getDir();
  }

  /**
   * (Re)build the index from the .json files of the clips folder. Concurrent calls share one
   * scan; records written while it runs (or still being written) keep their in-memory state.
   */
  scan() {
    if (this._scanning) return this._scanning;
    const dir = this.dir;
    /** @type {Map<string, EventRecord>} */
    const next = new Map();
    /** @type {Set<string>} */
    const touched = new Set();
    this._touched = touched;
    this._scanning = this._readAll(dir, next).then(() => {
      if (dir === this._scannedDir) {
        for (const [id, r] of this._index) if (touched.has(id) || this._writes.has(id)) next.set(id, r);
        for (const id of touched) if (!this._index.has(id)) next.delete(id); // removed meanwhile
      }
      this._index = next;
      this._scannedDir = dir;
    }).finally(() => {
      this._scanning = null;
      this._touched = null;
    });
    return this._scanning;
  }

  /** @param {string} dir @param {Map<string, EventRecord>} into */
  async _readAll(dir, into) {
    let days = [];
    try {
      days = (await this._fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name);
    } catch {
      return;
    }
    for (const day of days) {
      let files = [];
      try {
        files = await this._fs.readdir(path.join(dir, day));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/^\d{6}-(person|motion|tamper)-[a-z0-9]{4}\.json$/.test(f)) continue;
        try {
          const r = JSON.parse(await this._fs.readFile(path.join(dir, day, f), 'utf8'));
          if (r && r.v === 1 && typeof r.id === 'string') {
            r.base = `${day}/${f.slice(0, -5)}`;
            into.set(r.id, r);
          }
        } catch (err) {
          this._log('debug', `[tapo] skipping ${day}/${f}: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
  }

  async _ensureScanned() {
    if (this._scannedDir !== this.dir) await this.scan();
  }

  /** @param {string} id */
  _touch(id) {
    this._touched?.add(id);
  }

  /** @param {string} id */
  get(id) {
    return this._index.get(id) || null;
  }

  /**
   * Newest first.
   * @param {{ beforeMs?: number, sinceMs?: number, kinds?: string[], limit?: number }} [q]
   */
  async list(q = {}) {
    await this._ensureScanned();
    let all = [...this._index.values()].map(toSummary).sort((a, b) => b.startedAt - a.startedAt);
    if (q.kinds && q.kinds.length) all = all.filter((e) => q.kinds?.includes(e.kind));
    if (q.sinceMs !== undefined) all = all.filter((e) => e.startedAt >= /** @type {number} */ (q.sinceMs));
    if (q.beforeMs !== undefined) all = all.filter((e) => e.startedAt < /** @type {number} */ (q.beforeMs));
    const limit = Math.max(1, Math.min(200, q.limit ?? 50));
    return { events: all.slice(0, limit), total: all.length };
  }

  /** Write (create or update) an event record; fields merge into the existing one. @param {Partial<EventRecord> & { id: string }} patch */
  async upsert(patch) {
    await this._ensureScanned();
    const prev = this._index.get(patch.id);
    /** @type {EventRecord} */
    const rec = /** @type {any} */ ({ v: 1, sources: [], unconfirmed: false, notified: false, announced: false, described: '', acknowledged: false, ...(prev || {}), ...patch });
    if (!rec.base) rec.base = eventBase(rec.id, rec.kind);
    this._index.set(rec.id, rec);
    this._touch(rec.id);
    await this._write(rec);
    this.emit('change', rec);
    return rec;
  }

  /** @param {EventRecord} rec */
  _write(rec) {
    const run = async () => {
      const file = path.join(this.dir, ...`${rec.base}.json`.split('/'));
      await this._fs.mkdir(path.dirname(file), { recursive: true });
      const { base: _base, ...data } = rec;
      const tmp = `${file}.${process.pid}.tmp`;
      await this._fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
      await this._fs.rename(tmp, file);
    };
    const prev = this._writes.get(rec.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this._writes.set(rec.id, next);
    next.finally(() => {
      if (this._writes.get(rec.id) === next) this._writes.delete(rec.id);
    }).catch(() => {});
    return next.catch((err) => {
      this._log('warn', `[tapo] could not write the event record ${rec.base}.json: ${err.message}`);
    });
  }

  /** Save the event's snapshot as <base>.jpg. @param {string} id @param {Buffer} jpeg */
  async writeSnapshot(id, jpeg) {
    // the event's first record may still be on its way (the very first scan of the folder)
    await this._ensureScanned();
    const rec = this._index.get(id);
    if (!rec) return null;
    const rel = `${rec.base}.jpg`;
    const file = path.join(this.dir, ...rel.split('/'));
    // two snapshots of one event can be on their way at once (alert + best): own temp names
    const tmp = `${file}.${process.pid}-${++this._tmpSeq}.tmp`;
    try {
      await this._fs.mkdir(path.dirname(file), { recursive: true });
      await this._fs.writeFile(tmp, jpeg);
      await this._fs.rename(tmp, file);
    } catch (err) {
      await this._fs.rm(tmp, { force: true }).catch(() => {});
      this._log('warn', `[tapo] could not save the snapshot: ${/** @type {Error} */ (err).message}`);
      return null;
    }
    if (rec.snapshot !== rel) await this.upsert({ id, snapshot: rel });
    return file;
  }

  /** Absolute path of a relative clip path. @param {string} rel */
  abs(rel) {
    return path.join(this.dir, ...rel.split('/'));
  }

  /** Delete the event's files (record, clips, snapshot). @param {string} id */
  async remove(id) {
    await this._ensureScanned();
    const rec = this._index.get(id);
    if (!rec) return false;
    const rels = new Set([`${rec.base}.json`, `${rec.base}.jpg`, `${rec.base}.mp4`, ...(rec.clips || []), ...(rec.clip ? [rec.clip] : []), ...(rec.snapshot ? [rec.snapshot] : [])]);
    for (const rel of rels) await this._fs.rm(this.abs(rel), { force: true }).catch(() => {});
    this._index.delete(id);
    this._touch(id);
    this.emit('remove', id);
    return true;
  }

  /** @param {string} id */
  async ack(id) {
    if (!this._index.has(id)) return false;
    await this.upsert({ id, acknowledged: true });
    return true;
  }

  /** Forget records whose files retention deleted. @param {Set<string>} bases */
  dropBases(bases) {
    for (const [id, r] of this._index) if (bases.has(r.base)) this._index.delete(id);
  }

  /** Events today (local) and the newest start. */
  counts() {
    const d = new Date(this._now());
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let today = 0;
    let last = 0;
    for (const r of this._index.values()) {
      const t = Date.parse(r.startedAt);
      if (t >= start) today++;
      if (t > last) last = t;
    }
    return { todayCount: today, lastEventAt: last || undefined };
  }
}
