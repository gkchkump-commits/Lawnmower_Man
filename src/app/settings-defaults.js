// Renderer-side copy of the settings defaults (contract §4) plus small helpers.
//
// The authoritative store lives in the Electron main process (electron/settings.js, which
// validates every patch). The renderer only needs the defaults to fill gaps (e.g. an older
// main process that lacks a field), to drive the mock bridge, and to build the settings drawer.

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

export const DEFAULT_SETTINGS = Object.freeze({
  claude: {
    cliPath: '',
    model: '',
    effort: '',
    mode: 'chat',
    workdir: '',
    persona: '',
    resumeLastSession: true,
    lastSessionId: '',
  },
  voice: {
    enabled: true,
    pythonPath: '',
    sttModel: 'large-v3-turbo',
    sttLanguage: 'en',
    ttsVoice: 'af_heart',
    ttsSpeed: 1.0,
    systemVoice: '',
    device: 'auto',
    handsFree: false,
    speakReplies: true,
    character: 'synth', // the local voice's character: 'natural' | 'synth' | 'vocoder' | 'robot'
    fxAmount: 0.6,
    lipSyncOffsetMs: 0, // the mouth's timing against the voice (ms, + = later), both voices
  },
  avatar: {
    renderer: 'relief',
    pack: 'reference',
    quality: 'high',
    particles: 1.0,
    bloom: 1.0,
    followCursor: true,
    expressiveness: 1.0,
    liveliness: 1.0,
    projector: false,
  },
  window: {
    sizePreset: 'medium',
    avatarWidth: null, // a free size from resizing (px), null = the preset
    alwaysOnTop: true,
    clickThrough: true,
    position: /** @type {{x:number,y:number}|null} */ (null),
    showChat: true,
    skipTaskbar: false,
    lockPosition: false,
    snapToEdges: true,
  },
  hotkeys: {
    toggleListen: 'CommandOrControl+Alt+Space',
    toggleChat: 'CommandOrControl+Alt+C',
    stopSpeaking: 'CommandOrControl+Alt+X',
  },
  camera: {
    enabled: false,
    deviceId: '',
    followFace: true,
    presence: true,
    mirrorExpressions: true,
    shareWithClaude: false,
    greeting: 'hello', // 'off' | 'hello' (quick spoken hello) | 'claude' (Claude says hello)
    lookToTalk: false,
  },
});

/** @param {unknown} v @returns {v is Record<string, any>} */
export function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** @template T @param {T} v @returns {T} */
export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Deep-merge `patch` into a copy of `base`. Plain objects merge recursively; anything else
 * (null, arrays, primitives) replaces. Prototype-polluting keys are ignored.
 * @template T
 * @param {T} base
 * @param {unknown} patch
 * @returns {T}
 */
export function deepMerge(base, patch) {
  const out = /** @type {any} */ (clone(base) ?? {});
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

/**
 * Fill missing groups/fields of a settings object from the defaults (unknown extra fields are
 * kept so newer main processes can add settings without breaking the renderer).
 * @param {unknown} s
 * @returns {Settings}
 */
export function withDefaults(s) {
  return deepMerge(DEFAULT_SETTINGS, isPlainObject(s) ? s : {});
}

/**
 * Read a nested value by dotted path ("voice.ttsSpeed").
 * @param {Record<string, any>} obj @param {string} path
 */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Build a patch object for a dotted path: patchFor('voice.ttsSpeed', 1.2) → {voice:{ttsSpeed:1.2}}.
 * @param {string} path @param {unknown} value
 */
export function patchFor(path, value) {
  const keys = path.split('.');
  /** @type {Record<string, any>} */
  const root = {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = cur[k] = {};
  });
  return root;
}
