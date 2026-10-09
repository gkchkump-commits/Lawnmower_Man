import { describe, expect, it } from 'vitest';
import {
  ANIM_KEYS, BLINK_CLOSE, BLINK_HOLD, BLINK_TOTAL, Director, STATES, blinkCurve, createAnimState, lipSmooth, worldGaze,
} from '../../../src/avatar/director.js';

/** Run a director at a fixed frame rate, calling `each(t, a)` every frame. */
function run(d, seconds, fps = 60, each = () => {}, t0 = 0) {
  const dt = 1 / fps;
  let t = t0;
  let a;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    t += dt;
    a = d.update(dt, t);
    each(t, a);
  }
  return { t, a };
}

/** Count blink onsets (rising edges through 0.5) of blinkL. */
function countBlinks(d, seconds) {
  let blinks = 0;
  let prev = 0;
  run(d, seconds, 60, (t, a) => {
    if (prev < 0.5 && a.blinkL >= 0.5) blinks++;
    prev = a.blinkL;
  });
  return blinks;
}

describe('createAnimState', () => {
  it('has every contract field, numeric, at rest', () => {
    const a = createAnimState();
    for (const k of ANIM_KEYS) expect(typeof a[k]).toBe('number');
    expect(Object.keys(a).sort()).toEqual([...ANIM_KEYS].sort());
    expect(a.jawOpen).toBe(0);
    expect(a.energy).toBe(0.5);
  });
});

describe('blinkCurve', () => {
  it('closes with the speed peaking late, touches briefly, opens ~2.5x slower and returns to 0', () => {
    expect(blinkCurve(-0.01)).toBe(0);
    expect(blinkCurve(0)).toBe(0);
    expect(blinkCurve(BLINK_CLOSE)).toBeCloseTo(1, 5);
    expect(blinkCurve(BLINK_CLOSE + BLINK_HOLD / 2)).toBe(1);
    expect(blinkCurve(BLINK_TOTAL)).toBe(0);
    const at = (v, from, to, rising) => {
      for (let t = from; t <= to; t += 0.0005) if (rising ? blinkCurve(t) >= v : blinkCurve(t) <= v) return t;
      return NaN;
    };
    // closing: half closed after more than half of the close time (it accelerates)
    expect(at(0.5, 0, BLINK_CLOSE, true)).toBeGreaterThan(0.55 * BLINK_CLOSE);
    const close = at(0.9, 0, BLINK_CLOSE, true) - at(0.1, 0, BLINK_CLOSE, true);
    const o0 = BLINK_CLOSE + BLINK_HOLD;
    const open = at(0.1, o0, BLINK_TOTAL, false) - at(0.9, o0, BLINK_TOTAL, false);
    expect(open / close).toBeGreaterThan(2);
    expect(open / close).toBeLessThan(3.5);
    // closed (>= 90 %) only briefly, as in people (20-50 ms): the glowing eyes barely go dark
    let closed = 0;
    for (let t = 0; t < BLINK_TOTAL; t += 0.0005) if (blinkCurve(t) >= 0.9) closed += 0.0005;
    expect(closed).toBeGreaterThan(0.02);
    expect(closed).toBeLessThan(0.05);
    // smooth: no velocity steps (zero speed at the start, the touch and the end)
    const v = (t) => (blinkCurve(t + 1e-4) - blinkCurve(t - 1e-4)) / 2e-4;
    expect(Math.abs(v(1e-4))).toBeLessThan(0.5);
    expect(Math.abs(v(BLINK_CLOSE - 2e-4))).toBeLessThan(2);
    expect(Math.abs(v(BLINK_TOTAL - 2e-4))).toBeLessThan(0.5);
    // custom phase lengths
    expect(blinkCurve(0.05, { close: 0.05, hold: 0, open: 0.2 })).toBeCloseTo(1, 5);
  });
});

describe('lipSmooth', () => {
  it('attacks faster than it releases', () => {
    const up = lipSmooth(0, 1, 1 / 60, 0.035, 0.085);
    const down = 1 - lipSmooth(1, 0, 1 / 60, 0.035, 0.085);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeGreaterThan(0.3);
    expect(down).toBeGreaterThan(0.1);
  });
  it('is frame-rate independent', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 6; i++) a = lipSmooth(a, 1, 1 / 60, 0.05, 0.1);
    for (let i = 0; i < 3; i++) b = lipSmooth(b, 1, 1 / 30, 0.05, 0.1);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('Director', () => {
  it('is deterministic for a seed', () => {
    const trace = (seed) => {
      const d = new Director({ seed });
      const out = [];
      run(d, 8, 60, (t, a) => out.push(a.blinkL, a.gazeX, a.headYaw));
      return out;
    };
    expect(trace(7)).toEqual(trace(7));
    expect(trace(7)).not.toEqual(trace(8));
  });

  it('reuses one AnimState object (no per-frame allocation)', () => {
    const d = new Director();
    const a1 = d.update(1 / 60, 1 / 60);
    const a2 = d.update(1 / 60, 2 / 60);
    expect(a1).toBe(a2);
  });

  it('blinks every 2-6 s on average with occasional doubles', () => {
    const d = new Director({ seed: 3 });
    const n = countBlinks(d, 120);
    // 120 s / (2..6 s) -> 20..60 blinks (+ doubles)
    expect(n).toBeGreaterThanOrEqual(18);
    expect(n).toBeLessThanOrEqual(75);
  });

  it('honours an explicit blink() promptly', () => {
    const d = new Director({ seed: 1 });
    run(d, 0.5);
    d.blink();
    let peak = 0;
    run(d, 0.3, 60, (t, a) => { peak = Math.max(peak, a.blinkL); }, 0.5);
    expect(peak).toBeGreaterThan(0.95);
  });

  it('keeps all outputs in range over a long random session', () => {
    const d = new Director({ seed: 11 });
    let k = 0;
    run(d, 60, 30, (t, a) => {
      if (k++ % 45 === 0) d.setState(STATES[(k / 45) % STATES.length | 0]);
      d.setMouth({ jaw: Math.abs(Math.sin(t * 7)), wide: 0.5, round: 0.2 });
      d.setSpeechLevel(Math.abs(Math.sin(t * 3)));
      for (const key of ['jawOpen', 'mouthWide', 'mouthRound', 'smile', 'blinkL', 'blinkR', 'browUp', 'breath',
        'speech', 'energy', 'listen', 'think', 'speak', 'error', 'sleep']) {
        expect(a[key]).toBeGreaterThanOrEqual(0);
        expect(a[key]).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(a.gazeX)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.gazeY)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.headYaw)).toBeLessThanOrEqual(0.35);
      expect(Math.abs(a.headPitch)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(a.headRoll)).toBeLessThanOrEqual(0.2);
      for (const key of ANIM_KEYS) expect(Number.isFinite(a[key])).toBe(true);
    });
  });

  it('transitions state weights smoothly', () => {
    const d = new Director({ seed: 2 });
    run(d, 1);
    d.setState('listening');
    const { a } = run(d, 0.1, 60, () => {}, 1);
    expect(a.listen).toBeGreaterThan(0.1);
    expect(a.listen).toBeLessThan(0.6);
    const r = run(d, 2, 60, () => {}, 1.1);
    expect(r.a.listen).toBeGreaterThan(0.98);
    expect(r.a.think).toBeLessThan(0.01);
  });

  it('listening brightens, sleep dims and closes the eyes', () => {
    const d = new Director({ seed: 4 });
    const idle = run(d, 3).a.energy;
    d.setState('listening');
    const listen = run(d, 3, 60, () => {}, 3).a.energy;
    expect(listen).toBeGreaterThan(idle + 0.15);
    d.setState('sleep');
    const r = run(d, 5, 60, () => {}, 6);
    expect(r.a.energy).toBeLessThan(0.25);
    expect(r.a.blinkL).toBeGreaterThan(0.95);
    expect(r.a.blinkR).toBeGreaterThan(0.95);
  });

  it('thinking glances up and to the side', () => {
    const d = new Director({ seed: 5, idleMotion: 0 });
    d.setState('thinking');
    const { a } = run(d, 2);
    expect(a.gazeY).toBeGreaterThan(0.3);
    expect(Math.abs(a.gazeX)).toBeGreaterThan(0.25);
    expect(a.think).toBeGreaterThan(0.95);
  });

  it('follows lookAt and releases it; the head takes a share and the eyes counter-rotate', () => {
    const d = new Director({ seed: 6, idleMotion: 0 });
    d.lookAt(1, -1);
    const { a } = run(d, 1);
    const g = worldGaze(a);
    // the world gaze is on the target (0.85, -0.75), not beyond it (no eye + head overshoot)
    expect(g.x).toBeGreaterThan(0.8);
    expect(g.x).toBeLessThan(0.88);
    expect(g.y).toBeLessThan(-0.7);
    expect(a.headYaw).toBeGreaterThan(0.05);     // the head follows a little
    expect(a.gazeX).toBeGreaterThan(0.5);        // the eyes do most of it
    expect(a.gazeX).toBeLessThan(g.x);
    d.lookAt(null);
    const r = run(d, 3, 60, () => {}, 1);
    expect(Math.abs(worldGaze(r.a).x)).toBeLessThan(0.05);
    expect(Math.abs(r.a.gazeX)).toBeLessThan(0.15);
  });

  it('lip-sync: fast attack, slower release, decays when visemes stop', () => {
    const d = new Director({ seed: 7 });
    d.setState('speaking');
    run(d, 0.5);
    d.setMouth({ jaw: 1 });
    const open = run(d, 0.05, 60, () => {}, 0.5).a.jawOpen;
    expect(open).toBeGreaterThan(0.6);
    d.setMouth({ jaw: 0 });
    const closing = run(d, 0.05, 60, () => {}, 0.55).a.jawOpen;
    expect(closing).toBeGreaterThan(0.2);          // release is slower than attack
    d.setMouth({ jaw: 0.8 });
    const r = run(d, 2, 60, () => {}, 0.6);         // no new visemes for 2 s
    expect(r.a.jawOpen).toBeLessThan(0.05);
  });

  it('derives a jaw from loudness when no visemes arrive while speaking', () => {
    const d = new Director({ seed: 8 });
    d.setState('speaking');
    let maxJaw = 0;
    run(d, 2, 60, (t, a) => { d.setSpeechLevel(0.8); maxJaw = Math.max(maxJaw, a.jawOpen); });
    expect(maxJaw).toBeGreaterThan(0.3);
  });

  it('settle mode is deterministic, jumps to targets and never blinks on its own', () => {
    const d1 = new Director({ seed: 9 });
    const d2 = new Director({ seed: 99 });
    for (const d of [d1, d2]) {
      d.setMouth({ jaw: 0.6, wide: 0.2 });
      d.setExpression({ smile: 0.5 });
    }
    const a1 = { ...d1.update(0, 1.0, { settle: true }) };
    const a2 = { ...d2.update(0, 1.0, { settle: true }) };
    expect(a1.jawOpen).toBe(0.6);
    expect(a1.mouthWide).toBe(0.2);
    expect(a1.smile).toBeCloseTo(0.5, 6);
    expect(a1.blinkL).toBe(0);
    expect(a1.energy).toBeCloseTo(0.5, 6);
    expect(a1.breath).toBeCloseTo(a2.breath, 9);   // breathing is a function of time only
    // idle sway differs per seed but stays small
    expect(Math.abs(a1.headYaw)).toBeLessThan(0.08);
  });

  it('ignores unknown states', () => {
    const d = new Director();
    const warn = console.warn;
    console.warn = () => {};
    try { d.setState('dancing'); } finally { console.warn = warn; }
    expect(d.state).toBe('idle');
  });
});
