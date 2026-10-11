// The pretend camera (src/bridge/mock-tapo.js) behaves like the contract says main does, so the
// browser e2e and the screenshots test real behaviour: settings checks, PTZ signs and the
// mirrored pan, the 2 s exit delay, events from evidence, the connection test.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { MOCK_TRUTH, createMockTapoCore, mockTestReport, sanitizeTapoPatch, sanitizeTapoValue } from '../../../src/bridge/mock-tapo.js';
import { createMockBridge } from '../../../src/bridge/mock.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cores = [];
afterEach(() => {
  for (const c of cores) c.dispose();
  cores = [];
});

function core(settingsPatch = {}, scenario = 'online') {
  let settings = deepMerge(DEFAULT_SETTINGS, deepMerge({ tapo: { enabled: true, host: '192.168.1.50', username: 'camacct' } }, settingsPatch));
  const c = createMockTapoCore({ scenario, getSettings: () => settings, patchSettings: (p) => { settings = deepMerge(settings, sanitizeTapoPatch(p)); }, assetBase: 'http://127.0.0.1:4173/tapo/index.html' });
  cores.push(c);
  return { c, settings: () => settings };
}

describe('settings checks', () => {
  it('clamps numbers, checks enums, keeps only tapo/security', () => {
    expect(sanitizeTapoValue('tapo.onvifPort', 70000)).toEqual({ value: 65535 });
    expect(sanitizeTapoValue('security.armDelaySec', 12.6)).toEqual({ value: 13 });
    expect(sanitizeTapoValue('security.notify', 'everything')).toBeNull();
    expect(sanitizeTapoValue('tapo.host', 'http://x')).toBeNull();
    expect(sanitizeTapoValue('security.quietHours', '23:00-07:00')).toEqual({ value: '23:00-07:00' });
    expect(sanitizeTapoValue('tapo.nope', 1)).toBeNull();
    expect(sanitizeTapoPatch({ tapo: { name: 'Hall' }, voice: { enabled: false } })).toEqual({ tapo: { name: 'Hall' } });
  });

  it('the avatar mock validates Home camera settings the same way', async () => {
    const b = createMockBridge({ startupMs: 1 });
    try {
      const s = await b.settings.set({ tapo: { onvifPort: 99999, stream: 'stream9', name: 'Hall camera' }, security: { cooldownSec: 1 } });
      expect(s.tapo.onvifPort).toBe(65535);
      expect(s.tapo.stream).toBe('stream1');
      expect(s.tapo.name).toBe('Hall camera');
      expect(s.security.cooldownSec).toBe(10);
    } finally {
      b.__mock.dispose();
    }
  });
});

describe('PTZ', () => {
  it('uncalibrated, "right" turns the mirrored camera left; with invertPan it turns right', async () => {
    const { c } = core();
    expect(await c.ptz({ op: 'nudge', dir: 'right', amount: 'small' })).toMatchObject({ ok: true, moved: true });
    expect(c.cam.target.x).toBeLessThan(0); // mirrored
    const { c: c2 } = core({ tapo: { invertPan: true } });
    await c2.ptz({ op: 'nudge', dir: 'right', amount: 'small' });
    expect(c2.cam.target.x).toBeGreaterThan(0);
  });

  it('a step is a fraction of the view in calibrated units; too-small moves are ignored', async () => {
    const { c } = core({ tapo: { invertPan: true, viewUnitsX: MOCK_TRUTH.viewUnitsX, minStep: 0 } });
    await c.ptz({ op: 'nudge', dir: 'right', amount: 'medium' });
    expect(c.cam.target.x).toBeCloseTo(0.35 * MOCK_TRUTH.viewUnitsX);
    const { c: tiny } = core({ tapo: { minStep: 0 } });
    expect(c.relativeMove(0.01, 0, { raw: true })).toBe(false);
    expect((await tiny.ptz({ op: 'center', u: 0.52, v: 0.5 })).moved).toBe(false); // deadband
  });

  it('logs every command; refuses when offline or in privacy mode', async () => {
    const { c } = core({}, 'privacy');
    await wait(950); // connecting → online
    expect(await c.ptz({ op: 'nudge', dir: 'up', amount: 'medium' })).toMatchObject({ ok: false, code: 'privacy' });
    expect(c.calls.at(-1)).toMatchObject({ op: 'nudge', dir: 'up' });
    const { c: off } = core({}, 'offline');
    expect(await off.ptz({ op: 'home' })).toMatchObject({ ok: false, code: 'offline' });
  });

  it('a hold without heartbeats stops by itself (like main)', async () => {
    const { c } = core();
    await c.ptz({ op: 'hold', dir: 'left' });
    expect(c.cam.velocity).not.toBeNull();
    await wait(800);
    expect(c.cam.velocity).toBeNull();
  });
});

describe('arming and events', () => {
  it('arming takes 2 s; disarm is immediate and ends an event', async () => {
    const { c, settings } = core();
    const r = await c.arm({ armed: true });
    expect(r).toMatchObject({ armed: false, arming: true });
    expect(settings().security.armed).toBe(true);
    await wait(2100);
    expect(c.security.armed).toBe(true);
    const events = [];
    c.subscribe('event', (m) => events.push(m));
    c.evidence('person', 0.9);
    expect(events[0]).toMatchObject({ phase: 'start', event: { kind: 'person', maxScore: 0.9 } });
    await c.arm({ armed: false });
    expect(events.at(-1)).toMatchObject({ phase: 'end' });
    expect((await c.listEvents()).events[0].kind).toBe('person');
    await expect(c.arm(/** @type {any} */ (true))).rejects.toThrow(/armed: boolean/);
  });

  it('a motion event becomes a person event', async () => {
    const { c } = core();
    await c.arm({ armed: true, immediate: true });
    const events = [];
    c.subscribe('event', (m) => events.push(m));
    c.evidence('motion', 0);
    c.evidence('person', 0.7);
    expect(events.map((e) => [e.phase, e.event.kind])).toEqual([['start', 'motion'], ['update', 'person']]);
  });
});

describe('connection test', () => {
  it('passes, or stops at the sign-in with a hint', () => {
    expect(mockTestReport().ok).toBe(true);
    const bad = mockTestReport({ password: 'wrong' });
    expect(bad.ok).toBe(false);
    expect(bad.steps.at(-1)).toMatchObject({ id: 'auth', ok: false, hint: expect.stringMatching(/Camera Account/) });
    expect(mockTestReport({ scenario: 'offline' }).steps.at(-1)).toMatchObject({ id: 'tcp2020', ok: false });
  });
});
