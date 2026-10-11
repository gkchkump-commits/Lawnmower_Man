// RtspAuthProxy: go2rtc reaches the camera through main, so the Camera Account password never
// leaves main (security review: go2rtc answered a Basic challenge with the password in clear
// text, to whoever answers on the camera's address). Pure Node (net).
//
// go2rtc is given rtsp://127.0.0.1:<port>/<token>/<stream> — no user name, no password. For each
// connection it opens, main connects to the camera's pinned IP and relays the RTSP session:
//  * requests: the proxy's URL prefix is rewritten to the camera's; any Authorization from go2rtc
//    is dropped and main's own Digest answer (MD5 or SHA-256, qop=auth when offered) is added.
//  * a 401 with a Digest challenge: the request is sent again once with the answer (and later
//    requests carry it right away); a 401 to an answered request (not "stale") is a refused
//    sign-in: 'auth-failed', and no further connection reaches the camera until start() again
//    (camera lockouts).
//  * a challenge that is not Digest (Basic): never answered — the password would go out in clear
//    text — the connection is closed and 'insecure' emitted; nothing more reaches the camera.
//  * responses: the camera's URLs (Content-Base, RTP-Info, the SDP) are rewritten to the proxy's,
//    so go2rtc only ever knows the proxy. Interleaved RTP/RTCP ($ frames) passes through as is.
//  * a random token in the path keeps other programs on this PC from using the proxy (it would
//    sign in for them).
//  * stop() ends every session go2rtc left open with TEARDOWN (≤ 800 ms) before closing: the
//    camera has only two RTSP slots.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { hostPort } from './host.js';
import { parseChallenges } from './rtsp-probe.js';

export const MAX_CONNECTIONS = 4;
export const MAX_HEAD = 64 * 1024;
export const MAX_BODY = 1024 * 1024;
export const TEARDOWN_WAIT_MS = 800;
export const CONNECT_TIMEOUT_MS = 5000;

const EMPTY = Buffer.alloc(0);

/** @param {string} alg @param {string} s */
const hash = (alg, s) => crypto.createHash(alg).update(s, 'utf8').digest('hex');

/**
 * The Digest answer for one request (RFC 7616; MD5 or SHA-256, qop=auth optional).
 * @param {{ username: string, password: string, method: string, uri: string,
 *   challenge: { realm: string, nonce: string, opaque?: string, qop?: string, algorithm?: string }, nc: number, cnonce?: string }} o
 */
export function digestAuthorization(o) {
  const c = o.challenge;
  const algorithm = /^sha-256$/i.test(c.algorithm || '') ? 'SHA-256' : 'MD5';
  const h = (/** @type {string} */ s) => hash(algorithm === 'SHA-256' ? 'sha256' : 'md5', s);
  const qop = c.qop && /\bauth\b/i.test(c.qop) ? 'auth' : '';
  const nc = o.nc.toString(16).padStart(8, '0');
  const cnonce = o.cnonce || crypto.randomBytes(8).toString('hex');
  const ha1 = h(`${o.username}:${c.realm}:${o.password}`);
  const ha2 = h(`${o.method}:${o.uri}`);
  const response = qop ? h(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${c.nonce}:${ha2}`);
  const q = (/** @type {string} */ v) => String(v).replace(/["\\\r\n]/g, '');
  const fields = [`username="${q(o.username)}"`, `realm="${q(c.realm)}"`, `nonce="${q(c.nonce)}"`, `uri="${q(o.uri)}"`, `response="${response}"`];
  if (c.algorithm) fields.push(`algorithm=${algorithm}`);
  if (c.opaque !== undefined) fields.push(`opaque="${q(c.opaque)}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(', ')}`;
}

/** Splits a byte stream into RTSP messages and interleaved ($) frames. */
export class RtspFramer {
  constructor() {
    this.buf = EMPTY;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<{ type: 'frame', data: Buffer } | { type: 'msg', head: string, body: Buffer }>}
   */
  push(chunk) {
    const b = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    let off = 0;
    for (;;) {
      if (off >= b.length) break;
      if (b[off] === 0x24) {
        if (b.length - off < 4) break;
        const len = b.readUInt16BE(off + 2);
        if (b.length - off < 4 + len) break;
        out.push({ type: /** @type {const} */ ('frame'), data: b.subarray(off, off + 4 + len) });
        off += 4 + len;
        continue;
      }
      const end = b.indexOf('\r\n\r\n', off, 'latin1');
      if (end < 0) {
        if (b.length - off > MAX_HEAD) throw new Error('RTSP head too large');
        break;
      }
      const head = b.subarray(off, end).toString('latin1');
      const m = /\r\ncontent-length:[ \t]*(\d+)/i.exec(head);
      const len = m ? Number(m[1]) : 0;
      if (len > MAX_BODY) throw new Error('RTSP body too large');
      if (b.length < end + 4 + len) break;
      out.push({ type: /** @type {const} */ ('msg'), head, body: b.subarray(end + 4, end + 4 + len) });
      off = end + 4 + len;
    }
    this.buf = off >= b.length ? EMPTY : Buffer.from(b.subarray(off));
    return out;
  }
}

/** @param {string} head @returns {{ first: string, headers: Array<[string, string]> }} */
function parseHead(head) {
  const lines = head.split('\r\n');
  /** @type {Array<[string, string]>} */
  const headers = [];
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
  }
  return { first: lines[0] || '', headers };
}

/** @param {Array<[string, string]>} headers @param {string} name */
const getAll = (headers, name) => headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
/** @param {Array<[string, string]>} headers @param {string} name */
const get = (headers, name) => getAll(headers, name)[0];

/** @param {string} first @param {Array<[string, string]>} headers @param {Buffer} body */
function build(first, headers, body) {
  const hs = headers.filter(([k]) => k.toLowerCase() !== 'content-length');
  if (body.length) hs.push(['Content-Length', String(body.length)]);
  return Buffer.concat([Buffer.from(`${[first, ...hs.map(([k, v]) => `${k}: ${v}`)].join('\r\n')}\r\n\r\n`, 'latin1'), body]);
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @typedef {{ method: string, uri: string, headers: Array<[string, string]>, body: Buffer, cseq: string, tries: number, authed: boolean, own?: boolean }} PendingRequest
 * @typedef {{ id: number, client: net.Socket, cam: net.Socket, fromClient: RtspFramer, fromCam: RtspFramer, validated: boolean,
 *   challenge: any, nc: number, pending: Map<string, PendingRequest>, sessions: Set<string>, baseUri: string, ownSeq: number,
 *   closed: boolean, onOwnDone: (() => void)|null }} ProxyConn
 */

export class RtspAuthProxy extends EventEmitter {
  /**
   * @param {{ log?: (level: string, msg: string) => void, connect?: typeof net.connect, connectTimeoutMs?: number, teardownWaitMs?: number }} [o]
   */
  constructor(o = {}) {
    super();
    this._log = o.log || (() => {});
    this._connectImpl = o.connect || net.connect;
    this._connectTimeoutMs = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this._teardownWaitMs = o.teardownWaitMs ?? TEARDOWN_WAIT_MS;
    /** @type {net.Server|null} */
    this._server = null;
    this._port = 0;
    this._token = '';
    /** @type {{ ip: string, port: number, username: string, password: string }|null} */
    this._target = null;
    /** @type {'off'|'ready'|'auth-failed'|'insecure'} */
    this._state = 'off';
    /** @type {Set<ProxyConn>} */
    this._conns = new Set();
    this._seq = 0;
  }

  get state() {
    return this._state;
  }

  get port() {
    return this._port;
  }

  /** The secret path segment go2rtc must use (also a secret for redaction). */
  get token() {
    return this._token;
  }

  /** The source URL for go2rtc's config, with the token as an environment placeholder. @param {string} stream */
  sourceTemplate(stream) {
    return `rtsp://127.0.0.1:${this._port}/\${LM_SRC_TOKEN}/${stream}`;
  }

  /**
   * Listen (once) on 127.0.0.1 and relay to this camera. A new target or new credentials close
   * the running sessions and clear a sign-in failure.
   * @param {{ ip: string, port: number, username: string, password: string }} target
   * @returns {Promise<{ port: number, token: string }>}
   */
  async start(target) {
    this._closeAll('the camera or its sign-in changed');
    this._target = { ...target };
    this._state = 'ready';
    if (!this._server) {
      this._token = crypto.randomBytes(16).toString('hex');
      const server = net.createServer((sock) => this._accept(sock));
      server.on('error', (err) => this._log('warn', `[tapo] RTSP proxy: ${err.message}`));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(undefined);
        });
      });
      this._server = server;
      this._port = /** @type {net.AddressInfo} */ (server.address()).port;
      this._log('info', `[tapo] RTSP proxy on 127.0.0.1:${this._port}`);
    }
    return { port: this._port, token: this._token };
  }

  /** End the sessions (TEARDOWN, ≤ 800 ms), close everything, stop listening. */
  async stop() {
    const conns = [...this._conns];
    await Promise.all(conns.map((c) => this._teardown(c)));
    this._closeAll('stopped');
    const server = this._server;
    this._server = null;
    this._port = 0;
    this._target = null;
    this._state = 'off';
    if (server) await new Promise((r) => server.close(() => r(undefined)));
  }

  /** Close the relayed sessions (go2rtc reconnects). @param {string} why */
  _closeAll(why) {
    for (const c of [...this._conns]) this._close(c, why);
  }

  /** @param {net.Socket} client */
  _accept(client) {
    const t = this._target;
    if (!t || this._state !== 'ready' || this._conns.size >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    client.setNoDelay(true);
    client.pause();
    const cam = this._connectImpl({ host: t.ip, port: t.port });
    cam.setNoDelay?.(true);
    /** @type {ProxyConn} */
    const c = {
      id: ++this._seq, client, cam, fromClient: new RtspFramer(), fromCam: new RtspFramer(), validated: false, challenge: null, nc: 0,
      pending: new Map(), sessions: new Set(), baseUri: '', ownSeq: 90000, closed: false, onOwnDone: null,
    };
    this._conns.add(c);
    const timer = setTimeout(() => this._close(c, 'the camera did not answer'), this._connectTimeoutMs);
    cam.once('connect', () => {
      clearTimeout(timer);
      client.resume();
    });
    client.on('data', (d) => this._safely(c, () => this._fromClient(c, d)));
    cam.on('data', (d) => this._safely(c, () => this._fromCamera(c, d)));
    for (const s of [client, cam]) {
      s.on('error', (err) => this._log('debug', `[tapo] RTSP proxy #${c.id}: ${/** @type {any} */ (err).code || err.message}`));
      s.on('close', () => {
        clearTimeout(timer);
        this._close(c, s === cam ? 'the camera closed the connection' : 'go2rtc closed the connection');
      });
    }
  }

  /** @param {ProxyConn} c @param {() => void} fn */
  _safely(c, fn) {
    try {
      fn();
    } catch (err) {
      this._log('info', `[tapo] RTSP proxy #${c.id}: ${/** @type {Error} */ (err).message}`);
      this._close(c, 'protocol error');
    }
  }

  /** @param {ProxyConn} c @param {string} why */
  _close(c, why) {
    if (c.closed) return;
    c.closed = true;
    this._conns.delete(c);
    c.onOwnDone?.();
    c.client.destroy();
    c.cam.destroy();
    this._log('debug', `[tapo] RTSP proxy #${c.id} closed (${why})`);
  }

  get _prefix() {
    return `rtsp://127.0.0.1:${this._port}/${this._token}`;
  }

  get _camBase() {
    const t = /** @type {NonNullable<RtspAuthProxy['_target']>} */ (this._target);
    return `rtsp://${hostPort(t.ip, t.port)}`;
  }

  /** The camera's URLs in a response → the proxy's (with or without the default port). */
  _camUrlRe() {
    const t = /** @type {NonNullable<RtspAuthProxy['_target']>} */ (this._target);
    const ip = net.isIPv6(t.ip) ? `\\[${escapeRe(t.ip)}\\]` : escapeRe(t.ip);
    const port = t.port === 554 ? '(?::554)?' : `:${t.port}`;
    return new RegExp(`rtsp://${ip}${port}(?=[/;,\\s"]|$)`, 'gi');
  }

  /** @param {ProxyConn} c @param {Buffer} d */
  _fromClient(c, d) {
    for (const part of c.fromClient.push(d)) {
      if (part.type === 'frame') {
        c.cam.write(part.data); // RTCP receiver reports
        continue;
      }
      const { first, headers } = parseHead(part.head);
      const m = /^([A-Z_]{1,32}) (\S+) (RTSP\/1\.0)$/.exec(first);
      if (!m) throw new Error('not an RTSP request');
      const method = m[1];
      let uri = m[2];
      if (uri === this._prefix || uri.startsWith(`${this._prefix}/`)) uri = this._camBase + uri.slice(this._prefix.length);
      else if (!c.validated) {
        c.client.write(`RTSP/1.0 404 Not Found\r\nCSeq: ${get(headers, 'cseq') || '0'}\r\n\r\n`);
        this._close(c, 'a request without the token');
        return;
      }
      c.validated = true;
      const cseq = get(headers, 'cseq') || '';
      /** @type {PendingRequest} */
      const req = { method, uri, headers: headers.filter(([k]) => !/^(authorization|proxy-authorization|content-length)$/i.test(k)), body: part.body, cseq, tries: 0, authed: false };
      if (method === 'DESCRIBE' || !c.baseUri) c.baseUri = uri.replace(/\/(?:track|trackID=)[^/]*$/i, '');
      if (cseq) c.pending.set(cseq, req);
      this._send(c, req);
    }
  }

  /** @param {ProxyConn} c @param {PendingRequest} req */
  _send(c, req) {
    const t = /** @type {NonNullable<RtspAuthProxy['_target']>} */ (this._target);
    const hs = [...req.headers];
    if (c.challenge) {
      hs.push(['Authorization', digestAuthorization({ username: t.username, password: t.password, method: req.method, uri: req.uri, challenge: c.challenge, nc: ++c.nc })]);
      req.authed = true;
    }
    c.cam.write(build(`${req.method} ${req.uri} RTSP/1.0`, hs, req.body));
  }

  /** @param {ProxyConn} c @param {Buffer} d */
  _fromCamera(c, d) {
    const parts = c.fromCam.push(d);
    c.client.cork();
    try {
      for (const part of parts) {
        if (c.closed) return;
        if (part.type === 'frame') {
          c.client.write(part.data);
          continue;
        }
        this._onCameraMessage(c, part.head, part.body);
      }
    } finally {
      if (!c.closed) c.client.uncork();
    }
  }

  /** @param {ProxyConn} c @param {string} head @param {Buffer} body */
  _onCameraMessage(c, head, body) {
    const { first, headers } = parseHead(head);
    const m = /^RTSP\/1\.0 (\d{3})/.exec(first);
    if (!m) {
      c.client.write(build(first, headers, body)); // a request from the camera (rare): passed on
      return;
    }
    const status = Number(m[1]);
    const cseq = get(headers, 'cseq') || '';
    const req = cseq ? c.pending.get(cseq) : undefined;
    if (status === 401 && req) {
      const challenges = parseChallenges(getAll(headers, 'www-authenticate'));
      const digest = challenges.find((x) => x.scheme === 'digest');
      if (!digest) {
        this._refuseInsecure(c, challenges.map((x) => x.scheme).join(', ') || 'none');
        return;
      }
      const stale = /^true$/i.test(digest.params.stale || '');
      if ((req.authed && !stale) || req.tries >= 2) {
        this._authFailed(c, req, first, headers, body);
        return;
      }
      c.challenge = { realm: digest.params.realm || '', nonce: digest.params.nonce || '', opaque: digest.params.opaque, qop: digest.params.qop, algorithm: digest.params.algorithm };
      c.nc = 0;
      req.tries++;
      this._send(c, req);
      return;
    }
    if (req) c.pending.delete(cseq);
    if (req && status >= 200 && status < 300) {
      const session = (get(headers, 'session') || '').split(';')[0].trim();
      if (req.method === 'SETUP' && session) c.sessions.add(session);
      if (req.method === 'TEARDOWN') {
        if (session) c.sessions.delete(session);
        else c.sessions.clear();
      }
    }
    if (req?.own) {
      if (![...c.pending.values()].some((p) => p.own)) c.onOwnDone?.();
      return;
    }
    // go2rtc only ever knows the proxy's URLs
    const re = this._camUrlRe();
    const out = headers.map(([k, v]) => /** @type {[string, string]} */ ([k, /^(content-base|content-location|rtp-info|location)$/i.test(k) ? v.replace(re, this._prefix) : v]));
    let b = body;
    if (b.length && /^application\/sdp/i.test(get(headers, 'content-type') || '')) b = Buffer.from(b.toString('latin1').replace(re, this._prefix), 'latin1');
    c.client.write(build(first, out, b));
  }

  /** The camera asked for an unencrypted sign-in. @param {ProxyConn} c @param {string} schemes */
  _refuseInsecure(c, schemes) {
    this._log('warn', `[tapo] the camera's RTSP server asked for an unencrypted sign-in (${schemes}); the password was not sent`);
    this._state = 'insecure';
    this._closeAll('an unencrypted sign-in was asked for');
    this.emit('insecure', { schemes });
  }

  /** @param {ProxyConn} c @param {PendingRequest} req @param {string} first @param {Array<[string, string]>} headers @param {Buffer} body */
  _authFailed(c, req, first, headers, body) {
    this._log('warn', '[tapo] the camera refused the RTSP sign-in; not trying again until the credentials change');
    this._state = 'auth-failed';
    c.pending.delete(req.cseq);
    if (!req.own) c.client.write(build(first, headers.filter(([k]) => !/^www-authenticate$/i.test(k)), body));
    this._closeAll('the sign-in was refused');
    this.emit('auth-failed');
  }

  /** End the sessions go2rtc left open on this connection. @param {ProxyConn} c */
  async _teardown(c) {
    if (c.closed || !c.sessions.size || !c.baseUri || c.cam.destroyed) return;
    const done = new Promise((resolve) => {
      c.onOwnDone = () => resolve(undefined);
      setTimeout(resolve, this._teardownWaitMs).unref?.();
    });
    for (const s of c.sessions) {
      const cseq = String(++c.ownSeq);
      /** @type {PendingRequest} */
      const req = { method: 'TEARDOWN', uri: c.baseUri, headers: [['CSeq', cseq], ['Session', s], ['User-Agent', 'LawnmowerMan']], body: EMPTY, cseq, tries: 0, authed: false, own: true };
      c.pending.set(cseq, req);
      this._send(c, req);
    }
    await done;
    c.onOwnDone = null;
  }
}
