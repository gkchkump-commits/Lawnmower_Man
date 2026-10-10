import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { go2rtcBinaryPath } from '../../../electron/tapo/go2rtc.js';
import { startFakeOnvif } from './helpers/fake-onvif.js';
import { startMiniRtsp } from './helpers/mini-rtsp.js';
import { FakeMessageChannelMain, FakeRelay, FakeSidecar, fakeCameraWindow, memorySafeStorage, tempSettings, until } from './helpers/fakes.js';

const PERSON = { motion: { active: true, score: 0.05, global: false }, persons: [{ score: 0.9, box: [0.4, 0.3, 0.15, 0.4] }] };
const NOBODY = { motion: { active: false, score: 0, global: false }, persons: [] };

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function setup(o = {}) {
  const cam = await startFakeOnvif(o.onvif);
  cleanup.push(() => cam.close());
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-clips-'));
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: o.onvifPort ?? cam.port, rtspPort: o.rtspPort ?? 554, username: 'camacct', name: 'camera' },
    security: { armDelaySec: 0, preRollSec: 1, postRollSec: 2, cooldownSec: 10, clipsDir: clips, ...(o.security || {}) },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  await credentials.setPassword(o.password ?? 'se&cret', { host: '127.0.0.1' });
  const notified = [];
  const sidecar = o.realVideo ? undefined : new FakeSidecar();
  const relay = o.realVideo ? undefined : new FakeRelay();
  const logs = [];
  const service = new TapoService({
    settings: store,
    credentials,
    paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: {
      MessageChannelMain: FakeMessageChannelMain,
      alerts: { notify: (n) => { notified.push(n); return true; } },
      openPath: async () => '',
      detector: 'stub',
      assets: { wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/efficientdet_lite0_int8.tflite' },
      ...(o.realVideo ? { go2rtcBinary: go2rtcBinaryPath({ isPackaged: false, appRoot: path.resolve('.'), env: {} }) } : { createSidecar: () => sidecar, createRelay: () => relay }),
      ...(o.deps || {}),
    },
    log: (level, msg) => logs.push(`${level} ${msg}`),
    env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' },
    appVersion: '0.5.0',
  });
  store.on('change', (n, p) => service.applySettings(n, p)); // what main.js does
  cleanup.push(() => service.stop());
  const alerts = [];
  const statuses = [];
  const events = [];
  service.on('alert', (a, opts) => alerts.push({ a, opts }));
  service.on('status', (s) => statuses.push(s));
  service.on('security-event', (e) => events.push(e));
  return { cam, service, store, credentials, sidecar, relay, notified, alerts, statuses, events, logs, clips, dir };
}

describe('TapoService', () => {
  it('connects, probes PTZ, starts video only after the ONVIF sign-in, and reports one status', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online');
    const st = r.service.status();
    expect(st).toMatchObject({ enabled: true, configured: true, hasPassword: true, persistence: 'encrypted', name: 'camera', host: '127.0.0.1', connection: 'online' });
    expect(st.device).toEqual({ manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', hardwareId: '2.0' });
    expect(st.ptz).toMatchObject({ available: true, mode: 'relative', canStatus: true, canAbsolute: true, privacySuspected: false, calibrated: false });
    expect(st.clock).toMatchObject({ warn: false });
    expect(JSON.stringify(st)).not.toMatch(/se&cret|cret/);
    expect(r.sidecar.starts).toHaveLength(1);
    expect(r.sidecar.starts[0]).toMatchObject({ host: '127.0.0.1', rtspPort: 554, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    // not needed yet: no stream
    expect(r.relay.needed).toBe(false);
    expect(st.stream.state).toBe('off');
    // PTZ through the service
    const res = await r.service.ptz({ op: 'nudge', dir: 'right', amount: 'medium' });
    expect(res).toMatchObject({ ok: true, moved: true });
    expect(r.cam.calls.find((c) => c.op === 'RelativeMove')?.args).toEqual({ x: '0.175', y: '0' });
    expect((await r.service.presets()).map((p) => p.name)).toEqual(['Door', 'Window']);
    expect(r.service.toolPermissions()).toEqual({ allow: ['mcp__lawnmower-camera__camera_status', 'mcp__lawnmower-camera__camera_events'], deny: [] });
    expect(r.service.personaContext()).toEqual({ camera: { name: 'camera', canSee: true, canMove: true } });
  });

  it('the stream runs while the window shows it; the worker gets hello, config and chunks', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online');
    const win = fakeCameraWindow();
    expect(r.service.attachWorker(win)).toBe(true);
    await until(() => win.count('hello') === 1);
    expect(win.received[0]).toEqual({ t: 'hello', detector: 'stub', wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/efficientdet_lite0_int8.tflite' });
    await until(() => r.service.status().detector.state === 'on');
    // the worker learns whether the window shows the picture (the page cannot tell it is hidden)
    expect(win.received.filter((m) => m.t === 'view')).toEqual([{ t: 'view', visible: false }]);
    r.service.setViewVisible(true);
    r.service.setViewVisible(true); // no repeat for the same state
    await until(() => win.count('chunk') >= 10);
    expect(win.received.filter((m) => m.t === 'view')).toEqual([{ t: 'view', visible: false }, { t: 'view', visible: true }]);
    const cfg = win.received.find((m) => m.t === 'config');
    expect(cfg).toMatchObject({ codec: 'avc1.64001f', width: 160, height: 90 });
    expect(cfg.description).toBeInstanceOf(ArrayBuffer);
    const chunk = win.received.find((m) => m.t === 'chunk');
    expect(chunk.key).toBe(true);
    expect(chunk.data).toBeInstanceOf(ArrayBuffer);
    expect(Number.isFinite(chunk.ts)).toBe(true);
    r.service.setViewVisible(false);
    expect(r.relay.needed).toBe(false);
    await until(() => win.count('idle') >= 1);
    await until(() => win.count('view') === 3);
    expect(win.received.filter((m) => m.t === 'view').at(-1)).toEqual({ t: 'view', visible: false });
    // a replacement port closes the old one
    const old = win.port;
    r.service.attachWorker(win);
    expect(old.closed).toBe(true);
  });

  it('armed: a person → event, clip with pre-roll, snapshot, notification, announcement; then it ends', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online');
    const win = fakeCameraWindow();
    r.service.attachWorker(win);
    await until(() => r.service.status().detector.state === 'on');
    expect(r.service.arm({ armed: true, immediate: true })).toEqual({ armed: true, arming: false });
    expect(r.store.get().security.armed).toBe(true);
    await until(() => r.service.status().stream.state === 'live');
    await until(() => r.service.status().events.onvif === 'subscribed');
    // the engine ignores local evidence for 10 s after the stream starts: skip that here
    r.service.engine._localSuppressUntil = 0;
    await new Promise((res) => setTimeout(res, 1500)); // some pre-roll in the ring
    win.send({ t: 'det', at: 1, frameTs: 1, ...PERSON });
    win.send({ t: 'det', at: 2, frameTs: 2, ...PERSON });
    await until(() => r.events.some((e) => e.phase === 'start'));
    await until(() => r.notified.length === 1 && r.alerts.length === 1);
    expect(r.notified[0]).toMatchObject({ cameraName: 'camera', silent: false });
    expect(r.notified[0].snapshotPath).toMatch(/\.jpg$/);
    expect(r.alerts[0].a).toMatchObject({ kind: 'person', line: 'Someone is at the camera.', quiet: false, describe: false, cameraName: 'camera' });
    expect(r.alerts[0].opts).toEqual({ showAvatar: true });
    expect(r.service.status().security.recording).toBe(true);
    expect(r.service.status().security.active).toMatchObject({ kind: 'person' });
    // nobody for the post-roll (2 s)
    for (let i = 0; i < 4; i++) {
      win.send({ t: 'det', at: 10 + i, frameTs: 10 + i, ...NOBODY });
      await new Promise((res) => setTimeout(res, 800));
    }
    await until(() => r.events.some((e) => e.phase === 'end'), 6000);
    await until(() => !r.service.status().security.recording);
    const { events } = await r.service.listEvents();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toMatchObject({ kind: 'person', notified: true, announced: true, acknowledged: false });
    expect(ev.clipUrl).toMatch(/^app:\/\/lawnmower\/__clips\/\d{4}-\d{2}-\d{2}\/\d{6}-motion-[a-z0-9]{4}\.mp4$/);
    expect(ev.snapshotUrl).toMatch(/\.jpg$/);
    const rel = decodeURIComponent(ev.clipUrl.replace('app://lawnmower/__clips/', ''));
    const clip = fs.readFileSync(path.join(r.clips, rel));
    expect(clip.length).toBeGreaterThan(5000);
    expect(clip.subarray(4, 8).toString('latin1')).toBe('ftyp');
    const json = JSON.parse(fs.readFileSync(path.join(r.clips, rel.replace(/\.mp4$/, '.json')), 'utf8'));
    expect(json).toMatchObject({ v: 1, camera: 'camera', kind: 'person', notified: true, announced: true, clip: rel });
    expect(json.sources).toEqual(expect.arrayContaining(['local-person']));
    expect(r.service.status().security.todayCount).toBe(1);
    // disarm
    r.service.arm({ armed: false });
    expect(r.store.get().security.armed).toBe(false);
    await until(() => r.service.status().events.onvif === 'off');
  });

  it('MCP: camera_status and camera_snapshot through the service', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online');
    const win = fakeCameraWindow();
    r.service.attachWorker(win);
    const mcp = r.service.mcpServer();
    expect(mcp.name).toBe('lawnmower-camera');
    const st = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'camera_status', arguments: {} } });
    expect(st.result.content[0].text).toMatch(/^Camera: online\. Disarmed\. Pan\/tilt works/);
    const snap = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'camera_snapshot', arguments: {} } });
    expect(snap.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(snap.result.content[0].data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(r.relay.needed).toBe(true); // the stream stays on for up to 30 s after a snapshot
    const g2 = await mcp.startHttp();
    expect(g2.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await mcp.stopHttp();
  });

  it('a wrong password: auth-failed, no video, no retries — until new credentials', async () => {
    const r = await setup({ password: 'wrong-one' });
    await r.service.start();
    await until(() => r.service.status().connection === 'auth-failed');
    expect(r.service.status().detail).toMatch(/Camera Account/);
    expect(r.sidecar.starts).toHaveLength(0);
    expect(r.cam.count('GetDeviceInformation')).toBe(2);
    const calls = r.cam.calls.length;
    await new Promise((res) => setTimeout(res, 2500));
    expect(r.cam.calls.length).toBe(calls);
    expect(await r.service.ptz({ op: 'nudge', dir: 'left', amount: 'small' })).toMatchObject({ ok: false, code: 'auth' });
    expect(r.service.toolPermissions()).toEqual({ allow: ['mcp__lawnmower-camera__camera_status', 'mcp__lawnmower-camera__camera_events'], deny: [] });
    expect(await r.service.setCredentials({ username: 'camacct', password: 'se&cret' })).toEqual({ ok: true, persistence: 'encrypted' });
    await until(() => r.service.status().connection === 'online');
    expect(r.sidecar.starts).toHaveLength(1);
  });

  it('unreachable → retries with backoff; the connection test explains each step', async () => {
    const r = await setup({ onvifPort: 1 });
    await r.service.start();
    await until(() => r.service.status().connection === 'unreachable');
    expect(r.service.status().detail).toMatch(/Trying again in 2 s/);
    const rtsp = await startMiniRtsp({ file: path.resolve('tests/unit/tapo/fixtures/clip-160x90.h264'), path: '/stream1' });
    cleanup.push(() => rtsp.close());
    const report = await r.service.test({ onvifPort: r.cam.port, rtspPort: rtsp.port });
    expect(report.steps.map((s) => [s.id, s.ok])).toEqual([['host', true], ['tcp2020', true], ['clock', true], ['auth', true], ['services', true], ['profiles', true], ['ptz', true], ['events', true], ['rtsp', true]]);
    expect(report.ok).toBe(true);
    expect(report.device.model).toBe('Tapo C211');
    expect(report.rtsp.codecs).toEqual(['H264/90000']);
    expect(report.topics).toContain('tns1:RuleEngine/PeopleDetector/People');
    expect(r.cam.ops()).not.toContain('RelativeMove'); // the test never moves the camera
    const bad = await r.service.test({ onvifPort: r.cam.port, password: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s) => s.id === 'auth')).toMatchObject({ ok: false });
    expect(bad.steps.slice(4).every((s) => s.ok === null)).toBe(true);
    const host = await r.service.test({ host: '8.8.8.8' });
    expect(host.steps[0]).toMatchObject({ id: 'host', ok: false });
    expect(JSON.stringify(report)).not.toMatch(/cret|serialNumber/i);
  });

  it('settings changes: turning off disconnects; a new host reconnects; PTZ off probes again', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online');
    r.store.update({ tapo: { ptz: 'off' } });
    await until(() => r.service.status().ptz.available === false);
    r.store.update({ tapo: { enabled: false } });
    await until(() => r.service.status().connection === 'off');
    expect(r.service.toolPermissions()).toEqual({ allow: [], deny: [] });
    expect(r.service.personaContext()).toEqual({});
    r.store.update({ tapo: { enabled: true, ptz: 'auto' } });
    await until(() => r.service.status().connection === 'online');
    r.store.update({ tapo: { host: '127.0.0.2' } });
    await until(() => r.service.status().connection === 'not-configured');
    expect(r.service.status().detail).toMatch(/another camera address/);
  });

  it('claudeSee/claudeMove map to allowed and refused tools', async () => {
    const r = await setup({ security: { claudeSee: 'always', claudeMove: 'never' } });
    await r.service.start();
    expect(r.service.toolPermissions()).toEqual({
      allow: ['mcp__lawnmower-camera__camera_status', 'mcp__lawnmower-camera__camera_events', 'mcp__lawnmower-camera__camera_snapshot'],
      deny: ['mcp__lawnmower-camera__camera_look'],
    });
    expect(r.service.personaContext()).toEqual({ camera: { name: 'camera', canSee: true, canMove: false } });
  });
});

const BINARY = go2rtcBinaryPath({ isPackaged: false, appRoot: path.resolve('.'), env: {} });
describe.skipIf(!(process.platform === 'linux' && fs.existsSync(BINARY)))('TapoService with the real go2rtc', () => {
  it('ONVIF fake + RTSP server → go2rtc → relay → worker port; quitting tears it all down', async () => {
    const rtsp = await startMiniRtsp({ file: path.resolve('tests/unit/tapo/fixtures/clip-160x90.h264'), path: '/stream1' });
    cleanup.push(() => rtsp.close());
    const r = await setup({ realVideo: true, rtspPort: rtsp.port });
    await r.service.start();
    await until(() => r.service.status().go2rtc.state === 'ready', 15000);
    const win = fakeCameraWindow();
    r.service.attachWorker(win);
    r.service.setViewVisible(true);
    await until(() => win.count('chunk') >= 20, 15000);
    const st = r.service.status();
    expect(st.stream).toMatchObject({ state: 'live', codec: 'avc1.64001f', width: 160, height: 90 });
    expect(rtsp.log.sessions).toBe(1);
    const pid = r.service.sidecar.pid;
    const t0 = Date.now();
    await r.service.stop();
    expect(Date.now() - t0).toBeLessThan(4500);
    await until(() => rtsp.log.teardowns >= 1 || rtsp.log.active === 0, 3000);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
