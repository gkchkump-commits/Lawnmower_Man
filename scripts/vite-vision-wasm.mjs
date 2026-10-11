// Vite plugin: the MediaPipe Tasks Vision WebAssembly runtime (face tracking, src/vision/) is
// served from node_modules in development and copied into dist/assets/vision/wasm/ by the build,
// so the app never loads a CDN at runtime (CSP, offline) and the ~13 MB wasm is not committed.
//
// Only the ES-module build of the runtime is used (vision_wasm_module_internal.*): src/vision
// imports its loader with a dynamic import() in a module worker (or, as a fallback, on the main
// thread), which works under the app's CSP (script-src 'self' 'wasm-unsafe-eval').

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** URL path (relative to the app root) the renderer loads the runtime from. */
export const VISION_WASM_DIR = 'assets/vision/wasm';
/** The files of @mediapipe/tasks-vision/wasm that the app needs. */
export const VISION_WASM_FILES = Object.freeze(['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']);

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };

/** The package's wasm/ folder. @param {string} root project root */
export function visionWasmSourceDir(root) {
  const require = createRequire(path.join(root, 'package.json'));
  // the package's "exports" maps ./vision_wasm_module_internal.js to wasm/…; resolve that
  return path.dirname(require.resolve('@mediapipe/tasks-vision/vision_wasm_module_internal.js'));
}

/**
 * @param {{ root: string }} o
 * @returns {import('vite').Plugin}
 */
export function visionWasm(o) {
  let srcDir = '';
  const source = () => (srcDir ||= visionWasmSourceDir(o.root));
  return {
    name: 'lawnmower-vision-wasm',
    configureServer(server) {
      const prefix = `/${VISION_WASM_DIR}/`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith(prefix)) return next();
        const name = url.slice(prefix.length);
        if (!VISION_WASM_FILES.includes(name)) return next();
        const file = path.join(source(), name);
        res.setHeader('Content-Type', TYPES[/** @type {'.js'|'.wasm'} */ (path.extname(name))]);
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).on('error', next).pipe(res);
      });
    },
    generateBundle() {
      for (const name of VISION_WASM_FILES) {
        this.emitFile({ type: 'asset', fileName: `${VISION_WASM_DIR}/${name}`, source: fs.readFileSync(path.join(source(), name)) });
      }
    },
  };
}
