import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer, FX_WAIT_MS, toAudioBuffer } from '../../../src/audio/player.js';
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
    // with the samples for the effect: a caller's array is copied, never handed over
    const own = new Float32Array(480).fill(0.1);
    const r = toAudioBuffer(/** @type {any} */ (ctx), { kind: 'audio', samples: own, sampleRate: 48000 }, true);
    expect(r.samples).not.toBe(own);
    expect(Array.from(r.samples)).toEqual(Array.from(own));
  });
});

// ---------------------------------------------------------------------------------------------
// The voice character effect in the playback graph

/**
 * Fake AudioContext that records the graph, with a fake AudioWorklet. `addModule` resolves
 * after `loadMs` (or never with Infinity, or rejects with `fail`).
 */
function graphContext(o = {}) {
  const edges = [];
  const env = { edges, posts: [], modules: [], nodes: [], time: 0, started: 0 };
  let id = 0;
  const node = (kind, extra = {}) => {
    const n = {
      kind, id: ++id, ...extra,
      connect(dest) { edges.push([n, dest]); return dest; },
      disconnect(dest) {
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === n && (dest === undefined || edges[i][1] === dest)) edges.splice(i, 1);
      },
    };
    env.nodes.push(n);
    return n;
  };
  const destination = node('destination');
  const ctx = {
    sampleRate: 48000,
    state: 'running',
    get currentTime() { return env.time; },
    destination,
    outputLatency: 0,
    baseLatency: 0,
    resume: async () => {},
    close() {},
    createAnalyser: () => node('analyser', { fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData(a) { a.fill(0.1); }, getFloatFrequencyData(a) { a.fill(-40); } }),
    createGain: () => node('gain', { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createBuffer: (ch, n, rate) => ({ duration: n / rate, length: n, sampleRate: rate, data: null, copyToChannel(d) { this.data = new Float32Array(d); } }),
    createBufferSource() {
      const src = node('source', {
        buffer: null,
        onended: null,
        start() {
          env.started++;
          src.timer = setTimeout(() => src.onended?.(), (src.buffer.duration * 1000) / 10);
        },
        stop() { clearTimeout(src.timer); },
      });
      return src;
    },
  };
  if (o.worklet !== false) {
    ctx.audioWorklet = {
      addModule(url) {
        env.modules.push(url);
        if (o.fail) return Promise.reject(new Error(o.fail));
        if (o.loadMs === Infinity) return new Promise(() => {});
        return new Promise((r) => setTimeout(r, o.loadMs ?? 0));
      },
    };
  }
  /** what a node is connected to */
  const targets = (n) => edges.filter((e) => e[0] === n).map((e) => e[1]);
  return { ctx, env, targets };
}

class FakeWorkletNode {
  constructor(ctx, name, options) {
    this.kind = 'fx';
    this.name = name;
    this.options = options;
    this.ctx = ctx;
    this.posted = [];
    this.port = {
      onmessage: null,
      postMessage: (m, transfer) => {
        this.posted.push({ m, transfer });
        if (m.type === 'stats') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stats', id: m.id, character: 'robot', blocks: 3 } }));
      },
    };
    this.onprocessorerror = null;
    FakeWorkletNode.last = this;
  }

  connect(dest) { FakeWorkletNode.edges?.push([this, dest]); return dest; }
  disconnect() { if (FakeWorkletNode.edges) for (let i = FakeWorkletNode.edges.length - 1; i >= 0; i--) if (FakeWorkletNode.edges[i][0] === this) FakeWorkletNode.edges.splice(i, 1); }
}

describe('AudioPlayer voice character', () => {
  /** @type {any} */
  let saved;
  beforeEach(() => {
    saved = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = FakeWorkletNode;
    FakeWorkletNode.last = null;
  });
  afterEach(() => {
    globalThis.AudioWorkletNode = saved;
    FakeWorkletNode.edges = null;
  });
  const make = (o = {}, voiceFx = { character: 'synth', amount: 0.6 }) => {
    const g = graphContext(o);
    FakeWorkletNode.edges = g.env.edges;
    const p = new AudioPlayer({ createContext: () => /** @type {any} */ (g.ctx), voiceFx, fxModuleUrl: 'app://lawnmower/assets/voicefx-worklet.js' });
    return { p, ...g };
  };
  const sourceGain = (g) => {
    const src = g.env.nodes.filter((n) => n.kind === 'source').pop();
    return g.targets(src)[0];
  };

  it('loads the effect once, on the audio thread, when a character is chosen', async () => {
    const g = make();
    expect(g.p.voiceFx).toMatchObject({ character: 'synth', amount: 0.6, state: 'loading', active: false });
    g.p.setVoiceFx({ character: 'robot' });
    await waitFor(() => g.p.fxState === 'ready');
    expect(g.env.modules).toEqual(['app://lawnmower/assets/voicefx-worklet.js']);
    const fx = FakeWorkletNode.last;
    expect(fx.name).toBe('lawnmower-voicefx');
    expect(fx.options).toMatchObject({ numberOfInputs: 1, outputChannelCount: [1], channelCount: 1, processorOptions: { character: 'robot', amount: 0.6 } });
    expect(g.targets(fx)).toEqual([g.ctx.destination]);
    expect(g.p.voiceFx).toEqual({ character: 'robot', amount: 0.6, state: 'ready', active: true });
    // changes go to the processor (it ramps them)
    g.p.setVoiceFx({ amount: 0.9 });
    expect(fx.posted.at(-1).m).toEqual({ type: 'set', character: 'robot', amount: 0.9 });
  });

  it('a natural player loads nothing', async () => {
    const g = make({}, { character: 'natural', amount: 0.6 });
    await g.p.enqueue(clip(0.05, 'a'));
    expect(g.env.modules).toEqual([]);
    expect(g.p.voiceFx).toMatchObject({ state: 'off', active: false });
  });

  it('the analyser hears the dry clip; the effect gets it too and plays it; current.buffer is the dry buffer', async () => {
    const g = make();
    await waitFor(() => g.p.fxState === 'ready');
    const done = g.p.enqueue(clip(0.2, 'hello'));
    const gain = sourceGain(g);
    expect(gain.kind).toBe('gain');
    const outs = g.targets(gain);
    expect(outs).toContain(g.p.analyser);
    expect(outs).toContain(FakeWorkletNode.last);
    expect(outs).not.toContain(g.ctx.destination); // the dry voice is not heard next to the processed one
    // the analyser is a muted tap
    const [mute] = g.targets(g.p.analyser);
    expect(mute.gain.value).toBe(0);
    expect(g.targets(mute)).toEqual([g.ctx.destination]);
    // the dry buffer for other consumers (prosody analysis)
    const cur = g.p.current;
    expect(cur.buffer.sampleRate).toBe(24000);
    expect(cur.buffer.data[100]).toBeCloseTo(0.2, 3);
    // the clip went to the effect for its look-ahead pitch analysis, scheduled at the start time
    const post = FakeWorkletNode.last.posted.find((x) => x.m.type === 'clip');
    expect(post.m.rate).toBe(24000);
    expect(post.m.samples.length).toBe(Math.round(24000 * 0.2));
    expect(post.m.startTime).toBeCloseTo(0.01, 6);
    expect(post.transfer).toEqual([post.m.samples.buffer]);
    // the level and spectrum still read the (dry) analyser
    expect(g.p.level()).toBeCloseTo(0.1, 5);
    expect(await done).toEqual({ stopped: false });
  });

  it("'natural' bypasses the effect: the clip goes straight to the speakers", async () => {
    const g = make();
    await waitFor(() => g.p.fxState === 'ready');
    g.p.setVoiceFx({ character: 'natural' });
    expect(g.p.voiceFx.active).toBe(false);
    g.p.enqueue(clip(0.1, 'plain'));
    const outs = g.targets(sourceGain(g));
    expect(outs).toEqual(expect.arrayContaining([g.p.analyser, g.ctx.destination]));
    expect(outs).not.toContain(FakeWorkletNode.last);
    expect(FakeWorkletNode.last.posted.some((x) => x.m.type === 'clip')).toBe(false);
  });

  it('a clip ends when the dry clip ends (the tail rings out in the shared effect node)', async () => {
    const g = make();
    await waitFor(() => g.p.fxState === 'ready');
    const t0 = Date.now();
    const ends = [];
    g.p.on('end', (c) => ends.push(c.text));
    await g.p.enqueue(clip(0.3, 'a'));
    // the fake source ends after duration/10: 30 ms, not 30 ms + a tail
    expect(Date.now() - t0).toBeLessThan(200);
    expect(ends).toEqual(['a']);
    // the effect node stays connected for the tail
    expect(g.targets(FakeWorkletNode.last)).toEqual([g.ctx.destination]);
  });

  it('the first clip waits for the effect to load, but never longer than FX_WAIT_MS', async () => {
    // loads in 5 ms: the first clip already goes through it
    const fast = make({ loadMs: 5 });
    const a = fast.p.enqueue(clip(0.05, 'a'));
    expect(fast.p.busy).toBe(true);
    expect(fast.env.started).toBe(0);
    await waitFor(() => fast.env.started === 1);
    expect(g2targets(fast)).toContain(FakeWorkletNode.last);
    await a;
    // never loads: the clip starts unprocessed after FX_WAIT_MS
    const slow = make({ loadMs: Infinity });
    const t0 = Date.now();
    const b = slow.p.enqueue(clip(0.05, 'b'));
    await waitFor(() => slow.env.started === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FX_WAIT_MS - 5);
    expect(Date.now() - t0).toBeLessThan(FX_WAIT_MS + 150);
    expect(g2targets(slow)).toContain(slow.ctx.destination);
    expect(await b).toEqual({ stopped: false });
    // stopped while waiting: resolved as stopped, nothing plays
    const stopped = make({ loadMs: Infinity });
    const c = stopped.p.enqueue(clip(0.05, 'c'));
    stopped.p.stop();
    expect(await c).toEqual({ stopped: true });
    expect(stopped.p.busy).toBe(false);
    await tick(FX_WAIT_MS + 20);
    expect(stopped.env.started).toBe(0);
  });

  it('without AudioWorklet (or when it fails to load) the voice plays unprocessed, with one warning', async () => {
    const none = make({ worklet: false });
    expect(none.p.fxState).toBe('unavailable');
    const a = none.p.enqueue(clip(0.05, 'a'));
    expect(g2targets(none)).toContain(none.ctx.destination);
    await a;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = make({ fail: 'blocked by CSP' });
    await waitFor(() => broken.p.fxState === 'unavailable');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/blocked by CSP/);
    const errors = [];
    broken.p.on('error', (e) => errors.push(e));
    const b = broken.p.enqueue(clip(0.05, 'b'));
    expect(g2targets(broken)).toContain(broken.ctx.destination);
    expect(await b).toEqual({ stopped: false });
    expect(errors).toEqual([]);
    broken.p.setVoiceFx({ character: 'robot' }); // no retry storm
    expect(broken.env.modules).toHaveLength(1);
    warn.mockRestore();
  });

  it('a processor error re-routes the playing clip around the effect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = make();
    await waitFor(() => g.p.fxState === 'ready');
    g.p.enqueue(clip(1, 'long'));
    const gain = sourceGain(g);
    const fx = FakeWorkletNode.last;
    expect(g.targets(gain)).toContain(fx);
    fx.onprocessorerror();
    expect(g.targets(gain)).toContain(g.ctx.destination);
    expect(g.targets(gain)).not.toContain(fx);
    expect(g.p.voiceFx).toMatchObject({ state: 'unavailable', active: false });
    g.p.stop();
    warn.mockRestore();
  });

  it('fxStats asks the audio thread', async () => {
    const g = make();
    expect(await make({ worklet: false }).p.fxStats()).toBeNull();
    await waitFor(() => g.p.fxState === 'ready');
    expect(await g.p.fxStats()).toMatchObject({ type: 'stats', character: 'robot', blocks: 3 });
  });

  /** where the last clip's gain goes */
  function g2targets(g) {
    return g.targets(sourceGain(g));
  }
});
