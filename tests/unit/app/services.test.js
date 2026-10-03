/* global Response, DOMException */
import { describe, expect, it, vi } from 'vitest';
import { ClickThroughGate, probeAvatar } from '../../../src/app/click-through.js';
import { spokenPermissionPrompt, summarizeToolInput, toolChipLabel, toolCue } from '../../../src/app/permission.js';
import { DEFAULT_SETTINGS, deepMerge, getPath, patchFor, withDefaults } from '../../../src/app/settings-defaults.js';
import { createSpeechServices } from '../../../src/speech/index.js';
import { VoiceClient, VoiceError } from '../../../src/speech/voice-client.js';
import { WebSpeechTTS, estimateSpeechSeconds, pickVoice, scoreVoice } from '../../../src/speech/web-speech.js';

describe('permission summaries', () => {
  it('summarises common tools', () => {
    expect(summarizeToolInput('Bash', { command: 'rm -rf build', description: 'Clean the build' }))
      .toMatchObject({ title: 'Clean the build', target: 'rm -rf build', risk: 'danger' });
    expect(summarizeToolInput('Write', { file_path: 'C:\\work\\notes.md', content: 'hello' }))
      .toMatchObject({ title: 'Write notes.md', target: 'C:\\work\\notes.md', detail: 'hello', risk: 'write' });
    const edit = summarizeToolInput('Edit', { file_path: '/a/b.js', old_string: 'x = 1', new_string: 'x = 2' });
    expect(edit.detail).toBe('- x = 1\n+ x = 2');
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com', prompt: 'summarise' })).toMatchObject({ risk: 'web', target: 'https://example.com' });
    expect(summarizeToolInput('mcp__github__create_issue', { title: 't' })).toMatchObject({ title: 'Use create issue (github)', fields: [{ label: 'title', value: 't' }] });
    expect(summarizeToolInput('Weird', null)).toMatchObject({ title: 'Use Weird', fields: [] });
  });

  it('clips very long inputs', () => {
    const s = summarizeToolInput('Bash', { command: 'x'.repeat(5000) });
    expect(s.target.length).toBeLessThanOrEqual(400);
    expect(s.target.endsWith('…')).toBe(true);
  });

  it('spoken prompts, cues and chip labels', () => {
    expect(spokenPermissionPrompt('Bash')).toBe('I need your permission to run a command.');
    expect(spokenPermissionPrompt('Write', { file_path: '/x/report.txt' })).toBe('May I write the file report.txt?');
    expect(spokenPermissionPrompt('mcp__slack__post_message')).toBe('I need your permission to use post message.');
    expect(toolCue('WebSearch')).toBe('Let me look that up.');
    expect(toolChipLabel('Read', { file_path: '/a/b/c.txt' })).toBe('Reading c.txt');
    expect(toolChipLabel('Bash', { command: 'ls -la' })).toBe('Running: ls -la');
  });
});

describe('ClickThroughGate', () => {
  it('goes interactive immediately and click-through only after the delay; dedupes calls', () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      const g = new ClickThroughGate({ apply: (v) => calls.push(v), leaveDelayMs: 100 });
      g.update(false); // disabled: nothing happens
      expect(calls).toEqual([]);
      g.setEnabled(true);
      expect(calls).toEqual([false]);
      g.update(false);
      vi.advanceTimersByTime(50);
      g.update(true); // came back before the delay: stays interactive
      vi.advanceTimersByTime(200);
      expect(calls).toEqual([false]);
      g.update(false);
      g.update(false);
      vi.advanceTimersByTime(120);
      expect(calls).toEqual([false, true]);
      g.update(false);
      vi.advanceTimersByTime(200);
      expect(calls).toEqual([false, true]);
      g.update(true);
      expect(calls).toEqual([false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds force interactivity; disabling is fail-safe', () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      const g = new ClickThroughGate({ apply: (v) => calls.push(v), leaveDelayMs: 10 });
      g.setEnabled(true);
      g.update(false);
      vi.advanceTimersByTime(20);
      expect(g.ignoring).toBe(true);
      g.hold('drawer', true);
      expect(g.ignoring).toBe(false);
      g.update(false);
      vi.advanceTimersByTime(50);
      expect(g.ignoring).toBe(false);
      g.hold('drawer', false);
      vi.advanceTimersByTime(20);
      expect(g.ignoring).toBe(true);
      g.setEnabled(false);
      expect(calls.at(-1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probeAvatar adds a margin only while interactive', () => {
    const hit = (x) => x < 100;
    expect(probeAvatar(hit, 105, 0, true, 10)).toBe(true);
    expect(probeAvatar(hit, 105, 0, false, 10)).toBe(false);
    expect(probeAvatar(hit, 50, 0, false)).toBe(true);
  });
});

describe('settings helpers', () => {
  it('deepMerge / withDefaults / paths', () => {
    const s = withDefaults({ voice: { ttsSpeed: 1.5 }, extra: { keep: 1 } });
    expect(s.voice.ttsSpeed).toBe(1.5);
    expect(s.voice.ttsVoice).toBe('af_heart');
    expect(/** @type {any} */ (s).extra.keep).toBe(1);
    expect(deepMerge({ a: { b: 1 } }, JSON.parse('{"__proto__": {"polluted": 1}, "a": {"c": 2}}'))).toEqual({ a: { b: 1, c: 2 } });
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
    expect(getPath(DEFAULT_SETTINGS, 'window.sizePreset')).toBe('medium');
    expect(patchFor('voice.handsFree', true)).toEqual({ voice: { handsFree: true } });
  });
});

describe('VoiceClient', () => {
  const ready = { status: 'ready', url: 'http://127.0.0.1:5555/', token: 'tok' };

  it('sends the bearer token and JSON body', async () => {
    const seen = [];
    const vc = new VoiceClient({
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ sampleRate: 24000, audioB64: 'AAAA', durationSec: 1, visemes: null }), { status: 200 });
      },
    });
    vc.configure(ready);
    const r = await vc.synthesize('hi', { voice: 'af_bella', speed: 1.1 });
    expect(r.audioB64).toBe('AAAA');
    expect(seen[0].url).toBe('http://127.0.0.1:5555/tts');
    expect(seen[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[0].init.body)).toEqual({ text: 'hi', voice: 'af_bella', speed: 1.1 });
  });

  it('maps HTTP errors, network errors, timeouts and aborts', async () => {
    const vc = new VoiceClient({ fetch: async () => new Response(JSON.stringify({ error: 'TTS busy', code: 'busy' }), { status: 503 }) });
    vc.configure(ready);
    await expect(vc.synthesize('x')).rejects.toMatchObject({ name: 'VoiceError', status: 503, code: 'busy', retryable: true, message: 'TTS busy' });

    const down = new VoiceClient({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    down.configure(ready);
    await expect(down.voices()).rejects.toMatchObject({ code: 'network' });

    const slow = new VoiceClient({
      fetch: (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      timeouts: { stt: 20 },
    });
    slow.configure(ready);
    await expect(slow.transcribe(new ArrayBuffer(4))).rejects.toMatchObject({ code: 'timeout' });
    const ctrl = new AbortController();
    const p = slow.transcribe(new ArrayBuffer(4), { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses to call when not configured', async () => {
    const vc = new VoiceClient({ fetch: async () => new Response('{}') });
    expect(vc.ready).toBe(false);
    await expect(vc.voices()).rejects.toBeInstanceOf(VoiceError);
  });
});

describe('speech services', () => {
  const settings = () => DEFAULT_SETTINGS;
  const serverClient = (health) => {
    const vc = new VoiceClient({ fetch: async () => new Response(JSON.stringify({ sampleRate: 24000, audioB64: 'UklGRg==', durationSec: 0.1, visemes: [{ start: 0, end: 0.1, viseme: 'aa' }] })) });
    vc.configure({ status: 'ready', url: 'http://127.0.0.1:1', token: 't', health });
    return vc;
  };

  it('prefers the server, falls back to the browser voice, else none', async () => {
    const web = { available: true };
    const { tts, stt } = createSpeechServices({ voiceClient: serverClient({}), webSpeech: /** @type {any} */ (web), getSettings: settings });
    expect(tts.mode()).toBe('server');
    expect(stt.available()).toBe(true);
    const clip = await tts.synthesize('hello');
    expect(clip).toMatchObject({ kind: 'audio', audioB64: 'UklGRg==', visemes: [{ viseme: 'aa' }] });

    const off = createSpeechServices({ voiceClient: new VoiceClient(), webSpeech: /** @type {any} */ (web), getSettings: settings });
    expect(off.tts.mode()).toBe('browser');
    expect(await off.tts.synthesize('hi')).toEqual({ kind: 'speech', text: 'hi', rate: 1 });
    expect(off.stt.available()).toBe(false);
    expect(off.stt.unavailableReason()).toMatch(/setup-voice/);

    const none = createSpeechServices({ voiceClient: new VoiceClient(), webSpeech: null, getSettings: settings });
    expect(none.tts.available()).toBe(false);
  });

  it('an engine that failed to load is unavailable; voice.enabled=false disables the server', () => {
    const vc = serverClient({ stt: { loaded: false, error: 'CUDA out of memory' }, tts: { loaded: true } });
    const s = createSpeechServices({ voiceClient: vc, webSpeech: null, getSettings: settings });
    expect(s.stt.available()).toBe(false);
    expect(s.stt.unavailableReason()).toMatch(/CUDA out of memory/);
    expect(s.tts.mode()).toBe('server');
    const disabled = createSpeechServices({ voiceClient: vc, webSpeech: null, getSettings: () => deepMerge(DEFAULT_SETTINGS, { voice: { enabled: false } }) });
    expect(disabled.tts.mode()).toBe('none');
    expect(disabled.stt.unavailableReason()).toMatch(/off/);
  });

  it('server TTS failure falls back to the browser voice for that sentence', async () => {
    const vc = new VoiceClient({ fetch: async () => new Response('{"error":"boom"}', { status: 500 }) });
    vc.configure({ status: 'ready', url: 'http://127.0.0.1:1', token: 't' });
    const fallbacks = [];
    const s = createSpeechServices({ voiceClient: vc, webSpeech: /** @type {any} */ ({ available: true }), getSettings: settings, onFallback: (e) => fallbacks.push(e.message) });
    expect(await s.tts.synthesize('hello')).toMatchObject({ kind: 'speech', text: 'hello' });
    expect(fallbacks).toEqual(['boom']);
  });
});

describe('Web Speech', () => {
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false },
    { name: 'Google Deutsch', lang: 'de-DE' },
    { name: 'eSpeak English', lang: 'en' },
    { name: 'Zarvox', lang: 'en-US' },
  ];

  it('picks the most natural English voice', () => {
    expect(pickVoice(voices).name).toMatch(/Aria/);
    expect(pickVoice(voices, { preferred: 'Microsoft David - English (United States)' }).name).toMatch(/David/);
    expect(pickVoice([{ name: 'Google Deutsch', lang: 'de-DE' }])).toBeNull();
    expect(scoreVoice({ name: 'Zarvox', lang: 'en-US' })).toBeLessThan(scoreVoice({ name: 'Microsoft Zira', lang: 'en-US' }));
    expect(estimateSpeechSeconds('one two three four five six', 1)).toBeCloseTo(6 / 2.6, 5);
  });

  it('speaks through a fake synth, forwarding boundaries, and resolves on end', async () => {
    class U {
      constructor(text) { this.text = text; }
    }
    const synth = {
      paused: false,
      spoken: [],
      getVoices: () => voices,
      addEventListener() {},
      speak(u) {
        this.spoken.push(u);
        setTimeout(() => {
          u.onstart?.();
          u.onboundary?.({ name: 'word', charIndex: 0, charLength: 5 });
          u.onboundary?.({ name: 'word', charIndex: 6, charLength: 5 });
          u.onend?.();
        }, 1);
      },
      cancel() {},
    };
    const ws = new WebSpeechTTS({ synth: /** @type {any} */ (synth), Utterance: /** @type {any} */ (U) });
    expect(await ws.init()).toBe(true);
    expect(ws.voice.name).toMatch(/Aria/);
    const words = [];
    await ws.speak('hello world', { rate: 1.3, onBoundary: (w) => words.push(w) });
    expect(words).toEqual(['hello', 'world']);
    expect(synth.spoken[0].rate).toBe(1.3);
  });

  it('is unavailable without voices; times out if end never fires', async () => {
    const empty = new WebSpeechTTS({ synth: /** @type {any} */ ({ getVoices: () => [], addEventListener() {}, removeEventListener() {} }), Utterance: /** @type {any} */ (class {}) });
    expect(await empty.init(10)).toBe(false);
    expect(empty.available).toBe(false);
    expect(new WebSpeechTTS({ synth: null }).supported).toBe(false);

    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stuck = new WebSpeechTTS({ synth: /** @type {any} */ ({ getVoices: () => voices, addEventListener() {}, speak() {}, cancel }), Utterance: /** @type {any} */ (class {}) });
      const p = stuck.speak('two words');
      await vi.advanceTimersByTimeAsync(10000);
      await p;
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
