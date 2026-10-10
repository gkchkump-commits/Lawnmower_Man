// Validation of every lm:wake:* IPC payload (contract-wake §6.1, §2.3). Main trusts nothing the
// renderer sends: the sender is checked by main.js (avatar window only), the shape here. Each
// validator returns the cleaned value or throws a short message.

import { LABELS } from './config.js';

/** The listening states the renderer reports (§6.4). */
export const WAKE_UI_STATES = Object.freeze(['off', 'unavailable', 'starting', 'paused', 'locked', 'blocked', 'muted', 'waiting', 'attention', 'listening', 'followup', 'look', 'busy', 'barge']);

/** Test clips: ≤ 60 s of 16 kHz mono PCM16 (§7.9). */
export const CLIP_MAX_SEC = 60;
export const CLIP_MAX_DATA = CLIP_MAX_SEC * 16000 * 2;
const CLIP_MAX_HEADER = 4096;
export const CLIP_MAX_HITS = 200;

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** For handlers that take no arguments. @param {unknown[]} args */
export function validateNoArgs(args) {
  if (args.length > 0 && !(args.length === 1 && args[0] === undefined)) throw new Error('This call takes no arguments');
}

/**
 * lm:wake:state: `{ state, reason? }` → the tray tooltip and checkbox.
 * @param {unknown} p @returns {{ state: string, reason: string }}
 */
export function validateUiState(p) {
  if (!isPlainObject(p)) throw new Error('expected { state, reason? }');
  if (typeof p.state !== 'string' || !WAKE_UI_STATES.includes(p.state)) throw new Error('unknown wake state');
  let reason = '';
  if (p.reason !== undefined && p.reason !== null) {
    if (typeof p.reason !== 'string') throw new Error('reason must be a string');
    reason = p.reason.replace(CONTROL, ' ').trim().slice(0, 120);
  }
  return { state: p.state, reason };
}

/** @param {unknown} v @returns {Buffer} */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('wav must be an ArrayBuffer');
}

/**
 * A RIFF/WAVE file of PCM16 mono 16 kHz, ≤ 60 s, whose sizes agree.
 * @param {Buffer} b
 * @returns {{ dataOffset: number, dataBytes: number, durationSec: number }}
 */
export function checkWav(b) {
  if (b.length < 44) throw new Error('the clip is not a WAV file (too short)');
  if (b.length > CLIP_MAX_DATA + CLIP_MAX_HEADER) throw new Error(`the clip is longer than ${CLIP_MAX_SEC} s`);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('the clip is not a RIFF/WAVE file');
  if (b.readUInt32LE(4) !== b.length - 8) throw new Error('the clip\'s RIFF size does not match its length');
  let p = 12;
  let fmt = false;
  for (let guard = 0; p + 8 <= b.length && guard < 16; guard++) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > b.length) throw new Error('the clip has a bad fmt chunk');
      const format = b.readUInt16LE(body);
      const channels = b.readUInt16LE(body + 2);
      const rate = b.readUInt32LE(body + 4);
      const byteRate = b.readUInt32LE(body + 8);
      const align = b.readUInt16LE(body + 12);
      const bits = b.readUInt16LE(body + 14);
      if (format !== 1) throw new Error('the clip must be PCM');
      if (channels !== 1) throw new Error('the clip must be mono');
      if (rate !== 16000) throw new Error('the clip must be 16 kHz');
      if (bits !== 16 || align !== 2 || byteRate !== 32000) throw new Error('the clip must be 16-bit');
      fmt = true;
    } else if (id === 'data') {
      if (!fmt) throw new Error('the clip\'s data comes before its format');
      if (body > CLIP_MAX_HEADER) throw new Error('the clip\'s header is too long');
      if (size % 2 !== 0 || body + size !== b.length) throw new Error('the clip\'s data size does not match its length');
      if (size > CLIP_MAX_DATA) throw new Error(`the clip is longer than ${CLIP_MAX_SEC} s`);
      return { dataOffset: body, dataBytes: size, durationSec: size / 32000 };
    }
    p = body + size + (size % 2);
  }
  throw new Error('the clip has no data chunk');
}

/**
 * lm:wake:save-clip: `{ wav, hits }`.
 * @param {unknown} p
 * @returns {{ wav: Buffer, durationSec: number, hits: Array<{ atSec: number, keyword: string, outcome: string }> }}
 */
export function validateSaveClip(p) {
  if (!isPlainObject(p)) throw new Error('expected { wav, hits }');
  const wav = toBuffer(p.wav);
  const { durationSec } = checkWav(wav);
  const raw = p.hits === undefined ? [] : p.hits;
  if (!Array.isArray(raw) || raw.length > CLIP_MAX_HITS) throw new Error(`hits must be a list of at most ${CLIP_MAX_HITS}`);
  const hits = raw.map((h) => {
    if (!isPlainObject(h)) throw new Error('each hit must be { atSec, keyword, outcome }');
    if (typeof h.atSec !== 'number' || !Number.isFinite(h.atSec) || h.atSec < 0 || h.atSec > CLIP_MAX_SEC + 5) throw new Error('hit.atSec must be a time inside the clip');
    if (typeof h.keyword !== 'string' || !LABELS.includes(h.keyword)) throw new Error('hit.keyword must be HEY_JADE, HEY_JUDE or JADE');
    // the renderer's outcomes: 'heard', 'woke', 'ignored: <reason>' (src/wake/feature.js); no path characters
    if (typeof h.outcome !== 'string' || !/^[a-z][a-z0-9 '_:-]{0,39}$/i.test(h.outcome)) throw new Error('hit.outcome must be a short word');
    return { atSec: Math.round(h.atSec * 1000) / 1000, keyword: h.keyword, outcome: h.outcome };
  });
  return { wav, durationSec, hits };
}
