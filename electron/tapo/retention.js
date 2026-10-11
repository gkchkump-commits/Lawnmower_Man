// Clip retention (contract §8.7): delete events older than security.retentionDays, then the
// oldest ones while the folder is over security.maxStorageGB; stale .part files (a crash mid
// recording) after an hour. Pure Node.
//
// It only ever touches files whose relative path matches RETENTION_RE (our own naming) under the
// clips folder, never follows links, and removes day folders it emptied. The files of one event
// (.mp4, .jpg, .json) go together.

import nodeFs from 'node:fs/promises';
import path from 'node:path';

export const RETENTION_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{6})-(person|motion|tamper)-([a-z0-9]{4})\.(mp4|mp4\.part|jpg|json)$/;
export const STALE_PART_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ rel: string, size: number, mtimeMs: number }} ClipFile
 */

/** "2026-10-10/140312-person-a1b2" → local time of the event. @param {string} base */
function baseTime(base) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\/(\d{2})(\d{2})(\d{2})-/.exec(base);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** @param {string} rel */
function baseOf(rel) {
  return rel.replace(/\.(mp4\.part|mp4|jpg|json)$/, '');
}

/**
 * Which files to delete (pure).
 * @param {ClipFile[]} entries
 * @param {{ now: number, retentionDays: number, maxBytes: number, keep?: Set<string> }} o  keep: bases never deleted (recording now)
 * @returns {string[]} relative paths
 */
export function planDeletions(entries, o) {
  const keep = o.keep || new Set();
  /** @type {Set<string>} */
  const del = new Set();
  /** @type {Map<string, { files: ClipFile[], time: number, bytes: number }>} */
  const groups = new Map();
  for (const e of entries) {
    if (!RETENTION_RE.test(e.rel)) continue;
    const base = baseOf(e.rel);
    if (keep.has(base)) continue;
    if (e.rel.endsWith('.part') && o.now - e.mtimeMs > STALE_PART_MS) {
      del.add(e.rel);
      continue;
    }
    let g = groups.get(base);
    if (!g) {
      const t = baseTime(base);
      g = { files: [], time: Number.isFinite(t) ? t : e.mtimeMs, bytes: 0 };
      groups.set(base, g);
    }
    g.files.push(e);
    g.bytes += e.size;
  }
  const cutoff = o.now - Math.max(1, o.retentionDays) * DAY_MS;
  const live = [];
  for (const g of groups.values()) {
    if (g.time < cutoff) for (const f of g.files) del.add(f.rel);
    else live.push(g);
  }
  live.sort((a, b) => a.time - b.time);
  let total = live.reduce((a, g) => a + g.bytes, 0);
  for (const g of live) {
    if (total <= o.maxBytes) break;
    for (const f of g.files) del.add(f.rel);
    total -= g.bytes;
  }
  return [...del];
}

/**
 * List our files under `dir` (no links followed).
 * @param {string} dir @param {typeof nodeFs} fs
 * @returns {Promise<ClipFile[]>}
 */
export async function listClipFiles(dir, fs = nodeFs) {
  /** @type {ClipFile[]} */
  const out = [];
  let days = [];
  try {
    days = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of days) {
    if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue;
    let files = [];
    try {
      files = await fs.readdir(path.join(dir, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      const rel = `${d.name}/${f.name}`;
      if (!f.isFile() || !RETENTION_RE.test(rel)) continue;
      try {
        const st = await fs.lstat(path.join(dir, d.name, f.name));
        if (st.isFile()) out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* gone meanwhile */ }
    }
  }
  return out;
}

/**
 * Apply the retention rules to the clips folder.
 * @param {{ dir: string, settings: { retentionDays: number, maxStorageGB: number }, fs?: typeof nodeFs, log?: (level: string, msg: string) => void,
 *   now?: number, keep?: Set<string> }} o
 * @returns {Promise<{ deleted: string[], bytes: number, clips: number }>}
 */
export async function runRetention(o) {
  const fs = o.fs || nodeFs;
  const log = o.log || (() => {});
  const entries = await listClipFiles(o.dir, fs);
  const del = planDeletions(entries, {
    now: o.now ?? Date.now(),
    retentionDays: o.settings.retentionDays,
    maxBytes: o.settings.maxStorageGB * 1024 ** 3,
    keep: o.keep,
  });
  const gone = new Set();
  for (const rel of del) {
    try {
      await fs.rm(path.join(o.dir, ...rel.split('/')), { force: true });
      gone.add(rel);
    } catch (err) {
      log('warn', `[tapo] retention: could not delete ${rel}: ${/** @type {Error} */ (err).message}`);
    }
  }
  if (gone.size) log('info', `[tapo] retention removed ${gone.size} file(s)`);
  // day folders we emptied
  for (const day of new Set([...gone].map((r) => r.split('/')[0]))) {
    const p = path.join(o.dir, day);
    try {
      if ((await fs.readdir(p)).length === 0) await fs.rmdir(p);
    } catch { /* not empty, or gone */ }
  }
  const left = entries.filter((e) => !gone.has(e.rel));
  return { deleted: [...gone], bytes: left.reduce((a, e) => a + e.size, 0), clips: left.filter((e) => e.rel.endsWith('.mp4')).length };
}
