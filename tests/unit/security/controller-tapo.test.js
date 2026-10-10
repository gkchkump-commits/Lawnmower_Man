// The controller's Home camera additions (contract §9.6): images given to sendText go as they
// are, a command interceptor handles local commands (the user's bubble, no Claude turn), and
// wake() wakes the avatar without counting as user activity.
import { describe, expect, it } from 'vitest';
import { Controller } from '../../../src/app/controller.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { fakeBridge, fakePlayer, fakeView, waitFor } from '../app/helpers.js';

function make(o = {}) {
  const bridge = fakeBridge();
  const view = fakeView();
  let t = 0;
  const tts = { available: () => false, mode: () => 'none', synthesize: async () => ({}) };
  const stt = { available: () => false, unavailableReason: () => 'no', transcribe: async () => ({ text: '' }) };
  const states = [];
  const avatar = { setState: (s) => states.push(s), setMouth() {}, setSpeechLevel() {}, blink() {} };
  const c = new Controller({ bridge, view, avatar, player: fakePlayer(), tts, stt, settings: deepMerge(DEFAULT_SETTINGS, o.settings || {}), now: () => t, sleepAfterMs: 1000 });
  return { c, bridge, view, states, advance: (ms) => { t += ms; } };
}

const SNAP = { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' };

describe('sendText images', () => {
  it('sends the given images directly and does not ask the snapshot provider', async () => {
    const { c, bridge } = make();
    let asked = 0;
    c.setSnapshotProvider({ wants: () => { asked++; return true; }, capture: async () => [{ mediaType: 'image/jpeg', data: 'WEBCAM' }] });
    c.sendText('describe this', { hidden: true, source: 'camera', note: 'Home camera: asked Claude what it sees', images: [SNAP] });
    await waitFor(() => bridge.calls.length);
    expect(bridge.calls[0]).toEqual(['send', 'describe this', { images: [SNAP] }]);
    expect(asked).toBe(0);
  });

  it('without images the provider is asked as before', async () => {
    const { c, bridge } = make();
    c.setSnapshotProvider({ wants: () => true, capture: async () => [{ mediaType: 'image/jpeg', data: 'WEBCAM' }] });
    c.sendText('hello');
    await waitFor(() => bridge.calls.length);
    expect(bridge.calls[0]).toEqual(['send', 'hello', { images: [{ mediaType: 'image/jpeg', data: 'WEBCAM' }] }]);
  });

  it('a hidden turn shows its note, not a user bubble', async () => {
    const { c, view } = make();
    c.sendText('x', { hidden: true, note: 'Home camera: asked Claude what it sees', images: [SNAP] });
    expect(view.of('addNote')).toEqual([['Home camera: asked Claude what it sees']]);
    expect(view.of('addUserMessage')).toEqual([]);
  });
});

describe('command interceptor', () => {
  it('handled: the user bubble, no Claude turn', async () => {
    const { c, bridge, view } = make();
    const seen = [];
    c.setCommandInterceptor((text, o) => {
      seen.push([text, o]);
      return text === 'camera left';
    });
    expect(c.sendText('camera left', { source: 'voice' })).toBe(true);
    expect(seen).toEqual([['camera left', { source: 'voice' }]]);
    expect(view.of('addUserMessage')).toEqual([['camera left', { source: 'voice' }]]);
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.calls).toEqual([]);
    expect(c.state).toBe('idle');
    expect(c.isIdle()).toBe(true);
  });

  it('not handled (or a throwing / non-boolean answer): the message goes to Claude', async () => {
    const { c, bridge } = make();
    c.setCommandInterceptor(() => false);
    c.sendText('hello');
    c.setCommandInterceptor(() => { throw new Error('boom'); });
    c.sendText('hello again');
    c.setCommandInterceptor(() => /** @type {any} */ (Promise.resolve(true)));
    c.sendText('and again');
    const sends = () => bridge.calls.filter((x) => x[0] === 'send');
    await waitFor(() => sends().length === 3);
    expect(sends().map((x) => x[1])).toEqual(['hello', 'hello again', 'and again']);
  });

  it('is never asked for hidden prompts', async () => {
    const { c, bridge } = make();
    let asked = 0;
    c.setCommandInterceptor(() => { asked++; return true; });
    c.sendText('camera left', { hidden: true });
    await waitFor(() => bridge.calls.length);
    expect(asked).toBe(0);
  });

  it('a command interrupts a running reply like any new input', async () => {
    const { c, bridge } = make();
    await c.start();
    c.sendText('tell me a story');
    await waitFor(() => bridge.calls.length);
    bridge.emit({ type: 'turn_start', turnId: 't1', text: 'tell me a story' });
    c.setCommandInterceptor(() => true);
    c.sendText('arm the camera');
    await waitFor(() => bridge.calls.some((x) => x[0] === 'interrupt'));
  });
});

describe('wake', () => {
  it('wakes a sleeping avatar without counting as user activity; the doze timer starts over', () => {
    const { c, states, advance } = make();
    c.tick(0.016);
    advance(1500);
    c.tick(0.016);
    expect(c.sleeping).toBe(true);
    const before = c.lastActivityAt;
    c.wake();
    expect(c.sleeping).toBe(false);
    expect(states.at(-1)).toBe('idle');
    expect(c.lastActivityAt).toBe(before);
    advance(500);
    c.tick(0.016);
    expect(c.sleeping).toBe(false); // not right back to sleep
    advance(600);
    c.tick(0.016);
    expect(c.sleeping).toBe(true);
  });
});
