// PtzController on a real OnvifClient against the fake camera (real sockets, real timers).
import { describe, it, expect } from 'vitest';
import { OnvifClient } from '../../../electron/tapo/onvif-client.js';
import { PtzController } from '../../../electron/tapo/ptz.js';
import { sleep, startFakeOnvif } from './helpers/fake-onvif.js';

const SETTINGS = { ptz: 'auto', invertPan: true, invertTilt: false, stepSmall: 0.15, stepMedium: 0.35, stepLarge: 0.75, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, holdSpeed: 0.5, msPerUnit: 6000, homePreset: '', localPresets: [] };

async function setup(quirks = {}) {
  const cam = await startFakeOnvif({ quirks });
  const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'camacct', getPassword: async () => 'se&cret' });
  await client.connect();
  const ptz = new PtzController({ client, getSettings: () => SETTINGS });
  await ptz.probe();
  return { cam, client, ptz };
}

describe('PTZ over ONVIF (fake camera)', () => {
  it('probes without moving, nudges with the inverted pan sign and sees IDLE', async () => {
    const { cam, ptz } = await setup();
    try {
      expect(ptz.caps).toMatchObject({ available: true, mode: 'relative', canStatus: true, canAbsolute: true, canContinuous: true });
      expect(cam.ops()).not.toContain('RelativeMove');
      expect(cam.ops()).not.toContain('ContinuousMove');
      const r = await ptz.command({ op: 'nudge', dir: 'right', amount: 'medium' });
      expect(r).toMatchObject({ ok: true, moved: true });
      const mv = cam.calls.find((c) => c.op === 'RelativeMove');
      expect(mv?.args).toEqual({ x: '-0.175', y: '0' });
      expect(await ptz.waitIdle(3000)).toBe(true);
      expect(ptz.position?.x).toBeCloseTo(-0.175);
      expect((await ptz.presets()).map((p) => p.name)).toEqual(['Door', 'Window']);
      await ptz.command({ op: 'preset-name', name: 'window' });
      expect(cam.calls.filter((c) => c.op === 'GotoPreset').map((c) => c.args.presetToken)).toEqual(['2']);
    } finally {
      await ptz.dispose();
      await cam.close();
    }
  });

  it('a hold sends ContinuousMove and the release sends Stop', async () => {
    const { cam, ptz } = await setup();
    try {
      await ptz.command({ op: 'hold', dir: 'left' });
      await sleep(250);
      await ptz.command({ op: 'heartbeat' });
      await sleep(250);
      await ptz.command({ op: 'release' });
      const ops = cam.ops();
      expect(ops).toContain('ContinuousMove');
      expect(ops.lastIndexOf('Stop')).toBeGreaterThan(ops.lastIndexOf('ContinuousMove'));
      expect(cam.calls.find((c) => c.op === 'ContinuousMove')?.args).toEqual({ x: '0.5', y: '0', timeout: 'PT1S' });
    } finally {
      await ptz.dispose();
      await cam.close();
    }
  });

  it('privacy mode: malformed answer, then HTTP 500 — PTZ paused, not unsupported', async () => {
    const { cam, ptz } = await setup();
    try {
      cam.quirks.privacy = true;
      const r = await ptz.command({ op: 'nudge', dir: 'up', amount: 'small' });
      expect(r.code).toBe('privacy');
      expect(ptz.caps.available).toBe(true);
      expect(ptz.privacySuspected).toBe(true);
    } finally {
      await ptz.dispose();
      await cam.close();
    }
  });

  it('Stop faults → minimal Stop → zero velocity over the wire', async () => {
    const { cam, ptz } = await setup({ stopFaults: true, stopMinimalFaults: true });
    try {
      await ptz.command({ op: 'stop' });
      const tail = cam.calls.slice(-3).map((c) => `${c.op}${c.op === 'ContinuousMove' ? `(${c.args.x},${c.args.y})` : /PanTilt>true/.test(c.body) ? '(full)' : '(minimal)'}`);
      expect(tail).toEqual(['Stop(full)', 'Stop(minimal)', 'ContinuousMove(0,0)']);
    } finally {
      await ptz.dispose();
      await cam.close();
    }
  });
});
