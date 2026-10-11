// Integration: the app's pan/tilt controller (electron/tapo/ptz.js, contract §8.4) driving the
// simulated Tapo motor: the camera turns the way the user asked once the calibration's settings
// are in (mirrored pan, inverted tilt, view units, minimum step), click-to-center, presets and
// home, and the motor watchdogs: a RelativeMove that runs away like a ContinuousMove is stopped
// within the bound, a Stop ignored on the pan axis is backed up by a zero-velocity move, a hold
// without heartbeats stops, privacy mode answers "privacy" without marking PTZ unsupported.
// The motor must never push against an end stop.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startSim, SIM_TRUTH } from '../../../tools/tapo-sim/index.mjs';
import { gridCell } from '../../../tools/tapo-sim/geometry.mjs';
import { appModules, sleep, until } from './helpers.js';

const lane = await appModules(['electron/tapo/onvif-client.js', 'electron/tapo/ptz.js']);
const { OnvifClient } = lane.mods['electron/tapo/onvif-client.js'];
const { PtzController } = lane.mods['electron/tapo/ptz.js'];

/** What a finished calibration writes for this camera (the simulator's truth). */
const calibrated = () => ({
  ptz: 'auto', invertPan: true, invertTilt: true, stepSmall: 0.15, stepMedium: 0.35, stepLarge: 0.75,
  viewUnitsX: SIM_TRUTH.viewUnitsX, viewUnitsY: SIM_TRUTH.viewUnitsY, minStep: SIM_TRUTH.minEffectiveStep,
  holdSpeed: 0.5, msPerUnit: 6000, homePreset: '', localPresets: [],
});

describe('PtzController × simulated Tapo motor', () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {any} */
  let client;
  /** @type {any} */
  let ptz;
  /** @type {ReturnType<typeof calibrated>} */
  let settings;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(() => sim?.close());
  beforeEach(async () => {
    sim.reset();
    settings = calibrated();
    client = new OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => 'se&cret', log: () => {} });
    await client.connect();
    ptz = new PtzController({ client, getSettings: () => settings, log: () => {} });
  });
  afterEach(async () => {
    await ptz.stopAll('test end').catch(() => {});
    await ptz.dispose?.();
    client.close?.();
    expect(sim.state.ptz.endStopMs, 'the motor pushed against an end stop').toBe(0);
  });
  const idle = (timeout = 5000) => until(() => !sim.state.ptz.moving && !ptz.moving, { timeout, what: 'the camera to stop' });
  /** The way the lens points, as the user sees it (through the camera's quirks). */
  const view = () => {
    const { x, y } = sim.state.ptz;
    return gridCell(sim.quirks.mirrorPan ? -x : x, sim.quirks.invertTilt ? -y : y);
  };

  it('probes without moving: relative mode, GetStatus, AbsoluteMove, presets from the camera', async () => {
    const caps = await ptz.probe();
    expect(caps).toMatchObject({ available: true, mode: 'relative', canStatus: true, canAbsolute: true });
    expect(sim.callsOf('RelativeMove').length + sim.callsOf('ContinuousMove').length + sim.callsOf('AbsoluteMove').length).toBe(0);
    const presets = await ptz.presets({ refresh: true });
    expect(presets).toEqual(expect.arrayContaining([expect.objectContaining({ token: '1', name: 'Door', source: 'camera' }), expect.objectContaining({ token: '2', name: 'Window' })]));
  });

  it('with the calibrated settings the camera turns the way the user asked (mirrored pan, inverted tilt)', async () => {
    await ptz.probe();
    expect(await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' })).toMatchObject({ ok: true });
    await idle();
    // 0.35 of the view × 0.8 units per view; the mirrored camera needs a negative x to look right
    expect(sim.callsOf('RelativeMove')[0].args).toMatchObject({ x: expect.closeTo(-0.28, 6), y: 0 });
    expect(view().i).toBeGreaterThan(0);
    await ptz.command({ op: 'nudge', dir: 'up', amount: 'medium' });
    await idle();
    expect(sim.callsOf('RelativeMove')[1].args).toMatchObject({ x: 0, y: expect.closeTo(-0.42, 6) });
    expect(view().j).toBeGreaterThan(0);
  });

  it('raises a tiny nudge to the minimum step the camera acts on', async () => {
    await ptz.probe();
    settings.stepSmall = 0.02; // 0.016 units: the camera would acknowledge and ignore it
    await ptz.command({ op: 'nudge', dir: 'left', amount: 'small' });
    await idle();
    expect(Math.abs(sim.callsOf('RelativeMove')[0].args.x)).toBeCloseTo(0.05, 6);
    expect(sim.state.ptz.x).toBeCloseTo(0.05, 6); // it did move (mirrored: left is +x)
  });

  it('click-to-center: a proportional RelativeMove; inside the deadband nothing is sent', async () => {
    await ptz.probe();
    await ptz.command({ op: 'center', u: 0.75, v: 0.5 });
    await idle();
    expect(sim.callsOf('RelativeMove')[0].args.x).toBeCloseTo(-0.2, 6); // 0.25 of the view to the right
    const n = sim.callsOf('RelativeMove').length;
    expect(await ptz.command({ op: 'center', u: 0.51, v: 0.48 })).toMatchObject({ ok: true, moved: false });
    expect(sim.callsOf('RelativeMove').length).toBe(n);
  });

  it('presets by name and home (AbsoluteMove 0,0 when there is no home preset)', async () => {
    await ptz.probe();
    await ptz.command({ op: 'preset-name', name: 'the door' });
    await idle();
    expect(sim.callsOf('GotoPreset').map((c) => c.args.token)).toEqual(['1']);
    expect(sim.state.ptz).toMatchObject({ x: 0.3, y: -0.2 });
    await ptz.command({ op: 'home' });
    await idle();
    expect(sim.callsOf('AbsoluteMove').at(-1)?.args).toMatchObject({ x: 0, y: 0 });
    expect(sim.state.ptz).toMatchObject({ x: 0, y: 0 });
  });

  it('a RelativeMove that runs away like a ContinuousMove is stopped within the watchdog bound', async () => {
    sim.set({ quirks: { relativeActsContinuous: true } });
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    // bound: min(8 s, 1.5 s + |t| × msPerUnit) = 1.5 + 0.28 × 6 = 3.18 s
    const bound = Math.min(8000, 1500 + 0.28 * settings.msPerUnit);
    await until(() => !sim.state.ptz.moving, { timeout: bound + 2000, what: 'the runaway move to be stopped' });
    expect(Date.now() - t0).toBeLessThan(bound + 1500);
    expect(sim.callsOf('Stop', t0).length + sim.callsOf('ContinuousMove', t0).filter((c) => c.args.x === 0 && c.args.y === 0).length).toBeGreaterThan(0);
  });

  it('a runaway move whose Stop the pan axis ignores is stopped by a zero-velocity ContinuousMove', async () => {
    // the worst case for the gearbox: RelativeMove turned endless (C260) and Stop ignored on pan (C520WS)
    sim.set({ quirks: { relativeActsContinuous: true, stopIgnoredOnPan: true } });
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'left', amount: 'medium' });
    const bound = Math.min(8000, 1500 + 0.28 * settings.msPerUnit);
    await until(() => !sim.state.ptz.moving, { timeout: bound + 3000, what: 'the pan axis to stop' });
    expect(Date.now() - t0).toBeLessThan(bound + 2000); // the Stop chain: Stop, 600 ms check, zero velocity
    expect(sim.callsOf('ContinuousMove', t0).some((c) => c.args.x === 0 && c.args.y === 0)).toBe(true);
  });

  it('press-and-hold: ContinuousMove re-sent while heartbeats come; release stops it (Stop or its own PT1S)', async () => {
    sim.set({ quirks: { stopIgnoredOnPan: true } });
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'hold', dir: 'left' });
    for (let k = 0; k < 6; k++) {
      await sleep(250);
      await ptz.command({ op: 'heartbeat' });
    }
    expect(sim.state.ptz.moving).toBe(true);
    expect(sim.callsOf('ContinuousMove', t0).filter((c) => c.args.x !== 0).length).toBeGreaterThanOrEqual(2);
    expect(sim.callsOf('ContinuousMove', t0).every((c) => c.args.timeout === 'PT1S')).toBe(true);
    const released = Date.now();
    await ptz.command({ op: 'release' });
    await until(() => !sim.state.ptz.moving, { timeout: 3000, what: 'the hold to end' });
    expect(Date.now() - released).toBeLessThan(2000);
  });

  it('a hold whose heartbeats stop (renderer gone) stops the motor after ~700 ms', async () => {
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'hold', dir: 'right' });
    await until(() => sim.callsOf('ContinuousMove', t0).length > 0);
    await until(() => !sim.state.ptz.moving, { timeout: 3000, what: 'the heartbeat watchdog' });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(sim.callsOf('Stop', t0).length).toBeGreaterThan(0);
  });

  it('without GetStatus the watchdog stops every move on time (a late Stop is harmless)', async () => {
    sim.set({ quirks: { getStatusFails: true } });
    const caps = await ptz.probe();
    expect(caps.canStatus).toBe(false);
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'down', amount: 'small' });
    await until(() => sim.callsOf('Stop', t0).length > 0, { timeout: 6000, what: 'the timed Stop' });
    const stopAt = sim.callsOf('Stop', t0)[0].t - t0;
    expect(stopAt).toBeGreaterThan(1000);
    expect(stopAt).toBeLessThan(Math.min(8000, 1500 + 0.18 * settings.msPerUnit) + 1500);
  });

  it('privacy mode: commands answer "privacy" with the hint; PTZ is not marked unsupported', async () => {
    await ptz.probe();
    sim.set({ privacy: true });
    const r1 = await ptz.command({ op: 'nudge', dir: 'left', amount: 'medium' });
    const r2 = await ptz.command({ op: 'nudge', dir: 'left', amount: 'medium' });
    expect([r1.code, r2.code]).toContain('privacy');
    expect(r2).toMatchObject({ ok: false, code: 'privacy', error: expect.stringMatching(/privacy mode/i) });
    expect(ptz.caps.available).toBe(true);
    sim.set({ privacy: false });
  });
});
