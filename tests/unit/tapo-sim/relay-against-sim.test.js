// Integration: the real go2rtc 1.9.14 (the app's sidecar, electron/tapo/go2rtc.js) pulling the
// simulator's RTSP stream, and the app's StreamRelay (electron/tapo/stream-relay.js) reading its
// fMP4 (contract §8.5, §8.6, §12.1): init + samples starting at a keyframe, go2rtc's keepalive
// holding a session past the camera's 15 s timeout, the picture following a pan, and one RTSP
// session that ends (TEARDOWN) when the stream is no longer needed. Skipped unless the go2rtc
// binary is present (`npm run fetch:go2rtc`, or LAWNMOWER_GO2RTC).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { ROOT, appModules, sleep, until } from './helpers.js';
import { tmpDir } from '../helpers/tmp.js';

const lane = await appModules(['electron/tapo/go2rtc.js', 'electron/tapo/rtsp-auth-proxy.js', 'electron/tapo/stream-relay.js']);
const g2r = lane.mods['electron/tapo/go2rtc.js'];
const proxyMod = lane.mods['electron/tapo/rtsp-auth-proxy.js'];
const relayMod = lane.mods['electron/tapo/stream-relay.js'];
const binary = g2r.go2rtcBinaryPath({ isPackaged: false, resourcesPath: '', appRoot: ROOT, platform: process.platform, arch: process.arch, env: process.env });
const haveBinary = !!binary && fs.existsSync(binary);
const reason = haveBinary ? '' : ` [SKIPPED: no go2rtc binary at ${binary || 'vendor/go2rtc'} (npm run fetch:go2rtc)]`;

describe.skipIf(!haveBinary)(`go2rtc + StreamRelay × simulated RTSP${reason}`, () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {any} */
  let sidecar;
  /** @type {any} */
  let proxy;
  /** @type {any} */
  let relay;
  /** @type {string} */
  let dir;
  /** @type {any[]} */
  const samples = [];
  /** @type {any[]} */
  const inits = [];
  beforeAll(async () => {
    sim = await startSim();
    dir = tmpDir('lm-relay-sim-');
    sidecar = new g2r.Go2rtcSidecar({ binary, configDir: dir, log: () => {} });
    // go2rtc reaches the camera through main's RTSP auth proxy (it never has the password)
    proxy = new proxyMod.RtspAuthProxy({ log: () => {} });
    const src = await proxy.start({ ip: '127.0.0.1', port: sim.rtspPort, username: 'camacct', password: 'se&cret' });
    const ep = await sidecar.start({ sourcePort: src.port, sourceToken: src.token, stream: 'stream1' });
    expect(ep.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    relay = new relayMod.StreamRelay({ getEndpoint: () => sidecar.endpoint?.() ?? ep, log: () => {} });
    relay.on('init', (/** @type {any} */ i) => inits.push(i));
    relay.on('sample', (/** @type {any} */ s) => samples.push(s));
  });
  afterAll(async () => {
    relay?.setNeeded(false, 'test end');
    relay?.stop?.();
    await proxy?.stop();
    await sidecar?.stop();
    await sim?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams: init (H.264, the simulator\'s 640x360) and samples that start at a keyframe', async () => {
    relay.setNeeded(true, 'test');
    await until(() => samples.length >= 20, { timeout: 15000, what: '20 samples' });
    expect(inits[0]).toMatchObject({ codec: expect.stringMatching(/^avc1\.64/), width: 640, height: 360 });
    expect(samples[0].key).toBe(true);
    expect(relay.state).toBe('live');
    expect(sim.state.rtspSessions.live).toHaveLength(1); // exactly one RTSP session at the camera
  });

  it('go2rtc\'s keepalive holds the session past the camera\'s 15 s timeout', async () => {
    const session = sim.state.rtspSessions.live[0];
    await sleep(40_000);
    const live = sim.state.rtspSessions.live;
    expect(live.map((s) => s.id)).toEqual([session.id]);
    expect(sim.calls.some((c) => c.op === 'SESSION-TIMEOUT')).toBe(false);
    expect(sim.calls.filter((c) => c.service === 'rtsp' && (c.op === 'OPTIONS' || c.op === 'GET_PARAMETER') && c.t > Date.now() - 40_000).length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('the picture follows a pan: a new segment (and keyframe) in the stream', async () => {
    const before = samples.length;
    sim.camera.ptz.place(-0.2, 0); // the mirrored camera looks right
    await until(() => sim.state.rtspSessions.live[0]?.segment === 'p2_t0', { timeout: 3000, what: 'the segment switch' });
    await until(() => samples.slice(before).some((s) => s.key), { timeout: 3000, what: 'a keyframe after the pan' });
    expect(sim.state.rtspSessions.live[0].segments.map((/** @type {any} */ s) => s.id)).toContain('p2_t0');
  });

  it('a camera that drops the session without stating its timeout: the stream still flows', async () => {
    // go2rtc's keepalive follows the Session header's timeout; without it the camera drops the
    // session every ~15 s and go2rtc sets it up again (a short gap, no outage)
    sim.set({ quirks: { rtspAdvertiseTimeout: false } });
    relay.setNeeded(false, 'test');
    await until(() => sim.state.rtspSessions.live.length === 0, { timeout: 15000 });
    relay.setNeeded(true, 'test');
    await until(() => sim.state.rtspSessions.live.length === 1, { timeout: 15000 });
    const t0 = Date.now();
    await until(() => sim.callsOf('SESSION-TIMEOUT', t0).length > 0, { timeout: 25_000, what: 'the camera to drop the session' });
    const n = samples.length;
    await until(() => samples.length > n + 15, { timeout: 15_000, what: 'samples after the drop' });
    expect(sim.state.rtspSessions.live).toHaveLength(1);
    sim.set({ quirks: { rtspAdvertiseTimeout: true } });
  }, 60_000);

  it('not needed → go2rtc ends the RTSP session (TEARDOWN): the camera\'s stream slot is free', async () => {
    const t0 = Date.now();
    relay.setNeeded(false, 'test');
    await until(() => sim.state.rtspSessions.live.length === 0, { timeout: 15000, what: 'the RTSP session to end' });
    expect(sim.callsOf('TEARDOWN', t0).length + sim.state.rtspSessions.ended.filter((s) => s.endReason === 'closed').length).toBeGreaterThan(0);
  }, 20_000);
});
