// The security worker's pipeline (src/tapo/worker/pipeline.js) with fake pictures, canvases and
// a manual clock: the messages main and the page get, the detection duty cycle, suppression
// while the camera turns, snapshots, the calibration shift measurement and frame lifetimes.
import { describe, expect, it } from 'vitest';
import { RATES, SHIFT_MIN_WAIT_MS, SecurityPipeline } from '../../../src/tapo/worker/pipeline.js';
import { fakeGraphics, fakeImage, flush, manualClock, room } from './helpers.js';

function setup(o = {}) {
  const clock = manualClock();
  const g = fakeGraphics();
  const toMain = [];
  const toPage = [];
  const port = { onmessage: null, posted: toMain, postMessage(m) { toMain.push(m); }, start() {}, close() { this.closed = true; } };
  const p = new SecurityPipeline({
    postPage: (m) => toPage.push(m),
    createImageBitmap: g.createImageBitmap,
    OffscreenCanvas: g.OffscreenCanvas,
    loadDetector: o.loadDetector,
    detectorDelayMs: 500,
    ...clock,
  });
  p.attachPort(port);
  const main = (m) => port.onmessage({ data: m });
  const canvas = new g.OffscreenCanvas(10, 10);
  canvas.live = true;
  p.onPage({ t: 'canvas', canvas });
  p.onPage({ t: 'resize', width: 640, height: 360, dpr: 1 });
  const images = [];
  /** feed `n` frames at `fps` of the picture `paint` (a function of the frame index) */
  const feed = async (n, paint, fps = 10) => {
    for (let i = 0; i < n; i++) {
      const img = fakeImage(paint(i));
      images.push(img);
      main({ t: 'bitmap', image: img, ts: clock.now() });
      await flush(3);
      clock.advance(1000 / fps);
    }
    await flush();
  };
  const of = (list, t) => list.filter((m) => m.t === t);
  return { p, clock, g, toMain, toPage, main, feed, images, of, port };
}

describe('SecurityPipeline: hello and the detector', () => {
  it('stub detector: ready at once', () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub', wasmBase: 'x/', modelUrl: 'y' });
    expect(s.of(s.toMain, 'ready')).toEqual([{ t: 'ready', detector: 'stub' }]);
  });

  it('MediaPipe: loaded soon after hello (or at once when armed); ready on / failed', async () => {
    const calls = [];
    const s = setup({ loadDetector: async (o) => { calls.push(o); return { detect: () => [], close() {} }; } });
    s.main({ t: 'hello', detector: 'mediapipe', wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/m.tflite' });
    expect(calls).toHaveLength(0);
    s.clock.advance(500);
    await flush();
    expect(calls).toEqual([{ wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/m.tflite' }]);
    expect(s.of(s.toMain, 'ready')).toEqual([{ t: 'ready', detector: 'on' }]);
    // a new port (main restarted the camera service): hello again → ready again, no reload
    s.main({ t: 'hello', detector: 'mediapipe', wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/m.tflite' });
    expect(s.of(s.toMain, 'ready')).toHaveLength(2);
    expect(calls).toHaveLength(1);

    const f = setup({ loadDetector: async () => { throw new Error('model missing'); } });
    f.main({ t: 'hello', detector: 'mediapipe', wasmBase: 'a/', modelUrl: 'b' });
    f.main({ t: 'armed', on: true, people: true, sensitivity: 'medium' });
    f.clock.advance(0);
    await flush();
    expect(f.of(f.toMain, 'ready')).toEqual([{ t: 'ready', detector: 'failed', error: 'model missing' }]);
  });
});

describe('SecurityPipeline: detection', () => {
  it('disarmed: frames are drawn, nothing is sent to main', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    await s.feed(10, () => room());
    expect(s.of(s.toMain, 'det')).toHaveLength(0);
    expect(s.g.stats.drawsOnLive).toBe(10);
    expect(s.of(s.toPage, 'video')).toEqual([{ t: 'video', width: 640, height: 360 }]);
  });

  it('armed: det at the motion rate; a green figure is a person (detected: true at 1 Hz)', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    s.main({ t: 'armed', on: true, people: true, sensitivity: 'medium' });
    await s.feed(30, (i) => room({ figure: i >= 10 ? { x: 0.3 + i * 0.01, y: 0.5 } : null })); // 3 s at 10 fps
    const dets = s.of(s.toMain, 'det');
    expect(dets.length).toBeGreaterThanOrEqual(12);
    expect(dets.length).toBeLessThanOrEqual(16); // ≈ 5/s
    const withPersons = dets.filter((d) => d.detected && d.persons.length);
    expect(withPersons.length).toBeGreaterThanOrEqual(1);
    expect(dets.filter((d) => d.detected).length).toBeLessThanOrEqual(4); // 1 Hz
    const p = withPersons.at(-1).persons[0];
    expect(p.score).toBe(0.9);
    p.box.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
    // the moving figure is motion too
    expect(dets.some((d) => d.motion.active)).toBe(true);
    // det messages without a detector run carry no persons
    expect(dets.filter((d) => !d.detected).every((d) => d.persons.length === 0)).toBe(true);
    expect(s.of(s.toPage, 'det-view').some((m) => m.persons.length === 1)).toBe(true);
    // at is a wall-clock time
    expect(dets[0].at).toBeGreaterThan(s.clock.wall0);
  });

  it('boost raises person detection to 4 Hz', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    s.main({ t: 'armed', on: true, people: true });
    s.main({ t: 'boost', untilMs: s.clock.wallNow() + 10_000 });
    expect(s.p.detectionRate()).toBe(RATES.boostHz);
    await s.feed(20, () => room({ figure: { x: 0.5, y: 0.5 } }));
    const detected = s.of(s.toMain, 'det').filter((d) => d.detected);
    expect(detected.length).toBeGreaterThanOrEqual(6);
  });

  it('nothing is detected while the camera turns or settles; the background starts over after', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    s.main({ t: 'armed', on: true, people: true });
    s.main({ t: 'ptz', moving: true, settleUntil: 0 });
    expect(s.p.detectionRate()).toBe(0);
    await s.feed(10, (i) => room({ offset: i * 0.05, figure: { x: 0.5, y: 0.5 } }));
    expect(s.of(s.toMain, 'det')).toHaveLength(0);
    s.main({ t: 'ptz', moving: false, settleUntil: s.clock.wallNow() + 1500 });
    await s.feed(10, () => room({ offset: 0.5 }));
    expect(s.of(s.toMain, 'det')).toHaveLength(0);
    await s.feed(10, () => room({ offset: 0.5 }));
    const dets = s.of(s.toMain, 'det');
    expect(dets.length).toBeGreaterThan(0);
    expect(dets.every((d) => !d.motion.active && !d.motion.global)).toBe(true); // the new view is the new background
  });

  it('overlay (show detections while disarmed): boxes for the page, nothing for main', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    s.p.onPage({ t: 'overlay', show: true });
    await s.feed(15, () => room({ figure: { x: 0.5, y: 0.5 } }));
    expect(s.of(s.toMain, 'det')).toHaveLength(0);
    expect(s.of(s.toPage, 'det-view').some((m) => m.persons.length === 1)).toBe(true);
    s.p.onPage({ t: 'overlay', show: false });
    expect(s.of(s.toPage, 'det-view').at(-1)).toEqual({ t: 'det-view', persons: [] });
  });
});

describe('SecurityPipeline: frames, snapshots, stats', () => {
  it('keeps only the newest frame open', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    await s.feed(8, () => room());
    expect(s.images.slice(0, -1).every((i) => i.closed)).toBe(true);
    expect(s.images.at(-1).closed).toBe(false);
    s.main({ t: 'idle' });
    expect(s.images.at(-1).closed).toBe(true);
  });

  it('nothing is drawn while the page or main says the view is hidden', async () => {
    const s = setup();
    s.p.onPage({ t: 'view', visible: false });
    await s.feed(3, () => room());
    expect(s.g.stats.drawsOnLive).toBe(0);
    s.p.onPage({ t: 'view', visible: true });
    s.main({ t: 'view', visible: false });
    await s.feed(3, () => room());
    expect(s.g.stats.drawsOnLive).toBe(1); // the redraw when the page became visible
  });

  it('snapshots for main and for the page; none without a picture', async () => {
    const s = setup();
    s.main({ t: 'snap', id: 'a', maxSide: 640, quality: 0.75 });
    await flush();
    expect(s.of(s.toMain, 'snap-err')).toEqual([{ t: 'snap-err', id: 'a', message: 'There is no picture yet.' }]);
    await s.feed(2, () => room());
    s.main({ t: 'snap', id: 'b', maxSide: 640, quality: 0.75 });
    s.p.onPage({ t: 'snap', id: 'c', maxSide: 1280, quality: 0.9 });
    await flush();
    const ok = s.of(s.toMain, 'snap-ok')[0];
    expect(ok).toMatchObject({ id: 'b', width: 640, height: 360 });
    expect(new Uint8Array(ok.jpeg).slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(s.of(s.toPage, 'snap-ok')[0]).toMatchObject({ id: 'c', width: 640, height: 360 });
  });

  it('stats for main (contract shape) and the page (with the detector)', async () => {
    const s = setup();
    s.main({ t: 'hello', detector: 'stub' });
    await s.feed(12, () => room());
    s.p.postStats();
    const st = s.of(s.toMain, 'stats').at(-1);
    // the contract's fields plus the detector's rate (main's status shows it; validate.js reads it)
    expect(Object.keys(st).sort()).toEqual(['configSupported', 'decodeQueue', 'decoder', 'detectorHz', 'dropped', 'fps', 't']);
    expect(st.detectorHz).toBe(0); // disarmed, no overlay: the detector does not run
    expect(st.fps).toBeGreaterThan(8);
    // armed: the detector runs (1 Hz) and main learns its rate and the time of one run
    s.main({ t: 'armed', on: true, people: true, sensitivity: 'medium' });
    await s.feed(75, () => room());
    s.p.postStats();
    const armed = s.of(s.toMain, 'stats').at(-1);
    expect(armed.detectorHz).toBeGreaterThan(0.4);
    expect(armed.detectorMs).toBeGreaterThanOrEqual(0); // the stub takes no time on the manual clock
    expect(s.of(s.toPage, 'stats').at(-1)).toMatchObject({ hasFrame: true, detector: { state: 'stub' }, video: { width: 640, height: 360 } });
  });
});

describe('SecurityPipeline: calibration shift', () => {
  it('measures the scene shift after the picture moved and settled', async () => {
    const s = setup();
    await s.feed(2, () => room());
    s.main({ t: 'shift-ref' });
    await s.feed(2, () => room());
    s.main({ t: 'shift-measure', id: 7, timeoutMs: 6000 });
    // the camera turns right for a while (the scene moves left), then stops
    await s.feed(6, (i) => room({ offset: 0.02 * (i + 1) }));
    expect(s.of(s.toMain, 'shift')).toHaveLength(0);
    await s.feed(6, () => room({ offset: 0.12 }));
    const [r] = s.of(s.toMain, 'shift');
    expect(r.id).toBe(7);
    expect(r.dx).toBeLessThan(-0.08);
    expect(r.dx).toBeGreaterThan(-0.16);
    expect(Math.abs(r.dy)).toBeLessThan(0.03);
    expect(r.score).toBeGreaterThan(0.15);
    expect(r.settledMs).toBeGreaterThan(0);
  });

  it('a camera that did not move: answered after the minimum wait with ~0 shift', async () => {
    const s = setup();
    await s.feed(1, () => room());
    s.main({ t: 'shift-ref' });
    await s.feed(1, () => room());
    s.main({ t: 'shift-measure', id: 1, timeoutMs: 6000 });
    await s.feed(8, () => room());
    expect(s.of(s.toMain, 'shift')).toHaveLength(0);
    await s.feed(Math.ceil(SHIFT_MIN_WAIT_MS / 100), () => room());
    const [r] = s.of(s.toMain, 'shift');
    expect(Math.abs(r.dx)).toBeLessThan(0.01);
  });

  it('the camera reported a move: the late picture is waited for, past the minimum wait (video lag)', async () => {
    const s = setup();
    await s.feed(1, () => room());
    s.main({ t: 'shift-ref' });
    await s.feed(1, () => room());
    s.main({ t: 'shift-measure', id: 4, timeoutMs: 6000, expectMove: true });
    // the motor has stopped, but the video still shows the old view for 2.5 s
    await s.feed(Math.ceil(SHIFT_MIN_WAIT_MS / 100) + 10, () => room());
    expect(s.of(s.toMain, 'shift')).toHaveLength(0);
    await s.feed(6, () => room({ offset: 0.12 }));
    const [r] = s.of(s.toMain, 'shift');
    expect(r.id).toBe(4);
    expect(r.dx).toBeLessThan(-0.08);
    expect(r.score).toBeGreaterThan(0.15);
  });

  it('no frames: the timeout answers with score 0', async () => {
    const s = setup();
    s.main({ t: 'shift-ref' });
    s.main({ t: 'shift-measure', id: 2, timeoutMs: 1000 });
    s.clock.advance(1000);
    expect(s.of(s.toMain, 'shift')).toEqual([{ t: 'shift', id: 2, dx: 0, dy: 0, score: 0, settledMs: 1000 }]);
  });

  it('a featureless view gives a low score', async () => {
    const s = setup();
    await s.feed(1, () => room({ flat: true }));
    s.main({ t: 'shift-ref' });
    await s.feed(1, () => room({ flat: true }));
    s.main({ t: 'shift-measure', id: 3, timeoutMs: 6000 });
    await s.feed(20, () => room({ flat: true }));
    expect(s.of(s.toMain, 'shift')[0].score).toBeLessThan(0.15);
  });
});

describe('SecurityPipeline: flow control', () => {
  it('acknowledges the video chunks it has handled (every 4, or every 250 ms)', () => {
    const s = setup();
    for (let seq = 1; seq <= 10; seq++) s.main({ t: 'chunk', seq, gen: 0, key: seq === 1, ts: seq * 66_000, data: new ArrayBuffer(4) });
    expect(s.of(s.toMain, 'ack').map((m) => m.seq)).toEqual([1, 5, 9]);
    s.clock.advance(300);
    s.main({ t: 'chunk', seq: 11, gen: 0, key: false, ts: 11 * 66_000, data: new ArrayBuffer(4) });
    expect(s.of(s.toMain, 'ack').at(-1).seq).toBe(11);
    s.main({ t: 'chunk', gen: 0, key: false, ts: 0, data: new ArrayBuffer(4) }); // no seq (an old main): no ack
    expect(s.of(s.toMain, 'ack')).toHaveLength(4);
  });
});

describe('SecurityPipeline: ports', () => {
  it('a new port replaces the old one', () => {
    const s = setup();
    const next = { onmessage: null, postMessage() {}, start() {}, close() {} };
    s.p.attachPort(next);
    expect(s.port.closed).toBe(true);
    expect(typeof next.onmessage).toBe('function');
  });
});
