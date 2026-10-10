// Input validation for IPC arguments coming from the renderer. Every validator either returns
// a clean value or throws an Error with a short, user-presentable message.

import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64, MAX_TURN_CHARS, MAX_TURN_IMAGES } from './claude-session.js';

/** @param {unknown} v @returns {v is Record<string, any>} */
export function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} v @param {number} maxBytes */
function jsonSize(v, maxBytes) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    throw new Error('value is not serializable');
  }
  if (s === undefined) throw new Error('value is not serializable');
  if (s.length > maxBytes) throw new Error(`value is too large (max ${maxBytes} bytes)`);
  return s.length;
}

/** @param {unknown} text */
export function validateTurnText(text) {
  if (typeof text !== 'string') throw new Error('Message must be text');
  if (!text.trim()) throw new Error('Message is empty');
  if (text.length > MAX_TURN_CHARS) throw new Error(`Message is too long (max ${MAX_TURN_CHARS} characters)`);
  return text;
}

/** The first bytes of each image type we accept (the CLI rejects a type/content mismatch). */
const MAGIC = /** @type {Record<string, (b: Buffer) => boolean>} */ ({
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
});
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Options of claude.send(text, options) from the renderer: `images` (webcam snapshots,
 * docs/CAMERA.md) — at most MAX_TURN_IMAGES of { mediaType: image/jpeg|png|webp, data: base64
 * without a data: prefix, ≤ MAX_IMAGE_BASE64 characters }, whose bytes really are that type.
 * Unknown option keys are ignored.
 * @param {unknown} v
 * @returns {{ images?: Array<{ mediaType: 'image/jpeg'|'image/png'|'image/webp', data: string }> }}
 */
export function validateTurnOptions(v) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new Error('Message options must be an object');
  /** @type {{ images?: Array<{ mediaType: any, data: string }> }} */
  const out = {};
  if (v.images !== undefined && v.images !== null) {
    if (!Array.isArray(v.images)) throw new Error('Message images must be a list');
    if (v.images.length > MAX_TURN_IMAGES) throw new Error(`A message can carry at most ${MAX_TURN_IMAGES} images`);
    const images = v.images.map((img, i) => validateImage(img, v.images.length > 1 ? `Image ${i + 1}` : 'The image'));
    if (images.length) out.images = images;
  }
  return out;
}

/** @param {unknown} img @param {string} what */
function validateImage(img, what) {
  if (!isPlainObject(img)) throw new Error(`${what} must be an object`);
  const { mediaType, data } = img;
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType)) throw new Error(`${what} must be a JPEG, PNG or WebP image`);
  if (typeof data !== 'string' || !data) throw new Error(`${what} has no data`);
  if (/^data:/i.test(data)) throw new Error(`${what} must be plain base64 (without a data: prefix)`);
  if (data.length > MAX_IMAGE_BASE64) throw new Error(`${what} is too large (max ${Math.round(MAX_IMAGE_BASE64 / 1024)} KB of base64)`);
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new Error(`${what} is not valid base64`);
  if (!MAGIC[mediaType](Buffer.from(data.slice(0, 24), 'base64'))) throw new Error(`${what} is not really ${mediaType}`);
  return { mediaType: /** @type {'image/jpeg'|'image/png'|'image/webp'} */ (mediaType), data };
}

/** @param {unknown} turnId a turn id returned by claude.send() */
export function validateTurnId(turnId) {
  if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(turnId)) throw new Error('Invalid turn id');
  return turnId;
}

/**
 * @param {unknown} requestId @param {unknown} decision
 * @returns {{ requestId: string, decision: { behavior: 'allow'|'deny', message?: string, updatedInput?: Record<string, any> } }}
 */
export function validatePermissionResponse(requestId, decision) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Invalid permission request id');
  if (!isPlainObject(decision)) throw new Error('Decision must be an object');
  const behavior = decision.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') throw new Error('Decision behavior must be "allow" or "deny"');
  /** @type {{ behavior: 'allow'|'deny', message?: string, updatedInput?: Record<string, any> }} */
  const out = { behavior };
  if (decision.message !== undefined) {
    if (typeof decision.message !== 'string') throw new Error('Decision message must be text');
    out.message = decision.message.slice(0, 2000);
  }
  if (decision.updatedInput !== undefined && decision.updatedInput !== null) {
    if (!isPlainObject(decision.updatedInput)) throw new Error('updatedInput must be an object');
    jsonSize(decision.updatedInput, 1024 * 1024);
    out.updatedInput = decision.updatedInput;
  }
  return { requestId, decision: out };
}

/** @param {unknown} patch */
export function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) throw new Error('Settings patch must be an object');
  jsonSize(patch, 256 * 1024);
  return patch;
}

/** @param {unknown} v @param {string} what */
export function validateBoolean(v, what = 'value') {
  if (typeof v !== 'boolean') throw new Error(`${what} must be true or false`);
  return v;
}

/** @param {unknown} v @returns {'small'|'medium'|'large'} */
export function validateSizePreset(v) {
  if (v !== 'small' && v !== 'medium' && v !== 'large') throw new Error('Size preset must be small, medium or large');
  return v;
}

/** A resize grip from the renderer. @param {unknown} v @returns {'tl'|'tr'|'bl'|'br'} */
export function validateCorner(v) {
  if (v !== 'tl' && v !== 'tr' && v !== 'bl' && v !== 'br') throw new Error('Corner must be tl, tr, bl or br');
  return v;
}

/** A free avatar width in px (Ctrl + wheel); the settings schema clamps it. @param {unknown} v */
export function validateAvatarWidth(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Avatar width must be a number of pixels');
  return v;
}

/**
 * Options of voice.setup() from the renderer: only the CPU/GPU choice (undefined = decide by
 * the GPU that was detected). @param {unknown} v @returns {{ cpu?: boolean }}
 */
export function validateSetupOptions(v) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new Error('Setup options must be an object');
  /** @type {{ cpu?: boolean }} */
  const out = {};
  if (v.cpu !== undefined) out.cpu = validateBoolean(v.cpu, 'cpu');
  return out;
}

/**
 * Calls that take no arguments from the renderer (e.g. voice.openSetupLog(): main decides what
 * to open). @param {unknown[]} args
 */
export function validateNoArgs(args) {
  if (Array.isArray(args) && args.length > 0) throw new Error('This call takes no arguments');
}
