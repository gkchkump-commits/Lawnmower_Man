// The RTSP auth proxy (security review): go2rtc never has the Camera Account, a Basic challenge
// is never answered, a refused sign-in is tried once, other local programs cannot use the proxy,
// and the camera's session is ended with TEARDOWN when the video stops.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { RtspAuthProxy, RtspFramer, digestAuthorization } from '../../../electron/tapo/rtsp-auth-proxy.js';
import { Go2rtcSidecar, buildGo2rtcConfig, go2rtcBinaryPath, go2rtcEnv } from '../../../electron/tapo/go2rtc.js';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { tmpDir } from '../helpers/tmp.js';

const BINARY = go2rtcBinaryPath({ isPackaged: false, appRoot: path.resolve('.'), env: {} });
const HAVE_BINARY = process.platform === 'linux' && fs.existsSync(BINARY);
const PW = 'se&cret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Array<() => Promise<void>|void>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f()?.catch?.(() => {});
  cleanup = [];
});

/** A "camera" whose RTSP server only offers Basic (an impersonator on the camera's address). */
async function basicOnlyCamera() {
  const seen = [];
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const req = buf.slice(0, i);
        buf = buf.slice(i + 4);
        seen.push(req);
        const cseq = /CSeq:\s*(\d+)/i.exec(req)?.[1] || '1';
        if (/^OPTIONS/.test(req)) s.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n`);
        else s.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Basic realm="TP-Link IP-Camera"\r\n\r\n`);
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { port: /** @type {net.AddressInfo} */ (server.address()).port, seen };
}

/** A tiny RTSP client (what go2rtc does), through the proxy. */
function rtspClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  const framer = new RtspFramer();
  const replies = [];
  let closed = false;
  sock.on('data', (d) => { for (const p of framer.push(d)) if (p.type === 'msg') replies.push(p.head); });
  sock.on('close', () => { closed = true; });
  sock.on('error', () => {});
  let cseq = 0;
  return {
    replies,
    get closed() { return closed; },
    send(method, url, extra = {}) {
      cseq++;
      sock.write(`${method} ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\n${Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      return cseq;
    },
    async reply(n, timeoutMs = 3000) {
      const t0 = Date.now();
      for (;;) {
        const r = replies.find((h) => new RegExp(`\\r\\nCSeq: ${n}(\\r|$)`, 'i').test(h));
        if (r) return r;
        if (closed || Date.now() - t0 > timeoutMs) return null;
        await sleep(20);
      }
    },
    close() { sock.destroy(); },
  };
}

describe('Digest answer', () => {
  it('matches the contract test vector (MD5, no qop)', () => {
    const a = digestAuthorization({ username: 'camacct', password: PW, method: 'DESCRIBE', uri: 'rtsp://192.168.1.50:554/stream1', challenge: { realm: 'TP-Link IP-Camera', nonce: '0a1b2c3d4e5f6789' }, nc: 1 });
    expect(a).toContain('response="8b8bb29dc5fde00cacab3ee65e4303a9"');
    expect(a).not.toContain(PW);
  });

  it('go2rtc is never given the Camera Account', () => {
    const cfg = buildGo2rtcConfig({ sourcePort: 4321, stream: 'stream1' });
    expect(JSON.parse(cfg).streams.lm_main).toBe('rtsp://127.0.0.1:4321/${LM_SRC_TOKEN}/stream1');
    const env = go2rtcEnv({ port: 1, apiUser: 'u', apiPass: 'p', sourceToken: 'abcdef0123456789' });
    expect(Object.keys(env).sort()).toEqual(['LM_G2R_PASS', 'LM_G2R_PORT', 'LM_G2R_USER', 'LM_SRC_TOKEN']);
    expect(() => go2rtcEnv({ port: 1, apiUser: 'u', apiPass: 'p', sourceToken: '' })).toThrow();
  });
});

describe('RtspAuthProxy', () => {
  it('a Basic challenge is never answered: the password is not sent, "insecure" is reported, nothing more reaches the camera', async () => {
    const cam = await basicOnlyCamera();
    const proxy = new RtspAuthProxy();
    cleanup.push(() => proxy.stop());
    let insecure = 0;
    proxy.on('insecure', () => insecure++);
    const { port, token } = await proxy.start({ ip: '127.0.0.1', port: cam.port, username: 'camacct', password: PW });
    const c = rtspClient(port);
    const url = `rtsp://127.0.0.1:${port}/${token}/stream1`;
    await c.reply(c.send('OPTIONS', url));
    c.send('DESCRIBE', url, { Accept: 'application/sdp' });
    for (let i = 0; i < 50 && !c.closed; i++) await sleep(20);
    expect(c.closed).toBe(true);
    expect(insecure).toBe(1);
    expect(proxy.state).toBe('insecure');
    expect(cam.seen.join('\n')).not.toMatch(/Authorization/i);
    // a reconnect does not reach the camera at all
    const n = cam.seen.length;
    const again = rtspClient(port);
    again.send('OPTIONS', url);
    await sleep(200);
    expect(again.closed).toBe(true);
    expect(cam.seen.length).toBe(n);
  });

  it('requests without the secret token are refused (other local programs cannot sign in through it)', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const proxy = new RtspAuthProxy();
    cleanup.push(() => proxy.stop());
    const { port } = await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: PW });
    const c = rtspClient(port);
    const r = await c.reply(c.send('DESCRIBE', `rtsp://127.0.0.1:${port}/stream1`));
    expect(r).toMatch(/^RTSP\/1\.0 404/);
    expect(sim.calls.filter((x) => x.service === 'rtsp' && x.op === 'DESCRIBE')).toEqual([]);
  });

  it('Digest against the simulated camera; the camera\'s URLs are rewritten to the proxy\'s', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const proxy = new RtspAuthProxy();
    cleanup.push(() => proxy.stop());
    const { port, token } = await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: PW });
    const c = rtspClient(port);
    cleanup.push(() => c.close());
    const url = `rtsp://127.0.0.1:${port}/${token}/stream1`;
    const d = await c.reply(c.send('DESCRIBE', url, { Accept: 'application/sdp' }));
    expect(d).toMatch(/^RTSP\/1\.0 200/);
    expect(d).toContain(`Content-Base: rtsp://127.0.0.1:${port}/${token}/stream1/`);
    expect(d).not.toContain(String(sim.rtspPort));
    const setup = await c.reply(c.send('SETUP', `${url}/track1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' }));
    expect(setup).toMatch(/^RTSP\/1\.0 200/);
    expect(sim.state.authFailures.rtsp).toBe(0);
  });

  it('a wrong password: one refused sign-in, "auth-failed", and no further attempt', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const proxy = new RtspAuthProxy();
    cleanup.push(() => proxy.stop());
    let failed = 0;
    proxy.on('auth-failed', () => failed++);
    const { port, token } = await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: 'wrong' });
    const url = `rtsp://127.0.0.1:${port}/${token}/stream1`;
    for (let k = 0; k < 3; k++) {
      const c = rtspClient(port);
      c.send('DESCRIBE', url, { Accept: 'application/sdp' });
      await sleep(300);
      c.close();
    }
    expect(failed).toBe(1);
    expect(sim.state.authFailures.rtsp).toBe(1);
    // new credentials start afresh
    await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: PW });
    const ok = rtspClient(port);
    cleanup.push(() => ok.close());
    expect(await ok.reply(ok.send('DESCRIBE', url, { Accept: 'application/sdp' }))).toMatch(/^RTSP\/1\.0 200/);
  });

  it('stop() ends a session left open with TEARDOWN', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const proxy = new RtspAuthProxy();
    const { port, token } = await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: PW });
    const c = rtspClient(port);
    cleanup.push(() => c.close());
    const url = `rtsp://127.0.0.1:${port}/${token}/stream1`;
    await c.reply(c.send('DESCRIBE', url, { Accept: 'application/sdp' }));
    const setup = await c.reply(c.send('SETUP', `${url}/track1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' }));
    const session = /Session: ([^;\r]+)/.exec(setup)[1];
    await c.reply(c.send('PLAY', url, { Session: session }));
    expect(sim.state.rtspSessions.live).toHaveLength(1);
    const t0 = Date.now();
    await proxy.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(sim.state.rtspSessions.live).toHaveLength(0);
    expect(sim.state.rtspSessions.ended.at(-1).endReason).toBe('teardown');
  });
});

describe.skipIf(!HAVE_BINARY)('go2rtc 1.9.14 behind the proxy', () => {
  it('an impersonator that asks for Basic gets no password from go2rtc (it has none) nor from the proxy', async () => {
    const cam = await basicOnlyCamera();
    const proxy = new RtspAuthProxy();
    cleanup.push(() => proxy.stop());
    const dir = tmpDir('lm-g2r-basic-');
    const sc = new Go2rtcSidecar({ binary: BINARY, configDir: dir, log: () => {} });
    cleanup.push(() => sc.stop());
    const src = await proxy.start({ ip: '127.0.0.1', port: cam.port, username: 'camacct', password: PW });
    const ep = await sc.start({ sourcePort: src.port, sourceToken: src.token, stream: 'stream1' });
    await new Promise((resolve) => {
      const req = http.get(`${ep.url}/api/stream.mp4?src=lm_main`, { headers: { Authorization: ep.auth }, agent: false }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      setTimeout(() => { req.destroy(); resolve(); }, 4000);
    });
    expect(cam.seen.length).toBeGreaterThan(0);
    expect(cam.seen.join('\n')).not.toMatch(/Authorization/i);
    expect(proxy.state).toBe('insecure');
    expect(fs.readFileSync(path.join(dir, 'go2rtc.yaml'), 'utf8')).not.toMatch(/cret|camacct/);
  }, 20_000);
});
