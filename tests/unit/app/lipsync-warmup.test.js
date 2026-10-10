// The idle warm-up (browser only: requestIdleCallback) compiles the analysis, the fusion and the
// segment building in separate idle callbacks, so no one of them is a long task, and only once.
import { afterEach, describe, expect, it } from 'vitest';
import { LipSync } from '../../../src/audio/lipsync.js';

describe('LipSync idle warm-up', () => {
  const saved = globalThis.requestIdleCallback;
  afterEach(() => { globalThis.requestIdleCallback = saved; });

  it('runs the analysis, the fusion and the segments one idle callback each, once', () => {
    const queue = [];
    globalThis.requestIdleCallback = (fn, o) => { expect(o?.timeout).toBeGreaterThan(0); queue.push(fn); return queue.length; };
    let warm = 0;
    new LipSync({ acoustics: { analyse: () => null, warmUp: () => { warm++; } } });
    expect(queue.length).toBe(1);                      // nothing runs at construction
    let ran = 0;
    while (queue.length) { queue.shift()(); ran++; }
    expect(ran).toBe(3);
    expect(warm).toBe(1);
    // a second LipSync finds the fusion compiled: analysis step, fusion step (a no-op), done
    new LipSync({});
    ran = 0;
    while (queue.length) { queue.shift()(); ran++; }
    expect(ran).toBe(2);
  });
});
