// FaceTracker (src/vision/face-tracker.js) with a fake worker and fake frames: the worker
// protocol, back-pressure and rate, the main-thread fallback, and giving up cleanly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_TIMEOUT_MS, FaceTracker, MAIN_THREAD_MAX_HZ, MAX_CONSECUTIVE_ERRORS } from '../../../src/vision/face-tracker.js';

const URLS = { wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/vision/face_landmarker.task' };
const video = () => ({ readyState: 4, videoWidth: 640, videoHeight: 480 });

class FakeWorker {
  constructor() {
    this.sent = [];
    this.listeners = { message: [], error: [] };
    this.terminated = false;
  }
  addEventListener(ev, cb) { this.listeners[ev].push(cb); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  reply(data) { for (const cb of this.listeners.message) cb({ data }); }
  crash(message) { for (const cb of this.listeners.error) cb({ message, preventDefault() {} }); }
  frames() { return this.sent.filter((m) => m.type === 'frame'); }
}

let bitmaps;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  bitmaps = [];
  globalThis.createImageBitmap = vi.fn(async (_v, o) => {
    const b = { width: o.resizeWidth, height: o.resizeHeight, close: vi.fn() };
    bitmaps.push(b);
    return b;
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.createImageBitmap;
});

function tracker(o = {}) {
  const workers = [];
  const t = new FaceTracker({
    urls: URLS,
    now: () => Date.now(),
    createWorker: o.createWorker || (() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }),
    loadEngine: o.loadEngine,
  });
  const obs = [];
  const errors = [];
  t.on('observation', (x) => obs.push(x));
  t.on('error', (e) => errors.push(e));
  return { t, workers, obs, errors };
}

describe('FaceTracker', () => {
  it('worker: init with the asset URLs, ready, then ~320 px frames at the rate, one at a time', async () => {
    const { t, workers, obs } = tracker();
    const started = t.start();
    const w = workers[0];
    expect(w.sent[0]).toEqual({ type: 'init', ...URLS });
    w.reply({ type: 'ready', delegate: 'CPU', ms: 300 });
    await started;
    expect(t.mode).toBe('worker');
    t.setVideo(/** @type {any} */ (video()));
    t.setRate(10);
    await vi.advanceTimersByTimeAsync(5);
    expect(w.frames()).toHaveLength(1);
    expect(w.frames()[0]).toMatchObject({ width: 320, height: 240 });
    // back-pressure: no second frame before the answer, however long it takes
    await vi.advanceTimersByTimeAsync(500);
    expect(w.frames()).toHaveLength(1);
    w.reply({ type: 'result', id: 1, obs: { points: {} }, ms: 12 });
    expect(obs).toHaveLength(1);
    expect(t.lastMs).toBe(12);
    await vi.advanceTimersByTimeAsync(5);
    expect(w.frames()).toHaveLength(2); // the 100 ms interval had passed already
    w.reply({ type: 'result', id: 2, obs: null, ms: 9 });
    await vi.advanceTimersByTimeAsync(50);
    expect(w.frames()).toHaveLength(2); // 10/s: the next one 100 ms after the last
    await vi.advanceTimersByTimeAsync(60);
    expect(w.frames()).toHaveLength(3);
    w.reply({ type: 'result', id: 3, obs: null, ms: 9 });
    // paused
    t.setRate(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.frames()).toHaveLength(3);
    t.stop();
    expect(w.sent.at(-1)).toEqual({ type: 'close' });
    await vi.advanceTimersByTimeAsync(600);
    expect(w.terminated).toBe(true);
    expect(t.running).toBe(false);
  });

  it('skips frames while the video has none yet; a skipped answer is not an observation', async () => {
    const { t, workers, obs } = tracker();
    const started = t.start();
    workers[0].reply({ type: 'ready' });
    await started;
    const v = { readyState: 1, videoWidth: 0, videoHeight: 0 };
    t.setVideo(/** @type {any} */ (v));
    t.setRate(12);
    await vi.advanceTimersByTimeAsync(300);
    expect(workers[0].frames()).toHaveLength(0);
    Object.assign(v, video());
    await vi.advanceTimersByTimeAsync(150);
    expect(workers[0].frames()).toHaveLength(1);
    workers[0].reply({ type: 'result', id: 1, obs: null, ms: 0, skipped: true });
    expect(obs).toHaveLength(0);
  });

  it('falls back to the main thread (capped rate) when the worker cannot load', async () => {
    const detect = vi.fn(() => ({ points: {} }));
    const loadEngine = vi.fn(async () => ({ createFaceEngine: async (urls) => ({ delegate: 'CPU', detect, close: vi.fn(), urls }) }));
    const { t, workers, obs } = tracker({ loadEngine });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = t.start();
    workers[0].crash('Failed to load module script');
    await started;
    warn.mockRestore();
    expect(t.mode).toBe('main');
    expect(workers[0].terminated).toBe(true);
    t.setVideo(/** @type {any} */ (video()));
    t.setRate(12);
    await vi.advanceTimersByTimeAsync(1000);
    expect(obs.length).toBeGreaterThanOrEqual(MAIN_THREAD_MAX_HZ - 1);
    expect(obs.length).toBeLessThanOrEqual(MAIN_THREAD_MAX_HZ + 1);
    expect(detect).toHaveBeenCalledWith(expect.anything(), 320, 240, expect.any(Number));
    expect(bitmaps.every((b) => b.close.mock.calls.length === 1)).toBe(true); // frames are freed
  });

  it('neither worker nor main thread: a fatal error, mode "failed"', async () => {
    const loadEngine = async () => ({ createFaceEngine: async () => { throw new Error('no WebGL'); } });
    const { t, workers, errors } = tracker({ loadEngine });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = t.start().catch((e) => e);
    workers[0].reply({ type: 'error', message: 'Failed to fetch dynamically imported module', fatal: true });
    await started;
    warn.mockRestore();
    expect(t.mode).toBe('failed');
    expect(errors[0]).toMatchObject({ fatal: true });
    expect(errors[0].message).toMatch(/no WebGL/);
  });

  it('a crash after start, repeated detection errors, or no answer stop it with a fatal error', async () => {
    for (const how of ['crash', 'errors', 'hang']) {
      const { t, workers, errors } = tracker();
      const started = t.start();
      const w = workers[0];
      w.reply({ type: 'ready' });
      await started;
      t.setVideo(/** @type {any} */ (video()));
      t.setRate(12);
      await vi.advanceTimersByTimeAsync(5);
      if (how === 'crash') w.crash('out of memory');
      if (how === 'errors') {
        for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
          w.reply({ type: 'error', message: 'abort', fatal: false });
          await vi.advanceTimersByTimeAsync(100);
        }
      }
      if (how === 'hang') await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS + 10);
      expect(t.mode, how).toBe('failed');
      expect(errors.at(-1).fatal, how).toBe(true);
      expect(errors.filter((e) => !e.fatal).length, how).toBe(how === 'errors' ? MAX_CONSECUTIVE_ERRORS - 1 : 0);
      const n = w.frames().length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.frames().length, how).toBe(n); // stopped for good
    }
  });

  it('an occasional failed detection is tolerated', async () => {
    const { t, workers, errors, obs } = tracker();
    const started = t.start();
    const w = workers[0];
    w.reply({ type: 'ready' });
    await started;
    t.setVideo(/** @type {any} */ (video()));
    t.setRate(12);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(90);
      if (i % 3 === 0) w.reply({ type: 'error', message: 'glitch', fatal: false });
      else w.reply({ type: 'result', id: i, obs: null, ms: 5 });
    }
    expect(t.mode).toBe('worker');
    expect(errors.every((e) => !e.fatal)).toBe(true);
    expect(obs.length).toBe(8);
  });
});
