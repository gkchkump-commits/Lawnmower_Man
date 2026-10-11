// A pretend Tapo camera for the browser preview and Playwright (contract §9.7): the
// window.lawnmowerCamera API of the Home camera window, in memory, plus the `tapo` namespace the
// avatar's mock bridge (src/bridge/mock.js) exposes. No network, no camera.
//
// It behaves like the real thing where the UI can tell:
//   * a virtual pan/tilt head (0.35 units/s pan, 0.25 tilt, mirrored pan like a real C211, small
//     moves below 0.05 ignored) looking at a procedural living room that is wider and taller than
//     the view, so nudges, click-to-center, presets and calibration visibly turn the picture;
//   * frames at 10 fps as ImageBitmaps over the same MessagePort protocol main uses (§9.3), so
//     the window runs its real security worker (motion, the stub person detector, snapshots, the
//     calibration shift measurement); a green figure walks in with __tapoMock.person(true);
//   * main's side of that protocol: arming with a 2 s exit delay, a person seen while armed starts
//     an event (snapshot from the worker, the sample clip when it ends), calibration driven by
//     the worker's shift answers (?scenario=calib-ask shows a featureless picture → the "ask" step);
//   * connection test (a scripted TestReport can replace the default), discovery, presets,
//     credentials (the password is only ever "saved", never kept or shown).
//
// Test hooks on window.__tapoMock: calls (every PTZ command), person(on), dark(on), set(statusPatch),
// scriptTest(report), state(), emitEvent(), frames().
//
// Scenarios (?scenario=): online (default) · setup (not configured) · offline · auth · privacy ·
// noptz · h265 (a stream this PC cannot decode) · calib-ask.
/* global MessageChannel */

import { DEFAULT_SETTINGS, clone, deepMerge, isPlainObject } from '../app/settings-defaults.js';

// ------------------------------------------------------------------------------------------
// settings validation (light; the real store is electron/settings.js)

/** Numeric Home camera settings and their ranges (clamped, like electron/settings.js). */
export const TAPO_NUMBER_RANGES = Object.freeze({
  'tapo.onvifPort': [1, 65535, 'int'],
  'tapo.rtspPort': [1, 65535, 'int'],
  'tapo.stepSmall': [0.02, 1],
  'tapo.stepMedium': [0.02, 1],
  'tapo.stepLarge': [0.02, 2],
  'tapo.viewUnitsX': [0.05, 4],
  'tapo.viewUnitsY': [0.05, 4],
  'tapo.minStep': [0, 0.5],
  'tapo.holdSpeed': [0.1, 1],
  'tapo.msPerUnit': [500, 20000, 'int'],
  'security.armDelaySec': [0, 300, 'int'],
  'security.preRollSec': [0, 15, 'int'],
  'security.postRollSec': [2, 60, 'int'],
  'security.maxClipSec': [10, 600, 'int'],
  'security.retentionDays': [1, 90, 'int'],
  'security.maxStorageGB': [0.5, 500],
  'security.cooldownSec': [10, 3600, 'int'],
});

export const TAPO_ENUMS = Object.freeze({
  'tapo.stream': ['stream1', 'stream2'],
  'tapo.ptz': ['auto', 'relative', 'continuous', 'off'],
  'security.notify': ['person', 'motion', 'off'],
  'security.record': ['person', 'motion', 'off'],
  'security.sensitivity': ['low', 'medium', 'high'],
  'security.claudeSee': ['ask', 'always', 'never'],
  'security.claudeMove': ['ask', 'always', 'never'],
});

/**
 * One Home camera setting, checked like main would (enough for the mock): null = rejected.
 * @param {string} path 'tapo.x' | 'security.y' @param {any} v
 */
export function sanitizeTapoValue(path, v) {
  const [group, key] = path.split('.');
  const def = /** @type {any} */ (DEFAULT_SETTINGS)[group]?.[key];
  if (def === undefined) return null;
  const range = /** @type {any} */ (TAPO_NUMBER_RANGES)[path];
  if (range) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const c = Math.min(range[1], Math.max(range[0], v));
    return { value: range[2] === 'int' ? Math.round(c) : c };
  }
  const en = /** @type {any} */ (TAPO_ENUMS)[path];
  if (en) return en.includes(v) ? { value: v } : null;
  if (path === 'tapo.localPresets') return Array.isArray(v) ? { value: v.slice(0, 16) } : null;
  if (path === 'tapo.windowBounds') return v === null || isPlainObject(v) ? { value: v } : null;
  if (path === 'security.quietHours') return typeof v === 'string' && /^(|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/.test(v) ? { value: v } : null;
  if (path === 'tapo.host') {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s === '' || /^[A-Za-z0-9.:-]{1,253}$/.test(s) ? { value: s } : null;
  }
  if (typeof def === 'string') return typeof v === 'string' && !/[\r\n]/.test(v) ? { value: v.trim() } : null;
  if (typeof def === 'boolean') return typeof v === 'boolean' ? { value: v } : null;
  return typeof v === typeof def ? { value: v } : null;
}

/** Keep only valid tapo/security entries of a patch. @param {unknown} patch @param {string[]} [groups] */
export function sanitizeTapoPatch(patch, groups = ['tapo', 'security']) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!isPlainObject(patch)) return out;
  for (const [group, gp] of Object.entries(patch)) {
    if (!groups.includes(group) || !isPlainObject(gp)) continue;
    for (const [k, v] of Object.entries(gp)) {
      const r = sanitizeTapoValue(`${group}.${k}`, v);
      if (r) (out[group] ||= {})[k] = r.value;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// the virtual camera

/** What the mock camera "is" (one view width = 0.6 units, one view height = 1.5 units). */
export const MOCK_TRUTH = Object.freeze({ viewUnitsX: 0.6, viewUnitsY: 1.5, mirrorPan: true, invertTilt: false, minEffectiveStep: 0.05, panSpeed: 0.35, tiltSpeed: 0.25 });
export const MOCK_ARM_DELAY_MS = 2000;
export const MOCK_POST_ROLL_MS = 3000;
export const MOCK_FPS = 10;
export const MOCK_FRAME = Object.freeze({ width: 960, height: 540 });

const PRESETS = [
  { token: '1', name: 'Door', source: 'camera', pos: { x: -0.62, y: -0.1 } },
  { token: '2', name: 'Window', source: 'camera', pos: { x: 0.55, y: 0.25 } },
  { token: '3', name: 'Desk', source: 'camera', pos: { x: 0.05, y: -0.35 } },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "20261010-140312-a1b2" for a local time. @param {number} ms */
export function mockEventId(ms) {
  const d = new Date(ms);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** The default connection test: every step passes (the password "wrong" fails the sign-in). */
export function mockTestReport({ host = '192.168.1.50', password = '', scenario = 'online' } = {}) {
  const authFails = password === 'wrong' || scenario === 'auth';
  const offline = scenario === 'offline';
  /** @type {any[]} */
  const steps = [
    { id: 'host', label: 'Address', ok: true, detail: `${host} is on your home network.` },
    offline
      ? { id: 'tcp2020', label: 'Camera answers', ok: false, detail: `Nothing answers at ${host}:2020.`, hint: 'Check that the camera is on and connected to the same Wi-Fi as this PC. Its address may have changed: press Find cameras, or give it a fixed address (DHCP reservation) in your router.' }
      : { id: 'tcp2020', label: 'Camera answers', ok: true, detail: 'The camera answers on port 2020 (ONVIF).' },
  ];
  if (offline) return { ok: false, steps };
  steps.push({ id: 'clock', label: 'Camera clock', ok: true, detail: 'The camera’s clock is 0.4 s off; that is fine.' });
  if (authFails) {
    steps.push({ id: 'auth', label: 'Sign in', ok: false, detail: 'The camera refused the user name or password.', hint: 'Use the Camera Account from the Tapo app (camera › Settings › Advanced Settings › Camera Account), not your TP-Link login. The app tries only once, so the camera does not lock you out.' });
    return { ok: false, steps };
  }
  steps.push(
    { id: 'auth', label: 'Sign in', ok: true, detail: 'Signed in: tp-link Tapo C211, firmware 1.5.4 Build 260702.' },
    { id: 'services', label: 'Camera services', ok: true, detail: 'Video, pan/tilt and events are available.' },
    { id: 'profiles', label: 'Video streams', ok: true, detail: 'stream1 2304×1296 H.264 · stream2 640×360 H.264' },
    { id: 'ptz', label: 'Pan and tilt', ok: true, detail: 'Pan and tilt work (relative moves, 8 preset slots). The camera did not move for this test.' },
    { id: 'events', label: 'Motion and person events', ok: true, detail: 'The camera reports motion and person detection.' },
    { id: 'rtsp', label: 'Video', ok: true, detail: 'stream1: H264/90000, PCMA/8000 audio' },
  );
  return {
    ok: true,
    steps,
    device: { manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', hardwareId: '2.0' },
    clock: { offsetSec: 0.4, ntp: true, warn: false },
  };
}

/**
 * The camera model both mock bridges use: status, arming, PTZ, presets, events, credentials.
 * @param {{ scenario?: string, getSettings: () => any, patchSettings: (p: any) => void, assetBase?: string }} o
 */
export function createMockTapoCore(o) {
  const scenario = o.scenario || 'online';
  const now = () => Date.now();
  /** @type {Record<string, Set<Function>>} */
  const listeners = { status: new Set(), event: new Set(), openEvent: new Set(), calibration: new Set(), ptz: new Set() };
  const calls = /** @type {any[]} */ ([]);
  const base = o.assetBase || globalThis.document?.baseURI || globalThis.location?.href || 'http://127.0.0.1/';
  const sampleClip = new URL('../dev/tapo-sample.webm', base).href;
  const sampleThumb = new URL('../dev/tapo-sample.jpg', base).href;

  let hasPassword = scenario !== 'setup';
  const cam = {
    pos: { x: 0, y: 0 },
    target: /** @type {{x:number,y:number}|null} */ (null),
    velocity: /** @type {{x:number,y:number}|null} */ (null),
    holdUntil: 0,
    moving: false,
    settleUntil: 0,
  };
  const presets = PRESETS.map((p) => ({ ...p, pos: { ...p.pos } }));
  let presetSeq = 10;

  const today = new Date();
  const at = (/** @type {number} */ dayOffset, /** @type {number} */ h, /** @type {number} */ m) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOffset, h, m, 12).getTime();
  // two earlier events (the morning's delivery, last night's moth), with the sample clip
  const morning = Math.min(at(0, 9, 12), now() - 3_600_000);
  /** @type {any[]} */
  const events = [
    { id: mockEventId(morning), kind: 'person', startedAt: morning, endedAt: morning + 23_400, durationSec: 23.4, sources: ['camera-person', 'local-person', 'local-motion'], maxScore: 0.83, preset: 'Door', clipUrl: sampleClip, snapshotUrl: sampleThumb, bytes: 5_123_456, notified: true, announced: true, acknowledged: false },
    { id: mockEventId(at(1, 22, 47)), kind: 'motion', startedAt: at(1, 22, 47), endedAt: at(1, 22, 47) + 9_000, durationSec: 9, sources: ['local-motion'], maxScore: 0, clipUrl: sampleClip, snapshotUrl: sampleThumb, bytes: 1_811_022, notified: false, announced: false, acknowledged: true },
  ];

  const settings = () => o.getSettings();
  const tapoS = () => settings().tapo;
  const secS = () => settings().security;

  const configured = () => !!(tapoS().host && tapoS().username && hasPassword);
  let connection = /** @type {string} */ (scenario === 'offline' ? 'unreachable' : scenario === 'auth' ? 'auth-failed' : 'online');
  let connectTimer = 0;

  const security = {
    armed: false,
    arming: false,
    armingEndsAt: /** @type {number|undefined} */ (undefined),
    active: /** @type {any} */ (null),
    recording: false,
  };
  let armTimer = 0;
  /** @type {any} worker stats from the page (fps, codec support) */
  let workerStats = null;
  let detectorState = 'off';
  /** extra status fields set by tests */
  let overrides = {};

  const statusNow = () => {
    const t = tapoS();
    const enabled = !!t.enabled;
    const conf = configured();
    const conn = !enabled ? 'off' : !conf ? 'not-configured' : connection;
    const online = conn === 'online';
    const detail = {
      off: 'The Home camera is turned off.',
      'not-configured': 'Enter the camera’s address and Camera Account.',
      online: 'Connected to Tapo C211.',
      connecting: `Connecting to ${t.host}…`,
      'auth-failed': 'The camera did not accept the Camera Account user name or password.',
      unreachable: `The camera at ${t.host} does not answer. Is it on and connected to the same network?`,
      error: 'Something went wrong.',
    }[conn] || '';
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const st = {
      enabled,
      configured: conf,
      hasPassword,
      persistence: hasPassword ? 'encrypted' : 'none',
      name: t.name || 'camera',
      host: t.host,
      connection: conn,
      detail,
      device: online ? { manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', hardwareId: '2.0' } : undefined,
      clock: online ? { offsetSec: 0.4, ntp: true, warn: false } : undefined,
      go2rtc: { state: online ? 'ready' : 'stopped' },
      stream: online
        ? { state: scenario === 'h265' ? 'live' : 'live', codec: scenario === 'h265' ? 'hvc1.1.6.L120.B0' : 'avc1.640028', width: MOCK_FRAME.width, height: MOCK_FRAME.height, fps: workerStats?.fps || MOCK_FPS, kbps: 1840, keyIntervalSec: 1, lastFrameAgoMs: 60 }
        : { state: 'off' },
      ptz: {
        available: online && scenario !== 'noptz' && t.ptz !== 'off',
        mode: scenario === 'noptz' || t.ptz === 'off' ? 'none' : 'relative',
        moving: cam.moving || now() < cam.settleUntil,
        canStatus: true,
        canAbsolute: true,
        canSetPreset: true,
        position: online ? { x: round2(cam.pos.x), y: round2(cam.pos.y) } : null,
        privacySuspected: scenario === 'privacy' && online,
        calibrated: !!t.calibratedAt,
      },
      events: { onvif: online && security.armed ? 'subscribed' : 'off', topics: ['tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/PeopleDetector/People'] },
      detector: { state: detectorState, rateHz: workerStats?.detector?.rateHz, lastMs: workerStats?.detector?.lastMs },
      security: {
        armed: security.armed,
        arming: security.arming,
        armingEndsAt: security.arming ? security.armingEndsAt : undefined,
        active: security.active ? clone(security.active) : null,
        recording: security.recording,
        todayCount: events.filter((e) => e.startedAt >= todayStart).length + (security.active ? 1 : 0),
        lastEventAt: events[0]?.startedAt,
        storage: { bytes: events.reduce((s, e) => s + (e.bytes || 0), 0), clips: events.filter((e) => e.clipUrl).length, dir: 'C:\\Users\\you\\Videos\\Lawnmower Man\\Security' },
        warnings: [],
      },
    };
    return deepMerge(st, overrides);
  };

  let statusQueued = false;
  const emitStatus = () => {
    if (statusQueued) return;
    statusQueued = true;
    setTimeout(() => {
      statusQueued = false;
      const st = statusNow();
      for (const cb of [...listeners.status]) cb(clone(st));
    }, 30);
  };
  /** @param {keyof typeof listeners} kind @param {any} payload */
  const emit = (kind, payload) => {
    for (const cb of [...listeners[kind]]) {
      try {
        cb(clone(payload));
      } catch (err) {
        console.error(`[mock-tapo] ${kind} listener threw`, err);
      }
    }
  };
  /** @param {keyof typeof listeners} kind @param {Function} cb */
  const subscribe = (kind, cb) => {
    listeners[kind].add(cb);
    return () => listeners[kind].delete(cb);
  };

  // ---------------------------------------------------------------- the motors
  const physics = () => {
    const dt = 0.05;
    let moving = false;
    if (cam.velocity) {
      if (now() > cam.holdUntil) cam.velocity = null; // missed heartbeats: main would stop
      else {
        cam.pos.x = clamp(cam.pos.x + cam.velocity.x * MOCK_TRUTH.panSpeed * dt, -1, 1);
        cam.pos.y = clamp(cam.pos.y + cam.velocity.y * MOCK_TRUTH.tiltSpeed * dt, -1, 1);
        moving = true;
      }
    }
    if (cam.target) {
      const dx = cam.target.x - cam.pos.x;
      const dy = cam.target.y - cam.pos.y;
      const sx = MOCK_TRUTH.panSpeed * dt;
      const sy = MOCK_TRUTH.tiltSpeed * dt;
      cam.pos.x += Math.abs(dx) <= sx ? dx : Math.sign(dx) * sx;
      cam.pos.y += Math.abs(dy) <= sy ? dy : Math.sign(dy) * sy;
      if (Math.abs(dx) <= sx && Math.abs(dy) <= sy) cam.target = null;
      else moving = true;
    }
    if (moving !== cam.moving) {
      cam.moving = moving;
      if (!moving) cam.settleUntil = now() + 1500;
      emit('ptz', { moving: cam.moving, settleUntil: cam.settleUntil });
      emitStatus();
    }
  };
  const physicsTimer = setInterval(physics, 50);

  /** Physical move (what the motor does with an ONVIF translation). @param {number} tx @param {number} ty @param {{ raw?: boolean }} [m] */
  const relativeMove = (tx, ty, m = {}) => {
    let x = tx;
    let y = ty;
    if (!m.raw) {
      // main's PtzController: intent × invert settings, small moves raised to minStep
      x *= tapoS().invertPan ? -1 : 1;
      y *= tapoS().invertTilt ? -1 : 1;
      const min = tapoS().minStep;
      if (x && Math.abs(x) < min) x = Math.sign(x) * min;
      if (y && Math.abs(y) < min) y = Math.sign(y) * min;
    }
    // the camera: mirrored pan, ignores moves that are too small
    if (Math.abs(x) < MOCK_TRUTH.minEffectiveStep) x = 0;
    if (Math.abs(y) < MOCK_TRUTH.minEffectiveStep) y = 0;
    if (!x && !y) return false;
    const from = cam.target || cam.pos;
    cam.target = { x: clamp(from.x + (MOCK_TRUTH.mirrorPan ? -x : x), -1, 1), y: clamp(from.y + (MOCK_TRUTH.invertTilt ? -y : y), -1, 1) };
    cam.velocity = null;
    physics();
    return true;
  };

  const ptzError = () => {
    const s = statusNow();
    if (!s.configured) return { ok: false, code: 'not-configured', error: 'The camera is not set up yet.' };
    if (s.connection !== 'online') return { ok: false, code: s.connection === 'auth-failed' ? 'auth' : 'offline', error: 'The camera is offline.' };
    if (s.ptz.privacySuspected) return { ok: false, code: 'privacy', error: 'The camera seems to be in privacy mode. Turn privacy mode off in the Tapo app.' };
    if (!s.ptz.available) return { ok: false, code: 'unsupported', error: 'This camera does not support pan and tilt over ONVIF.' };
    return null;
  };

  /** @param {any} cmd PtzCommand */
  const ptz = async (cmd) => {
    if (!cmd || typeof cmd !== 'object') throw new Error('Invalid camera command');
    calls.push({ at: now(), ...clone(cmd) });
    const err = ptzError();
    const position = () => ({ x: round2(cam.pos.x), y: round2(cam.pos.y) });
    if (err && cmd.op !== 'stop' && cmd.op !== 'release' && cmd.op !== 'heartbeat') return err;
    const t = tapoS();
    const sign = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };
    switch (cmd.op) {
      case 'nudge': {
        const v = sign[/** @type {'left'} */ (cmd.dir)];
        if (!v) throw new Error('Invalid direction');
        const f = cmd.amount === 'small' ? t.stepSmall : cmd.amount === 'large' ? t.stepLarge : t.stepMedium;
        const moved = relativeMove(v[0] * f * t.viewUnitsX, v[1] * f * t.viewUnitsY);
        return { ok: true, moved, position: position() };
      }
      case 'hold': {
        const v = sign[/** @type {'left'} */ (cmd.dir)];
        if (!v) throw new Error('Invalid direction');
        const k = t.holdSpeed;
        const x = v[0] * k * (t.invertPan ? -1 : 1);
        const y = v[1] * k * (t.invertTilt ? -1 : 1);
        cam.target = null;
        cam.velocity = { x: MOCK_TRUTH.mirrorPan ? -x : x, y };
        cam.holdUntil = now() + 700;
        physics();
        return { ok: true, moved: true, position: position() };
      }
      case 'heartbeat':
        if (cam.velocity) cam.holdUntil = now() + 700;
        return { ok: true };
      case 'release':
      case 'stop':
        cam.velocity = null;
        if (cmd.op === 'stop') cam.target = null;
        physics();
        return { ok: true, moved: false, position: position() };
      case 'center': {
        const u = Number(cmd.u);
        const v = Number(cmd.v);
        if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) throw new Error('Invalid point');
        let dx = u - 0.5;
        let dy = v - 0.5;
        if (Math.abs(dx) < 0.04) dx = 0;
        if (Math.abs(dy) < 0.04) dy = 0;
        if (!dx && !dy) return { ok: true, moved: false, position: position() };
        const moved = relativeMove(dx * t.viewUnitsX, -dy * t.viewUnitsY);
        return { ok: true, moved, position: position() };
      }
      case 'preset':
      case 'preset-name': {
        const p = cmd.op === 'preset'
          ? presets.find((x) => x.token === cmd.token)
          : presets.find((x) => x.name.toLowerCase() === String(cmd.name || '').toLowerCase());
        if (!p) return { ok: false, code: 'no-preset', error: `There is no saved position called "${cmd.name || cmd.token}".` };
        cam.velocity = null;
        cam.target = { ...p.pos };
        physics();
        return { ok: true, moved: true, position: position() };
      }
      case 'home': {
        const home = presets.find((x) => x.token === t.homePreset);
        cam.velocity = null;
        cam.target = home ? { ...home.pos } : { x: 0, y: 0 };
        physics();
        return { ok: true, moved: true, position: position() };
      }
      default:
        throw new Error('Unknown camera command');
    }
  };

  // ---------------------------------------------------------------- arming
  const setArmed = (/** @type {boolean} */ armed, /** @type {boolean} */ immediate = false) => {
    clearTimeout(armTimer);
    if (!armed) {
      security.armed = false;
      security.arming = false;
      security.armingEndsAt = undefined;
      endEvent(true);
      o.patchSettings({ security: { armed: false } });
    } else if (immediate) {
      security.armed = true;
      security.arming = false;
      security.armingEndsAt = undefined;
      o.patchSettings({ security: { armed: true } });
    } else {
      security.armed = false;
      security.arming = true;
      security.armingEndsAt = now() + MOCK_ARM_DELAY_MS;
      o.patchSettings({ security: { armed: true } });
      armTimer = /** @type {any} */ (setTimeout(() => {
        security.arming = false;
        security.armed = true;
        security.armingEndsAt = undefined;
        emitStatus();
        core.onArmedChanged?.();
      }, MOCK_ARM_DELAY_MS));
    }
    emitStatus();
    core.onArmedChanged?.();
    return { armed: security.armed, arming: security.arming, ...(security.arming ? { armingEndsAt: security.armingEndsAt } : {}) };
  };

  // ---------------------------------------------------------------- events
  let evidenceAt = 0;
  /** @param {'person'|'motion'} kind @param {number} score */
  const evidence = (kind, score) => {
    if (!security.armed) return;
    evidenceAt = now();
    const sec = secS();
    if (kind === 'person' && !sec.people) return;
    if (kind === 'motion' && !sec.motion) return;
    if (!security.active) {
      const t = now();
      security.active = {
        id: mockEventId(t), kind, startedAt: t, sources: kind === 'person' ? ['local-person', 'local-motion'] : ['local-motion'],
        maxScore: score, preset: undefined, ptz: { x: round2(cam.pos.x), y: round2(cam.pos.y) },
        notified: sec.notify !== 'off', announced: sec.announce, acknowledged: false,
      };
      security.recording = sec.record === kind || sec.record === 'motion';
      emit('event', { phase: 'start', event: security.active });
      core.onEventStart?.(security.active);
      emitStatus();
      return;
    }
    const ev = security.active;
    let changed = false;
    if (kind === 'person' && ev.kind === 'motion') {
      ev.kind = 'person';
      ev.sources = [...new Set([...ev.sources, 'local-person'])];
      if (!security.recording && sec.record !== 'off') {
        security.recording = true;
        emitStatus();
      }
      changed = true;
    }
    if (score > (ev.maxScore || 0)) {
      ev.maxScore = score;
      changed = true;
    }
    if (changed) emit('event', { phase: 'update', event: ev });
  };
  /** @param {boolean} [now_] end at once (disarm) */
  function endEvent(now_ = false) {
    const ev = security.active;
    if (!ev) return;
    if (!now_ && now() - evidenceAt < MOCK_POST_ROLL_MS) return;
    ev.endedAt = now();
    ev.durationSec = Math.round((ev.endedAt - ev.startedAt) / 100) / 10;
    if (security.recording) {
      ev.clipUrl = sampleClip;
      ev.bytes = Math.round(ev.durationSec * 230_000);
    }
    ev.snapshotUrl ||= sampleThumb;
    security.active = null;
    security.recording = false;
    events.unshift(ev);
    emit('event', { phase: 'end', event: ev });
    emitStatus();
  }
  const eventTimer = setInterval(() => endEvent(false), 250);

  // ---------------------------------------------------------------- the API
  const core = {
    scenario,
    calls,
    cam,
    presets,
    events,
    subscribe,
    emit,
    emitStatus,
    statusNow,
    relativeMove,
    evidence,
    /** @type {(() => void)|undefined} */
    onArmedChanged: undefined,
    /** @type {((ev: any) => void)|undefined} */
    onEventStart: undefined,
    get security() {
      return security;
    },
    get hasPassword() {
      return hasPassword;
    },
    /** @param {any} w */
    setWorkerStats(w) {
      workerStats = w;
    },
    /** @param {string} s */
    setDetector(s) {
      if (s !== detectorState) {
        detectorState = s;
        emitStatus();
      }
    },
    /** @param {Record<string, any>} patch  merged into every status (tests) */
    setOverrides(patch) {
      overrides = deepMerge(overrides, patch || {});
      emitStatus();
    },
    /** @param {string} c */
    setConnection(c) {
      connection = c;
      emitStatus();
    },
    async status() {
      return statusNow();
    },
    ptz,
    /** @param {{ armed: boolean, immediate?: boolean }} a */
    async arm(a) {
      if (!a || typeof a.armed !== 'boolean') throw new Error('arm() takes { armed: boolean }');
      calls.push({ at: now(), op: 'arm', armed: a.armed });
      return setArmed(a.armed, !!a.immediate);
    },
    async presets() {
      return presets.map((p) => ({ token: p.token, name: p.name, source: p.source, ...(p.token === tapoS().homePreset ? { home: true } : {}) }));
    },
    /** @param {{ name: string, token?: string }} a */
    async savePreset(a) {
      const name = String(a?.name || '').trim();
      if (!name || name.length > 40) return { ok: false, error: 'Give the position a name (up to 40 characters).' };
      const existing = a.token ? presets.find((p) => p.token === a.token) : null;
      if (existing) {
        existing.name = name;
        existing.pos = { ...cam.pos };
        return { ok: true, token: existing.token };
      }
      if (presets.length >= 8) return { ok: false, error: 'All 8 preset slots are used. Remove one first.' };
      const p = { token: String(++presetSeq), name, source: 'camera', pos: { ...cam.pos } };
      presets.push(p);
      return { ok: true, token: p.token };
    },
    /** @param {{ token: string }} a */
    async removePreset(a) {
      const i = presets.findIndex((p) => p.token === a?.token);
      if (i < 0) return { ok: false, error: 'That position does not exist any more.' };
      presets.splice(i, 1);
      return { ok: true };
    },
    /** @param {{ beforeMs?: number, sinceMs?: number, kinds?: string[], limit?: number }} [q] */
    async listEvents(q = {}) {
      let list = events.slice();
      if (Number.isFinite(q.beforeMs)) list = list.filter((e) => e.startedAt < /** @type {number} */ (q.beforeMs));
      if (Number.isFinite(q.sinceMs)) list = list.filter((e) => e.startedAt >= /** @type {number} */ (q.sinceMs));
      if (Array.isArray(q.kinds) && q.kinds.length) list = list.filter((e) => /** @type {string[]} */ (q.kinds).includes(e.kind));
      const total = list.length;
      return { events: clone(list.slice(0, clamp(Number(q.limit) || 50, 1, 200))), total };
    },
    /** @param {{ id: string }} a */
    async removeEvent(a) {
      const i = events.findIndex((e) => e.id === a?.id);
      if (i >= 0) events.splice(i, 1);
      emitStatus();
      return { ok: i >= 0 };
    },
    /** @param {{ id: string }} a */
    async ackEvent(a) {
      const e = events.find((x) => x.id === a?.id);
      if (e) e.acknowledged = true;
      return { ok: !!e };
    },
    async openClips() {
      calls.push({ at: now(), op: 'open-clips' });
      return { ok: true, path: 'C:\\Users\\you\\Videos\\Lawnmower Man\\Security' };
    },
    /** @param {{ username: string, password: string }} a */
    async setCredentials(a) {
      if (!a || typeof a.password !== 'string' || !a.password || /[\r\n\0]/.test(a.password) || a.password.length > 128) throw new Error('The password is not valid.');
      if (typeof a.username !== 'string' || !a.username.trim() || /\s/.test(a.username.trim())) throw new Error('The user name is not valid.');
      hasPassword = true;
      core.authFixed = a.password !== 'wrong';
      o.patchSettings({ tapo: { username: a.username.trim() } });
      calls.push({ at: now(), op: 'set-credentials', username: a.username.trim(), passwordLength: a.password.length });
      core.reconnect();
      return { ok: true, persistence: 'encrypted' };
    },
    async clearCredentials() {
      hasPassword = false;
      emitStatus();
      return { ok: true };
    },
    /** Connect again (after a settings or credential change, Retry). */
    reconnect() {
      clearTimeout(connectTimer);
      if (!configured() || !tapoS().enabled) {
        emitStatus();
        return;
      }
      connection = 'connecting';
      emitStatus();
      connectTimer = /** @type {any} */ (setTimeout(() => {
        connection = scenario === 'offline' ? 'unreachable' : scenario === 'auth' && !core.authFixed ? 'auth-failed' : 'online';
        emitStatus();
      }, 900));
    },
    authFixed: false,
    restoreArmed() {
      if (secS().armed && !security.armed && !security.arming) setArmed(true, true);
    },
    dispose() {
      clearInterval(physicsTimer);
      clearInterval(eventTimer);
      clearTimeout(armTimer);
      clearTimeout(connectTimer);
    },
  };
  return core;
}

/** @param {number} v */
function round2(v) {
  return Math.round(v * 100) / 100;
}

// ------------------------------------------------------------------------------------------
// the picture: a procedural living room, wider and taller than the view

/** Pixels of the panorama per view (the frames are scaled up from this). */
const PANO_VIEW = { w: 800, h: 450 };

/**
 * Paint the room the mock camera looks at. Coordinates: the panorama is
 * (1 + 2 / viewUnitsX) views wide and (1 + 2 / viewUnitsY) views tall.
 * @param {any} g CanvasRenderingContext2D @param {number} W @param {number} H
 */
function paintRoom(g, W, H) {
  const floorY = H * 0.68;
  // wall
  let grad = g.createLinearGradient(0, 0, 0, floorY);
  grad.addColorStop(0, '#5b5650');
  grad.addColorStop(1, '#7c756b');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, floorY);
  // wallpaper: faint stripes above a chair rail, a lighter panelled wall below it
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = 0; x < W; x += 46) g.fillRect(x, 0, 18, H * 0.52);
  g.fillStyle = 'rgba(255,248,236,0.08)';
  g.fillRect(0, H * 0.52, W, floorY - H * 0.52);
  g.fillStyle = '#b5ad9f';
  g.fillRect(0, H * 0.52 - 5, W, 8);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 2;
  for (let x = 30; x < W; x += 180) g.strokeRect(x, H * 0.56, 140, floorY - H * 0.6);
  // ceiling shadow and cornice
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, W, H * 0.06);
  g.fillStyle = '#9d968a';
  g.fillRect(0, H * 0.06, W, 6);
  // floor boards
  grad = g.createLinearGradient(0, floorY, 0, H);
  grad.addColorStop(0, '#6b4a2f');
  grad.addColorStop(1, '#3d2a1b');
  g.fillStyle = grad;
  g.fillRect(0, floorY, W, H - floorY);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    const y = floorY + (H - floorY) * ((i + 1) / 10) ** 1.3;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  for (let x = 37; x < W; x += 151) {
    g.beginPath();
    g.moveTo(x, floorY);
    g.lineTo(x - 60, H);
    g.stroke();
  }
  // skirting board
  g.fillStyle = '#d8d2c6';
  g.fillRect(0, floorY - 14, W, 14);

  const v = (/** @type {number} */ f) => f * W; // horizontal positions as fractions of the panorama
  // the door (left)
  const dx = v(0.14);
  const dw = 150;
  const dh = 330;
  g.fillStyle = '#e9e3d8';
  g.fillRect(dx - 12, floorY - dh - 12, dw + 24, dh + 12);
  grad = g.createLinearGradient(dx, 0, dx + dw, 0);
  grad.addColorStop(0, '#6e4b2e');
  grad.addColorStop(1, '#8a6040');
  g.fillStyle = grad;
  g.fillRect(dx, floorY - dh, dw, dh);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  for (const [y0, y1] of [[0.08, 0.45], [0.53, 0.92]]) g.strokeRect(dx + 18, floorY - dh + dh * y0, dw - 36, dh * (y1 - y0));
  g.fillStyle = '#d9b45a';
  g.beginPath();
  g.arc(dx + dw - 22, floorY - dh * 0.48, 7, 0, Math.PI * 2);
  g.fill();
  // coat hooks with a coat
  g.fillStyle = '#2f3d52';
  g.beginPath();
  g.ellipse(dx + dw + 70, floorY - 230, 30, 80, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#b3462f';
  g.fillRect(dx + dw + 52, floorY - 170, 36, 12);
  // a bookshelf (lots of texture)
  const bx = v(0.29);
  const bw = 230;
  const bh = 300;
  g.fillStyle = '#4a3322';
  g.fillRect(bx, floorY - bh, bw, bh);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const spines = ['#b23a48', '#3a6ea5', '#e0b04a', '#4d8b5b', '#d9d2c5', '#7a4f9e', '#c76b2a', '#2e3b4e'];
  for (let shelf = 0; shelf < 4; shelf++) {
    const sy = floorY - bh + 12 + shelf * 72;
    g.fillStyle = '#3a2718';
    g.fillRect(bx + 6, sy + 60, bw - 12, 8);
    let x = bx + 10;
    while (x < bx + bw - 20) {
      const w = 9 + Math.floor(rnd() * 14);
      const hgt = 38 + Math.floor(rnd() * 22);
      g.fillStyle = spines[Math.floor(rnd() * spines.length)];
      g.fillRect(x, sy + 60 - hgt, w, hgt);
      x += w + 2;
    }
  }
  // the sofa
  const sx = v(0.43);
  g.fillStyle = '#35505e';
  roundRect(g, sx, floorY - 150, 420, 130, 26);
  g.fill();
  g.fillStyle = '#2b4250';
  roundRect(g, sx - 20, floorY - 110, 70, 110, 20);
  g.fill();
  roundRect(g, sx + 370, floorY - 110, 70, 110, 20);
  g.fill();
  g.fillStyle = '#e3c069';
  roundRect(g, sx + 70, floorY - 175, 90, 70, 16);
  g.fill();
  g.fillStyle = '#c95f50';
  roundRect(g, sx + 270, floorY - 172, 85, 66, 16);
  g.fill();
  // pictures above the sofa
  for (const [px, py, pw, ph, c] of [[sx + 60, H * 0.33, 120, 90, '#88a3b8'], [sx + 220, H * 0.29, 90, 120, '#c4a46b'], [sx + 340, H * 0.35, 80, 80, '#8fae8b']]) {
    g.fillStyle = '#2a2724';
    g.fillRect(px - 8, py - 8, pw + 16, ph + 16);
    g.fillStyle = c;
    g.fillRect(px, py, pw, ph);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.beginPath();
    g.moveTo(px, py + ph);
    g.lineTo(px + pw * 0.5, py + ph * 0.35);
    g.lineTo(px + pw, py + ph);
    g.fill();
  }
  // a rug
  g.fillStyle = '#7d3b3b';
  g.beginPath();
  g.ellipse(sx + 210, floorY + 80, 300, 45, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#d7b37a';
  g.lineWidth = 4;
  g.beginPath();
  g.ellipse(sx + 210, floorY + 80, 270, 35, 0, 0, Math.PI * 2);
  g.stroke();
  // the desk with a monitor and a lamp
  const kx = v(0.6);
  g.fillStyle = '#8b6a48';
  g.fillRect(kx, floorY - 120, 260, 16);
  g.fillRect(kx + 10, floorY - 104, 12, 104);
  g.fillRect(kx + 238, floorY - 104, 12, 104);
  g.fillStyle = '#1b1f26';
  g.fillRect(kx + 70, floorY - 230, 140, 90);
  g.fillStyle = '#3c6e9e';
  g.fillRect(kx + 76, floorY - 224, 128, 78);
  g.fillStyle = '#1b1f26';
  g.fillRect(kx + 132, floorY - 140, 16, 20);
  g.fillStyle = '#e6e0c8';
  g.beginPath();
  g.moveTo(kx + 20, floorY - 200);
  g.lineTo(kx + 60, floorY - 200);
  g.lineTo(kx + 50, floorY - 170);
  g.lineTo(kx + 30, floorY - 170);
  g.fill();
  g.fillStyle = '#333';
  g.fillRect(kx + 38, floorY - 170, 4, 50);
  // the window (right): sky, frame, curtains
  const wx = v(0.78);
  const wy = H * 0.22;
  const ww = 300;
  const wh = 260;
  grad = g.createLinearGradient(0, wy, 0, wy + wh);
  grad.addColorStop(0, '#7fb2e5');
  grad.addColorStop(1, '#cfe3f2');
  g.fillStyle = grad;
  g.fillRect(wx, wy, ww, wh);
  g.fillStyle = '#5c8f4e';
  g.beginPath();
  g.ellipse(wx + 80, wy + wh, 120, 70, 0, Math.PI, 0);
  g.fill();
  g.beginPath();
  g.ellipse(wx + 230, wy + wh, 100, 55, 0, Math.PI, 0);
  g.fill();
  g.strokeStyle = '#f2efe8';
  g.lineWidth = 12;
  g.strokeRect(wx, wy, ww, wh);
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(wx + ww / 2, wy);
  g.lineTo(wx + ww / 2, wy + wh);
  g.moveTo(wx, wy + wh / 2);
  g.lineTo(wx + ww, wy + wh / 2);
  g.stroke();
  g.fillStyle = '#a8423c';
  g.fillRect(wx - 60, wy - 20, 50, wh + 70);
  g.fillRect(wx + ww + 10, wy - 20, 50, wh + 70);
  // a plant
  const ppx = v(0.93);
  g.fillStyle = '#b86b3d';
  g.fillRect(ppx - 30, floorY - 70, 60, 70);
  g.fillStyle = '#3f7a3a';
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i - 4) * 0.33;
    g.beginPath();
    g.ellipse(ppx + Math.cos(a) * 45, floorY - 90 + Math.sin(a) * 60, 16, 46, a + Math.PI / 2, 0, Math.PI * 2);
    g.fill();
  }
  // a wall clock, a light switch, a radiator
  g.fillStyle = '#efe9dc';
  g.beginPath();
  g.arc(v(0.69), H * 0.34, 34, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#333';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(v(0.69), H * 0.34);
  g.lineTo(v(0.69) + 18, H * 0.34 - 10);
  g.moveTo(v(0.69), H * 0.34);
  g.lineTo(v(0.69) - 4, H * 0.34 - 24);
  g.stroke();
  g.fillStyle = '#e8e2d4';
  g.fillRect(dx + dw + 24, floorY - 190, 22, 34);
  g.fillStyle = '#cfc8ba';
  for (let i = 0; i < 12; i++) g.fillRect(v(0.83) + i * 16, floorY - 120, 11, 90);
  // soft light from the window
  const light = g.createRadialGradient(wx + ww / 2, wy + wh / 2, 50, wx + ww / 2, wy + wh / 2, W * 0.45);
  light.addColorStop(0, 'rgba(255,240,210,0.18)');
  light.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = light;
  g.fillRect(0, 0, W, H);
}

/** @param {any} g */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draws the camera's frames: the panorama cropped at the virtual position, plus overlays. */
class MockPicture {
  constructor() {
    const C = globalThis.OffscreenCanvas;
    this.supported = typeof C === 'function';
    const views = { x: 1 + 2 / MOCK_TRUTH.viewUnitsX, y: 1 + 2 / MOCK_TRUTH.viewUnitsY };
    this.pw = Math.round(PANO_VIEW.w * views.x);
    this.ph = Math.round(PANO_VIEW.h * views.y);
    this.frame = this.supported ? new C(MOCK_FRAME.width, MOCK_FRAME.height) : null;
    this.pano = null;
    this.walk = 0;
  }

  _pano() {
    if (!this.pano && this.supported) {
      this.pano = new globalThis.OffscreenCanvas(this.pw, this.ph);
      paintRoom(this.pano.getContext('2d'), this.pw, this.ph);
    }
    return this.pano;
  }

  /**
   * @param {{ x: number, y: number }} pos  physical position, -1..1
   * @param {{ person: boolean, dark: boolean, privacy: boolean, name: string }} o
   */
  render(pos, o) {
    if (!this.frame) return null;
    const g = this.frame.getContext('2d');
    const W = MOCK_FRAME.width;
    const H = MOCK_FRAME.height;
    if (o.privacy) {
      g.fillStyle = '#101317';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#9aa7b4';
      g.font = '28px sans-serif';
      g.textAlign = 'center';
      g.fillText('Privacy Mode is on', W / 2, H / 2);
      g.textAlign = 'left';
      return this.frame.transferToImageBitmap();
    }
    if (o.dark) {
      g.fillStyle = '#1c1d1f';
      g.fillRect(0, 0, W, H);
    } else {
      const pano = this._pano();
      // +x pans right (the crop moves right), +y tilts up (the crop moves up)
      const sx = ((pos.x + 1) / 2) * (this.pw - PANO_VIEW.w);
      const sy = ((1 - pos.y) / 2) * (this.ph - PANO_VIEW.h);
      g.imageSmoothingQuality = 'medium';
      g.drawImage(pano, sx, sy, PANO_VIEW.w, PANO_VIEW.h, 0, 0, W, H);
      if (o.person) this._person(g, sx, sy, W / PANO_VIEW.w);
    }
    // the camera's own timestamp, like a real camera's
    const d = new Date();
    g.font = '600 18px ui-monospace, monospace';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(14, 12, 236, 28);
    g.fillStyle = '#f2f2f2';
    g.fillText(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, 22, 32);
    return this.frame.transferToImageBitmap();
  }

  /** A pure green walking figure near the door (what the stub detector looks for). */
  _person(g, sx, sy, k) {
    this.walk += 1 / MOCK_FPS;
    const floorY = this.ph * 0.68;
    // in front of the sofa, so the default view (and the tests) see it
    const span = this.pw * 0.16;
    const px = this.pw * 0.42 + (Math.sin(this.walk * 0.6) * 0.5 + 0.5) * span;
    const x = (px - sx) * k;
    const feet = (floorY + 30 - sy) * k;
    const hgt = 290 * k;
    g.fillStyle = '#00ff00';
    g.beginPath();
    g.arc(x, feet - hgt + 26 * k, 26 * k, 0, Math.PI * 2);
    g.fill();
    roundRect(g, x - 36 * k, feet - hgt + 56 * k, 72 * k, 130 * k, 18 * k);
    g.fill();
    const step = Math.sin(this.walk * 6) * 16 * k;
    g.fillRect(x - 28 * k + step, feet - hgt + 180 * k, 22 * k, hgt - 180 * k);
    g.fillRect(x + 6 * k - step, feet - hgt + 180 * k, 22 * k, hgt - 180 * k);
  }
}

// ------------------------------------------------------------------------------------------
// window.lawnmowerCamera

/**
 * @param {{ scenario?: string, win?: any, settings?: Record<string, any>, detector?: 'stub'|'mediapipe' }} [o]
 * @returns {any} the window.lawnmowerCamera API (+ __mock)
 */
export function createMockCameraBridge(o = {}) {
  const win = o.win || globalThis.window;
  const scenario = o.scenario || 'online';
  const initial = deepMerge(DEFAULT_SETTINGS, {
    tapo: scenario === 'setup'
      ? { enabled: true, host: '', username: '' }
      : { enabled: true, name: 'camera', host: '192.168.1.50', username: 'camacct' },
  });
  let settings = deepMerge(initial, sanitizeTapoPatch(o.settings || {}));
  const settingsListeners = new Set();
  const patchSettings = (/** @type {any} */ patch) => {
    const next = deepMerge(settings, sanitizeTapoPatch(patch));
    if (JSON.stringify(next) === JSON.stringify(settings)) return false;
    const prev = settings;
    settings = next;
    queueMicrotask(() => {
      for (const cb of [...settingsListeners]) cb(clone(settings));
    });
    onSettingsChanged(prev, settings);
    return true;
  };
  const core = createMockTapoCore({ scenario, getSettings: () => settings, patchSettings, assetBase: win?.document?.baseURI });
  const picture = new MockPicture();
  const scene = { person: false, dark: false };
  /** @type {any} the "main" end of the worker channel */
  let port = null;
  let frameTimer = 0;
  let viewVisible = true;
  let frames = 0;
  let snapSeq = 0;
  /** @type {Map<any, (m: any) => void>} */
  const pending = new Map();
  /** @type {any|null} the next connection test's answer (tests) */
  let scripted = null;

  const assets = () => {
    const base = win?.document?.baseURI || 'http://127.0.0.1/';
    return { wasmBase: new URL('../assets/vision/wasm/', base).href, modelUrl: new URL('../assets/security/efficientdet_lite0_int8.tflite', base).href };
  };
  const toWorker = (/** @type {any} */ m, /** @type {any[]} */ tr = []) => {
    try {
      port?.postMessage(m, tr);
    } catch (err) {
      console.warn('[mock-tapo] post to the worker failed', err);
    }
  };
  const armedMsg = () => ({ t: 'armed', on: core.security.armed, people: settings.security.people, sensitivity: settings.security.sensitivity });
  core.onArmedChanged = () => toWorker(armedMsg());
  core.subscribe('ptz', (/** @type {any} */ p) => toWorker({ t: 'ptz', moving: p.moving, settleUntil: p.settleUntil }));
  core.onEventStart = (ev) => {
    // the event's picture: a snapshot from the worker (like main's 'best' snapshot)
    snap(480, 0.75).then((r) => {
      if (!r) return;
      const url = URL.createObjectURL(new Blob([r.jpeg], { type: 'image/jpeg' }));
      ev.snapshotUrl = url;
      if (core.security.active === ev) core.emit('event', { phase: 'update', event: ev });
    });
  };

  /** @param {number} maxSide @param {number} quality @returns {Promise<any>} */
  function snap(maxSide, quality) {
    if (!port) return Promise.resolve(null);
    const id = `snap-${++snapSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 4000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m.t === 'snap-ok' ? m : null);
      });
      toWorker({ t: 'snap', id, maxSide, quality });
    });
  }

  const streamWanted = () => {
    const st = core.statusNow();
    return st.connection === 'online' && scenario !== 'h265' && (viewVisible || core.security.armed || core.security.arming || calib.running);
  };
  const pump = () => {
    if (!port || !streamWanted()) return;
    const image = picture.render(core.cam.pos, { person: scene.person, dark: scene.dark || (calib.running && scenario === 'calib-ask'), privacy: scenario === 'privacy', name: settings.tapo.name });
    if (!image) return;
    frames++;
    toWorker({ t: 'bitmap', image, ts: performance.now() }, [image]);
  };

  /** @param {any} m a worker → main message */
  const fromWorker = (m) => {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready': core.setDetector(m.detector); break;
      case 'stats': core.setWorkerStats(m); break;
      case 'det':
        if (m.detected && Array.isArray(m.persons)) {
          const best = Math.max(0, ...m.persons.map((/** @type {any} */ p) => p.score));
          if (best >= 0.5) core.evidence('person', best);
        }
        if (m.motion?.active) core.evidence('motion', 0);
        break;
      case 'snap-ok':
      case 'snap-err':
      case 'shift': {
        const cb = pending.get(m.id);
        if (cb) {
          pending.delete(m.id);
          cb(m);
        }
        break;
      }
      case 'error':
        console.warn('[mock-tapo] worker:', m.message);
        break;
      default:
    }
  };

  const openPort = () => {
    const ch = new MessageChannel();
    try {
      port?.close();
    } catch { /* gone */ }
    port = ch.port1;
    port.onmessage = (/** @type {MessageEvent} */ e) => fromWorker(e.data);
    port.start?.();
    toWorker({ t: 'hello', detector: o.detector === 'mediapipe' ? 'mediapipe' : 'stub', ...assets() });
    toWorker(armedMsg());
    if (scenario === 'h265') {
      toWorker({ t: 'config', gen: 1, codec: 'hvc1.1.6.L120.B0', description: new ArrayBuffer(0), width: 2304, height: 1296 });
    }
    clearInterval(frameTimer);
    frameTimer = /** @type {any} */ (setInterval(pump, 1000 / MOCK_FPS));
    // exactly what preload-camera.cjs does with main's port
    win.postMessage({ type: 'lm:tapo:port' }, '*', [ch.port2]);
  };

  /** @param {any} prev @param {any} next */
  function onSettingsChanged(prev, next) {
    const conn = ['host', 'onvifPort', 'rtspPort', 'username', 'enabled'];
    if (conn.some((k) => prev.tapo[k] !== next.tapo[k])) core.reconnect();
    else core.emitStatus();
    if (prev.security.people !== next.security.people || prev.security.sensitivity !== next.security.sensitivity) toWorker(armedMsg());
    if (!prev.security.armed && next.security.armed && !core.security.armed && !core.security.arming) core.arm({ armed: true });
    if (prev.security.armed && !next.security.armed && (core.security.armed || core.security.arming)) core.arm({ armed: false });
  }

  // ---------------------------------------------------------------- calibration (main's wizard)
  const calib = { running: false, token: 0, state: /** @type {any} */ ({ step: 'idle', progress: 0 }), answer: /** @type {((a: string) => void)|null} */ (null) };
  /** @param {any} s */
  const setCalib = (s) => {
    calib.state = s;
    core.emit('calibration', s);
  };
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  const waitStill = async (/** @type {number} */ token) => {
    const t0 = Date.now();
    while ((core.cam.moving || core.cam.target) && Date.now() - t0 < 8000) {
      await sleep(80);
      if (token !== calib.token) throw new Error('cancelled');
    }
  };
  /** @param {number} timeoutMs @returns {Promise<any>} */
  const measure = (timeoutMs) => new Promise((resolve) => {
    const id = `shift-${++snapSeq}`;
    pending.set(id, resolve);
    toWorker({ t: 'shift-measure', id, timeoutMs });
  });
  /** @param {string} question @returns {Promise<string>} */
  /** Like main (calibration.js): only the answers for the axis just moved are taken. */
  const ask = (question, progress, answers) => new Promise((resolve) => {
    calib.answer = (/** @type {string} */ a) => {
      if (!answers.includes(a)) return false;
      calib.answer = null;
      resolve(a);
      return true;
    };
    setCalib({ step: 'ask', question, progress, answers: [...answers] });
  });
  async function runCalibration(token) {
    const check = () => {
      if (token !== calib.token) throw new Error('cancelled');
    };
    const start = { ...core.cam.pos };
    const result = { invertPan: settings.tapo.invertPan, invertTilt: settings.tapo.invertTilt, viewUnitsX: settings.tapo.viewUnitsX, viewUnitsY: settings.tapo.viewUnitsY, minStep: settings.tapo.minStep, msPerUnit: settings.tapo.msPerUnit };
    /** One raw move and the worker's measurement. @param {number} x @param {number} y */
    const probe = async (x, y) => {
      toWorker({ t: 'shift-ref' });
      await sleep(250);
      check();
      const t0 = Date.now();
      core.relativeMove(x, y, { raw: true });
      const m = measure(6000);
      await waitStill(token);
      const r = await m;
      check();
      return { ...r, ms: Date.now() - t0 };
    };
    const back = async (x, y) => {
      core.relativeMove(-x, -y, { raw: true });
      await waitStill(token);
      await sleep(300);
    };
    setCalib({ step: 'pan', progress: 0.05 });
    let pan = await probe(0.2, 0);
    if (pan.score >= 0.15 && Math.abs(pan.dx) >= 0.02) {
      result.invertPan = pan.dx > 0;
      result.viewUnitsX = Math.round((0.2 / Math.abs(pan.dx)) * 1000) / 1000;
      result.msPerUnit = Math.round(Math.max(500, Math.min(20000, pan.ms / 0.2)));
    } else {
      const a = await ask('Which way did the camera turn? (The picture moves the other way.)', 0.25, ['left', 'right', 'none']);
      check();
      if (a === 'none') throw new Error('The camera did not seem to move. Is privacy mode on, or is pan and tilt disabled?');
      result.invertPan = a === 'left'; // told to turn right, it turned left: mirrored
    }
    setCalib({ step: 'pan', progress: 0.35 });
    await back(0.2, 0);
    setCalib({ step: 'tilt', progress: 0.45 });
    const tilt = await probe(0, 0.2);
    if (tilt.score >= 0.15 && Math.abs(tilt.dy) >= 0.02) {
      result.invertTilt = tilt.dy < 0;
      result.viewUnitsY = Math.round((0.2 / Math.abs(tilt.dy)) * 1000) / 1000;
    } else {
      const a = await ask('Which way did the camera tilt? (The picture moves the other way.)', 0.6, ['up', 'down', 'none']);
      check();
      if (a === 'none') throw new Error('The camera did not seem to tilt.');
      result.invertTilt = a === 'down'; // told to tilt up, it tilted down: inverted
    }
    setCalib({ step: 'tilt', progress: 0.7 });
    await back(0, 0.2);
    setCalib({ step: 'min-step', progress: 0.8 });
    if (scenario !== 'calib-ask') {
      for (const step of [0.02, 0.05]) {
        const r = await probe(step, 0);
        if (Math.abs(r.dx) > 0.01) {
          result.minStep = step;
          await back(step, 0);
          break;
        }
      }
    }
    pan = null;
    core.cam.target = { ...start };
    await waitStill(token);
    check();
    patchSettings({ tapo: { ...result, calibratedAt: new Date().toISOString() } });
    setCalib({ step: 'done', progress: 1, result });
  }

  const cameraApi = {
    settings: {
      async get() {
        return clone(settings);
      },
      /** The camera window may change only the tapo and security groups (like main). @param {any} patch */
      async set(patch) {
        if (isPlainObject(patch) && Object.keys(patch).some((k) => k !== 'tapo' && k !== 'security')) throw new Error('The camera window can only change Home camera settings.');
        patchSettings(patch);
        return clone(settings);
      },
      onChange: (/** @type {Function} */ cb) => {
        settingsListeners.add(cb);
        return () => settingsListeners.delete(cb);
      },
    },
    tapo: {
      status: () => core.status(),
      onStatus: (/** @type {Function} */ cb) => core.subscribe('status', cb),
      onEvent: (/** @type {Function} */ cb) => core.subscribe('event', cb),
      onOpenEvent: (/** @type {Function} */ cb) => core.subscribe('openEvent', cb),
      onCalibration: (/** @type {Function} */ cb) => core.subscribe('calibration', cb),
      setCredentials: (/** @type {any} */ a) => core.setCredentials(a),
      clearCredentials: () => core.clearCredentials(),
      /** @param {any} [over] */
      async test(over = {}) {
        core.calls.push({ at: Date.now(), op: 'test', host: over.host, hasPassword: !!over.password });
        // the scripted answer belongs to the next call made, not to one already running
        const r = scripted;
        scripted = null;
        await sleep(700);
        if (r) return clone(r);
        return mockTestReport({ host: over.host || settings.tapo.host, password: over.password, scenario });
      },
      async discover() {
        await sleep(600);
        return [{ host: '192.168.1.50', xaddr: 'http://192.168.1.50:2020/onvif/device_service', name: 'Tapo C211', model: 'C211', hardware: 'C211' }];
      },
      ptz: (/** @type {any} */ cmd) => core.ptz(cmd),
      presets: () => core.presets(),
      savePreset: (/** @type {any} */ a) => core.savePreset(a),
      removePreset: (/** @type {any} */ a) => core.removePreset(a),
      arm: (/** @type {any} */ a) => core.arm(a),
      /** @param {{ action: string, answer?: string }} req */
      async calibrate(req) {
        const action = req?.action;
        if (action === 'start') {
          const st = core.statusNow();
          if (!st.ptz.available) return { step: 'failed', progress: 0, error: 'Pan and tilt are not available, so there is nothing to calibrate.' };
          if (st.ptz.privacySuspected) return { step: 'failed', progress: 0, error: 'Turn privacy mode off in the Tapo app first.' };
          if (st.connection !== 'online') return { step: 'failed', progress: 0, error: 'The camera is offline.' };
          const token = ++calib.token;
          calib.running = true;
          setCalib({ step: 'pan', progress: 0 });
          runCalibration(token).catch((err) => {
            if (token !== calib.token) return;
            core.cam.target = null;
            setCalib({ step: 'failed', progress: calib.state.progress || 0, error: String(err?.message || err) });
          }).finally(() => {
            if (token === calib.token) calib.running = false;
          });
          return clone(calib.state);
        }
        if (action === 'answer') {
          const a = String(req.answer || '');
          if (!['left', 'right', 'up', 'down', 'none'].includes(a)) throw new Error('Invalid answer');
          // an answer for the other axis is not taken: the state stays "ask" (as in main)
          calib.answer?.(a);
          return clone(calib.state);
        }
        if (action === 'cancel') {
          calib.token++;
          calib.running = false;
          calib.answer = null;
          core.cam.velocity = null;
          core.cam.target = null;
          setCalib({ step: 'idle', progress: 0 });
          return clone(calib.state);
        }
        throw new Error('Invalid calibration request');
      },
      events: {
        list: (/** @type {any} */ q) => core.listEvents(q),
        remove: (/** @type {any} */ a) => core.removeEvent(a),
        ack: (/** @type {any} */ a) => core.ackEvent(a),
        openFolder: () => core.openClips(),
      },
      /** @param {boolean} v */
      setViewVisible(v) {
        viewVisible = !!v;
        core.calls.push({ at: Date.now(), op: 'view', visible: viewVisible });
      },
      async requestPort() {
        openPort();
        return { ok: true };
      },
      /** Reconnect now (offline / a problem; never a refused sign-in). */
      async retry() {
        core.calls.push({ at: Date.now(), op: 'retry' });
        const st = core.statusNow();
        if (st.connection === 'auth-failed') return { ok: false, needsPassword: true };
        return { ok: true, connection: st.connection };
      },
      /** The redacted diagnostic report (what main builds from the connection test and the status). */
      async diagnostics() {
        core.calls.push({ at: Date.now(), op: 'diagnostics' });
        await sleep(300);
        const test = mockTestReport({ host: settings.tapo.host, scenario });
        const user = (settings.tapo.username || '').length >= 3 ? settings.tapo.username : '\u0000';
        return JSON.parse(JSON.stringify({ tool: 'lawnmower-diagnostics', version: 1, appVersion: '0.1.0', at: new Date().toISOString(), platform: 'browser', test, status: core.statusNow() })
          .split(settings.tapo.host || '\u0000').join('<camera>').split(user).join('<camera account>'));
      },
    },
    app: {
      async info() {
        return { version: '0.1.0', platform: 'browser', mock: true };
      },
    },
  };

  if (scenario === 'privacy' || scenario === 'online' || scenario === 'noptz' || scenario === 'calib-ask' || scenario === 'h265') core.reconnect();
  else core.emitStatus();
  queueMicrotask(() => core.restoreArmed());

  const hooks = {
    calls: core.calls,
    /** @param {boolean} on */
    person(on) {
      scene.person = !!on;
    },
    /** @param {boolean} on  a dark, featureless picture */
    dark(on) {
      scene.dark = !!on;
    },
    /** @param {Record<string, any>} patch merged into every status */
    set(patch) {
      core.setOverrides(patch);
    },
    /** @param {string} c */
    connection(c) {
      core.setConnection(c);
    },
    /** @param {any} report the next test() answer */
    scriptTest(report) {
      scripted = clone(report);
    },
    /** @param {string} id */
    openEvent(id) {
      core.emit('openEvent', { id });
    },
    state: () => ({ pos: { ...core.cam.pos }, moving: core.cam.moving, armed: core.security.armed, arming: core.security.arming, active: clone(core.security.active), frames, settings: clone(settings), presets: core.presets.map((p) => ({ token: p.token, name: p.name })) }),
    frames: () => frames,
    dispose() {
      clearInterval(frameTimer);
      core.dispose();
    },
  };
  if (win) win.__tapoMock = hooks;
  return { ...cameraApi, __mock: hooks };
}
