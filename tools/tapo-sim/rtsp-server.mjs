// The simulated camera's RTSP server (contract §11.3): RTSP/1.0 over TCP with Digest auth (realm
// "TP-Link IP-Camera"), /stream1 + /stream2 (/stream8 is 404, as on the C545D), RTP/AVP/TCP
// interleaved only (UDP → 461), the camera's 2-session budget (453 for the next one) and its
// ~15 s session timeout: a session that sees no RTSP request for that long is dropped (RTCP
// receiver reports do not count, as on the C220 in CameraHub's notes).
//
// Video: the pre-encoded 1-second GOPs of fixtures.mjs, 15 fps, 90 kHz timestamps, one RTP
// packet per NAL unit (FU-A above 1400 bytes), marker on the last packet of a frame. The segment
// follows the virtual pan/tilt position: when the view changes the next frame starts the new
// segment at its IDR (a scene-cut keyframe), so the picture moves with the camera within a frame;
// while the motor runs it alternates between the two cells around the position, so the picture
// never looks settled mid-move.
// Audio (track2, PCMA/8000) sends A-law silence, only when SETUP'd.

import crypto from 'node:crypto';
import net from 'node:net';
import { FPS } from './geometry.mjs';
import { selectSegment } from './fixtures.mjs';
import { NAL, nalType, rtpPacket, rtpPayloads } from './h264.mjs';

export const REALM = 'TP-Link IP-Camera';
const STREAMS = { stream1: 'stream1', stream2: 'stream2' };
const MISSING_STREAMS = new Set(['stream8']); // MJPEG not implemented → 404 (C545D does the same)
const MAX_HEAD = 64 * 1024;
const BACKLOG_LIMIT = 4 * 1024 * 1024;

/** @param {string} s */
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Parse `Digest a="b", c=d` into a record. @param {string} v */
export function parseAuthParams(v) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(v))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

/**
 * The Digest response a client must send (RFC 2617; qop optional).
 * @param {{ username: string, realm: string, password: string, method: string, uri: string, nonce: string, qop?: string, nc?: string, cnonce?: string }} d
 */
export function digestResponse(d) {
  const ha1 = md5(`${d.username}:${d.realm}:${d.password}`);
  const ha2 = md5(`${d.method}:${d.uri}`);
  return d.qop ? md5(`${ha1}:${d.nonce}:${d.nc}:${d.cnonce}:${d.qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
}

/**
 * @typedef {{ id: string, conn: Conn, path: string, stream: import('./fixtures.mjs').StreamFixtures,
 *   video: number|null, audio: number|null, state: 'ready'|'playing'|'paused'|'teardown'|'timeout'|'closed'|'rejected',
 *   createdAt: number, lastRequestAt: number, ssrc: number, audioSsrc: number, seq: number, audioSeq: number,
 *   ts0: number, frameNo: number, startAt: number, seg: import('./fixtures.mjs').Segment|null, segFrame: number,
 *   segments: Array<{ at: number, id: string }>, framesSent: number, framesDropped: number, bytesSent: number,
 *   dropUntilKey: boolean, frameTimer: NodeJS.Timeout|null, audioTimer: NodeJS.Timeout|null, endedAt?: number, endReason?: string }} Session
 * @typedef {{ socket: net.Socket, buf: Buffer, nonce: string, sessions: Set<Session>, peer: string, authed: boolean }} Conn
 */

/**
 * @param {{ camera: import('./camera.mjs').SimCamera, host: string, port: number, fixtures: Record<string, import('./fixtures.mjs').StreamFixtures> }} o
 * @returns {Promise<{ port: number, close: () => Promise<void>, snapshot: () => any }>}
 */
export async function startRtspServer(o) {
  const cam = o.camera;
  /** @type {Set<Conn>} */
  const conns = new Set();
  /** @type {Set<Session>} */
  const live = new Set();
  /** @type {Session[]} */
  const ended = [];
  const stats = { sessionsTotal: 0, rejected: 0, timeouts: 0, teardowns: 0, notFound: 0 };
  let port = 0;

  const server = net.createServer((socket) => {
    if (cam.scenario.offline) {
      socket.destroy();
      return;
    }
    /** @type {Conn} */
    const conn = { socket, buf: Buffer.alloc(0), nonce: crypto.randomBytes(16).toString('hex'), sessions: new Set(), peer: `${socket.remoteAddress}:${socket.remotePort}`, authed: false };
    conns.add(conn);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
      try {
        pump(conn);
      } catch (err) {
        cam.log('warn', `[sim] RTSP ${conn.peer}: ${/** @type {Error} */ (err).message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      conns.delete(conn);
      for (const s of conn.sessions) endSession(s, s.state === 'teardown' ? 'teardown' : 'closed');
    });
  });

  // Session timeout watchdog (and nothing else: frames run on their own timers)
  const watchdog = setInterval(() => {
    const limit = (Number(cam.quirks.sessionTimeoutSec) || 15) * 1000;
    const now = cam.now();
    for (const s of [...live]) {
      if (now - s.lastRequestAt > limit) {
        stats.timeouts++;
        cam.record({ service: 'rtsp', op: 'SESSION-TIMEOUT', args: { session: s.id, path: s.path, idleMs: now - s.lastRequestAt }, status: 'timeout' });
        endSession(s, 'timeout');
        if (![...s.conn.sessions].some((x) => live.has(x))) s.conn.socket.destroy();
      }
    }
  }, 500);
  watchdog.unref?.();

  /** @param {Conn} conn */
  function pump(conn) {
    for (;;) {
      const b = conn.buf;
      if (!b.length) return;
      if (b[0] === 0x24) {
        // interleaved data from the client ($ ch len16): RTCP receiver reports. Ignored (they do
        // not keep the session alive on this camera).
        if (b.length < 4) return;
        const len = b.readUInt16BE(2);
        if (b.length < 4 + len) return;
        conn.buf = b.subarray(4 + len);
        continue;
      }
      const end = b.indexOf('\r\n\r\n');
      if (end < 0) {
        if (b.length > MAX_HEAD) throw new Error('request head too large');
        return;
      }
      const head = b.subarray(0, end).toString('latin1');
      const lines = head.split('\r\n');
      const [method = '', url = '', version = ''] = lines[0].split(' ');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const cl = Number(headers['content-length'] || 0);
      if (b.length < end + 4 + cl) return;
      const body = b.subarray(end + 4, end + 4 + cl).toString('utf8');
      conn.buf = b.subarray(end + 4 + cl);
      if (!/^RTSP\/1\.0$/.test(version)) throw new Error(`not RTSP: ${lines[0].slice(0, 60)}`);
      request(conn, { method, url, headers, body, cseq: headers.cseq || '0' });
    }
  }

  /**
   * @param {Conn} conn @param {{ cseq: string }} req @param {number} status @param {string} reason
   * @param {Record<string, string>} [headers] @param {string} [body]
   */
  function reply(conn, req, status, reason, headers = {}, body = '') {
    const h = { CSeq: req.cseq, Date: new Date(cam.now()).toUTCString(), ...headers };
    if (body) h['Content-Length'] = String(Buffer.byteLength(body));
    const text = `RTSP/1.0 ${status} ${reason}\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`;
    if (!conn.socket.destroyed) conn.socket.write(text);
  }

  /**
   * Digest check: true, or a 401 was sent.
   * @param {Conn} conn @param {{ method: string, headers: Record<string, string>, cseq: string }} req @param {any} call
   */
  function authorized(conn, req, call) {
    const h = req.headers.authorization || '';
    if (h) {
      const [scheme, ...rest] = h.split(' ');
      const ok = /^digest$/i.test(scheme)
        ? (() => {
            const p = parseAuthParams(rest.join(' '));
            if (p.username !== cam.username || p.realm !== REALM || p.nonce !== conn.nonce || !p.uri) return false;
            return p.response === digestResponse({ username: p.username, realm: REALM, password: cam.password, method: req.method, uri: p.uri, nonce: p.nonce, qop: p.qop, nc: p.nc, cnonce: p.cnonce });
          })()
        : /^basic$/i.test(scheme) && cam.quirks.rtspAcceptBasic && Buffer.from(rest.join(''), 'base64').toString('utf8') === `${cam.username}:${cam.password}`;
      if (ok) {
        conn.authed = true;
        return true;
      }
      cam.authFailures.rtsp++;
      call.why = 'wrong credentials';
    }
    call.status = 401;
    reply(conn, req, 401, 'Unauthorized', {
      'WWW-Authenticate': `Digest realm="${REALM}", nonce="${conn.nonce}"`,
    });
    return false;
  }

  /** The stream and track a request URL names. @param {string} url */
  function target(url) {
    const m = /^rtsp:\/\/[^/]+(\/[^?#]*)?/i.exec(url);
    const p = (m ? m[1] || '/' : url).replace(/\/+$/, '');
    const parts = p.split('/').filter(Boolean);
    return { stream: parts[0] || '', track: parts[1] || '' };
  }

  /** @param {Conn} conn @param {{ method: string, url: string, headers: Record<string, string>, body: string, cseq: string }} req */
  function request(conn, req) {
    const { stream, track } = target(req.url);
    const sessionId = (req.headers.session || '').split(';')[0].trim();
    const call = cam.record({ service: 'rtsp', op: req.method, args: { path: `/${stream}${track ? `/${track}` : ''}`, session: sessionId || null }, status: 0 });
    // any request on the connection keeps its sessions alive (and one naming a session, that one)
    const now = cam.now();
    for (const s of conn.sessions) s.lastRequestAt = now;
    const named = sessionId ? [...live].find((s) => s.id === sessionId) : null;
    if (named) named.lastRequestAt = now;
    const done = (/** @type {number} */ status, /** @type {string} */ reason, /** @type {Record<string,string>} */ headers, /** @type {string} */ body) => {
      call.status = status;
      reply(conn, req, status, reason, headers, body);
    };

    switch (req.method) {
      case 'OPTIONS':
        return done(200, 'OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, GET_PARAMETER, TEARDOWN' });
      case 'DESCRIBE': {
        if (!authorized(conn, req, call)) return undefined;
        const fx = STREAMS[/** @type {keyof typeof STREAMS} */ (stream)] && o.fixtures[stream];
        if (!fx) {
          if (MISSING_STREAMS.has(stream) || stream) stats.notFound++;
          return done(404, 'Not Found');
        }
        const hostIp = conn.socket.localAddress || o.host;
        const sdp = [
          'v=0',
          `o=- 14665860 31787219 1 IN IP4 ${hostIp}`,
          's=Session streamed by "TP-LINK RTSP Server"',
          't=0 0',
          'm=video 0 RTP/AVP 96',
          'c=IN IP4 0.0.0.0',
          'b=AS:4096',
          'a=range:npt=0-',
          'a=control:track1',
          'a=rtpmap:96 H264/90000',
          `a=fmtp:96 packetization-mode=1; profile-level-id=${fx.profileLevelId}; sprop-parameter-sets=${fx.sprop}`,
          'm=audio 0 RTP/AVP 8',
          'a=rtpmap:8 PCMA/8000',
          'a=control:track2',
          '',
        ].join('\r\n');
        return done(200, 'OK', { 'Content-Base': `rtsp://${hostIp}:${port}/${stream}/`, 'Content-Type': 'application/sdp' }, sdp);
      }
      case 'SETUP': {
        if (!authorized(conn, req, call)) return undefined;
        const fx = o.fixtures[stream];
        if (!fx || !STREAMS[/** @type {keyof typeof STREAMS} */ (stream)]) return done(404, 'Not Found');
        if (track !== 'track1' && track !== 'track2') return done(404, 'Not Found');
        const transport = req.headers.transport || '';
        const im = /interleaved=(\d+)(?:-(\d+))?/.exec(transport);
        if (!/RTP\/AVP\/TCP/i.test(transport) || !im) return done(461, 'Unsupported Transport');
        let s = sessionId ? [...conn.sessions].find((x) => x.id === sessionId && live.has(x)) : null;
        if (sessionId && !s) return done(454, 'Session Not Found');
        if (!s) {
          const used = live.size + (Number(cam.scenario.viewers) || 0);
          if (used >= (Number(cam.quirks.maxRtspSessions) || 2)) {
            stats.rejected++;
            call.why = `${live.size} sessions + ${cam.scenario.viewers || 0} other viewers`;
            return done(453, 'Not Enough Bandwidth');
          }
          s = newSession(conn, stream, fx);
        }
        const ch = Number(im[1]);
        if (track === 'track1') s.video = ch;
        else s.audio = ch;
        const ssrc = (track === 'track1' ? s.ssrc : s.audioSsrc).toString(16).toUpperCase().padStart(8, '0');
        const timeout = cam.quirks.rtspAdvertiseTimeout ? `;timeout=${Number(cam.quirks.sessionTimeoutSec) || 15}` : '';
        call.args.session = s.id;
        return done(200, 'OK', { Transport: `RTP/AVP/TCP;unicast;interleaved=${ch}-${ch + 1};ssrc=${ssrc};mode="play"`, Session: `${s.id}${timeout}` });
      }
      case 'PLAY': {
        if (!authorized(conn, req, call)) return undefined;
        const s = named && named.conn === conn ? named : null;
        if (!s) return done(454, 'Session Not Found');
        const base = `rtsp://${conn.socket.localAddress}:${port}/${s.path}`;
        done(200, 'OK', {
          Session: s.id,
          Range: 'npt=0.000-',
          'RTP-Info': `url=${base}/track1;seq=${s.seq};rtptime=${s.ts0 + s.frameNo * 6000}${s.audio !== null ? `,url=${base}/track2;seq=${s.audioSeq};rtptime=0` : ''}`,
        });
        play(s);
        return undefined;
      }
      case 'PAUSE': {
        if (!authorized(conn, req, call)) return undefined;
        if (!named) return done(454, 'Session Not Found');
        pause(named, 'paused');
        return done(200, 'OK', { Session: named.id });
      }
      case 'GET_PARAMETER':
      case 'SET_PARAMETER':
        if (!authorized(conn, req, call)) return undefined;
        return done(200, 'OK', named ? { Session: named.id } : {});
      case 'TEARDOWN': {
        if (!authorized(conn, req, call)) return undefined;
        if (named) {
          stats.teardowns++;
          endSession(named, 'teardown');
        }
        return done(200, 'OK', named ? { Session: named.id } : {});
      }
      default:
        return done(501, 'Not Implemented');
    }
  }

  /** @param {Conn} conn @param {string} path @param {import('./fixtures.mjs').StreamFixtures} stream @returns {Session} */
  function newSession(conn, path, stream) {
    const now = cam.now();
    /** @type {Session} */
    const s = {
      id: crypto.randomBytes(4).readUInt32BE(0).toString(16).toUpperCase().padStart(8, '0'),
      conn, path, stream, video: null, audio: null, state: 'ready', createdAt: now, lastRequestAt: now,
      ssrc: crypto.randomBytes(4).readUInt32BE(0), audioSsrc: crypto.randomBytes(4).readUInt32BE(0),
      seq: crypto.randomBytes(2).readUInt16BE(0), audioSeq: crypto.randomBytes(2).readUInt16BE(0),
      ts0: crypto.randomBytes(4).readUInt32BE(0) >>> 2, frameNo: 0, startAt: 0, seg: null, segFrame: 0, segments: [],
      framesSent: 0, framesDropped: 0, bytesSent: 0, dropUntilKey: false, frameTimer: null, audioTimer: null,
    };
    conn.sessions.add(s);
    live.add(s);
    stats.sessionsTotal++;
    return s;
  }

  /** @param {Session} s */
  function play(s) {
    if (s.state === 'playing') return;
    s.state = 'playing';
    s.startAt = cam.now() - s.frameNo * (1000 / FPS);
    const tick = () => {
      s.frameTimer = null;
      if (s.state !== 'playing') return;
      sendFrame(s);
      const next = s.startAt + s.frameNo * (1000 / FPS);
      s.frameTimer = setTimeout(tick, Math.max(0, next - cam.now()));
      s.frameTimer.unref?.();
    };
    tick();
    if (s.audio !== null) {
      let ts = 0;
      s.audioTimer = setInterval(() => {
        if (s.state !== 'playing') return;
        const pkt = rtpPacket({ payloadType: 8, seq: s.audioSeq++, timestamp: ts, ssrc: s.audioSsrc, marker: ts === 0, payload: Buffer.alloc(160, 0xd5) });
        ts += 160;
        writeInterleaved(s, /** @type {number} */ (s.audio), pkt);
      }, 20);
      s.audioTimer.unref?.();
    }
  }

  /** @param {Session} s @param {'paused'} state */
  function pause(s, state) {
    s.state = state;
    if (s.frameTimer) clearTimeout(s.frameTimer);
    if (s.audioTimer) clearInterval(s.audioTimer);
    s.frameTimer = null;
    s.audioTimer = null;
  }

  /** @param {Session} s */
  function sendFrame(s) {
    const ts = s.ts0 + s.frameNo * (90000 / FPS);
    s.frameNo++;
    if (cam.scenario.privacy && cam.quirks.privacyKillsStream) return;
    // while a motor runs the picture changes every frame (the two cells around the position
    // alternate on that axis); at rest it is the nearest cell
    const want = selectSegment(s.stream, cam.ptz.position, cam.quirks, cam.scenario, { ...cam.ptz.movingAxes, frameNo: s.frameNo });
    if (!s.seg || s.segFrame >= s.seg.frames.length || want.id !== s.seg.id) {
      if (!s.seg || want.id !== s.seg.id) {
        s.segments.push({ at: cam.now(), id: want.id });
        if (s.segments.length > 300) s.segments.splice(0, 100);
      }
      s.seg = want;
      s.segFrame = 0;
    }
    const key = s.segFrame === 0;
    const frame = s.seg.frames[s.segFrame++];
    if (s.video === null) return;
    if (s.conn.socket.writableLength > BACKLOG_LIMIT) s.dropUntilKey = true; // the client stopped reading
    if (s.dropUntilKey) {
      if (!key || s.conn.socket.writableLength > BACKLOG_LIMIT / 2) {
        s.framesDropped++;
        return;
      }
      s.dropUntilKey = false;
    }
    const nals = frame.filter((n) => nalType(n) !== NAL.AUD);
    nals.forEach((nal, ni) => {
      const payloads = rtpPayloads(nal);
      payloads.forEach((payload, pi) => {
        const marker = ni === nals.length - 1 && pi === payloads.length - 1;
        writeInterleaved(s, /** @type {number} */ (s.video), rtpPacket({ payloadType: 96, seq: s.seq++, timestamp: ts, ssrc: s.ssrc, marker, payload }));
      });
    });
    s.framesSent++;
  }

  /** @param {Session} s @param {number} channel @param {Buffer} pkt */
  function writeInterleaved(s, channel, pkt) {
    const sock = s.conn.socket;
    if (sock.destroyed) return;
    const h = Buffer.from([0x24, channel, (pkt.length >> 8) & 0xff, pkt.length & 0xff]);
    sock.write(Buffer.concat([h, pkt]));
    s.bytesSent += pkt.length + 4;
  }

  /** @param {Session} s @param {'teardown'|'timeout'|'closed'} reason */
  function endSession(s, reason) {
    if (!live.has(s)) return;
    if (s.frameTimer) clearTimeout(s.frameTimer);
    if (s.audioTimer) clearInterval(s.audioTimer);
    s.frameTimer = null;
    s.audioTimer = null;
    s.state = reason;
    s.endedAt = cam.now();
    s.endReason = reason;
    live.delete(s);
    ended.push(s);
    if (ended.length > 30) ended.shift();
  }

  /** @param {Session} s */
  const view = (s) => ({
    id: s.id, path: s.path, state: s.state, peer: s.conn.peer, video: s.video !== null, audio: s.audio !== null,
    segment: s.seg?.id ?? null, segments: s.segments.slice(-50), framesSent: s.framesSent, framesDropped: s.framesDropped,
    bytesSent: s.bytesSent, ageMs: cam.now() - s.createdAt, idleMs: cam.now() - s.lastRequestAt, endReason: s.endReason ?? null,
  });

  // ---- online / offline ----
  /** @type {Promise<void>} */
  let transition = Promise.resolve();
  const onOffline = (/** @type {boolean} */ off) => {
    transition = transition.then(() => new Promise((resolve) => {
      if (off) {
        for (const c of conns) c.socket.destroy();
        if (server.listening) server.close(() => resolve(undefined));
        else resolve(undefined);
      } else if (!server.listening) {
        server.once('error', () => resolve(undefined));
        server.listen(port, o.host, () => resolve(undefined));
      } else resolve(undefined);
    }));
  };
  cam.onOffline.add(onOffline);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  port = /** @type {net.AddressInfo} */ (server.address()).port;

  return {
    port,
    snapshot: () => ({ live: [...live].map(view), ended: ended.map(view), stats: { ...stats } }),
    close: async () => {
      clearInterval(watchdog);
      cam.onOffline.delete(onOffline);
      await transition;
      for (const s of [...live]) endSession(s, 'closed');
      for (const c of conns) c.socket.destroy();
      await new Promise((resolve) => (server.listening ? server.close(() => resolve(undefined)) : resolve(undefined)));
    },
  };
}
