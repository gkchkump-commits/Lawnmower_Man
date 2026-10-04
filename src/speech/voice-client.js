// HTTP client for the local voice server (contract §6): faster-whisper STT and Kokoro TTS.
//
// The URL and bearer token come from bridge.voice.info() (the Electron main process starts the
// server on a random loopback port with a random token). Every request has a timeout and can
// be aborted; errors are normalised into VoiceError with a `code` and `retryable` flag.

/* global DOMException */

// sttFirst/ttsFirst: the first request per server while the engine is not known to be loaded
// (see VoiceClient.timeoutFor) — it may include loading, downloading or JIT-compiling the model.
export const VOICE_TIMEOUTS = Object.freeze({ health: 4000, stt: 60000, tts: 30000, voices: 8000, warmup: 240000, sttFirst: 240000, ttsFirst: 90000 });

export class VoiceError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, retryable?: boolean, cause?: unknown }} [o]
   */
  constructor(message, o = {}) {
    super(message);
    this.name = 'VoiceError';
    this.status = o.status ?? 0;
    this.code = o.code || 'error';
    this.retryable = !!o.retryable;
    if (o.cause !== undefined) this.cause = o.cause;
  }
}

/** @param {unknown} err */
export function isAbortError(err) {
  return !!err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError';
}

/**
 * @typedef {object} VoiceInfo  bridge.voice.info()
 * @property {'disabled'|'starting'|'ready'|'error'|'stopped'} status
 * @property {string} [url]
 * @property {string} [token]
 * @property {string} [detail]
 * @property {any} [health]
 */

export class VoiceClient {
  /**
   * @param {object} [deps]
   * @param {typeof fetch} [deps.fetch]
   * @param {Partial<typeof VOICE_TIMEOUTS>} [deps.timeouts]
   */
  constructor(deps = {}) {
    this._fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this.timeouts = { ...VOICE_TIMEOUTS, ...(deps.timeouts || {}) };
    /** @type {VoiceInfo} */
    this.info = { status: 'stopped' };
    /** Engines that answered a request on the current server (their model is loaded). */
    this._warm = { stt: false, tts: false };
  }

  /** @param {VoiceInfo|null|undefined} info */
  configure(info) {
    const prevUrl = this.info.url;
    this.info = info && typeof info === 'object' ? { ...info } : { status: 'stopped' };
    if (this.info.url !== prevUrl) this._warm = { stt: false, tts: false };
  }

  /**
   * Request timeout for an engine. Until it is known to be loaded (from /health, or a request
   * that succeeded on this server) the server may still be loading — or on the first RTX 50-series
   * run JIT-compiling — the model inside this request, so allow the warm-up time.
   * @param {'stt'|'tts'} kind
   */
  timeoutFor(kind) {
    const eng = this.health && this.health[kind];
    const loaded = this._warm[kind] || !!(eng && eng.loaded);
    const first = kind === 'stt' ? this.timeouts.sttFirst : this.timeouts.ttsFirst;
    return loaded ? this.timeouts[kind] : Math.max(this.timeouts[kind], first || 0);
  }

  /** The server is up and we have credentials. */
  get ready() {
    return this.info.status === 'ready' && !!this.info.url && !!this.info.token;
  }

  get health() {
    return this.info.health || null;
  }

  /** @param {{ signal?: AbortSignal }} [o] */
  async getHealth(o = {}) {
    const h = await this._request('/health', { auth: false, timeoutMs: this.timeouts.health, signal: o.signal });
    this.info = { ...this.info, health: h };
    return h;
  }

  /**
   * Speech to text.
   * @param {ArrayBuffer|Blob|Uint8Array} audio WAV file (PCM16 mono)
   * @param {{ language?: string, signal?: AbortSignal }} [o]
   * @returns {Promise<{ text: string, language?: string, durationSec?: number, processingMs?: number }>}
   */
  async transcribe(audio, o = {}) {
    // 'auto' is sent explicitly (the server then detects the language); omitting it would mean
    // "the server's default language"
    const q = o.language ? `?language=${encodeURIComponent(o.language)}` : '';
    const r = await this._request(`/stt${q}`, {
      method: 'POST',
      body: audio,
      headers: { 'Content-Type': 'audio/wav' },
      timeoutMs: this.timeoutFor('stt'),
      signal: o.signal,
    });
    this._warm.stt = true;
    return { ...r, text: typeof r?.text === 'string' ? r.text : '' };
  }

  /**
   * Text to speech.
   * @param {string} text
   * @param {{ voice?: string, speed?: number, signal?: AbortSignal }} [o]
   * @returns {Promise<{ sampleRate: number, audioB64: string, durationSec: number, processingMs?: number, visemes: Array<{start:number,end:number,viseme:string}>|null }>}
   */
  async synthesize(text, o = {}) {
    /** @type {Record<string, any>} */
    const body = { text };
    if (o.voice) body.voice = o.voice;
    if (Number.isFinite(o.speed)) body.speed = o.speed;
    const r = await this._request('/tts', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: this.timeoutFor('tts'),
      signal: o.signal,
    });
    if (!r || typeof r.audioB64 !== 'string' || !r.audioB64) throw new VoiceError('The voice server returned no audio', { code: 'bad_response' });
    this._warm.tts = true;
    return r;
  }

  /** @returns {Promise<Array<{ id: string, name?: string, lang?: string, gender?: string }>>} */
  async voices() {
    const r = await this._request('/voices', { timeoutMs: this.timeouts.voices });
    return Array.isArray(r) ? r.filter((v) => v && typeof v.id === 'string') : [];
  }

  async warmup() {
    return this._request('/warmup', { method: 'POST', timeoutMs: this.timeouts.warmup });
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: any, headers?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, auth?: boolean }} o
   */
  async _request(path, o) {
    const base = this.info.url;
    if (!base) throw new VoiceError('The voice server is not running', { code: 'not_ready' });
    if (o.auth !== false && !this.info.token) throw new VoiceError('The voice server is not ready', { code: 'not_ready' });
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, o.timeoutMs || 15000);
    const onAbort = () => ctrl.abort();
    if (o.signal) {
      if (o.signal.aborted) ctrl.abort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    /** @type {Record<string,string>} */
    const headers = { ...(o.headers || {}) };
    if (o.auth !== false) headers.Authorization = `Bearer ${this.info.token}`;
    let res;
    try {
      res = await this._fetch(`${base.replace(/\/+$/, '')}${path}`, {
        method: o.method || 'GET',
        headers,
        body: o.body,
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (timedOut) throw new VoiceError(`The voice server did not answer in time (${path})`, { code: 'timeout', retryable: true, cause: err });
      if (o.signal?.aborted || isAbortError(err)) throw abortError();
      throw new VoiceError('The voice server is unreachable', { code: 'network', retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener?.('abort', onAbort);
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const msg = (data && typeof data.error === 'string' && data.error) || `Voice server error ${res.status}`;
      throw new VoiceError(msg, { status: res.status, code: (data && data.code) || `http_${res.status}`, retryable: res.status === 503 || res.status >= 500 });
    }
    if (data === null && text) throw new VoiceError('The voice server sent an invalid response', { status: res.status, code: 'bad_response' });
    return data;
  }
}

function abortError() {
  try {
    return new DOMException('The operation was aborted', 'AbortError');
  } catch {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
  }
}
