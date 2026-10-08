// The MediaPipe Face Landmarker, wrapped for src/vision: loads the bundled ES-module wasm
// runtime and the committed model (no CDN, works under the app's CSP), and turns each frame into
// a compact FaceObservation (src/vision/attention.js). Used by the tracker worker
// (face-worker.js) and, when a worker cannot run it, by the main-thread fallback.
//
// The wasm runtime is copied from node_modules by scripts/vite-vision-wasm.mjs.

import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { WASM_BINARY, WASM_LOADER } from './assets.js';
import { summarizeFaceResult } from './attention.js';

/**
 * @typedef {object} FaceEngine
 * @property {(image: any, width: number, height: number, timestampMs: number) => import('./attention.js').FaceObservation|null} detect
 * @property {() => void} close
 * @property {string} delegate
 */

/**
 * @param {{ wasmBase: string, modelUrl: string, delegate?: 'CPU'|'GPU' }} o
 *   wasmBase: absolute URL of the folder with the wasm runtime (ends with /)
 * @returns {Promise<FaceEngine>}
 */
export async function createFaceEngine(o) {
  const base = o.wasmBase.endsWith('/') ? o.wasmBase : `${o.wasmBase}/`;
  // MediaPipe would load its loader itself (importScripts, or a <script> tag on the main thread,
  // which cannot run an ES module). Import it here instead and hand MediaPipe the factory; an
  // empty wasmLoaderPath makes it use the global factory as is.
  const mod = await import(/* @vite-ignore */ `${base}${WASM_LOADER}`);
  /** @type {any} */ (globalThis).ModuleFactory = mod.default || /** @type {any} */ (globalThis).ModuleFactory;
  // MediaPipe's own logging (glog lines and TFLite notices on stderr) would land in
  // console.error; route it by severity instead. MediaPipe uses a global Module as the factory
  // argument when there is one (and clears it afterwards).
  /** @type {any} */ (globalThis).Module = { print: (/** @type {string} */ t) => logLine(t, false), printErr: (/** @type {string} */ t) => logLine(t, true) };
  // its glog warnings go through a global hook the loader points at console.warn
  /** @type {any} */ (globalThis).custom_dbg = (/** @type {string} */ t) => logLine(t, false);
  const delegate = o.delegate === 'GPU' ? 'GPU' : 'CPU';
  const landmarker = await FaceLandmarker.createFromOptions(
    { wasmLoaderPath: '', wasmBinaryPath: `${base}${WASM_BINARY}` },
    {
      baseOptions: { modelAssetPath: o.modelUrl, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    },
  );
  let lastTs = -1;
  return {
    delegate,
    detect(image, width, height, timestampMs) {
      // VIDEO mode needs strictly increasing timestamps
      const ts = Math.max(Math.round(timestampMs), lastTs + 1);
      lastTs = ts;
      const result = landmarker.detectForVideo(image, ts);
      return summarizeFaceResult(result, width, height);
    },
    close() {
      try {
        landmarker.close();
      } catch { /* already closed */ }
    },
  };
}

/**
 * MediaPipe log line → console at a fitting level: glog "I…"/"W…" lines and TFLite "INFO:"
 * notices are routine (debug); "E…"/"F…" and anything else on stderr is worth a warning.
 * @param {string} text @param {boolean} stderr
 */
export function logLine(text, stderr) {
  const t = String(text ?? '');
  if (!t.trim()) return;
  const routine = /^[IW]\d{4} /.test(t) || /^INFO: /.test(t) || !stderr;
  if (routine) console.debug(`[mediapipe] ${t}`);
  else console.warn(`[mediapipe] ${t}`);
}
