// Motion primitives (src/avatar/motion.js) and the eye controller (src/avatar/eyes.js): the
// properties the director's smoothness rests on — continuous velocity, frame-rate independence,
// main-sequence saccades, head-eye coordination without overshoot.
import { describe, expect, it } from 'vitest';
import {
  OneEuro, Spring, envelope, logNormal, minJerk, pinkNoise, pulse, spring2Step, springStep,
} from '../../../src/avatar/motion.js';
import { EyeController, GAZE_DEG, saccadeDuration, saccadePeakVelocity } from '../../../src/avatar/eyes.js';
import { mulberry32 } from '../../../src/avatar/noise.js';

/** Largest one-frame velocity change as a fraction of the peak velocity (1 = starts at full speed). */
function stepRatio(xs, dt) {
  const v = [];
  for (let i = 1; i < xs.length; i++) v.push((xs[i] - xs[i - 1]) / dt);
  let step = 0;
  for (let i = 1; i < v.length; i++) step = Math.max(step, Math.abs(v[i] - v[i - 1]));
  return step / Math.max(...v.map(Math.abs));
}

describe('springs', () => {
  it('critically damped: starts from rest (no velocity step), never overshoots, t90 ~ 3.9 / omega', () => {
    const dt = 1 / 60;
    const s = new Spring();
    const xs = [0];
    let t90 = NaN;
    for (let i = 1; i < 120; i++) {
      xs.push(s.step(1, 20, dt));
      if (!Number.isFinite(t90) && s.x >= 0.9) t90 = i * dt;
    }
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
    expect(t90).toBeGreaterThan(3.89 / 20 - dt);
    expect(t90).toBeLessThan(3.89 / 20 + dt);
    // a one-pole lag would put ~100 % of its peak speed into the first frame
    expect(stepRatio(xs, dt)).toBeLessThan(0.75);
  });

  it('is exact for any step size: 60 Hz, 144 Hz and one big step land on the same curve', () => {
    const run = (fps, T = 0.5) => {
      const s = { x: 0, v: 0 };
      for (let i = 0; i < Math.round(T * fps); i++) springStep(s, 1, 30, 1 / fps);
      return s;
    };
    const a = run(60), b = run(144), one = { x: 0, v: 0 };
    springStep(one, 1, 30, 0.5);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.x).toBeCloseTo(one.x, 9);
    expect(a.v).toBeCloseTo(one.v, 6);
    // dt = 0 changes nothing
    const z = { x: 0.3, v: 2 };
    springStep(z, 1, 30, 0);
    expect(z).toEqual({ x: 0.3, v: 2 });
  });

  it('under-damped: a slight rebound, exact at any step size', () => {
    const run = (fps) => {
      const s = { x: 1, v: 0 };
      let min = 1;
      for (let i = 0; i < fps; i++) { spring2Step(s, 0, 12, 0.6, 1 / fps); min = Math.min(min, s.x); }
      return { s, min };
    };
    const a = run(60), b = run(144);
    expect(a.min).toBeLessThan(-0.02); // rebound
    expect(a.min).toBeGreaterThan(-0.2);
    expect(a.s.x).toBeCloseTo(b.s.x, 6);
  });
});

describe('kernels', () => {
  it('minimum jerk and the pulse start, peak and end at rest', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 9);
    const v = (f, x, h = 1e-5) => (f(x + h) - f(x - h)) / (2 * h);
    const p = (x) => pulse(x, 0.16, 0.3);
    expect(Math.abs(v(p, 1e-5))).toBeLessThan(1e-3);
    expect(Math.abs(v(p, 0.16))).toBeLessThan(1e-3);
    expect(p(0.16)).toBeCloseTo(1, 9);
    expect(p(0.46)).toBe(0);
    expect(Math.abs(v(p, 0.46 - 2e-5))).toBeLessThan(1e-2);
    const e = (x) => envelope(x, 0.1, 0.2, 0.3);
    expect(e(0.05)).toBeCloseTo(0.5, 9);
    expect(e(0.2)).toBe(1);
    expect(e(0.6)).toBe(0);
  });

  it('a nod pulse has no velocity step at 60 Hz (one-frame dv about a third of its peak speed)', () => {
    const dt = 1 / 60;
    const xs = [];
    for (let t = 0; t < 1; t += dt) xs.push(pulse(t - 0.2 - 0.004, 0.17, 0.31));
    expect(stepRatio(xs, dt)).toBeLessThan(0.4);
  });
});

describe('OneEuro', () => {
  it('a still noisy signal stays still; a step is followed within a frame or two', () => {
    const rng = mulberry32(5);
    const f = new OneEuro(0.5, 8, 1);
    const out = [];
    for (let k = 0; k < 120; k++) out.push(f.filter(0.002 * (rng() * 2 - 1), k / 12));
    const sd = Math.sqrt(out.slice(20).reduce((s, x) => s + x * x, 0) / 100);
    expect(sd).toBeLessThan(0.0006); // input sd 0.0012
    f.filter(0.5, 121 / 12);
    const second = f.filter(0.5, 122 / 12);
    expect(second).toBeGreaterThan(0.45);
  });
});

describe('pinkNoise', () => {
  it('is smooth, deterministic per seed, never repeats, and is not zero on a lattice', () => {
    expect(pinkNoise(3.7, 11)).toBe(pinkNoise(3.7, 11));
    expect(pinkNoise(3.7, 11)).not.toBe(pinkNoise(3.7, 12));
    // no zeros at integer times (plain gradient noise is 0 at every lattice point)
    let zeros = 0;
    for (let k = 0; k < 200; k++) if (Math.abs(pinkNoise(k / 0.07, 3)) < 1e-6) zeros++;
    expect(zeros).toBe(0);
    // its autocorrelation has no strong period
    const dt = 1 / 10;
    const x = Array.from({ length: 3000 }, (_, i) => pinkNoise(i * dt, 3));
    const m = x.reduce((a, b) => a + b, 0) / x.length;
    const v = x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length;
    let best = 0;
    for (let lag = 50; lag < 1500; lag += 5) {
      let c = 0;
      for (let i = 0; i + lag < x.length; i++) c += (x[i] - m) * (x[i + lag] - m);
      best = Math.max(best, c / (x.length - lag) / v);
    }
    expect(best).toBeLessThan(0.6);
  });

  it('has unit rms for any octave count (the sway amplitudes are rms values)', () => {
    const rms = (o) => {
      let s = 0, n = 0;
      for (let seed = 1; seed <= 5; seed++) {
        for (let t = 0; t < 3000; t += 0.1) { const v = pinkNoise(t, seed, o); s += v * v; n++; }
      }
      return Math.sqrt(s / n);
    };
    for (const o of [{}, { f0: 0.1 }, { f0: 0.6, octaves: 2 }, { octaves: 1, f0: 1 }]) {
      expect(rms(o)).toBeGreaterThan(0.9);
      expect(rms(o)).toBeLessThan(1.1);
    }
  });

  it('log-normal draws: median and spread, clamped', () => {
    const rng = mulberry32(9);
    const d = Array.from({ length: 2000 }, () => logNormal(rng, 2.8, 0.6, 0.8, 12)).sort((a, b) => a - b);
    expect(d[1000]).toBeGreaterThan(2.5);
    expect(d[1000]).toBeLessThan(3.1);
    expect(d[0]).toBeGreaterThanOrEqual(0.8);
    expect(d[1999]).toBeLessThanOrEqual(12);
  });
});

describe('EyeController', () => {
  /** Run the controller toward a target; returns per-frame samples. */
  function drive(c, target, seconds, o = {}, fps = 60, t0 = 0) {
    const dt = 1 / fps;
    const rec = [];
    for (let i = 1; i <= Math.round(seconds * fps); i++) {
      const t = t0 + i * dt;
      const tg = typeof target === 'function' ? target(t) : target;
      c.update(dt, t, { reactive: false, now: i === 1 && !o.reactive, headShare: 0.25, ...o, ...tg });
      rec.push({ t, x: c.x, y: c.y, hx: c.hx.x, sac: c.saccading });
    }
    return rec;
  }

  it('makes main-sequence saccades: a 10 deg shift in ~43 ms, the peak speed mid-way', () => {
    expect(saccadeDuration(2) * 1000).toBeCloseTo(25.4, 1);
    expect(saccadeDuration(15) * 1000).toBeCloseTo(54, 1);
    expect(saccadePeakVelocity(10)).toBeGreaterThan(200);
    const c = new EyeController();
    const rec = drive(c, { x: 10, y: 0 }, 0.3, {}, 1000);
    const t10 = rec.find((r) => r.x >= 1).t, t90 = rec.find((r) => r.x >= 9).t;
    expect((t90 - t10) * 1000).toBeLessThan(35);
    expect(rec.at(-1).x).toBeCloseTo(10, 6); // lands on the target, no glide
    let vpk = 0, tpk = 0;
    for (let i = 1; i < rec.length; i++) {
      const v = (rec[i].x - rec[i - 1].x) * 1000;
      if (v > vpk) { vpk = v; tpk = rec[i].t; }
    }
    expect(tpk).toBeGreaterThan(0.015);
    expect(tpk).toBeLessThan(0.03);
  });

  it('reacts to a followed target after a reaction time; holds still on a still target', () => {
    const c = new EyeController();
    const rec = drive(c, { x: 6, y: 0 }, 0.6, { reactive: true });
    const start = rec.find((r) => r.x > 0.1).t;
    expect(start).toBeGreaterThan(0.15);
    expect(start).toBeLessThan(0.22);
    // fixation: no drifting once there
    const tail = rec.filter((r) => r.t > 0.35);
    expect(Math.max(...tail.map((r) => r.x)) - Math.min(...tail.map((r) => r.x))).toBeLessThan(1e-9);
  });

  it('pursues a moving target smoothly, with catch-up saccades when it gets away', () => {
    const c = new EyeController();
    // 12 deg/s sweep (as pursuit sees it ~100 ms late)
    const rec = drive(c, (t) => ({ x: 12 * t, y: 0, vx: t > 0.1 ? 12 : 0, vy: 0 }), 3, { reactive: true });
    const late = rec.filter((r) => r.t > 1.5);
    const err = late.map((r) => Math.abs(12 * r.t - r.x));
    expect(Math.max(...err)).toBeLessThan(2);
    // mostly smooth: few saccades
    let sacs = 0;
    for (let i = 1; i < late.length; i++) if (late[i].sac && !late[i - 1].sac) sacs++;
    expect(sacs).toBeLessThan(5);
  });

  it('the head takes a share of a large shift late and slowly; small shifts move it little', () => {
    const c = new EyeController();
    const rec = drive(c, { x: 20, y: 0 }, 1.5);
    const eyeDone = rec.find((r) => r.x >= 19).t;
    const headHalf = rec.find((r) => r.hx >= 0.5 * rec.at(-1).hx).t;
    expect(headHalf - eyeDone).toBeGreaterThan(0.05); // the head arrives well after the eyes
    expect(rec.at(-1).hx).toBeGreaterThan(3);
    expect(rec.at(-1).hx).toBeLessThan(8);
    // the head's velocity starts at zero (it is a spring)
    const hv = rec.map((r, i) => (i ? (r.hx - rec[i - 1].hx) * 60 : 0));
    const first = hv.findIndex((v) => v > 0.01);
    expect(hv[first]).toBeLessThan(0.5 * Math.max(...hv));
    const s = new EyeController();
    const r2 = drive(s, { x: 4, y: 0 }, 0.5);
    expect(r2.at(-1).hx).toBeLessThan(0.6);
  });

  it('GAZE_DEG maps gaze units to degrees of eye rotation (relief iris travel, procedural eyeballs)', () => {
    expect(GAZE_DEG.x).toBeCloseTo(17.2, 1);
    expect(GAZE_DEG.y).toBeCloseTo(12.8, 1);
  });
});
