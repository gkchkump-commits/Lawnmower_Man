import { describe, expect, it } from 'vitest';
import { Controller } from '../../../src/app/controller.js';
import { DEFAULT_SETTINGS, deepMerge } from '../../../src/app/settings-defaults.js';
import { fakeAvatar, fakeBridge, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView, tick, waitFor } from './helpers.js';

function setup(o = {}) {
  const bridge = fakeBridge();
  const view = fakeView();
  const player = fakePlayer({ clipMs: o.clipMs ?? 15 });
  const tts = fakeTts({ available: o.tts ?? true, delayMs: o.ttsDelay ?? 1 });
  const stt = fakeStt({ available: o.stt ?? true });
  const mic = fakeMic();
  const avatar = fakeAvatar();
  const settings = deepMerge(DEFAULT_SETTINGS, o.settings || {});
  const c = new Controller({ bridge, view, player, tts, stt, mic, avatar, settings, sleepAfterMs: 0 });
  const states = [];
  c.on('state', (s) => states.push(s));
  return { c, bridge, view, player, tts, stt, mic, avatar, states };
}

const ev = {
  start: (turnId, text = 'hi') => ({ type: 'turn_start', turnId, text }),
  delta: (turnId, text) => ({ type: 'text_delta', turnId, text }),
  end: (turnId, extra = {}) => ({ type: 'turn_end', turnId, result: '', isError: false, ...extra }),
  msgEnd: (turnId) => ({ type: 'message_end', turnId }),
};

describe('Controller: text conversation', () => {
  it('runs a full text-only turn: thinking → speaking → idle', async () => {
    const { c, bridge, view, states, avatar } = setup({ tts: false });
    await c.start();
    expect(c.sendText('  Hello Claude  ')).toBe(true);
    expect(view.of('addUserMessage')[0]).toEqual(['Hello Claude', { source: 'text' }]);
    expect(c.state).toBe('thinking');
    await tick();
    expect(bridge.calls).toContainEqual(['send', 'Hello Claude']);
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'Hello '));
    bridge.emit(ev.delta('t1', 'there!'));
    expect(c.state).toBe('speaking');
    expect(view.of('assistantDelta').at(-1)).toEqual(['t1', 'there!', 'Hello there!']);
    bridge.emit(ev.msgEnd('t1'));
    bridge.emit(ev.end('t1', { result: 'Hello there!' }));
    expect(c.state).toBe('idle');
    expect(states).toEqual(['thinking', 'speaking', 'idle']);
    expect(view.of('assistantEnd')[0][1]).toMatchObject({ isError: false, interrupted: false, empty: false });
    expect(avatar.states).toEqual(['idle', 'thinking', 'speaking', 'idle']);
  });

  it('ignores empty messages and unknown events', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    expect(c.sendText('   ')).toBe(false);
    bridge.emit({ type: 'rate_limit_event' });
    bridge.emit(null);
    expect(view.of('addUserMessage')).toHaveLength(0);
    expect(c.state).toBe('idle');
  });

  it('shows the final result when nothing was streamed', async () => {
    const { c, bridge, view } = setup({ tts: false });
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.end('t1', { result: 'Only a result.' }));
    expect(view.of('assistantDelta')[0]).toEqual(['t1', 'Only a result.', 'Only a result.']);
    expect(c.state).toBe('idle');
  });

  it('handles turn_start arriving before send() resolves', async () => {
    const { c, bridge, view } = setup({ tts: false });
    await c.start();
    bridge.sendImpl = async () => {
      bridge.emit(ev.start('t9'));
      return { turnId: 't9' };
    };
    c.sendText('hey');
    await tick();
    expect(c.activeTurnId).toBe('t9');
    expect(c.pendingSends).toBe(0);
    expect(view.of('assistantStart')).toEqual([['t9']]);
  });

  it('reports a failed send', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    bridge.sendImpl = async () => { throw new Error('Claude CLI not found'); };
    c.sendText('hi');
    await waitFor(() => c.state === 'idle');
    expect(view.of('markUserMessage')[0]).toEqual([1, 'failed', 'Claude CLI not found']);
    expect(view.of('toast')[0][0]).toMatch(/Claude CLI not found/);
  });
});

describe('Controller: speech pipeline', () => {
  it('chunks streamed text into sentences and speaks them in order', async () => {
    const { c, bridge, tts, player, states } = setup();
    await c.start();
    c.sendText('talk');
    bridge.emit(ev.start('t1'));
    for (const d of ['Hello there. ', 'How are you ', 'doing today? I am ', 'fine, thanks for asking.']) bridge.emit(ev.delta('t1', d));
    bridge.emit(ev.msgEnd('t1'));
    bridge.emit(ev.end('t1'));
    expect(c.state).not.toBe('idle'); // audio still queued
    await waitFor(() => c.state === 'idle', { message: 'idle after speech' });
    expect(tts.texts).toEqual(['Hello there.', 'How are you doing today?', 'I am fine, thanks for asking.']);
    expect(player.played.map((p) => p.text)).toEqual(tts.texts);
    expect(states).toEqual(['thinking', 'speaking', 'idle']);
  });

  it('never speaks code; says the placeholder once', async () => {
    const { c, bridge, tts } = setup();
    await c.start();
    c.sendText('code please');
    bridge.emit(ev.start('t1'));
    const reply = 'Here you go:\n```js\nconst secret = 42;\n```\nAnd that **works**.';
    for (const ch of reply) bridge.emit(ev.delta('t1', ch));
    bridge.emit(ev.end('t1'));
    await waitFor(() => c.state === 'idle');
    expect(tts.texts).toEqual(['Here you go:', "I've put the code in the chat.", 'And that works.']);
  });

  it('respects speakReplies=false (text only)', async () => {
    const { c, bridge, tts } = setup({ settings: { voice: { speakReplies: false } } });
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'Silent reply. '));
    bridge.emit(ev.end('t1'));
    await tick(5);
    expect(tts.texts).toEqual([]);
    expect(c.state).toBe('idle');
  });

  it('drives the avatar mouth while audio plays', async () => {
    const { c, bridge, avatar, player } = setup({ clipMs: 40 });
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'Some words to say. '));
    bridge.emit(ev.end('t1'));
    await waitFor(() => player.current);
    for (let i = 0; i < 5; i++) c.tick(1 / 60, i / 60);
    expect(avatar.mouths.length).toBeGreaterThan(0);
    expect(avatar.mouths.at(-1).jaw).toBeGreaterThan(0.05); // 'aa' viseme from the fake TTS
    expect(avatar.levels.at(-1)).toBeGreaterThan(0);
  });

  it('a spoken cue when Claude uses a tool without saying anything first', async () => {
    const { c, bridge, tts } = setup();
    await c.start();
    c.sendText('look at file');
    bridge.emit(ev.start('t1'));
    bridge.emit({ type: 'tool_use', turnId: 't1', id: 'u1', name: 'Read', input: { file_path: '/a/b.txt' } });
    expect(c.state).toBe('thinking');
    await waitFor(() => tts.texts.length === 1);
    expect(tts.texts[0]).toBe('Let me take a look.');
  });
});

describe('Controller: permissions', () => {
  it('shows a card, says a prompt, and answers allow with the original input', async () => {
    const { c, bridge, view, tts } = setup();
    await c.start();
    c.sendText('run the tests');
    bridge.emit(ev.start('t1'));
    const input = { command: 'npm test', description: 'Run tests' };
    bridge.emit({ type: 'tool_use', turnId: 't1', id: 'u1', name: 'Bash', input });
    bridge.emit({ type: 'permission_request', turnId: 't1', requestId: 'r1', toolName: 'Bash', input, description: 'Run tests' });
    const card = view.of('showPermission')[0][0];
    expect(card).toMatchObject({ requestId: 'r1', toolName: 'Bash', summary: { target: 'npm test', risk: 'danger' } });
    expect(view.of('setAttention')).toContainEqual([true]);
    await waitFor(() => tts.texts.includes('I need your permission to run a command.'));
    expect(await c.respondPermission('r1', true)).toBe(true);
    expect(bridge.calls).toContainEqual(['respondPermission', 'r1', { behavior: 'allow', updatedInput: input }]);
    expect(view.of('removePermission')).toContainEqual(['r1', 'allowed']);
    expect(view.of('setAttention').at(-1)).toEqual([false]);
    expect(await c.respondPermission('r1', true)).toBe(false); // already answered
  });

  it('deny sends a deny decision; turn_end and restarts dismiss open cards', async () => {
    const { c, bridge, view } = setup({ tts: false });
    await c.start();
    bridge.emit(ev.start('t1'));
    bridge.emit({ type: 'permission_request', turnId: 't1', requestId: 'r1', toolName: 'Write', input: { file_path: '/x/y.md', content: 'hi' } });
    bridge.emit({ type: 'permission_request', turnId: 't1', requestId: 'r2', toolName: 'Edit', input: { file_path: '/x/z.md' } });
    await c.respondPermission('r1', false);
    expect(bridge.calls.find((x) => x[0] === 'respondPermission')[2]).toEqual({ behavior: 'deny', message: 'The user denied this action.' });
    bridge.emit(ev.end('t1'));
    expect(view.of('removePermission')).toContainEqual(['r2', 'expired']);
    bridge.emit(ev.start('t2'));
    bridge.emit({ type: 'permission_request', turnId: 't2', requestId: 'r3', toolName: 'Bash', input: {} });
    bridge.emit({ type: 'status', status: 'restarting' });
    expect(view.of('removePermission')).toContainEqual(['r3', 'expired']);
    expect(c.permissions.size).toBe(0);
  });

  it('a rejected respondPermission (expired) shows a warning', async () => {
    const { c, bridge, view } = setup({ tts: false });
    await c.start();
    bridge.rejectPermission = true;
    bridge.emit({ type: 'permission_request', turnId: null, requestId: 'r1', toolName: 'Bash', input: {} });
    expect(await c.respondPermission('r1', true)).toBe(false);
    expect(view.of('toast').at(-1)[1]).toBe('warn');
  });
});

describe('Controller: barge-in, interrupt, stop', () => {
  it('barge-in stops playback, interrupts the turn and listens; the rest is not spoken', async () => {
    const { c, bridge, tts, player, mic } = setup({ clipMs: 200 });
    await c.start();
    c.sendText('tell me a story');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'Once upon a time there was a hologram. It lived on a desktop. '));
    await waitFor(() => c.state === 'speaking');
    await c.bargeIn();
    expect(player.stops).toBeGreaterThan(0);
    expect(bridge.calls).toContainEqual(['interrupt']);
    expect(c.state).toBe('listening');
    expect(mic.log).toContainEqual(['start', 'utterance']);
    const n = tts.texts.length;
    bridge.emit(ev.delta('t1', 'More story that should stay silent. '));
    bridge.emit(ev.end('t1', { interrupted: true }));
    await tick(10);
    expect(tts.texts.length).toBe(n);
    expect(c.state).toBe('listening');
  });

  it('typing while Claude speaks pre-empts the reply', async () => {
    const { c, bridge, player } = setup({ clipMs: 200 });
    await c.start();
    c.sendText('first');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'A long answer is being spoken right now. And'));
    await waitFor(() => c.state === 'speaking');
    c.sendText('second');
    expect(player.stops).toBeGreaterThan(0);
    await tick();
    expect(bridge.calls.filter((x) => x[0] === 'interrupt')).toHaveLength(1);
    expect(c.state).toBe('thinking');
  });

  it('stopSpeaking silences the voice but the text keeps streaming', async () => {
    const { c, bridge, tts, view } = setup({ clipMs: 200 });
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'First sentence here. Then'));
    await waitFor(() => c.state === 'speaking');
    expect(c.stopSpeaking()).toBe(true);
    expect(c.state).toBe('thinking');
    const n = tts.texts.length;
    bridge.emit(ev.delta('t1', ' a second sentence here. '));
    expect(tts.texts.length).toBe(n);
    expect(view.of('assistantDelta').at(-1)[2]).toContain('a second sentence');
    bridge.emit(ev.end('t1'));
    expect(c.state).toBe('idle');
    expect(bridge.calls.filter((x) => x[0] === 'interrupt')).toHaveLength(0);
  });

  it('interrupt() stops a turn that is still thinking', async () => {
    const { c, bridge } = setup();
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    expect(c.interrupt()).toBe(true);
    await tick();
    expect(bridge.calls).toContainEqual(['interrupt']);
  });
});

describe('Controller: errors and session', () => {
  it('error events toast and flash the avatar; a dropped queued turn marks its message', async () => {
    const { c, bridge, view, avatar } = setup({ tts: false });
    await c.start();
    c.sendText('queued one');
    await tick();
    bridge.emit({ type: 'error', turnId: 't1', message: 'The conversation was reset before this message was sent.' });
    expect(view.of('markUserMessage')[0]).toEqual([1, 'failed', 'The conversation was reset before this message was sent.']);
    expect(avatar.states).toContain('error');
    expect(c.state).toBe('idle');
  });

  it('a failed turn shows its result as an error', async () => {
    const { c, bridge, view } = setup({ tts: false });
    await c.start();
    c.sendText('x');
    bridge.emit(ev.start('t1'));
    bridge.emit({ type: 'error', turnId: 't1', message: 'Claude CLI exited unexpectedly (code 1)' });
    bridge.emit(ev.end('t1', { isError: true, result: 'API Error: overloaded' }));
    expect(view.of('assistantError')[0]).toEqual(['t1', 'Claude CLI exited unexpectedly (code 1)']);
    expect(view.of('toast').map((t) => t[0])).toContain('Claude: API Error: overloaded');
    expect(c.state).toBe('idle');
  });

  it('status error toasts; session reset clears the transcript', async () => {
    const { c, bridge, view } = setup();
    await c.start();
    bridge.emit({ type: 'status', status: 'error', detail: 'Claude CLI not found' });
    expect(view.of('toast').at(-1)).toEqual(['Claude CLI not found', 'error']);
    expect(view.of('setClaudeStatus').at(-1)[0]).toMatchObject({ status: 'error', detail: 'Claude CLI not found' });
    bridge.emit({ type: 'session', sessionId: 'abc', model: 'opus', tools: [] });
    expect(view.of('clearTranscript')).toHaveLength(0);
    bridge.emit({ type: 'session', sessionId: '', model: '', tools: [] });
    expect(view.of('clearTranscript')).toHaveLength(1);
  });
});

describe('Controller: startup', () => {
  it('notes a resumed conversation and reports a CLI error present before load', async () => {
    const { c, bridge, view } = setup({ settings: { claude: { lastSessionId: 'abc-123' } } });
    bridge.claude.status = async () => ({ status: 'error', detail: 'Claude CLI not found', sessionId: 'abc-123', busy: false, queue: 0 });
    await c.start();
    expect(view.of('toast')[0]).toEqual(['Claude CLI not found', 'error']);
    expect(view.of('addNote')).toEqual([['Continuing your previous conversation']]);
    bridge.emit({ type: 'session', sessionId: 'abc-123', model: 'm', tools: [] });
    expect(view.of('addNote')).toHaveLength(1);
  });

  it('a new session id is not "continuing"', async () => {
    const { c, bridge, view } = setup({ settings: { claude: { lastSessionId: 'old' } } });
    await c.start();
    bridge.emit({ type: 'session', sessionId: 'new', model: 'm', tools: [] });
    expect(view.of('addNote')).toHaveLength(0);
  });
});

describe('Controller: voice input', () => {
  it('push-to-talk: listening → transcribing → thinking with the transcript', async () => {
    const { c, bridge, mic, stt, view, states } = setup();
    await c.start();
    await c.startListening('ptt');
    expect(c.state).toBe('listening');
    expect(mic.log[0]).toEqual(['start', 'ptt']);
    const p = c.stopListening();
    await waitFor(() => c.state === 'transcribing' || stt.calls > 0);
    await p;
    expect(stt.calls).toBe(1);
    expect(view.of('addUserMessage')[0]).toEqual(['hello there', { source: 'voice' }]);
    expect(states.slice(0, 3)).toEqual(['listening', 'transcribing', 'thinking']);
    await tick();
    expect(bridge.calls).toContainEqual(['send', 'hello there']);
  });

  it('ignores Whisper hallucinations on short noise', async () => {
    const { c, mic, stt, view } = setup();
    await c.start();
    stt.text = 'Thank you.';
    mic.result = { wav: new ArrayBuffer(8), durationMs: 600, speechMs: 400 };
    await c.startListening('ptt');
    await c.stopListening();
    expect(view.of('addUserMessage')).toHaveLength(0);
    expect(view.of('toast').at(-1)[0]).toMatch(/didn't catch/);
    expect(c.state).toBe('idle');
  });

  it('no speech recorded → back to idle', async () => {
    const { c, mic, view } = setup();
    await c.start();
    mic.result = null;
    await c.startListening('ptt');
    await c.stopListening();
    expect(c.state).toBe('idle');
    expect(view.of('toast').at(-1)[0]).toMatch(/didn't hear/);
  });

  it('voice input unavailable → explains how to enable it', async () => {
    const { c, view } = setup({ stt: false });
    await c.start();
    expect(view.of('setMicAvailable').at(-1)).toEqual([false, 'Voice input needs the local voice server.']);
    expect(await c.startListening()).toBe(false);
    expect(view.of('toast').at(-1)[0]).toMatch(/voice server/);
    expect(c.state).toBe('idle');
  });

  it('hands-free: listens when idle, pauses while thinking/speaking, resumes after', async () => {
    const { c, bridge, mic } = setup({ settings: { voice: { handsFree: true } }, clipMs: 20 });
    await c.start();
    expect(c.handsFree).toBe(true);
    await waitFor(() => mic.mode === 'handsfree');
    mic.emit('speechstart');
    expect(c.state).toBe('listening');
    mic.emit('utterance', { wav: new ArrayBuffer(8), durationMs: 1000, speechMs: 800 });
    expect(mic.paused).toBe(true);
    await waitFor(() => bridge.calls.some((x) => x[0] === 'send'));
    expect(c.state).toBe('thinking');
    bridge.emit(ev.start('t1'));
    bridge.emit(ev.delta('t1', 'Sure thing. '));
    bridge.emit(ev.end('t1'));
    await waitFor(() => c.state === 'idle');
    await waitFor(() => mic.paused === false, { message: 'mic resumed' });
    // turning it off releases the mic
    c.applySettings(deepMerge(DEFAULT_SETTINGS, { voice: { handsFree: false } }));
    expect(c.handsFree).toBe(false);
    expect(mic.log.at(-1)).toEqual(['cancel']);
  });

  it('toggleListening: listen → stop+transcribe', async () => {
    const { c, stt } = setup();
    await c.start();
    await c.toggleListening();
    expect(c.state).toBe('listening');
    await c.toggleListening();
    expect(stt.calls).toBe(1);
  });
});
