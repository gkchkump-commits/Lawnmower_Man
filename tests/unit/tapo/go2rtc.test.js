import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AUTH_LINE, GO2RTC_STREAM, Go2rtcSidecar, MISSING_DETAIL, buildGo2rtcConfig, go2rtcBinaryPath, go2rtcEnv, loopbackGet,
} from '../../../electron/tapo/go2rtc.js';
import { StreamRelay } from '../../../electron/tapo/stream-relay.js';
import { startMiniRtsp } from './helpers/mini-rtsp.js';

const ROOT = path.resolve('.');
const BINARY = go2rtcBinaryPath({ isPackaged: false, appRoot: ROOT, env: {} });
const HAVE_BINARY = process.platform === 'linux' && fs.existsSync(BINARY);
const CLIP = path.resolve('tests/unit/tapo/fixtures/clip-160x90.h264');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-g2r-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('go2rtc configuration', () => {
  it('writes the hardened config with no secrets in it', () => {
    const text = buildGo2rtcConfig({ host: '192.168.1.50', rtspPort: 554, stream: 'stream1' });
    expect(JSON.parse(text)).toEqual({
      app: { modules: ['api', 'mp4', 'rtsp'] },
      api: { listen: '127.0.0.1:${LM_G2R_PORT}', username: '${LM_G2R_USER}', password: '${LM_G2R_PASS}', local_auth: true, allow_paths: ['/api/streams', '/api/stream.mp4'] },
      rtsp: { listen: '' },
      log: { format: 'text', level: 'info', output: 'stdout' },
      streams: { lm_main: 'rtsp://${LM_CAM_USER}:${LM_CAM_PASS}@192.168.1.50:554/stream1' },
    });
    expect(JSON.parse(buildGo2rtcConfig({ host: 'fd00::5', rtspPort: 10554, stream: 'stream2' })).streams.lm_main).toBe('rtsp://${LM_CAM_USER}:${LM_CAM_PASS}@[fd00::5]:10554/stream2');
    expect(GO2RTC_STREAM).toBe('lm_main');
  });

  it('percent-encodes the camera credentials for the environment', () => {
    expect(go2rtcEnv({ port: 4242, apiUser: 'u', apiPass: 'p', camUser: 'cam acct', camPass: 'se&c"r\\et:@/' })).toEqual({
      LM_G2R_PORT: '4242', LM_G2R_USER: 'u', LM_G2R_PASS: 'p', LM_CAM_USER: 'cam%20acct', LM_CAM_PASS: 'se%26c%22r%5Cet%3A%40%2F',
    });
  });

  it('finds the binary: env override, packaged resources, vendor/', () => {
    expect(go2rtcBinaryPath({ isPackaged: false, appRoot: '/src', platform: 'linux', arch: 'x64', env: { LAWNMOWER_GO2RTC: '/x/go2rtc' } })).toBe('/x/go2rtc');
    expect(go2rtcBinaryPath({ isPackaged: true, resourcesPath: 'C:\\Program Files\\LM\\resources', appRoot: 'C:\\app', platform: 'win32', arch: 'x64', env: {} })).toBe('C:\\Program Files\\LM\\resources\\tapo\\go2rtc.exe');
    expect(go2rtcBinaryPath({ isPackaged: false, appRoot: '/src', platform: 'linux', arch: 'x64', env: {} })).toBe('/src/vendor/go2rtc/linux-x64/go2rtc');
    expect(go2rtcBinaryPath({ isPackaged: false, appRoot: 'C:\\src', platform: 'win32', arch: 'x64', env: {} })).toBe('C:\\src\\vendor\\go2rtc\\win32-x64\\go2rtc.exe');
  });

  it('recognises go2rtc 1.9.14 sign-in failures', () => {
    expect(AUTH_LINE.test('04:11:28.332 ERR github.com/AlexxIT/go2rtc/internal/mp4/mp4.go:107 > error="streams: wrong user/pass"')).toBe(true);
    expect(AUTH_LINE.test('RTSP/1.0 401 Unauthorized')).toBe(true);
    expect(AUTH_LINE.test('04:11:19.530 INF go2rtc platform=linux/amd64 version=1.9.14')).toBe(false);
  });
});

/** A stand-in go2rtc process: answers /api/streams with Basic auth, prints scripted log lines. */
function fakeSpawn(lines = [], { exitAfterMs = 0 } = {}) {
  const spawned = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 40000 + spawned.length;
    child.exitCode = null;
    child.signalCode = null;
    const auth = `Basic ${Buffer.from(`${opts.env.LM_G2R_USER}:${opts.env.LM_G2R_PASS}`).toString('base64')}`;
    const srv = http.createServer((req, res) => {
      res.writeHead(req.headers.authorization === auth ? 200 : 401);
      res.end('{}');
    }).listen(Number(opts.env.LM_G2R_PORT), '127.0.0.1');
    const exit = (code, signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      srv.close();
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    };
    child.kill = () => exit(null, 'SIGTERM');
    spawned.push({ cmd, args, env: opts.env, child });
    setTimeout(() => { for (const l of lines) child.stdout.write(`${l}\n`); }, 30);
    if (exitAfterMs) setTimeout(() => exit(1, null), exitAfterMs);
    return child;
  };
  return { impl, spawned };
}

describe('Go2rtcSidecar (fake process)', () => {
  let g;
  afterEach(async () => { await g?.stop(); g = null; });

  it('starts, reports ready, and keeps secrets out of argv, the config and the log', async () => {
    const dir = tmp();
    const logs = [];
    const bin = path.join(dir, 'go2rtc');
    fs.writeFileSync(bin, '');
    const f = fakeSpawn(['04:00:00.000 INF go2rtc version=1.9.14', '04:00:00.100 WRN stream rtsp://camacct:se%26cret@192.168.1.50:554/stream1 slow, pass se&cret']);
    g = new Go2rtcSidecar({ binary: bin, configDir: dir, spawn: f.impl, log: (l, m) => logs.push(m), platform: 'linux' });
    const ep = await g.start({ host: '192.168.1.50', rtspPort: 554, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    expect(g.info().state).toBe('ready');
    expect(ep.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await loopbackGet(`${ep.url}/api/streams`, ep.auth)).status).toBe(200);
    expect((await loopbackGet(`${ep.url}/api/streams`, 'Basic eDp5')).status).toBe(401);
    const { args, env } = f.spawned[0];
    expect(args).toEqual(['-config', path.join(dir, 'go2rtc.yaml')]);
    expect(args.join(' ')).not.toContain('cret');
    expect(env.LM_CAM_PASS).toBe('se%26cret');
    expect(fs.readFileSync(path.join(dir, 'go2rtc.yaml'), 'utf8')).not.toContain('cret');
    await sleep(80);
    expect(logs.join('\n')).not.toMatch(/se&cret|se%26cret/);
    expect(logs.join('\n')).toContain('rtsp://***:***@192.168.1.50:554/stream1');
  });

  it('a sign-in failure in the log emits auth-failed and stops (no restart)', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'go2rtc');
    fs.writeFileSync(bin, '');
    const f = fakeSpawn(['04:11:28.332 ERR github.com/AlexxIT/go2rtc/internal/mp4/mp4.go:107 > error="streams: wrong user/pass"']);
    g = new Go2rtcSidecar({ binary: bin, configDir: dir, spawn: f.impl, platform: 'linux' });
    let fired = 0;
    g.on('auth-failed', () => fired++);
    await g.start({ host: '192.168.1.50', rtspPort: 554, stream: 'stream1', camUser: 'camacct', camPass: 'x' });
    await sleep(150);
    expect(fired).toBe(1);
    expect(g.info().state).toBe('error');
    expect(g.info().detail).toMatch(/refused the video sign-in/);
    await sleep(100);
    expect(f.spawned).toHaveLength(1);
  });

  it('restarts a crashed process with backoff, then gives up', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'go2rtc');
    fs.writeFileSync(bin, '');
    const f = fakeSpawn([], { exitAfterMs: 400 });
    g = new Go2rtcSidecar({ binary: bin, configDir: dir, spawn: f.impl, platform: 'linux', restart: { baseDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 } });
    await g.start({ host: '192.168.1.50', rtspPort: 554, stream: 'stream1', camUser: 'camacct', camPass: 'x' });
    await sleep(1800);
    expect(f.spawned).toHaveLength(3);
    expect(g.info()).toMatchObject({ state: 'error' });
    expect(g.info().detail).toMatch(/Press Retry/);
  });

  it('reports a missing binary', async () => {
    g = new Go2rtcSidecar({ binary: path.join(tmp(), 'nope'), configDir: tmp() });
    await expect(g.start({ host: '192.168.1.50', rtspPort: 554, stream: 'stream1', camUser: 'a', camPass: 'b' })).rejects.toThrow(/missing/);
    expect(g.info()).toEqual({ state: 'missing', detail: MISSING_DETAIL });
  });
});

/** Is something listening on 127.0.0.1:port? */
const listening = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

describe.skipIf(!HAVE_BINARY)('go2rtc 1.9.14 + StreamRelay against an RTSP server', () => {
  let g;
  let rtsp;
  let relay;
  afterEach(async () => {
    relay?.stop();
    await g?.stop();
    await rtsp?.close();
    relay = g = rtsp = null;
  });

  it('serves the stream on loopback only, behind auth, with /api/config blocked; TEARDOWN when not needed', async () => {
    rtsp = await startMiniRtsp({ file: CLIP, path: '/stream1' });
    const dir = tmp();
    g = new Go2rtcSidecar({ binary: BINARY, configDir: dir });
    const ep = await g.start({ host: '127.0.0.1', rtspPort: rtsp.port, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    expect((await loopbackGet(`${ep.url}/api/streams`, 'Basic AAAA')).status).toBe(401);
    expect((await loopbackGet(`${ep.url}/api/config`, ep.auth)).status).toBe(404);
    const streams = await loopbackGet(`${ep.url}/api/streams`, ep.auth);
    expect(streams.status).toBe(200);
    expect(streams.body).not.toContain('cret');
    for (const p of [1984, 8554, 8555]) expect(await listening(p)).toBe(false);
    const tcp = ['/proc/net/tcp', '/proc/net/tcp6'].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const hexPort = Number(new URL(ep.url).port).toString(16).toUpperCase().padStart(4, '0');
    const binds = tcp.split('\n').filter((l) => l.includes(`:${hexPort} `) && / 0A /.test(l)).map((l) => l.trim().split(/\s+/)[1]);
    expect(binds).toEqual([`0100007F:${hexPort}`]); // 127.0.0.1 only

    relay = new StreamRelay({ getEndpoint: () => g.endpoint() });
    const samples = [];
    let init = null;
    relay.on('init', (i) => { init = i; });
    relay.on('sample', (s) => samples.push(s));
    expect(rtsp.log.sessions).toBe(0); // lazy: no RTSP session until someone reads
    relay.setNeeded(true, 'test');
    for (let i = 0; i < 100 && samples.length < 20; i++) await sleep(100);
    expect(init).toMatchObject({ codec: 'avc1.64001f', width: 160, height: 90, gen: 1 });
    expect(samples.length).toBeGreaterThanOrEqual(20);
    expect(samples[0].key).toBe(true);
    expect(relay.state).toBe('live');
    expect(relay.stats().fps).toBeGreaterThan(8);
    expect(rtsp.log.sessions).toBe(1);
    relay.setNeeded(false, 'test');
    for (let i = 0; i < 30 && rtsp.log.teardowns === 0; i++) await sleep(100);
    expect(rtsp.log.teardowns).toBe(1);
    expect(relay.state).toBe('off');
    const pid = g.pid;
    await g.stop();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a wrong camera password: auth-failed, and nobody retries the sign-in', async () => {
    rtsp = await startMiniRtsp({ file: CLIP, path: '/stream1' });
    g = new Go2rtcSidecar({ binary: BINARY, configDir: tmp() });
    let sidecarAuth = 0;
    let relayAuth = 0;
    g.on('auth-failed', () => sidecarAuth++);
    await g.start({ host: '127.0.0.1', rtspPort: rtsp.port, stream: 'stream1', camUser: 'camacct', camPass: 'wrong' });
    relay = new StreamRelay({ getEndpoint: () => g.endpoint() });
    relay.on('auth-failed', () => relayAuth++);
    relay.setNeeded(true, 'test');
    for (let i = 0; i < 50 && relayAuth + sidecarAuth === 0; i++) await sleep(100);
    expect(relayAuth + sidecarAuth).toBeGreaterThanOrEqual(1);
    const failures = rtsp.log.authFailures;
    expect(failures).toBeGreaterThanOrEqual(1);
    expect(failures).toBeLessThanOrEqual(2); // go2rtc's own single retry
    await sleep(3000);
    expect(rtsp.log.authFailures).toBe(failures);
    expect(relay.state).toBe('error');
  });

  it('reconnects after the camera drops the session (stalled → live, new generation)', async () => {
    rtsp = await startMiniRtsp({ file: CLIP, path: '/stream1' });
    g = new Go2rtcSidecar({ binary: BINARY, configDir: tmp() });
    await g.start({ host: '127.0.0.1', rtspPort: rtsp.port, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    relay = new StreamRelay({ getEndpoint: () => g.endpoint(), idleMs: 1500 });
    const gens = new Set();
    relay.on('sample', (s) => gens.add(s.gen));
    relay.setNeeded(true, 'test');
    for (let i = 0; i < 50 && relay.state !== 'live'; i++) await sleep(100);
    expect(relay.state).toBe('live');
    const port = rtsp.port;
    await rtsp.close(); // the camera rebooted
    rtsp = await startMiniRtsp({ file: CLIP, path: '/stream1' });
    // go2rtc has the old port in its config: restart it on the new one, as the service would
    await g.start({ host: '127.0.0.1', rtspPort: rtsp.port, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    relay.kick();
    for (let i = 0; i < 80 && gens.size < 2; i++) await sleep(100);
    expect(gens.size).toBeGreaterThanOrEqual(2);
    expect(port).not.toBe(rtsp.port);
  });
});
