// The real Claude CLI ends an interrupted turn with a `result` of subtype error_during_execution
// and is_error: true (tests/fixtures/fake-claude.mjs does the same), so main forwards
// turn_end { isError: true, interrupted: true }. A reply the user stopped is not a failure: the
// transcript must show it as "stopped", without the error styling and without an error toast.
import { describe, expect, it } from 'vitest';
import { Controller } from '../../../src/app/controller.js';
import { DEFAULT_SETTINGS } from '../../../src/app/settings-defaults.js';
import { fakeAvatar, fakeBridge, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView, tick } from './helpers.js';

function setup() {
  const bridge = fakeBridge();
  const view = fakeView();
  const c = new Controller({
    bridge, view, player: fakePlayer({ clipMs: 15 }), tts: fakeTts({ available: false, delayMs: 1 }), stt: fakeStt({ available: true }),
    mic: fakeMic(), avatar: fakeAvatar(), settings: structuredClone(DEFAULT_SETTINGS), sleepAfterMs: 0,
  });
  return { c, bridge, view };
}

describe('Controller: an interrupted turn is "stopped", not an error', () => {
  it('Stop on a streaming reply: assistantEnd has interrupted and no isError; no error toast', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    c.sendText('tell me a long story');
    await tick();
    bridge.emit({ type: 'turn_start', turnId: 't1', text: 'tell me a long story' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'Once upon a time, ' });
    expect(c.interrupt()).toBe(true);
    bridge.emit({ type: 'turn_end', turnId: 't1', result: '', isError: true, interrupted: true });
    const [turnId, info] = view.of('assistantEnd').at(-1);
    expect(turnId).toBe('t1');
    expect(info).toMatchObject({ isError: false, interrupted: true, empty: false });
    expect(view.of('toast').filter(([, level]) => level === 'error')).toEqual([]);
    expect(c.state).toBe('idle');
  });

  it('a real failure (not interrupted) still reports isError', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    c.sendText('hi');
    await tick();
    bridge.emit({ type: 'turn_start', turnId: 't2', text: 'hi' });
    bridge.emit({ type: 'turn_end', turnId: 't2', result: 'API Error: overloaded', isError: true });
    expect(view.of('assistantEnd').at(-1)[1]).toMatchObject({ isError: true, interrupted: false });
    expect(view.of('toast').some(([, level]) => level === 'error')).toBe(true);
  });
});
