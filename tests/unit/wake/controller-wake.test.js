// The controller's "Hey Jade" block and hooks (contract-wake §9.4): wake captures, the adapter
// deciding transcripts, silent drops, the idle hook, the hotkey and barge-in routing,
// push-to-talk winning, hands-free unchanged without an adapter.
import { describe, expect, it } from 'vitest';
import { Controller } from '../../../src/app/controller.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { decideCommand } from '../../../src/wake/phrase.js';
import { fakeAvatar, fakeBridge, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView, tick, waitFor } from '../app/helpers.js';

const HALLUCINATION = /^(?:thank you\.?|thanks for watching!?|thank you for watching!?|you\.?|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?)$/i;

/** an adapter that records everything and decides with the real rules */
function fakeAdapter(o = {}) {
  const a = {
    calls: [],
    isActive: o.active ?? true,
    isFallback: o.fallback ?? false,
    turnRunning: false,
    active: () => a.isActive,
    fallback: () => a.isFallback,
    manual: (x) => a.calls.push(['manual', x]),
    idle: (x) => a.calls.push(['idle', x]),
    state: (s) => a.calls.push(['state', s]),
    noSpeech: (m) => a.calls.push(['noSpeech', m]),
    captured: (m) => a.calls.push(['captured', m]),
    cancelled: (m) => a.calls.push(['cancelled', m]),
    decide: async (text, meta, x) => {
      a.calls.push(['decide', text, meta, x]);
      if (o.decide) return o.decide(text, meta, x);
      return decideCommand(text, { kind: meta.kind === 'fallback' ? 'command' : meta.kind, turnRunning: a.turnRunning, speechMs: x.speechMs, hallucination: HALLUCINATION, failed: x.failed });
    },
    of: (name) => a.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
  };
  return a;
}

function setup(o = {}) {
  const bridge = fakeBridge();
  const view = fakeView();
  const player = fakePlayer({ clipMs: 15 });
  const tts = fakeTts({ available: o.tts ?? false });
  const stt = fakeStt({ available: true, text: o.text ?? 'what time is it?' });
  const mic = fakeMic();
  // the wake capture's options reach the mic
  const start = mic.start;
  mic.start = async (mode, opts) => {
    mic.log.push(['opts', opts || null]);
    return start(mode);
  };
  const avatar = fakeAvatar();
  const settings = deepMerge(DEFAULT_SETTINGS, { wake: { enabled: true }, ...(o.settings || {}) });
  const c = new Controller({ bridge, view, player, tts, stt, mic, avatar, settings, sleepAfterMs: 0 });
  const adapter = fakeAdapter(o.adapter);
  if (o.attach !== false) c.setWakeWord(adapter);
  return { c, bridge, view, mic, stt, adapter, player };
}

const sends = (bridge) => bridge.calls.filter((x) => x[0] === 'send').map((x) => x[1]);
const toasts = (view) => view.of('toast').map((t) => t[0]);

describe('Controller: the wake capture', () => {
  it('wakeWordCapture sets listen.wake, starts the mic from the keyword end, shows listening', async () => {
    const { c, mic, view } = setup();
    await c.start();
    const ok = await c.wakeWordCapture({ kind: 'command', fromSample: 12345, noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    expect(ok).toBe(true);
    expect(c.listen).toEqual({ mode: 'utterance', wake: { kind: 'command', wakeId: 'w1' } });
    expect(mic.log).toContainEqual(['opts', { fromSample: 12345, noSpeechMs: 8000 }]);
    expect(mic.log).toContainEqual(['start', 'utterance']);
    expect(c.state).toBe('listening');
    expect(view.of('setListening').at(-1)).toEqual(['utterance']);
  });

  it('show: false keeps the state (a barge-in check while she speaks); wakeWordShow shows it', async () => {
    const { c } = setup();
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: false, meta: { wakeId: 'w1' } });
    expect(c.state).toBe('idle');
    expect(c.listen.wake.wakeId).toBe('w1');
    c.wakeWordShow();
    expect(c.state).toBe('listening');
  });

  it('the utterance goes to adapter.decide with its meta; the command is sent as voice', async () => {
    const { c, mic, bridge, adapter } = setup({ text: 'Jade, what time is it?' });
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('utterance', mic.result);
    await waitFor(() => sends(bridge).length);
    expect(adapter.of('captured')).toEqual([[{ kind: 'command', wakeId: 'w1' }]]);
    expect(adapter.of('decide')[0]).toEqual(['Jade, what time is it?', { kind: 'command', wakeId: 'w1' }, { speechMs: 700, failed: false }]);
    expect(sends(bridge)).toEqual(['what time is it?']);
    expect(c.listen).toBeNull();
  });

  it('the interceptor gets the stripped command ("camera left")', async () => {
    const { c, mic, bridge } = setup({ text: 'Hey Jade, camera left.' });
    const seen = [];
    c.setCommandInterceptor((text, o) => {
      seen.push([text, o.source]);
      return /camera left/.test(text);
    });
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('utterance', mic.result);
    await waitFor(() => seen.length);
    expect(seen).toEqual([['camera left.', 'voice']]);
    expect(sends(bridge)).toEqual([]);
  });

  it('empty, hallucinated and failed transcripts drop silently: no "didn\'t catch that", no "failed" toast', async () => {
    for (const text of ['', 'Thank you.', new Error('server down')]) {
      const { c, mic, view, stt, bridge } = setup({ text: '' });
      stt.text = text;
      await c.start();
      await c.wakeWordCapture({ kind: 'followup', noSpeechMs: 6000, show: true, meta: { wakeId: 'u1' } });
      mic.result = { wav: new ArrayBuffer(8), durationMs: 600, speechMs: 400 };
      mic.emit('utterance', mic.result);
      await tick(20);
      expect(toasts(view), String(text)).toEqual([]);
      expect(sends(bridge)).toEqual([]);
      expect(c.state).toBe('idle');
    }
  });

  it('"again": the adapter listens again for the rest of the window, the controller does nothing else', async () => {
    const { c, mic, adapter } = setup({
      text: 'Jade.',
      adapter: { decide: () => { c.wakeWordCapture({ kind: 'command', noSpeechMs: 6000, show: true, meta: { wakeId: 'w1' } }); return { action: 'again', reason: 'empty' }; } },
    });
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('utterance', mic.result);
    await waitFor(() => adapter.of('decide').length);
    await tick(5);
    expect(c.listen?.wake?.wakeId).toBe('w1');
    expect(c.state).toBe('listening');
  });

  it('"stop" while the reply streams → interrupt(); no message for Claude (BRG-4)', async () => {
    const { c, mic, bridge, adapter } = setup({ text: 'stop' });
    await c.start();
    c.sendText('tell me a long story');
    await tick(5);
    bridge.emit({ type: 'turn_start', turnId: 't1' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'Once upon a time' });
    adapter.turnRunning = true;
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('utterance', mic.result);
    await waitFor(() => bridge.calls.some((x) => x[0] === 'interrupt'));
    expect(sends(bridge)).toEqual(['tell me a long story']);
  });

  it('no speech in the window: adapter.noSpeech, no toast (END-3)', async () => {
    const { c, mic, view, adapter } = setup();
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('discard', { reason: 'no-speech' });
    expect(adapter.of('noSpeech')).toEqual([[{ kind: 'command', wakeId: 'w1' }]]);
    expect(toasts(view)).toEqual([]);
    expect(c.state).toBe('idle');
    expect(c.listen).toBeNull();
  });

  it('wakeWordCancel: silent; back to what still runs', async () => {
    const { c, bridge, adapter } = setup();
    await c.start();
    c.sendText('hello');
    await tick(5);
    bridge.emit({ type: 'turn_start', turnId: 't1' });
    expect(c.state).toBe('thinking');
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    expect(c.state).toBe('listening');
    c.wakeWordCancel();
    expect(c.listen).toBeNull();
    expect(c.state).toBe('thinking');
    expect(adapter.of('cancelled')).toEqual([]); // its own cancel is not reported back
  });

  it('push-to-talk wins over a wake capture, and the adapter is told (T14)', async () => {
    const { c, mic, adapter } = setup();
    await c.start();
    await c.wakeWordCapture({ kind: 'followup', noSpeechMs: 6000, show: true, meta: { wakeId: 'u1' } });
    await c.startListening('ptt');
    expect(c.listen).toEqual({ mode: 'ptt' });
    expect(adapter.of('cancelled')).toEqual([[{ kind: 'followup', wakeId: 'u1' }]]);
    expect(mic.log.filter((x) => x[0] === 'start').map((x) => x[1])).toEqual(['utterance', 'ptt']);
  });

  it('typing cancels a wake capture (and tells the adapter)', async () => {
    const { c, bridge, adapter } = setup();
    await c.start();
    await c.wakeWordCapture({ kind: 'followup', noSpeechMs: 6000, show: true, meta: { wakeId: 'u1' } });
    c.sendText('typed instead');
    expect(adapter.of('cancelled')).toHaveLength(1);
    await tick(5);
    expect(sends(bridge)).toEqual(['typed instead']);
  });

  it('a manual capture or PTT is never replaced by a wake capture', async () => {
    const { c } = setup();
    await c.start();
    await c.startListening('ptt');
    expect(await c.wakeWordCapture({ kind: 'followup', noSpeechMs: 6000, meta: { wakeId: 'u1' } })).toBe(false);
    expect(c.listen).toEqual({ mode: 'ptt' });
  });
});

describe('Controller: the idle hook (the follow-up window)', () => {
  it('after a voice turn, 350 ms after idle: adapter.idle({ voiceTurn: true, turnId })', async () => {
    const { c, bridge, adapter, mic } = setup({ text: 'what time is it?' });
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'w1' } });
    mic.emit('utterance', mic.result);
    await waitFor(() => sends(bridge).length);
    await tick(5);
    bridge.emit({ type: 'turn_start', turnId: 't1' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'It is noon.' });
    bridge.emit({ type: 'turn_end', turnId: 't1', result: 'It is noon.' });
    expect(c.state).toBe('idle');
    await tick(200);
    expect(adapter.of('idle')).toEqual([]);
    await waitFor(() => adapter.of('idle').length, { timeout: 1000 });
    expect(adapter.of('idle')[0][0]).toEqual({ turnId: 't1', voiceTurn: true, spoke: false, permissionPending: false });
  });

  it('a typed turn reports voiceTurn: false', async () => {
    const { c, bridge, adapter } = setup();
    await c.start();
    c.sendText('typed');
    await tick(5);
    bridge.emit({ type: 'turn_start', turnId: 't1' });
    bridge.emit({ type: 'turn_end', turnId: 't1', result: 'ok' });
    await waitFor(() => adapter.of('idle').length, { timeout: 1000 });
    expect(adapter.of('idle')[0][0]).toMatchObject({ turnId: 't1', voiceTurn: false });
  });

  it('not when something started meanwhile (the tail is cancelled by the new state)', async () => {
    const { c, adapter } = setup();
    await c.start();
    c._maybeIdle();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'm1' } });
    await tick(450);
    expect(adapter.of('idle')).toEqual([]);
  });

  it('the adapter hears every state change', async () => {
    const { c, adapter } = setup();
    await c.start();
    c.sendText('hi');
    expect(adapter.of('state').map((x) => x[0])).toContain('thinking');
  });
});

describe('Controller: the hotkey, the mic button and barge-in with the wake word', () => {
  it('the hotkey while waiting → adapter.manual, not the hands-free toast (T13)', async () => {
    const { c, adapter, view, mic } = setup();
    await c.start();
    await c.toggleListening();
    expect(adapter.of('manual')).toEqual([[{ from: 'hotkey' }]]);
    expect(toasts(view)).toEqual([]);
    expect(mic.log.filter((x) => x[0] === 'start')).toEqual([]);
  });

  it('the hotkey during a follow-up window → listen now (manual), not "stop"', async () => {
    const { c, adapter } = setup();
    await c.start();
    await c.wakeWordCapture({ kind: 'followup', noSpeechMs: 6000, show: true, meta: { wakeId: 'u1' } });
    await c.toggleListening();
    expect(adapter.of('manual')).toEqual([[{ from: 'hotkey' }]]);
  });

  it('the hotkey while she speaks → barge-in: pre-empt, then adapter.manual({ from: "barge" })', async () => {
    const { c, bridge, adapter } = setup({ tts: true });
    await c.start();
    c.sendText('hello');
    await tick(5);
    bridge.emit({ type: 'turn_start', turnId: 't1' });
    bridge.emit({ type: 'text_delta', turnId: 't1', text: 'A long reply. With sentences.' });
    await waitFor(() => c.state === 'speaking');
    await c.toggleListening();
    expect(bridge.calls.some((x) => x[0] === 'interrupt')).toBe(true);
    expect(adapter.of('manual')).toEqual([[{ from: 'barge' }]]);
  });

  it('the hotkey while listening to a command: stop and transcribe it with its meta', async () => {
    const { c, adapter, bridge } = setup({ text: 'open the calendar' });
    await c.start();
    await c.wakeWordCapture({ kind: 'command', noSpeechMs: 8000, show: true, meta: { wakeId: 'm1' } });
    await c.toggleListening();
    await waitFor(() => sends(bridge).length);
    expect(adapter.of('decide')[0][1]).toEqual({ kind: 'command', wakeId: 'm1' });
    expect(sends(bridge)).toEqual(['open the calendar']);
  });

  it('an inactive adapter (blocked, paused) leaves the hotkey as it was', async () => {
    const { c, adapter, mic } = setup({ adapter: { active: false } });
    await c.start();
    await c.toggleListening();
    expect(adapter.of('manual')).toEqual([]);
    expect(mic.log.filter((x) => x[0] === 'start').map((x) => x[1])).toEqual(['utterance']);
  });
});

describe('Controller: hands-free and the wake word', () => {
  it('with "Hey Jade" on, hands-free does not listen to everything (and the gate does not matter)', async () => {
    const { c, mic } = setup({ settings: { voice: { handsFree: true } } });
    await c.start();
    expect(c.handsFree).toBe(false);
    expect(mic.log.filter((x) => x[0] === 'start')).toEqual([]);
    // speech without her name changes nothing
    mic.emit('speechstart');
    expect(c.state).toBe('idle');
  });

  it('the transcript check (fallback): hands-free runs; each utterance goes to decide silently', async () => {
    const { c, mic, bridge, adapter, view } = setup({ adapter: { fallback: true }, text: 'Hey Jade, what time is it?' });
    await c.start();
    expect(c.handsFree).toBe(true);
    expect(mic.log.filter((x) => x[0] === 'start').map((x) => x[1])).toEqual(['handsfree']);
    const states = [];
    c.on('state', (s) => states.push(s));
    mic.emit('speechstart'); // no listening pose for background speech
    mic.emit('utterance', mic.result);
    await waitFor(() => adapter.of('decide').length);
    expect(adapter.of('decide')[0][1]).toEqual({ kind: 'fallback' });
    expect(states).not.toContain('transcribing');
    expect(states).not.toContain('listening');
    await waitFor(() => sends(bridge).length);
    expect(sends(bridge)).toEqual(['what time is it?']);
    expect(toasts(view)).toEqual([]);
  });

  it('without an adapter hands-free behaves exactly as before', async () => {
    const { c, mic, view } = setup({ attach: false, settings: { voice: { handsFree: true } } });
    await c.start();
    expect(c.handsFree).toBe(true);
    expect(mic.log.filter((x) => x[0] === 'start').map((x) => x[1])).toEqual(['handsfree']);
    mic.emit('speechstart');
    expect(c.state).toBe('listening');
    mic.emit('discard', { reason: 'too-short' });
    expect(c.state).toBe('idle');
    await c.toggleListening();
    expect(toasts(view).at(-1)).toMatch(/Hands-free listening is on/);
  });

  it('wake.enabled off: hands-free as before even with the adapter attached', async () => {
    const { c } = setup({ settings: { wake: { enabled: false }, voice: { handsFree: true } }, adapter: { active: false } });
    await c.start();
    expect(c.handsFree).toBe(true);
  });
});
