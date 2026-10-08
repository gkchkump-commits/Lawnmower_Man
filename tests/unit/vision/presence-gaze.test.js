// Presence state machine, eye-contact gaze and cursor priority, snapshot sizing, camera errors.
import { describe, expect, it, vi } from 'vitest';
import { PRESENCE_DEFAULTS, PresenceMachine } from '../../../src/vision/presence.js';
import { GAZE_DEFAULTS, GazeArbiter, faceGaze } from '../../../src/vision/gaze.js';
import { SNAPSHOT_MAX_SIDE, base64Of, fitSize } from '../../../src/vision/snapshot.js';
import { CameraCapture, cameraConstraints, describeCameraError, listCameras } from '../../../src/vision/camera.js';
import { detectSize, visionAssetUrls } from '../../../src/vision/face-tracker.js';
import { logLine } from '../../../src/vision/landmarker.js';

const MIN = 60_000;

describe('PresenceMachine', () => {
  it('nobody watched before the camera started: someone there right away is not "back"', () => {
    const p = new PresenceMachine({}, 0);
    expect(p.update(true, 300)).toEqual([{ type: 'back', awayMs: 300, welcome: false, greet: false }]);
    expect(p.update(true, 400)).toEqual([]);
  });

  it('away after 2 minutes while idle (once); back wakes with a welcome', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    expect(p.update(false, 1000, { idle: true })).toEqual([]);
    expect(p.update(false, 1000 + 2 * MIN - 1, { idle: true })).toEqual([]);
    expect(p.update(false, 1000 + 2 * MIN, { idle: true })).toEqual([{ type: 'away', awayMs: 2 * MIN }]);
    expect(p.update(false, 1000 + 3 * MIN, { idle: true })).toEqual([]); // once
    const back = p.update(true, 1000 + 4 * MIN, { idle: true, sleeping: true });
    expect(back).toEqual([{ type: 'back', awayMs: 4 * MIN, welcome: true, greet: false }]);
  });

  it('waits for the conversation to be idle before dozing off', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    p.update(false, 10);
    expect(p.update(false, 10 + 3 * MIN, { idle: false })).toEqual([]);
    expect(p.update(false, 10 + 3 * MIN + 500, { idle: true })).toEqual([{ type: 'away', awayMs: 3 * MIN + 500 }]);
  });

  it('a short absence is no welcome; an avatar that sleeps anyway is woken with one', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    p.update(false, 1000);
    expect(p.update(true, 31_000, { sleeping: false })[0]).toMatchObject({ welcome: false, greet: false });
    p.update(false, 40_000);
    expect(p.update(true, 50_000, { sleeping: true })[0]).toMatchObject({ welcome: true });
  });

  it('greets after ≥ 10 minutes away, at most every 30 minutes', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    p.update(false, 1000);
    const b1 = p.update(true, 1000 + 12 * MIN)[0];
    expect(b1).toMatchObject({ type: 'back', greet: true, welcome: true });
    p.markGreeted(1000 + 12 * MIN);
    p.update(false, 1000 + 13 * MIN);
    expect(p.update(true, 1000 + 25 * MIN)[0].greet).toBe(false); // rate limit
    p.update(false, 1000 + 26 * MIN);
    expect(p.update(true, 1000 + 44 * MIN)[0].greet).toBe(true);
    // the 10-minute threshold itself
    const q = new PresenceMachine({}, 0);
    q.update(true, 0);
    q.update(false, 0);
    expect(q.update(true, PRESENCE_DEFAULTS.greetAfterMs - 1)[0].greet).toBe(false);
  });

  it('the absence starts when the face was last seen, not when the tracker gave up on it', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    expect(p.update(false, 5000, { lastSeen: 3000 })).toEqual([]);
    expect(p.absentSince).toBe(3000);
    expect(p.update(false, 3000 + 2 * MIN, { idle: true, lastSeen: 3000 })).toEqual([{ type: 'away', awayMs: 2 * MIN }]);
    expect(p.update(true, 3000 + 11 * MIN)[0]).toMatchObject({ awayMs: 11 * MIN, greet: true });
    const q = new PresenceMachine({}, 0);
    q.update(false, 100, { lastSeen: -Infinity }); // never seen: from now
    expect(q.absentSince).toBe(0); // (reset at construction)
  });

  it('reset (camera restarted) forgets the absence', () => {
    const p = new PresenceMachine({}, 0);
    p.update(true, 0);
    p.update(false, 1000);
    p.reset(20 * MIN);
    expect(p.update(true, 20 * MIN + 200)[0]).toMatchObject({ welcome: false, greet: false });
  });
});

describe('faceGaze', () => {
  it('eye contact is about straight ahead; the face position only leans the eyes a little', () => {
    expect(faceGaze({ x: 0, y: 0 })).toEqual([0, 0]);
    const [x, y] = faceGaze({ x: 0.8, y: -0.5 });
    expect(x).toBeCloseTo(0.8 * GAZE_DEFAULTS.faceGainX);
    expect(y).toBeCloseTo(-0.5 * GAZE_DEFAULTS.faceGainY);
    expect(faceGaze({ x: 10, y: -10 }, { faceGainX: 1, faceGainY: 1 })).toEqual([1, -1]);
    expect(faceGaze({ x: NaN, y: undefined })).toEqual([0, 0]);
  });
});

/** A GazeArbiter on a fake clock; `run(ms)` advances time and fires due timers. */
function arbiter(o = {}) {
  let now = 0;
  const timers = [];
  const applied = [];
  const a = new GazeArbiter({
    apply: (t) => applied.push(t ? [...t] : null),
    now: () => now,
    rng: () => 0.5,
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    ...o,
  });
  const run = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  return { a, applied, run, at: () => now };
}

describe('GazeArbiter: cursor priority and eye contact', () => {
  it('without a face it behaves like plain cursor-follow: look, then release after the hold', () => {
    const { a, applied, run } = arbiter();
    a.cursor([0.5, -0.2]);
    expect(applied).toEqual([[0.5, -0.2]]);
    run(4000);
    a.cursor([0.5, -0.2]); // same target: not applied again, but the hold restarts
    run(4900);
    expect(applied).toEqual([[0.5, -0.2]]);
    run(200);
    expect(applied).toEqual([[0.5, -0.2], null]);
    a.cursor([0.1, 0.1], 1200); // pointer left the page: short hold
    run(1300);
    expect(applied.at(-1)).toBeNull();
  });

  it('with a face, a moving cursor wins for 1.5 s, then the gaze returns to the user', () => {
    const { a, applied, run } = arbiter();
    a.setFace([0.1, 0]);
    expect(applied.at(-1)).toEqual([0.1, 0]);
    expect(a.source).toBe('face');
    a.cursor([-0.7, 0.3]);
    expect(applied.at(-1)).toEqual([-0.7, 0.3]);
    expect(a.source).toBe('cursor');
    run(1000);
    a.cursor([-0.6, 0.3]); // still moving: keeps winning
    run(1400);
    expect(applied.at(-1)).toEqual([-0.6, 0.3]);
    run(200);
    expect(applied.at(-1)).toEqual([0.1, 0]);
    expect(a.source).toBe('face');
  });

  it('the face leaving hands the gaze back to the cursor hold or to idle', () => {
    const { a, applied, run } = arbiter();
    a.setFace([0.2, 0.1]);
    a.setFace(null);
    expect(applied.at(-1)).toBeNull();
    a.cursor([0.3, 0.3]);
    a.setFace([0.2, 0.1]);
    run(1600);
    expect(applied.at(-1)).toEqual([0.2, 0.1]);
    a.setFace(null); // the cursor's own 5 s hold has not run out: back to the cursor
    expect(applied.at(-1)).toEqual([0.3, 0.3]);
    run(3500);
    expect(applied.at(-1)).toBeNull();
  });

  it('eye contact is held for a few seconds, then broken by a short glance away, and so on', () => {
    const { a, applied, run } = arbiter();
    a.setFace([0, 0]);
    expect(a.source).toBe('face');
    const contact = GAZE_DEFAULTS.contactMinMs + 0.5 * (GAZE_DEFAULTS.contactMaxMs - GAZE_DEFAULTS.contactMinMs);
    const glance = GAZE_DEFAULTS.glanceMinMs + 0.5 * (GAZE_DEFAULTS.glanceMaxMs - GAZE_DEFAULTS.glanceMinMs);
    run(contact - 10);
    expect(a.source).toBe('face');
    run(20);
    expect(a.source).toBe('glance');
    expect(applied.at(-1)).toBeNull(); // the director's own small saccades meanwhile
    run(glance);
    expect(a.source).toBe('face');
    expect(applied.at(-1)).toEqual([0, 0]);
    // face updates within the contact phase are applied; tiny changes are not
    a.setFace([0.05, 0]);
    a.setFace([0.052, 0.001]);
    expect(applied.filter((t) => t && t[0] > 0.04)).toHaveLength(1);
  });

  it('reapply sends the current target again (a re-created avatar)', () => {
    const { a, applied } = arbiter();
    a.cursor([0.4, 0.2]);
    a.reapply();
    expect(applied).toEqual([[0.4, 0.2], [0.4, 0.2]]);
  });

  it('dispose stops its timer', () => {
    const clear = vi.fn();
    const { a } = arbiter({ clearTimeout: clear });
    a.cursor([0, 0]);
    a.dispose();
    expect(clear).toHaveBeenCalled();
  });
});

describe('snapshot sizing', () => {
  it('fits the longest side into 640 px and never upscales', () => {
    expect(SNAPSHOT_MAX_SIDE).toBe(640);
    expect(fitSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(fitSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(fitSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(fitSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(fitSize(4000, 3)).toEqual({ width: 640, height: 1 });
    expect(fitSize(0, 480)).toEqual({ width: 0, height: 0 });
    expect(fitSize(NaN, 480)).toEqual({ width: 0, height: 0 });
    expect(fitSize(640, 480, 160)).toEqual({ width: 160, height: 120 });
    expect(base64Of('data:image/jpeg;base64,/9j/AA==')).toBe('/9j/AA==');
  });
  it('detector frames are ~320 px wide', () => {
    expect(detectSize(640, 480)).toEqual({ width: 320, height: 240 });
    expect(detectSize(1280, 720)).toEqual({ width: 320, height: 180 });
    expect(detectSize(160, 120)).toEqual({ width: 160, height: 120 });
  });
  it('asset URLs resolve against the page (Vite and app://)', () => {
    expect(visionAssetUrls('app://lawnmower/index.html')).toEqual({
      wasmBase: 'app://lawnmower/assets/vision/wasm/',
      modelUrl: 'app://lawnmower/assets/vision/face_landmarker.task',
    });
    expect(visionAssetUrls('http://127.0.0.1:5173/index.html?mock=1').modelUrl).toBe('http://127.0.0.1:5173/assets/vision/face_landmarker.task');
  });
});

describe('MediaPipe log routing', () => {
  it('routine glog / TFLite lines go to debug, real errors to warn, never console.error', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logLine('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.', true);
      logLine('W1008 12:21:17.823000 2172416 face_landmarker_graph.cc:180] Sets acceleration', true);
      logLine('Graph successfully started running.', false);
      logLine('E1008 12:00:00.000000 1 calculator_graph.cc:1] Something broke', true);
      logLine('   ', true);
      expect(debug).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('camera errors → what to do', () => {
  it('maps getUserMedia errors to helpful cards (Windows wording)', () => {
    const denied = describeCameraError({ name: 'NotAllowedError', message: 'Permission denied' }, 'win32');
    expect(denied.kind).toBe('denied');
    expect(denied.steps.join(' ')).toMatch(/Privacy & security › Camera/);
    expect(denied.steps.join(' ')).toMatch(/Let desktop apps access your camera/);
    expect(denied.detail).toBe('Permission denied');
    const busy = describeCameraError({ name: 'NotReadableError', message: 'Could not start video source' }, 'win32');
    expect(busy.kind).toBe('busy');
    expect(busy.steps[0]).toMatch(/Teams, Zoom/);
    expect(describeCameraError({ name: 'AbortError' }).kind).toBe('busy');
    expect(describeCameraError({ name: 'NotFoundError' }).kind).toBe('none');
    expect(describeCameraError({ name: 'OverconstrainedError' }).kind).toBe('none');
    expect(describeCameraError({ name: 'NoFramesError' }).kind).toBe('frames');
    expect(describeCameraError({ name: 'NotSupportedError' }).kind).toBe('unsupported');
    expect(describeCameraError(new Error('weird')).kind).toBe('unknown');
    expect(describeCameraError({ name: 'NotAllowedError' }, 'darwin').steps[0]).toMatch(/System Settings/);
    expect(describeCameraError({ name: 'NotAllowedError' }, 'linux').steps[0]).not.toMatch(/Windows/);
  });
});

describe('CameraCapture', () => {
  function fakeMedia({ fail = [], devices = [] } = {}) {
    const tracks = [];
    const md = {
      calls: [],
      async getUserMedia(c) {
        md.calls.push(c);
        const f = fail.shift();
        if (f) throw Object.assign(new Error(f), { name: f });
        const listeners = {};
        const track = {
          readyState: 'live',
          label: 'Integrated Webcam',
          stop: vi.fn(() => { track.readyState = 'ended'; }),
          getSettings: () => ({ deviceId: c.video.deviceId?.exact || 'default-cam' }),
          addEventListener: (ev, cb) => { listeners[ev] = cb; },
          fire: (ev) => listeners[ev]?.(),
        };
        tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track] };
      },
      async enumerateDevices() {
        return devices;
      },
    };
    const doc = { createElement: () => ({ setAttribute() {}, play: async () => {}, pause() {}, srcObject: null }) };
    return { md, doc, tracks };
  }

  it('opens the chosen camera at ~640x480, video only; stop releases it', async () => {
    const { md, doc, tracks } = fakeMedia();
    const cam = new CameraCapture({ mediaDevices: /** @type {any} */ (md), doc: /** @type {any} */ (doc) });
    await cam.start('cam-2');
    expect(md.calls[0]).toEqual(cameraConstraints('cam-2'));
    expect(md.calls[0]).toMatchObject({ audio: false, video: { deviceId: { exact: 'cam-2' }, width: { ideal: 640 }, height: { ideal: 480 } } });
    expect(cameraConstraints('').video.deviceId).toBeUndefined();
    expect(cam.running).toBe(true);
    expect(cam.label).toBe('Integrated Webcam');
    expect(cam.video.srcObject).toBeTruthy();
    cam.stop();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(cam.running).toBe(false);
    expect(cam.video).toBeNull();
  });

  it('falls back to the default camera when the saved one is gone; reports a track that ends', async () => {
    const { md, doc, tracks } = fakeMedia({ fail: ['OverconstrainedError'] });
    const cam = new CameraCapture({ mediaDevices: /** @type {any} */ (md), doc: /** @type {any} */ (doc) });
    const fell = vi.fn();
    const ended = vi.fn();
    cam.on('device-fallback', fell);
    cam.on('ended', ended);
    await cam.start('unplugged');
    expect(md.calls.map((c) => c.video.deviceId?.exact)).toEqual(['unplugged', undefined]);
    expect(fell).toHaveBeenCalledWith('unplugged');
    tracks[0].fire('ended');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a denied camera is not retried with another device', async () => {
    const { md, doc } = fakeMedia({ fail: ['NotAllowedError'] });
    const cam = new CameraCapture({ mediaDevices: /** @type {any} */ (md), doc: /** @type {any} */ (doc) });
    await expect(cam.start('cam-2')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(md.calls).toHaveLength(1);
    const none = new CameraCapture({ mediaDevices: undefined, doc: /** @type {any} */ (doc) });
    none._md = null;
    await expect(none.start()).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('lists cameras for the picker (no labels before permission)', async () => {
    const { md } = fakeMedia({ devices: [
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
      { kind: 'videoinput', deviceId: 'a', label: 'Integrated Webcam' },
      { kind: 'videoinput', deviceId: 'b', label: '' },
      { kind: 'videoinput', deviceId: 'default', label: 'Default' },
    ] });
    expect(await listCameras(/** @type {any} */ (md))).toEqual([{ id: 'a', label: 'Integrated Webcam' }, { id: 'b', label: 'Camera 2' }]);
    expect(await listCameras(undefined)).toEqual([]);
  });
});
