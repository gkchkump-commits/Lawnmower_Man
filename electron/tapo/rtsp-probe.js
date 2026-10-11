// rtspDescribe: one RTSP DESCRIBE to check a stream path and its codecs (contract §8.10), for
// the connection test and the probe tool. Pure Node (net).
//
// OPTIONS, then DESCRIBE; on 401 with a Digest challenge (Tapo: realm "TP-Link IP-Camera") at
// most ONE retry with credentials — never a loop (camera lockouts). A Basic-only challenge is not
// answered (that would send the password in clear text). The credentials never go into the URL.

import crypto from 'node:crypto';
import net from 'node:net';

import { hostPort } from './host.js';

const md5 = (/** @type {string} */ s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/**
 * RFC 2617 Digest response (MD5; with qop=auth when the server offers it).
 * @param {{ username: string, realm: string, password: string, method: string, uri: string, nonce: string, qop?: string, nc?: string, cnonce?: string }} o
 */
export function digestResponse(o) {
  const ha1 = md5(`${o.username}:${o.realm}:${o.password}`);
  const ha2 = md5(`${o.method}:${o.uri}`);
  return o.qop ? md5(`${ha1}:${o.nonce}:${o.nc}:${o.cnonce}:${o.qop}:${ha2}`) : md5(`${ha1}:${o.nonce}:${ha2}`);
}

/**
 * The challenges of WWW-Authenticate header(s): [{ scheme: 'digest'|'basic', params }].
 * @param {string|string[]|undefined} header
 */
export function parseChallenges(header) {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.map((h) => {
    const m = /^\s*(\w+)\s*(.*)$/.exec(h) || [];
    /** @type {Record<string, string>} */
    const params = {};
    for (const p of String(m[2] || '').matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) params[p[1].toLowerCase()] = p[2] ?? p[3];
    return { scheme: String(m[1] || '').toLowerCase(), params };
  });
}

/** @param {string} text */
function parseResponse(text) {
  const [head, ...rest] = text.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const m = /^RTSP\/1\.0\s+(\d{3})/.exec(lines[0] || '');
  /** @type {Record<string, string[]>} */
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    (headers[k] = headers[k] || []).push(l.slice(i + 1).trim());
  }
  return { status: m ? Number(m[1]) : 0, headers, body: rest.join('\r\n\r\n') };
}

/** Codecs and fmtp lines of an SDP. @param {string} sdp */
export function parseSdp(sdp) {
  const codecs = [];
  const fmtp = [];
  for (const line of String(sdp).split(/\r?\n/)) {
    const r = /^a=rtpmap:\d+\s+([\w.-]+\/\d+)/.exec(line);
    if (r) codecs.push(r[1]);
    const f = /^a=fmtp:\d+\s+(.*)$/.exec(line);
    if (f) fmtp.push(f[1].slice(0, 300));
  }
  return { codecs, fmtp };
}

/**
 * @param {{ ip: string, port?: number, path?: string, username: string, password: string, timeoutMs?: number }} o
 * @returns {Promise<{ ok: boolean, status: number, codecs: string[], fmtp: string[], error?: string }>}
 */
export function rtspDescribe(o) {
  const port = o.port || 554;
  const uri = `rtsp://${hostPort(o.ip, port)}${o.path || '/stream1'}`;
  const timeoutMs = o.timeoutMs ?? 4000;
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let cseq = 0;
    let authTried = false;
    /** @type {(r: any) => void} */
    let onReply = () => {};
    const sock = net.connect({ host: o.ip, port });
    const finish = (/** @type {{ ok: boolean, status: number, codecs?: string[], fmtp?: string[], error?: string }} */ r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ codecs: [], fmtp: [], ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, status: 0, error: 'The camera did not answer on the RTSP port in time.' }), timeoutMs);
    const send = (/** @type {string} */ method, /** @type {Record<string, string>} */ extra = {}) => {
      const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++cseq}`, 'User-Agent: LawnmowerMan', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    };
    sock.setEncoding('latin1');
    sock.on('error', (err) => finish({ ok: false, status: 0, error: /** @type {any} */ (err).code === 'ECONNREFUSED' ? 'The camera refused the RTSP connection (port 554).' : `RTSP connection failed (${/** @type {any} */ (err).code || err.message}).` }));
    sock.on('close', () => finish({ ok: false, status: 0, error: 'The camera closed the RTSP connection.' }));
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end);
        const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] || 0);
        if (buf.length < end + 4 + len) return;
        const msg = buf.slice(0, end + 4 + len);
        buf = buf.slice(end + 4 + len);
        onReply(parseResponse(msg));
      }
    });
    sock.on('connect', () => {
      onReply = () => {
        // OPTIONS answered (whatever it said): now DESCRIBE
        onReply = (r) => {
          if (r.status === 401) {
            const digest = parseChallenges(r.headers['www-authenticate']).find((c) => c.scheme === 'digest');
            if (authTried) return finish({ ok: false, status: 401, error: 'The camera refused the Camera Account user name or password.' });
            if (!digest) return finish({ ok: false, status: 401, error: 'The camera asked for an unencrypted sign-in; the password was not sent.' });
            authTried = true;
            const p = digest.params;
            const qop = p.qop && /\bauth\b/.test(p.qop) ? 'auth' : undefined;
            const nc = '00000001';
            const cnonce = crypto.randomBytes(8).toString('hex');
            const response = digestResponse({ username: o.username, realm: p.realm || '', password: o.password, method: 'DESCRIBE', uri, nonce: p.nonce || '', qop, nc, cnonce });
            const fields = [`username="${o.username.replace(/"/g, '')}"`, `realm="${p.realm || ''}"`, `nonce="${p.nonce || ''}"`, `uri="${uri}"`, `response="${response}"`];
            if (p.opaque) fields.push(`opaque="${p.opaque}"`);
            if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
            send('DESCRIBE', { Accept: 'application/sdp', Authorization: `Digest ${fields.join(', ')}` });
            return undefined;
          }
          if (r.status !== 200) {
            return finish({ ok: false, status: r.status, error: r.status === 404 ? `The camera has no stream at ${o.path || '/stream1'}.` : r.status === 453 ? 'The camera is busy (too many viewers).' : `The camera answered RTSP ${r.status}.` });
          }
          const sdp = parseSdp(r.body);
          return finish({ ok: true, status: 200, ...sdp });
        };
        send('DESCRIBE', { Accept: 'application/sdp' });
      };
      send('OPTIONS');
    });
  });
}
