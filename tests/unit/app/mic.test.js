import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mic, describeMicError } from '../../../src/audio/mic.js';
import { decodeWav } from '../../../src/audio/wav.js';
import { renderEarcon } from '../../../src/wake/earcons.js';
import { tick, waitFor } from './helpers.js';

const RATE = 48000;

/** Fake getUserMedia + AudioContext using the ScriptProcessor path (no AudioWorklet in Node). */
function fakeAudio() {
  const env = { processor: null, closed: 0, gumCalls: 0, stopped: 0 };
  const node = () => ({ connect() {}, disconnect() {} });
  // a track per getUserMedia() (a reopen gets a new one); events for mute/unmute/ended
  const newTrack = () => {
    const listeners = {};
    const t = {
      readyState: 'live',
      muted: false,
      label: 'Microphone Array (Realtek(R) Audio)',
      listeners,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type) { for (const fn of listeners[type] || []) fn(); },
      getSettings: () => ({ echoCancellation: env.constraints?.audio?.echoCancellation?.ideal === 'all' ? 'all' : true }),
      stop() { env.stopped++; this.readyState = 'ended'; },
    };
    env.track = t;
    return t;
  };
  let track = newTrack();
  env.getUserMedia = async (c) => {
    env.gumCalls++;
    env.constraints = c;
    if (track.readyState !== 'live') track = newTrack();
    const tr = track;
    return { getAudioTracks: () => [tr], getTracks: () => [tr] };
  };
  env.createContext = () => ({
    sampleRate: RATE,
    state: 'running',
    destination: {},
    resume: async () => {},
    close() { env.closed++; },
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createScriptProcessor: () => {
      const sp = { ...node(), onaudioprocess: null };
      env.processor = sp;
      return sp;
    },
  });
  /** push seconds of audio produced by `fn(t)` in 2048-sample blocks */
  env.feed = (seconds, fn) => {
    const n = Math.round(seconds * RATE);
    for (let off = 0; off < n; off += 2048) {
      const block = new Float32Array(Math.min(2048, n - off));
      for (let i = 0; i < block.length; i++) block[i] = fn((off + i) / RATE);
      env.processor.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
    }
  };
  return env;
}

const silence = () => 0.0005 * Math.sin(12345 * Math.random());
/** speech-like: a 200 Hz tone with a 4 Hz syllable envelope */
const speech = (t) => 0.3 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 200 * t);

describe('Mic', () => {
  it('asks for echo cancellation / noise suppression / AGC and releases the device on close', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    await mic.start('ptt');
    expect(env.constraints.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(env.constraints.video).toBe(false);
    mic.close();
    expect(env.stopped).toBe(1);
    expect(env.closed).toBe(1);
  });

  it('push-to-talk: records until stop(), trims silence, returns a 16 kHz PCM16 WAV', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, idleCloseMs: 10 });
    await mic.start('ptt');
    expect(mic.active).toBe(true);
    env.feed(0.8, silence);
    env.feed(1.0, speech);
    env.feed(0.8, silence);
    expect(mic.level).toBeGreaterThan(0);
    const r = await mic.stop();
    expect(r).not.toBeNull();
    const wav = decodeWav(/** @type {any} */ (r).wav);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect(wav.durationSec).toBeGreaterThan(1.0);
    expect(wav.durationSec).toBeLessThan(1.6); // silence trimmed (with padding)
    expect(mic.active).toBe(false);
    await waitFor(() => env.closed === 1, { message: 'device released after idle' });
  });

  it('push-to-talk with nothing said returns null', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    await mic.start('ptt');
    env.feed(1, silence);
    expect(await mic.stop()).toBeNull();
    mic.close();
  });

  it('utterance mode: the VAD ends it and the mic stops by itself', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    const events = [];
    mic.on('speechstart', () => events.push('speechstart'));
    mic.on('utterance', (u) => events.push(['utterance', u.durationMs]));
    await mic.start('utterance');
    env.feed(0.5, silence);
    env.feed(1.0, speech);
    env.feed(1.2, silence);
    expect(events[0]).toBe('speechstart');
    expect(events[1][0]).toBe('utterance');
    expect(events[1][1]).toBeGreaterThan(900);
    expect(mic.active).toBe(false);
    mic.close();
  });

  it('utterance mode gives up without speech', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, noSpeechMs: 30 });
    const discards = [];
    mic.on('discard', (d) => discards.push(d.reason));
    await mic.start('utterance');
    env.feed(0.2, silence);
    await tick(60);
    expect(discards).toEqual(['no-speech']);
    expect(mic.active).toBe(false);
    mic.close();
  });

  it('hands-free: several utterances; input is ignored while paused (half-duplex)', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    let n = 0;
    mic.on('utterance', () => n++);
    await mic.start('handsfree');
    env.feed(0.5, silence);
    env.feed(0.8, speech);
    env.feed(1.0, silence);
    expect(n).toBe(1);
    mic.pause();
    env.feed(0.8, speech); // the avatar talking: must not be heard
    env.feed(1.0, silence);
    expect(n).toBe(1);
    mic.resume();
    env.feed(0.8, speech);
    env.feed(1.0, silence);
    expect(n).toBe(2);
    expect(mic.mode).toBe('handsfree');
    mic.close();
  });

  it('turns getUserMedia errors into actionable messages', async () => {
    const mic = new Mic({ getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }, createContext: fakeAudio().createContext });
    await expect(mic.start('ptt')).rejects.toThrow(/Microphone access was denied/);
    expect(describeMicError({ name: 'NotFoundError' })).toMatch(/No microphone/);
    expect(describeMicError({ name: 'NotReadableError' })).toMatch(/in use/);
  });
});

// ---- "Hey Jade" (contract-wake §9.2, §11.2): the tap, the ring, replay, windows, echo mode ----
describe('Mic: the wake word tap', () => {
  /** a tap that records what it gets */
  const recorder = () => {
    const r = { blocks: [], samples: 0, ats: [] };
    r.fn = (x, info) => {
      r.blocks.push(x);
      r.ats.push(info.at);
      r.samples += x.length;
      expect(Number.isFinite(info.arrivalPerf)).toBe(true);
    };
    return r;
  };

  it('feeds the tap in mode null and while paused; the VAD stays half-duplex (BRG-7)', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    const tap = recorder();
    mic.setTap(tap.fn);
    await mic.open();
    expect(mic.mode).toBeNull();
    env.feed(1.0, silence);
    expect(tap.samples).toBeGreaterThan(15000);
    expect(mic.samplesSeen).toBe(tap.samples);
    // contiguous indices
    for (let i = 1; i < tap.ats.length; i++) expect(tap.ats[i]).toBe(tap.ats[i - 1] + tap.blocks[i - 1].length);
    let n = 0;
    mic.on('utterance', () => n++);
    await mic.start('handsfree');
    mic.pause();
    const before = tap.samples;
    env.feed(0.8, speech);
    env.feed(1.0, silence);
    expect(tap.samples - before).toBeGreaterThan(28000); // the detector heard her speak…
    expect(n).toBe(0); // …the VAD did not
    mic.close();
  });

  it('keeps the device open while tapped (no idle close); close() releases it', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, idleCloseMs: 5 });
    mic.setTap(() => {});
    await mic.start('ptt');
    env.feed(0.3, speech);
    await mic.stop();
    await tick(30);
    expect(env.closed).toBe(0);
    expect(mic.isOpen).toBe(true);
    mic.setTap(null);
    mic.close();
    expect(env.closed).toBe(1);
    expect(env.track.readyState).toBe('ended');
  });

  it('the ring holds the last 3 s; older or future ranges are null', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    mic.setTap(() => {});
    await mic.open();
    env.feed(1.0, silence);
    env.feed(0.5, (t) => 0.25 * Math.sin(2 * Math.PI * 300 * t));
    const end = mic.samplesSeen;
    const last = mic.ring(end - 4000, end);
    expect(last).toHaveLength(4000);
    expect(Math.max(...last.map(Math.abs))).toBeGreaterThan(0.2);
    expect(mic.ring(end - 100, end + 1)).toBeNull(); // not there yet
    env.feed(3.2, silence);
    expect(mic.ring(end - 4000, end)).toBeNull(); // evicted
    expect(mic.ring(mic.samplesSeen - 3 * 16000, mic.samplesSeen)).toHaveLength(48000);
    mic.setTap(null);
    expect(mic.ring(mic.samplesSeen - 10, mic.samplesSeen)).toBeNull(); // dropped with the tap
    mic.close();
  });

  it('release → untapped blocks → tapped again: the ring is wiped and replays nothing from before', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    mic.setTap(() => {});
    await mic.open();
    env.feed(3.0, () => 0.25);
    const s0 = mic.samplesSeen;
    mic.setTap(null);
    expect(Array.from(mic._ring).every((v) => v === 0)).toBe(true); // not just marked old
    await mic.start('ptt'); // push-to-talk keeps the blocks flowing, untapped
    env.feed(1.0, () => 0.5);
    const s1 = mic.samplesSeen;
    mic.setTap(() => {});
    expect(mic.ring(s0, s1)).toBeNull(); // the ring never held that time
    env.feed(0.2, () => 0.75);
    expect(mic.ring(s1, mic.samplesSeen)).toHaveLength(mic.samplesSeen - s1);
    expect(mic.ring(s1 - 10, mic.samplesSeen)).toBeNull();
    mic.close();
  });

  it('start("utterance", { fromSample }) replays the ring from there, then continues live', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    mic.setTap(() => {});
    await mic.open();
    env.feed(1.0, silence);
    const from = mic.samplesSeen; // "…Jade" ends here; the command starts at once
    env.feed(0.6, speech);
    const utts = [];
    mic.on('utterance', (u) => utts.push(u));
    await mic.start('utterance', { fromSample: from });
    env.feed(0.6, speech);
    env.feed(1.2, silence);
    expect(utts).toHaveLength(1);
    // the replayed 0.6 s + the live 0.6 s (+ pre-roll/tail): the floor came from the tapped
    // silence, so speech at the very first sample was still detected
    expect(utts[0].durationMs).toBeGreaterThan(1100);
    expect(utts[0].durationMs).toBeLessThan(1700);
    mic.close();
  });

  it('a fromSample in the future skips the audio before it', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    mic.setTap(() => {});
    await mic.open();
    env.feed(1.0, silence);
    const utts = [];
    mic.on('utterance', (u) => utts.push(u));
    await mic.start('utterance', { fromSample: mic.samplesSeen + 16000 });
    env.feed(0.8, speech); // before fromSample: ignored
    env.feed(0.2, silence);
    env.feed(1.2, silence);
    expect(utts).toHaveLength(0);
    env.feed(0.8, speech);
    env.feed(1.2, silence);
    expect(utts).toHaveLength(1);
    expect(utts[0].durationMs).toBeLessThan(1300);
    mic.close();
  });

  describe('per-start no-speech timeout (onset-based: the follow-up window, FUP-2)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** a 6 s follow-up window, the user starts talking `onsetMs` into it */
    async function window6(onsetMs) {
      const env = fakeAudio();
      const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, now: () => Date.now() });
      mic.setTap(() => {});
      await mic.open();
      env.feed(0.5, silence);
      const events = [];
      mic.on('utterance', () => events.push('utterance'));
      mic.on('discard', (d) => events.push(d.reason));
      await mic.start('utterance', { noSpeechMs: 6000 });
      // silence until the onset (the clock and the audio advance together)
      for (let t = 0; t < onsetMs; t += 100) {
        env.feed(0.1, silence);
        vi.advanceTimersByTime(100);
      }
      for (let t = 0; t < 1000; t += 100) {
        env.feed(0.1, speech);
        vi.advanceTimersByTime(100);
      }
      for (let t = 0; t < 1200; t += 100) {
        env.feed(0.1, silence);
        vi.advanceTimersByTime(100);
      }
      mic.close();
      return events;
    }

    it('speech that starts at 5.9 s is captured, even though it runs past 6 s', async () => {
      expect(await window6(5900)).toEqual(['utterance']);
    });

    it('speech that starts at 6.1 s is too late', async () => {
      expect(await window6(6100)).toEqual(['no-speech']);
    });

    it('Infinity: no timeout (look and talk)', async () => {
      const env = fakeAudio();
      const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, noSpeechMs: 10 });
      const discards = [];
      mic.on('discard', (d) => discards.push(d.reason));
      await mic.start('utterance', { noSpeechMs: Infinity });
      vi.advanceTimersByTime(60_000);
      expect(discards).toEqual([]);
      expect(mic.mode).toBe('utterance');
      mic.close();
    });

    it('a too-short noise does not keep the window open (END-5)', async () => {
      const env = fakeAudio();
      const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, now: () => Date.now() });
      mic.setTap(() => {});
      await mic.open();
      env.feed(0.5, silence);
      const events = [];
      mic.on('discard', (d) => events.push(d.reason));
      await mic.start('utterance', { noSpeechMs: 1000 });
      // a click at 0.9 s: the VAD starts, the deadline passes, then it is discarded as too short
      for (let t = 0; t < 900; t += 100) {
        env.feed(0.1, silence);
        vi.advanceTimersByTime(100);
      }
      env.feed(0.12, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t));
      vi.advanceTimersByTime(120);
      for (let t = 0; t < 1000; t += 100) {
        env.feed(0.1, silence);
        vi.advanceTimersByTime(100);
      }
      expect(events).toEqual(['too-short', 'no-speech']);
      expect(mic.mode).toBeNull();
      mic.close();
    });
  });

  it('ignoreSpeechStartUntil: a VAD start then is not the user speaking', async () => {
    let now = 0;
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext, now: () => now });
    mic.setTap(() => {});
    await mic.open();
    env.feed(0.5, silence);
    let starts = 0;
    mic.on('speechstart', () => starts++);
    const discards = [];
    mic.on('discard', (d) => discards.push(d.reason));
    await mic.start('utterance', { noSpeechMs: 60_000 });
    // the wake earcon reaching the mic 10 dB down while the mask is on (ACK-7)
    const e = renderEarcon('wake', RATE);
    mic.ignoreSpeechStartUntil(1000);
    env.feed(e.length / RATE, (t) => 10 ** (-10 / 20) * (e[Math.round(t * RATE)] || 0));
    expect(starts).toBe(0);
    expect(mic._heard).toBe(false);
    env.feed(1.0, silence);
    expect(discards).toHaveLength(1); // too short (or steady): never an utterance
    expect(mic.mode).toBe('utterance'); // the window is still open, unchanged
    now = 2000;
    env.feed(0.6, speech);
    expect(starts).toBe(1);
    mic.close();
  });

  it("echo mode 'all' asks for { ideal: 'all' }; the track's real setting is readable", async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    expect(mic.echoMode).toBe('app');
    mic.setEchoMode('all');
    mic.setTap(() => {});
    await mic.open();
    expect(env.constraints.audio.echoCancellation).toEqual({ ideal: 'all' });
    expect(env.constraints.audio).toMatchObject({ noiseSuppression: true, autoGainControl: true });
    expect(mic.echoCancellation).toBe('all');
    expect(mic.trackLabel).toMatch(/Realtek/);
    // back to the app's own output: reopened at once when idle
    mic.setEchoMode('app');
    await waitFor(() => env.gumCalls === 2);
    expect(env.constraints.audio.echoCancellation).toBe(true);
    mic.close();
  });

  it('track mute/unmute → "mute" events; a track that ends while tapped → "lost", and a reopen leaves a gap', async () => {
    const env = fakeAudio();
    const mic = new Mic({ getUserMedia: env.getUserMedia, createContext: env.createContext });
    const tap = recorder();
    mic.setTap(tap.fn);
    await mic.open();
    const mutes = [];
    const lost = [];
    const errors = [];
    mic.on('mute', (m) => mutes.push(m.muted));
    mic.on('lost', (l) => lost.push(l.reason));
    mic.on('error', (e) => errors.push(e.message));
    env.track.muted = true;
    env.track.dispatch('mute');
    expect(mic.muted).toBe(true);
    env.track.dispatch('unmute');
    expect(mutes).toEqual([true, false]);
    env.feed(0.2, silence);
    const seen = mic.samplesSeen;
    env.track.dispatch('ended');
    expect(lost).toEqual(['ended']);
    expect(errors).toEqual([]); // no capture was running: nothing to report to the user
    expect(mic.tapped).toBe(true);
    await mic.open();
    env.feed(0.2, silence);
    expect(tap.ats[tap.ats.length - 1]).toBeGreaterThanOrEqual(seen + 16000);
    mic.close();
  });
});
// ---- end "Hey Jade" ----
