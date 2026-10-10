// The avatar's side of the Home camera (src/tapo/avatar-link.js) with a fake controller and a
// fake bridge: alerts wake it and are said (or toasted and said later), the describe request goes
// only when nothing else was going on, looks turn the gaze, and local commands run here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { DESCRIBE_NOTE, RETRY_SAY_MS, TapoAvatarLink, describePrompt } from '../../../src/tapo/avatar-link.js';

function fakeController() {
  const c = new Emitter();
  c.idle = true;
  c.said = [];
  c.sent = [];
  c.woke = 0;
  c.lastActivityAt = 0;
  c.isIdle = () => c.idle;
  c.say = (t) => {
    if (!c.idle) return false;
    c.said.push(t);
    return true;
  };
  c.wake = () => { c.woke++; };
  c.sendText = (t, o) => { c.sent.push([t, o]); return true; };
  c.setIdle = (v) => {
    c.idle = v;
    c.emit('state', v ? 'idle' : 'speaking');
  };
  return c;
}

function fakeBridge() {
  const em = new Emitter();
  const calls = [];
  return {
    calls,
    emit: (k, p) => em.emit(k, p),
    tapo: {
      status: async () => ({ enabled: true, connection: 'online', name: 'front door camera', security: { armed: false } }),
      presets: async () => [{ token: '1', name: 'Door' }, { token: '2', name: 'Window' }],
      ptz: async (cmd) => { calls.push(['ptz', cmd]); return { ok: true, moved: true }; },
      arm: async (armed) => { calls.push(['arm', armed]); return armed ? { armed: false, arming: true, armingEndsAt: Date.now() + 30_000 } : { armed: false, arming: false }; },
      openWindow: async () => { calls.push(['openWindow']); return { ok: true }; },
      onAlert: (cb) => em.on('alert', cb),
      onLook: (cb) => em.on('look', cb),
      onStatus: (cb) => em.on('status', cb),
    },
  };
}

function setup(settings = {}) {
  const controller = fakeController();
  const bridge = fakeBridge();
  const toasts = [];
  const looks = [];
  const statuses = [];
  const link = new TapoAvatarLink({
    bridge,
    controller,
    gaze: { cursor: (g, hold) => looks.push([g, hold]) },
    getSettings: () => deepMerge(DEFAULT_SETTINGS, deepMerge({ tapo: { enabled: true, name: 'front door camera' } }, settings)),
    getStage: () => ({ left: 0, top: 0, width: 400, height: 600 }),
    view: { toast: (m, l) => toasts.push([m, l]), setStatus: (s) => statuses.push(s) },
  });
  link.start();
  return { link, controller, bridge, toasts, looks, statuses };
}

const SNAP = { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' };
const alert = (o = {}) => ({ id: 'a1', kind: 'person', at: Date.now(), cameraName: 'front door camera', line: 'Someone is at the front door camera.', quiet: false, describe: false, ...o });

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('alerts', () => {
  it('wake up and say the line', async () => {
    const { bridge, controller } = setup();
    bridge.emit('alert', alert());
    expect(controller.woke).toBe(1);
    expect(controller.said).toEqual(['Someone is at the front door camera.']);
  });

  it('busy: a toast now, the line once free (within 60 s, once)', () => {
    const { bridge, controller, toasts } = setup();
    controller.idle = false;
    bridge.emit('alert', alert());
    expect(controller.said).toEqual([]);
    expect(toasts).toEqual([['Someone is at the front door camera.', 'warn']]);
    vi.advanceTimersByTime(5000);
    controller.setIdle(true);
    vi.advanceTimersByTime(10);
    expect(controller.said).toEqual(['Someone is at the front door camera.']);
    controller.setIdle(false);
    controller.setIdle(true);
    vi.advanceTimersByTime(1000);
    expect(controller.said).toHaveLength(1);
  });

  it('busy for more than 60 s: the line is dropped', () => {
    const { bridge, controller } = setup();
    controller.idle = false;
    bridge.emit('alert', alert());
    vi.advanceTimersByTime(RETRY_SAY_MS + 100);
    controller.setIdle(true);
    vi.advanceTimersByTime(1000);
    expect(controller.said).toEqual([]);
  });

  it('quiet hours: no spoken line (the window still wakes)', () => {
    const { bridge, controller, toasts } = setup();
    bridge.emit('alert', alert({ quiet: true }));
    expect(controller.said).toEqual([]);
    expect(toasts).toEqual([]);
    expect(controller.woke).toBe(1);
  });

  it('describe: after the line, a hidden turn with the snapshot', () => {
    const { bridge, controller } = setup();
    bridge.emit('alert', alert({ describe: true, snapshot: SNAP }));
    // the line is being said (busy), then the avatar is free again
    controller.setIdle(false);
    vi.advanceTimersByTime(2000);
    expect(controller.sent).toEqual([]);
    controller.setIdle(true);
    vi.advanceTimersByTime(10);
    expect(controller.sent).toHaveLength(1);
    const [text, o] = controller.sent[0];
    expect(text).toBe(describePrompt('front door camera', alert().at));
    expect(text).toMatch(/^\(Automatic note from the Lawnmower Man app, not typed by the user: the home security camera "front door camera" detected a person at \d\d:\d\d\. .*Do not guess who it is\.\)$/);
    expect(o).toEqual({ hidden: true, source: 'camera', note: DESCRIBE_NOTE, images: [SNAP] });
  });

  it('never describes while the user is in a conversation', () => {
    const { bridge, controller } = setup();
    controller.idle = false;
    bridge.emit('alert', alert({ describe: true, snapshot: SNAP }));
    controller.setIdle(true);
    vi.advanceTimersByTime(40_000);
    expect(controller.sent).toEqual([]);
    // the user started typing between the line and the description
    const s2 = setup();
    s2.bridge.emit('alert', alert({ describe: true, snapshot: SNAP }));
    s2.controller.lastActivityAt = 123;
    vi.advanceTimersByTime(1000);
    expect(s2.controller.sent).toEqual([]);
  });

  it('no snapshot → no describe', () => {
    const { bridge, controller } = setup();
    bridge.emit('alert', alert({ describe: true }));
    vi.advanceTimersByTime(1000);
    expect(controller.sent).toEqual([]);
  });
});

describe('look', () => {
  it('turns the eyes toward the camera window (outside the stage: toward its edge)', () => {
    const { bridge, looks } = setup();
    bridge.emit('look', { x: -400, y: 300, holdMs: 4000 });
    expect(looks).toHaveLength(1);
    const [[g, hold]] = looks;
    expect(g[0]).toBe(-1);
    expect(Math.abs(g[1])).toBeLessThan(0.01);
    expect(hold).toBe(4000);
    bridge.emit('look', { x: 'nope', y: 1 });
    expect(looks).toHaveLength(1);
  });
});

describe('status and local commands', () => {
  it('status → the view (pill, drawer); presets loaded when online', async () => {
    const { link, statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ connection: 'online' });
    await vi.advanceTimersByTimeAsync(0);
    expect(link.presets.map((p) => p.name)).toEqual(['Door', 'Window']);
  });

  it('runs camera commands and confirms them out loud', async () => {
    const { link, controller, bridge } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.intercept('camera left', { source: 'voice' })).toBe(true);
    expect(link.intercept('look at the door')).toBe(true);
    expect(link.intercept('arm the camera')).toBe(true);
    expect(link.intercept('show me the camera')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.calls).toEqual([
      ['ptz', { op: 'nudge', dir: 'left', amount: 'medium' }],
      ['ptz', { op: 'preset-name', name: 'Door' }],
      ['arm', true],
      ['openWindow'],
    ]);
    expect(controller.said).toEqual(['Turning left.', 'Looking at the door.', 'Armed. You have thirty seconds.', 'Here is the camera.']);
  });

  it('leaves everything else to Claude, and does nothing when off, offline or switched off', async () => {
    const { link } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.intercept('what is the weather like')).toBe(false);
    const off = setup({ security: { voiceCommands: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(off.link.intercept('camera left')).toBe(false);
    const disabled = setup({ tapo: { enabled: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(disabled.link.intercept('camera left')).toBe(false);
    const offline = setup();
    offline.link.onStatus({ enabled: true, connection: 'unreachable' });
    expect(offline.link.intercept('camera left')).toBe(false);
  });

  it('a refused move is explained (toast when the avatar cannot talk)', async () => {
    const { link, controller, bridge, toasts } = setup();
    await vi.advanceTimersByTimeAsync(0);
    bridge.tapo.ptz = async () => ({ ok: false, code: 'privacy' });
    controller.idle = false;
    link.intercept('camera right');
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.at(-1)?.[0]).toMatch(/privacy mode/);
  });
});
