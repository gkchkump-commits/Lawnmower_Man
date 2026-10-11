// "Hey Jade" across the lanes (contract-wake §3.2, §6): the renderer's side (src/wake/, lane B)
// against main's and the utility's real modules (electron/wake/, lane A) and the preload, without
// Electron. Each lane tests its own side against the contract; these tests put the two real sides
// together where they meet: the audio port, the tray state, the test clip, the bridge's surface.
/* global MessageChannel */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { WakePort, parseUtilityMessage, MAX_FRAME } from '../../../src/wake/port.js';
import { WAKE_STATES } from '../../../src/wake/machine.js';
import { encodeWav } from '../../../src/audio/wav.js';
import { createMockWake, checkClip } from '../../../src/bridge/mock-wake.js';
import { DEFAULT_SETTINGS as RENDERER_DEFAULTS } from '../../../src/app/settings-defaults.js';
import { PortSession, checkPcm } from '../../../electron/wake/utility/protocol.js';
import { WAKE_UI_STATES, validateSaveClip, validateUiState } from '../../../electron/wake/validate.js';
import { WAKE_CHANNELS } from '../../../electron/wake/ipc.js';
import { DEFAULT_SETTINGS as MAIN_DEFAULTS } from '../../../electron/settings.js';
import { wakeTrayText } from '../../../electron/tray-menu.js';

const root = path.resolve('.');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A window stand-in for WakePort: the preload's postMessage arrives as a 'message' event. */
function fakeWindow() {
  /** @type {Array<(ev: any) => void>} */
  const listeners = [];
  const win = {
    addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => { if (t === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    /** what electron/preload.cjs does with main's port: window.postMessage({ type, gen }, '*', ports) */
    deliver: (/** @type {any} */ data, /** @type {any[]} */ ports) => { for (const fn of listeners) fn({ source: win, data, ports }); },
  };
  return win;
}

/** The utility's side of one port (electron/wake/utility/main.js does the same with its engine). */
function utilitySide(port, engine, gen) {
  const session = new PortSession({ engine, gen });
  /** @type {any[]} */
  const received = [];
  /** @type {any[]} */
  const replies = [];
  port.on('message', (/** @type {any} */ m) => {
    received.push(m);
    for (const r of session.handle(m)) {
      replies.push(r);
      port.postMessage(r);
    }
  });
  port.postMessage(session.ready());
  return { session, received, replies };
}

describe('"Hey Jade" across the lanes', () => {
  it('the audio port: the renderer\'s frames pass the utility\'s checks, its hits and pongs pass the renderer\'s', async () => {
    const pushed = [];
    let hitOnce = true;
    const engine = {
      models: ['zhen', 'giga'],
      recipe: { speaking: false },
      noteDropped() { pushed.push('dropped'); },
      reset() { pushed.push('reset'); },
      setStrict(on) { pushed.push(`strict:${on}`); },
      /** @param {Float32Array} pcm @param {number} at */
      push(pcm, at) {
        pushed.push([at, pcm.length]);
        this.recipe.speaking = true;
        if (at > 0 && hitOnce) {
          hitOnce = false;
          // as electron/wake/utility/engine.js reports one
          return [{ id: 7, keyword: 'HEY_JADE', model: 'zhen', streamAt: 0, startAt: 3200, endAt: 9600, emitAt: at + pcm.length }];
        }
        return [];
      },
    };
    const win = fakeWindow();
    const bridge = { wake: { requestPort: async () => ({ ok: true, gen: 1 }) } };
    const wp = new WakePort({ bridge, win, setInterval: () => 0, clearInterval: () => {} });
    const events = { ready: [], hit: [], vad: [], error: [], lost: [] };
    for (const k of Object.keys(events)) wp.on(k, (/** @type {any} */ m) => events[k].push(m));
    wp.start();
    const ch = new MessageChannel();
    const u = utilitySide(ch.port2, engine, 1);
    win.deliver({ type: 'lm:wake:port', gen: 1 }, [ch.port1]);
    for (let i = 0; i < 50 && !wp.ready; i++) await tick(5);
    expect(wp.ready).toBe(true);
    expect(wp.models).toEqual(['zhen', 'giga']);
    // 5000 samples with a NaN and an overshoot: split at 4096, mended, contiguous, never transferred
    const x = new Float32Array(5000).fill(0.1);
    x[10] = NaN;
    x[4500] = 2.5;
    expect(wp.post(x, 0)).toBe(true);
    for (let i = 0; i < 50 && events.hit.length === 0; i++) await tick(5);
    expect(u.received.filter((m) => m.t === 'pcm').map((m) => [m.at, m.pcm.length])).toEqual([[0, MAX_FRAME], [MAX_FRAME, 5000 - MAX_FRAME]]);
    expect(u.received.every((m) => m.t !== 'pcm' || m.pcm instanceof Float32Array)).toBe(true);
    expect(u.replies.filter((r) => r.t === 'error')).toEqual([]);
    expect(events.vad).toEqual([{ t: 'vad', speaking: true, at: MAX_FRAME }]);
    expect(events.hit).toEqual([{ t: 'hit', id: '7', keyword: 'HEY_JADE', model: 'zhen', streamAt: 0, startAt: 3200, endAt: 9600 }]);
    // reset / strict / ping reach the engine and come back as the renderer expects
    wp.reset();
    wp.strict(true);
    for (let k = 0; k < 4; k++) {
      wp._ping(); // the 10 s health check
      await tick(10);
    }
    expect(pushed).toEqual(expect.arrayContaining(['reset', 'strict:true']));
    expect(u.replies.filter((r) => r.t === 'pong').length).toBe(4);
    expect(events.lost).toEqual([]); // pongs answered every ping: no reconnect
    // a backward jump is refused by the renderer itself; a gap is fine (a new stream)
    expect(wp.post(new Float32Array(10), 100)).toBe(false);
    expect(wp.post(new Float32Array(10), 20000)).toBe(true);
    await tick(20);
    expect(u.replies.filter((r) => r.t === 'error')).toEqual([]);
    wp.dispose();
    ch.port2.close();
  });

  it('every message the utility can send is one the renderer understands', () => {
    const engine = { models: ['giga', 'name'], recipe: { speaking: false }, noteDropped() {}, reset() {}, setStrict() {}, push: () => [] };
    const s = new PortSession({ engine, gen: 3 });
    const ready = parseUtilityMessage(s.ready());
    expect(ready).toEqual({ t: 'ready', models: ['giga', 'name'], gen: 3 });
    expect(parseUtilityMessage(s.handle({ t: 'ping', n: 9 })[0])).toEqual({ t: 'pong', n: 9 });
    expect(parseUtilityMessage(s.handle({ t: 'nonsense' })[0])).toMatchObject({ t: 'error' });
    // a frame the renderer would never send is refused by the utility (and reported, not thrown)
    expect(checkPcm({ pcm: new Float32Array(MAX_FRAME + 1), at: 0 }, null).ok).toBe(false);
    expect(parseUtilityMessage(s.handle({ t: 'pcm', at: 0, pcm: new Float32Array([NaN]) })[0])).toMatchObject({ t: 'error' });
  });

  it('the listening states and the tray: the renderer\'s states are main\'s, each has a tooltip text', () => {
    expect([...WAKE_STATES].sort()).toEqual([...WAKE_UI_STATES].sort());
    for (const state of WAKE_STATES) {
      // what src/wake/feature.js _report() sends (reason ≤ 120 characters)
      const payload = { state, reason: 'The local voice is off.'.repeat(10).slice(0, 120) };
      expect(validateUiState(payload)).toEqual(payload);
      expect(wakeTrayText({ enabled: state !== 'off', state, reason: payload.reason }), state).toMatch(/\S/);
    }
  });

  it('"Record a test clip": what the renderer sends is what main saves (the WAV and every outcome)', () => {
    // src/wake/feature.js _recFinish(): encodeWav(16 kHz) + hits with 'heard' | 'woke' | 'ignored: <reason>'
    const wav = encodeWav(new Float32Array(30 * 16000).map((_, i) => 0.2 * Math.sin(i / 10)), 16000);
    const hits = ['heard', 'woke', 'ignored: jude', 'ignored: rival', 'ignored: self', 'ignored: system', 'ignored: no-call', 'ignored: empty', 'ignored: echo']
      .map((outcome, i) => ({ atSec: Math.round(i * 3.21 * 100) / 100, keyword: i % 2 ? 'HEY_JUDE' : 'HEY_JADE', outcome }));
    const c = { wav, hits };
    expect(checkClip(c)).toBe(''); // the mock bridge (browser e2e) agrees with main
    const v = validateSaveClip(c);
    expect(v.durationSec).toBe(30);
    expect(v.hits.map((h) => h.outcome)).toEqual(hits.map((h) => h.outcome));
    // 61 s is refused on both sides
    const long = { wav: encodeWav(new Float32Array(61 * 16000), 16000), hits: [] };
    expect(checkClip(long)).not.toBe('');
    expect(() => validateSaveClip(long)).toThrow(/longer than 60 s/);
  });

  it('the bridge: the preload, the mock and main expose the same wake surface and channels', () => {
    const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
    const block = preload.match(/\n {2}wake: \{\n([\s\S]*?)\n {2}\},/)?.[1] || '';
    const preloadKeys = [...block.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]).sort();
    const mock = createMockWake({ getSettings: () => RENDERER_DEFAULTS, win: null });
    expect(Object.keys(mock.api).sort()).toEqual(preloadKeys);
    mock.dispose();
    expect(preloadKeys).toEqual(['download', 'micAccess', 'onPower', 'onStatus', 'openMicSettings', 'report', 'requestPort', 'restart', 'saveClip', 'status'] /* (restart added on purpose) */);
    // every channel the preload names is one electron/wake/ipc.js serves (or main sends)
    const used = new Set([...block.matchAll(/'(lm:wake:[a-z-]+)'/g)].map((m) => m[1]));
    const served = new Set([...WAKE_CHANNELS.invoke, ...WAKE_CHANNELS.send, ...WAKE_CHANNELS.toAvatar]);
    for (const ch of used) expect(served.has(ch), ch).toBe(true);
    expect(preload).toContain("ipcRenderer.on('lm:wake:port'");
    expect(preload).toMatch(/show: \(\) => send\('lm:window:show'\)/);
  });

  it('the settings: the renderer\'s mirror of the wake group is main\'s', () => {
    expect(RENDERER_DEFAULTS.wake).toEqual(MAIN_DEFAULTS.wake);
  });
});
