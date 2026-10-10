import { describe, it, expect } from 'vitest';
import { MAX_FRAME, PortSession, checkPcm } from '../../../electron/wake/utility/protocol.js';

function fakeEngine() {
  const e = {
    models: ['zhen', 'giga'],
    pushes: [],
    dropped: 0,
    strict: null,
    resets: 0,
    nextHits: [],
    recipe: { speaking: false },
    push(pcm, at) {
      e.pushes.push({ n: pcm.length, at });
      const h = e.nextHits;
      e.nextHits = [];
      return h;
    },
    noteDropped() { e.dropped++; },
    setStrict(on) { e.strict = on; },
    reset() { e.resets++; },
  };
  return e;
}

describe('port protocol (contract §6.3)', () => {
  it('validates frames: Float32Array, 1-4096 finite samples in ±1.5, integer at, not backwards', () => {
    expect(checkPcm({ pcm: new Float32Array(683), at: 0 }, null)).toEqual({ ok: true });
    expect(checkPcm({ pcm: new Float32Array(MAX_FRAME), at: 5 }, 5).ok).toBe(true);
    expect(checkPcm({ pcm: new Float32Array(MAX_FRAME + 1), at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: new Float32Array(0), at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: [0.1, 0.2], at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: new Float64Array(4), at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: Float32Array.of(0, NaN), at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: Float32Array.of(0, 2), at: 0 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: Float32Array.of(0), at: 1.5 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: Float32Array.of(0), at: -1 }, null).ok).toBe(false);
    expect(checkPcm({ pcm: Float32Array.of(0), at: 10 }, 20).error).toMatch(/goes back/);
    expect(checkPcm({ pcm: Float32Array.of(0), at: 30 }, 20).ok).toBe(true); // a gap forward is allowed
  });

  it('feeds valid frames to the engine and posts hits and VAD transitions', () => {
    const e = fakeEngine();
    const hitsSeen = [];
    const s = new PortSession({ engine: /** @type {any} */ (e), gen: 3, onHits: (h) => hitsSeen.push(...h) });
    expect(s.ready()).toEqual({ t: 'ready', models: ['zhen', 'giga'], gen: 3 });
    expect(s.handle({ t: 'pcm', at: 0, pcm: new Float32Array(683) })).toEqual([]);
    e.recipe.speaking = true;
    e.nextHits = [{ id: 1, keyword: 'HEY_JADE', model: 'zhen', streamAt: 10, startAt: 20, endAt: 30, emitAt: 40 }];
    const out = s.handle({ t: 'pcm', at: 683, pcm: new Float32Array(683) });
    expect(out).toEqual([
      { t: 'vad', speaking: true, at: 1366 },
      { t: 'hit', id: 1, keyword: 'HEY_JADE', model: 'zhen', streamAt: 10, startAt: 20, endAt: 30, emitAt: 40 },
    ]);
    expect(hitsSeen).toHaveLength(1);
    expect(e.pushes).toEqual([{ n: 683, at: 0 }, { n: 683, at: 683 }]);
  });

  it('drops a bad frame with an error (never throws), and resynchronises after a backward jump', () => {
    const e = fakeEngine();
    const s = new PortSession({ engine: /** @type {any} */ (e), gen: 1 });
    s.handle({ t: 'pcm', at: 1000, pcm: new Float32Array(100) });
    expect(s.handle({ t: 'pcm', at: 0, pcm: new Float32Array(100) })[0]).toMatchObject({ t: 'error' });
    expect(e.dropped).toBe(1);
    // the sender restarted its count: the next frame is accepted from wherever it starts
    expect(s.handle({ t: 'pcm', at: 50, pcm: new Float32Array(100) })).toEqual([]);
    expect(e.pushes.at(-1)).toEqual({ n: 100, at: 50 });
    expect(s.handle(null)[0].t).toBe('error');
    expect(s.handle({ t: 'evil' })[0].message).toMatch(/unknown message type/);
  });

  it('rate-limits error replies from a misbehaving page', () => {
    const s = new PortSession({ engine: /** @type {any} */ (fakeEngine()), gen: 1 });
    let n = 0;
    for (let i = 0; i < 300; i++) n += s.handle({ t: 'pcm', at: 0, pcm: 'x' }).length;
    expect(n).toBeLessThan(10);
  });

  it('reset, strict and ping', () => {
    const e = fakeEngine();
    const s = new PortSession({ engine: /** @type {any} */ (e), gen: 1 });
    expect(s.handle({ t: 'reset' })).toEqual([]);
    expect(e.resets).toBe(1);
    expect(s.handle({ t: 'strict', on: true })).toEqual([]);
    expect(e.strict).toBe(true);
    expect(s.handle({ t: 'strict', on: 'yes' })[0].t).toBe('error');
    expect(s.handle({ t: 'ping', n: 7 })).toEqual([{ t: 'pong', n: 7 }]);
  });
});
