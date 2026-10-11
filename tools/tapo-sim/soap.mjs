// SOAP 1.2 responses and WS-Security checks for the simulated camera. Responses use gSOAP-style
// prefixes (SOAP-ENV, tds, tt, …) that differ from what the app sends, so a client that matched
// prefixes instead of local names would fail here as it would on a camera.

import crypto from 'node:crypto';
import { at, findAll, textAt } from './xml-lite.mjs';

export const NS = Object.freeze({
  env: 'http://www.w3.org/2003/05/soap-envelope',
  wsa5: 'http://www.w3.org/2005/08/addressing',
  tt: 'http://www.onvif.org/ver10/schema',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wstop: 'http://docs.oasis-open.org/wsn/t-1',
  tns1: 'http://www.onvif.org/ver10/topics',
  ter: 'http://www.onvif.org/ver10/error',
});

const XMLNS = Object.entries({
  'SOAP-ENV': NS.env, wsa5: NS.wsa5, tt: NS.tt, tds: NS.tds, trt: NS.trt, tptz: NS.tptz, tev: NS.tev,
  wsnt: NS.wsnt, wstop: NS.wstop, tns1: NS.tns1, ter: NS.ter,
}).map(([p, u]) => `xmlns:${p}="${u}"`).join(' ');

/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] || c);
}

/** @param {string} body @param {{ action?: string }} [o] */
export function envelope(body, o = {}) {
  const header = o.action ? `<SOAP-ENV:Header><wsa5:Action>${esc(o.action)}</wsa5:Action></SOAP-ENV:Header>` : '<SOAP-ENV:Header></SOAP-ENV:Header>';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope ${XMLNS}>${header}<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

/**
 * A SOAP 1.2 fault. `sender` faults are answered with HTTP 400, receiver faults with 500.
 * @param {{ code?: string, subcodes?: string[], reason: string, sender?: boolean }} f
 */
export function fault(f) {
  const subs = (f.subcodes || []).reduceRight((inner, c) => `<SOAP-ENV:Subcode><SOAP-ENV:Value>${esc(c)}</SOAP-ENV:Value>${inner}</SOAP-ENV:Subcode>`, '');
  const code = f.code || (f.sender === false ? 'SOAP-ENV:Receiver' : 'SOAP-ENV:Sender');
  return envelope(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>${code}</SOAP-ENV:Value>${subs}</SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${esc(f.reason)}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`);
}

/** A fault the handlers throw; the server turns it into the HTTP answer. */
export class SoapFault extends Error {
  /** @param {string} reason @param {{ subcodes?: string[], sender?: boolean, status?: number }} [o] */
  constructor(reason, o = {}) {
    super(reason);
    this.subcodes = o.subcodes || [];
    this.sender = o.sender !== false;
    this.status = o.status || (this.sender ? 400 : 500);
  }
  xml() {
    return fault({ reason: this.message, subcodes: this.subcodes, sender: this.sender });
  }
}

export const notAuthorized = () => new SoapFault('Sender not Authorized', { subcodes: ['ter:NotAuthorized'] });
export const notSupported = (what = 'Optional Action Not Implemented') => new SoapFault(what, { subcodes: ['ter:ActionNotSupported'], sender: false });
export const invalidArg = (what, sub = 'ter:InvalidArgVal') => new SoapFault(what, { subcodes: ['ter:InvalidArgVal', sub].filter((v, i, a) => a.indexOf(v) === i) });

/**
 * ISO 8601 duration (PT5S, PT0.5S, PT10M, P1DT2H) → seconds; null when absent or invalid.
 * @param {string} s
 */
export function parseDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

/** "PTnS" for a number of seconds. @param {number} sec */
export function formatDuration(sec) {
  return `PT${Math.round(sec)}S`;
}

/**
 * A plain decimal from a request attribute. Exponents ("1e-7", which JavaScript produces for
 * tiny numbers) are refused like Tapo firmware does (gladys-tapo `formatNumber`).
 * @param {string|undefined} v @param {string} what
 */
export function parseNumber(v, what) {
  if (v === undefined || v === '') return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(v.trim())) throw invalidArg(`${what}: cannot parse ${JSON.stringify(v).slice(0, 40)}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw invalidArg(`${what}: not a number`);
  return n;
}

/**
 * Verify the WS-Security UsernameToken (PasswordDigest) of a request.
 * @param {import('./xml-lite.mjs').XNode} doc
 * @param {{ username: string, password: string, cameraNowMs: number, toleranceSec: number, seenNonces: Map<string, number>|null }} o
 * @returns {{ ok: true, user: string } | { ok: false, why: string }}
 */
export function checkWsse(doc, o) {
  const tok = findAll(at(doc, 'Envelope/Header'), 'UsernameToken')[0];
  if (!tok) return { ok: false, why: 'no UsernameToken' };
  const user = textAt(tok, 'Username');
  const pw = at(tok, 'Password');
  const nonceB64 = textAt(tok, 'Nonce');
  const created = textAt(tok, 'Created');
  if (!pw || !nonceB64 || !created) return { ok: false, why: 'incomplete UsernameToken' };
  if (!/#PasswordDigest$/.test(pw.attrs.Type || '')) return { ok: false, why: `password type ${pw.attrs.Type || '(none)'}` };
  const createdMs = Date.parse(created);
  if (!Number.isFinite(createdMs)) return { ok: false, why: 'bad Created' };
  if (Math.abs(createdMs - o.cameraNowMs) > o.toleranceSec * 1000) {
    return { ok: false, why: `Created is ${Math.round((createdMs - o.cameraNowMs) / 1000)} s off the camera clock` };
  }
  const nonce = Buffer.from(nonceB64, 'base64');
  const want = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(o.password, 'utf8')])).digest('base64');
  if (user !== o.username || pw.text !== want) return { ok: false, why: user !== o.username ? 'unknown user' : 'wrong digest' };
  if (o.seenNonces) {
    // a reused header reads as a replay (gladys-tapo: build a fresh one for every call)
    if (o.seenNonces.has(nonceB64)) return { ok: false, why: 'nonce replayed' };
    o.seenNonces.set(nonceB64, o.cameraNowMs);
    if (o.seenNonces.size > 2000) {
      for (const [k, t] of o.seenNonces) if (o.cameraNowMs - t > 10 * 60_000 || o.seenNonces.size > 1500) o.seenNonces.delete(k);
    }
  }
  return { ok: true, user };
}
