// A minimal RTSP camera for the go2rtc integration tests: Digest auth (realm "TP-Link IP-Camera",
// like Tapo), one H.264 video track from an Annex B file (frames split on AUD NAL units), RTP over
// TCP interleaved only, looping at a fixed frame rate. Records requests and sessions.
// (The full Tapo simulator, with PTZ-driven views and quirks, is tools/tapo-sim/, lane C.)

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

export const REALM = 'TP-Link IP-Camera';
const md5 = (/** @type {string} */ s) => crypto.createHash('md5').update(s).digest('hex');

/** Split an Annex B stream into NAL units. @param {Buffer} buf @returns {Buffer[]} */
export function splitNals(buf) {
  const starts = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
    while (end > starts[k] && buf[end - 1] === 0) end--; // the 4-byte start code's leading zero
    if (end > starts[k]) nals.push(buf.subarray(starts[k], end));
  }
  return nals;
}

/** Access units, split on AUD (type 9); the AUDs themselves are dropped. @param {Buffer[]} nals */
export function accessUnits(nals) {
  const aus = [];
  let cur = [];
  for (const n of nals) {
    if ((n[0] & 0x1f) === 9) {
      if (cur.length) aus.push(cur);
      cur = [];
    } else cur.push(n);
  }
  if (cur.length) aus.push(cur);
  return aus;
}

/**
 * @param {{ file: string, username?: string, password?: string, fps?: number, path?: string }} o
 */
export async function startMiniRtsp(o) {
  const username = o.username ?? 'camacct';
  let password = o.password ?? 'se&cret';
  const fps = o.fps ?? 15;
  const nals = splitNals(fs.readFileSync(o.file));
  const aus = accessUnits(nals);
  const sps = nals.find((n) => (n[0] & 0x1f) === 7);
  const pps = nals.find((n) => (n[0] & 0x1f) === 8);
  if (!sps || !pps) throw new Error('fixture without SPS/PPS');
  const nonce = crypto.randomBytes(8).toString('hex');
  const log = { requests: /** @type {string[]} */ ([]), sessions: 0, teardowns: 0, authFailures: 0, active: 0, packets: 0 };
  /** @type {Set<net.Socket>} */
  const sockets = new Set();

  const sdp = (host) => [
    'v=0', `o=- 14665860 31787219 IN IP4 ${host}`, 's=Session streamed by "TP-LINK RTSP Server"', 't=0 0', 'a=control:*',
    'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
    `a=fmtp:96 packetization-mode=1; profile-level-id=${sps.subarray(1, 4).toString('hex')}; sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`,
    'a=control:track1', '',
  ].join('\r\n');

  /** @param {string} header @param {string} method */
  const authOk = (header, method) => {
    if (!header || !/^Digest /i.test(header)) return false;
    const f = Object.fromEntries([...header.slice(7).matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));
    if (f.username !== username || f.realm !== REALM || f.nonce !== nonce) return false;
    const ha1 = md5(`${username}:${REALM}:${password}`);
    const ha2 = md5(`${method}:${f.uri}`);
    return f.response === (f.qop ? md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`));
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    let session = '';
    let seq = Math.floor(Math.random() * 60000);
    let ts = Math.floor(Math.random() * 1e9);
    let frame = 0;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    sock.on('close', () => {
      stop();
      if (session) log.active = Math.max(0, log.active - 1);
      sockets.delete(sock);
    });
    sock.on('error', () => {});
    const reply = (cseq, status, headers = {}, body = '') => {
      const lines = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, 'Server: mini-rtsp'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    };
    const sendAu = () => {
      const au = aus[frame % aus.length];
      frame++;
      au.forEach((nal, i) => {
        const last = i === au.length - 1;
        const packets = [];
        if (nal.length <= 1400) packets.push(nal);
        else {
          const hdr = nal[0];
          for (let off = 1; off < nal.length; off += 1400) {
            const part = nal.subarray(off, Math.min(nal.length, off + 1400));
            const fuS = off === 1 ? 0x80 : 0;
            const fuE = off + 1400 >= nal.length ? 0x40 : 0;
            packets.push(Buffer.concat([Buffer.from([(hdr & 0xe0) | 28, fuS | fuE | (hdr & 0x1f)]), part]));
          }
        }
        packets.forEach((payload, j) => {
          const rtp = Buffer.alloc(12);
          rtp[0] = 0x80;
          rtp[1] = (last && j === packets.length - 1 ? 0x80 : 0) | 96;
          rtp.writeUInt16BE(seq++ & 0xffff, 2);
          rtp.writeUInt32BE(ts >>> 0, 4);
          rtp.writeUInt32BE(0x1234abcd, 8);
          const pkt = Buffer.concat([rtp, payload]);
          const frameHdr = Buffer.from([0x24, 0, pkt.length >> 8, pkt.length & 255]);
          sock.write(Buffer.concat([frameHdr, pkt]));
          log.packets++;
        });
      });
      ts += Math.round(90000 / fps);
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf[0] === 0x24) { // interleaved data from the client (RTCP): skip
          if (buf.length < 4) return;
          const len = buf.readUInt16BE(2);
          if (buf.length < 4 + len) return;
          buf = buf.subarray(4 + len);
          continue;
        }
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        const [reqLine, ...hl] = head.split('\r\n');
        const [method, uri] = reqLine.split(' ');
        const h = Object.fromEntries(hl.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
        const len = Number(h['content-length'] || 0);
        if (len) buf = buf.subarray(len);
        log.requests.push(method);
        const cseq = h.cseq;
        if (method === 'OPTIONS') reply(cseq, '200 OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
        else if (method === 'GET_PARAMETER') reply(cseq, '200 OK', session ? { Session: session } : {});
        else if (method === 'DESCRIBE') {
          if (o.path && !new URL(uri).pathname.endsWith(o.path)) reply(cseq, '404 Not Found');
          else if (!authOk(h.authorization, 'DESCRIBE')) {
            if (h.authorization) log.authFailures++;
            reply(cseq, '401 Unauthorized', { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${nonce}"` });
          } else reply(cseq, '200 OK', { 'Content-Type': 'application/sdp', 'Content-Base': uri.endsWith('/') ? uri : `${uri}/` }, sdp('127.0.0.1'));
        } else if (method === 'SETUP') {
          if (!/RTP\/AVP\/TCP/.test(h.transport || '')) reply(cseq, '461 Unsupported Transport');
          else {
            session = crypto.randomBytes(4).toString('hex');
            log.sessions++;
            log.active++;
            reply(cseq, '200 OK', { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1', Session: `${session};timeout=60` });
          }
        } else if (method === 'PLAY') {
          reply(cseq, '200 OK', { Session: session, Range: 'npt=0.000-' });
          stop();
          sendAu();
          timer = setInterval(sendAu, 1000 / fps);
        } else if (method === 'TEARDOWN') {
          log.teardowns++;
          reply(cseq, '200 OK', { Session: session });
          stop();
        } else reply(cseq, '501 Not Implemented');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return {
    port,
    log,
    frames: aus.length,
    setPassword: (pw) => { password = pw; },
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r(undefined));
    }),
  };
}
