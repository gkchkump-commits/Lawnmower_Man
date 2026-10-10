// Integration: the app's ONVIF client (electron/tapo/onvif-client.js, contract §8.3) against the
// camera simulator with the Tapo quirks: connect, clock skew, a wrong password (auth-failed after
// one resync, never a loop), XAddr rewriting, the serialized control queue under concurrent401,
// and the well-behaved `ideal` camera. Skips while lane A's modules are not present.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { laneModules } from './helpers.js';

const lane = await laneModules(['electron/tapo/onvif-client.js']);
const mod = lane.mods['electron/tapo/onvif-client.js'];

/** @param {any} sim @param {Record<string, any>} [o] */
const clientFor = (sim, o = {}) => new mod.OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => 'se&cret', log: () => {}, ...o });

describe.skipIf(!lane.ok)(`OnvifClient × simulator${lane.reason}`, () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(() => sim?.close());
  afterEach(() => sim.reset());

  it('connects: device information, PTZ/Events XAddrs from their own sections, tokens read from the camera', async () => {
    const c = clientFor(sim);
    const device = await c.connect();
    expect(device).toMatchObject({ manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', hardwareId: '2.0' });
    expect(c.xaddr.ptz).toBe(`http://127.0.0.1:${sim.onvifPort}/onvif/service`);
    expect(c.xaddr.events).toBe(`http://127.0.0.1:${sim.onvifPort}/onvif/service`);
    expect(c.profile).toMatchObject({ token: 'profile_1', ptzConfigToken: 'PTZConfiguration_1', encoding: 'H264', width: 2304, height: 1296 });
    // GetSystemDateAndTime first and without auth; every other call authenticated
    const ops = sim.calls.filter((x) => x.service !== 'rtsp');
    expect(ops[0]).toMatchObject({ op: 'GetSystemDateAndTime', status: 200 });
    expect(ops.every((x) => x.status === 200)).toBe(true);
    expect(sim.state.authFailures.onvif).toBe(0);
    c.close?.();
  });

  it('compensates a camera clock 30 s off (no NTP): every signed call is accepted', async () => {
    sim.set({ clockSkewSec: 30 });
    const c = clientFor(sim);
    await c.connect();
    const clock = await c.syncClock();
    expect(Math.abs(clock.offsetMs - 30_000)).toBeLessThan(1500);
    expect(clock.ntp).toBe(false);
    expect(sim.state.authFailures.onvif).toBe(0);
    await expect(c.getStatus()).resolves.toBeTruthy();
  });

  it('a wrong password: auth-failed after one clock resync, and no further request ever reaches the camera', async () => {
    const c = clientFor(sim, { getPassword: async () => 'wrong-password' });
    await expect(c.connect()).rejects.toMatchObject({ kind: 'auth' });
    const signedAttempts = sim.calls.filter((x) => x.status === 400 && x.why === 'wrong digest').length;
    expect(signedAttempts).toBeGreaterThanOrEqual(1);
    expect(signedAttempts).toBeLessThanOrEqual(3); // the call, its one retry after a resync (+ at most one sign-in check)
    const before = sim.calls.length;
    await expect(c.getDeviceInformation()).rejects.toMatchObject({ kind: 'auth' });
    await expect(c.getStatus()).rejects.toBeTruthy();
    expect(sim.calls.length).toBe(before); // never loops on bad credentials (camera lockouts)
  });

  it('rewrites XAddrs the camera reports with a host the LAN cannot resolve', async () => {
    sim.set({ quirks: { xaddrHost: 'tapo-c211.invalid:2020' } });
    const c = clientFor(sim);
    await c.connect();
    expect(c.xaddr.ptz).toBe(`http://127.0.0.1:${sim.onvifPort}/onvif/service`);
    await expect(c.getPresets()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ token: '1', name: 'Door' })]));
  });

  it('with concurrent401 on, overlapping callers never overlap on the wire (one serialized queue)', async () => {
    sim.set({ quirks: { concurrent401: true } });
    const c = clientFor(sim);
    await c.connect();
    const results = await Promise.allSettled([c.getStatus(), c.getPresets(), c.getStatus(), c.getNodes(), c.getStatus()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(sim.calls.some((x) => x.status === 401)).toBe(false);
  });

  it('privacy mode: a PTZ call fails as malformed / HTTP 500, a device call still works', async () => {
    const c = clientFor(sim);
    await c.connect();
    sim.set({ privacy: true });
    await expect(c.getStatus()).rejects.toMatchObject({ kind: expect.stringMatching(/malformed|fault|http/) });
    await expect(c.getDeviceInformation()).resolves.toMatchObject({ model: 'Tapo C211' });
  });

  it('PullPoint basics: InitialTerminationTime refused (C500) → subscribes without it; topics from GetEventProperties', async () => {
    const c = clientFor(sim);
    await c.connect();
    const topics = await c.getEventProperties();
    expect(topics).toEqual(expect.arrayContaining(['tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/PeopleDetector/People']));
    const sub = await c.createPullPoint();
    expect(sub.address).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${sim.onvifPort}/event-\\d+_${sim.onvifPort}$`));
    const creates = sim.callsOf('CreatePullPointSubscription');
    expect(creates.map((x) => [x.args.initialTerminationTime, x.status])).toEqual([['PT10M', 400], [null, 200]]);
    await c.unsubscribe(sub.address);
    expect(sim.state.subscriptions.list).toHaveLength(0);
  });
});

describe.skipIf(!lane.ok)(`OnvifClient × the well-behaved "ideal" camera${lane.reason}`, () => {
  it('uses the per-service paths and the first profile that has PTZ', async () => {
    const sim = await startSim({ quirks: 'ideal' });
    try {
      const c = clientFor(sim);
      await c.connect();
      expect(c.xaddr.ptz).toBe(`http://127.0.0.1:${sim.onvifPort}/onvif/ptz_service`);
      expect(c.xaddr.media).toBe(`http://127.0.0.1:${sim.onvifPort}/onvif/media_service`);
      expect(c.profile).toMatchObject({ token: 'MainStream', ptzConfigToken: 'PtzConfigMain' });
      await expect(c.getStatus()).resolves.toBeTruthy();
      expect(sim.calls.filter((x) => x.status !== 200 && x.service !== 'rtsp')).toEqual([]);
    } finally {
      await sim.close();
    }
  });
});
