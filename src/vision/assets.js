// Where the face tracker's files are (served from public/assets/vision/ and, for the wasm
// runtime, copied from node_modules by scripts/vite-vision-wasm.mjs). Kept apart from
// landmarker.js so the main bundle does not pull in MediaPipe until the camera is used.

export const WASM_LOADER = 'vision_wasm_module_internal.js';
export const WASM_BINARY = 'vision_wasm_module_internal.wasm';
export const MODEL_FILE = 'face_landmarker.task';

/**
 * Absolute URLs of the vision assets, relative to the page (works under Vite and app://).
 * @param {string} [baseHref] document.baseURI
 */
export function visionAssetUrls(baseHref = globalThis.document?.baseURI || globalThis.location?.href || '') {
  return {
    wasmBase: new URL('./assets/vision/wasm/', baseHref).href,
    modelUrl: new URL(`./assets/vision/${MODEL_FILE}`, baseHref).href,
  };
}
