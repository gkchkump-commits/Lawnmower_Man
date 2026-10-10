import { describe, it, expect } from 'vitest';
import { ASK_NOTES, CalibrationWizard } from '../../../electron/tapo/calibration.js';

const CURRENT = { invertPan: false, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, msPerUnit: 6000 };

/**
 * A scripted camera: the scene shift for a raw move (x, y) = -(x, y) × gain (mirrored axes flip
 * the sign); `score` and an `overrides` queue for special answers. Its pictures are current: the
 * reference and every measurement name frames that arrived after the move (`at` later than the
 * request's `after`), and a measurement names the reference it used. (Updated on purpose for the
 * gated protocol: before, the fake answered without stamps, which the wizard no longer trusts.)
 * `vision` replaces the picture side: (camera) => ({ ref, measure }), camera = { last, pos, gain }.
 */
function rig(o = {}) {
  const moves = [];
  const gainX = o.gainX ?? 0.8; // view fractions per unit (viewUnitsX = 1 / gainX)
  const gainY = o.gainY ?? 0.7;
  const mirrorPan = !!o.mirrorPan;
  const invertTilt = !!o.invertTilt;
  const minEffective = o.minEffective ?? 0.04;
  let last = { x: 0, y: 0 };
  const pos = { x: 0, y: 0 };
  const overrides = [...(o.overrides || [])];
  const saved = [];
  const states = [];
  const measures = [];
  const refs = [];
  const log = [];
  let tick = 1000;
  /** the scene shift of a raw camera move: turning right (+x) moves the scene left (−dx), tilting up (+y) moves it down (+dy) */
  const sceneOf = (m) => ({ dx: -m.x * gainX * (mirrorPan ? -1 : 1), dy: m.y * gainY * (invertTilt ? -1 : 1) });
  /** where the camera has been: after each move, oldest first */
  const history = [{ x: 0, y: 0 }];
  const camera = { get last() { return last; }, pos, history, sceneOf };
  let refAt = null;
  const current = {
    ref: async (q) => {
      refAt = q.after + 1;
      return { ok: true, at: refAt, still: true };
    },
    measure: async (m) => {
      const stamps = { at: m.after + 1, refAt };
      if (overrides.length) return { ...stamps, ...overrides.shift() };
      return { ...stamps, ...sceneOf(last), score: o.score ?? 0.6, settledMs: 1500 };
    },
  };
  const vision = o.vision ? o.vision(camera) : current;
  const wiz = new CalibrationWizard({
    ptz: {
      rawMove: async (x, y) => {
        moves.push([x, y]);
        last = { x: Math.abs(x) >= minEffective ? x : 0, y: Math.abs(y) >= minEffective ? y : 0 };
        pos.x += last.x;
        pos.y += last.y;
        history.push({ ...pos });
        return { settledMs: 1200, ...(o.reportsMoves ? { measured: true, moved: !!(last.x || last.y) } : {}) };
      },
      stopAll: async () => {},
    },
    vision: {
      ref: async (q) => {
        refs.push(q);
        return vision.ref(q);
      },
      measure: async (m) => {
        measures.push(m);
        return vision.measure(m);
      },
    },
    clock: () => (tick += 10),
    log: (level, msg) => log.push(msg),
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
  /** wait for the next question (or the end), answer it with what `answer(state)` says */
  const settle = async (answer) => {
    for (let i = 0; i < 10; i++) {
      const st = await finished();
      if (st.step !== 'ask') return st;
      wiz.answer(answer(st));
      await new Promise((res) => setTimeout(res, 2));
    }
    return wiz.state;
  };
  return { wiz, moves, saved, states, finished, settle, net, measures, refs, log };
}

/** The truth for the C211 (mirrored pan, inverted tilt): what a user sees when asked. */
const truthful = (st) => (st.answers.includes('left') ? 'left' : 'down');

/**
 * A stalled camera window worker, as in the tapo-e2e log on a loaded PC: its pictures are one move
 * behind the camera (they left it before the last move ended, which their arrival stamps show:
 * earlier than `after`), and its first reference picture does not come in time. The old wizard
 * carried on and saved invertPan false and viewUnitsX 1.6 from it (the truth: mirrored, 0.8).
 */
const stalledWorker = (cam) => {
  let n = 0;
  let refPos = { x: 0, y: 0 };
  const behind = () => cam.history[Math.max(0, cam.history.length - 2)];
  return {
    ref: async (q) => {
      n++;
      refPos = { ...behind() };
      if (n === 1) return { ok: false, reason: 'The camera picture did not arrive in time.' };
      return { ok: true, at: (q?.after ?? 0) - 5, still: true }; // the backlog's still picture
    },
    measure: async (m) => {
      const p = behind();
      return { ...cam.sceneOf({ x: p.x - refPos.x, y: p.y - refPos.y }), score: 0.95, settledMs: 6170, at: (m?.after ?? 0) - 5, refAt: -1 };
    },
  };
};
const C211 = { mirrorPan: true, invertTilt: true, gainX: 1 / 0.8, gainY: 1 / 1.2, reportsMoves: true, minEffective: 0.05 };

describe('CalibrationWizard: a picture that is not current is never used', () => {
  it('a stalled worker\'s stale pictures (the logged sign inversion) make it ask, never save a wrong result', async () => {
    const r = rig({ ...C211, vision: stalledWorker });
    r.wiz.start();
    const first = await r.finished();
    expect(first.step).toBe('ask'); // nothing current to measure against: the user is asked
    expect(first.note).toBe(ASK_NOTES.lagging); // …and told why
    expect(r.net().x).toBeCloseTo(0.2); // …with the camera turned, so they can see where it went
    const st = await r.settle(truthful);
    expect(st.step).toBe('done');
    expect(r.measures).toEqual([]); // never measured against nothing or against a stale picture
    expect(r.refs).toHaveLength(4); // per axis: the reference, and once more
    expect(r.saved).toHaveLength(1);
    // the user's answers; what could not be measured stays as it was (not 1.6)
    expect(r.saved[0]).toMatchObject({ invertPan: true, invertTilt: true, viewUnitsX: CURRENT.viewUnitsX, viewUnitsY: CURRENT.viewUnitsY, minStep: CURRENT.minStep });
    expect(r.net().x).toBeCloseTo(0);
    expect(r.net().y).toBeCloseTo(0);
    expect(r.log.some((l) => /no reference picture yet \(The camera picture did not arrive in time\.\); asking again/.test(l))).toBe(true);
  });

  it('a measurement of a picture from before the move ended, or without stamps (an older worker), is not used', async () => {
    for (const stale of [{ at: -1 }, { at: undefined, refAt: undefined }]) {
      let refAt = 0;
      const r = rig({ ...C211, vision: (cam) => ({
        ref: async (q) => {
          refAt = q.after + 1;
          return { ok: true, at: refAt };
        },
        measure: async () => ({ ...cam.sceneOf(cam.last), score: 0.9, refAt, ...stale }),
      }) });
      r.wiz.start();
      expect(await r.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.lagging });
      expect(r.measures).toHaveLength(1);
      const st = await r.settle(truthful);
      expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, viewUnitsX: CURRENT.viewUnitsX });
      expect(r.log.some((l) => /NOT USED/.test(l))).toBe(true);
    }
  });

  it('a measurement against another reference than the one confirmed before the move (a late reference) is not used', async () => {
    const r = rig({ ...C211, vision: (cam) => ({
      ref: async (q) => ({ ok: true, at: q.after + 1 }),
      measure: async (m) => ({ ...cam.sceneOf(cam.last), score: 0.9, at: m.after + 1, refAt: m.after + 0.5 }),
    }) });
    r.wiz.start();
    expect((await r.finished()).step).toBe('ask');
    expect(r.log.some((l) => /measured against another reference picture/.test(l))).toBe(true);
  });

  it('no reference picture: asked for once more; then it asks the user, with the camera turned, and measures nothing', async () => {
    const r = rig({ ...C211, vision: () => ({
      ref: async () => ({ ok: false, reason: 'no picture arrived after the camera\'s last move' }),
      measure: async () => { throw new Error('must not measure'); },
    }) });
    r.wiz.start();
    const st = await r.finished();
    expect(st).toMatchObject({ step: 'ask', answers: ['left', 'right', 'none'] });
    expect(r.refs).toHaveLength(2);
    expect(r.moves).toEqual([[0.2, 0]]);
    r.wiz.answer('none');
    const end = await r.settle(truthful);
    expect(end.step).toBe('failed');
    expect(r.saved).toEqual([]);
    expect(r.measures).toEqual([]);
    expect(r.net().x).toBeCloseTo(0);
  });

  it('a reference that comes on the second request is used', async () => {
    let n = 0;
    let refAt = 0;
    const r = rig({ ...C211, vision: (cam) => ({
      ref: async (q) => {
        n++;
        if (n === 1) return { ok: false, reason: 'The camera picture did not arrive in time.' };
        refAt = q.after + 1;
        return { ok: true, at: refAt };
      },
      measure: async (m) => ({ ...cam.sceneOf(cam.last), score: 0.9, at: m.after + 1, refAt }),
    }) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: 0.05 });
    expect(st.result.viewUnitsX).toBeCloseTo(0.8);
    expect(st.result.viewUnitsY).toBeCloseTo(1.2);
  });
});

describe('CalibrationWizard: every axis is measured both ways', () => {
  it('measures the way back against a new reference at the turned position', async () => {
    const r = rig({ ...C211 });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    // pan +0.2, back; tilt +0.2, back; min step: 0.02 (below the firmware's minimum), 0.05 and back
    expect(r.moves).toEqual([[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2], [0.02, 0], [-0.02, 0], [0.05, 0], [-0.05, 0]]);
    expect(r.refs).toHaveLength(7);
    expect(r.measures).toHaveLength(7);
    // each measurement is gated on the end of the move it measures
    for (let i = 1; i < r.measures.length; i++) expect(r.measures[i].after).toBeGreaterThan(r.measures[i - 1].after);
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: 0.05 });
  });

  it('the way back disagreeing (same sign, or far off in size) → measured once more, then asked with the camera turned', async () => {
    // the picture keeps drifting the same way, or the way back is 3.6× / 0.2× the way there
    for (const back of [{ dx: -0.25 }, { dx: 0.9 }, { dx: 0.05 }]) {
      const there = { dx: -0.25, dy: 0, score: 0.9 };
      const r = rig({ ...C211, overrides: [there, { dy: 0, score: 0.9, ...back }, there, { dy: 0, score: 0.9, ...back }] });
      r.wiz.start();
      const st = await r.finished();
      expect(st).toMatchObject({ step: 'ask', answers: ['left', 'right', 'none'], note: ASK_NOTES.disagree });
      expect(r.moves).toEqual([[0.2, 0], [-0.2, 0], [0.2, 0], [-0.2, 0], [0.2, 0]]);
      expect(r.net().x).toBeCloseTo(0.2);
      expect(r.log.filter((l) => /the way back did not confirm the way there/.test(l))).toHaveLength(2);
      const end = await r.settle(truthful);
      expect(end.step).toBe('done');
      expect(end.result).toMatchObject({ invertPan: true, viewUnitsX: CURRENT.viewUnitsX }); // the answer, not the measurement
      expect(r.net().x).toBeCloseTo(0);
    }
  });

  it('a one-off disagreement: the second round is used', async () => {
    const r = rig({ ...C211, overrides: [{ dx: 0.25, dy: 0, score: 0.9 }, { dx: 0.24, dy: 0, score: 0.9 }] });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result.invertPan).toBe(true);
    expect(st.result.viewUnitsX).toBeCloseTo(0.8);
  });

  it('the way there and back average into the view units', async () => {
    const r = rig({ ...C211, overrides: [{ dx: 0.2, dy: 0, score: 0.9 }, { dx: -0.3, dy: 0, score: 0.9 }] });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result.viewUnitsX).toBeCloseTo(0.2 / 0.25);
  });
});

describe('CalibrationWizard: the min-step probe', () => {
  /** pan and tilt measured as the truth, then the probe's answers */
  const probe = (answers) => [
    ...[[0.25, 0], [-0.25, 0], [0, 0.1667], [0, -0.1667]].map(([dx, dy]) => ({ dx, dy, score: 0.9 })),
    ...answers.map((a) => ({ dy: 0, score: 0.9, ...a })),
  ];

  it('a step whose way back does not confirm it is tried once more, then the next one', async () => {
    // 0.02: a glitch shows motion there, but nothing comes back (twice); 0.05: there and back
    const r = rig({ ...C211, overrides: probe([{ dx: 0.03 }, { dx: 0 }, { dx: 0.03 }, { dx: 0.001 }, { dx: 0.062 }, { dx: -0.06 }]) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result.minStep).toBe(0.05);
    expect(r.log.filter((l) => /min step 0\.02 was not confirmed/.test(l))).toHaveLength(2);
    expect(r.net().x).toBeCloseTo(0);
  });

  it('a step that moved the picture the other way than the pan did is not taken', async () => {
    const r = rig({ ...C211, overrides: probe([{ dx: -0.03 }, { dx: 0.03 }, { dx: -0.03 }, { dx: 0.03 }, { dx: 0.062 }, { dx: -0.06 }]) });
    r.wiz.start();
    expect((await r.finished()).result.minStep).toBe(0.05);
  });

  it('no reference picture for the probe: minStep stays as it was', async () => {
    let n = 0;
    let refAt = 0;
    const r = rig({ ...C211, vision: (cam) => ({
      ref: async (q) => {
        if (++n > 4) return { ok: false, reason: 'no picture arrived after the camera\'s last move' };
        refAt = q.after + 1;
        return { ok: true, at: refAt };
      },
      measure: async (m) => ({ ...cam.sceneOf(cam.last), score: 0.9, at: m.after + 1, refAt }),
    }) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: CURRENT.minStep });
    expect(r.net().x).toBeCloseTo(0);
  });
});

describe('CalibrationWizard: msPerUnit', () => {
  it('a picture that settles much later than the camera stopped (a stalled worker) does not stretch msPerUnit', async () => {
    const r = rig({ overrides: [{ dx: -0.16, dy: 0, score: 0.9, settledMs: 16_000 }] });
    r.wiz.request({ action: 'start' });
    const st = await r.finished();
    expect(st.step).toBe('done');
    // the camera's own 1200 ms per 0.2 units (the picture's 16 s are its lag, not the motor's)
    expect(st.result.msPerUnit).toBe(Math.round(1200 / 0.2));
  });
});

describe('CalibrationWizard: video lag', () => {
  it('tells the picture to wait for a move the camera reported (a real camera\'s video lags the motor)', async () => {
    const r = rig({ reportsMoves: true });
    r.wiz.request({ action: 'start' });
    expect((await r.finished()).step).toBe('done');
    expect(r.measures.length).toBeGreaterThan(2);
    // the first pan and tilt measures follow a move the camera reported
    // (updated on purpose: every measurement now also names when the move ended, `after`)
    expect(r.measures[0]).toEqual({ timeoutMs: 6000, expectMove: true, after: expect.any(Number) });
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
    // updated on purpose: msPerUnit is the camera's reported travel time (1200 ms), not the
    // picture's settle time (1500 ms), which includes the video's lag
    expect(st.result.msPerUnit).toBe(Math.round(1200 / 0.2));
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
    expect(st.note).toBe(ASK_NOTES.plain);
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
