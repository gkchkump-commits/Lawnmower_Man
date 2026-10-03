import { describe, expect, it } from 'vitest';
import { MOCK_REPLIES, createMockBridge, pickScript } from '../../../src/bridge/mock.js';
import { createFakeVoiceFetch, fakeSynthesize } from '../../../src/bridge/mock-voice.js';
import { getBridge } from '../../../src/bridge/index.js';
import { decodeWav, base64ToBytes, encodeWav } from '../../../src/audio/wav.js';
import { VoiceClient } from '../../../src/speech/voice-client.js';
import { waitFor } from './helpers.js';

const FAST = { wordDelayMs: 0, firstTokenMs: 0, startupMs: 0 };

function collect(bridge) {
  const events = [];
  bridge.claude.onEvent((e) => events.push(e));
  return events;
}

describe('mock bridge: claude', () => {
  it('starts up with status and session events', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'ready'));
    expect(events.find((e) => e.type === 'session').sessionId).toMatch(/^mock-/);
    expect((await b.claude.status()).status).toBe('ready');
  });

  it('streams a canned reply word by word and ends the turn', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    const { turnId } = await b.claude.send('hello there');
    await waitFor(() => events.some((e) => e.type === 'turn_end'));
    const mine = events.filter((e) => e.turnId === turnId);
    expect(mine[0].type).toBe('turn_start');
    const deltas = mine.filter((e) => e.type === 'text_delta');
    expect(deltas.length).toBeGreaterThan(10);
    expect(deltas.map((d) => d.text).join('')).toBe(MOCK_REPLIES.greeting);
    const end = mine.at(-1);
    expect(end).toMatchObject({ type: 'turn_end', isError: false, result: MOCK_REPLIES.greeting });
    expect(mine.some((e) => e.type === 'message_end')).toBe(true);
  });

  it('rejects empty messages', async () => {
    const b = createMockBridge(FAST);
    await expect(b.claude.send('  ')).rejects.toThrow(/empty/);
  });

  it('tool flow waits for respondPermission', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    await b.claude.send('please run the tests');
    const req = await waitFor(() => events.find((e) => e.type === 'permission_request'));
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'Bash', input: { command: expect.any(String) } });
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    await expect(b.claude.respondPermission('nope', { behavior: 'allow' })).rejects.toThrow(/Unknown/);
    await b.claude.respondPermission(req.requestId, { behavior: 'allow', updatedInput: req.input });
    await waitFor(() => events.some((e) => e.type === 'turn_end'));
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: false });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toContain(MOCK_REPLIES.toolAllowed);
  });

  it('deny produces an error tool_result and the denied text', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    await b.claude.send('use a tool');
    const req = await waitFor(() => events.find((e) => e.type === 'permission_request'));
    await b.claude.respondPermission(req.requestId, { behavior: 'deny', message: 'no' });
    await waitFor(() => events.some((e) => e.type === 'turn_end'));
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true, summary: 'no' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')).toContain(MOCK_REPLIES.toolDenied);
  });

  it('interrupt stops streaming and resolves when the turn ended', async () => {
    const b = createMockBridge({ ...FAST, wordDelayMs: 20 });
    const events = collect(b);
    await b.claude.send('tell me a long story');
    await waitFor(() => events.filter((e) => e.type === 'text_delta').length >= 2);
    await b.claude.interrupt();
    const end = events.find((e) => e.type === 'turn_end');
    expect(end).toMatchObject({ interrupted: true });
    expect(end.result.length).toBeLessThan(MOCK_REPLIES.long.length);
  });

  it('queues turns and runs them in order', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    const a = await b.claude.send('hi');
    const c = await b.claude.send('code');
    await waitFor(() => events.filter((e) => e.type === 'turn_end').length === 2);
    const starts = events.filter((e) => e.type === 'turn_start').map((e) => e.turnId);
    expect(starts).toEqual([a.turnId, c.turnId]);
  });

  it('simulated errors emit error + failed turn_end', async () => {
    const b = createMockBridge(FAST);
    const events = collect(b);
    await b.claude.send('simulate error please');
    await waitFor(() => events.some((e) => e.type === 'turn_end'));
    expect(events.find((e) => e.type === 'error').message).toMatch(/Simulated/);
    expect(events.find((e) => e.type === 'turn_end').isError).toBe(true);
  });

  it('reset emits an empty session and drops queued turns', async () => {
    const b = createMockBridge({ ...FAST, wordDelayMs: 10 });
    const events = collect(b);
    await b.claude.send('long story');
    const queued = await b.claude.send('hi');
    await b.claude.reset();
    expect(events.find((e) => e.type === 'error' && e.turnId === queued.turnId)).toBeTruthy();
    expect(events.some((e) => e.type === 'session' && e.sessionId === '')).toBe(true);
    await waitFor(() => events.filter((e) => e.type === 'session' && e.sessionId).length >= 2);
  });

  it('picks scripts by keyword', () => {
    expect(pickScript('Run it').kind).toBe('tool');
    expect(pickScript('write some code').say).toBe(MOCK_REPLIES.code);
    expect(pickScript('<b>hi</b>').say).toBe(MOCK_REPLIES.greeting);
    expect(pickScript('banana').say).toMatch(/You said: “banana”/);
  });
});

describe('mock bridge: settings, voice, window, hotkeys', () => {
  it('settings merge, validate and notify', async () => {
    const b = createMockBridge({ ...FAST, settings: { avatar: { quality: 'low' } } });
    expect((await b.settings.get()).avatar.quality).toBe('low');
    const changes = [];
    b.settings.onChange((s) => changes.push(s));
    const s = await b.settings.set({ voice: { ttsSpeed: 9, handsFree: 'yes' }, bogus: { x: 1 }, avatar: { renderer: 'procedural' } });
    expect(s.voice.ttsSpeed).toBe(2); // clamped
    expect(s.voice.handsFree).toBe(false); // wrong type ignored
    expect(s.avatar.renderer).toBe('procedural');
    expect(s.bogus).toBeUndefined();
    await waitFor(() => changes.length === 1);
    await b.settings.set({ avatar: { renderer: 'procedural' } }); // no change → no event
    await new Promise((r) => setTimeout(r, 5));
    expect(changes).toHaveLength(1);
  });

  it('voice is disabled by default; fake when asked; follows voice.enabled', async () => {
    expect((await createMockBridge(FAST).voice.info()).status).toBe('disabled');
    const b = createMockBridge({ ...FAST, voice: 'fake' });
    const info = await b.voice.info();
    expect(info).toMatchObject({ status: 'ready', token: 'mock-token' });
    const seen = [];
    b.voice.onStatus((i) => seen.push(i.status));
    await b.settings.set({ voice: { enabled: false } });
    await waitFor(() => seen.includes('disabled'));
    const ext = createMockBridge({ ...FAST, voice: 'http://127.0.0.1:8123', voiceToken: 'abc' });
    expect(await ext.voice.info()).toMatchObject({ status: 'ready', url: 'http://127.0.0.1:8123', token: 'abc' });
  });

  it('window calls are recorded no-ops; hotkeys can be triggered', async () => {
    const b = createMockBridge(FAST);
    b.window.setIgnoreMouse(true);
    b.window.minimize();
    expect(b.__mock.calls).toEqual([['setIgnoreMouse', true], ['minimize']]);
    const keys = [];
    const off = b.onHotkey((k) => keys.push(k));
    b.__mock.hotkey('toggleListen');
    off();
    b.__mock.hotkey('toggleChat');
    expect(keys).toEqual(['toggleListen']);
    expect((await b.app.info()).mock).toBe(true);
  });

  it('getBridge prefers window.lawnmower unless ?mock=1', () => {
    const real = { claude: {}, voice: {}, settings: {}, window: {}, app: {}, onHotkey() {} };
    expect(getBridge({ win: { lawnmower: real, location: { search: '' } } })).toEqual({ bridge: real, isMock: false });
    const forced = getBridge({ win: { lawnmower: real }, search: '?mock=1&voice=fake&mockDelay=5' });
    expect(forced.isMock).toBe(true);
    expect(forced.bridge.__mock.voiceFetch).toBeTypeOf('function');
    expect(getBridge({ win: {}, search: '' }).isMock).toBe(true);
  });
});

describe('fake voice server', () => {
  it('synthesizes a WAV with a contiguous viseme timeline', () => {
    const r = fakeSynthesize('Hello world');
    expect(r.sampleRate).toBe(24000);
    expect(r.visemes[0].start).toBe(0);
    for (let i = 1; i < r.visemes.length; i++) {
      expect(r.visemes[i].start).toBeCloseTo(r.visemes[i - 1].end, 6);
      expect(r.visemes[i].viseme).not.toBe(r.visemes[i - 1].viseme);
    }
    expect(r.visemes.at(-1).end).toBeCloseTo(r.durationSec, 3);
  });

  it('works through the VoiceClient (auth, /tts, /stt, /voices, /health)', async () => {
    const vc = new VoiceClient({ fetch: createFakeVoiceFetch({ latencyMs: 0 }) });
    vc.configure({ status: 'ready', url: 'http://127.0.0.1:59999', token: 'mock-token' });
    expect(vc.ready).toBe(true);
    const tts = await vc.synthesize('Testing one two.', { voice: 'af_heart', speed: 1.2 });
    const wav = decodeWav(base64ToBytes(tts.audioB64));
    expect(wav.sampleRate).toBe(24000);
    expect(wav.durationSec).toBeCloseTo(tts.durationSec, 2);
    expect(tts.visemes.length).toBeGreaterThan(5);
    const silent = await vc.transcribe(encodeWav(new Float32Array(1600), 16000));
    expect(silent.text).toBe('');
    const tone = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 5));
    expect((await vc.transcribe(encodeWav(tone, 16000))).text).toMatch(/Claude/);
    expect((await vc.voices()).length).toBeGreaterThan(2);
    expect((await vc.getHealth()).device.cuda).toBe(true);
    vc.configure({ status: 'ready', url: 'http://127.0.0.1:59999', token: 'wrong' });
    await expect(vc.voices()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });
});
