// Settings store: defaults (contract §4), schema validation/sanitization, deep merge,
// atomic persistence and change events. Pure Node — no Electron import; the caller injects the
// directory (app.getPath('userData') in the app, a temp dir in tests).

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import path from 'node:path';

import { normalizeAvatarWidth } from './window-manager.js';
import { validateHostSetting } from './tapo/host.js';

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

export const DEFAULT_SETTINGS = Object.freeze({
  claude: {
    cliPath: '', // '' = auto-detect
    model: '', // '' = CLI default; e.g. 'sonnet', 'opus'
    effort: '', // '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    mode: 'chat', // 'chat' | 'assistant' | 'agent'
    workdir: '', // '' = <home>/LawnmowerMan (created on demand)
    persona: '', // '' = built-in persona (electron/persona.js); else custom text
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
    systemVoice: '', // system (Web Speech) voice name/URI when the local voice is not running; '' = best English voice
    device: 'auto', // 'auto' | 'cuda' | 'cpu'
    handsFree: false,
    speakReplies: true,
    // the local voice's character (src/audio/voicefx.js; the system voice cannot be processed):
    // 'synth' (default) | 'vocoder' | 'robot' | 'natural' (unprocessed); fxAmount 0..1
    character: 'synth',
    fxAmount: 0.6,
  },
  avatar: {
    renderer: 'relief', // 'relief' | 'procedural' | 'placeholder'
    pack: 'reference',
    quality: 'high', // 'low' | 'medium' | 'high'
    particles: 1.0, // 0..2
    bloom: 1.0, // 0..2
    followCursor: true,
    expressiveness: 1.0, // 0..2: how much speech moves the head, brows and face (1 = natural)
  },
  window: {
    sizePreset: 'medium', // 'small' | 'medium' | 'large'
    // a free size set by resizing (a corner grip, Ctrl + wheel, the Size slider): the avatar
    // area's width in px (200..1200, the height follows at 2:3); null = the preset's size
    avatarWidth: /** @type {number|null} */ (null),
    alwaysOnTop: true,
    clickThrough: true,
    position: /** @type {{x:number,y:number}|null} */ (null),
    showChat: true,
    skipTaskbar: false, // extension to §4: hide the taskbar button (tray icon stays)
    lockPosition: false, // true: pressing on the head does not move the window
    snapToEdges: true, // a dragged window locks flush against screen edges and corners
  },
  hotkeys: {
    // Linux/macOS defaults; Windows uses WIN32_HOTKEYS (see defaultSettings()).
    toggleListen: 'CommandOrControl+Alt+Space',
    toggleChat: 'CommandOrControl+Alt+C',
    stopSpeaking: 'CommandOrControl+Alt+X',
  },
  // The avatar can see you through the PC camera (docs/CAMERA.md). Off by default; face tracking
  // runs locally, and Claude only gets a picture when shareWithClaude is on or for one message.
  camera: {
    enabled: false,
    deviceId: '', // '' = the system's default camera
    followFace: true, // eye contact
    presence: true, // doze off when you are away, wake up when you are back
    mirrorExpressions: true, // smile back
    shareWithClaude: false, // a snapshot with every message you send
    // greet you when it first sees you and when you are back: 'hello' = a quick spoken hello
    // (instant, no Claude turn), 'claude' = a short hidden prompt so Claude says hello, 'off'
    greeting: 'hello',
    lookToTalk: false, // hands-free mode: only listen while you look at the screen
  },
  // ---- Home camera (Tapo pan/tilt camera + home security; docs/TAPO.md) -------------------------
  // The camera password is NOT a setting: electron/tapo/credentials.js keeps it encrypted.
  tapo: {
    enabled: false, // the whole feature (camera window, video component, ONVIF)
    name: 'camera', // spoken/display name: "front door camera"
    host: '', // '' or a home-network address (IP or .local/.lan/single-label name); never a URL
    onvifPort: 2020,
    rtspPort: 554,
    username: '', // the Tapo Camera Account user (not secret)
    stream: 'stream1', // 'stream1' | 'stream2'
    ptz: 'auto', // 'auto' | 'relative' | 'continuous' | 'off'
    invertPan: false,
    invertTilt: false,
    stepSmall: 0.15, // nudge sizes, as fractions of the view
    stepMedium: 0.35,
    stepLarge: 0.75,
    viewUnitsX: 0.5, // ONVIF units that turn the view by one full width (calibration measures it)
    viewUnitsY: 1.4, // … by one full height
    minStep: 0.05, // the smallest translation the firmware acts on
    holdSpeed: 0.5, // ContinuousMove velocity for press-and-hold
    msPerUnit: 6000, // travel time estimate (the watchdog Stop)
    homePreset: '', // a preset token; '' = AbsoluteMove(0,0) when supported
    localPresets: /** @type {Array<{ name: string, x: number, y: number }>} */ ([]),
    calibratedAt: '', // ISO time of the last calibration
    windowBounds: /** @type {{ x: number, y: number, width: number, height: number }|null} */ (null),
    windowOnTop: false,
    showDetections: false, // person boxes in the live view while disarmed
  },
  security: {
    armed: false, // persisted: an armed app re-arms right after a restart
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
    cameraEvents: true, // subscribe to the camera's own motion/person events
    confirmLocally: true, // an alert needs the local person detector to agree (when it runs)
    cooldownSec: 60,
    quietHours: '', // '' | 'HH:MM-HH:MM' (may wrap midnight)
    announce: true, // the avatar says it
    showOnAlert: true, // bring the avatar back (without focus)
    describe: false, // send the alert snapshot to Claude for a one-sentence description
    claudeSee: 'ask', // 'ask' | 'always' | 'never'  (camera_snapshot)
    claudeMove: 'ask', // 'ask' | 'always' | 'never'  (camera_look)
    voiceCommands: true, // simple camera commands run locally, without a Claude turn
  },
  // ---- end of the Home camera block ----------------------------------------------------------
});

/**
 * Windows global-shortcut defaults. Windows reports AltGr as Ctrl+Alt, so a Ctrl+Alt+<key>
 * global shortcut also fires for AltGr+<key> and swallows that character in every app
 * (Polish ć = AltGr+C, ź = AltGr+X; Hungarian/Czech & and #; BÉPO _ = AltGr+Space).
 */
export const WIN32_HOTKEYS = Object.freeze({
  toggleListen: 'Control+Shift+Space',
  toggleChat: 'Control+Shift+F9',
  stopSpeaking: 'Control+Shift+F10',
});

/** Version written into settings.json (top-level "version"); bump when a migration is added. */
export const SETTINGS_VERSION = 3;

/** @param {string} [platform] */
export function defaultHotkeys(platform = process.platform) {
  return { ...(platform === 'win32' ? WIN32_HOTKEYS : DEFAULT_SETTINGS.hotkeys) };
}

/**
 * Complete default settings for a platform (only the hotkeys differ).
 * @param {string} [platform]
 * @returns {Settings}
 */
export function defaultSettings(platform = process.platform) {
  const s = cloneSettings(DEFAULT_SETTINGS);
  /** @type {any} */ (s).hotkeys = defaultHotkeys(platform);
  return s;
}

/**
 * Upgrade a parsed settings file written by an older version (mutates `raw`).
 * v1 → v2 (Windows only): hotkeys that still hold the old Ctrl+Alt defaults move to the new
 * Windows defaults; shortcuts the user chose are kept.
 * v2 → v3: camera.greet (a boolean, off by default, so it never greeted anyone) becomes
 * camera.greeting: a greeting that was switched on keeps asking Claude ('claude'); otherwise the
 * new default, the quick spoken hello.
 * @param {Record<string, any>} raw @param {number} fromVersion @param {string} platform
 * @returns {string[]} what changed (for the log)
 */
export function migrateSettings(raw, fromVersion, platform) {
  const notes = [];
  if (fromVersion < 2 && platform === 'win32' && isPlainObject(raw.hotkeys)) {
    for (const [name, legacy] of Object.entries(DEFAULT_SETTINGS.hotkeys)) {
      if (raw.hotkeys[name] === legacy) {
        raw.hotkeys[name] = /** @type {any} */ (WIN32_HOTKEYS)[name];
        notes.push(`hotkeys.${name}: ${legacy} → ${raw.hotkeys[name]} (Ctrl+Alt shortcuts swallow AltGr characters on Windows)`);
      }
    }
  }
  if (fromVersion < 3 && isPlainObject(raw.camera) && 'greet' in raw.camera) {
    const on = raw.camera.greet === true;
    delete raw.camera.greet;
    if (raw.camera.greeting === undefined) raw.camera.greeting = on ? 'claude' : 'hello';
    notes.push(`camera.greet: ${on} → camera.greeting: ${raw.camera.greeting}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Accelerators (Electron global shortcut syntax)

const MODIFIERS = new Map(
  [
    'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr',
    'Shift', 'Super', 'Meta',
  ].map((m) => [m.toLowerCase(), m]),
);

const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert',
  'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
  'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack',
  'MediaStop', 'MediaPlayPause', 'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];
const KEYS = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
for (let i = 1; i <= 24; i++) KEYS.set(`f${i}`, `F${i}`);
for (let i = 0; i <= 9; i++) {
  KEYS.set(String(i), String(i));
  KEYS.set(`num${i}`, `num${i}`);
}
for (let c = 65; c <= 90; c++) KEYS.set(String.fromCharCode(c).toLowerCase(), String.fromCharCode(c));
for (const p of ')!@#$%^&*(:;<,_->.?/~`{]["|\\}=\'') KEYS.set(p, p);

/**
 * Validate and normalize an Electron accelerator ("CommandOrControl+Alt+Space").
 * Returns the canonical spelling, '' for "disabled", or null when invalid.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAccelerator(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return '';
  if (s.length > 100) return null;
  const parts = s.split('+').map((p) => p.trim());
  if (parts.some((p) => p === '')) return null;
  const mods = [];
  const seen = new Set();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS.get(p.toLowerCase());
    if (!m || seen.has(m)) return null;
    seen.add(m);
    mods.push(m);
  }
  const key = KEYS.get(parts[parts.length - 1].toLowerCase());
  if (!key || MODIFIERS.has(key.toLowerCase())) return null;
  return [...mods, key].join('+');
}

// ---------------------------------------------------------------------------------------------
// Schema: leaf validators return { ok: true, value } or { ok: false, reason }.

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** @param {{ max?: number, pattern?: RegExp, multiline?: boolean, trim?: boolean }} o */
const str = (o = {}) => (/** @type {unknown} */ v) => {
  if (typeof v !== 'string') return { ok: false, reason: 'expected a string' };
  const s = o.trim === false ? v : v.trim();
  if (o.max !== undefined && s.length > o.max) return { ok: false, reason: `longer than ${o.max} characters` };
  if (!o.multiline && /[\r\n]/.test(s)) return { ok: false, reason: 'must be a single line' };
  if (CONTROL_CHARS.test(s) || s.includes('\0')) return { ok: false, reason: 'contains control characters' };
  if (o.pattern && !o.pattern.test(s)) return { ok: false, reason: 'has an invalid format' };
  return { ok: true, value: s };
};
/** @param {readonly string[]} values */
const oneOf = (values) => (/** @type {unknown} */ v) =>
  typeof v === 'string' && values.includes(v)
    ? { ok: true, value: v }
    : { ok: false, reason: `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}` };
const bool = () => (/** @type {unknown} */ v) =>
  typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: 'expected true or false' };
/** Numbers are clamped into range (sanitization); non-numbers rejected. */
const num = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: 'expected a number' };
  return { ok: true, value: Math.min(max, Math.max(min, v)) };
};
const position = () => (/** @type {any} */ v) => {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'expected {x, y} or null' };
  const { x, y } = v;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: 'expected numeric x and y' };
  }
  const c = (/** @type {number} */ n) => Math.round(Math.min(1e6, Math.max(-1e6, n)));
  return { ok: true, value: { x: c(x), y: c(y) } };
};
/** A free avatar width in px (clamped, even) or null (= the size preset). */
const avatarWidth = () => (/** @type {unknown} */ v) => {
  if (v === null) return { ok: true, value: null };
  const w = normalizeAvatarWidth(v);
  return w === null ? { ok: false, reason: 'expected a width in pixels or null' } : { ok: true, value: w };
};
const accelerator = () => (/** @type {unknown} */ v) => {
  const n = normalizeAccelerator(v);
  return n === null ? { ok: false, reason: 'is not a valid shortcut (e.g. "CommandOrControl+Alt+Space")' } : { ok: true, value: n };
};

// ---- Home camera validators (tapo / security groups) -------------------------------------------
/** Integers are rounded and clamped into range; non-numbers rejected. */
const int = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: 'expected a number' };
  return { ok: true, value: Math.min(max, Math.max(min, Math.round(v))) };
};
/** tapo.host: '' or a home-network address (syntax only; electron/tapo/host.js). */
const lanHostSetting = () => (/** @type {unknown} */ v) => validateHostSetting(v);
/** A window's {x, y, width, height} (integers) or null. */
const bounds = () => (/** @type {any} */ v) => {
  if (v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return { ok: false, reason: 'expected {x, y, width, height} or null' };
  const keys = ['x', 'y', 'width', 'height'];
  if (!keys.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]))) return { ok: false, reason: 'expected numeric x, y, width and height' };
  const c = (/** @type {number} */ n, /** @type {number} */ lo, /** @type {number} */ hi) => Math.round(Math.min(hi, Math.max(lo, n)));
  return { ok: true, value: { x: c(v.x, -1e6, 1e6), y: c(v.y, -1e6, 1e6), width: c(v.width, 100, 20000), height: c(v.height, 100, 20000) } };
};
/** '' or "HH:MM-HH:MM" (may wrap midnight). */
const quietHours = () => (/** @type {unknown} */ v) => {
  if (typeof v !== 'string') return { ok: false, reason: 'expected a string' };
  const s = v.trim();
  if (s === '') return { ok: true, value: '' };
  return /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(s) ? { ok: true, value: s } : { ok: false, reason: 'must look like 22:00-07:00' };
};
/** At most 16 saved positions {name, x, y} (x, y in [-1, 1]). */
const localPresets = () => (/** @type {unknown} */ v) => {
  if (!Array.isArray(v) || v.length > 16) return { ok: false, reason: 'expected a list of at most 16 positions' };
  const out = [];
  for (const p of v) {
    if (!isPlainObject(p) || typeof p.name !== 'string' || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { ok: false, reason: 'each position needs a name, x and y' };
    }
    const name = p.name.trim();
    if (!name || name.length > 40 || CONTROL_CHARS.test(name) || /[\r\n]/.test(name)) return { ok: false, reason: 'a position name must be 1 to 40 characters on one line' };
    out.push({ name, x: Math.min(1, Math.max(-1, p.x)), y: Math.min(1, Math.max(-1, p.y)) });
  }
  return { ok: true, value: out };
};
/** '' or an absolute folder (the clips folder). */
const absPath = () => (/** @type {unknown} */ v) => {
  const r = str({ max: 1024 })(v);
  if (!r.ok || r.value === '') return r;
  return path.win32.isAbsolute(r.value) || path.posix.isAbsolute(r.value) ? r : { ok: false, reason: 'must be a full folder path' };
};
// ---- end of the Home camera validators ---------------------------------------------------------

const SCHEMA = {
  claude: {
    cliPath: str({ max: 1024 }),
    // Goes onto the CLI command line: keep to safe characters (aliases, ids, "[1m]" suffixes).
    model: str({ max: 100, pattern: /^[A-Za-z0-9._:@/[\]-]*$/ }),
    effort: oneOf(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    mode: oneOf(['chat', 'assistant', 'agent']),
    workdir: str({ max: 1024 }),
    persona: str({ max: 20000, multiline: true, trim: false }),
    resumeLastSession: bool(),
    lastSessionId: str({ max: 128, pattern: /^[A-Za-z0-9-]*$/ }),
  },
  voice: {
    enabled: bool(),
    pythonPath: str({ max: 1024 }),
    sttModel: str({ max: 128, pattern: /^[A-Za-z0-9._/-]+$/ }),
    sttLanguage: str({ max: 16, pattern: /^(|auto|[a-z]{2,3}([-_][A-Za-z]{2,8})?)$/ }),
    ttsVoice: str({ max: 64, pattern: /^[A-Za-z0-9_.-]+$/ }),
    ttsSpeed: num(0.5, 2.0),
    // A SpeechSynthesisVoice name or voiceURI ("Microsoft Aria Online (Natural) - English (United
    // States)"): any printable text on one line. It never reaches a command line.
    systemVoice: str({ max: 256 }),
    device: oneOf(['auto', 'cuda', 'cpu']),
    handsFree: bool(),
    speakReplies: bool(),
    character: oneOf(['natural', 'synth', 'vocoder', 'robot']),
    fxAmount: num(0, 1),
  },
  avatar: {
    renderer: oneOf(['relief', 'procedural', 'placeholder']),
    pack: str({ max: 64, pattern: /^[A-Za-z0-9_-]+$/ }),
    quality: oneOf(['low', 'medium', 'high']),
    particles: num(0, 2),
    bloom: num(0, 2),
    followCursor: bool(),
    expressiveness: num(0, 2),
  },
  window: {
    sizePreset: oneOf(['small', 'medium', 'large']),
    avatarWidth: avatarWidth(),
    alwaysOnTop: bool(),
    clickThrough: bool(),
    position: position(),
    showChat: bool(),
    skipTaskbar: bool(),
    lockPosition: bool(),
    snapToEdges: bool(),
  },
  hotkeys: {
    toggleListen: accelerator(),
    toggleChat: accelerator(),
    stopSpeaking: accelerator(),
  },
  camera: {
    enabled: bool(),
    // MediaDeviceInfo.deviceId: an opaque token (Chromium: a hex hash); never reaches a command line
    deviceId: str({ max: 256, pattern: /^[A-Za-z0-9._:=+/-]*$/ }),
    followFace: bool(),
    presence: bool(),
    mirrorExpressions: bool(),
    shareWithClaude: bool(),
    greeting: oneOf(['off', 'hello', 'claude']),
    lookToTalk: bool(),
  },
  // ---- Home camera ----------------------------------------------------------------------------
  tapo: {
    enabled: bool(),
    name: str({ max: 40 }),
    host: lanHostSetting(),
    onvifPort: int(1, 65535),
    rtspPort: int(1, 65535),
    // printable, no whitespace; it only ever reaches a SOAP header (escaped) and go2rtc's env (percent-encoded)
    username: str({ max: 64, pattern: /^\S*$/ }),
    stream: oneOf(['stream1', 'stream2']),
    ptz: oneOf(['auto', 'relative', 'continuous', 'off']),
    invertPan: bool(),
    invertTilt: bool(),
    stepSmall: num(0.02, 1),
    stepMedium: num(0.02, 1),
    stepLarge: num(0.02, 2),
    viewUnitsX: num(0.05, 4),
    viewUnitsY: num(0.05, 4),
    minStep: num(0, 0.5),
    holdSpeed: num(0.1, 1),
    msPerUnit: int(500, 20000),
    homePreset: str({ max: 64, pattern: /^[A-Za-z0-9_.:-]*$/ }),
    localPresets: localPresets(),
    calibratedAt: str({ max: 40 }),
    windowBounds: bounds(),
    windowOnTop: bool(),
    showDetections: bool(),
  },
  security: {
    armed: bool(),
    armDelaySec: int(0, 300),
    people: bool(),
    motion: bool(),
    notify: oneOf(['person', 'motion', 'off']),
    record: oneOf(['person', 'motion', 'off']),
    preRollSec: int(0, 15),
    postRollSec: int(2, 60),
    maxClipSec: int(10, 600),
    retentionDays: int(1, 90),
    maxStorageGB: num(0.5, 500),
    clipsDir: absPath(),
    sensitivity: oneOf(['low', 'medium', 'high']),
    cameraEvents: bool(),
    confirmLocally: bool(),
    cooldownSec: int(10, 3600),
    quietHours: quietHours(),
    announce: bool(),
    showOnAlert: bool(),
    describe: bool(),
    claudeSee: oneOf(['ask', 'always', 'never']),
    claudeMove: oneOf(['ask', 'always', 'never']),
    voiceCommands: bool(),
  },
  // ---- end of the Home camera groups ------------------------------------------------------------
};

/** @param {unknown} v @returns {v is Record<string, any>} */
export function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** @template T @param {T} v @returns {T} */
export function cloneSettings(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Deep-merge `patch` into `base` (both untouched; returns a new object). Plain objects merge
 * recursively; everything else (including null and arrays) replaces.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} patch
 */
export function deepMerge(base, patch) {
  const out = cloneSettings(base);
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v === undefined ? out[k] : cloneSettings(v);
  }
  return out;
}

/**
 * Apply `patch` onto `base` with validation. Invalid or unknown entries are skipped (base value
 * kept) and reported in `warnings`.
 * @param {Settings} base   a complete, valid settings object
 * @param {unknown} patch
 * @returns {{ settings: Settings, warnings: string[] }}
 */
export function applyPatch(base, patch) {
  const settings = cloneSettings(base);
  /** @type {string[]} */
  const warnings = [];
  if (patch === undefined || patch === null) return { settings, warnings };
  if (!isPlainObject(patch)) {
    warnings.push('settings patch must be an object');
    return { settings, warnings };
  }
  for (const [group, groupPatch] of Object.entries(patch)) {
    const groupSchema = /** @type {Record<string, any>} */ (SCHEMA)[group];
    if (!groupSchema || !Object.prototype.hasOwnProperty.call(SCHEMA, group)) {
      warnings.push(`unknown setting "${group}" ignored`);
      continue;
    }
    if (!isPlainObject(groupPatch)) {
      warnings.push(`"${group}" must be an object`);
      continue;
    }
    for (const [key, value] of Object.entries(groupPatch)) {
      const validate = Object.prototype.hasOwnProperty.call(groupSchema, key) ? groupSchema[key] : null;
      if (!validate) {
        warnings.push(`unknown setting "${group}.${key}" ignored`);
        continue;
      }
      if (value === undefined) continue;
      const r = validate(value);
      if (r.ok) /** @type {any} */ (settings)[group][key] = r.value;
      else warnings.push(`"${group}.${key}" ${r.reason}; kept ${JSON.stringify(/** @type {any} */ (base)[group][key])}`);
    }
    // Picking a size preset (tray, drawer, IPC) replaces a free size from resizing, unless the
    // same patch sets one too (a whole settings file has both).
    if (group === 'window' && groupPatch.sizePreset !== undefined && !('avatarWidth' in groupPatch)
      && settings.window.sizePreset === groupPatch.sizePreset) {
      settings.window.avatarWidth = null;
    }
  }
  return { settings, warnings };
}

/**
 * Validate a whole (possibly partial or stale) settings object against the defaults.
 * @param {unknown} input @param {string} [platform]
 */
export function sanitizeSettings(input, platform = process.platform) {
  return applyPatch(defaultSettings(platform), input);
}

// ---------------------------------------------------------------------------------------------

/**
 * Persistent settings store.
 * Events: 'change' (settings: Settings, previous: Settings), 'warning' (message: string).
 */
export class SettingsStore extends EventEmitter {
  /**
   * @param {{ dir: string, fileName?: string, fs?: typeof nodeFs, log?: (level: string, msg: string) => void, platform?: string }} opts
   */
  constructor(opts) {
    super();
    if (!opts || typeof opts.dir !== 'string' || !opts.dir) throw new TypeError('SettingsStore requires a directory');
    this.dir = opts.dir;
    this.file = path.join(opts.dir, opts.fileName || 'settings.json');
    this._fs = opts.fs || nodeFs;
    this._log = opts.log || (() => {});
    this.platform = opts.platform || process.platform;
    /** @type {Settings} */
    this._settings = defaultSettings(this.platform);
    this._loaded = false;
  }

  /**
   * Load from disk. Missing file → defaults. Unreadable/corrupt JSON → the bad file is moved
   * aside (settings.corrupt-<time>.json) and defaults are used. Invalid fields are replaced by
   * defaults and the cleaned file is written back.
   * @returns {Settings}
   */
  load() {
    const fs = this._fs;
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        this._warn(`could not read ${this.file}: ${/** @type {Error} */ (err).message}; using defaults`);
      }
    }
    let parsed = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw.replace(/^﻿/, ''));
        if (!isPlainObject(parsed)) throw new Error('top level is not an object');
      } catch (err) {
        parsed = null;
        const aside = this.file.replace(/\.json$/i, '') + `.corrupt-${Date.now()}.json`;
        try {
          fs.renameSync(this.file, aside);
          this._warn(`settings file was corrupt (${/** @type {Error} */ (err).message}); moved to ${aside} and reset to defaults`);
        } catch {
          this._warn(`settings file was corrupt (${/** @type {Error} */ (err).message}); reset to defaults`);
        }
      }
    }
    let fileVersion = SETTINGS_VERSION;
    if (parsed !== null) {
      fileVersion = typeof parsed.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : 1;
      delete parsed.version; // file metadata, not a setting
      for (const note of migrateSettings(parsed, fileVersion, this.platform)) this._log('info', `[settings] migrated ${note}`);
    }
    const { settings, warnings } = sanitizeSettings(parsed || {}, this.platform);
    for (const w of warnings) this._warn(w);
    this._settings = settings;
    this._loaded = true;
    if (parsed === null || warnings.length > 0 || fileVersion < SETTINGS_VERSION) {
      try {
        this._write(settings);
      } catch (err) {
        this._warn(`could not write settings: ${/** @type {Error} */ (err).message}`);
      }
    }
    return cloneSettings(settings);
  }

  /** @returns {Settings} a copy of the current settings */
  get() {
    if (!this._loaded) this.load();
    return cloneSettings(this._settings);
  }

  /**
   * Deep-merge, validate and persist a partial update. Emits 'change' if anything changed.
   * @param {unknown} patch
   * @returns {{ settings: Settings, warnings: string[], changed: boolean }}
   */
  update(patch) {
    if (!this._loaded) this.load();
    const previous = this._settings;
    const { settings, warnings } = applyPatch(previous, patch);
    for (const w of warnings) this._warn(w);
    const changed = JSON.stringify(settings) !== JSON.stringify(previous);
    if (changed) {
      this._settings = settings;
      try {
        this._write(settings);
      } catch (err) {
        this._warn(`could not save settings: ${/** @type {Error} */ (err).message}`);
      }
      this.emit('change', cloneSettings(settings), cloneSettings(previous));
    }
    return { settings: cloneSettings(settings), warnings, changed };
  }

  /** Convenience: update and return only the settings. @param {unknown} patch */
  set(patch) {
    return this.update(patch).settings;
  }

  /** Atomic write: temp file in the same directory, fsync, rename over the target. */
  _write(settings) {
    const fs = this._fs;
    fs.mkdirSync(this.dir, { recursive: true });
    const data = `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`;
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      try { fs.fsyncSync(fd); } catch { /* not supported everywhere */ }
    } finally {
      fs.closeSync(fd);
    }
    // Windows can briefly refuse the rename (antivirus/indexer holding the file): retry.
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        lastErr = err;
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        const until = Date.now() + 20 * (attempt + 1);
        while (Date.now() < until) { /* short synchronous back-off */ }
      }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw lastErr;
  }

  /** @param {string} msg */
  _warn(msg) {
    this._log('warn', `[settings] ${msg}`);
    this.emit('warning', msg);
  }
}
