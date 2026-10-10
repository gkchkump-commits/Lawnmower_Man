// Regression tests for the motor review (fixer round): TapoService and PullPointMonitor against
// the simulator (ONVIF only; video faked). A failed move does not silence the alarm, turning the
// camera off while it moves still stops it, a wrong password is tried once, the camera's event
// state does not survive a disarm or a reboot, and short outages do not leave subscriptions
// behind on the camera.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { OnvifClient } from '../../../electron/tapo/onvif-client.js';
import { PullPointMonitor } from '../../../electron/tapo/events.js';
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
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-motor-clips-'));
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: sim.onvifPort, rtspPort: sim.rtspPort, username: 'camacct', name: 'camera', invertPan: true, invertTilt: true, viewUnitsX: 0.8, viewUnitsY: 1.2 },
    security: { armDelaySec: 0, preRollSec: 1, postRollSec: 2, cooldownSec: 1, clipsDir: clips, confirmLocally: false, ...(o.security || {}) },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  await credentials.setPassword(o.password ?? 'se&cret', { host: '127.0.0.1' });
  const sidecar = new FakeSidecar();
  const relay = new FakeRelay();
  const service = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: { MessageChannelMain: FakeMessageChannelMain, alerts: { notify: () => true }, openPath: async () => '', detector: 'stub', createSidecar: () => sidecar, createRelay: () => relay },
    log: () => {}, env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' }, appVersion: '0.5.0',
  });
  store.on('change', (n, p) => service.applySettings(n, p));
  cleanup.push(() => service.stop());
  const events = [];
  service.on('security-event', (e) => events.push({ at: Date.now(), phase: e.phase, kind: e.event.kind, id: e.event.id }));
  return { sim, service, store, sidecar, relay, events, credentials };
}

async function armedAndSubscribed(r) {
  await r.service.start();
  await until(() => r.service.status().connection === 'online', 8000);
  r.service.arm({ armed: true, immediate: true });
  await until(() => r.service.status().events.onvif === 'subscribed', 8000);
}

describe('TapoService × simulator: motor safety', () => {
  it('a failed PTZ move (privacy answer) does not silence the alarm afterwards', async () => {
    const r = await setup();
    await armedAndSubscribed(r);
    r.sim.set({ privacy: true });
    const res = await r.service.ptz({ op: 'nudge', dir: 'left', amount: 'small' });
    expect(res.ok).toBe(false);
    r.sim.set({ privacy: false });
    await until(() => !r.service.status().ptz.moving, 5000);
    await sleep(1600); // the settle time
    r.sim.set({ person: true });
    await until(() => r.events.some((e) => e.phase === 'start' && e.kind === 'person'), 10000);
  }, 40_000);

  it('turning the camera off while it runs away still sends the Stop', async () => {
    const r = await setup({ quirks: { relativeActsContinuous: true } });
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    const t0 = Date.now();
    await r.service.ptz({ op: 'nudge', dir: 'right', amount: 'medium' });
    await sleep(300);
    r.store.update({ tapo: { enabled: false } });
    expect(r.service.status().connection).toBe('off'); // let go of at once
    await sleep(2000);
    expect(r.sim.callsOf('Stop', t0).length).toBeGreaterThan(0);
    expect(r.sim.state.ptz.moving).toBe(false);
    expect(r.sim.state.ptz.endStopMs).toBe(0);
  }, 20_000);

  it('Forget password while it moves: the Stop goes out with the password, then it is cleared', async () => {
    const r = await setup({ quirks: { relativeActsContinuous: true } });
    await r.service.start();
    await until(() => r.service.status().connection === 'online', 8000);
    const t0 = Date.now();
    await r.service.ptz({ op: 'nudge', dir: 'right', amount: 'medium' });
    await sleep(300);
    await r.service.clearCredentials();
    expect(r.sim.callsOf('Stop', t0).filter((c) => c.status === 200).length).toBeGreaterThan(0);
    expect(r.sim.state.ptz.moving).toBe(false);
    expect(r.service.status()).toMatchObject({ configured: false, hasPassword: false });
  }, 20_000);

  it('a wrong password is tried once and never again while the user does things', async () => {
    const r = await setup({ password: 'wrong-pass' });
    await r.service.start();
    await until(() => r.service.status().connection === 'auth-failed', 8000);
    r.service.arm({ armed: true, immediate: true });
    for (let k = 0; k < 3; k++) {
      await r.service.ptz({ op: 'nudge', dir: 'left', amount: 'small' });
      await r.service.presets({ refresh: true });
      await sleep(500);
    }
    r.store.update({ security: { sensitivity: 'high' } });
    r.store.update({ tapo: { name: 'front door camera' } });
    await sleep(3000);
    expect(r.sim.state.authFailures.onvif).toBe(1);
    expect(r.sidecar.starts.length).toBe(0);
  }, 30_000);
});

describe('TapoService × simulator: the camera\'s event state', () => {
  it('disarm while the camera reports a person, the person leaves, re-arm: nothing starts', async () => {
    const r = await setup();
    await armedAndSubscribed(r);
    r.sim.set({ person: true });
    await until(() => r.events.some((e) => e.phase === 'start'), 10000);
    r.service.arm({ armed: false });
    await sleep(1000);
    r.sim.set({ person: false });
    await sleep(1500);
    const n = r.events.length;
    r.service.arm({ armed: true, immediate: true });
    await until(() => r.service.status().events.onvif === 'subscribed', 8000);
    await sleep(8000);
    expect(r.events.slice(n).filter((e) => e.phase === 'start')).toEqual([]);
    expect(r.service.status().security.active).toBeNull();
  }, 40_000);

  it('the same with confirmLocally and no camera window: no unconfirmed phantom', async () => {
    const r = await setup({ security: { confirmLocally: true } });
    await armedAndSubscribed(r);
    r.sim.set({ person: true });
    await until(() => r.events.some((e) => e.phase === 'start'), 15000);
    r.service.arm({ armed: false });
    await sleep(1000);
    r.sim.set({ person: false });
    await sleep(1500);
    const n = r.events.length;
    r.service.arm({ armed: true, immediate: true });
    await sleep(9000);
    expect(r.events.slice(n).filter((e) => e.phase === 'start')).toEqual([]);
  }, 45_000);

  it('a reboot while a person is reported, who leaves meanwhile: the event ends', async () => {
    const r = await setup();
    await armedAndSubscribed(r);
    r.sim.set({ person: true });
    await until(() => r.events.some((e) => e.phase === 'start'), 10000);
    r.sim.set({ reboot: true });
    await sleep(500);
    r.sim.set({ person: false });
    await until(() => r.events.some((e) => e.phase === 'end'), 25_000);
    expect(r.service.status().security.recording).toBe(false);
  }, 45_000);
});

describe('PullPointMonitor × simulator: outages and lifetimes', () => {
  it('short outages keep one subscription; stop() during a backoff leaves none behind', async () => {
    const sim = await startSim({ quirks: { pullDropAfterMs: 2000 } });
    cleanup.push(() => sim.close());
    const client = new OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => 'se&cret', log: () => {} });
    await client.connect();
    cleanup.push(async () => client.close());
    const m = new PullPointMonitor({ client, log: () => {} });
    await m.start();
    const snap = [];
    for (let k = 0; k < 2; k++) {
      await sleep(2000);
      sim.set({ offline: true });
      await sleep(3000);
      sim.set({ offline: false });
      await sleep(7000);
      const s = sim.state.subscriptions;
      snap.push({ onCamera: s.list.length, monitor: m.state });
    }
    expect(snap.every((x) => x.onCamera === 1)).toBe(true);
    expect(sim.state.subscriptions.refused).toBe(0);
    sim.set({ offline: true });
    await sleep(4500);
    sim.set({ offline: false });
    await sleep(300);
    await m.stop();
    await sleep(300);
    expect(sim.state.subscriptions.list.length).toBe(0);
    expect(m.orphans).toEqual([]);
  }, 60_000);

  it('a subscription shorter than the renew period is renewed (from TerminationTime − CurrentTime)', async () => {
    const sim = await startSim({ quirks: { subscriptionLifetimeSec: 6, pullDropAfterMs: 1500 } });
    cleanup.push(() => sim.close());
    const client = new OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => 'se&cret', log: () => {} });
    await client.connect();
    cleanup.push(async () => client.close());
    const m = new PullPointMonitor({ client, log: () => {} });
    await m.start();
    await sleep(16_000);
    // renewed before the 6 s ran out (the camera then grants the asked-for 10 minutes), so the one
    // subscription carried on: no re-creation, no failed pull
    expect(sim.state.subscriptions.created).toBe(1);
    expect(sim.callsOf('Renew').filter((c) => c.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(sim.callsOf('PullMessages').filter((c) => c.status >= 400).length).toBe(0);
    await m.stop();
  }, 30_000);
});
