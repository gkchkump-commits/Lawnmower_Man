// WakeEngine (electron/wake/utility/engine.js) over a fake addon: the strict ('low') thresholds are
// built ahead at the first quiet moment, so the media-burst switch never blocks the audio path;
// only the current set and its strict twin stay cached.
import { describe, expect, it } from 'vitest';
import { WakeEngine } from '../../../electron/wake/utility/engine.js';
import { fakeSherpaAddon } from './fakes.js';

const model = (d) => ({ encoder: `/${d}/e.onnx`, decoder: `/${d}/d.onnx`, joiner: `/${d}/j.onnx`, tokens: `/${d}/t.txt` });

function make() {
  const addon = fakeSherpaAddon();
  let t = 0;
  const logs = [];
  const e = new WakeEngine({ addon, models: { zhen: model('zhen'), giga: model('giga'), vad: '/vad.onnx' }, gc: null, now: () => t, log: (l, m) => logs.push(m), agc: false });
  e.load();
  let at = 0;
  const feed = (sec, v = 0.001) => {
    for (let n = 0; n < sec * 16000; n += 683) {
      const x = new Float32Array(683).fill(v);
      e.push(x, at);
      at += x.length;
    }
  };
  return { e, addon, feed, logs, tick: (ms) => { t += ms; } };
}

describe('WakeEngine: thresholds without blocking the audio', () => {
  it('builds the strict twin after 1.5 s of quiet; the strict switch is then a cache hit', () => {
    const { e, addon, feed, logs } = make();
    expect(addon.spotters).toBe(2); // zh-en + GigaSpeech, normal
    feed(1.0);
    expect(addon.spotters).toBe(2);
    feed(0.6);
    expect(addon.spotters).toBe(4); // the low thresholds, built ahead
    expect(logs.some((l) => /built the strict thresholds ahead/.test(l))).toBe(true);
    // a media burst: strict on, then off again — no new spotter, nothing blocks
    e.setStrict(true);
    feed(0.1);
    e.setStrict(false);
    feed(0.1);
    expect(addon.spotters).toBe(4);
    expect(e.stats().cachedSets).toBe(4);
  });

  it('keeps only the current set and its strict twin (a sensitivity change drops the old ones)', () => {
    const { e, addon, feed } = make();
    feed(2);
    expect(e.stats().cachedSets).toBe(4);
    e.setParams({ sensitivity: 'high' });
    feed(0.1); // rebuilt in the quiet: high (zh-en 0.05; GigaSpeech 0.05 = normal's)
    feed(2); // and its twin (low) is cached already
    expect(e.stats().cachedSets).toBeLessThanOrEqual(4);
    e.setParams({ sensitivity: 'normal' });
    feed(2);
    e.setParams({ sensitivity: 'high' });
    feed(2);
    expect(e.stats().cachedSets).toBeLessThanOrEqual(4);
    expect(addon.spotters).toBeGreaterThan(4);
  });

  it('never builds while someone speaks (the recipe is feeding a stream)', () => {
    const { addon, feed } = make();
    feed(3, 0.3); // continuous speech
    expect(addon.spotters).toBe(2);
    feed(0.7 + 1.6); // the 0.7 s hangover, then 1.5 s of quiet
    expect(addon.spotters).toBe(4);
  });
});
