import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSpotter, createVad, loadAddon } from '../../../electron/wake/utility/sherpa.js';
import { tmpDir } from '../helpers/tmp.js';

/** A fake raw addon: spotters that report one queued result, a VAD driven by the block's energy. */
function fakeAddon() {
  const calls = [];
  const a = {
    calls,
    results: [],
    createKeywordSpotter: (cfg) => { calls.push(['spotter', cfg]); return { cfg }; },
    createKeywordStream: (h) => ({ h, fed: 0, ready: 0 }),
    acceptWaveformOnline: (s, w) => { s.fed += w.samples.length; s.ready += Math.floor(w.samples.length / 320); calls.push(['accept', w.sampleRate]); },
    isKeywordStreamReady: (_h, s) => s.ready > 0,
    decodeKeywordStream: (_h, s) => { s.ready--; },
    getKeywordResultAsJson: () => JSON.stringify(a.results.shift() || { start_time: 0, keyword: '', timestamps: [], tokens: [] }),
    resetKeywordStream: (_h, s) => { s.resets = (s.resets || 0) + 1; },
    createVoiceActivityDetector: (cfg, buf) => { calls.push(['vad', cfg, buf]); a.lastVad = { speech: false, segs: 0, resets: 0 }; return a.lastVad; },
    voiceActivityDetectorAcceptWaveform: (h, x) => { h.speech = x.some((v) => Math.abs(v) > 0.1); if (h.speech) h.segs = 1; },
    voiceActivityDetectorIsDetected: (h) => h.speech,
    voiceActivityDetectorIsEmpty: (h) => h.segs === 0,
    voiceActivityDetectorPop: (h) => { h.segs = 0; },
    voiceActivityDetectorReset: (h) => { h.resets = (h.resets || 0) + 1; h.speech = false; },
  };
  return a;
}

const model = { encoder: '/m/e.onnx', decoder: '/m/d.onnx', joiner: '/m/j.onnx', tokens: '/m/t.txt' };

describe('the raw addon wrapper (utility/sherpa.js)', () => {
  it('passes keywords from memory, one thread, beam 16, the threshold', () => {
    const a = fakeAddon();
    createSpotter(a, { model, keywords: '▁HE Y ▁JA DE @HEY_JADE\n', threshold: 0.05 });
    const cfg = a.calls[0][1];
    expect(cfg).toMatchObject({ featConfig: { sampleRate: 16000, featureDim: 80 }, maxActivePaths: 16, numTrailingBlanks: 1, keywordsScore: 1, keywordsThreshold: 0.05 });
    expect(cfg.modelConfig).toMatchObject({ transducer: { encoder: '/m/e.onnx', decoder: '/m/d.onnx', joiner: '/m/j.onnx' }, tokens: '/m/t.txt', numThreads: 1, provider: 'cpu' });
    expect(cfg.keywordsBuf).toBe('▁HE Y ▁JA DE @HEY_JADE\n');
    expect(cfg.keywordsBufSize).toBe(Buffer.byteLength('▁HE Y ▁JA DE @HEY_JADE\n')); // bytes, not characters (▁ is 3 bytes)
    expect(cfg.keywordsBufSize).toBeGreaterThan(cfg.keywordsBuf.length);
  });

  it('drain() decodes what is ready, returns keywords and resets the stream after each', () => {
    const a = fakeAddon();
    const sp = createSpotter(a, { model, keywords: 'X @HEY_JADE\n', threshold: 0.1 });
    const s = sp.newStream();
    sp.accept(s, new Float32Array(960));
    a.results.push({ start_time: 0, keyword: '', timestamps: [], tokens: [] }, { start_time: 0, keyword: 'HEY_JADE', timestamps: [0.64, 1.08], tokens: ['HH', 'D'] });
    expect(sp.drain(s)).toEqual([{ keyword: 'HEY_JADE', timestamps: [0.64, 1.08], tokens: ['HH', 'D'], startTime: 0 }]);
    expect(s.resets).toBe(1);
    expect(sp.drain(s)).toEqual([]);
  });

  it('the VAD drops collected segments and resets itself after 25 s of uninterrupted speech', () => {
    const a = fakeAddon();
    const vad = createVad(a, { model: '/m/vad.onnx' });
    expect(a.calls[0][1]).toMatchObject({ sileroVad: { model: '/m/vad.onnx', threshold: 0.5, minSpeechDuration: 0.06, minSilenceDuration: 0.1, windowSize: 512 }, sampleRate: 16000, numThreads: 1 });
    expect(a.calls[0][2]).toBe(30);
    const loud = new Float32Array(320).fill(0.3);
    const quiet = new Float32Array(320);
    const blocks25s = (25 * 16000) / 320; // 1250 blocks of 20 ms
    for (let i = 0; i < blocks25s - 1; i++) expect(vad.accept(loud)).toBe(true);
    expect(a.lastVad.resets).toBe(0);
    expect(a.lastVad.segs).toBe(0); // segments are dropped every block
    vad.accept(loud); // 25 s without a pause
    expect(a.lastVad.resets).toBe(1);
    // a pause restarts the count
    for (let i = 0; i < blocks25s - 10; i++) vad.accept(loud);
    vad.accept(quiet);
    for (let i = 0; i < blocks25s - 10; i++) vad.accept(loud);
    expect(a.lastVad.resets).toBe(1);
    vad.reset();
    expect(a.lastVad.resets).toBe(2);
  });

  it('loadAddon() refuses a module without the functions it needs', () => {
    const dir = tmpDir('lm-addon-');
    const f = path.join(dir, 'fake.cjs');
    fs.writeFileSync(f, 'module.exports = { createKeywordSpotter() {} };');
    expect(() => loadAddon(f)).toThrow(/lacks createKeywordStream/);
  });
});
