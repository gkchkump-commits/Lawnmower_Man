// Regression tests for the motor review (fixer round), against the simulator: a move whose request
// fails still gets its watchdog (and never leaves `moving` stuck), a lost answer gets a timed Stop,
// zero velocity follows a Stop nothing can confirm, a long preset move that converges is not cut
// short, a hold stops at the end of the travel, calibration does not feed its own estimate back
// into msPerUnit, and a wrong password costs one refused sign-in per test.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startSim, SIM_TRUTH } from '../../../tools/tapo-sim/index.mjs';
import { OnvifClient } from '../../../electron/tapo/onvif-client.js';
import { PtzController } from '../../../electron/tapo/ptz.js';
import { CalibrationWizard } from '../../../electron/tapo/calibration.js';
import { connectionTest } from '../../../electron/tapo/connection-test.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calibrated = () => ({
  ptz: 'auto', invertPan: true, invertTilt: true, stepSmall: 0.15, stepMedium: 0.35, stepLarge: 0.75,
  viewUnitsX: SIM_TRUTH.viewUnitsX, viewUnitsY: SIM_TRUTH.viewUnitsY, minStep: SIM_TRUTH.minEffectiveStep,
  holdSpeed: 0.5, msPerUnit: 6000, homePreset: '', localPresets: [],
});
const newClient = (sim, password = 'se&cret') => new OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => password, log: () => {} });

describe('PTZ watchdog after failed or lost moves (simulator)', () => {
  let sim;
  let client;
  let ptz;
  let settings;
  beforeAll(async () => { sim = await startSim(); });
  afterAll(() => sim?.close());
  beforeEach(async () => {
    sim.reset();
    settings = calibrated();
    client = newClient(sim);
    await client.connect();
    ptz = new PtzController({ client, getSettings: () => settings, log: () => {} });
  });
  afterEach(async () => {
    sim.camera.ptz.halt();
    await ptz.dispose().catch(() => {});
    client.close();
  });

  it('a RelativeMove that runs away, with Stop ignored on pan and no GetStatus: zero velocity stops it', async () => {
    sim.set({ quirks: { relativeActsContinuous: true, stopIgnoredOnPan: true, getStatusFails: true } });
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'left', amount: 'medium' });
    await sleep(6000);
    const st = sim.state.ptz;
    expect(st.moving, 'pan still turning after the timed Stop').toBe(false);
    expect(st.endStopMs).toBe(0);
    expect(sim.callsOf('ContinuousMove', t0).filter((c) => Number(c.args.x) === 0 && Number(c.args.y) === 0).length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('a lost (timed-out) RelativeMove answer: the camera acted on it, and the timed Stop still comes', async () => {
    await ptz.probe();
    sim.set({ quirks: { relativeActsContinuous: true, latencyMs: 5600 } });
    const t0 = Date.now();
    const r = await ptz.command({ op: 'nudge', dir: 'right', amount: 'small' });
    expect(r).toMatchObject({ ok: false, code: 'offline' });
    sim.set({ quirks: { latencyMs: 40 } });
    await sleep(5000);
    const st = sim.state.ptz;
    expect(sim.callsOf('Stop', t0).length).toBeGreaterThanOrEqual(1);
    expect(st.moving, 'still turning after a timed-out RelativeMove').toBe(false);
    expect(st.endStopMs).toBe(0);
    expect(ptz.moving, 'PtzController.moving stuck true').toBe(false);
  }, 20000);

  it('a privacy-mode answer does not leave moving=true', async () => {
    await ptz.probe();
    sim.set({ privacy: true });
    const r = await ptz.command({ op: 'nudge', dir: 'left', amount: 'medium' });
    expect(r.code).toBe('privacy');
    sim.set({ privacy: false });
    await sleep(2000);
    expect(ptz.moving).toBe(false);
  }, 10000);

  it('a refused GotoPreset (unknown token) ends the move at once', async () => {
    await ptz.probe();
    const r = await ptz.command({ op: 'preset', token: '7' });
    expect(r.ok).toBe(false);
    expect(ptz.moving).toBe(false);
  }, 10000);

  it('a relative-only hold with a runaway RelativeMove, Stop ignored and no GetStatus stops after release', async () => {
    settings.ptz = 'relative';
    sim.set({ quirks: { relativeActsContinuous: true, stopIgnoredOnPan: true, getStatusFails: true } });
    await ptz.probe();
    await ptz.command({ op: 'hold', dir: 'left' });
    for (let k = 0; k < 4; k++) {
      await sleep(250);
      await ptz.command({ op: 'heartbeat' });
    }
    await ptz.command({ op: 'release' });
    await sleep(4000);
    expect(sim.state.ptz.moving).toBe(false);
  }, 15000);

  it('a continuous-mode nudge sends a whole-second Timeout', async () => {
    settings.ptz = 'continuous';
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
    await sleep(3500);
    const timeouts = sim.callsOf('ContinuousMove', t0).map((c) => c.args.timeout).filter(Boolean);
    expect(timeouts.length).toBeGreaterThan(0);
    for (const t of timeouts) expect(t).toMatch(/^PT\d+S$/);
    expect(sim.state.ptz.moving).toBe(false);
  }, 10000);

  it('a slow preset move that GetStatus shows converging is not stopped at 8 s', async () => {
    sim.camera.ptz.place(-1, -0.2);
    sim.camera.ptz.x.speed = 0.15;
    await ptz.probe();
    const t0 = Date.now();
    await ptz.command({ op: 'preset', token: '1' }); // Door at x 0.3: ≈ 8.7 s at 0.15 u/s
    await sleep(11_000);
    expect(sim.state.ptz.x).toBeCloseTo(0.3, 2);
    expect(sim.callsOf('Stop', t0).filter((c) => c.t - t0 < 8500)).toEqual([]);
    expect(ptz.moving).toBe(false);
  }, 20000);

  it('press-and-hold stops at the end of the travel (and tracks the position)', async () => {
    await ptz.probe();
    sim.camera.ptz.place(-0.6, 0);
    const e0 = sim.state.ptz.endStopMs;
    await ptz.command({ op: 'hold', dir: 'right' }); // mirrored pan: right = −x
    for (let k = 0; k < 28; k++) {
      await sleep(250);
      await ptz.command({ op: 'heartbeat' });
    }
    await ptz.command({ op: 'release' });
    expect(sim.state.ptz.endStopMs - e0).toBeLessThan(1000);
    expect(ptz.position.x).toBeLessThan(-0.9);
  }, 15000);
});

describe('calibration without GetStatus', () => {
  it('keeps msPerUnit instead of feeding its own timed Stop back into it', async () => {
    const sim = await startSim({ quirks: { getStatusFails: true } });
    try {
      const client = newClient(sim);
      await client.connect();
      const settings = { ...calibrated(), invertPan: false, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05 };
      const ptz = new PtzController({ client, getSettings: () => settings, log: () => {} });
      await ptz.probe();
      let last = { x: 0, y: 0 };
      const wizardPtz = { rawMove: async (x, y) => { last = { x, y }; return ptz.rawMove(x, y); }, stopAll: (r) => ptz.stopAll(r) };
      // a current picture: the reference and each measurement name frames from after the move
      // (updated on purpose for the gated protocol: an unstamped answer is no longer trusted)
      let refAt = 0;
      const vision = {
        ref: async ({ after }) => {
          refAt = after + 1;
          return { ok: true, at: refAt };
        },
        measure: async ({ after }) => ({ dx: last.x / SIM_TRUTH.viewUnitsX, dy: last.y / SIM_TRUTH.viewUnitsY, score: 0.9, settledMs: 0, at: after + 1, refAt }),
      };
      const w = new CalibrationWizard({ ptz: wizardPtz, vision, canStart: () => null, current: () => ({ ...settings }), save: (r) => Object.assign(settings, r), delay: async () => {} });
      w.start();
      await new Promise((resolve) => { const t = setInterval(() => { if (!w.running) { clearInterval(t); resolve(); } }, 100); });
      expect(w.state.step).toBe('done');
      expect(settings.invertPan).toBe(true);
      expect(settings.msPerUnit).toBe(6000); // before: 6000 → 13985 → 20000 over three runs
      await ptz.dispose();
      client.close();
    } finally {
      await sim.close();
    }
  }, 120_000);

  it('with GetStatus: msPerUnit comes from the travel time the camera reported', async () => {
    const sim = await startSim();
    try {
      const client = newClient(sim);
      await client.connect();
      const settings = { ...calibrated(), invertPan: false, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05 };
      const ptz = new PtzController({ client, getSettings: () => settings, log: () => {} });
      await ptz.probe();
      const r = await ptz.rawMove(0.2, 0);
      expect(r.measured).toBe(true);
      expect(r.moved).toBe(true); // the reported position changed: the picture will move too
      await ptz.rawMove(-0.2, 0);
      expect((await ptz.rawMove(0.01, 0)).moved).toBe(false); // below the firmware's minimum step
      await ptz.rawMove(-0.01, 0);
      sim.set({ quirks: { getStatusFails: true } });
      await ptz.probe();
      const blind = await ptz.rawMove(0.2, 0);
      expect(blind.measured).toBe(false);
      expect(blind.moved).toBeUndefined(); // nothing to go by
      await ptz.rawMove(-0.2, 0);
      await ptz.dispose();
      client.close();
    } finally {
      await sim.close();
    }
  }, 60_000);
});

describe('a wrong password', () => {
  it('one press of Test connection costs one refused sign-in', async () => {
    const sim = await startSim();
    try {
      const r = await connectionTest({ host: '127.0.0.1', onvifPort: sim.onvifPort, rtspPort: sim.rtspPort, username: 'camacct', getPassword: async () => 'wrong-pass', allowLoopback: true, log: () => {} });
      expect(r.steps.find((s) => s.id === 'auth').ok).toBe(false);
      expect(sim.state.authFailures.onvif).toBe(1);
      expect(sim.state.authFailures.rtsp).toBe(0);
    } finally {
      await sim.close();
    }
  }, 30_000);
});
