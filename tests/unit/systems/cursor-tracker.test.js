import { describe, expect, it } from 'vitest';
import { CursorTracker } from '../../../electron/cursor-tracker.js';

function harness() {
  const st = { point: { x: 500, y: 400 }, origin: { x: 100, y: 50 }, active: true, sent: [], timers: [] };
  const t = new CursorTracker({
    getPoint: () => st.point,
    getOrigin: () => st.origin,
    isActive: () => st.active,
    send: (p) => st.sent.push(p),
    setInterval: (fn, ms) => { const id = { fn, ms }; st.timers.push(id); return id; },
    clearInterval: (id) => { st.timers = st.timers.filter((x) => x !== id); },
  });
  return { t, st };
}

describe('CursorTracker (global cursor follow)', () => {
  it('reports the cursor relative to the window content, even outside it', () => {
    const { t, st } = harness();
    expect(t.poll()).toEqual({ x: 400, y: 350 });
    st.point = { x: 20, y: 10 }; // left of / above the window
    expect(t.poll()).toEqual({ x: -80, y: -40 });
    expect(st.sent).toEqual([{ x: 400, y: 350 }, { x: -80, y: -40 }]);
  });

  it('sends nothing while the cursor (relative to the window) does not move', () => {
    const { t, st } = harness();
    t.poll();
    t.poll();
    t.poll();
    expect(st.sent).toHaveLength(1);
    st.origin = { x: 90, y: 50 }; // the window moved under a still cursor
    t.poll();
    expect(st.sent.at(-1)).toEqual({ x: 410, y: 350 });
  });

  it('polls at ~30 Hz only while started and active; restart re-sends', () => {
    const { t, st } = harness();
    t.start();
    t.start();
    expect(st.timers).toHaveLength(1);
    expect(st.timers[0].ms).toBeLessThanOrEqual(40);
    st.timers[0].fn();
    st.active = false; // hidden / minimized
    st.point = { x: 1, y: 1 };
    st.timers[0].fn();
    expect(st.sent).toHaveLength(1);
    t.stop();
    expect(st.timers).toHaveLength(0);
    expect(t.running).toBe(false);
    st.active = true;
    st.point = { x: 500, y: 400 };
    t.start();
    st.timers[0].fn();
    expect(st.sent).toHaveLength(2); // same position as before the stop, sent again
  });

  it('survives a window that disappears mid-poll', () => {
    const { t, st } = harness();
    st.origin = null;
    expect(t.poll()).toBeNull();
    const bad = new CursorTracker({ getPoint: () => { throw new Error('gone'); }, getOrigin: () => ({ x: 0, y: 0 }), isActive: () => true, send: () => {} });
    expect(bad.poll()).toBeNull();
  });
});
