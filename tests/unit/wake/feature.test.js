// WakeFeature (src/wake/feature.js) against fakes of the Mic, the AudioPlayer, the controller,
// the bridge and /stt: the wiring the browser e2e exercises end to end, here step by step and
// on a fake clock — the tap feeds the port and the ring; a hit is checked on exactly the wake
// segment; her own voice is masked; the echo test counts hits and never acts; a test clip is
// saved with its hits; turning it off releases the mic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
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
  ring(a, b) {
    this.ringCalls.push([a, b]);
    return b > a && b <= this.samplesSeen ? new Float32Array(b - a).fill(0.1) : null;
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

function setup(o = {}) {
  vi.useFakeTimers();
  let t = 10_000;
  const now = () => t;
  const mic = new FakeMic();
  const player = new FakePlayer();
  const speech = Object.assign(new Emitter(), { busy: false });
  const said = [];
  const captures = [];
  const controller = {
    state: 'idle', activeTurnId: null, pendingSends: 0, claudeStatus: null, sleeping: false, listen: null, speech,
    adapter: null,
    setWakeWord(a) { this.adapter = a; },
    wakeWordChanged() {},
    wakeWordCapture: vi.fn(async (c) => { captures.push(c); return true; }),
    wakeWordShow: vi.fn(),
    wakeWordCancel: vi.fn(),
    wakeWordQuiet: vi.fn(),
    stopSpeaking: vi.fn(),
    noteActivity: vi.fn(),
    say: vi.fn((text) => { said.push(text); return true; }),
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
  const settings = { wake: { enabled: true, explained: true, sounds: 'start', ...(o.wake || {}) }, camera: {} };
  const bridge = {
    wake: {
      status: async () => ({ engine: 'ready', detail: '', models: { giga: 'ok', zhen: 'ok', vad: 'ok' } }),
      onStatus: () => () => {},
      onPower: () => () => {},
      requestPort: async () => {
        for (const fn of win.handlers) fn({ source: win, data: { type: 'lm:wake:port', gen: 1 }, ports: [fakePort] });
        fakePort.onmessage?.({ data: { t: 'ready', models: ['giga'], gen: 1 } });
        return { ok: true, gen: 1 };
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
    s.speech.emit('idle');
    await s.advance(1300);
    expect(s.toasts.at(-1)[0]).toMatch(/I heard my own voice 2 times/);
    expect(s.f.echoResult).toMatch(/2 times/);
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
