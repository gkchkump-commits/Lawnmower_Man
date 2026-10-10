import { describe, it, expect } from 'vitest';
import { ASK_NOTES, CalibrationWizard, MIN_STEPS } from '../../../electron/tapo/calibration.js';

const CURRENT = { invertPan: false, invertTilt: false, viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, msPerUnit: 6000 };

/**
 * A scripted camera: the scene shift for a raw move (x, y) = -(x, y) × gain (mirrored axes flip
 * the sign); `score` and an `overrides` queue for special answers. Its pictures are current: the
 * reference and every measurement name frames that arrived after the move (`at` later than the
 * request's `after`), and a measurement names the reference it used. (Updated on purpose for the
 * gated protocol: before, the fake answered without stamps, which the wizard no longer trusts;
 * and again for the second round of it: a reference says it was still and how far it is from
 * the frame the last measurement ended on (`vsLast`), a measurement whether the picture moved and
 * settled, and when it first changed. A camera window that does not say so is not trusted.)
 * `vision` replaces the picture side: (camera) => ({ ref, measure }); `worker(camera)` is the
 * default one, for visions that change only part of it.
 */
function rig(o = {}) {
  const moves = [];
  const gainX = o.gainX ?? 0.8; // view fractions per unit (viewUnitsX = 1 / gainX)
  const gainY = o.gainY ?? 0.7;
  const mirrorPan = !!o.mirrorPan;
  const invertTilt = !!o.invertTilt;
  const minEffective = o.minEffective ?? 0.04;
  let last = { x: 0, y: 0 };
  const pos = { x: o.x0 ?? 0, y: o.y0 ?? 0 };
  const start = { ...pos };
  const overrides = [...(o.overrides || [])];
  const saved = [];
  const states = [];
  const measures = [];
  const refs = [];
  const log = [];
  let tick = 1000;
  /** the scene shift of a raw camera move: turning right (+x) moves the scene left (−dx), tilting up (+y) moves it down (+dy) */
  const sceneOf = (m) => ({ dx: -m.x * gainX * (mirrorPan ? -1 : 1), dy: m.y * gainY * (invertTilt ? -1 : 1) });
  /** the scene shift between two positions of the camera */
  const between = (a, b) => sceneOf({ x: b.x - a.x, y: b.y - a.y });
  /** where the camera has been: after each move, oldest first */
  const history = [{ ...pos }];
  const camera = { get last() { return last; }, pos, history, sceneOf, between };
  const contrast = o.contrast ?? 40;
  /** the camera window's worker, current and truthful (pipeline.js's answers) */
  const worker = (cam = camera, w = {}) => {
    let refAt = null;
    let refPos = { ...cam.pos };
    let lastAt = null;
    let lastPos = null;
    return {
      ref: async (q) => {
        refAt = q.after + 1;
        refPos = { ...cam.pos };
        const vsLast = lastAt === null ? {} : { vsLast: { at: lastAt, ...between(lastPos, cam.pos), score: 0.95 } };
        return { ok: true, at: refAt, still: true, contrast, ...vsLast };
      },
      measure: async (m) => {
        const at = m.after + 1;
        lastAt = at;
        lastPos = { ...cam.pos };
        const truth = between(refPos, cam.pos);
        const r = { ...truth, score: o.score ?? 0.6, settledMs: 1500, ...(overrides.length ? overrides.shift() : {}), ...(w.measure ? w.measure(m) : {}) };
        const moved = r.moved ?? (Math.abs(r.dx) >= 0.005 || Math.abs(r.dy) >= 0.005);
        return { at, refAt, frames: 5, firstAt: at, settled: true, contrast, ...(moved ? { changedAt: at } : {}), ...r, moved };
      },
    };
  };
  const vision = o.vision ? o.vision(camera, worker) : worker();
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
    delay: async (ms) => { tick += ms; },
    now: () => Date.parse('2026-10-10T12:00:00Z'),
  });
  wiz.on('state', (s) => states.push(s));
  const finished = () => new Promise((resolve) => {
    const check = () => (['done', 'failed', 'idle', 'ask'].includes(wiz.state.step) && !(wiz.state.step === 'idle' && wiz.running) ? resolve(wiz.state) : setTimeout(check, 1));
    check();
  });
  /**
   * Where the camera is, relative to where it started (updated on purpose: this used to add up
   * the commands, but a move the camera reports as not made is no longer undone)
   */
  const net = () => ({ x: pos.x - start.x, y: pos.y - start.y });
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
  return { wiz, moves, saved, states, finished, settle, net, measures, refs, log, camera };
}

/** The truth for the C211 (mirrored pan, inverted tilt): what a user sees when asked about a + move. */
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
      return { ...cam.sceneOf({ x: p.x - refPos.x, y: p.y - refPos.y }), score: 0.95, settledMs: 6170, at: (m?.after ?? 0) - 5, refAt: -1, moved: true, settled: true };
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
      const r = rig({ ...C211, vision: (cam, worker) => worker(cam, { measure: () => stale }) });
      r.wiz.start();
      expect(await r.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.lagging });
      expect(r.measures).toHaveLength(1);
      const st = await r.settle(truthful);
      expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, viewUnitsX: CURRENT.viewUnitsX });
      expect(r.measures).toHaveLength(1); // nothing more is measured once a picture was not current
      expect(r.log.some((l) => /NOT USED/.test(l))).toBe(true);
    }
  });

  it('a measurement against another reference than the one confirmed before the move (a late reference) is not used', async () => {
    const r = rig({ ...C211, vision: (cam, worker) => worker(cam, { measure: (m) => ({ refAt: m.after + 0.5 }) }) });
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

  it('no live stream at all (the reference request throws) fails with that message, nothing moved', async () => {
    const r = rig({ ...C211, vision: () => ({
      ref: async () => { throw new Error('No live picture, so the camera cannot be calibrated.'); },
      measure: async () => { throw new Error('must not measure'); },
    }) });
    r.wiz.start();
    const st = await r.finished();
    expect(st).toMatchObject({ step: 'failed', error: 'No live picture, so the camera cannot be calibrated.' });
    expect(r.moves).toEqual([]);
    expect(r.saved).toEqual([]);
  });

  it('a reference that comes on the second request is used', async () => {
    let n = 0;
    const r = rig({ ...C211, vision: (cam, worker) => {
      const w = worker(cam);
      return { ...w, ref: async (q) => (++n === 1 ? { ok: false, reason: 'The camera picture did not arrive in time.' } : w.ref(q)) };
    } });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: 0.05 });
    expect(st.result.viewUnitsX).toBeCloseTo(0.8);
    expect(st.result.viewUnitsY).toBeCloseTo(1.2);
  });

  it('a gated answer without `settled` or `still` (a camera window that does not say the picture caught up) is not used', async () => {
    const unsettled = rig({ ...C211, vision: (cam, worker) => worker(cam, { measure: () => ({ settled: undefined }) }) });
    unsettled.wiz.start();
    expect(await unsettled.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.unsettled });
    const notStill = rig({ ...C211, vision: (cam, worker) => {
      const w = worker(cam);
      return { ...w, ref: async (q) => ({ ...(await w.ref(q)), still: undefined }) };
    } });
    notStill.wiz.start();
    expect(await notStill.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.unsettled });
    expect(notStill.measures).toEqual([]);
  });
});

/**
 * A C211 on a virtual clock whose video lags the motor by `lagMs` BEFORE it reaches main (the
 * camera, Wi-Fi, go2rtc on a busy PC): every frame reaches main after the move ended, so the
 * arrival gate passes it, but it shows where the lens pointed `lagMs` earlier. The worker follows
 * pipeline.js: a reference is a frame that stood still for 2 comparisons (or the newest after
 * 4 s, not still); a measurement waits for the picture to move (when the camera reported the
 * move, or cannot report) and stand still, or answers at its timeout (settled only when still);
 * `changedAt` is the first frame that differed; `vsLast` compares a reference with the frame the
 * last measurement ended on. The motor: mirrored pan 0.35 units/s, inverted tilt 0.25, end stops
 * at ±1 (or `yMax`), minimum step 0.05; with GetStatus the move ends on MoveStatus IDLE (polled
 * every 300 ms) and reports its travel (`runaway`: it travels that many times the command);
 * without, it ends with the app's timed Stop (1.5 s + units × msPerUnit).
 * (The old wizard stored invertPan or invertTilt false with 7–8 s of lag and GetStatus, and wrong
 * signs or view units twice the truth with 3–7 s without GetStatus.)
 */
function laggingCamera(lagMs, o = {}) {
  const TRUTH = { viewUnitsX: 0.8, viewUnitsY: 1.2 };
  const FRAME = 1000 / 15;
  const yMax = o.yMax ?? 1;
  let T = 0;
  /** motor segments: from t0 to t1 the lens goes from → to */
  const segs = [{ t0: -1e9, t1: -1e9, from: { x: o.x0 ?? 0, y: o.y0 ?? 0 }, to: { x: o.x0 ?? 0, y: o.y0 ?? 0 } }];
  const lens = (t) => {
    let s = segs[0];
    for (const g of segs) if (g.t0 <= t) s = g;
    if (t >= s.t1) return { ...s.to };
    const k = (t - s.t0) / (s.t1 - s.t0);
    return { x: s.from.x + (s.to.x - s.from.x) * k, y: s.from.y + (s.to.y - s.from.y) * k };
  };
  const picture = (t) => lens(t - lagMs);
  const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  // the C211: raw +x turns the lens left, so the scene moves right (+dx); raw +y tilts it down, the scene moves up (−dy)
  const shift = (a, b) => {
    const dx = (b.x - a.x) / TRUTH.viewUnitsX;
    const dy = -(b.y - a.y) / TRUTH.viewUnitsY;
    return { dx, dy, score: Math.abs(dx) <= 0.45 && Math.abs(dy) <= 0.39 ? 0.95 : 0.05 };
  };
  const frameAfter = (t) => Math.floor(t / FRAME) * FRAME + FRAME;
  let ref = null;
  let last = null;
  let lastMove = { x: 0, y: 0 };
  const start = lens(0);
  const saved = [];
  const log = [];
  const asked = [];
  const wiz = new CalibrationWizard({
    ptz: {
      rawMove: async (x, y) => {
        if (!o.noStatus) T += 40; // the GetStatus before the move
        const p0 = lens(T);
        const k = o.runaway ?? 1;
        const to = {
          x: Math.max(-1, Math.min(1, p0.x + (Math.abs(x) >= 0.05 ? x * k : 0))),
          y: Math.max(-1, Math.min(yMax, p0.y + (Math.abs(y) >= 0.05 ? y * k : 0))),
        };
        const dur = Math.max(Math.abs(to.x - p0.x) / 0.35, Math.abs(to.y - p0.y) / 0.25) * 1000;
        segs.push({ t0: T, t1: T + dur, from: p0, to });
        lastMove = { x, y };
        if (o.noStatus) {
          const ms = 1500 + Math.max(Math.abs(x), Math.abs(y)) * 6000;
          T += ms;
          return { settledMs: ms, measured: false };
        }
        const ms = (Math.floor(dur / 300) + 1) * 300 + 40;
        T += ms;
        const travel = { x: to.x - p0.x, y: to.y - p0.y };
        return { settledMs: ms, measured: true, moved: Math.max(Math.abs(travel.x), Math.abs(travel.y)) > 0.005, travel };
      },
      stopAll: async () => {},
      ...(o.noStatus ? {} : { position: async () => lens(T) }),
    },
    vision: {
      ref: async ({ after }) => {
        T += 300; // main waits for the live stream, then 300 ms
        const t0 = frameAfter(Math.max(after, T));
        let t = t0;
        let prev = null;
        let stable = 0;
        let p;
        for (;;) {
          p = picture(t);
          stable = prev && same(prev, p) ? stable + 1 : 0;
          prev = p;
          if (stable >= 2 || t - t0 >= 4000) break;
          t += FRAME;
        }
        T = t;
        ref = { pos: p, at: t };
        return { ok: true, at: t, still: stable >= 2, contrast: 40, ...(last ? { vsLast: { at: last.at, ...shift(last.pos, p) } } : {}) };
      },
      measure: async ({ after, expectMove, timeoutMs }) => {
        const t0 = frameAfter(Math.max(after, T));
        const req = T;
        let t = t0;
        let prev = null;
        let stable = 0;
        let moved = false;
        let changedAt;
        let settled = false;
        let frames = 0;
        let p;
        for (;;) {
          p = picture(t);
          frames++;
          if (!moved && ((prev && !same(prev, p)) || !same(ref.pos, p))) {
            moved = true;
            changedAt = t;
          }
          stable = prev && same(prev, p) ? stable + 1 : 0;
          prev = p;
          if (stable >= 2 && (moved || (!expectMove && t - t0 >= 1500))) {
            settled = true;
            break;
          }
          if (t - req >= timeoutMs) {
            settled = stable >= 2;
            break;
          }
          t += FRAME;
        }
        T = t;
        last = { pos: p, at: t };
        return { ...shift(ref.pos, p), settledMs: Math.round(t - req), at: t, refAt: ref.at, moved, settled, frames, firstAt: t0, ...(moved ? { changedAt } : {}), contrast: 40 };
      },
    },
    clock: () => T,
    log: (level, msg) => log.push(msg),
    canStart: () => null,
    current: () => ({ ...CURRENT }),
    save: (r) => saved.push(r),
    delay: async (ms) => { T += ms; },
    now: () => Date.parse('2026-10-10T12:00:00Z'),
  });
  /** run to the end, answering as the user watching the camera would (the lens's real turn) */
  const run = async () => {
    wiz.start();
    for (let i = 0; i < 2000; i++) {
      const st = wiz.state;
      if (st.step === 'done' || st.step === 'failed') return st;
      if (st.step === 'ask') {
        // the camera is turned by the move just made: mirrored pan (+x turns it left), inverted tilt (+y turns it down)
        const a = st.answers.includes('left') ? (lastMove.x > 0 ? 'left' : 'right') : (lastMove.y > 0 ? 'down' : 'up');
        asked.push(`${a}: ${st.note}`);
        wiz.answer(a);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    return wiz.state;
  };
  return { wiz, run, saved, log, asked, end: () => lens(T + 1e6), start, TRUTH };
}

/** A stored result is never wrong: the C211's signs, and view units near the truth or as they were. */
function expectNeverWrong(st, cam, what) {
  expect(st.step, what).toBe('done');
  const r = st.result;
  expect(r.invertPan, `${what}: invertPan`).toBe(true);
  expect(r.invertTilt, `${what}: invertTilt`).toBe(true);
  for (const [k, truth] of [['viewUnitsX', cam.TRUTH.viewUnitsX], ['viewUnitsY', cam.TRUTH.viewUnitsY]]) {
    if (r[k] !== CURRENT[k]) expect(Math.abs(r[k] / truth - 1), `${what}: ${k} ${r[k]}`).toBeLessThan(0.1);
  }
  expect([CURRENT.minStep, 0.05], `${what}: minStep`).toContain(r.minStep);
  const end = cam.end();
  expect(Math.abs(end.x - cam.start.x) + Math.abs(end.y - cam.start.y), `${what}: the camera ends where it started`).toBeLessThan(0.01);
}

describe('CalibrationWizard: a video that lags the motor (the arrival gate cannot see it)', () => {
  for (const noStatus of [false, true]) {
    for (const lag of [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000, 12_000, 16_000]) {
      it(`${lag} ms${noStatus ? ', no GetStatus' : ''}: never stores a wrong result`, async () => {
        const cam = laggingCamera(lag, { noStatus });
        const st = await cam.run();
        expectNeverWrong(st, cam, `lag ${lag}${noStatus ? ' (no GetStatus)' : ''}: ${cam.log.join(' | ')}`);
        // a lag the picture can be waited out for is measured without asking
        if (lag <= (noStatus ? 3000 : 4000)) {
          expect(cam.asked, cam.log.join('\n')).toEqual([]);
          expect(st.result.viewUnitsX).not.toBe(CURRENT.viewUnitsX);
        }
      }, 20_000);
    }
  }

  it('7 s with GetStatus (the verifier\'s run that stored invertTilt false): asks, never stores', async () => {
    const cam = laggingCamera(7000);
    const st = await cam.run();
    expectNeverWrong(st, cam, cam.log.join('\n'));
    expect(cam.asked.length).toBeGreaterThan(0);
    expect(cam.asked[0]).toMatch(/running too far behind/);
    expect(st.result).toMatchObject({ viewUnitsX: CURRENT.viewUnitsX, viewUnitsY: CURRENT.viewUnitsY, minStep: CURRENT.minStep });
    // the camera reported the move, the picture did not follow: nothing after it was measured
    expect(cam.log.filter((l) => /calibration (x|y) [+-]/.test(l))).toHaveLength(1);
  });

  for (const lag of [3000, 4000, 5000]) {
    it(`${lag} ms without GetStatus: no "barely moved" before the full wait, so it measures or asks, never stores a wrong result`, async () => {
      const cam = laggingCamera(lag, { noStatus: true });
      const st = await cam.run();
      expectNeverWrong(st, cam, cam.log.join('\n'));
      expect(cam.log.some((l) => /x \+0\.4/.test(l))).toBe(false); // never escalated on a picture that had not caught up
    });
  }
});

describe('CalibrationWizard: end stops and moves that do not travel as commanded', () => {
  for (const x0 of [1, 0.9, 0.85]) {
    it(`started at the pan end stop (x = ${x0}): measured away from it, right units, and the camera ends where it started`, async () => {
      const cam = laggingCamera(0, { x0 });
      const st = await cam.run();
      expectNeverWrong(st, cam, cam.log.join('\n'));
      expect(cam.asked).toEqual([]);
      expect(Math.abs(st.result.viewUnitsX / 0.8 - 1)).toBeLessThan(0.05);
      expect(cam.log.some((l) => /x -0\.2:/.test(l))).toBe(true); // the way with room
    });
  }

  it('a tilt end stop the camera reports (it turned only a quarter): measured the other way', async () => {
    const cam = laggingCamera(0, { y0: 0.25, yMax: 0.3 });
    const st = await cam.run();
    expectNeverWrong(st, cam, cam.log.join('\n'));
    expect(cam.asked).toEqual([]);
    expect(Math.abs(st.result.viewUnitsY / 1.2 - 1)).toBeLessThan(0.05);
    expect(cam.log.some((l) => /y: the camera turned only \+0\.05 of \+0\.2 \(an end stop\); measuring the other way/.test(l))).toBe(true);
  });

  it('a move cut short at the stop (half the command): the view units come from the travel the camera reported', async () => {
    const cam = laggingCamera(0, { y0: 0.1, yMax: 0.2 });
    const st = await cam.run();
    expectNeverWrong(st, cam, cam.log.join('\n'));
    expect(Math.abs(st.result.viewUnitsY / 1.2 - 1)).toBeLessThan(0.05);
  });

  for (const runaway of [1.6, 2, 2.5]) {
    it(`a RelativeMove that travels ${runaway}× the command (it runs on until the watchdog stops it): never wrong units`, async () => {
      const cam = laggingCamera(0, { runaway });
      const st = await cam.run();
      expectNeverWrong(st, cam, cam.log.join('\n'));
      if (runaway === 1.6) expect(Math.abs(st.result.viewUnitsX / 0.8 - 1)).toBeLessThan(0.05); // from the reported travel
    });
  }
});

describe('CalibrationWizard: every axis is measured both ways', () => {
  it('measures the way back against a new reference at the turned position', async () => {
    const r = rig({ ...C211 });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    // pan +0.2, back; tilt +0.2, back; min step: 0.02 (below the firmware's minimum: the camera
    // reports no move, so there is nothing to undo; updated on purpose, it used to send -0.02),
    // 0.05 and back
    expect(r.moves).toEqual([[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2], [0.02, 0], [0.05, 0], [-0.05, 0]]);
    expect(r.refs).toHaveLength(7);
    expect(r.measures).toHaveLength(7);
    // each measurement is gated on the end of the move it measures
    for (let i = 1; i < r.measures.length; i++) expect(r.measures[i].after).toBeGreaterThan(r.measures[i - 1].after);
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: 0.05 });
    expect(r.net()).toEqual({ x: 0, y: 0 });
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

  // (updated on purpose: the two used to be averaged within 0.5×–2× of each other; a picture that
  // has not caught up shows less shift, so now the larger one counts, within 0.75×–1.33×)
  it('the view units come from the larger of the two shifts', async () => {
    const r = rig({ ...C211, overrides: [{ dx: 0.22, dy: 0, score: 0.9 }, { dx: -0.25, dy: 0, score: 0.9 }] });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result.viewUnitsX).toBeCloseTo(0.2 / 0.25);
  });

  it('one way half-measured, the other 0.9× (a picture that had not caught up): not taken, even though the signs agree', async () => {
    // pan there 0.5× of the truth, back 0.9×, twice (both were taken, and +43 % stored)
    const half = [{ dx: 0.125, dy: 0 }, { dx: -0.225, dy: 0 }, { dx: 0.125, dy: 0 }, { dx: -0.225, dy: 0 }];
    const r = rig({ ...C211, overrides: half.map((m) => ({ ...m, score: 0.9 })) });
    r.wiz.start();
    const st = await r.settle(truthful);
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: true, viewUnitsX: CURRENT.viewUnitsX });
    expect(r.log.filter((l) => /x: the way back did not confirm the way there/.test(l))).toHaveLength(2);
  });

  it('the reference at the turned position does not show the frame the measurement ended on (the picture was still catching up): it asks, and measures nothing more', async () => {
    let n = 0;
    const r = rig({ ...C211, vision: (cam, worker) => {
      const w = worker(cam);
      return { ...w, ref: async (q) => {
        const a = await w.ref(q);
        // the second reference (at the turned position): the picture moved on after the measurement
        return ++n === 2 ? { ...a, vsLast: { ...a.vsLast, dx: 0.08 } } : a;
      } };
    } });
    r.wiz.start();
    const st = await r.finished();
    expect(st).toMatchObject({ step: 'ask', note: ASK_NOTES.lagging });
    expect(r.net().x).toBeCloseTo(0.2); // asked while turned
    expect(r.log.some((l) => /the picture changed after the measurement ended \(by \+0\.08, \+0/.test(l))).toBe(true);
    const end = await r.settle(truthful);
    expect(end.result).toMatchObject({ invertPan: true, invertTilt: true, viewUnitsX: CURRENT.viewUnitsX, viewUnitsY: CURRENT.viewUnitsY, minStep: CURRENT.minStep });
    expect(r.measures).toHaveLength(1);
    expect(r.net()).toEqual({ x: 0, y: 0 });
  });

  it('a measurement that did not settle (its timeout\'s newest frame) is not used', async () => {
    const r = rig({ ...C211, overrides: [{ dx: 0.25, dy: 0, score: 0.9, settled: false }] });
    r.wiz.start();
    expect(await r.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.unsettled });
  });
});

describe('CalibrationWizard: the min-step probe', () => {
  /** pan and tilt measured as the truth, then the probe's answers */
  const probe = (answers) => [
    ...[[0.25, 0], [-0.25, 0], [0, -0.1667], [0, 0.1667]].map(([dx, dy]) => ({ dx, dy, score: 0.9 })),
    ...answers.map((a) => ({ dy: 0, score: 0.9, ...a })),
  ];
  // (updated on purpose: these two used a camera that reports its moves; one that reports a step
  // as not made while the picture shows motion now stops the probe, see below, so they use one
  // that cannot report)
  const C211_NO_STATUS = { ...C211, reportsMoves: false };

  it('a step whose way back does not confirm it is tried once more, then the next one', async () => {
    // 0.02: a glitch shows motion there, but nothing comes back (twice); 0.05: there and back
    const r = rig({ ...C211_NO_STATUS, overrides: probe([{ dx: 0.03 }, { dx: 0 }, { dx: 0.03 }, { dx: 0.001 }, { dx: 0.062 }, { dx: -0.06 }]) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result.minStep).toBe(0.05);
    expect(r.log.filter((l) => /min step 0\.02 was not confirmed/.test(l))).toHaveLength(2);
    expect(r.net().x).toBeCloseTo(0);
  });

  it('a step that moved the picture the other way than the pan did is not taken', async () => {
    const r = rig({ ...C211_NO_STATUS, overrides: probe([{ dx: -0.03 }, { dx: 0.03 }, { dx: -0.03 }, { dx: 0.03 }, { dx: 0.062 }, { dx: -0.06 }]) });
    r.wiz.start();
    expect((await r.finished()).result.minStep).toBe(0.05);
  });

  it('the camera reports a step as not made, but the picture moved: the probe stops, minStep stays as it was', async () => {
    const r = rig({ ...C211, overrides: probe([{ dx: 0.03 }]) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result.minStep).toBe(CURRENT.minStep);
    expect(r.log.some((l) => /smallest step could not be measured \(the camera reported no move, but the picture moved\)/.test(l))).toBe(true);
  });

  it('no reference picture for the probe: minStep stays as it was', async () => {
    let n = 0;
    const r = rig({ ...C211, vision: (cam, worker) => {
      const w = worker(cam);
      return { ...w, ref: async (q) => (++n > 4 ? { ok: false, reason: 'no picture arrived after the camera\'s last move' } : w.ref(q)) };
    } });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(st.result).toMatchObject({ invertPan: true, invertTilt: true, minStep: CURRENT.minStep });
    expect(r.net().x).toBeCloseTo(0);
  });

  it('every probe measurement stale, or unreadable: minStep stays as it was (it used to become 0.1)', async () => {
    for (const bad of [{ at: -1 }, { score: 0 }]) {
      let n = 0;
      const r = rig({ ...C211, vision: (cam, worker) => worker(cam, { measure: () => (++n > 4 ? bad : {}) }) });
      r.wiz.start();
      const st = await r.finished();
      expect(st.step).toBe('done');
      expect(st.result.minStep).toBe(CURRENT.minStep);
      expect(r.net()).toEqual({ x: 0, y: 0 });
    }
  });

  it('the camera reported a step as made but the picture stood still: not "too small", minStep stays as it was', async () => {
    // a firmware that reports a 0.02 step it did not make visibly (or a picture that runs behind)
    const r = rig({ ...C211, minEffective: 0.01, overrides: probe([{ dx: 0, moved: false }]) });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result.minStep).toBe(CURRENT.minStep);
    expect(r.log.some((l) => /the camera reported the step, but the picture did not follow/.test(l))).toBe(true);
  });

  it('0.1 only when every size reliably did not move', async () => {
    const r = rig({ ...C211, minEffective: 0.15 });
    r.wiz.start();
    const st = await r.finished();
    expect(st.result.minStep).toBe(0.1);
    expect(r.moves.filter(([x]) => MIN_STEPS.includes(x))).toEqual(MIN_STEPS.map((s) => [s, 0]));
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
    // (updated on purpose: every measurement now also names when the move ended, `after`, and
    // carries the calibration's abort signal)
    expect(r.measures[0]).toEqual({ timeoutMs: 6000, expectMove: true, after: expect.any(Number), signal: expect.anything() });
    // the min-step probe's 0.02 is below what this firmware acts on: no move, no waiting
    expect(r.measures.some((m) => m.expectMove === false)).toBe(true);
    const plain = rig();
    plain.wiz.request({ action: 'start' });
    await plain.finished();
    // no GetStatus: nothing says the camera did not move, so every measurement waits the full
    // time for the picture to move (updated on purpose: it used to give up after 1.5 s of a
    // still picture, which on a lagging video made "barely moved" of a move that was coming)
    expect(plain.measures.every((m) => m.expectMove === true)).toBe(true);
  });

  it('a picture that hardly moved after the move is not escalated to 0.4 (it may be running behind): it asks', async () => {
    // (updated on purpose: this used to retry with 0.4, against a reference that could show the
    // first move arriving late)
    const r = rig({ overrides: [{ dx: -0.005, dy: 0, score: 0.6 }] });
    r.wiz.start();
    const st = await r.finished();
    expect(st).toMatchObject({ step: 'ask', note: ASK_NOTES.small });
    expect(r.moves).toEqual([[0.2, 0]]);
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

  // (updated on purpose: a bigger move now follows only a move the camera reported as not made;
  // a picture that barely moved after a move that was made makes it ask, see "video lag")
  it('retries with a bigger move when the camera reports that it did not move (a firmware that ignores 0.2)', async () => {
    const r = rig({ reportsMoves: true, minEffective: 0.3 });
    r.wiz.start();
    const st = await r.finished();
    expect(st.step).toBe('done');
    expect(r.moves.slice(0, 3)).toEqual([[0.2, 0], [0.4, 0], [-0.4, 0]]);
    expect(st.result.viewUnitsX).toBeCloseTo(1 / 0.8);
    expect(r.net()).toEqual({ x: 0, y: 0 });
  });

  it('asks the user when the picture cannot be measured (dark, featureless)', async () => {
    const r = rig({ score: 0.05, contrast: 2 });
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

  it('a picture with contrast that still cannot be matched says so (not "too dark or too plain")', async () => {
    const r = rig({ score: 0.05 });
    r.wiz.start();
    expect(await r.finished()).toMatchObject({ step: 'ask', note: ASK_NOTES.unclear });
  });

  it('the answer is about the move made: measured away from an end stop (−x), "right" means mirrored', async () => {
    const r = rig({ score: 0.05, x0: 0.9, mirrorPan: true });
    const ptz = r.wiz._o.ptz;
    ptz.position = async () => ({ ...r.camera.pos });
    r.wiz.start();
    const st = await r.finished();
    expect(r.moves).toEqual([[-0.2, 0]]);
    expect(st.step).toBe('ask');
    r.wiz.answer('right'); // raw −x turned it right: mirrored
    const end = await r.settle(() => 'up');
    expect(end.result).toMatchObject({ invertPan: true, invertTilt: false });
    expect(r.camera.pos.x).toBeCloseTo(0.9);
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
    // (updated on purpose: 'cancelling' while the camera is turned back, then 'idle')
    expect(r.wiz.request({ action: 'cancel' }).step).toBe('cancelling');
    await new Promise((res) => setTimeout(res, 10));
    expect(r.wiz.state.step).toBe('idle');
    expect(r.wiz.running).toBe(false);
    expect(r.net().x).toBeCloseTo(0);
    expect(r.net().y).toBeCloseTo(0);
    expect(r.saved).toHaveLength(0);
  });

  it('cancel while a picture is awaited: the request is dropped and the camera turned back at once; Start then waits for that', async () => {
    let hold = null;
    let signal = null;
    const r = rig({ ...C211, vision: (cam, worker) => {
      const w = worker(cam);
      return { ...w, measure: (m) => {
        signal = m.signal;
        return new Promise((resolve) => { hold = () => resolve(w.measure(m)); }); // a stalled worker: up to 31 s
      } };
    } });
    r.wiz.start();
    for (let i = 0; i < 100 && !hold; i++) await new Promise((res) => setTimeout(res, 1));
    const stalled = hold;
    expect(r.net().x).toBeCloseTo(0.2); // turned, measuring
    expect(r.wiz.cancel().step).toBe('cancelling');
    expect(signal.aborted).toBe(true); // main drops its pending request
    expect(r.wiz.start().step).toBe('cancelling'); // not silently "idle": it starts once the camera is back
    for (let i = 0; i < 100 && r.moves.length < 2; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.moves.slice(0, 2)).toEqual([[0.2, 0], [-0.2, 0]]); // back without waiting for the picture
    for (let i = 0; i < 100 && r.wiz.state.step !== 'pan'; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.states.map((s) => s.step)).toEqual(expect.arrayContaining(['cancelling', 'idle', 'pan']));
    stalled(); // the stalled answer comes at last: it belongs to the cancelled run, nothing uses it
    r.wiz.cancel();
    for (let i = 0; i < 100 && r.wiz.running; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.saved).toEqual([]);
  });

  it('goes back to the position the camera reported at the start (also when a move was cut short)', async () => {
    const r = rig({ ...C211, score: 0.05 });
    let pos = { x: 0.3, y: -0.1 };
    const ptz = r.wiz._o.ptz;
    const moves = [];
    ptz.position = async () => ({ ...pos });
    ptz.rawMove = async (x, y) => {
      moves.push([x, y]);
      const to = { x: Math.min(0.45, pos.x + x), y: pos.y + y }; // an end stop at 0.45 cuts the pan short
      const travel = { x: to.x - pos.x, y: to.y - pos.y };
      pos = to;
      return { settledMs: 900, measured: true, moved: Math.abs(travel.x) + Math.abs(travel.y) > 0.005, travel };
    };
    r.wiz.start();
    await r.finished();
    r.wiz.cancel();
    for (let i = 0; i < 100 && r.wiz.running; i++) await new Promise((res) => setTimeout(res, 1));
    expect(pos.x).toBeCloseTo(0.3);
    expect(pos.y).toBeCloseTo(-0.1);
  });

  it('refuses to start when PTZ or the stream is not ready', () => {
    const r = rig({ why: 'The live picture is needed for calibration. Wait until the camera is online.' });
    expect(r.wiz.start()).toMatchObject({ step: 'failed', error: /live picture/ });
    expect(r.moves).toEqual([]);
  });
});
