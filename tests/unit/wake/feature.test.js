// WakeFeature (src/wake/feature.js) against fakes of the Mic, the AudioPlayer, the controller,
// the bridge and /stt: the wiring the browser e2e exercises end to end, here step by step and
// on a fake clock — the tap feeds the port and the ring; a hit is checked on exactly the wake
// segment; her own voice is masked; the echo test counts hits and never acts; a test clip is
// saved with its hits; turning it off releases the mic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
import { Mic } from '../../../src/audio/mic.js';
import { ECHO_TEST_LINE, WakeFeature } from '../../../src/wake/feature.js';
import { WAKE } from '../../../src/wake/machine.js';

const RATE = 16000;

class FakeMic extends Emitter {
  constructor() {
    super();
    this.samplesSeen = 0;
    this._tap = null;
    this.mode = null;
    this.opened = 0;
    this.closed = 0;
    this.ringCalls = [];
    this.echo = 'app';
  }
  setTap(fn) { this._tap = fn; }
  get tapped() { return !!this._tap; }
  setEchoMode(m) { this.echo = m; }
  async open() { this.opened++; }
  close() { this.closed++; }
  get isOpen() { return this.opened > this.closed; }
  get trackLabel() { return 'Microphone Array (Realtek(R) Audio)'; }
  get echoCancellation() { return 'all'; }
  get muted() { return false; }
  ignoreSpeechStartUntil(t) { this.ignoreUntil = t; }
  /** like the real Mic: the last 3 s */
  get ringStart() { return Math.max(0, this.samplesSeen - 3 * RATE); }
  ring(a, b) {
    this.ringCalls.push([a, b]);
    return b > a && b <= this.samplesSeen && a >= this.ringStart ? new Float32Array(b - a).fill(0.1) : null;
  }
  /** deliver `ms` of tapped audio, in real time on the fake clock (clock.tick(ms) moves it) */
  feed(ms, clock) {
    const n = Math.round((ms / 1000) * RATE);
    for (let done = 0; done < n; done += 683) {
      const x = new Float32Array(Math.min(683, n - done)).fill(0.01);
      clock.tick((x.length / RATE) * 1000);
      const at = this.samplesSeen;
      this.samplesSeen += x.length;
      this._tap?.(x, { at, arrivalPerf: clock.now() });
    }
  }
}

class FakePlayer extends Emitter {
  constructor() {
    super();
    this.cues = [];
    this.ducks = [];
    this.kind = 'audio';
    this.sampleRate = 48000;
  }
  duck(db, ms) { this.ducks.push(['duck', db, ms]); }
  unduck(ms, after) { this.ducks.push(['unduck', ms, after]); }
  playCue(samples, rate) {
    this.cues.push(samples.length / rate);
    return { startPerf: 0, endPerf: 0 };
  }
}

/**
 * The real Mic over a fake getUserMedia/AudioContext (the ScriptProcessor path): its track, its
 * modes and its 20 s idle close are what is under test. feed(ms, clock) like FakeMic's.
 * @param {() => number} now
 */
function realMic(now) {
  const env = { processor: null, stopped: 0, tracks: [] };
  const node = () => ({ connect() {}, disconnect() {} });
  const gum = async () => {
    const t = { readyState: 'live', muted: false, label: 'Microphone Array (Realtek(R) Audio)', addEventListener() {}, getSettings: () => ({ echoCancellation: 'all' }), stop() { env.stopped++; this.readyState = 'ended'; } };
    env.tracks.push(t);
    return { getAudioTracks: () => [t], getTracks: () => [t] };
  };
  const ctx = () => ({
    sampleRate: 16000, state: 'running', destination: {}, resume: async () => {}, close() {},
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createScriptProcessor: () => {
      const sp = { ...node(), onaudioprocess: null };
      env.processor = sp;
      return sp;
    },
  });
  const mic = new Mic({ getUserMedia: gum, createContext: ctx, now });
  /** @type {any} */ (mic).env = env;
  /** @type {any} */ (mic).track = () => env.tracks.at(-1);
  /** @type {any} */ (mic).feed = (ms, clock) => {
    const n = Math.round((ms / 1000) * RATE);
    for (let done = 0; done < n; done += 683) {
      const x = new Float32Array(Math.min(683, n - done)).fill(0.01);
      clock.tick((x.length / RATE) * 1000);
      env.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => x } });
    }
  };
  return mic;
}

function setup(o = {}) {
  vi.useFakeTimers();
  let t = 10_000;
  const now = () => t;
  const mic = o.realMic ? realMic(now) : new FakeMic();
  const player = new FakePlayer();
  const speech = Object.assign(new Emitter(), { busy: false });
  const said = [];
  const captures = [];
  const controller = {
    state: 'idle', activeTurnId: null, pendingSends: 0, claudeStatus: null, sleeping: false, listen: null, speech,
    adapter: null,
    setWakeWord(a) { this.adapter = a; },
    wakeWordChanged: vi.fn(),
    wakeWordCapture: vi.fn(async (c) => {
      captures.push(c);
      if (!o.realMic) return true;
      // like the controller: the capture is the Mic's 'utterance' mode
      controller.listen = { mode: 'utterance', wake: c.meta };
      await mic.start('utterance', { fromSample: c.fromSample, noSpeechMs: c.noSpeechMs });
      return true;
    }),
    wakeWordShow: vi.fn(),
    wakeWordCancel: vi.fn(() => {
      if (!o.realMic || !controller.listen?.wake) return;
      controller.listen = null;
      mic.cancel();
    }),
    wakeWordQuiet: vi.fn(),
    stopSpeaking: vi.fn(),
    noteActivity: vi.fn(),
    // like the controller: a line that is spoken keeps the speech queue busy until 'idle'
    say: vi.fn((text) => { said.push(text); if (o.speaks !== false) speech.busy = true; return true; }),
  };
  const posted = [];
  const fakePort = { postMessage: (m) => posted.push(m), close() {}, start() {}, onmessage: null };
  const win = {
    handlers: new Set(),
    addEventListener(type, fn) { if (type === 'message') this.handlers.add(fn); },
    removeEventListener(type, fn) { this.handlers.delete(fn); },
  };
  const reports = [];
  const saved = [];
  let portGen = 0;
  const settings = { wake: { enabled: true, explained: true, sounds: 'start', ...(o.wake || {}) }, camera: {}, voice: { speakReplies: true, ...(o.voice || {}) } };
  const bridge = {
    wake: {
      status: async () => ({ engine: 'ready', detail: '', models: { giga: 'ok', zhen: 'ok', vad: 'ok' } }),
      onStatus: () => () => {},
      onPower: () => () => {},
      // like main: a new port (a newer gen) per request
      requestPort: async () => {
        const gen = ++portGen;
        for (const fn of win.handlers) fn({ source: win, data: { type: 'lm:wake:port', gen }, ports: [fakePort] });
        fakePort.onmessage?.({ data: { t: 'ready', models: ['giga'], gen } });
        return { ok: true, gen };
      },
      report: (st) => reports.push(st.state),
      micAccess: async () => 'granted',
      saveClip: vi.fn(async (c) => { saved.push(c); return { ok: true, path: 'x.wav' }; }),
    },
    window: { show: vi.fn() },
  };
  const transcripts = [...(o.transcripts || [])];
  const stt = {
    available: () => true,
    device: () => 'cuda',
    unavailableReason: () => '',
    transcribe: vi.fn(async () => ({ text: transcripts.shift() ?? '' })),
  };
  const toasts = [];
  const view = { render: vi.fn(), toast: (m, l) => toasts.push([m, l]), setDim: vi.fn(), announce: vi.fn(), hint: vi.fn(), showOffer: vi.fn(), hideOffer: vi.fn() };
  const f = new WakeFeature({
    bridge, controller, mic, player, speech, services: { stt, tts: { mode: () => 'server' } }, voiceInfo: () => ({ status: 'ready' }),
    view, getSettings: () => settings, saveWake: vi.fn(async (w) => Object.assign(settings.wake, w)), now, win, mediaDevices: null,
  });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const advance = async (ms) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  };
  /** the utility says it heard the keyword ending at sample endAt */
  const hit = (extra = {}) => fakePort.onmessage?.({ data: { t: 'hit', id: extra.id || 'h1', keyword: 'HEY_JADE', model: 'giga', streamAt: 0, startAt: extra.endAt - 8000, endAt: extra.endAt, ...extra } });
  const clock = { now, tick: (ms) => { t += ms; } };
  return { f, mic, player, speech, controller, bridge, stt, view, posted, reports, saved, said, captures, toasts, settings, now, clock, flush, advance, hit };
}

afterEach(() => {
  vi.useRealTimers();
});

async function started(o) {
  const s = setup(o);
  s.f.start();
  await s.flush();
  await s.advance(10);
  return s;
}

describe('WakeFeature: the mic, the port, the ring', () => {
  it('opens the mic for her name, asks for the all-apps echo canceller, feeds the port with the tap', async () => {
    const s = await started();
    expect(s.f.state).toBe('waiting');
    expect(s.mic.echo).toBe('all');
    expect(s.mic.tapped).toBe(true);
    s.mic.feed(1000, s.clock);
    const pcm = s.posted.filter((m) => m.t === 'pcm');
    expect(pcm.reduce((n, m) => n + m.pcm.length, 0)).toBe(RATE);
    expect(pcm[1].at).toBe(683);
    expect(s.stt.transcribe).not.toHaveBeenCalled(); // nothing is transcribed while waiting (PWR-2)
    await s.advance(300); // reports to main are coalesced (at most 4 a second)
    expect(s.reports.at(-1)).toBe('waiting');
  });

  it('a hit: the capture starts where the keyword ended; only the wake segment is checked; accepted → one earcon', async () => {
    const s = await started({ transcripts: ['Hey Jade.'] });
    s.mic.feed(3000, s.clock);
    const endAt = s.mic.samplesSeen - 4000;
    s.hit({ endAt });
    expect(s.f.state).toBe('attention');
    const cut = endAt + Math.round((WAKE.cutAfterKeywordMs / 1000) * RATE);
    expect(s.captures[0]).toMatchObject({ kind: 'command', fromSample: cut, noSpeechMs: WAKE.commandWindowMs });
    expect(s.posted.some((m) => m.t === 'reset')).toBe(true);
    // the segment: ≤ 2.5 s before the keyword's end, to 150 ms after it
    expect(s.mic.ringCalls[0]).toEqual([endAt - Math.round((WAKE.segMaxBeforeEndMs / 1000) * RATE), cut]);
    await s.flush();
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(s.f.state).toBe('listening');
    expect(s.player.cues).toHaveLength(1);
    expect(s.f.log.at(-1).text).toBe('woke');
  });

  it('the segment is not in the ring yet: the check waits for the tap', async () => {
    const s = await started({ transcripts: ['Hey Jade.'] });
    s.mic.feed(2000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen }); // its 150 ms tail has not been heard yet
    await s.flush();
    expect(s.stt.transcribe).not.toHaveBeenCalled();
    s.mic.feed(200, s.clock);
    await s.flush();
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1);
  });

  it('a hit that arrives late is checked on what the ring still holds of its segment (not rejected as "nothing understood")', async () => {
    const s = await started({ transcripts: ['Hey Jade.'] });
    s.mic.feed(10_000, s.clock);
    const endAt = s.mic.samplesSeen - Math.round(2.5 * RATE); // a busy PC: the hit is 2.5 s late
    s.hit({ endAt, streamAt: endAt - 6 * RATE });
    await s.flush();
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(s.mic.ringCalls[0]).toEqual([s.mic.ringStart, endAt + Math.round(0.15 * RATE)]);
    expect(s.f.state).toBe('listening');
  });

  it('a hit whose call is no longer in the ring: "no longer buffered" in the log, not "nothing understood", and not counted', async () => {
    const s = await started();
    s.mic.feed(10_000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - Math.round(3.2 * RATE) });
    await s.flush();
    expect(s.stt.transcribe).not.toHaveBeenCalled();
    expect(s.f.state).toBe('waiting');
    expect(s.f.log.at(-1).text).toBe('ignored · the audio was no longer buffered');
    expect(s.f.machine.burst).toEqual([]);
  });

  it('the segment ends where stage 1 decided (emitAt), so "Hey Jude" is not cut short', async () => {
    const s = await started({ transcripts: ['Hey Jude!'] });
    s.mic.feed(3000, s.clock);
    const endAt = s.mic.samplesSeen - 8000;
    s.hit({ endAt, emitAt: endAt + 7000 });
    await s.flush();
    expect(s.mic.ringCalls[0]).toEqual([endAt - Math.round(1.2 * RATE), endAt + 7000]);
    expect(s.captures[0].fromSample).toBe(endAt + Math.round(0.15 * RATE));
    await s.flush();
    expect(s.f.log.at(-1).text).toBe('ignored · sounded like “Hey Jude”');
  });

  it('"Hey Jude": rejected silently, back to waiting, the capture cancelled', async () => {
    const s = await started({ transcripts: ["Hey Jude, don't make it bad."] });
    s.mic.feed(3000, s.clock);
    s.controller.listen = { wake: { wakeId: 'h1' } };
    s.hit({ endAt: s.mic.samplesSeen - 4000 });
    await s.flush();
    await s.flush();
    expect(s.f.state).toBe('waiting');
    expect(s.player.cues).toHaveLength(0);
    expect(s.controller.wakeWordCancel).toHaveBeenCalled();
    expect(s.f.log.at(-1).text).toBe('ignored · sounded like “Hey Jude”');
  });
});

describe('WakeFeature: her own voice', () => {
  it('a hit while she says her name is masked: no check, no duck', async () => {
    const s = await started();
    s.mic.feed(3000, s.clock);
    s.speech.busy = true;
    s.controller.state = 'speaking';
    s.controller.adapter.state('speaking');
    s.speech.emit('playing', { clip: { kind: 'audio' }, text: "Hello! I'm Jade, floating on your desktop." });
    s.mic.feed(1000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 2000 });
    await s.flush();
    expect(s.stt.transcribe).not.toHaveBeenCalled();
    expect(s.player.ducks).toEqual([]);
    expect(s.f.log.at(-1).text).toBe('ignored · my own voice');
  });

  it('a hit while she speaks without her name: ducked, checked, stopped (barge-in)', async () => {
    const s = await started({ transcripts: ['Hey Jade.'] });
    s.mic.feed(3000, s.clock);
    s.speech.busy = true;
    s.controller.state = 'speaking';
    s.controller.activeTurnId = 't1';
    s.controller.adapter.state('speaking');
    s.speech.emit('playing', { clip: { kind: 'audio' }, text: 'Holograms work by recording how light interferes.' });
    s.mic.feed(1000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 4000 });
    expect(s.f.state).toBe('barge');
    expect(s.player.ducks[0]).toEqual(['duck', WAKE.duckDb, WAKE.duckRampMs]);
    await s.flush();
    await s.flush();
    expect(s.controller.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(s.f.state).toBe('listening');
  });
});

describe('WakeFeature: Test my echo, Record a test clip', () => {
  it('the echo test says its line, counts the hits it causes and never acts on them', async () => {
    const s = await started();
    expect(s.f.echoTest()).toBe(true);
    expect(s.said).toEqual([ECHO_TEST_LINE]);
    s.mic.feed(3000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 4000 });
    s.hit({ id: 'h2', endAt: s.mic.samplesSeen - 100 });
    await s.flush();
    expect(s.stt.transcribe).not.toHaveBeenCalled();
    expect(s.captures).toEqual([]);
    s.speech.busy = false;
    s.speech.emit('idle');
    await s.advance(1300);
    expect(s.toasts.at(-1)[0]).toMatch(/I heard my own voice 2 times/);
    expect(s.f.echoResult).toMatch(/2 times/);
  });

  it('"Speak replies" off: the echo test does not start (no line in the chat), says why, and her name keeps working', async () => {
    const s = await started({ voice: { speakReplies: false }, transcripts: ['Hey Jade.'] });
    expect(s.f.echoTest()).toBe(false);
    expect(s.said).toEqual([]);
    expect(s.toasts.at(-1)[0]).toMatch(/Speak replies/);
    expect(s.f._echoTest).toBeNull();
    s.f._render();
    expect(s.view.render.mock.calls.at(-1)[0]).toMatchObject({ canSpeak: false, echoTesting: false });
    s.mic.feed(3000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 4000 });
    await s.flush();
    expect(s.stt.transcribe).toHaveBeenCalledTimes(1); // the hit is acted on, not swallowed by a test
  });

  it('the line was not spoken after all (the voice went away): no test, nothing left exempt', async () => {
    const s = await started({ speaks: false });
    expect(s.f.echoTest()).toBe(false);
    expect(s.f._echoTest).toBeNull();
    expect(s.f.mask.masked(0, 1)).toBeFalsy();
    expect(s.toasts.at(-1)[0]).toMatch(/Speak replies/);
  });

  it('the echo test ends after 20 s whatever happens (a voice that never goes idle)', async () => {
    const s = await started();
    expect(s.f.echoTest()).toBe(true);
    await s.advance(20_100);
    expect(s.f._echoTest).toBeNull();
    expect(s.toasts.at(-1)[0]).toMatch(/did not finish/);
  });

  it('a test clip: the tapped audio and the hits in it, saved through main', async () => {
    const s = await started();
    expect(s.f.recordClip(1)).toBe(true);
    s.mic.feed(500, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 100, keyword: 'HEY_JUDE' });
    s.mic.feed(700, s.clock);
    await s.flush();
    expect(s.bridge.wake.saveClip).toHaveBeenCalledTimes(1);
    const c = s.saved[0];
    expect(c.wav.byteLength).toBe(44 + RATE * 2);
    expect(c.hits).toEqual([{ atSec: expect.closeTo(0.49, 1), keyword: 'HEY_JUDE', outcome: 'heard' }]);
    expect(s.toasts.at(-1)).toEqual(['Saved the test clip: x.wav', 'success']);
  });
});

describe('WakeFeature: a test clip never outlives the microphone (PRIV: only when you press it)', () => {
  it('turning "Hey Jade" off while recording cancels the clip: nothing is saved, even after it is turned on again', async () => {
    const s = await started();
    expect(s.f.recordClip(30)).toBe(true);
    s.mic.feed(5000, s.clock);
    s.settings.wake = { ...s.settings.wake, enabled: false };
    s.f.applySettings(s.settings);
    await s.flush();
    expect(s.f.state).toBe('off');
    expect(s.f._rec).toBeNull();
    expect(s.toasts.some(([m]) => /test clip was cancelled/.test(m))).toBe(true);
    await s.advance(600_000);
    s.settings.wake = { ...s.settings.wake, enabled: true };
    s.f.applySettings(s.settings);
    await s.advance(50);
    s.mic.feed(26_000, s.clock);
    await s.flush();
    expect(s.bridge.wake.saveClip).not.toHaveBeenCalled();
    expect(s.f.recordClip(1)).toBe(true); // a new one can be started again
  });

  it('a PC lock while recording cancels it (no clip spliced from before and after the lock)', async () => {
    const s = await started();
    s.f.recordClip(30);
    s.mic.feed(5000, s.clock);
    s.f._step({ type: 'power', state: 'locked' });
    await s.advance(3_600_000);
    s.f._step({ type: 'power', state: 'unlocked' });
    await s.advance(50);
    s.mic.feed(30_000, s.clock);
    await s.flush();
    expect(s.bridge.wake.saveClip).not.toHaveBeenCalled();
  });

  it('a gap in the samples cancels it; so does "Cancel recording"; the chip never says "Recording" without the mic', async () => {
    const s = await started();
    s.f.recordClip(2);
    s.mic.feed(500, s.clock);
    s.mic.samplesSeen += 16000; // the device reopened: a second later
    s.mic.feed(2000, s.clock);
    await s.flush();
    expect(s.bridge.wake.saveClip).not.toHaveBeenCalled();
    expect(s.toasts.at(-1)[0]).toMatch(/interrupted/);
    s.f.recordClip(2);
    expect(s.f.cancelRecording()).toBe(true);
    s.mic.feed(3000, s.clock);
    await s.flush();
    expect(s.bridge.wake.saveClip).not.toHaveBeenCalled();
    expect(s.f.cancelRecording()).toBe(false);
  });
});

describe('WakeFeature: the microphone is released within 1 s, also during a capture (PRIV-5, PRIV-6)', () => {
  for (const [from, how] of [['listening', 'lock'], ['listening', 'off'], ['followup', 'lock'], ['followup', 'off']]) {
    it(`${from} → ${how === 'lock' ? 'PC locked' : '"Hey Jade" off'}: the track ends at once, not after the Mic's 20 s idle time`, async () => {
      const s = await started({ realMic: true });
      s.mic.feed(1000, s.clock);
      if (from === 'listening') s.f.adapter.manual({ from: 'hotkey' });
      else s.f.adapter.idle({ turnId: 't1', voiceTurn: true, spoke: true, permissionPending: false });
      await s.flush();
      expect(s.f.state).toBe(from);
      expect(s.mic.mode).toBe('utterance');
      const track = s.mic.track();
      expect(track.readyState).toBe('live');
      if (how === 'lock') s.f._step({ type: 'power', state: 'locked' });
      else {
        s.settings.wake = { ...s.settings.wake, enabled: false };
        s.f.applySettings(s.settings);
      }
      await s.advance(300);
      expect(track.readyState).toBe('ended');
      expect(s.mic.isOpen).toBe(false);
      expect(s.controller.listen).toBeNull();
    });
  }
});

describe('WakeFeature: the controller hears when wake mode stops running', () => {
  it('the transcript check: a PC lock stops the controller\'s hands-free at once (never plain hands-free while locked)', async () => {
    const s = await started({ wake: { transcriptFallback: true } });
    s.f._onEngine({ engine: 'error', detail: 'keeps stopping' });
    await s.flush();
    expect(s.f.machine.fallback).toBe(true);
    expect(s.controller.adapter.fallback()).toBe(true);
    s.controller.wakeWordChanged.mockClear();
    s.f._step({ type: 'power', state: 'locked' });
    expect(s.f.state).toBe('locked');
    // the controller re-reads active()/fallback() now (its hands-free stops: no name, no lock → nothing)
    expect(s.controller.wakeWordChanged).toHaveBeenCalled();
    expect(s.controller.adapter.active()).toBe(false);
    expect(s.controller.adapter.fallback()).toBe(false);
  });
});

describe('WakeFeature: a rejected hit does not keep her awake', () => {
  it('asleep, the TV says "Hey Jake": she looks up, the check rejects it, she dozes off again', async () => {
    const s = await started({ transcripts: ['Hey Jake, come here.'] });
    s.controller.sleeping = true;
    s.controller.sleep = vi.fn(() => { s.controller.sleeping = true; return true; });
    s.mic.feed(3000, s.clock);
    s.hit({ endAt: s.mic.samplesSeen - 4000 });
    s.controller.sleeping = false; // the attention cue woke her (fast wake)
    await s.flush();
    await s.flush();
    expect(s.f.log.at(-1).text).toBe('ignored · another name');
    expect(s.controller.sleep).toHaveBeenCalledTimes(1);
    // a real call keeps her awake
    s.controller.sleep.mockClear();
    s.stt.transcribe.mockImplementationOnce(async () => ({ text: 'Hey Jade.' }));
    s.controller.sleeping = true;
    s.mic.feed(3000, s.clock);
    s.hit({ id: 'h2', endAt: s.mic.samplesSeen - 4000 });
    await s.flush();
    await s.flush();
    expect(s.f.state).toBe('listening');
    expect(s.controller.sleep).not.toHaveBeenCalled();
  });
});

describe('WakeFeature: the engine stops answering', () => {
  it('the port is lost (a frozen utility): "starting", not "listening"; a new port: listening again, strict re-sent', async () => {
    const s = await started();
    expect(s.f.state).toBe('waiting');
    s.f.machine.strictUntil = s.now() + 60_000; // strict mode is on
    const answer = s.bridge.wake.requestPort;
    s.bridge.wake.requestPort = async () => ({ ok: true, gen: 0 }); // the frozen utility never answers on a new port
    // three pings without a pong
    s.f.port._pings = 3;
    s.f.port._ping();
    await s.flush();
    s.bridge.wake.requestPort = answer;
    expect(s.f.state).toBe('starting');
    expect(s.f.machine.reason).toMatch(/not answering/);
    // main's status still says ready (its watchdog has not fired yet): still not listening
    s.f._onEngine({ engine: 'ready', detail: '' });
    expect(s.f.state).toBe('starting');
    // main restarted the utility: a new port answers
    s.posted.length = 0;
    await s.bridge.wake.requestPort();
    await s.flush();
    await s.advance(10);
    expect(s.f.state).toBe('waiting');
    expect(s.posted.some((m) => m.t === 'strict' && m.on === true)).toBe(true);
  });
});

describe('WakeFeature: off', () => {
  it('turning it off releases the mic and the tap, with the micOff earcon', async () => {
    const s = await started();
    s.settings.wake = { ...s.settings.wake, enabled: false };
    s.f.applySettings(s.settings);
    await s.flush();
    expect(s.f.state).toBe('off');
    expect(s.mic.tapped).toBe(false);
    expect(s.mic.closed).toBeGreaterThan(0);
    expect(s.player.cues).toHaveLength(1);
  });

  it('dispose leaves nothing behind', async () => {
    const s = await started();
    s.f.dispose();
    expect(s.mic.tapped).toBe(false);
    expect(s.controller.adapter).toBeNull();
  });
});
