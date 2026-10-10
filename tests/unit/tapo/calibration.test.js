import { describe, it, expect } from 'vitest';
import { CalibrationWizard } from '../../../electron/tapo/calibration.js';

const CURRENT = { invertPan: false, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, msPerUnit: 6000 };

/**
 * A scripted camera: the scene shift for a raw move (x, y) = -(x, y) × gain (mirrored axes flip
 * the sign); `score` and an `overrides` queue for special answers.
 */
function rig(o = {}) {
  const moves = [];
  const gainX = o.gainX ?? 0.8; // view fractions per unit (viewUnitsX = 1 / gainX)
  const gainY = o.gainY ?? 0.7;
  const mirrorPan = !!o.mirrorPan;
  const invertTilt = !!o.invertTilt;
  const minEffective = o.minEffective ?? 0.04;
  let last = { x: 0, y: 0 };
  const overrides = [...(o.overrides || [])];
  const saved = [];
  const states = [];
  const measures = [];
  const wiz = new CalibrationWizard({
    ptz: {
      rawMove: async (x, y) => {
        moves.push([x, y]);
        last = { x: Math.abs(x) >= minEffective ? x : 0, y: Math.abs(y) >= minEffective ? y : 0 };
        return { settledMs: 1200, ...(o.reportsMoves ? { measured: true, moved: !!(last.x || last.y) } : {}) };
      },
      stopAll: async () => {},
    },
    vision: {
      ref: async () => {},
      measure: async (m) => {
        measures.push(m);
        if (overrides.length) return overrides.shift();
        // camera turns right (+x) → scene moves left (−dx); tilt up (+y) → scene moves down (+dy)
        return { dx: -last.x * gainX * (mirrorPan ? -1 : 1), dy: last.y * gainY * (invertTilt ? -1 : 1), score: o.score ?? 0.6, settledMs: 1500 };
      },
    },
    canStart: () => o.why ?? null,
    current: () => ({ ...CURRENT }),
    save: (r) => saved.push(r),
    delay: async () => {},
    now: () => Date.parse('2026-10-10T12:00:00Z'),
  });
  wiz.on('state', (s) => states.push(s));
  const finished = () => new Promise((resolve) => {
    const check = () => (['done', 'failed', 'idle', 'ask'].includes(wiz.state.step) && !(wiz.state.step === 'idle' && wiz.running) ? resolve(wiz.state) : setTimeout(check, 1));
    check();
  });
  const net = () => moves.reduce((a, [x, y]) => ({ x: a.x + x, y: a.y + y }), { x: 0, y: 0 });
  return { wiz, moves, saved, states, finished, net, measures };
}

describe('CalibrationWizard: video lag', () => {
  it('tells the picture to wait for a move the camera reported (a real camera\'s video lags the motor)', async () => {
    const r = rig({ reportsMoves: true });
    r.wiz.request({ action: 'start' });
    expect((await r.finished()).step).toBe('done');
    expect(r.measures.length).toBeGreaterThan(2);
    // the first pan and tilt measures follow a move the camera reported
    expect(r.measures[0]).toEqual({ timeoutMs: 6000, expectMove: true });
    // the min-step probe's 0.02 is below what this firmware acts on: no move, no waiting
    expect(r.measures.some((m) => m.expectMove === false)).toBe(true);
    const plain = rig();
    plain.wiz.request({ action: 'start' });
    await plain.finished();
    expect(plain.measures.every((m) => m.expectMove === false)).toBe(true); // no GetStatus: nothing to go by
  });
});

describe('CalibrationWizard', () => {
  it('measures signs, view units, min step and speed for a standard camera', async () => {
    const r = rig();
    expect(r.wiz.request({ action: 'start' }).step).toBe('pan');
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: false, invertTilt: false, minStep: 0.05 });
    expect(st.result.viewUnitsX).toBeCloseTo(1 / 0.8);
    expect(st.result.viewUnitsY).toBeCloseTo(1 / 0.7);
    expect(st.result.msPerUnit).toBe(Math.round(1500 / 0.2));
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].calibratedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(r.net().x).toBeCloseTo(0);
    expect(r.net().y).toBeCloseTo(0);
    expect(r.states.map((s) => s.step)).toEqual(expect.arrayContaining(['pan', 'tilt', 'min-step', 'done']));
  });

  it('detects mirrored pan (the C211) and inverted tilt', async () => {
    const r = rig({ mirrorPan: true, invertTilt: true });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true });
  });

  it('retries with a bigger move when the picture barely moved', async () => {
    const r = rig({ overrides: [{ dx: -0.005, dy: 0, score: 0.6 }] });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(r.moves.slice(0, 4)).toEqual([[0.2, 0], [-0.2, 0], [0.4, 0], [-0.4, 0]]);
    expect(st.result.viewUnitsX).toBeCloseTo(1 / 0.8);
  });

  it('asks the user when the picture cannot be measured (dark, featureless)', async () => {
    const r = rig({ score: 0.05 });
    r.wiz.start();
    let st = await r.finished();
    expect(st.step).toBe('ask');
    expect(st.answers).toEqual(['left', 'right', 'none']);
    expect(st.question).toMatch(/Which way did the camera turn/);
    r.wiz.answer('up'); // not an answer to this question: ignored
    expect(r.wiz.state.step).toBe('ask');
    r.wiz.answer('left');
    await new Promise((res) => setTimeout(res, 5));
    st = await r.finished();
    expect(st.step).toBe('ask');
    expect(st.answers).toEqual(['up', 'down', 'none']);
    r.wiz.answer('up');
    st = await new Promise((res) => {
      const check = () => (r.wiz.state.step === 'done' || r.wiz.state.step === 'failed' ? res(r.wiz.state) : setTimeout(check, 1));
      check();
    });
    expect(st.step).toBe('done');
    // the user said "left" for +x: mirrored pan; the units it could not measure stay
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05 });
    expect(r.net().x).toBeCloseTo(0);
  });

  it('"none" fails with a hint and puts the camera back', async () => {
    const r = rig({ score: 0.05 });
    r.wiz.start();
    await r.finished();
    r.wiz.answer('none');
    const st = await new Promise((res) => {
      const check = () => (r.wiz.state.step === 'failed' ? res(r.wiz.state) : setTimeout(check, 1));
      check();
    });
    expect(st.error).toMatch(/did not turn/);
    expect(r.net().x).toBeCloseTo(0);
    expect(r.saved).toHaveLength(0);
  });

  it('cancel stops and restores the starting position', async () => {
    const r = rig({ score: 0.05 });
    r.wiz.start();
    await r.finished(); // waiting for an answer, turned by +0.2
    expect(r.wiz.request({ action: 'cancel' }).step).toBe('idle');
    await new Promise((res) => setTimeout(res, 10));
    expect(r.wiz.running).toBe(false);
    expect(r.net().x).toBeCloseTo(0);
    expect(r.net().y).toBeCloseTo(0);
    expect(r.saved).toHaveLength(0);
  });

  it('refuses to start when PTZ or the stream is not ready', () => {
    const r = rig({ why: 'The live picture is needed for calibration. Wait until the camera is online.' });
    expect(r.wiz.start()).toMatchObject({ step: 'failed', error: /live picture/ });
    expect(r.moves).toEqual([]);
  });
});
