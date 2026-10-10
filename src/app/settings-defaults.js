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
  },
  avatar: {
    renderer: 'relief',
    pack: 'reference',
    quality: 'high',
    particles: 1.0,
    bloom: 1.0,
    followCursor: true,
    expressiveness: 1.0,
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
  // ---- Home camera (Tapo pan/tilt camera + home security; docs/TAPO.md) ---------------------
  // Mirror of electron/settings.js; main validates every value. The camera password is never a
  // setting (main keeps it encrypted, the renderer never sees it).
  tapo: {
    enabled: false, // the whole feature: camera window, video component, ONVIF
    name: 'camera', // spoken/display name ("front door camera")
    host: '', // '' or the camera's LAN address (IP or name, never a URL)
    onvifPort: 2020,
    rtspPort: 554,
    username: '', // the Tapo Camera Account user (not secret)
    stream: 'stream1', // 'stream1' | 'stream2'
    ptz: 'auto', // 'auto' | 'relative' | 'continuous' | 'off'
    invertPan: false,
    invertTilt: false,
    stepSmall: 0.15, // nudge sizes as fractions of the view
    stepMedium: 0.35,
    stepLarge: 0.75,
    viewUnitsX: 0.5, // ONVIF units that turn the view by one width / height (calibration)
    viewUnitsY: 1.4,
    minStep: 0.05,
    holdSpeed: 0.5,
    msPerUnit: 6000,
    homePreset: '', // a preset token; '' = AbsoluteMove(0,0) when supported
    localPresets: /** @type {Array<{ name: string, x: number, y: number }>} */ ([]),
    calibratedAt: '', // ISO time of the last calibration, '' = never
    windowBounds: /** @type {{x:number,y:number,width:number,height:number}|null} */ (null),
    windowOnTop: false,
    showDetections: false, // person boxes in the live view while disarmed
  },
  security: {
    armed: false, // persisted: an armed app re-arms after a restart
    armDelaySec: 30, // exit delay after arming in the app
    people: true,
    motion: true,
    notify: 'person', // 'person' | 'motion' | 'off'
    record: 'person', // 'person' | 'motion' | 'off'
    preRollSec: 5,
    postRollSec: 10,
    maxClipSec: 120,
    retentionDays: 7,
    maxStorageGB: 5,
    clipsDir: '', // '' = <Videos>/Lawnmower Man/Security
    sensitivity: 'medium', // 'low' | 'medium' | 'high'
    cameraEvents: true,
    confirmLocally: true,
    cooldownSec: 60,
    quietHours: '', // '' | 'HH:MM-HH:MM'
    announce: true, // the avatar says it
    showOnAlert: true,
    describe: false, // Claude describes the alert snapshot (consent card first)
    claudeSee: 'ask', // 'ask' | 'always' | 'never'  camera_snapshot
    claudeMove: 'ask', // 'ask' | 'always' | 'never'  camera_look
    voiceCommands: true, // "camera left", "arm the camera" run locally, without a Claude turn
    startAtLogin: false, // start with Windows (hidden): an armed alarm comes back after a restart
    startAtLoginOffered: false,
  },
  // ---- end Home camera -----------------------------------------------------------------------
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
