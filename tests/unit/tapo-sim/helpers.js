// Helpers for the simulator tests: a minimal ONVIF SOAP caller and RTSP client of their own (so
// the simulator's self-tests do not depend on the app's client), and the skip rule for the
// integration tests that drive lane A's modules (electron/tapo/*) against the simulator.
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parse } from '../../../tools/tapo-sim/xml-lite.mjs';
import { digestResponse, parseAuthParams } from '../../../tools/tapo-sim/rtsp-server.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * Import an app module for an integration test, or null when the file does not exist yet (the
 * lane that writes it has not been merged). Any other import error is a real failure and throws.
 * @param {string} rel path from the repository root, e.g. 'electron/tapo/onvif-client.js'
 */
export async function importIfPresent(rel) {
  const file = path.join(ROOT, rel);
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(path.basename(rel))) return null;
    throw err;
  }
}

/**
 * The modules an integration test needs, and a title suffix that says why it is skipped.
 * @param {string[]} rels
 */
export async function laneModules(rels) {
  /** @type {Record<string, any>} */
  const mods = {};
  const missing = [];
  for (const rel of rels) {
    const m = await importIfPresent(rel);
    if (m) mods[rel] = m;
    else missing.push(rel);
  }
  const reason = missing.length ? ` [SKIPPED: ${missing.join(', ')} not present yet (lane A not merged)]` : '';
  return { mods, missing, ok: missing.length === 0, reason };
}

// ---------------------------------------------------------------------------------------------
// SOAP

/**
 * WS-Security UsernameToken header (PasswordDigest).
 * @param {{ username: string, password: string, created?: string, nonce?: Buffer }} o
 */
export function wsse(o) {
  const nonce = o.nonce || crypto.randomBytes(16);
  const created = o.created || new Date().toISOString();
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(o.password)])).digest('base64');
  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${o.username.replace(/&/g, '&amp;')}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce>${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

/**
 * POST one SOAP request.
 * @param {string} url @param {string} body
 * @param {{ auth?: { username: string, password: string, created?: string, nonce?: Buffer }|null, timeoutMs?: number }} [o]
 * @returns {Promise<{ status: number, text: string, doc: any }>}
 */
export function soap(url, body, o = {}) {
  const header = o.auth ? wsse(o.auth) : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"><s:Header>${header}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) } }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let doc = null;
        try { doc = text ? parse(text) : null; } catch { doc = null; }
        resolve({ status: res.statusCode || 0, text, doc });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.timeoutMs) req.setTimeout(o.timeoutMs, () => req.destroy(new Error('timeout')));
    req.end(xml);
  });
}

/** Fault subcodes of a SOAP answer. @param {string} text */
export function faultCodes(text) {
  return [...text.matchAll(/<SOAP-ENV:Value>([^<]+)<\/SOAP-ENV:Value>/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------
// RTSP

/**
 * A small RTSP/1.0 client over TCP: requests with Digest auth, interleaved RTP collected per
 * channel. Enough to test the simulator without ffmpeg or go2rtc.
 */
export class RtspClient {
  /** @param {number} port @param {{ username?: string, password?: string, host?: string }} [o] */
  constructor(port, o = {}) {
    this.port = port;
    this.host = o.host || '127.0.0.1';
    this.username = o.username;
    this.password = o.password;
    this.cseq = 0;
    this.buf = Buffer.alloc(0);
    /** @type {Array<(r: any) => void>} */
    this.waiting = [];
    /** @type {Map<number, Buffer[]>} */
    this.rtp = new Map();
    this.closed = false;
    /** @type {Record<string, string>|null} */
    this.challenge = null;
    this.session = '';
  }

  async connect() {
    this.sock = net.connect(this.port, this.host);
    await new Promise((resolve, reject) => {
      this.sock.once('connect', resolve);
      this.sock.once('error', reject);
    });
    this.sock.on('data', (c) => this._data(c));
    this.sock.on('close', () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w(null);
    });
    this.sock.on('error', () => {});
    return this;
  }

  /** @param {Buffer} c */
  _data(c) {
    this.buf = Buffer.concat([this.buf, c]);
    for (;;) {
      if (!this.buf.length) return;
      if (this.buf[0] === 0x24) {
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        const ch = this.buf[1];
        if (!this.rtp.has(ch)) this.rtp.set(ch, []);
        /** @type {Buffer[]} */ (this.rtp.get(ch)).push(Buffer.from(this.buf.subarray(4, 4 + len)));
        this.buf = this.buf.subarray(4 + len);
        continue;
      }
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString('latin1').split('\r\n');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const l of head.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const cl = Number(headers['content-length'] || 0);
      if (this.buf.length < end + 4 + cl) return;
      const body = this.buf.subarray(end + 4, end + 4 + cl).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + cl);
      const status = Number(head[0].split(' ')[1]);
      const w = this.waiting.shift();
      if (w) w({ status, headers, body });
    }
  }

  /**
   * One request; answers a 401 once with Digest when credentials are set.
   * @param {string} method @param {string} url @param {Record<string, string>} [headers]
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }|null>}
   */
  async request(method, url, headers = {}) {
    const send = () => {
      const h = { CSeq: String(++this.cseq), ...headers };
      if (this.session && !h.Session) h.Session = this.session;
      if (this.challenge && this.username !== undefined) {
        const response = digestResponse({ username: this.username, realm: this.challenge.realm, password: /** @type {string} */ (this.password), method, uri: url, nonce: this.challenge.nonce });
        h.Authorization = `Digest username="${this.username}", realm="${this.challenge.realm}", nonce="${this.challenge.nonce}", uri="${url}", response="${response}"`;
      }
      const p = new Promise((resolve) => this.waiting.push(resolve));
      this.sock.write(`${method} ${url} RTSP/1.0\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      return /** @type {Promise<any>} */ (p);
    };
    let r = await send();
    if (r && r.status === 401 && !this.challenge && this.username !== undefined) {
      this.challenge = parseAuthParams(String(r.headers['www-authenticate'] || '').replace(/^Digest\s+/i, ''));
      r = await send();
    }
    if (r && r.headers.session) this.session = r.headers.session.split(';')[0];
    return r;
  }

  /** DESCRIBE + SETUP (video, and audio when asked) + PLAY. @param {string} path @param {{ audio?: boolean }} [o] */
  async play(path, o = {}) {
    const base = `rtsp://${this.host}:${this.port}${path}`;
    const d = await this.request('DESCRIBE', base, { Accept: 'application/sdp' });
    if (!d || d.status !== 200) return { describe: d };
    const s1 = await this.request('SETUP', `${base}/track1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    if (!s1 || s1.status !== 200) return { describe: d, setup: s1 };
    if (o.audio) await this.request('SETUP', `${base}/track2`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=2-3' });
    const p = await this.request('PLAY', base, { Range: 'npt=0.000-' });
    return { describe: d, setup: s1, play: p };
  }

  /** RTP packets received on a channel. @param {number} ch */
  packets(ch = 0) {
    return this.rtp.get(ch) || [];
  }

  /**
   * Received video frames: RTP payloads grouped by timestamp up to the marker bit.
   * @returns {Array<{ ts: number, payloads: Buffer[], seqs: number[] }>}
   */
  frames(ch = 0) {
    const out = [];
    /** @type {{ ts: number, payloads: Buffer[], seqs: number[] }|null} */
    let cur = null;
    for (const p of this.packets(ch)) {
      const ts = p.readUInt32BE(4);
      const marker = (p[1] & 0x80) !== 0;
      if (!cur || cur.ts !== ts) {
        if (cur) out.push(cur);
        cur = { ts, payloads: [], seqs: [] };
      }
      cur.payloads.push(p.subarray(12));
      cur.seqs.push(p.readUInt16BE(2));
      if (marker) {
        out.push(cur);
        cur = null;
      }
    }
    return out;
  }

  close() {
    this.sock?.destroy();
  }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until fn() returns a truthy value.
 * @template T @param {() => T|Promise<T>} fn @param {{ timeout?: number, interval?: number, what?: string }} [o]
 * @returns {Promise<T>}
 */
export async function until(fn, o = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > (o.timeout ?? 5000)) throw new Error(`timed out waiting for ${o.what || 'a condition'}`);
    await sleep(o.interval ?? 25);
  }
}
