// The audio port to the wake-word engine (contract-wake §6.3): renderer ↔ utility, direct.
//
// Main creates a MessageChannelMain per request (bridge.wake.requestPort()) and sends one end to
// the utility process ("Jade wake word"), the other to this window; the preload forwards it with
// window.postMessage({ type: 'lm:wake:port', gen }, '*', ports) because a port cannot cross the
// context bridge. A newer gen replaces (and closes) the old port: main sends one after every
// utility restart.
//
// Out: { t:'pcm', at, pcm } (16 kHz, ≤ 4096 samples, `at` = Mic.samplesSeen index of pcm[0]),
//      { t:'reset' }, { t:'strict', on }, { t:'ping', n } every 10 s.
// In:  { t:'ready', models, gen }, { t:'hit', id, keyword, model, streamAt, startAt, endAt },
//      { t:'vad', speaking, at }, { t:'stats', … }, { t:'error', message }, { t:'pong', n }.
// Never with a transfer list: an ArrayBuffer transferred to a MessagePortMain arrives as null
// (verified, §1.2); plain structured-clone copies arrive intact. Every message from the utility is
// validated here; anything malformed is dropped.

import { Emitter } from '../app/emitter.js';

export const MAX_FRAME = 4096;
export const PING_MS = 10000;
export const MISSED_PINGS = 3;
const KEYWORDS = new Set(['HEY_JADE', 'HEY_JUDE', 'JADE']);
const MODELS = new Set(['zhen', 'giga', 'name']);

const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one message of the utility. @param {any} m
 * @returns {null | Record<string, any>} a clean copy, or null
 */
export function parseUtilityMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'ready': {
      const models = Array.isArray(m.models) ? m.models.filter((x) => MODELS.has(x)) : [];
      return { t: 'ready', models, gen: finite(m.gen) ? m.gen : 0 };
    }
    case 'hit': {
      if (!KEYWORDS.has(m.keyword) || !finite(m.streamAt) || !finite(m.startAt) || !finite(m.endAt)) return null;
      if (m.startAt > m.endAt || m.streamAt > m.endAt || m.endAt < 0) return null;
      const id = typeof m.id === 'string' || finite(m.id) ? String(m.id).slice(0, 64) : '';
      if (!id) return null;
      return { t: 'hit', id, keyword: m.keyword, model: MODELS.has(m.model) ? m.model : 'giga', streamAt: m.streamAt, startAt: m.startAt, endAt: m.endAt };
    }
    case 'vad':
      return typeof m.speaking === 'boolean' && finite(m.at) ? { t: 'vad', speaking: m.speaking, at: m.at } : null;
    case 'stats': {
      /** @type {Record<string, any>} */
      const out = { t: 'stats' };
      for (const k of ['fedSec', 'speechSec', 'cpuMsPerSecSpeech', 'cpuMsPerSecAll', 'streams', 'dropped']) if (finite(m[k])) out[k] = m[k];
      return out;
    }
    case 'error':
      return { t: 'error', message: String(m.message ?? '').slice(0, 200) };
    case 'pong':
      return finite(m.n) ? { t: 'pong', n: m.n } : null;
    default:
      return null;
  }
}

export class WakePort extends Emitter {
  /**
   * @param {object} o
   * @param {any} o.bridge  window.lawnmower (or the mock): wake.requestPort()
   * @param {any} [o.win]   the window the preload posts the port to
   * @param {(fn: () => void, ms: number) => any} [o.setInterval]
   * @param {(id: any) => void} [o.clearInterval]
   */
  constructor(o) {
    super();
    this.bridge = o.bridge;
    this.win = o.win ?? globalThis.window;
    this._setInterval = o.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = o.clearInterval || ((id) => clearInterval(id));
    /** @type {MessagePort|null} */
    this.port = null;
    this.gen = 0;
    this.ready = false;
    this.models = /** @type {string[]} */ ([]);
    this.stats = /** @type {Record<string, number>|null} */ (null);
    this._requesting = null;
    this._pings = 0;
    this._pingN = 0;
    this._timer = 0;
    this._lastAt = -Infinity;
    this.sent = 0;
    this._onWindowMessage = (/** @type {MessageEvent} */ ev) => this._accept(ev);
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this.win?.addEventListener?.('message', this._onWindowMessage);
    this._timer = this._setInterval(() => this._ping(), PING_MS);
  }

  /** Ask main for a (new) port; one request at a time. @returns {Promise<boolean>} */
  request() {
    if (this._requesting) return this._requesting;
    const fn = this.bridge?.wake?.requestPort;
    if (typeof fn !== 'function') return Promise.resolve(false);
    this._requesting = Promise.resolve()
      .then(() => fn.call(this.bridge.wake))
      .then((r) => !!r?.ok, (err) => {
        console.warn('[wake] requestPort failed', err?.message || err);
        return false;
      })
      .finally(() => {
        this._requesting = null;
      });
    return this._requesting;
  }

  /** @param {MessageEvent} ev */
  _accept(ev) {
    const d = ev?.data;
    if (ev?.source !== this.win || !d || d.type !== 'lm:wake:port') return;
    const gen = Number(d.gen);
    const port = ev.ports?.[0];
    if (!port || !Number.isFinite(gen) || gen <= this.gen) {
      try { port?.close?.(); } catch { /* ignore */ }
      return;
    }
    this.close();
    this.gen = gen;
    this.port = port;
    this._pings = 0;
    this._lastAt = -Infinity;
    port.onmessage = (e) => this._onMessage(e.data);
    port.start?.();
    this.emit('port', { gen });
  }

  /** @param {any} raw */
  _onMessage(raw) {
    const m = parseUtilityMessage(raw);
    if (!m) return;
    switch (m.t) {
      case 'ready':
        this.ready = true;
        this.models = m.models;
        this.emit('ready', m);
        break;
      case 'pong':
        this._pings = 0;
        break;
      case 'stats':
        this.stats = m;
        this.emit('stats', m);
        break;
      default:
        this.emit(m.t, m);
    }
  }

  /**
   * Send 16 kHz samples starting at index `at` (copies; never a transfer list).
   * @param {Float32Array} x @param {number} at
   * @returns {boolean} sent
   */
  post(x, at) {
    if (!this.port || !this.ready || !x || !x.length || !Number.isFinite(at)) return false;
    if (at < this._lastAt) return false; // indices only go forward
    for (let i = 0; i < x.length; i += MAX_FRAME) {
      const pcm = x.slice(i, Math.min(x.length, i + MAX_FRAME));
      try {
        this.port.postMessage({ t: 'pcm', at: at + i, pcm });
      } catch (err) {
        console.warn('[wake] the port failed', err?.message || err);
        return false;
      }
    }
    this._lastAt = at + x.length;
    this.sent += x.length;
    return true;
  }

  /** Drop the engine's current streams (a hit was taken, or the mic was muted). */
  reset() {
    this._send({ t: 'reset' });
  }

  /** The media-burst rule: the 'low' thresholds while on. @param {boolean} on */
  strict(on) {
    this._send({ t: 'strict', on: !!on });
  }

  /** @param {object} m */
  _send(m) {
    if (!this.port) return;
    try { this.port.postMessage(m); } catch { /* ignore */ }
  }

  _ping() {
    if (!this.port || !this.ready) return;
    if (this._pings >= MISSED_PINGS) {
      // three pings without a pong: the utility is gone or stuck, ask for a new port
      this.close();
      this.emit('lost', { gen: this.gen });
      this.request();
      return;
    }
    this._pings++;
    this._send({ t: 'ping', n: ++this._pingN });
  }

  /** Close the port (the wake word is off). The gen is kept: only newer ports are accepted. */
  close() {
    try { this.port?.close?.(); } catch { /* ignore */ }
    if (this.port) this.port.onmessage = null;
    this.port = null;
    this.ready = false;
  }

  dispose() {
    this.close();
    this._clearInterval(this._timer);
    this.win?.removeEventListener?.('message', this._onWindowMessage);
    this.removeAllListeners();
  }
}
