// Where the wake-word engine's files are (contract-wake §7.8). Pure Node (fs injectable).
//
//   wake dir:  env.LAWNMOWER_WAKE_DIR  >  packaged: <resources>/wake  >  <appRoot>/vendor/wake
//   addon:     <wake>/sherpa-onnx/<platform>-<arch>/sherpa-onnx.node (+ its DLLs / .so files)
//   model B:   <wake>/models/gigaspeech-3.3m/{encoder.int8.onnx, decoder.onnx, joiner.int8.onnx, tokens.txt}
//   VAD:       <wake>/models/silero_vad.onnx
//   model A:   env.LAWNMOWER_WAKE_ZHEN_DIR  >  <voice models>/kws/zh-en-3m (the voice downloader's folder)
//              >  unpackaged only: <wake>/dev-models/zh-en-3m (npm run fetch:wake -- --with-zhen)
// checkFiles() compares presence and exact sizes with electron/wake/config.js (the fetch step
// verified the hashes).

import nodeFs from 'node:fs';
import path from 'node:path';

import { ADDON_FILES, LAYOUT, MODEL_FILES } from './config.js';

/** @param {string} [platform] @param {string} [arch] */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * @param {{ isPackaged: boolean, resourcesPath?: string, appRoot: string, env?: Record<string, string|undefined> }} o
 */
export function resolveWakeDir(o) {
  const env = o.env || {};
  if (env.LAWNMOWER_WAKE_DIR && env.LAWNMOWER_WAKE_DIR.trim()) return path.resolve(env.LAWNMOWER_WAKE_DIR.trim());
  if (o.isPackaged && o.resourcesPath) return path.join(o.resourcesPath, 'wake');
  return path.join(o.appRoot, 'vendor', 'wake');
}

/** @param {string} wakeDir @param {string} [key] platformKey() */
export function addonPath(wakeDir, key = platformKey()) {
  return path.join(wakeDir, ...LAYOUT.addonDir(key).split('/'), 'sherpa-onnx.node');
}

/**
 * Model file paths in `dir` (by role). @param {string} dir @param {'giga'|'zhen'} which
 * @returns {{ encoder: string, decoder: string, joiner: string, tokens: string }}
 */
export function modelFiles(dir, which) {
  /** @type {any} */
  const out = {};
  for (const f of MODEL_FILES[which]) out[/** @type {string} */ (f.role)] = path.join(dir, f.name);
  return out;
}

/** @param {string} wakeDir */
export function enginePaths(wakeDir, key = platformKey()) {
  return {
    addon: addonPath(wakeDir, key),
    giga: modelFiles(path.join(wakeDir, ...LAYOUT.gigaDir.split('/')), 'giga'),
    vad: path.join(wakeDir, ...LAYOUT.vad.split('/')),
  };
}

/**
 * @param {string} file @param {number} size @param {Pick<typeof nodeFs, 'statSync'>} fs
 */
function sizeOk(file, size, fs) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size === size;
  } catch {
    return false;
  }
}

/**
 * Are the shipped engine files there (addon for this platform, model B, the VAD)?
 * @param {string} wakeDir
 * @param {{ key?: string, fs?: Pick<typeof nodeFs, 'statSync'> }} [o]
 * @returns {{ ok: boolean, missing: string[], platformSupported: boolean }}
 */
export function checkFiles(wakeDir, o = {}) {
  const key = o.key || platformKey();
  const fs = o.fs || nodeFs;
  const addon = /** @type {any} */ (ADDON_FILES)[key];
  /** @type {string[]} */
  const missing = [];
  if (!addon) missing.push(`${LAYOUT.addonDir(key)} (no wake-word engine for ${key})`);
  else for (const f of addon) if (!sizeOk(path.join(wakeDir, ...LAYOUT.addonDir(key).split('/'), f.name), f.size, fs)) missing.push(`${LAYOUT.addonDir(key)}/${f.name}`);
  for (const f of MODEL_FILES.giga) if (!sizeOk(path.join(wakeDir, ...LAYOUT.gigaDir.split('/'), f.name), f.size, fs)) missing.push(`${LAYOUT.gigaDir}/${f.name}`);
  if (!sizeOk(path.join(wakeDir, ...LAYOUT.vad.split('/')), MODEL_FILES.vad.size, fs)) missing.push(LAYOUT.vad);
  return { ok: missing.length === 0, missing, platformSupported: !!addon };
}

/**
 * Is model A complete in `dir`? @param {string} dir @param {{ fs?: Pick<typeof nodeFs, 'statSync'> }} [o]
 */
export function checkZhen(dir, o = {}) {
  const fs = o.fs || nodeFs;
  return !!dir && MODEL_FILES.zhen.every((f) => sizeOk(path.join(dir, f.name), f.size, fs));
}

/**
 * Model A's folder candidates, in order (the first complete one is used).
 * @param {{ env?: Record<string, string|undefined>, isPackaged: boolean, wakeDir: string, voiceModelsDir?: string|null }} o
 * @returns {string[]}
 */
export function zhenCandidates(o) {
  const env = o.env || {};
  const out = [];
  if (env.LAWNMOWER_WAKE_ZHEN_DIR && env.LAWNMOWER_WAKE_ZHEN_DIR.trim()) return [path.resolve(env.LAWNMOWER_WAKE_ZHEN_DIR.trim())];
  if (o.voiceModelsDir) out.push(path.join(o.voiceModelsDir, ...LAYOUT.zhenUserDir.split('/')));
  if (!o.isPackaged) out.push(path.join(o.wakeDir, ...LAYOUT.zhenDevDir.split('/')));
  return out;
}

/**
 * The first complete model A folder, or null.
 * @param {{ env?: Record<string, string|undefined>, isPackaged: boolean, wakeDir: string, voiceModelsDir?: string|null, fs?: Pick<typeof nodeFs, 'statSync'> }} o
 */
export function zhenDir(o) {
  for (const d of zhenCandidates(o)) if (checkZhen(d, { fs: o.fs })) return d;
  return null;
}
