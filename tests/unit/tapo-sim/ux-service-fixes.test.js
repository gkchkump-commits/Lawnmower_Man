// Regression tests for the UX review (fixer round), against the simulator: a camera that drops off
// mid-session is shown as offline (and comes back), an armed camera that stops watching tells the
// user once, Retry reconnects (never a refused sign-in), waking the PC reconnects, privacy mode
// clears by itself, and the diagnostic report is redacted.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService, BLIND_ALERT_MS } from '../../../electron/tapo/tapo-service.js';
import { FakeMessageChannelMain, FakeRelay, FakeSidecar, memorySafeStorage, tempSettings, until } from '../tapo/helpers/fakes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function setup(o = {}) {
  const sim = await startSim({ quirks: o.quirks });
  cleanup.push(() => sim.close());
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ux-clips-'));
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: sim.onvifPort, rtspPort: sim.rtspPort, username: 'camacct', name: 'front door camera' },
    security: { armDelaySec: 0, clipsDir: clips, ...(o.security || {}) },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  await credentials.setPassword(o.password ?? 'se&cret', { host: '127.0.0.1' });
  const relay = new FakeRelay();
  const trouble = [];
  const service = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: {
      MessageChannelMain: FakeMessageChannelMain, openPath: async () => '', detector: 'stub', createSidecar: () => new FakeSidecar(), createRelay: () => relay,
      alerts: { notify: () => true, notifyTrouble: (n) => { trouble.push(n); return true; } },
    },
    log: () => {}, env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' }, appVersion: '0.5.0', now: o.now,
  });
  store.on('change', (n, p) => service.applySettings(n, p));
  cleanup.push(() => service.stop());
  const alerts = [];
  service.on('alert', (a, opts) => alerts.push({ a, opts }));
  return { sim, service, store, relay, trouble, alerts };
}

describe('a camera that drops off mid-session', () => {
  it('is shown as offline (the video stalls, the camera does not answer), and comes back by itself', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    r.service.arm({ armed: true, immediate: true });
    await until(() => r.relay.state === 'live', 5000);
    r.sim.set({ offline: true });
    // what the real relay does when the camera's video stops
    r.relay._stop();
    r.relay.state = 'stalled';
    r.relay.emit('state', 'stalled');
    await until(() => r.service.status().connection === 'unreachable', 30_000);
    const st = r.service.status();
    expect(st.detail).toMatch(/stopped answering/);
    expect(st.security.watching).toBe('offline');
    expect(st.events.onvif).toBe('off'); // nothing talks to it meanwhile
    r.sim.set({ offline: false });
    await until(() => r.service.status().connection === 'online', 30_000);
    expect(r.service.status().security.watching).toBe('yes');
  }, 70_000);
});

describe('an armed camera that stopped watching', () => {
  it('reads "offline" at once when the camera does not answer, and tells the user once after a minute', async () => {
    let now = 1_760_000_000_000;
    const r = await setup({ now: () => now });
    r.service._started = true;
    r.service._conn = { state: 'unreachable', detail: 'x' };
    r.service.arm({ armed: true, immediate: true });
    r.service._checkBlind(now);
    expect(r.service.status().security.watching).toBe('offline');
    now += BLIND_ALERT_MS - 1000;
    r.service._checkBlind(now);
    expect(r.trouble).toEqual([]);
    now += 2000;
    r.service._checkBlind(now);
    now += 60_000;
    r.service._checkBlind(now);
    expect(r.trouble).toHaveLength(1);
    expect(r.trouble[0].title).toBe('The front door camera is not watching');
    expect(r.alerts.map((x) => x.a)).toEqual([expect.objectContaining({ kind: 'trouble', line: 'I lost the front door camera.' })]);
    // back: watching again, and a new outage would be told again
    r.service._conn = { state: 'online', detail: '' };
    r.service._streamWanted = false;
    r.service._checkBlind(now);
    expect(r.service.status().security.watching).toBe('yes');
  });

  it('no video for 30 s while armed: "no-video" (a grace for the stream to start)', async () => {
    let now = 1_760_000_000_000;
    const r = await setup({ now: () => now });
    r.service._started = true;
    r.service._conn = { state: 'online', detail: '' };
    r.service._streamWanted = true;
    r.service.arm({ armed: true, immediate: true });
    r.relay.state = 'stalled';
    r.service._checkBlind(now);
    expect(r.service.status().security.watching).toBe('yes');
    now += 31_000;
    r.service._checkBlind(now);
    expect(r.service.status().security.watching).toBe('no-video');
  });
});

describe('Retry, waking up, privacy mode, the diagnostic report', () => {
  it('Retry reconnects an unreachable camera at once; a refused sign-in is not retried', async () => {
    const r = await setup();
    r.sim.set({ offline: true });
    await r.service.start();
    await until(() => r.service.status().connection === 'unreachable', 10_000);
    r.sim.set({ offline: false });
    expect(await r.service.retry()).toMatchObject({ ok: true, connection: 'connecting' });
    await until(() => r.service.status().connection === 'online', 8000);
    const bad = await setup({ password: 'wrong-pass' });
    await bad.service.start();
    await until(() => bad.service.status().connection === 'auth-failed', 8000);
    expect(await bad.service.retry()).toEqual({ ok: false, needsPassword: true });
    await sleep(500);
    expect(bad.sim.state.authFailures.onvif).toBe(1);
  }, 40_000);

  it('the PC woke up: it reconnects at once', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    const n = r.sim.callsOf('GetDeviceInformation').length;
    r.service.onResume();
    await until(() => r.sim.callsOf('GetDeviceInformation').length > n, 8000);
    await until(() => r.service.status().connection === 'online', 8000);
  }, 20_000);

  it('privacy mode turned off: the suspicion clears within seconds, not 60 s', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    r.sim.set({ privacy: true });
    const res = await r.service.ptz({ op: 'nudge', dir: 'left', amount: 'small' });
    expect(res.code).toBe('privacy');
    await until(() => r.service.status().ptz.privacySuspected, 5000);
    r.sim.set({ privacy: false });
    const t0 = Date.now();
    await until(() => !r.service.status().ptz.privacySuspected, 15_000);
    expect(Date.now() - t0).toBeLessThan(12_000);
  }, 30_000);

  it('the diagnostic report: the test and the status, without password, user name or address', async () => {
    const r = await setup();
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    const rep = await r.service.diagnostics();
    expect(rep.tool).toBe('lawnmower-diagnostics');
    expect(rep.test.steps.find((s) => s.id === 'auth').ok).toBe(true);
    expect(rep.status.connection).toBe('online');
    expect(rep.streamUris.length).toBeGreaterThan(0);
    const text = JSON.stringify(rep);
    expect(text).not.toMatch(/se&cret|se%26cret|camacct|127\.0\.0\.1/);
    expect(text).toContain('<camera>');
    expect(r.sim.calls.filter((c) => c.service === 'ptz' && /Move|GotoPreset/.test(c.op))).toEqual([]);
  }, 30_000);
});
