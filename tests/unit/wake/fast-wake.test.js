// The avatar's fast wake (contract-wake §9.7, ux.md ACK-5): "Hey Jade" out of a doze reaches the
// listening pose within ≈ 400 ms; an ordinary wake keeps the slow, sleepy transition.
import { describe, expect, it } from 'vitest';
import { Director, FAST_WAKE_S } from '../../../src/avatar/director.js';

/** asleep for 4 s, then `setState('listening', o)`: seconds until she is (nearly) all there */
function wakeTime(o) {
  const d = new Director({ seed: 5 });
  const dt = 1 / 60;
  let t = 0;
  d.setState('sleep');
  for (; t < 4; t += dt) d.update(dt, t);
  const out0 = d.update(dt, (t += dt));
  expect(out0.sleep).toBeGreaterThan(0.95);
  d.setState('listening', o);
  const t0 = t;
  for (let i = 0; i < 600; i++) {
    t += dt;
    const out = d.update(dt, t);
    if (out.listen > 0.9 && out.sleep < 0.1) return t - t0;
  }
  return Infinity;
}

describe('fast wake', () => {
  it('leaves a doze for the listening pose within 400 ms', () => {
    const fast = wakeTime({ fast: true });
    expect(fast).toBeLessThanOrEqual(0.4);
    expect(FAST_WAKE_S).toBeGreaterThan(fast);
  });

  it('without it the doze still ends slowly (unchanged)', () => {
    expect(wakeTime(undefined)).toBeGreaterThan(0.6);
  });

  it('only for 0.6 s: later state changes have their usual pace', () => {
    const d = new Director({ seed: 5 });
    const dt = 1 / 60;
    let t = 0;
    d.setState('listening', { fast: true });
    for (; t < 1; t += dt) d.update(dt, t);
    d.setState('sleep');
    let out;
    for (let i = 0; i < 18; i++) out = d.update(dt, (t += dt)); // 300 ms
    expect(out.sleep).toBeLessThan(0.6); // ω 3.2: far from asleep after 300 ms
  });
});
