// The "Jade wake word" utility opens no sockets and starts no processes (contract-wake §2.3).
// Electron's utilityProcess has no OS sandbox option and ignores Node's --permission flags, so
// this module, imported first by utility/main.js, refuses the Node modules that could reach the
// network or run something else, and removes the network globals, before anything else loads.
// (An in-process guard: code that can load a native addon could still get around it; the vendored
// sherpa-onnx addon is pinned by SHA-256 and does no networking.)

import module from 'node:module';

/** Node built-ins the wake-word process never needs. */
export const BLOCKED_MODULES = Object.freeze(['net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns', 'child_process', 'cluster', 'worker_threads', 'inspector']);

const blocked = new Set(BLOCKED_MODULES);

/** @param {string} specifier */
export function isBlocked(specifier) {
  const name = String(specifier).replace(/^node:/, '').split('/')[0];
  return blocked.has(name);
}

let installed = false;

/** Install the guard (idempotent). @returns {boolean} whether the module hooks are in place */
export function lockdown() {
  if (installed) return true;
  installed = true;
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, next) {
        if (isBlocked(specifier)) throw new Error(`the wake-word process may not use ${specifier}`);
        return next(specifier, context);
      },
    });
  } else {
    installed = false;
  }
  for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    try { delete /** @type {any} */ (globalThis)[k]; } catch { /* not configurable */ }
  }
  const proc = /** @type {any} */ (process);
  for (const k of ['binding', '_linkedBinding']) {
    try { proc[k] = () => { throw new Error(`the wake-word process may not use process.${k}`); }; } catch { /* read-only */ }
  }
  return installed;
}

// in the utility process (Electron gives it a parentPort) at once, before the other imports run;
// elsewhere (tests, tools) only when lockdown() is called
if (/** @type {any} */ (process).parentPort) lockdown();
