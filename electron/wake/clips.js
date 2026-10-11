// "Record a test clip (30 s)…" (contract-wake §7.9): the only disk write of the wake word, and
// only on that explicit click. The renderer sends the WAV it recorded from its mic tap plus the
// stage-1 hits it saw; main validates both (validate.js) and writes
//   <Documents>/Lawnmower Man/Hey Jade tests/YYYYMMDD-HHMMSS.wav  (+ .json with the hits)
// under a name main chooses (never one from the renderer), then opens the folder, so the user can
// send the files for tuning (tools/wake/eval-folder.mjs).

import nodeFs from 'node:fs';
import path from 'node:path';

import { validateSaveClip } from './validate.js';

/** @param {string} documentsDir */
export function testClipsDir(documentsDir) {
  return path.join(documentsDir, 'Lawnmower Man', 'Hey Jade tests');
}

/** "20261010-094112" in local time. @param {Date} d */
export function clipStamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Validate and write a test clip. Never throws: `{ ok: false, error }` instead.
 * @param {unknown} payload
 * @param {{ documentsDir: string, now?: () => Date, fs?: typeof nodeFs, openPath?: (p: string) => Promise<string>|string, appVersion?: string, log?: (level: string, msg: string) => void }} o
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function saveTestClip(payload, o) {
  const fs = o.fs || nodeFs;
  const log = o.log || (() => {});
  let clip;
  try {
    clip = validateSaveClip(payload);
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message };
  }
  const dir = testClipsDir(o.documentsDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = clipStamp((o.now || (() => new Date()))());
    let base = stamp;
    for (let i = 2; fs.existsSync(path.join(dir, `${base}.wav`)) && i < 100; i++) base = `${stamp}-${i}`;
    const wavPath = path.join(dir, `${base}.wav`);
    fs.writeFileSync(wavPath, clip.wav, { flag: 'wx' });
    const meta = { version: 1, app: o.appVersion || '', sampleRate: 16000, durationSec: Math.round(clip.durationSec * 100) / 100, savedAt: new Date().toISOString(), hits: clip.hits };
    fs.writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
    log('info', `[wake] test clip saved: ${wavPath} (${meta.durationSec} s, ${clip.hits.length} hits)`);
    if (o.openPath) {
      try {
        const err = await o.openPath(dir);
        if (err) log('warn', `[wake] could not open ${dir}: ${err}`);
      } catch (err) {
        log('warn', `[wake] could not open ${dir}: ${/** @type {Error} */ (err).message}`);
      }
    }
    return { ok: true, path: wavPath };
  } catch (err) {
    log('warn', `[wake] saving a test clip failed: ${/** @type {Error} */ (err).message}`);
    return { ok: false, error: `The clip could not be saved: ${/** @type {Error} */ (err).message}` };
  }
}
