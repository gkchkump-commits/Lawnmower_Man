// Validators for the home camera's IPC payloads (contract §6.1) and for what the camera window's
// worker sends back over its MessagePort (§9.3). Each returns a clean value or throws an Error
// with a short, user-presentable message (worker messages: null when invalid). Pure.

import { isPlainObject } from '../ipc-validate.js';

const DIRS = ['left', 'right', 'up', 'down'];
const AMOUNTS = ['small', 'medium', 'large'];
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const EVENT_ID = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

/** @param {unknown} v @param {string} what @returns {Record<string, any>} */
function obj(v, what) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new Error(`${what} must be an object`);
  return v;
}

/** @param {Record<string, any>} v @param {string[]} allowed @param {string} what */
function onlyKeys(v, allowed, what) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`${what}: unknown field "${k.slice(0, 40)}"`);
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {string} what */
function finite(v, lo, hi, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
  return v;
}

/** @param {unknown} v @param {number} max @param {string} what */
function text(v, max, what) {
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  const s = v.trim();
  if (!s) throw new Error(`${what} is empty`);
  if (s.length > max || /[\0-\x1f\x7f]/.test(s)) throw new Error(`${what} is not valid`);
  return s;
}

/**
 * A pan/tilt command from a window.
 * @param {unknown} v @returns {import('./ptz.js').PtzCommand}
 */
export function validatePtzCommand(v) {
  const c = obj(v, 'Camera command');
  switch (c.op) {
    case 'nudge':
      onlyKeys(c, ['op', 'dir', 'amount'], 'nudge');
      if (!DIRS.includes(c.dir)) throw new Error('Direction must be left, right, up or down');
      if (!AMOUNTS.includes(c.amount)) throw new Error('Amount must be small, medium or large');
      return { op: 'nudge', dir: c.dir, amount: c.amount };
    case 'hold':
      onlyKeys(c, ['op', 'dir'], 'hold');
      if (!DIRS.includes(c.dir)) throw new Error('Direction must be left, right, up or down');
      return { op: 'hold', dir: c.dir };
    case 'heartbeat':
    case 'release':
    case 'stop':
    case 'home':
      onlyKeys(c, ['op'], c.op);
      return /** @type {any} */ ({ op: c.op });
    case 'center':
      onlyKeys(c, ['op', 'u', 'v'], 'center');
      return { op: 'center', u: finite(c.u, 0, 1, 'u'), v: finite(c.v, 0, 1, 'v') };
    case 'preset':
      onlyKeys(c, ['op', 'token'], 'preset');
      if (typeof c.token !== 'string' || !TOKEN.test(c.token)) throw new Error('Invalid preset');
      return { op: 'preset', token: c.token };
    case 'preset-name':
      onlyKeys(c, ['op', 'name'], 'preset-name');
      return { op: 'preset-name', name: text(c.name, 64, 'Position name') };
    default:
      throw new Error('Unknown camera command');
  }
}

/** @param {unknown} v @returns {{ username: string, password: string }} */
export function validateCredentialsPayload(v) {
  const c = obj(v, 'Credentials');
  onlyKeys(c, ['username', 'password'], 'credentials');
  const username = text(c.username, 64, 'The Camera Account user name');
  if (/\s/.test(username)) throw new Error('The user name cannot contain spaces');
  if (typeof c.password !== 'string' || !c.password) throw new Error('Enter the Camera Account password.');
  if (c.password.length > 128 || /[\0\r\n]/.test(c.password)) throw new Error('That password is not valid (at most 128 characters, no line breaks).');
  return { username, password: c.password };
}

/** Test with unsaved values. @param {unknown} v */
export function validateTestOverride(v) {
  const c = obj(v, 'Test options');
  onlyKeys(c, ['host', 'onvifPort', 'rtspPort', 'username', 'password'], 'test');
  /** @type {{ host?: string, onvifPort?: number, rtspPort?: number, username?: string, password?: string }} */
  const out = {};
  if (c.host !== undefined) {
    if (typeof c.host !== 'string' || c.host.length > 253) throw new Error('Invalid camera address');
    out.host = c.host.trim();
  }
  for (const k of /** @type {const} */ (['onvifPort', 'rtspPort'])) {
    if (c[k] !== undefined) {
      if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 65535) throw new Error(`${k} must be a port number`);
      out[k] = c[k];
    }
  }
  if (c.username !== undefined && c.username !== '') {
    out.username = text(c.username, 64, 'The user name');
    if (/\s/.test(out.username)) throw new Error('The user name cannot contain spaces');
  }
  if (c.password !== undefined && c.password !== '') {
    if (typeof c.password !== 'string' || c.password.length > 128 || /[\0\r\n]/.test(c.password)) throw new Error('That password is not valid');
    out.password = c.password;
  }
  return out;
}

/** @param {unknown} v @returns {{ refresh: boolean }} */
export function validatePresetsQuery(v) {
  const c = obj(v, 'Presets query');
  onlyKeys(c, ['refresh'], 'presets');
  if (c.refresh !== undefined && typeof c.refresh !== 'boolean') throw new Error('refresh must be true or false');
  return { refresh: !!c.refresh };
}

/** @param {unknown} v @returns {{ name: string, token?: string }} */
export function validatePresetSave(v) {
  const c = obj(v, 'Preset');
  onlyKeys(c, ['name', 'token'], 'preset');
  const out = /** @type {{ name: string, token?: string }} */ ({ name: text(c.name, 40, 'The position name') });
  if (c.token !== undefined) {
    if (typeof c.token !== 'string' || !TOKEN.test(c.token)) throw new Error('Invalid preset');
    out.token = c.token;
  }
  return out;
}

/** @param {unknown} v @returns {{ token: string }} */
export function validateTokenPayload(v) {
  const c = obj(v, 'Preset');
  onlyKeys(c, ['token'], 'preset');
  if (typeof c.token !== 'string' || !TOKEN.test(c.token)) throw new Error('Invalid preset');
  return { token: c.token };
}

/** @param {unknown} v @returns {{ armed: boolean, immediate: boolean }} */
export function validateArmPayload(v) {
  const c = obj(v, 'Arm request');
  onlyKeys(c, ['armed', 'immediate'], 'arm');
  if (typeof c.armed !== 'boolean') throw new Error('armed must be true or false');
  if (c.immediate !== undefined && typeof c.immediate !== 'boolean') throw new Error('immediate must be true or false');
  return { armed: c.armed, immediate: !!c.immediate };
}

/** @param {unknown} v @returns {{ action: 'start'|'answer'|'cancel', answer?: string }} */
export function validateCalibratePayload(v) {
  const c = obj(v, 'Calibration request');
  onlyKeys(c, ['action', 'answer'], 'calibrate');
  if (!['start', 'answer', 'cancel'].includes(c.action)) throw new Error('action must be start, answer or cancel');
  if (c.action !== 'answer') return { action: c.action };
  if (!['left', 'right', 'up', 'down', 'none'].includes(c.answer)) throw new Error('answer must be left, right, up, down or none');
  return { action: 'answer', answer: c.answer };
}

/** @param {unknown} v */
export function validateEventsQuery(v) {
  const c = obj(v, 'Events query');
  onlyKeys(c, ['beforeMs', 'sinceMs', 'kinds', 'limit'], 'events');
  /** @type {{ beforeMs?: number, sinceMs?: number, kinds?: string[], limit?: number }} */
  const out = {};
  if (c.beforeMs !== undefined) out.beforeMs = finite(c.beforeMs, 0, 1e15, 'beforeMs');
  if (c.sinceMs !== undefined) out.sinceMs = finite(c.sinceMs, 0, 1e15, 'sinceMs');
  if (c.kinds !== undefined) {
    if (!Array.isArray(c.kinds) || c.kinds.length > 3 || !c.kinds.every((k) => ['person', 'motion', 'tamper'].includes(k))) throw new Error('kinds must list person, motion or tamper');
    out.kinds = [...new Set(/** @type {string[]} */ (c.kinds))];
  }
  if (c.limit !== undefined) {
    if (!Number.isInteger(c.limit) || c.limit < 1 || c.limit > 200) throw new Error('limit must be 1 to 200');
    out.limit = c.limit;
  }
  return out;
}

/** @param {unknown} v @returns {{ id: string }} */
export function validateEventIdPayload(v) {
  const c = obj(v, 'Event');
  onlyKeys(c, ['id'], 'event');
  if (typeof c.id !== 'string' || !EVENT_ID.test(c.id)) throw new Error('Invalid event');
  return { id: c.id };
}

/** @param {unknown} v @returns {{ show: boolean, eventId?: string }} */
export function validateWindowPayload(v) {
  const c = obj(v, 'Window request');
  onlyKeys(c, ['show', 'eventId'], 'window');
  if (typeof c.show !== 'boolean') throw new Error('show must be true or false');
  if (c.eventId !== undefined && (typeof c.eventId !== 'string' || !EVENT_ID.test(c.eventId))) throw new Error('Invalid event');
  return c.eventId ? { show: c.show, eventId: c.eventId } : { show: c.show };
}

/** @param {unknown} v @returns {{ visible: boolean }} */
export function validateViewPayload(v) {
  const c = obj(v, 'View state');
  onlyKeys(c, ['visible'], 'view');
  if (typeof c.visible !== 'boolean') throw new Error('visible must be true or false');
  return { visible: c.visible };
}

/**
 * lm:settings:set from the camera window: only the tapo and security groups (the settings
 * store validates every field). @param {unknown} patch
 */
export function validateCameraSettingsPatch(patch) {
  if (!isPlainObject(patch)) throw new Error('Settings patch must be an object');
  for (const k of Object.keys(patch)) {
    if (k !== 'tapo' && k !== 'security') throw new Error('The camera window can only change the camera settings');
  }
  let size = 0;
  try {
    size = JSON.stringify(patch).length;
  } catch {
    throw new Error('Settings patch is not serializable');
  }
  if (size > 64 * 1024) throw new Error('Settings patch is too large');
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Worker → main messages (MessagePort)

/** @param {unknown} n @param {number} [lo] @param {number} [hi] */
const num = (n, lo = -Infinity, hi = Infinity) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
/** @param {unknown} s @param {number} max */
const shortText = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

/** Bytes of an ArrayBuffer / typed array / Buffer, else null. @param {unknown} v */
export function bytesOf(v) {
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

export const MAX_JPEG_BYTES = 2 * 1024 * 1024;

/**
 * Validate one message from the security worker. Unknown or malformed → null (dropped).
 * @param {any} m
 */
export function validateWorkerMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'ack':
      if (!Number.isSafeInteger(m.seq) || m.seq < 0) return null;
      return { t: 'ack', seq: m.seq };
    case 'ready':
      if (!['on', 'stub', 'failed'].includes(m.detector)) return null;
      return { t: 'ready', detector: m.detector, ...(m.error ? { error: shortText(m.error, 300) } : {}) };
    case 'det': {
      if (!num(m.at) || !num(m.frameTs ?? 0)) return null;
      const mo = m.motion || {};
      if (typeof mo.active !== 'boolean' || (mo.score !== undefined && !num(mo.score, 0, 1)) || (mo.global !== undefined && typeof mo.global !== 'boolean')) return null;
      if (!Array.isArray(m.persons) || m.persons.length > 10) return null;
      if (m.detected !== undefined && typeof m.detected !== 'boolean') return null;
      const persons = [];
      for (const p of m.persons) {
        if (!p || !num(p.score, 0, 1) || !Array.isArray(p.box) || p.box.length !== 4 || !p.box.every((/** @type {unknown} */ x) => num(x, 0, 1))) return null;
        persons.push({ score: p.score, box: /** @type {number[]} */ ([...p.box]) });
      }
      // `detected` (lane B's additive field): does `persons` come from a person-detector run? The
      // worker sends det at ~5 Hz but runs the detector at 1 Hz while armed; only detector runs
      // are samples for the "2 of the last 3" rule. A sender without the field (§9.3 as written)
      // means every det is a detector sample.
      return { t: 'det', at: m.at, frameTs: m.frameTs ?? 0, motion: { active: mo.active, score: mo.score ?? 0, global: !!mo.global }, persons, detected: m.detected !== false };
    }
    case 'snap-ok': {
      const jpeg = bytesOf(m.jpeg);
      if (typeof m.id !== 'string' || m.id.length > 64 || !jpeg || jpeg.length < 4 || jpeg.length > MAX_JPEG_BYTES) return null;
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return null;
      if (!num(m.width, 1, 10000) || !num(m.height, 1, 10000)) return null;
      return { t: 'snap-ok', id: m.id, jpeg, width: Math.round(m.width), height: Math.round(m.height), frameTs: num(m.frameTs) ? m.frameTs : 0 };
    }
    case 'snap-err':
      if (typeof m.id !== 'string' || m.id.length > 64) return null;
      return { t: 'snap-err', id: m.id, message: shortText(m.message, 300) };
    case 'shift-ref-ok':
      if (typeof m.id !== 'string' || m.id.length > 64) return null;
      return { t: 'shift-ref-ok', id: m.id };
    case 'shift':
      if (typeof m.id !== 'string' || m.id.length > 64 || !num(m.dx, -2, 2) || !num(m.dy, -2, 2) || !num(m.score, -1, 1)) return null;
      return { t: 'shift', id: m.id, dx: m.dx, dy: m.dy, score: m.score, settledMs: num(m.settledMs, 0, 1e6) ? m.settledMs : 0 };
    case 'stats':
      if (!num(m.fps ?? 0, 0, 1000)) return null;
      return {
        t: 'stats', fps: m.fps ?? 0, decodeQueue: num(m.decodeQueue, 0, 1e6) ? m.decodeQueue : 0, dropped: num(m.dropped, 0, 1e12) ? m.dropped : 0,
        decoder: ['prefer-hardware', 'no-preference'].includes(m.decoder) ? m.decoder : null, configSupported: m.configSupported !== false,
        ...(num(m.detectorMs, 0, 1e5) ? { detectorMs: m.detectorMs } : {}), ...(num(m.detectorHz, 0, 100) ? { detectorHz: m.detectorHz } : {}),
      };
    case 'error':
      return { t: 'error', fatal: !!m.fatal, message: shortText(m.message, 500) };
    default:
      return null;
  }
}
