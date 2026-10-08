// Face tracker worker (module worker): runs the MediaPipe Face Landmarker off the main thread,
// so the hologram keeps its 60 fps. Protocol (all messages are plain objects):
//
//   main → worker  { type: 'init', wasmBase, modelUrl, delegate? }
//                  { type: 'frame', id, bitmap: ImageBitmap (transferred), width, height, t }
//                  { type: 'close' }
//   worker → main  { type: 'ready', delegate, ms }            the model is loaded
//                  { type: 'result', id, obs: FaceObservation|null, ms }
//                  { type: 'error', message, fatal }
//
// Frames are processed one at a time; the main thread sends the next one only after the result
// of the previous one (back-pressure), so a slow machine just gets fewer detections.

/* global self */
import { createFaceEngine } from './landmarker.js';

/** @type {import('./landmarker.js').FaceEngine|null} */
let engine = null;
/** @type {Promise<void>|null} */
let starting = null;

/** @param {any} msg @param {Transferable[]} [transfer] */
const post = (msg, transfer) => /** @type {any} */ (self).postMessage(msg, transfer || []);

self.addEventListener('message', (e) => {
  const msg = /** @type {any} */ (e).data || {};
  if (msg.type === 'init') {
    if (starting) return;
    const t0 = performance.now();
    starting = createFaceEngine({ wasmBase: msg.wasmBase, modelUrl: msg.modelUrl, delegate: msg.delegate })
      .then((eng) => {
        engine = eng;
        post({ type: 'ready', delegate: eng.delegate, ms: Math.round(performance.now() - t0) });
      })
      .catch((err) => post({ type: 'error', message: String(err?.message || err), fatal: true }));
  } else if (msg.type === 'frame') {
    const bitmap = msg.bitmap;
    if (!engine) {
      bitmap?.close?.();
      post({ type: 'result', id: msg.id, obs: null, ms: 0, skipped: true });
      return;
    }
    const t0 = performance.now();
    try {
      const obs = engine.detect(bitmap, msg.width, msg.height, msg.t);
      post({ type: 'result', id: msg.id, obs, ms: Math.round((performance.now() - t0) * 10) / 10 });
    } catch (err) {
      post({ type: 'error', message: String(/** @type {any} */ (err)?.message || err), fatal: false, id: msg.id });
    } finally {
      bitmap?.close?.();
    }
  } else if (msg.type === 'close') {
    engine?.close();
    engine = null;
    self.close();
  }
});
