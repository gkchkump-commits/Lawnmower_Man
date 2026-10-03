// Input validation for IPC arguments coming from the renderer. Every validator either returns
// a clean value or throws an Error with a short, user-presentable message.

import { MAX_TURN_CHARS } from './claude-session.js';

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
