import { describe, expect, it } from 'vitest';
import { Mic, describeMicError } from '../../../src/audio/mic.js';
import { decodeWav } from '../../../src/audio/wav.js';
import { tick, waitFor } from './helpers.js';

const RATE = 48000;

/** Fake getUserMedia + AudioContext using the ScriptProcessor path (no AudioWorklet in Node). */
function fakeAudio() {
  const env = { processor: null, closed: 0, gumCalls: 0, stopped: 0 };
  const node = () => ({ connect() {}, disconnect() {} });
  const track = { readyState: 'live', addEventListener() {}, stop() { env.stopped++; this.readyState = 'ended'; } };
  env.getUserMedia = async (c) => {
    env.gumCalls++;
    env.constraints = c;
    return { getAudioTracks: () => [track], getTracks: () => [track] };
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
