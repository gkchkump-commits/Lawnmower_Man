// The mock bridge's "Hey Jade" (src/bridge/mock-wake.js): the engine status follows the
// setting, the port is posted like the preload does, and the pretend spotter speaks the real
// protocol (frames counted, onsets found, an armed hit fired, ping/pong, bad frames refused).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../../../src/audio/wav.js';
import { checkClip, createMockWake } from '../../../src/bridge/mock-wake.js';
import { parseUtilityMessage } from '../../../src/wake/port.js';

const RATE = 16000;
// the spotter's replies cross the channel once more after it has read our messages
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 5));
};

function setup(o = {}) {
  let settings = { wake: { enabled: o.enabled ?? true } };
  const calls = [];
  const posted = [];
  const win = { postMessage: (data, origin, ports) => posted.push({ data, origin, port: ports?.[0] }) };
  const w = createMockWake({ scenario: o.scenario, mode: o.mode, getSettings: () => settings, record: (e) => calls.push(e), win });
  return {
    w,
    win,
    calls,
    posted,
    set(next) {
      const prev = settings;
      settings = next;
      w.settingsChanged(prev, next);
    },
  };
}

/** open the port and collect what the spotter says */
async function connect(s) {
  const r = await s.w.api.requestPort();
  expect(r).toMatchObject({ ok: true });
  const { data, port } = s.posted.at(-1);
  expect(data).toEqual({ type: 'lm:wake:port', gen: r.gen });
  const got = [];
  port.onmessage = (e) => got.push(e.data);
  await flush();
  return { port, got };
}

/** n samples of a level (dBFS-ish amplitude) */
const tone = (n, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.3));

let opened = [];
afterEach(() => {
  for (const s of opened) s.w.dispose();
  opened = [];
  vi.useRealTimers();
});

describe('mock wake: the engine status follows the setting', () => {
  it('ready when on at boot, off when turned off, starting then ready when turned on', async () => {
    vi.useFakeTimers();
    const s = setup();
    opened.push(s);
    const seen = [];
    s.w.api.onStatus((st) => seen.push(st.engine));
    expect((await s.w.api.status()).engine).toBe('ready');
    s.set({ wake: { enabled: false } });
    s.set({ wake: { enabled: true } });
    expect(seen).toEqual(['off', 'starting']);
    vi.advanceTimersByTime(130);
    expect(seen).toEqual(['off', 'starting', 'ready']);
  });

  it('scenarios: missing, error, basic (the extra model downloading), blocked (micAccess denied)', async () => {
    for (const [scenario, engine] of [['missing', 'missing'], ['error', 'error'], ['basic', 'ready']]) {
      const s = setup({ scenario });
      opened.push(s);
      expect((await s.w.api.status()).engine).toBe(engine);
    }
    const b = setup({ scenario: 'basic' });
    opened.push(b);
    expect((await b.w.api.status()).models.zhen).toBe('downloading');
    const k = setup({ scenario: 'blocked' });
    opened.push(k);
    expect(await k.w.api.micAccess()).toBe('denied');
    const m = setup({ scenario: 'missing' });
    opened.push(m);
    expect(await m.w.api.requestPort()).toMatchObject({ ok: false });
  });
});

describe('mock wake: the spotter', () => {
  it('ready on connect; pong for ping; reset and strict are recorded', async () => {
    const s = setup();
    opened.push(s);
    const { port, got } = await connect(s);
    expect(parseUtilityMessage(got[0])).toEqual({ t: 'ready', models: ['zhen', 'giga'], gen: 1 });
    port.postMessage({ t: 'ping', n: 7 });
    port.postMessage({ t: 'strict', on: true });
    port.postMessage({ t: 'reset' });
    await flush();
    expect(got.at(-1)).toEqual({ t: 'pong', n: 7 });
    expect(s.w.hooks.strict).toBe(true);
    expect(s.w.hooks.resets).toBe(1);
  });

  it('counts frames, finds an onset after quiet, fires the armed hit about afterOnsetMs later', async () => {
    const s = setup();
    opened.push(s);
    const { port, got } = await connect(s);
    s.w.hooks.arm({ afterOnsetMs: 700, latencyMs: 300 });
    let at = 0;
    const send = (x) => {
      for (let i = 0; i < x.length; i += 683) {
        const pcm = x.slice(i, i + 683);
        port.postMessage({ t: 'pcm', at, pcm });
        at += pcm.length;
      }
    };
    send(tone(RATE, 0.0005)); // 1 s of a quiet room
    send(tone(RATE * 1.2, 0.2)); // "Hey Jade, …"
    await flush();
    expect(s.w.hooks.frames).toBe(Math.ceil(RATE / 683) + Math.ceil((RATE * 1.2) / 683));
    expect(s.w.hooks.samples).toBe(at);
    expect(s.w.hooks.onsets).toBe(1);
    const onset = s.w.hooks.onsetAt[0];
    expect(Math.abs(onset - RATE)).toBeLessThanOrEqual(320);
    const hits = got.map(parseUtilityMessage).filter((m) => m?.t === 'hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ keyword: 'HEY_JADE', startAt: onset });
    expect(hits[0].endAt).toBe(onset + Math.round(0.7 * RATE) - Math.round(0.3 * RATE));
    expect(s.w.hooks.badFrames).toBe(0);
  });

  it('refuses frames that are not 16 kHz Float32 blocks going forward', async () => {
    const s = setup();
    opened.push(s);
    const { port, got } = await connect(s);
    port.postMessage({ t: 'pcm', at: 0, pcm: new Float32Array(683) });
    port.postMessage({ t: 'pcm', at: 0, pcm: new Float32Array(683) }); // backwards
    port.postMessage({ t: 'pcm', at: 683, pcm: [0, 0, 0] }); // not a Float32Array
    port.postMessage({ t: 'pcm', at: 683, pcm: new Float32Array(5000) }); // too long
    port.postMessage({ t: 'pcm', at: 683, pcm: null }); // a transferred buffer arriving as null
    await flush();
    expect(s.w.hooks.frames).toBe(1);
    expect(s.w.hooks.badFrames).toBe(4);
    expect(got.filter((m) => m.t === 'error')).toHaveLength(4);
  });

  it('hit() fires at once, power() is delivered', async () => {
    const s = setup();
    opened.push(s);
    const { got } = await connect(s);
    const power = [];
    s.w.api.onPower((p) => power.push(p.state));
    s.w.hooks.hit({ keyword: 'HEY_JUDE' });
    s.w.hooks.power('locked');
    await flush();
    expect(got.filter((m) => m.t === 'hit').map((m) => m.keyword)).toEqual(['HEY_JUDE']);
    expect(power).toEqual(['locked']);
  });

  it('report() keeps the last state for the tests', () => {
    const s = setup();
    opened.push(s);
    s.w.api.report({ state: 'waiting', reason: 'x'.repeat(300) });
    expect(s.w.hooks.lastReport.state).toBe('waiting');
    expect(s.w.hooks.lastReport.reason).toHaveLength(120);
  });
});

describe('checkClip: like main, a PCM16 mono 16 kHz WAV of at most 60 s', () => {
  it('accepts a test clip, refuses the rest', () => {
    const wav = encodeWav(new Float32Array(RATE * 2), RATE);
    expect(checkClip({ wav, hits: [{ atSec: 1, keyword: 'HEY_JADE', outcome: 'woke' }] })).toBe('');
    expect(checkClip({ wav: new Uint8Array(100), hits: [] })).toMatch(/ArrayBuffer/);
    expect(checkClip({ wav, hits: new Array(201).fill({}) })).toMatch(/200/);
    expect(checkClip({ wav: new ArrayBuffer(40), hits: [] })).toMatch(/not a WAV/);
    expect(checkClip({ wav: encodeWav(new Float32Array(100), 48000), hits: [] })).toMatch(/16 kHz/);
    expect(checkClip({ wav: encodeWav(new Float32Array(RATE * 61), RATE), hits: [] })).toMatch(/60 s/);
  });
});
