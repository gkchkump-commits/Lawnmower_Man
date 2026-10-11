// The Home camera's person detector (contract §9.4): MediaPipe ObjectDetector with the bundled
// EfficientDet-Lite0 int8 model (public/assets/security/), on the CPU (XNNPACK) in the security
// worker, restricted to COCO "person". Loaded exactly like the face tracker
// (src/vision/landmarker.js): the ES-module wasm loader is imported here and handed to MediaPipe
// as its factory, so nothing comes from a CDN and it works under the app's CSP. Main sends the
// absolute wasm and model URLs in the worker's `hello` (the page lives in /tapo/, one folder
// below the assets).

import { ObjectDetector } from '@mediapipe/tasks-vision';
import { WASM_BINARY, WASM_LOADER } from '../../vision/assets.js';
import { logLine } from '../../vision/landmarker.js';
import { clampBox } from '../geometry.js';

export const DETECTOR_OPTIONS = Object.freeze({ scoreThreshold: 0.3, maxResults: 5 });

/**
 * @typedef {object} PersonDetector
 * @property {(image: any, width: number, height: number, timestampMs: number) => Array<{ score: number, box: [number, number, number, number] }>} detect
 * @property {() => void} close
 * @property {string} kind
 */

/**
 * MediaPipe's detections → persons with boxes in 0..1 of the input picture.
 * @param {any} result ObjectDetectorResult @param {number} width @param {number} height
 */
export function personsFromResult(result, width, height) {
  const out = [];
  for (const d of result?.detections || []) {
    const cat = (d.categories || []).find((c) => (c.categoryName || c.displayName) === 'person') || null;
    const bb = d.boundingBox;
    if (!cat || !bb || !(width > 0) || !(height > 0)) continue;
    const score = Number(cat.score);
    if (!Number.isFinite(score)) continue;
    out.push({ score: Math.round(score * 1000) / 1000, box: clampBox([bb.originX / width, bb.originY / height, bb.width / width, bb.height / height]) });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * @param {{ wasmBase: string, modelUrl: string }} o  wasmBase ends with /
 * @returns {Promise<PersonDetector>}
 */
export async function createPersonDetector(o) {
  const base = o.wasmBase.endsWith('/') ? o.wasmBase : `${o.wasmBase}/`;
  const mod = await import(/* @vite-ignore */ `${base}${WASM_LOADER}`);
  /** @type {any} */ (globalThis).ModuleFactory = mod.default || /** @type {any} */ (globalThis).ModuleFactory;
  /** @type {any} */ (globalThis).Module = { print: (/** @type {string} */ t) => logLine(t, false), printErr: (/** @type {string} */ t) => logLine(t, true) };
  /** @type {any} */ (globalThis).custom_dbg = (/** @type {string} */ t) => logLine(t, false);
  const detector = await ObjectDetector.createFromOptions(
    { wasmLoaderPath: '', wasmBinaryPath: `${base}${WASM_BINARY}` },
    {
      baseOptions: { modelAssetPath: o.modelUrl, delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: DETECTOR_OPTIONS.scoreThreshold,
      maxResults: DETECTOR_OPTIONS.maxResults,
      categoryAllowlist: ['person'],
    },
  );
  let lastTs = -1;
  return {
    kind: 'mediapipe',
    detect(image, width, height, timestampMs) {
      // VIDEO mode needs strictly increasing timestamps
      const ts = Math.max(Math.round(timestampMs), lastTs + 1);
      lastTs = ts;
      return personsFromResult(detector.detectForVideo(image, ts), width, height);
    },
    close() {
      try {
        detector.close();
      } catch { /* already closed */ }
    },
  };
}
