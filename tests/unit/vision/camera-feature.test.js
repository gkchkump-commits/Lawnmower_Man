// CameraFeature (src/vision/index.js) with fakes: consent, start/stop/errors, visibility,
// behaviours (eye contact, presence sleep/wake, smile back, greeting, look-to-talk), the
// detection rate, and the pictures it hands the controller.
import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
import { withDefaults, deepMerge } from '../../../src/app/settings-defaults.js';
import { summarizeFaceResult } from '../../../src/vision/attention.js';
import { CONSENT_KEY, CameraFeature, MIRROR_SMILE, QUICK_GREETINGS, TRACK_RATES, WELCOME, greetingPrompt, quickGreeting } from '../../../src/vision/index.js';
import { faceResult } from './helpers.js';

const MIN = 60_000;
const face = (o) => summarizeFaceResult(faceResult(o), 320, 240);

function setup(o = {}) {
  let now = 1000;
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  let settings = withDefaults(deepMerge({ camera: { enabled: false } }, o.settings || {}));
  const saved = [];
  const camera = Object.assign(new Emitter(), {
    label: 'Fake Cam',
    video: null,
    fail: /** @type {string[]} */ ([]),
    start: vi.fn(async () => {
      const f = camera.fail.shift();
      if (f) throw Object.assign(new Error(f), { name: f });
      camera.video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
    }),
    stop: vi.fn(() => { camera.video = null; }),
  });
  const trackers = [];
  const createTracker = () => {
    const t = Object.assign(new Emitter(), {
      mode: 'worker', delegate: 'CPU', rate: 0, lastMs: 0, frames: 0,
      start: vi.fn(async () => { t.emit('ready', { mode: 'worker' }); }),
      setVideo: vi.fn(), setRate: vi.fn((hz) => { t.rate = hz; }), dispose: vi.fn(),
    });
    trackers.push(t);
    return t;
  };
  const expressions = [];
  const avatar = { setExpression: vi.fn((e) => expressions.push(e)), blink: vi.fn() };
  const gazes = [];
  const gaze = { setFace: vi.fn((g) => gazes.push(g)) };
  const controller = {
    state: 'idle', sleeping: false, claudeProblem: null, claudeStatus: { status: 'ready' },
    provider: null, gate: true, sent: [],
    idle: true,
    isIdle: () => controller.idle,
    setSnapshotProvider: (p) => { controller.provider = p; },
    setListenGate: vi.fn((open) => { controller.gate = open; }),
    sleep: vi.fn(() => { controller.sleeping = true; return true; }),
    noteActivity: vi.fn(() => { controller.sleeping = false; }),
    sendText: vi.fn((text, opts) => { controller.sent.push([text, opts]); return true; }),
    said: [],
    say: vi.fn((text) => { if (!controller.idle) return false; controller.said.push(text); return true; }),
  };
  const store = new Map(o.consent ? [[CONSENT_KEY, 'yes']] : []);
  const view = {
    states: [], consent: null, errors: [], toasts: [],
    setState: (s) => view.states.push(s),
    showConsent: (cb) => { view.consent = cb; },
    hideConsent: () => { view.consent = null; },
    showError: (m, cb) => view.errors.push({ m, cb }),
    hideError: vi.fn(),
    toast: (m) => view.toasts.push(m),
    setDevices: vi.fn(),
  };
  const capture = vi.fn(async () => ({ mediaType: 'image/jpeg', data: '/9j/AAAA', width: 640, height: 480, thumb: 'data:image/jpeg;base64,/9j/BB' }));
  const feat = new CameraFeature({
    getSettings: () => settings,
    saveSettings: vi.fn(async (patch) => {
      saved.push(patch);
      settings = withDefaults(deepMerge(settings, patch));
      feat.applySettings(settings);
    }),
    controller, getAvatar: () => avatar, gaze, view, camera, createTracker,
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) },
    capture, listCameras: async () => [{ id: 'a', label: 'Fake Cam' }],
    userBusy: () => !!o.userBusy?.(),
    hour: () => o.hour ?? 10, random: () => 0,
    platform: 'win32', ...clock,
  });
  const set = (patch) => {
    settings = withDefaults(deepMerge(settings, patch));
    feat.applySettings(settings);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** a tracker frame at the current time, then advance */
  const frame = (obs, dt = 83) => {
    trackers.at(-1).emit('observation', { obs, t: now, ms: 10 });
    advance(dt);
  };
  return { feat, camera, trackers, controller, avatar, expressions, gaze, gazes, view, store, saved, capture, set, flush, frame, advance, now: () => now, settings: () => settings };
}

describe('CameraFeature: turning the camera on and off', () => {
  it('the first time, the privacy card comes first; nothing is opened before the OK', async () => {
    const h = setup();
    h.set({ camera: { enabled: true } });
    expect(h.feat.state).toBe('consent');
    expect(h.camera.start).not.toHaveBeenCalled();
    expect(h.view.consent).toBeTruthy();
    h.view.consent.onAccept();
    await h.flush();
    expect(h.store.get(CONSENT_KEY)).toBe('yes');
    expect(h.camera.start).toHaveBeenCalledWith('');
    expect(h.feat.state).toBe('on');
    expect(h.trackers).toHaveLength(1);
    expect(h.trackers[0].setVideo).toHaveBeenCalledWith(h.camera.video);
    expect(h.view.setDevices).toHaveBeenCalled();
    expect(h.view.setDevices).toHaveBeenLastCalledWith([{ id: 'a', label: 'Fake Cam' }], { known: true });
    expect(h.view.states.at(-1)).toMatchObject({ state: 'on' });
  });

  it('"Not now" turns the setting off again; the next time asks again', async () => {
    const h = setup();
    h.set({ camera: { enabled: true } });
    h.view.consent.onDecline();
    await h.flush();
    expect(h.saved).toEqual([{ camera: { enabled: false } }]);
    expect(h.feat.state).toBe('off');
    expect(h.camera.start).not.toHaveBeenCalled();
    h.set({ camera: { enabled: true } });
    expect(h.feat.state).toBe('consent');
  });

  it('after the OK once, it starts straight away; turning it off releases camera and tracker', async () => {
    const h = setup({ consent: true });
    h.set({ camera: { enabled: true, deviceId: 'cam-2' } });
    await h.flush();
    expect(h.camera.start).toHaveBeenCalledWith('cam-2');
    expect(h.feat.state).toBe('on');
    h.set({ camera: { deviceId: 'cam-3' } }); // another camera: reopened
    await h.flush();
    expect(h.camera.start).toHaveBeenLastCalledWith('cam-3');
    h.set({ camera: { enabled: false } });
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.trackers[0].dispose).toHaveBeenCalled();
    expect(h.feat.state).toBe('off');
    expect(h.gazes.at(-1)).toBeNull();
    expect(h.controller.gate).toBe(true);
  });

  it('a blocked camera shows the Windows card; Try again retries, "Turn off" saves the setting', async () => {
    const h = setup({ consent: true });
    h.camera.fail.push('NotAllowedError');
    h.set({ camera: { enabled: true } });
    await h.flush();
    expect(h.feat.state).toBe('error');
    expect(h.view.errors[0].m.kind).toBe('denied');
    expect(h.view.errors[0].m.steps.join(' ')).toMatch(/Let desktop apps access your camera/);
    h.view.errors[0].cb.onRetry();
    await h.flush();
    expect(h.feat.state).toBe('on');
    h.camera.fail.push('NotReadableError');
    h.set({ camera: { deviceId: 'other' } });
    await h.flush();
    expect(h.view.errors[1].m.kind).toBe('busy');
    h.view.errors[1].cb.onTurnOff();
    await h.flush();
    expect(h.saved.at(-1)).toEqual({ camera: { enabled: false } });
    expect(h.feat.state).toBe('off');
  });

  it('a camera that stops by itself (unplugged, taken over) shows the error card', async () => {
    const h = setup({ consent: true });
    h.set({ camera: { enabled: true } });
    await h.flush();
    h.camera.emit('ended');
    expect(h.feat.state).toBe('error');
    expect(h.view.errors.at(-1).m.kind).toBe('busy');
  });

  it('face tracking that gives up keeps the camera (snapshots work), opens the listen gate, retries on the next start', async () => {
    const h = setup({ consent: true, settings: { camera: { lookToTalk: true }, voice: { handsFree: true } } });
    h.set({ camera: { enabled: true } });
    await h.flush();
    for (let i = 0; i < 6; i++) h.frame(face({ yawDeg: 45 }));
    expect(h.controller.gate).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.trackers[0].emit('error', Object.assign(new Error('the face tracker stopped answering'), { fatal: true }));
    warn.mockRestore();
    expect(h.feat.tracking).toBe('failed');
    expect(h.feat.state).toBe('on');
    expect(h.view.toasts.at(-1)).toMatch(/not available \(the face tracker stopped answering\)/);
    expect(h.controller.gate).toBe(true);
    expect(h.controller.provider.wants({ hidden: false })).toBe(false);
    h.feat.toggleShot();
    expect(h.controller.provider.wants({ hidden: false })).toBe(true); // pictures still work
    h.feat.setVisible(false);
    h.feat.setVisible(true);
    await h.flush();
    expect(h.trackers[0].dispose).toHaveBeenCalled();
    expect(h.trackers).toHaveLength(2);
    expect(h.feat.tracking).toBe('on');
    expect(h.feat.trackingError).toBe('');
  });

  it('no dozing off while the user types or uses the mouse, even when the camera cannot see the face', async () => {
    const h = await onWithFace();
    for (let i = 0; i < 4; i++) h.frame(face());
    // the face is lost (camera to the side, dark room) while the user keeps typing for 3 minutes
    for (let i = 0; i < 4 * 180; i++) {
      if (i % 4 === 0) h.controller.lastActivityAt = h.now(); // a key every second
      h.frame(null, 250);
    }
    expect(h.controller.sleep).not.toHaveBeenCalled();
    // the typing stops: it dozes off about 2 minutes later, once
    const stoppedAt = h.controller.lastActivityAt;
    let sleptAt = null;
    for (let i = 0; i < 4 * 180; i++) {
      h.frame(null, 250);
      if (sleptAt === null && h.controller.sleep.mock.calls.length) sleptAt = h.now();
    }
    expect(h.controller.sleep).toHaveBeenCalledTimes(1);
    expect(sleptAt - stoppedAt).toBeGreaterThanOrEqual(2 * MIN);
    expect(sleptAt - stoppedAt).toBeLessThan(2 * MIN + 1000);
  });

  it('warns once that the chosen camera is missing, not on every restore; again after it worked', async () => {
    const h = setup({ consent: true, settings: { camera: { deviceId: 'desk' } } });
    let plugged = false;
    h.camera.start.mockImplementation(async (id) => {
      if (id === 'desk' && !plugged) {
        h.camera.emit('device-fallback', id); // CameraCapture opened the default camera instead
        h.camera.deviceId = 'laptop';
      } else {
        h.camera.deviceId = id || 'laptop';
      }
      h.camera.video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
    });
    const warnings = () => h.view.toasts.filter((t) => /not connected/.test(t)).length;
    h.set({ camera: { enabled: true } });
    await h.flush();
    expect(warnings()).toBe(1);
    for (let i = 0; i < 2; i++) {
      h.feat.setVisible(false); // minimized / hidden to the tray
      h.feat.setVisible(true);
      await h.flush();
    }
    expect(h.camera.start).toHaveBeenCalledTimes(3);
    expect(warnings()).toBe(1);
    // back at the desk: it opens; unplugged again later: one new warning
    plugged = true;
    h.feat.setVisible(false);
    h.feat.setVisible(true);
    await h.flush();
    plugged = false;
    h.feat.setVisible(false);
    h.feat.setVisible(true);
    await h.flush();
    expect(warnings()).toBe(2);
  });

  it('the device list says whether a missing saved camera is really unplugged (ids are hidden while off)', async () => {
    const h = setup({ consent: true });
    await h.feat.refreshDevices(); // the drawer opened with the camera off
    expect(h.view.setDevices).toHaveBeenLastCalledWith([{ id: 'a', label: 'Fake Cam' }], { known: false });
    h.set({ camera: { enabled: true } });
    await h.flush();
    expect(h.view.setDevices).toHaveBeenLastCalledWith([{ id: 'a', label: 'Fake Cam' }], { known: true });
  });

  it('pauses and releases the camera while the window is hidden, resumes when shown', async () => {
    const h = setup({ consent: true });
    h.set({ camera: { enabled: true } });
    await h.flush();
    h.feat.setVisible(false);
    expect(h.feat.state).toBe('paused');
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.trackers[0].setRate).toHaveBeenLastCalledWith(0);
    h.feat.setVisible(true);
    await h.flush();
    expect(h.feat.state).toBe('on');
    expect(h.camera.start).toHaveBeenCalledTimes(2);
    // enabled while hidden: waits
    const g = setup({ consent: true });
    g.feat.setVisible(false);
    g.set({ camera: { enabled: true } });
    await g.flush();
    expect(g.feat.state).toBe('paused');
    expect(g.camera.start).not.toHaveBeenCalled();
  });

  it('the toolbar button toggles the setting', async () => {
    const h = setup({ consent: true });
    await h.feat.toggle();
    expect(h.saved.at(-1)).toEqual({ camera: { enabled: true } });
    await h.flush();
    await h.feat.toggle();
    expect(h.saved.at(-1)).toEqual({ camera: { enabled: false } });
  });
});

async function onWithFace(o = {}) {
  const h = setup({ consent: true, ...o });
  h.set({ camera: { enabled: true } });
  await h.flush();
  return h;
}

describe('CameraFeature: behaviours', () => {
  it('eye contact follows the face (followFace), and is released when off or the face leaves', async () => {
    const h = await onWithFace();
    for (let i = 0; i < 4; i++) h.frame(face({ cx: 0.3 }));
    const g = h.gazes.at(-1);
    expect(g[0]).toBeGreaterThan(0.05); // mirrored: screen right, small lean
    expect(g[0]).toBeLessThan(0.3);
    h.set({ camera: { followFace: false } });
    expect(h.gazes.at(-1)).toBeNull();
    h.frame(face({ cx: 0.3 }));
    expect(h.gazes.at(-1)).toBeNull();
  });

  it('the detection rate follows presence and sleep', async () => {
    const h = await onWithFace();
    const t = h.trackers[0];
    expect(t.rate).toBe(TRACK_RATES.searching);
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(t.rate).toBe(TRACK_RATES.tracking);
    h.controller.sleeping = true;
    h.frame(face());
    expect(t.rate).toBe(TRACK_RATES.sleeping);
  });

  it('smiles back while the user smiles (mirrorExpressions)', async () => {
    const h = await onWithFace();
    for (let i = 0; i < 4; i++) h.frame(face()); // the first sight: hello (welcome smile)
    h.advance(WELCOME.smileMs + 10);
    const smiling = face({ blend: { mouthSmileLeft: 0.85, mouthSmileRight: 0.8 } });
    for (let i = 0; i < 10; i++) h.frame(smiling);
    expect(h.expressions.at(-1)).toEqual({ smile: MIRROR_SMILE, browUp: 0 });
    for (let i = 0; i < 12; i++) h.frame(face());
    expect(h.expressions.at(-1)).toEqual({ smile: 0, browUp: 0 });
    h.set({ camera: { mirrorExpressions: false } });
    for (let i = 0; i < 10; i++) h.frame(smiling);
    expect(h.expressions.at(-1).smile).toBe(0);
  });

  it('presence: away > 2 min while idle → sleep; back → wake with a brow raise and a smile', async () => {
    const h = await onWithFace();
    for (let i = 0; i < 4; i++) h.frame(face());
    // gone: frames without a face for over two minutes (at the searching rate)
    for (let i = 0; i < 4 * 125; i++) h.frame(null, 250);
    expect(h.controller.sleep).toHaveBeenCalledTimes(1);
    expect(h.controller.sleeping).toBe(true);
    // back
    h.frame(face(), 250);
    h.frame(face(), 250);
    expect(h.controller.noteActivity).toHaveBeenCalled();
    expect(h.controller.sleeping).toBe(false);
    expect(h.expressions.at(-1)).toEqual({ smile: WELCOME.smile, browUp: WELCOME.browUp });
    h.advance(WELCOME.browMs);
    expect(h.expressions.at(-1)).toEqual({ smile: WELCOME.smile, browUp: 0 });
    h.advance(WELCOME.smileMs);
    expect(h.expressions.at(-1)).toEqual({ smile: 0, browUp: 0 });
    // presence off: no sleeping
    h.set({ camera: { presence: false } });
    for (let i = 0; i < 4 * 125; i++) h.frame(null, 250);
    expect(h.controller.sleep).toHaveBeenCalledTimes(1);
  });

  it('says a quick hello at the first sight and when the user is back (by default), rate-limited', async () => {
    const h = await onWithFace({ hour: 9 });
    const away = (minutes) => {
      h.frame(null, minutes * MIN);
      h.frame(null, 250);
      h.frame(null, 250);
    };
    const back = () => {
      for (let i = 0; i < 4; i++) h.frame(face());
    };
    back(); // the camera was just turned on and sees the user
    expect(h.controller.said).toEqual([QUICK_GREETINGS.morning[0]]);
    expect(h.controller.sendText).not.toHaveBeenCalled(); // no Claude turn
    expect(h.expressions.at(-1)).toEqual({ smile: WELCOME.smile, browUp: WELCOME.browUp });
    away(1); // a short absence: nothing
    back();
    expect(h.controller.said).toHaveLength(1);
    away(6); // back after 6 min (and 7 since the hello)
    back();
    expect(h.controller.said).toEqual([QUICK_GREETINGS.morning[0], QUICK_GREETINGS.back[0]]);
    away(3); // 3 min away, but the last hello was 3 min ago: rate limit
    back();
    expect(h.controller.said).toHaveLength(2);
    away(40); // busy (a reply runs): no hello
    h.controller.idle = false;
    back();
    expect(h.controller.said).toHaveLength(2);
    // greeting off: nothing, but the welcome after a long absence still shows
    h.controller.idle = true;
    h.set({ camera: { greeting: 'off' } });
    away(40);
    back();
    expect(h.controller.said).toHaveLength(2);
  });

  it('hides and shows of the window do not count as being away; turning the camera on again does', async () => {
    const h = await onWithFace();
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.said).toHaveLength(1);
    h.feat.setVisible(false);
    h.advance(20 * MIN);
    h.feat.setVisible(true);
    await h.flush();
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.said).toHaveLength(1); // restored: no hello
    h.set({ camera: { enabled: false } });
    h.set({ camera: { enabled: true } });
    await h.flush();
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.said).toHaveLength(2); // turned on again: hello
  });

  it("greeting 'claude': a hidden prompt with a transcript note, never with a picture", async () => {
    const h = await onWithFace({ settings: { camera: { greeting: 'claude', shareWithClaude: true } } });
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.sendText).toHaveBeenCalledTimes(1);
    const [first, o1] = h.controller.sent[0];
    expect(first).toBe(greetingPrompt(1, true));
    expect(o1.note).toMatch(/camera sees you/);
    h.frame(null, 12 * MIN);
    h.frame(null, 250);
    h.frame(null, 250);
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.sendText).toHaveBeenCalledTimes(2);
    const [text, opts] = h.controller.sent[1];
    expect(text).toBe(greetingPrompt(12));
    expect(opts).toMatchObject({ source: 'camera', hidden: true });
    expect(opts.note).toMatch(/back after 12 min/);
    expect(h.controller.provider.wants(opts)).toBe(false); // even with "Let Claude see me" on
    expect(h.controller.said).toEqual([]);
  });

  it('quickGreeting: time of day for the first sight, back / long time no see otherwise', () => {
    const at = (hour, pick = 0) => quickGreeting({ first: true, awayMs: 0, hour, pick: () => pick });
    expect(at(6)).toBe(QUICK_GREETINGS.morning[0]);
    expect(at(13)).toBe(QUICK_GREETINGS.afternoon[0]);
    expect(at(19)).toBe(QUICK_GREETINGS.evening[0]);
    expect(at(2)).toBe(QUICK_GREETINGS.night[0]);
    expect(at(23.5)).toBe(QUICK_GREETINGS.night[0]);
    expect(at(9, 0.999)).toBe(QUICK_GREETINGS.morning.at(-1));
    expect(quickGreeting({ first: false, awayMs: 5 * MIN, hour: 9, pick: () => 0.5 })).toBe(QUICK_GREETINGS.back[2]);
    expect(quickGreeting({ first: false, awayMs: 45 * MIN, hour: 9, pick: () => NaN })).toBe(QUICK_GREETINGS.backLong[0]);
  });

  it('no greeting while the user is typing; the Claude greeting also not with a setup problem', async () => {
    let typing = true;
    const h = await onWithFace({ settings: { camera: { greeting: 'claude' } }, userBusy: () => typing });
    h.frame(null, 11 * MIN);
    h.frame(null, 250);
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.sendText).not.toHaveBeenCalled();
    expect(h.controller.said).toEqual([]);
    typing = false;
    h.controller.claudeProblem = { kind: 'auth' };
    h.frame(null, 2000);
    h.frame(null, 31 * MIN);
    h.frame(null, 250);
    for (let i = 0; i < 4; i++) h.frame(face());
    expect(h.controller.sendText).not.toHaveBeenCalled();
  });

  it('look-to-talk (hands-free only): listening waits until the user looks at the screen', async () => {
    const h = await onWithFace({ settings: { camera: { lookToTalk: true }, voice: { handsFree: true } } });
    expect(h.controller.gate).toBe(true); // nothing seen yet: not gated
    for (let i = 0; i < 6; i++) h.frame(face({ yawDeg: 45 }));
    expect(h.controller.gate).toBe(false);
    for (let i = 0; i < 6; i++) h.frame(face());
    expect(h.controller.gate).toBe(true);
    for (let i = 0; i < 12; i++) h.frame(face({ yawDeg: 45 }));
    expect(h.controller.gate).toBe(false);
    h.set({ voice: { handsFree: false } });
    expect(h.controller.gate).toBe(true);
    h.set({ voice: { handsFree: true }, camera: { lookToTalk: false } });
    expect(h.controller.gate).toBe(true);
    h.set({ camera: { lookToTalk: true } });
    h.frame(face({ yawDeg: 45 }));
    expect(h.controller.gate).toBe(false);
    h.set({ camera: { enabled: false } }); // the camera off never blocks listening
    expect(h.controller.gate).toBe(true);
  });
});

describe('CameraFeature: pictures for Claude', () => {
  it('nothing without the camera; "Let Claude see me" adds one to every message you send, not to hidden ones', async () => {
    const h = setup({ consent: true, settings: { camera: { shareWithClaude: true } } });
    const p = h.controller.provider;
    expect(p.wants({ source: 'text', hidden: false })).toBe(false); // camera off
    h.set({ camera: { enabled: true } });
    await h.flush();
    expect(p.wants({ source: 'text', hidden: false })).toBe(true);
    expect(p.wants({ source: 'voice', hidden: false })).toBe(true);
    // the greeting is the app's own prompt: no bubble, no thumbnail, so no picture either
    expect(p.wants({ source: 'camera', hidden: true })).toBe(false);
    const shots = await p.capture({ source: 'text', hidden: false });
    expect(shots).toEqual([expect.objectContaining({ mediaType: 'image/jpeg', data: '/9j/AAAA', thumb: expect.stringMatching(/^data:image\/jpeg/) })]);
    expect(h.capture).toHaveBeenCalledWith(h.camera.video);
  });

  it('📷 arms one picture for the next (typed or spoken) message only', async () => {
    const h = setup({ consent: true });
    const p = h.controller.provider;
    expect(h.feat.toggleShot()).toBe(false); // camera off: explains instead
    expect(h.view.toasts.at(-1)).toMatch(/camera on first/);
    h.set({ camera: { enabled: true } });
    await h.flush();
    expect(p.wants({ source: 'text', hidden: false })).toBe(false);
    expect(h.feat.toggleShot()).toBe(true);
    expect(h.view.states.at(-1).shotArmed).toBe(true);
    expect(p.wants({ source: 'camera', hidden: true })).toBe(false); // not for the greeting
    expect(p.wants({ source: 'voice', hidden: false })).toBe(true);
    await p.capture({ source: 'voice', hidden: false });
    expect(h.feat.shotArmed).toBe(false);
    expect(p.wants({ source: 'text', hidden: false })).toBe(false);
    expect(h.feat.toggleShot()).toBe(true);
    expect(h.feat.toggleShot()).toBe(false); // pressed again: cancelled
    h.feat.toggleShot();
    h.set({ camera: { enabled: false } });
    expect(h.feat.shotArmed).toBe(false);
  });

  it('dispose unhooks the snapshot provider', () => {
    const h = setup();
    h.feat.dispose();
    expect(h.controller.provider).toBeNull();
  });
});
