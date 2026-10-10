// The mock bridge's "Hey Jade" (contract-wake §9.8): bridge.wake like main's (electron/wake/),
// with a pretend wake-word engine in the page.
//
// requestPort() posts one end of a MessageChannel to the window exactly like the preload does
// ({ type: 'lm:wake:port', gen } + the port); the other end is the mock spotter. It speaks the
// real port protocol (src/wake/port.js): it counts the 16 kHz frames it gets, finds energy
// onsets, and fires a hit when told to:
//   window.__wakeMock.arm({ keyword = 'HEY_JADE', afterOnsetMs = 700, latencyMs = 300 })
//       fires once, afterOnsetMs after the next onset; the keyword "ends" latencyMs before that
//   window.__wakeMock.hit(o)       fires now (o: keyword, latencyMs, durMs)
//   window.__wakeMock.frames / samples / onsets / hits / resets / strict   counters
//   window.__wakeMock.power('locked' | 'unlocked' | 'suspended' | 'resumed')
// ?wakeMock=auto arms a HEY_JADE on every onset (demos). Scenarios (?wake=): missing | error
// (the engine), basic (the extra model is downloading), blocked (Windows blocks the mic).

const ONSET = Object.freeze({ frame: 320, quietMs: 600, loudFrames: 3, marginDb: 12, minDb: -50 });

/**
 * @param {object} o
 * @param {string} [o.scenario]
 * @param {string} [o.mode]           'auto' arms on every onset
 * @param {() => any} o.getSettings
 * @param {(entry: any[]) => void} [o.record]   the mock's calls log
 * @param {any} [o.win]
 */
export function createMockWake(o) {
  const win = o.win ?? globalThis.window;
  const record = o.record || (() => {});
  const scenario = String(o.scenario || '');
  /** @type {Record<string, Set<Function>>} */
  const listeners = { status: new Set(), power: new Set() };
  const deliver = (/** @type {'status'|'power'} */ kind, /** @type {any} */ payload) => {
    for (const cb of [...listeners[kind]]) {
      try {
        cb(JSON.parse(JSON.stringify(payload)));
      } catch (err) {
        console.error(`[mock] wake ${kind} listener threw`, err);
      }
    }
  };
  const subscribe = (/** @type {'status'|'power'} */ kind, /** @type {Function} */ cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    listeners[kind].add(cb);
    return () => listeners[kind].delete(cb);
  };

  // ---------------------------------------------------------------- the engine's status
  let engine = 'off';
  let restarts = 0;
  let gen = 0;
  let startTimer = 0;
  const status = () => {
    const enabled = !!o.getSettings()?.wake?.enabled;
    const e = !enabled ? 'off' : scenario === 'missing' ? 'missing' : scenario === 'error' ? 'error' : engine === 'off' ? 'starting' : engine;
    const detail = e === 'missing' ? 'The wake-word engine is not installed; reinstall Lawnmower Man'
      : e === 'error' ? 'The wake-word engine keeps stopping; see the log'
        : e === 'starting' ? 'The wake-word engine is starting' : e === 'ready' ? 'Listening for “Hey Jade” (mock engine)' : 'Off';
    return {
      engine: e,
      detail,
      models: { giga: 'ok', zhen: scenario === 'basic' ? 'downloading' : 'ok', vad: 'ok' },
      version: '1.13.8',
      platform: 'browser',
      restarts,
      portGen: gen,
      ...(e === 'ready' ? { loadMs: 120, cpuMsPerSecSpeech: 0 } : {}),
    };
  };
  const emitStatus = () => deliver('status', status());
  /** settings changed (from the mock's settings.set) @param {any} prev @param {any} next */
  const settingsChanged = (prev, next) => {
    const was = !!prev?.wake?.enabled;
    const now = !!next?.wake?.enabled;
    if (was === now) return;
    clearTimeout(startTimer);
    if (!now) {
      engine = 'off';
      closePort();
      emitStatus();
      return;
    }
    engine = 'starting';
    emitStatus();
    // like main: the utility loads its models, then says ready
    startTimer = /** @type {any} */ (setTimeout(() => {
      if (!o.getSettings()?.wake?.enabled) return;
      engine = 'ready';
      emitStatus();
    }, 120));
  };
  if (o.getSettings()?.wake?.enabled) engine = 'ready';

  // ---------------------------------------------------------------- the spotter
  const hooks = {
    frames: 0,
    samples: 0,
    onsets: 0,
    hits: 0,
    resets: 0,
    strict: false,
    badFrames: 0,
    gen: 0,
    /** onset sample indices (most recent last) */
    onsetAt: /** @type {number[]} */ ([]),
    /** @type {Array<{ keyword: string, afterOnsetMs: number, latencyMs: number }>} */
    armed: [],
    auto: o.mode === 'auto',
    /** @param {{ keyword?: string, afterOnsetMs?: number, latencyMs?: number }} [a] */
    arm(a = {}) {
      hooks.armed.push({ keyword: a.keyword || 'HEY_JADE', afterOnsetMs: a.afterOnsetMs ?? 700, latencyMs: a.latencyMs ?? 300 });
    },
    /** @param {{ keyword?: string, latencyMs?: number, durMs?: number }} [a] */
    hit(a = {}) {
      const endAt = Math.max(0, sp.end - Math.round(((a.latencyMs ?? 300) / 1000) * 16000));
      const startAt = Math.max(0, endAt - Math.round(((a.durMs ?? 500) / 1000) * 16000));
      fire({ keyword: a.keyword || 'HEY_JADE', streamAt: Math.max(0, startAt - 6400), startAt, endAt });
    },
    /** @param {string} state */
    power(state) {
      record(['wake.power', state]);
      deliver('power', { state });
    },
    /** a pretend utility restart: a new port (like main after a crash) */
    restart() {
      restarts++;
      openPort();
      emitStatus();
    },
    status,
    emitStatus,
  };

  /** the spotter's view of the stream */
  const sp = {
    /** @type {MessagePort|null} */
    port: null,
    end: 0,
    part: new Float32Array(ONSET.frame),
    n: 0,
    partAt: 0,
    floor: -70,
    quiet: Infinity,
    loud: 0,
    loudAt: 0,
    /** @type {Array<{ at: number, keyword: string, latencyMs: number }>} */
    pending: [],
    ids: 0,
  };

  const fire = (/** @type {{ keyword: string, streamAt: number, startAt: number, endAt: number }} */ h) => {
    if (!sp.port) return;
    hooks.hits++;
    sp.port.postMessage({ t: 'hit', id: `mock-${++sp.ids}`, keyword: h.keyword, model: 'giga', streamAt: h.streamAt, startAt: h.startAt, endAt: h.endAt });
  };

  /** 20 ms frames: an onset is ≥ 60 ms loud after ≥ 600 ms quiet (the utility's VAD + onset recipe, simplified) */
  const frame = (/** @type {Float32Array} */ f, /** @type {number} */ at) => {
    let acc = 0;
    for (let i = 0; i < f.length; i++) acc += f[i] * f[i];
    const db = 10 * Math.log10(acc / f.length + 1e-12);
    const loud = db > Math.max(ONSET.minDb, sp.floor + ONSET.marginDb);
    if (!loud) {
      sp.floor += (db - sp.floor) * (db < sp.floor ? 0.3 : 0.02);
      sp.quiet += 20;
      sp.loud = 0;
      return;
    }
    if (sp.loud === 0) sp.loudAt = at;
    sp.loud++;
    if (sp.loud === ONSET.loudFrames && sp.quiet >= ONSET.quietMs) {
      hooks.onsets++;
      hooks.onsetAt.push(sp.loudAt);
      if (hooks.onsetAt.length > 50) hooks.onsetAt.shift();
      const a = hooks.armed.shift() || (hooks.auto ? { keyword: 'HEY_JADE', afterOnsetMs: 700, latencyMs: 300 } : null);
      if (a) sp.pending.push({ at: sp.loudAt + Math.round((a.afterOnsetMs / 1000) * 16000), keyword: a.keyword, latencyMs: a.latencyMs, onset: sp.loudAt });
    }
    if (sp.loud >= ONSET.loudFrames) sp.quiet = 0;
  };

  const onPcm = (/** @type {any} */ m) => {
    const pcm = m.pcm;
    if (!(pcm instanceof Float32Array) || pcm.length < 1 || pcm.length > 4096 || !Number.isFinite(m.at) || m.at < sp.end) {
      hooks.badFrames++;
      sp.port?.postMessage({ t: 'error', message: 'bad frame' });
      return;
    }
    if (m.at !== sp.end) {
      // a gap (the mic was reopened): the onset state starts over
      sp.n = 0;
      sp.quiet = Infinity;
      sp.loud = 0;
    }
    hooks.frames++;
    hooks.samples += pcm.length;
    for (let i = 0; i < pcm.length; i++) {
      if (sp.n === 0) sp.partAt = m.at + i;
      sp.part[sp.n++] = pcm[i];
      if (sp.n === ONSET.frame) {
        frame(sp.part, sp.partAt);
        sp.n = 0;
      }
    }
    sp.end = m.at + pcm.length;
    // armed hits whose time has come
    for (let i = 0; i < sp.pending.length; i++) {
      const p = sp.pending[i];
      if (sp.end < p.at) continue;
      sp.pending.splice(i--, 1);
      const endAt = Math.max(p.onset + 3200, p.at - Math.round((p.latencyMs / 1000) * 16000));
      fire({ keyword: p.keyword, streamAt: Math.max(0, p.onset - 6400), startAt: p.onset, endAt });
    }
  };

  const onMessage = (/** @type {any} */ m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'pcm') onPcm(m);
    else if (m.t === 'ping') sp.port?.postMessage({ t: 'pong', n: m.n });
    else if (m.t === 'reset') {
      hooks.resets++;
      sp.pending = [];
    } else if (m.t === 'strict') hooks.strict = !!m.on;
  };

  const closePort = () => {
    try { sp.port?.close(); } catch { /* ignore */ }
    sp.port = null;
  };

  const openPort = () => {
    const MC = globalThis.MessageChannel;
    if (typeof MC !== 'function' || !win?.postMessage) return 0;
    closePort();
    const ch = new MC();
    gen++;
    hooks.gen = gen;
    sp.port = ch.port2;
    sp.port.onmessage = (/** @type {MessageEvent} */ e) => onMessage(e.data);
    sp.port.start?.();
    sp.port.postMessage({ t: 'ready', models: scenario === 'basic' ? ['giga'] : ['zhen', 'giga'], gen });
    win.postMessage({ type: 'lm:wake:port', gen }, '*', [ch.port1]);
    return gen;
  };

  // ---------------------------------------------------------------- bridge.wake
  /** @type {any} */
  let lastReport = null;
  const api = {
    status: async () => status(),
    onStatus: (/** @type {Function} */ cb) => subscribe('status', cb),
    async requestPort() {
      const st = status();
      if (st.engine !== 'ready') return { ok: false, gen };
      return { ok: true, gen: openPort() };
    },
    /** @param {{ state: string, reason?: string }} st */
    report(st) {
      lastReport = st && typeof st === 'object' ? { state: String(st.state), ...(st.reason ? { reason: String(st.reason).slice(0, 120) } : {}) } : null;
      record(['wake.report', lastReport]);
    },
    onPower: (/** @type {Function} */ cb) => subscribe('power', cb),
    micAccess: async () => (scenario === 'blocked' ? 'denied' : 'granted'),
    async openMicSettings() {
      record(['wake.openMicSettings']);
      return { ok: false };
    },
    /** @param {{ wav: ArrayBuffer, hits: any[] }} c */
    async saveClip(c) {
      const err = checkClip(c);
      record(['wake.saveClip', err ? { error: err } : { bytes: c.wav.byteLength, hits: c.hits.length }]);
      if (err) return { ok: false, error: err };
      return { ok: true, path: 'Documents/Lawnmower Man/Hey Jade tests/mock.wav' };
    },
    async download() {
      record(['wake.download']);
      return { ok: true, started: scenario === 'basic' };
    },
  };
  // (a getter: Object.assign would copy today's value once)
  Object.defineProperty(hooks, 'lastReport', { get: () => lastReport, enumerable: true });
  if (win) win.__wakeMock = hooks;
  return {
    api,
    hooks,
    settingsChanged,
    dispose: () => {
      clearTimeout(startTimer);
      closePort();
    },
  };
}

/**
 * Like main's clips.js: a RIFF/WAVE PCM16 mono 16 kHz file of ≤ 60 s, ≤ 200 hits.
 * @param {any} c @returns {string} '' when fine
 */
export function checkClip(c) {
  if (!c || typeof c !== 'object' || !(c.wav instanceof ArrayBuffer)) return 'wav must be an ArrayBuffer';
  if (!Array.isArray(c.hits) || c.hits.length > 200) return 'hits must be a list of at most 200';
  // as electron/wake/validate.js validateSaveClip
  for (const h of c.hits) {
    if (!h || typeof h !== 'object' || !Number.isFinite(h.atSec) || h.atSec < 0 || h.atSec > 65) return 'hit.atSec must be a time inside the clip';
    if (!['HEY_JADE', 'HEY_JUDE', 'JADE'].includes(h.keyword)) return 'hit.keyword must be HEY_JADE, HEY_JUDE or JADE';
    if (typeof h.outcome !== 'string' || !/^[a-z][a-z0-9 '_:-]{0,39}$/i.test(h.outcome)) return 'hit.outcome must be a short word';
  }
  const v = new DataView(c.wav);
  if (c.wav.byteLength < 44) return 'not a WAV file';
  const tag = (/** @type {number} */ o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 'not a WAV file';
  if (v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== 16000 || v.getUint16(34, true) !== 16) return 'must be PCM16 mono 16 kHz';
  if (c.wav.byteLength - 44 > 60 * 16000 * 2) return 'longer than 60 s';
  return '';
}
