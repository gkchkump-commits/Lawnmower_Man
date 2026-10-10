// The audio port to the wake-word engine (src/wake/port.js, contract-wake §6.3): what is
// accepted from the preload, what is sent (copies in ≤ 4096-sample frames, never a transfer
// list), what comes back (validated), and the ping that notices a dead utility.
import { describe, expect, it, vi } from 'vitest';
import { MAX_FRAME, MISSED_PINGS, WakePort, parseUtilityMessage } from '../../../src/wake/port.js';

function fakeWin() {
  const handlers = new Set();
  return {
    addEventListener: (type, fn) => type === 'message' && handlers.add(fn),
    removeEventListener: (type, fn) => handlers.delete(fn),
    handlers,
    /** what the preload does: window.postMessage({ type, gen }, '*', [port]) */
    deliver(win, data, ports) {
      for (const fn of handlers) fn({ source: win, data, ports });
    },
  };
}

function fakePort() {
  return {
    sent: [],
    closed: false,
    started: false,
    onmessage: null,
    postMessage(m, transfer) {
      this.sent.push({ m, transfer });
    },
    start() { this.started = true; },
    close() { this.closed = true; },
    /** a message from the utility */
    reply(data) { this.onmessage?.({ data }); },
  };
}

function setup(o = {}) {
  const win = fakeWin();
  let tick = null;
  const requestPort = vi.fn(async () => ({ ok: true }));
  const port = new WakePort({
    bridge: { wake: { requestPort } },
    win,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => { tick = null; },
    ...o,
  });
  port.start();
  return { win, port, requestPort, ping: () => tick?.() };
}

describe('parseUtilityMessage: only well-formed messages of the utility get through', () => {
  it('a hit', () => {
    const h = { t: 'hit', id: 7, keyword: 'HEY_JADE', model: 'zhen', streamAt: 100, startAt: 900, endAt: 9000, extra: 'x' };
    expect(parseUtilityMessage(h)).toEqual({ t: 'hit', id: '7', keyword: 'HEY_JADE', model: 'zhen', streamAt: 100, startAt: 900, endAt: 9000 });
    expect(parseUtilityMessage({ ...h, model: 'other' }).model).toBe('giga');
  });

  it.each([
    ['an unknown keyword', { keyword: 'HEY_JOE' }],
    ['start after end', { startAt: 9001 }],
    ['the stream after the end', { streamAt: 9500 }],
    ['a NaN index', { endAt: Number.NaN }],
    ['a string index', { startAt: '900' }],
    ['no id', { id: '' }],
    ['an object id', { id: {} }],
  ])('a hit with %s is dropped', (_why, patch) => {
    expect(parseUtilityMessage({ t: 'hit', id: 'h1', keyword: 'HEY_JADE', streamAt: 100, startAt: 900, endAt: 9000, ...patch })).toBeNull();
  });

  it('ready, vad, stats, error, pong; anything else is dropped', () => {
    expect(parseUtilityMessage({ t: 'ready', models: ['giga', 'evil', 'zhen'], gen: 3 })).toEqual({ t: 'ready', models: ['giga', 'zhen'], gen: 3 });
    expect(parseUtilityMessage({ t: 'ready' })).toEqual({ t: 'ready', models: [], gen: 0 });
    expect(parseUtilityMessage({ t: 'vad', speaking: true, at: 5 })).toEqual({ t: 'vad', speaking: true, at: 5 });
    expect(parseUtilityMessage({ t: 'vad', speaking: 'yes', at: 5 })).toBeNull();
    expect(parseUtilityMessage({ t: 'stats', fedSec: 10, speechSec: 2, cpuMsPerSecSpeech: 31, bogus: 1, dropped: 'x' })).toEqual({ t: 'stats', fedSec: 10, speechSec: 2, cpuMsPerSecSpeech: 31 });
    expect(parseUtilityMessage({ t: 'error', message: 'x'.repeat(500) }).message).toHaveLength(200);
    expect(parseUtilityMessage({ t: 'pong', n: 4 })).toEqual({ t: 'pong', n: 4 });
    expect(parseUtilityMessage({ t: 'pong' })).toBeNull();
    for (const bad of [null, 1, 'hit', {}, { t: 3 }, { t: 'pcm', pcm: [] }, { t: '__proto__' }]) expect(parseUtilityMessage(bad)).toBeNull();
  });
});

describe('WakePort: the port from the preload', () => {
  it('is taken only from this window and only when newer; an older one is closed at once', () => {
    const { win, port } = setup();
    const ports = [];
    port.on('port', (p) => ports.push(p.gen));
    const a = fakePort();
    win.deliver({}, { type: 'lm:wake:port', gen: 1 }, [a]); // another frame
    expect(port.port).toBeNull();
    win.deliver(win, { type: 'something-else', gen: 1 }, [a]);
    expect(port.port).toBeNull();
    win.deliver(win, { type: 'lm:wake:port', gen: 2 }, [a]);
    expect(port.port).toBe(a);
    expect(a.started).toBe(true);
    const old = fakePort();
    win.deliver(win, { type: 'lm:wake:port', gen: 2 }, [old]);
    expect(old.closed).toBe(true);
    expect(port.port).toBe(a);
    const b = fakePort();
    win.deliver(win, { type: 'lm:wake:port', gen: 3 }, [b]);
    expect(a.closed).toBe(true); // replaced (main sends one after a utility restart)
    expect(port.port).toBe(b);
    expect(ports).toEqual([2, 3]);
    // close() keeps the generation: a stale port is still refused afterwards
    port.close();
    const stale = fakePort();
    win.deliver(win, { type: 'lm:wake:port', gen: 3 }, [stale]);
    expect(stale.closed).toBe(true);
  });

  it('emits what the utility says, validated', () => {
    const { win, port } = setup();
    const p = fakePort();
    win.deliver(win, { type: 'lm:wake:port', gen: 1 }, [p]);
    const hits = [];
    const ready = [];
    port.on('hit', (h) => hits.push(h));
    port.on('ready', (r) => ready.push(r));
    p.reply({ t: 'ready', models: ['giga'], gen: 1 });
    p.reply({ t: 'hit', id: 'h1', keyword: 'HEY_JADE', streamAt: 0, startAt: 100, endAt: 200 });
    p.reply({ t: 'hit', id: 'h2', keyword: 'NOPE', streamAt: 0, startAt: 100, endAt: 200 });
    expect(port.ready).toBe(true);
    expect(ready).toHaveLength(1);
    expect(hits.map((h) => h.id)).toEqual(['h1']);
  });
});

describe('WakePort.post: 16 kHz copies in ≤ 4096-sample frames', () => {
  const open = () => {
    const s = setup();
    const p = fakePort();
    s.win.deliver(s.win, { type: 'lm:wake:port', gen: 1 }, [p]);
    return { ...s, p };
  };

  it('nothing before ready', () => {
    const { port, p } = open();
    expect(port.post(new Float32Array(683), 0)).toBe(false);
    expect(p.sent).toEqual([]);
  });

  it('splits, numbers each frame by its first sample, never transfers', () => {
    const { port, p } = open();
    p.reply({ t: 'ready', models: ['giga'] });
    const x = new Float32Array(MAX_FRAME * 2 + 100).map((_, i) => (i % 1000) / 1000);
    expect(port.post(x, 50_000)).toBe(true);
    expect(p.sent.map((s) => [s.m.t, s.m.at, s.m.pcm.length])).toEqual([
      ['pcm', 50_000, MAX_FRAME],
      ['pcm', 50_000 + MAX_FRAME, MAX_FRAME],
      ['pcm', 50_000 + 2 * MAX_FRAME, 100],
    ]);
    for (const s of p.sent) expect(s.transfer).toBeUndefined();
    // copies: the caller's buffer is intact and not shared
    expect(x.length).toBe(MAX_FRAME * 2 + 100);
    expect(p.sent[1].m.pcm[0]).toBe(x[MAX_FRAME]);
    expect(p.sent[2].m.pcm[99]).toBe(x[2 * MAX_FRAME + 99]);
    expect(p.sent[0].m.pcm.buffer).not.toBe(x.buffer);
    expect(port.sent).toBe(x.length);
  });

  it('indices only go forward (a repeated or older block is dropped)', () => {
    const { port, p } = open();
    p.reply({ t: 'ready' });
    expect(port.post(new Float32Array(683), 1000)).toBe(true);
    expect(port.post(new Float32Array(683), 1000)).toBe(false);
    expect(port.post(new Float32Array(683), 1683)).toBe(true);
    // a gap (the mic was reopened) is fine
    expect(port.post(new Float32Array(683), 50_000)).toBe(true);
    expect(p.sent.map((s) => s.m.at)).toEqual([1000, 1683, 50_000]);
    expect(port.post(new Float32Array(683), Number.NaN)).toBe(false);
  });

  it('values the utility would refuse are mended, not sent (NaN → 0, clamped to ±1.5)', () => {
    const { port, p } = open();
    p.reply({ t: 'ready' });
    const x = Float32Array.from([0.5, Number.NaN, 2, -3, Number.POSITIVE_INFINITY, -0.25]);
    port.post(x, 0);
    expect([...p.sent[0].m.pcm]).toEqual([0.5, 0, 1.5, -1.5, 1.5, -0.25]);
    expect(Number.isNaN(x[1])).toBe(true); // the caller's samples are not touched
  });

  it('reset and strict go to the utility as they are', () => {
    const { port, p } = open();
    port.reset();
    port.strict(true);
    expect(p.sent.map((s) => s.m)).toEqual([{ t: 'reset' }, { t: 'strict', on: true }]);
  });
});

describe('WakePort: a dead utility is noticed by its missing pongs', () => {
  it('three pings without a pong: lost, and a new port is asked for', async () => {
    const { win, port, requestPort, ping } = setup();
    const p = fakePort();
    win.deliver(win, { type: 'lm:wake:port', gen: 1 }, [p]);
    p.reply({ t: 'ready' });
    const lost = [];
    port.on('lost', (x) => lost.push(x));
    for (let i = 0; i < MISSED_PINGS; i++) ping();
    expect(p.sent.map((s) => s.m)).toEqual([{ t: 'ping', n: 1 }, { t: 'ping', n: 2 }, { t: 'ping', n: 3 }]);
    p.reply({ t: 'pong', n: 3 }); // alive after all
    ping();
    expect(lost).toEqual([]);
    for (let i = 0; i < MISSED_PINGS; i++) ping();
    expect(lost).toEqual([{ gen: 1 }]);
    expect(p.closed).toBe(true);
    expect(port.port).toBeNull();
    await Promise.resolve();
    expect(requestPort).toHaveBeenCalledTimes(1);
  });

  it('one port request at a time', async () => {
    let resolve;
    const requestPort = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { port } = setup({ bridge: { wake: { requestPort } } });
    const a = port.request();
    const b = port.request();
    expect(a).toBe(b);
    await Promise.resolve();
    resolve({ ok: true });
    expect(await a).toBe(true);
    expect(requestPort).toHaveBeenCalledTimes(1);
    expect(await setup({ bridge: {} }).port.request()).toBe(false); // no wake namespace (old preload)
  });

  it('dispose stops listening to the window and the timer', () => {
    const { win, port } = setup();
    port.dispose();
    expect(win.handlers.size).toBe(0);
  });
});
