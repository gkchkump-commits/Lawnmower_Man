// Face tracker worker (module worker): runs the MediaPipe Face Landmarker off the main thread,
// so the hologram keeps its 60 fps. Protocol (all messages are plain objects):
//
//   main → worker  { type: 'init', wasmBase, modelUrl, delegate? }
//                  { type: 'frame', id, image: VideoFrame|ImageBitmap (transferred), width, height, t }
//                  { type: 'close' }
//   worker → main  { type: 'ready', delegate, ms }            the model is loaded
//                  { type: 'result', id, obs: FaceObservation|null, ms }
//                  { type: 'error', message, fatal }
//
// Frames are processed one at a time; the main thread sends the next one only after the result
// of the previous one (back-pressure), so a slow machine just gets fewer detections.

/* global self, createImageBitmap, VideoFrame */
import { createFaceEngine } from './landmarker.js';
import { detectSize } from './frame-size.js';

/** @type {import('./landmarker.js').FaceEngine|null} */
let engine = null;
/** @type {Promise<void>|null} */
let starting = null;

/** @param {any} msg @param {Transferable[]} [transfer] */
const post = (msg, transfer) => /** @type {any} */ (self).postMessage(msg, transfer || []);

/**
 * MediaPipe needs pixels it can upload: a VideoFrame (camera formats like NV12/I420) is first
 * turned into a small RGBA ImageBitmap — here in the worker, so the wait for the GPU process
 * never blocks the main thread.
 * @param {any} image @param {number} width @param {number} height
 */
async function toBitmap(image, width, height) {
  if (typeof VideoFrame !== 'function' || !(image instanceof VideoFrame)) return { image, width, height };
  const size = detectSize(width, height);
  try {
    const bmp = await createImageBitmap(image, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
    return { image: bmp, width: size.width, height: size.height };
  } finally {
    image.close();
  }
}

self.addEventListener('message', async (e) => {
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
    if (!engine) {
      msg.image?.close?.();
      post({ type: 'result', id: msg.id, obs: null, ms: 0, skipped: true });
      return;
    }
    const t0 = performance.now();
    /** @type {any} */
    let frame = null;
    try {
      frame = await toBitmap(msg.image, msg.width, msg.height);
      const obs = engine.detect(frame.image, frame.width, frame.height, msg.t);
      post({ type: 'result', id: msg.id, obs, ms: Math.round((performance.now() - t0) * 10) / 10 });
    } catch (err) {
      post({ type: 'error', message: String(/** @type {any} */ (err)?.message || err), fatal: false, id: msg.id });
    } finally {
      (frame?.image || msg.image)?.close?.(); // camera frames hold capture buffers: free them at once
    }
  } else if (msg.type === 'close') {
    engine?.close();
    engine = null;
    self.close();
  }
});
