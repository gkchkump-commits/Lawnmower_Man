import { describe, it, expect } from 'vitest';
import dgram from 'node:dgram';
import net from 'node:net';
import path from 'node:path';
import { digestResponse, parseChallenges, parseSdp, rtspDescribe } from '../../../electron/tapo/rtsp-probe.js';
import { discover, parseProbeMatches, probeMessage } from '../../../electron/tapo/discovery.js';
import { parseXml, path as xpath } from '../../../electron/tapo/xml.js';
import { startMiniRtsp } from './helpers/mini-rtsp.js';

const CLIP = path.resolve('tests/unit/tapo/fixtures/clip-160x90.h264');

describe('rtspDescribe', () => {
  it('computes the contract Digest vector', () => {
    expect(digestResponse({ username: 'camacct', realm: 'TP-Link IP-Camera', password: 'se&cret', method: 'DESCRIBE', uri: 'rtsp://192.168.1.50:554/stream1', nonce: '0a1b2c3d4e5f6789' })).toBe('8b8bb29dc5fde00cacab3ee65e4303a9');
  });

  it('parses challenges and SDP', () => {
    expect(parseChallenges(['Digest realm="TP-Link IP-Camera", nonce="abc", qop="auth"', 'Basic realm="x"'])).toEqual([
      { scheme: 'digest', params: { realm: 'TP-Link IP-Camera', nonce: 'abc', qop: 'auth' } },
      { scheme: 'basic', params: { realm: 'x' } },
    ]);
    expect(parseSdp('v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\nm=audio 0 RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\n')).toEqual({ codecs: ['H264/90000', 'PCMA/8000'], fmtp: ['packetization-mode=1'] });
  });

  it('describes a stream with Digest, retries once on a wrong password, reports a missing path', async () => {
    const cam = await startMiniRtsp({ file: CLIP, path: '/stream1' });
    try {
      const ok = await rtspDescribe({ ip: '127.0.0.1', port: cam.port, path: '/stream1', username: 'camacct', password: 'se&cret' });
      expect(ok).toMatchObject({ ok: true, status: 200, codecs: ['H264/90000'] });
      expect(ok.fmtp[0]).toMatch(/sprop-parameter-sets=/);
      const bad = await rtspDescribe({ ip: '127.0.0.1', port: cam.port, path: '/stream1', username: 'camacct', password: 'wrong' });
      expect(bad).toMatchObject({ ok: false, status: 401 });
      expect(bad.error).toMatch(/refused/);
      expect(cam.log.authFailures).toBe(1); // one try with credentials, no loop
      const missing = await rtspDescribe({ ip: '127.0.0.1', port: cam.port, path: '/stream8', username: 'camacct', password: 'se&cret' });
      expect(missing).toMatchObject({ ok: false, status: 404 });
    } finally {
      await cam.close();
    }
  });

  it('never answers a Basic-only challenge (the password would travel in clear text)', async () => {
    let sawAuth = false;
    const srv = net.createServer((s) => {
      s.on('data', (d) => {
        const t = String(d);
        if (/Authorization:/i.test(t)) sawAuth = true;
        const cseq = /CSeq: (\d+)/.exec(t)?.[1];
        if (t.startsWith('OPTIONS')) s.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`);
        else s.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n`);
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await rtspDescribe({ ip: '127.0.0.1', port: /** @type {any} */ (srv.address()).port, username: 'u', password: 'p' });
      expect(r).toMatchObject({ ok: false, status: 401 });
      expect(r.error).toMatch(/unencrypted/);
      expect(sawAuth).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('times out and reports refused connections', async () => {
    const conns = [];
    const silent = net.createServer((s) => conns.push(s));
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const port = /** @type {any} */ (silent.address()).port;
    try {
      expect(await rtspDescribe({ ip: '127.0.0.1', port, username: 'u', password: 'p', timeoutMs: 150 })).toMatchObject({ ok: false, status: 0, error: expect.stringMatching(/in time/) });
    } finally {
      for (const c of conns) c.destroy();
      await new Promise((r) => silent.close(r));
    }
    expect((await rtspDescribe({ ip: '127.0.0.1', port, username: 'u', password: 'p' })).error).toMatch(/refused/);
  });
});

describe('WS-Discovery', () => {
  it('builds the ONVIF Probe', () => {
    const doc = parseXml(probeMessage('1234'));
    expect(xpath(doc, 'Header/MessageID')?.text).toBe('uuid:1234');
    expect(xpath(doc, 'Body/Probe/Types')?.text).toBe('dn:NetworkVideoTransmitter');
  });

  const MATCH = (xaddr) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/TP-IPC onvif://www.onvif.org/hardware/C211 onvif://www.onvif.org/Profile/Streaming</d:Scopes><d:XAddrs>${xaddr}</d:XAddrs></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  it('parses ProbeMatches', () => {
    expect(parseProbeMatches(MATCH('http://192.168.1.50:2020/onvif/device_service'))).toEqual([{ xaddrs: ['http://192.168.1.50:2020/onvif/device_service'], name: 'TP-IPC', hardware: 'C211' }]);
    expect(parseProbeMatches('<not xml')).toEqual([]);
  });

  it('collects LAN cameras from replies, deduplicated (a loopback responder stands in for the multicast group)', async () => {
    const responder = dgram.createSocket('udp4');
    await new Promise((r) => responder.bind(0, '127.0.0.1', r));
    responder.on('message', (msg, rinfo) => {
      expect(String(msg)).toContain('NetworkVideoTransmitter');
      for (const x of ['http://192.168.1.50:2020/onvif/device_service', 'http://192.168.1.50:2020/onvif/device_service', 'http://8.8.8.8:2020/onvif/device_service']) {
        responder.send(Buffer.from(MATCH(x)), rinfo.port, rinfo.address);
      }
    });
    try {
      const found = await discover({ timeoutMs: 400, target: { address: '127.0.0.1', port: /** @type {any} */ (responder.address()).port } });
      // 8.8.8.8 is not on the LAN, and the reply came from loopback (not allowed): dropped
      expect(found).toEqual([{ host: '192.168.1.50', xaddr: 'http://192.168.1.50:2020/onvif/device_service', name: 'TP-IPC', hardware: 'C211', model: 'C211' }]);
    } finally {
      responder.close();
    }
  });
});
