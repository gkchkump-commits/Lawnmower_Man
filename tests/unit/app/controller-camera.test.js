// Controller additions for the camera (src/vision): pictures with messages through the snapshot
// provider, hidden prompts (the camera greeting), the look-to-talk listen gate, sleep().
import { describe, expect, it, vi } from 'vitest';
import { Controller } from '../../../src/app/controller.js';
import { Emitter } from '../../../src/app/emitter.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { CONSENT_KEY, CameraFeature, greetingPrompt } from '../../../src/vision/index.js';
import { fakeAvatar, fakeBridge, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView, tick, waitFor } from './helpers.js';

function setup(o = {}) {
  const bridge = fakeBridge();
  const view = fakeView();
  const player = fakePlayer({ clipMs: 15 });
  const tts = fakeTts({ available: o.tts ?? false });
  const stt = fakeStt({ available: true });
  const mic = fakeMic();
  const avatar = fakeAvatar();
  const settings = deepMerge(DEFAULT_SETTINGS, o.settings || {});
  const c = new Controller({ bridge, view, player, tts, stt, mic, avatar, settings, sleepAfterMs: 0 });
  return { c, bridge, view, mic, avatar };
}

const SHOT = { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==', width: 640, height: 480, thumb: 'data:image/jpeg;base64,/9j/thumb' };

function provider({ want = true, fail = false } = {}) {
  const p = {
    asked: [],
    wants: (o) => {
      p.asked.push(o);
      return typeof want === 'function' ? want(o) : want;
    },
    capture: async () => {
      await tick(1);
      if (fail) throw new Error('the camera is off');
      return [SHOT];
    },
  };
  return p;
}

const sends = (bridge) => bridge.calls.filter((x) => x[0] === 'send');

describe('Controller + camera snapshots', () => {
  it('without a provider (camera off) a message is sent exactly as before', async () => {
    const { c, bridge } = setup();
    await c.start();
    c.sendText('hello');
    await tick();
    expect(sends(bridge)).toEqual([['send', 'hello']]);
  });

  it('a picture goes with the message: images after the text, thumbnail in the transcript', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    const p = provider();
    c.setSnapshotProvider(p);
    c.sendText('can you see me?');
    expect(p.asked).toEqual([{ source: 'text', hidden: false }]);
    await waitFor(() => sends(bridge).length);
    expect(sends(bridge)[0]).toEqual(['send', 'can you see me?', { images: [{ mediaType: 'image/jpeg', data: SHOT.data }] }]);
    expect(view.of('attachUserImages')).toEqual([[1, ['data:image/jpeg;base64,/9j/thumb']]]);
    // the turn proceeds normally
    bridge.emit({ type: 'turn_start', turnId: 't1', text: 'can you see me?' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'Yes!' });
    bridge.emit({ type: 'turn_end', turnId: 't1', result: 'Yes!', isError: false });
    expect(c.state).toBe('idle');
  });

  it('spoken messages ask too (source voice); the provider may decline', async () => {
    const { c, bridge } = setup();
    await c.start();
    c.setSnapshotProvider(provider({ want: (o) => o.source === 'voice' }));
    c.sendText('typed');
    await waitFor(() => sends(bridge).length === 1);
    c.sendText('spoken', { source: 'voice' });
    await waitFor(() => sends(bridge).length === 2);
    expect(sends(bridge)[0]).toEqual(['send', 'typed']);
    expect(sends(bridge)[1][1]).toBe('spoken');
    expect(sends(bridge)[1][2].images).toHaveLength(1);
  });

  it('a failed snapshot does not lose the message: sent without it, with a warning', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    c.setSnapshotProvider(provider({ fail: true }));
    c.sendText('hello');
    await waitFor(() => sends(bridge).length);
    expect(sends(bridge)).toEqual([['send', 'hello']]);
    expect(view.of('toast').some(([m, l]) => /camera picture could not be taken/.test(m) && l === 'warn')).toBe(true);
    expect(view.of('attachUserImages')).toEqual([]);
  });

  it('a provider that throws in wants() is ignored', async () => {
    const { c, bridge } = setup();
    await c.start();
    c.setSnapshotProvider({ wants: () => { throw new Error('boom'); }, capture: async () => [SHOT] });
    const warn = console.warn;
    console.warn = () => {};
    try {
      c.sendText('hello');
      await tick();
    } finally {
      console.warn = warn;
    }
    expect(sends(bridge)).toEqual([['send', 'hello']]);
  });

  it('send failures still mark the message as failed', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    c.setSnapshotProvider(provider());
    bridge.sendImpl = () => Promise.reject(new Error('The image is not really image/jpeg'));
    c.sendText('hello');
    await waitFor(() => view.of('markUserMessage').length);
    expect(view.of('markUserMessage')[0]).toEqual([1, 'failed', 'The image is not really image/jpeg']);
    expect(c.pendingSends).toBe(0);
  });

  it('a message pre-empted while its picture is taken is dropped like any other', async () => {
    const { c, bridge } = setup();
    await c.start();
    c.setSnapshotProvider(provider());
    c.sendText('first');
    c.interrupt(); // Esc right away, before the picture is ready
    await waitFor(() => bridge.calls.some((x) => x[0] === 'cancel'));
    expect(sends(bridge)[0][1]).toBe('first');
    expect(bridge.calls.find((x) => x[0] === 'cancel')).toEqual(['cancel', 't1']);
  });
});

describe('Controller: hidden prompts (camera greeting)', () => {
  it('no user bubble; a note in the transcript instead; the reply shows as usual', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    expect(c.sendText('(automatic note) greet them', { source: 'camera', hidden: true, note: 'Camera greeting' })).toBe(true);
    expect(view.of('addUserMessage')).toEqual([]);
    expect(view.of('addNote')).toEqual([['Camera greeting']]);
    await tick();
    expect(sends(bridge)).toEqual([['send', '(automatic note) greet them']]);
    bridge.emit({ type: 'turn_start', turnId: 't1', text: 'x' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'Welcome back!' });
    bridge.emit({ type: 'turn_end', turnId: 't1', result: 'Welcome back!', isError: false });
    expect(view.of('assistantDelta').at(-1)).toEqual(['t1', 'Welcome back!', 'Welcome back!']);
  });

  it('a hidden prompt that fails to send does not try to mark a bubble', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    bridge.sendImpl = () => Promise.reject(new Error('nope'));
    c.sendText('greet', { hidden: true });
    await waitFor(() => view.of('toast').length);
    expect(view.of('markUserMessage')).toEqual([]);
  });

  it('hidden prompts are asked about pictures as hidden', async () => {
    const { c } = setup();
    await c.start();
    const p = provider({ want: false });
    c.setSnapshotProvider(p);
    c.sendText('greet', { source: 'camera', hidden: true });
    expect(p.asked).toEqual([{ source: 'camera', hidden: true }]);
  });

  it('with the real camera feature and "Let Claude see me" on, the greeting carries no picture', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    const settings = deepMerge(DEFAULT_SETTINGS, { camera: { enabled: true, shareWithClaude: true, greet: true } });
    const camera = Object.assign(new Emitter(), {
      label: 'Fake Cam', video: null,
      start: async () => { camera.video = { readyState: 4, videoWidth: 640, videoHeight: 480 }; },
      stop: () => { camera.video = null; },
    });
    const tracker = Object.assign(new Emitter(), { start: async () => {}, setVideo() {}, setRate() {}, dispose() {} });
    const capture = vi.fn(async () => SHOT);
    const feat = new CameraFeature({
      getSettings: () => settings, saveSettings: async () => {}, controller: c, getAvatar: () => null,
      gaze: { setFace() {} }, camera, createTracker: () => tracker, capture,
      storage: { get: (k) => (k === CONSENT_KEY ? 'yes' : null), set() {} }, listCameras: async () => [],
    });
    feat.applySettings(settings);
    await waitFor(() => feat.active);
    // what CameraFeature._greet sends
    c.sendText(greetingPrompt(12), { source: 'camera', hidden: true, note: "You're back after 12 min, so the camera asked Claude to say hello." });
    await waitFor(() => sends(bridge).length === 1);
    expect(sends(bridge)[0]).toEqual(['send', greetingPrompt(12)]); // no images argument
    expect(capture).not.toHaveBeenCalled();
    bridge.emit({ type: 'turn_start', turnId: 't1', text: 'x' });
    bridge.emit({ type: 'turn_end', turnId: 't1', result: 'Hi again!', isError: false });
    // a message the user sends still gets one, with its thumbnail in the transcript
    c.sendText('how do I look?');
    await waitFor(() => sends(bridge).length === 2);
    expect(sends(bridge)[1][2].images).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(view.of('attachUserImages')).toHaveLength(1);
    feat.dispose();
  });
});

describe('Controller: look-to-talk gate and sleep()', () => {
  it('a closed gate keeps hands-free from listening (mic not even opened); opening resumes it', async () => {
    const { c, mic } = setup({ settings: { voice: { handsFree: true } } });
    c.setListenGate(false);
    await c.start();
    expect(c.handsFree).toBe(true);
    expect(mic.log.filter((x) => x[0] === 'start')).toEqual([]);
    c.setListenGate(true);
    await tick();
    expect(mic.log.filter((x) => x[0] === 'start')).toEqual([['start', 'handsfree']]);
    c.setListenGate(false);
    expect(mic.paused).toBe(true);
    c.setListenGate(true);
    expect(mic.paused).toBe(false);
    expect(c.listenGate).toBe(true);
  });

  it('never cuts off speech in progress: the gate only acts when idle', async () => {
    const { c, mic } = setup({ settings: { voice: { handsFree: true } } });
    await c.start();
    await tick();
    mic.emit('speechstart');
    expect(c.state).toBe('listening');
    c.setListenGate(false);
    expect(mic.paused).toBe(false); // still hearing the user out
    mic.emit('utterance', { wav: new ArrayBuffer(8), durationMs: 900, speechMs: 700 });
    expect(mic.paused).toBe(true); // half-duplex as always
  });

  it('sleep() dozes off only when nothing is going on; activity wakes it', async () => {
    const busy = setup();
    await busy.c.start();
    busy.c.sendText('hello');
    expect(busy.c.isIdle()).toBe(false);
    expect(busy.c.sleep()).toBe(false);
    expect(busy.c.sleeping).toBe(false);

    const { c, view, avatar } = setup();
    await c.start();
    expect(c.isIdle()).toBe(true);
    expect(c.sleep()).toBe(true);
    expect(c.sleeping).toBe(true);
    expect(view.of('setSleep')).toEqual([[true]]);
    expect(avatar.states.at(-1)).toBe('sleep');
    expect(c.sleep()).toBe(true);
    c.noteActivity();
    expect(c.sleeping).toBe(false);
    expect(avatar.states.at(-1)).toBe('idle');
  });
});
