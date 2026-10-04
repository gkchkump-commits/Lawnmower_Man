// Shared fakes for the renderer-app unit tests.
import { Emitter } from '../../../src/app/emitter.js';

/** Poll until `cond()` is truthy (real timers). */
export async function waitFor(cond, { timeout = 2000, step = 2, message = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Records every call; `addUserMessage` returns incrementing ids. */
export function fakeView() {
  const calls = [];
  let ids = 0;
  const view = new Proxy({}, {
    get(_t, name) {
      if (name === 'calls') return calls;
      if (name === 'of') return (n) => calls.filter((c) => c[0] === n).map((c) => c.slice(1));
      if (name === 'then') return undefined;
      return (...args) => {
        calls.push([name, ...args]);
        if (name === 'addUserMessage') return ++ids;
        return undefined;
      };
    },
  });
  return /** @type {any} */ (view);
}

/** A bridge whose events are emitted by the test. */
export function fakeBridge() {
  const em = new Emitter();
  const calls = [];
  let n = 0;
  const bridge = {
    calls,
    emit: (ev) => em.emit('ev', ev),
    sendImpl: null,
    claude: {
      send: async (text) => {
        calls.push(['send', text]);
        if (bridge.sendImpl) return bridge.sendImpl(text);
        return { turnId: `t${++n}` };
      },
      interrupt: async () => { calls.push(['interrupt']); },
      cancel: async (turnId) => {
        calls.push(['cancel', turnId]);
        // like main: a queued turn is dropped and reported (the test decides when, by default now)
        if (bridge.autoCancel !== false) em.emit('ev', { type: 'turn_cancelled', turnId });
        return { cancelled: true, interrupted: false };
      },
      reset: async () => { calls.push(['reset']); },
      respondPermission: async (id, d) => {
        calls.push(['respondPermission', id, d]);
        if (bridge.rejectPermission) throw new Error('Unknown or expired permission request');
      },
      status: async () => ({ status: 'ready', busy: false, queue: 0 }),
      onEvent: (cb) => em.on('ev', cb),
    },
    voice: { info: async () => ({ status: 'disabled' }), restart: async () => {}, onStatus: () => () => {} },
    settings: { get: async () => ({}), set: async () => ({}), onChange: () => () => {} },
    window: { setIgnoreMouse() {}, setSizePreset() {}, setAlwaysOnTop() {}, minimize() {}, hide() {}, quit() {} },
    onHotkey: () => () => {},
    app: { info: async () => ({ version: 'test' }) },
  };
  return bridge;
}

/** Player: each clip "plays" for `clipMs`. */
export function fakePlayer({ clipMs = 15 } = {}) {
  const p = new Emitter();
  p.played = [];
  p.stops = 0;
  p.queue = [];
  p._cur = null;
  p.enqueue = (clip) => new Promise((resolve) => {
    p.queue.push({ clip, resolve });
    if (!p._cur) next();
  });
  function next() {
    const item = p.queue.shift();
    if (!item) {
      p._cur = null;
      p.emit('idle');
      return;
    }
    p._cur = item;
    p.played.push(item.clip);
    p.emit('start', item.clip);
    item.timer = setTimeout(() => {
      if (p._cur !== item) return;
      p.emit('end', item.clip, { stopped: false });
      item.resolve({ stopped: false });
      p._cur = null;
      next();
    }, clipMs);
  }
  p.stop = () => {
    p.stops++;
    for (const q of p.queue.splice(0)) q.resolve({ stopped: true });
    if (p._cur) {
      clearTimeout(p._cur.timer);
      p._cur.resolve({ stopped: true });
      p._cur = null;
    }
  };
  Object.defineProperty(p, 'current', { get: () => (p._cur ? { clip: p._cur.clip, kind: p._cur.clip.kind || 'audio', time: 0.05 } : null) });
  Object.defineProperty(p, 'busy', { get: () => !!p._cur || p.queue.length > 0 });
  p.level = () => (p._cur ? 0.2 : 0);
  p.spectrum = () => false;
  p.sampleRate = 48000;
  return /** @type {any} */ (p);
}

export function fakeTts({ available = true, delayMs = 1, fail = null } = {}) {
  const tts = {
    texts: [],
    aborted: 0,
    _available: available,
    available: () => tts._available,
    mode: () => (tts._available ? 'server' : 'none'),
    synthesize: (text, { signal } = {}) => new Promise((resolve, reject) => {
      tts.texts.push(text);
      const d = typeof delayMs === 'function' ? delayMs(text) : delayMs;
      const timer = setTimeout(() => {
        if (fail && fail(text)) reject(new Error(`synthesis failed for "${text}"`));
        else resolve({ kind: 'audio', text, visemes: [{ start: 0, end: 0.1, viseme: 'aa' }] });
      }, d);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        tts.aborted++;
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  };
  return tts;
}

export function fakeStt({ text = 'hello there', available = true } = {}) {
  const stt = {
    calls: 0,
    text,
    _available: available,
    available: () => stt._available,
    unavailableReason: () => 'Voice input needs the local voice server.',
    transcribe: async () => {
      stt.calls++;
      await tick(2);
      if (stt.text instanceof Error) throw stt.text;
      return { text: stt.text };
    },
  };
  return stt;
}

export function fakeMic() {
  const m = new Emitter();
  m.mode = null;
  m.paused = false;
  m.level = 0.4;
  m.log = [];
  m.result = { wav: new ArrayBuffer(8), durationMs: 900, speechMs: 700 };
  m.start = async (mode) => { m.log.push(['start', mode]); m.mode = mode; m.paused = false; };
  m.stop = async () => { m.log.push(['stop']); const r = m.mode ? m.result : null; m.mode = null; return r; };
  m.cancel = () => { m.log.push(['cancel']); m.mode = null; };
  m.pause = () => { m.log.push(['pause']); m.paused = true; };
  m.resume = () => { m.log.push(['resume']); m.paused = false; };
  return /** @type {any} */ (m);
}

export function fakeAvatar() {
  const a = { states: [], mouths: [], levels: [], blinks: 0 };
  a.setState = (s) => a.states.push(s);
  a.setMouth = (m) => a.mouths.push(m);
  a.setSpeechLevel = (l) => a.levels.push(l);
  a.blink = () => { a.blinks++; };
  a.lookAt = () => {};
  return a;
}
