// The text mask and the echo check (contract-wake §8.5): her own voice saying her name never
// wakes her.
import { describe, expect, it } from 'vitest';
import { HAS_NAME, SelfMask, TapClock, inputLatencySec, jaccard } from '../../../src/wake/self-mask.js';

describe('TapClock: 16 kHz sample index → performance.now()', () => {
  it('maps through the arrival time of the block that holds the sample', () => {
    const c = new TapClock();
    // 683-sample blocks (2048 at 48 kHz), the last sample of each arriving at t
    c.push(0, 683, 1000);
    c.push(683, 683, 1042.7);
    c.push(1366, 683, 1085.4);
    // the last sample of block 2 arrived at 1042.7
    expect(c.perf(1365)).toBeCloseTo(1042.7 - (1 / 16000) * 1000, 6);
    // the first sample of block 2: one block duration earlier
    expect(c.perf(683)).toBeCloseTo(1042.7 - (683 / 16000) * 1000, 6);
    // beyond the newest block: extrapolated from it
    expect(c.perf(2049 + 1600)).toBeCloseTo(1085.4 + 100, 6);
    // before the oldest: extrapolated from it
    expect(c.perf(-1600)).toBeCloseTo(1000 - ((683 + 1600) / 16000) * 1000, 6);
  });

  it('subtracts the capture latency: 30 ms, plus 170 ms with the all-apps echo canceller', () => {
    expect(inputLatencySec(true)).toBeCloseTo(0.03, 6);
    expect(inputLatencySec('all')).toBeCloseTo(0.2, 6);
    const c = new TapClock();
    c.push(0, 1600, 500);
    expect(c.perf(1600, inputLatencySec(true))).toBeCloseTo(470, 6);
    expect(c.perf(1600, inputLatencySec('all'))).toBeCloseTo(300, 6);
  });

  it('keeps only the last few seconds of blocks; nothing before the first block', () => {
    const c = new TapClock({ keepMs: 1000 });
    expect(c.perf(0)).toBeNull();
    for (let i = 0; i < 100; i++) c.push(i * 800, 800, i * 50);
    expect(c.blocks.length).toBeLessThan(30);
    expect(c.perf(99 * 800 + 400)).toBeCloseTo(99 * 50 - 25, 6);
  });
});

describe('SelfMask', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, set: (v) => { t = v; } };
  };

  it('knows her name in its spellings', () => {
    for (const s of ["I'm Jade.", 'JADE here', 'Jaide', 'jayde?', 'Jaed']) expect(HAS_NAME.test(s), s).toBe(true);
    for (const s of ['jaded', 'Jude', 'the jadeite statue', 'Jayden']) expect(HAS_NAME.test(s), s).toBe(false);
  });

  it('masks a hit overlapping a clip with her name, from 100 ms before it to 400 ms after it', () => {
    const k = clock();
    const m = new SelfMask({ now: k.now });
    const clip = {};
    m.clipStart({ key: clip, text: "Hello! I'm Jade, floating on your desktop.", kind: 'audio', startPerf: 1000 });
    // while it plays (no end yet)
    expect(m.masked(1500, 1800)).toEqual({ reason: 'self', text: "Hello! I'm Jade, floating on your desktop." });
    m.clipEnd(clip, 3000);
    expect(m.masked(905, 950)).not.toBeNull(); // the keyword ends 50 ms before the clip starts: inside the 100 ms pre margin
    expect(m.masked(800, 899)).toBeNull();
    expect(m.masked(3300, 3399)).not.toBeNull(); // in the 400 ms tail
    expect(m.masked(3401, 3600)).toBeNull();
  });

  it('a clip without her name masks nothing; the system voice gets its own reason', () => {
    const m = new SelfMask({ now: () => 0 });
    m.clipStart({ key: 1, text: 'Holograms work by recording light.', kind: 'audio', startPerf: 0 });
    expect(m.masked(100, 400)).toBeNull();
    m.clipStart({ key: 2, text: 'Jade here.', kind: 'speech', startPerf: 1000 });
    expect(m.masked(1100, 1300)?.reason).toBe('system');
  });

  it('the echo test lets its own line through (exempt) and only that line', () => {
    const m = new SelfMask({ now: () => 0 });
    const line = 'Just say hey Jade whenever you need me.';
    m.exempt(line);
    m.clipStart({ key: 1, text: line, startPerf: 0 });
    expect(m.masked(100, 300)).toBeNull();
    m.unexempt(line);
    m.clipStart({ key: 2, text: line, startPerf: 5000 });
    expect(m.masked(5100, 5300)).not.toBeNull();
  });

  it('without tap timing, masks while a clip with her name plays', () => {
    const m = new SelfMask({ now: () => 0 });
    expect(m.masked(null, null)).toBeNull();
    m.clipStart({ key: 1, text: "I'm Jade.", startPerf: 0 });
    expect(m.masked(null, null)?.reason).toBe('self');
    m.allEnded(100);
    expect(m.masked(null, null)).toBeNull();
    expect(m.speakingName(450)).toBe(true);
    expect(m.speakingName(600)).toBe(false);
  });

  it('echo(): a transcript that is mostly one of her sentences of the last 10 s', () => {
    const k = clock();
    const m = new SelfMask({ now: k.now });
    m.clipStart({ key: 1, text: 'The weather tomorrow will be sunny and warm.', startPerf: 0 });
    k.set(4000);
    expect(m.echo('the weather tomorrow will be sunny and warm')).toBe(true);
    expect(m.echo('weather tomorrow will be sunny and warm')).toBe(true); // 7/8 words
    expect(m.echo('will it be warm tomorrow')).toBe(false);
    expect(m.echo('sunny warm')).toBe(false); // fewer than 3 words: never an echo
    k.set(10_500);
    expect(m.echo('the weather tomorrow will be sunny and warm')).toBe(false); // older than 10 s
  });

  it('jaccard', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(1);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 6);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('forgets clips that ended long ago', () => {
    const k = clock();
    const m = new SelfMask({ now: k.now, keepMs: 1000 });
    m.clipStart({ key: 1, text: "I'm Jade.", startPerf: 0 });
    m.clipEnd(1, 100);
    k.set(5000);
    m.clipStart({ key: 2, text: 'Something else.', startPerf: 5000 });
    expect(m.clips.map((c) => c.key)).toEqual([2]);
  });
});
