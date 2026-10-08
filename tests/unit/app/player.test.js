import { describe, expect, it } from 'vitest';
import { AudioPlayer, toAudioBuffer } from '../../../src/audio/player.js';
import { bytesToBase64, encodeWav } from '../../../src/audio/wav.js';
import { tick, waitFor } from './helpers.js';

/** Fake AudioContext: sources "end" after their buffer duration (scaled down 10×). */
function fakeContext() {
  const env = { started: [], stopped: 0, time: 0 };
  const node = () => ({ connect() {}, disconnect() {} });
  const ctx = {
    sampleRate: 48000,
    state: 'running',
    get currentTime() { return env.time; },
    destination: {},
    outputLatency: 0,
    baseLatency: 0,
    resume: async () => {},
    close() {},
    createAnalyser: () => ({ ...node(), fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData(a) { a.fill(0.1); }, getFloatFrequencyData(a) { a.fill(-40); } }),
    createGain: () => ({ ...node(), gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createBuffer: (ch, n, rate) => ({ duration: n / rate, length: n, sampleRate: rate, data: null, copyToChannel(d) { this.data = d; } }),
    createBufferSource() {
      const src = {
        ...node(),
        buffer: null,
        onended: null,
        start() {
          env.started.push(src.buffer.duration);
          src.timer = setTimeout(() => src.onended?.(), (src.buffer.duration * 1000) / 10);
        },
        stop() { clearTimeout(src.timer); env.stopped++; },
      };
      return src;
    },
  };
  return { ctx, env };
}

const clip = (seconds, text) => ({ kind: 'audio', text, audioB64: bytesToBase64(new Uint8Array(encodeWav(new Float32Array(Math.round(24000 * seconds)).fill(0.2), 24000))), visemes: null });

describe('AudioPlayer', () => {
  it('plays clips strictly in order and emits start/end/idle', async () => {
    const { ctx, env } = fakeContext();
    const p = new AudioPlayer({ createContext: () => /** @type {any} */ (ctx) });
    const events = [];
    p.on('start', (c) => events.push(`start:${c.text}`));
    p.on('end', (c, o) => events.push(`end:${c.text}:${o.stopped}`));
    p.on('idle', () => events.push('idle'));
    const a = p.enqueue(clip(0.3, 'a'));
    const b = p.enqueue(clip(0.1, 'b'));
    expect(p.busy).toBe(true);
    expect(p.current.clip.text).toBe('a');
    expect(p.current.kind).toBe('audio');
    expect(await a).toEqual({ stopped: false });
    expect(await b).toEqual({ stopped: false });
    await waitFor(() => events.includes('idle'));
    expect(events).toEqual(['start:a', 'end:a:false', 'start:b', 'end:b:false', 'idle']);
    expect(env.started.map((d) => Math.round(d * 10) / 10)).toEqual([0.3, 0.1]);
    expect(p.busy).toBe(false);
  });

  it('stop() stops the current clip and flushes the queue', async () => {
    const { ctx, env } = fakeContext();
    const p = new AudioPlayer({ createContext: () => /** @type {any} */ (ctx) });
    const a = p.enqueue(clip(2, 'long'));
    const b = p.enqueue(clip(1, 'next'));
    await tick(5);
    p.stop();
    expect(await a).toEqual({ stopped: true });
    expect(await b).toEqual({ stopped: true });
    expect(env.stopped).toBe(1);
    expect(p.current).toBeNull();
    expect(env.started).toHaveLength(1);
  });

  it('reports level/spectrum only while audio plays; bad clips fail without blocking the queue', async () => {
    const { ctx } = fakeContext();
    const p = new AudioPlayer({ createContext: () => /** @type {any} */ (ctx) });
    expect(p.level()).toBe(0);
    const errors = [];
    p.on('error', (e) => errors.push(e.message));
    const bad = p.enqueue({ kind: 'audio', audioB64: bytesToBase64(new Uint8Array([1, 2, 3])) });
    const good = p.enqueue(clip(0.2, 'ok'));
    expect((await bad).error).toBeInstanceOf(Error);
    await tick(1);
    expect(p.level()).toBeCloseTo(0.1, 5);
    expect(p.spectrum(new Float32Array(1024))).toBe(true);
    expect(await good).toEqual({ stopped: false });
    expect(errors).toEqual(['not a WAV file']);
  });

  it('speech clips go through the Web Speech wrapper, forwarding the start and word boundaries', async () => {
    const spoken = [];
    const speech = {
      speak: async (text, o) => {
        spoken.push([text, o.rate]);
        await tick(2);
        o.onStart?.();
        o.onBoundary?.('hello', { charIndex: 0, charLength: 5 });
        o.onBoundary?.('world');
        await tick(5);
      },
      cancel() {},
    };
    const p = new AudioPlayer({ createContext: () => { throw new Error('no audio'); }, speech });
    const words = [];
    const events = [];
    const clip = { kind: 'speech', text: 'hello world', rate: 1.2 };
    p.on('start', (c) => events.push(['start', c === clip]));
    p.on('speechstart', (c) => events.push(['speechstart', c === clip]));
    p.on('boundary', (e) => words.push(e));
    await p.enqueue(clip);
    expect(spoken).toEqual([['hello world', 1.2]]);
    expect(events).toEqual([['start', true], ['speechstart', true]]);
    expect(words.map((w) => w.word)).toEqual(['hello', 'world']);
    expect(words[0]).toMatchObject({ charIndex: 0, charLength: 5, clip });
    expect(words[1].charIndex).toBeUndefined();
  });

  it('toAudioBuffer accepts raw samples', () => {
    const { ctx } = fakeContext();
    const buf = toAudioBuffer(/** @type {any} */ (ctx), { kind: 'audio', samples: new Float32Array(480), sampleRate: 48000 });
    expect(buf.duration).toBeCloseTo(0.01, 6);
    expect(() => toAudioBuffer(/** @type {any} */ (ctx), { kind: 'audio' })).toThrow(/no audio/);
  });
});
