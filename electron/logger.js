// Minimal file + console logger for the main process. On Windows a GUI app has no visible
// console, so <userData>/logs/main.log is where problems (CLI not found, voice crashes, GPU info)
// can be read. Size-rotated (main.log → main.old.log). Debug lines only with LAWNMOWER_DEBUG=1.

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {{ dir?: string|null, fileName?: string, maxBytes?: number, level?: keyof LEVELS, console?: boolean }} [o]
 * @returns {((level: keyof LEVELS, msg: string) => void) & { file: string|null, dir: string|null }}
 */
export function createLogger(o = {}) {
  const min = LEVELS[o.level || (process.env.LAWNMOWER_DEBUG ? 'debug' : 'info')] ?? 20;
  const toConsole = o.console !== false;
  const maxBytes = o.maxBytes ?? 1024 * 1024;
  let file = null;
  let size = 0;
  if (o.dir) {
    try {
      fs.mkdirSync(o.dir, { recursive: true });
      file = path.join(o.dir, o.fileName || 'main.log');
      try { size = fs.statSync(file).size; } catch { size = 0; }
    } catch {
      file = null;
    }
  }

  /** @param {keyof LEVELS} level @param {string} msg */
  const log = (level, msg) => {
    if ((LEVELS[level] ?? 20) < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (toConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(line);
    }
    if (!file) return;
    try {
      if (size > maxBytes) {
        const old = file.replace(/\.log$/, '.old.log');
        try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
        fs.renameSync(file, old);
        size = 0;
      }
      const data = `${line}\n`;
      fs.appendFileSync(file, data);
      size += Buffer.byteLength(data);
    } catch {
      /* logging must never throw */
    }
  };
  return Object.assign(log, { file, dir: o.dir || null });
}
