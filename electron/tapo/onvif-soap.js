// ONVIF SOAP 1.2: envelopes, WS-Security UsernameToken (PasswordDigest), the request bodies the
// app sends, HTTP transport and fault classification (contract §8.2/§8.3). Pure Node.
//
// The envelope shape matches gladys-tapo, which works on Tapo C210/C500: no whitespace between
// elements, every namespace on the Envelope, the Security header without mustUnderstand.
// Every interpolated value goes through escapeXml(), every number through formatNumber()
// (JavaScript's `1e-7` is unparseable to some firmwares).

import crypto from 'node:crypto';
import http from 'node:http';

import { child, children, parseXml, textOf } from './xml.js';

export const NS = Object.freeze({
  s: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wsa: 'http://www.w3.org/2005/08/addressing',
});

export const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';

/** WS-Addressing actions for the events calls (the subscription manager wants them). */
export const ACTIONS = Object.freeze({
  pull: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
  // what gladys-tapo sends (also works on Tapo); used after a fault that mentions the Action
  pullAlt: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessages',
  renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
});

/** @param {unknown} s */
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * A plain decimal for the wire: at most 6 fraction digits, no exponent, no "-0".
 * @param {number} n
 */
export function formatNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`not a finite number: ${n}`);
  if (Math.abs(n) >= 1e15) throw new RangeError(`number out of range: ${n}`);
  let s = n.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}

/** ISO-8601 duration in seconds ("PT5S", "PT0.5S"). @param {number} sec */
export function durationSec(sec) {
  return `PT${formatNumber(Math.max(0, sec))}S`;
}

/**
 * PasswordDigest = Base64(SHA1(nonce ‖ created ‖ password)).
 * @param {Buffer} nonce @param {string} createdIso @param {string} password
 */
export function passwordDigest(nonce, createdIso, password) {
  return crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(createdIso, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');
}

/**
 * The WS-Security header (fresh for every call: the camera rejects a replayed digest).
 * @param {{ username: string, password: string, createdIso: string, nonce: Buffer }} o
 */
export function wsseHeader(o) {
  const digest = passwordDigest(o.nonce, o.createdIso, o.password);
  return `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"><wsse:UsernameToken>`
    + `<wsse:Username>${escapeXml(o.username)}</wsse:Username>`
    + `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>`
    + `<wsse:Nonce>${o.nonce.toString('base64')}</wsse:Nonce>`
    + `<wsu:Created>${escapeXml(o.createdIso)}</wsu:Created>`
    + '</wsse:UsernameToken></wsse:Security>';
}

/**
 * The SOAP 1.2 envelope around `body` (already escaped). No Header element when there is
 * nothing to put in it (GetSystemDateAndTime before the clock is known).
 * @param {string} body @param {{ security?: string, action?: string, to?: string }} [o]
 */
export function envelope(body, o = {}) {
  const header = (o.security || '')
    + (o.action ? `<wsa:Action>${escapeXml(o.action)}</wsa:Action>` : '')
    + (o.to ? `<wsa:To>${escapeXml(o.to)}</wsa:To>` : '');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tptz="${NS.tptz}" xmlns:tev="${NS.tev}" xmlns:tt="${NS.tt}" xmlns:wsnt="${NS.wsnt}" xmlns:wsa="${NS.wsa}">`
    + (header ? `<s:Header>${header}</s:Header>` : '')
    + `<s:Body>${body}</s:Body></s:Envelope>`;
}

/** @param {string} tag @param {string} profileToken */
const withProfile = (tag, profileToken, rest = '') => `<tptz:${tag}><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>${rest}</tptz:${tag}>`;
/** @param {number} x @param {number} y */
const panTilt = (x, y) => `<tt:PanTilt x="${formatNumber(x)}" y="${formatNumber(y)}"/>`;

/**
 * Every request body the app sends (contract §8.3, exact strings). Tokens and names are escaped;
 * numbers are plain decimals. No `space` attribute (Tapo uses the default spaces).
 */
export const BODIES = Object.freeze({
  getSystemDateAndTime: () => '<tds:GetSystemDateAndTime/>',
  getDeviceInformation: () => '<tds:GetDeviceInformation/>',
  getCapabilities: () => '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
  getServices: () => '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>',
  getProfiles: () => '<trt:GetProfiles/>',
  /** @param {string} profileToken @param {string} [protocol] */
  getStreamUri: (profileToken, protocol = 'RTSP') => '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
    + `<tt:Transport><tt:Protocol>${escapeXml(protocol)}</tt:Protocol></tt:Transport></trt:StreamSetup>`
    + `<trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`,
  getNodes: () => '<tptz:GetNodes/>',
  /** @param {string} configToken */
  getConfigurationOptions: (configToken) => `<tptz:GetConfigurationOptions><tptz:ConfigurationToken>${escapeXml(configToken)}</tptz:ConfigurationToken></tptz:GetConfigurationOptions>`,
  /** @param {string} t */
  getStatus: (t) => withProfile('GetStatus', t),
  /** @param {string} t @param {number} x @param {number} y */
  relativeMove: (t, x, y) => withProfile('RelativeMove', t, `<tptz:Translation>${panTilt(x, y)}</tptz:Translation><tptz:Speed>${panTilt(1, 1)}</tptz:Speed>`),
  /** @param {string} t @param {number} x @param {number} y @param {number} timeoutSec */
  continuousMove: (t, x, y, timeoutSec) => withProfile('ContinuousMove', t, `<tptz:Velocity>${panTilt(x, y)}</tptz:Velocity><tptz:Timeout>${durationSec(timeoutSec)}</tptz:Timeout>`),
  /** @param {string} t */
  stop: (t) => withProfile('Stop', t, '<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom>'),
  /** The first fallback when Stop faults: Stop with nothing but the profile. @param {string} t */
  stopMinimal: (t) => withProfile('Stop', t),
  /** @param {string} t @param {number} x @param {number} y */
  absoluteMove: (t, x, y) => withProfile('AbsoluteMove', t, `<tptz:Position>${panTilt(x, y)}</tptz:Position><tptz:Speed>${panTilt(1, 1)}</tptz:Speed>`),
  /** @param {string} t */
  getPresets: (t) => withProfile('GetPresets', t),
  /** @param {string} t @param {string} presetToken */
  gotoPreset: (t, presetToken) => withProfile('GotoPreset', t, `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>`),
  /** @param {string} t @param {string} name @param {string} [presetToken] */
  setPreset: (t, name, presetToken) => withProfile('SetPreset', t, `<tptz:PresetName>${escapeXml(name)}</tptz:PresetName>${presetToken ? `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>` : ''}`),
  /** @param {string} t @param {string} presetToken */
  removePreset: (t, presetToken) => withProfile('RemovePreset', t, `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>`),
  getEventProperties: () => '<tev:GetEventProperties/>',
  /** @param {boolean} [withTermination] false after the camera refused InitialTerminationTime */
  createPullPointSubscription: (withTermination = true) => (withTermination
    ? '<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime></tev:CreatePullPointSubscription>'
    : '<tev:CreatePullPointSubscription/>'),
  /** @param {number} [timeoutSec] @param {number} [limit] */
  pullMessages: (timeoutSec = 5, limit = 32) => `<tev:PullMessages><tev:Timeout>${durationSec(timeoutSec)}</tev:Timeout><tev:MessageLimit>${Math.max(1, Math.round(limit))}</tev:MessageLimit></tev:PullMessages>`,
  renew: () => '<wsnt:Renew><wsnt:TerminationTime>PT10M</wsnt:TerminationTime></wsnt:Renew>',
  unsubscribe: () => '<wsnt:Unsubscribe/>',
});

// ---------------------------------------------------------------------------------------------
// Errors

/** @typedef {'auth'|'fault'|'http'|'malformed'|'timeout'|'reset'|'refused'|'unreachable'} OnvifErrorKind */

export class OnvifError extends Error {
  /**
   * @param {OnvifErrorKind} kind @param {string} message
   * @param {{ status?: number, codes?: string[], text?: string, cause?: unknown, code?: string }} [o]
   */
  constructor(kind, message, o = {}) {
    super(message);
    this.name = 'OnvifError';
    /** @type {OnvifErrorKind} */
    this.kind = kind;
    this.status = o.status ?? 0;
    /** @type {string[]} */
    this.codes = o.codes || [];
    this.text = o.text || '';
    /** the Node error code behind a transport failure (ECONNRESET, HPE_…) */
    this.code = o.code || '';
    if (o.cause) this.cause = o.cause;
  }
}

const AUTH_RE = /NotAuthorized|Sender not Authorized|Authority failure|FailedAuthentication/i;

/**
 * A transport error → OnvifError.
 * @param {any} err @param {{ timedOut?: boolean }} [o]
 */
export function transportError(err, o = {}) {
  if (err instanceof OnvifError) return err;
  const code = String(err?.code || '');
  const msg = String(err?.message || err);
  if (o.timedOut) return new OnvifError('timeout', 'The camera did not answer in time.', { code: code || 'ETIMEDOUT', cause: err });
  if (code.startsWith('HPE_') || /Parse Error/i.test(msg)) return new OnvifError('malformed', `The camera sent a malformed answer (${msg}).`, { code, cause: err });
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(msg)) return new OnvifError('reset', 'The camera closed the connection.', { code: code || 'ECONNRESET', cause: err });
  if (code === 'ECONNREFUSED') return new OnvifError('refused', 'The camera refused the connection (is ONVIF on port 2020?).', { code, cause: err });
  if (['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return new OnvifError('unreachable', 'The camera cannot be reached on the network.', { code, cause: err });
  }
  return new OnvifError('unreachable', `Network error: ${msg}`, { code, cause: err });
}

/**
 * Is this failure of a PullMessages request the camera's usual way of ending a pull (it drops
 * the connection after ~10 s whatever Timeout was asked, sometimes with bytes after
 * "Connection: close")? Then the subscription is fine: pull again.
 * @param {unknown} err
 */
export function isBenignPullError(err) {
  const e = /** @type {any} */ (err);
  if (!e) return false;
  const msg = String(e.message || '') + ' ' + String(e.cause?.message || '');
  if (e.kind === 'reset' || e.kind === 'timeout') return true;
  if (/ECONNRESET|socket hang up|Data after .?Connection: close.?/i.test(msg)) return true;
  if (e.code === 'HPE_CLOSED_CONNECTION' || e.cause?.code === 'HPE_CLOSED_CONNECTION') return true;
  return false;
}

/**
 * Fault codes (Code/Value then the Subcode/Value chain, SOAP 1.2; faultcode for SOAP 1.1) and the
 * reason text of a Fault element.
 * @param {import('./xml.js').XmlNode} fault
 */
export function parseFault(fault) {
  const codes = [];
  let code = child(fault, 'Code');
  if (code) {
    for (let depth = 0; code && depth < 8; depth++) {
      const v = textOf(code, 'Value');
      if (v) codes.push(v);
      code = child(code, 'Subcode');
    }
  } else {
    const fc = textOf(fault, 'faultcode');
    if (fc) codes.push(fc);
  }
  const reason = child(fault, 'Reason');
  const text = (reason ? children(reason, 'Text').map((t) => t.text.trim()).filter(Boolean)[0] : null)
    || textOf(fault, 'faultstring')
    || textOf(fault, 'Detail/Text')
    || '';
  return { codes, text };
}

/**
 * Turn an HTTP answer into the Body's first element, or throw an OnvifError.
 * @param {{ status: number, body: string }} res
 * @returns {import('./xml.js').XmlNode}
 */
export function parseSoapResponse(res) {
  let doc = null;
  if (res.body && res.body.trim()) {
    try {
      doc = parseXml(res.body);
    } catch (err) {
      if (res.status === 401) throw new OnvifError('auth', 'The camera refused the sign-in.', { status: 401 });
      if (res.status >= 400) throw new OnvifError('http', `The camera answered HTTP ${res.status}.`, { status: res.status });
      throw new OnvifError('malformed', `The camera sent an unreadable answer (${/** @type {Error} */ (err).message}).`, { status: res.status, cause: err });
    }
  }
  const body = doc && doc.name === 'Envelope' ? child(doc, 'Body') : null;
  const fault = body ? child(body, 'Fault') : null;
  if (fault) {
    const { codes, text } = parseFault(fault);
    const auth = res.status === 401 || codes.some((c) => AUTH_RE.test(c)) || AUTH_RE.test(text);
    const what = text || codes[codes.length - 1] || 'fault';
    throw new OnvifError(auth ? 'auth' : 'fault', auth ? `The camera refused the sign-in (${what}).` : `The camera reported an error: ${what}`, { status: res.status, codes, text });
  }
  if (res.status === 401) throw new OnvifError('auth', 'The camera refused the sign-in.', { status: 401 });
  if (res.status < 200 || res.status >= 300) throw new OnvifError('http', `The camera answered HTTP ${res.status}.`, { status: res.status });
  if (!doc) throw new OnvifError('malformed', 'The camera sent an empty answer.', { status: res.status });
  if (!body) throw new OnvifError('malformed', 'The camera sent an answer that is not SOAP.', { status: res.status });
  const first = body.children[0];
  if (!first) throw new OnvifError('malformed', 'The camera sent an empty SOAP body.', { status: res.status });
  return first;
}

/**
 * POST a SOAP request. No keep-alive pool (`agent: false`): Tapo closes connections anyway.
 * The answer is capped at `maxBytes`; the whole request at `timeoutMs`.
 * @param {string} url
 * @param {string} xml
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxBytes?: number, request?: typeof http.request }} [o]
 * @returns {Promise<{ status: number, body: string }>}
 */
export function postSoap(url, xml, o = {}) {
  const timeoutMs = o.timeoutMs ?? 5000;
  const maxBytes = o.maxBytes ?? 1_048_576;
  const request = o.request || http.request;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new OnvifError('unreachable', `Bad camera address ${url}`));
      return;
    }
    if (u.protocol !== 'http:') {
      reject(new OnvifError('unreachable', 'ONVIF must use plain http on the home network.'));
      return;
    }
    const payload = Buffer.from(xml, 'utf8');
    let settled = false;
    let timedOut = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    const done = (/** @type {Error|null} */ err, /** @type {any} */ value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const req = request({
      protocol: 'http:',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': String(payload.length),
        Connection: 'close',
      },
    }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          done(new OnvifError('malformed', `The camera's answer is larger than ${maxBytes} bytes.`, { status: res.statusCode || 0 }));
          return;
        }
        parts.push(chunk);
      });
      res.on('end', () => done(null, { status: res.statusCode || 0, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', (err) => done(transportError(err, { timedOut })));
      res.on('aborted', () => done(transportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { timedOut })));
    });
    const onAbort = () => {
      req.destroy();
      done(new OnvifError('timeout', 'The request was cancelled.', { code: 'ABORT_ERR' }));
    };
    if (o.signal) {
      if (o.signal.aborted) {
        onAbort();
        return;
      }
      o.signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      done(new OnvifError('timeout', 'The camera did not answer in time.', { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('error', (err) => done(transportError(err, { timedOut })));
    req.end(payload);
  });
}
