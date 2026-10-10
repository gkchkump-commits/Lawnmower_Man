// StreamRelay: main's one consumer of go2rtc's /api/stream.mp4 (contract §8.6). Pure Node.
//
// It runs only while the picture is needed (armed, the camera window visible, calibration, a
// snapshot, a recording — tapo-service decides); closing the request makes go2rtc tear down the
// camera's RTSP session. Bytes go through the fMP4 parser; every sample fans out to the worker
// port and the recorder ring. No bytes for 5 s → "stalled" → reconnect with backoff 1, 2, 4 … 30 s.
// go2rtc answering "wrong user/pass" is a sign-in failure: no reconnect (camera lockouts).

import { EventEmitter } from 'node:events';
import http from 'node:http';

import { Fmp4Parser } from './fmp4.js';
import { AUTH_LINE, GO2RTC_STREAM } from './go2rtc.js';

export const IDLE_MS = 5000;
export const MAX_BACKOFF_MS = 30000;

/** @typedef {'off'|'starting'|'live'|'stalled'|'error'} RelayState */

export class StreamRelay extends EventEmitter {
  /**
   * @param {{ getEndpoint: () => ({ url: string, auth: string }|null), streamName?: string, log?: (level: string, msg: string) => void,
   *   now?: () => number, request?: typeof http.get, idleMs?: number, redact?: (text: string) => string }} o
   *   redact: applied to go2rtc's error text before it is logged or shown (it can name the source URL)
   */
  constructor(o) {
    super();
    this._getEndpoint = o.getEndpoint;
    this._name = o.streamName || GO2RTC_STREAM;
    this._log = o.log || (() => {});
    this._now = o.now || (() => Date.now());
    this._get = o.request || http.get;
    this._idleMs = o.idleMs ?? IDLE_MS;
    this._redact = o.redact || ((/** @type {string} */ t) => t);
    this._needed = false;
    /** @type {RelayState} */
    this._state = 'off';
    this._detail = '';
    this.gen = 0;
    /** @type {import('./fmp4.js').TrackInit|null} */
    this.init = null;
    /** @type {import('node:http').ClientRequest|null} */
    this._req = null;
    /** @type {NodeJS.Timeout|null} */
    this._idle = null;
    /** @type {NodeJS.Timeout|null} */
    this._retry = null;
    /** @type {NodeJS.Timeout|null} */
    this._statsTimer = null;
    this._attempt = 0;
    this._authFailed = false;
    this._parser = new Fmp4Parser();
    this._parser.on('init', (init) => {
      this.init = init;
      this.emit('init', { ...init, gen: this.gen });
    });
    this._parser.on('sample', (s) => this._onSample(s));
    this._parser.on('error', (err) => {
      this._log('warn', `[tapo] stream: ${err.message}; reconnecting`);
      this._drop('error', `The video stream could not be read (${err.message}).`);
    });
    this._resetStats();
  }

  get state() {
    return this._state;
  }

  /** Why it is not live (the relay's own words; shown in the camera window). */
  get detail() {
    return this._detail;
  }

  get needed() {
    return this._needed;
  }

  /** @param {RelayState} s @param {string} [detail] */
  _setState(s, detail = '') {
    if (this._state === s && this._detail === detail) return;
    this._state = s;
    this._detail = detail;
    this.emit('state', s, detail);
  }

  /**
   * @param {boolean} needed @param {string} [reason]
   */
  setNeeded(needed, reason = '') {
    if (needed === this._needed) {
      if (needed && !this._req && !this._retry && !this._authFailed) this._connect();
      return;
    }
    this._needed = needed;
    this._log('debug', `[tapo] stream ${needed ? 'needed' : 'not needed'}${reason ? ` (${reason})` : ''}`);
    if (needed) {
      this._attempt = 0;
      this._connect();
    } else {
      this._close();
      this._setState('off');
    }
  }

  /** The endpoint may have changed (go2rtc (re)started) or the sign-in was fixed: connect afresh. */
  kick() {
    this._authFailed = false;
    this._attempt = 0;
    this._close();
    if (this._needed) this._connect();
  }

  stop() {
    this._needed = false;
    this._close();
    this._setState('off');
  }

  _close() {
    if (this._retry) clearTimeout(this._retry);
    this._retry = null;
    if (this._idle) clearTimeout(this._idle);
    this._idle = null;
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
    const req = this._req;
    this._req = null;
    if (req) req.destroy();
    this._parser.end();
  }

  _connect() {
    if (!this._needed || this._req || this._authFailed) return;
    if (this._retry) {
      clearTimeout(this._retry);
      this._retry = null;
    }
    const ep = this._getEndpoint();
    if (!ep) {
      this._setState('starting', 'Waiting for the video component…');
      return; // kick() when go2rtc is ready
    }
    this._parser.reset();
    this.gen++;
    this.init = null;
    this._resetStats();
    this.emit('reset', { gen: this.gen });
    this._setState('starting', 'Connecting to the camera…');
    const url = `${ep.url}/api/stream.mp4?src=${encodeURIComponent(this._name)}`;
    const req = this._get(url, { headers: { Authorization: ep.auth }, agent: false }, (res) => {
      if (this._req !== req) {
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 2048) body += c; });
        res.on('end', () => this._onHttpError(req, res.statusCode || 0, body.trim()));
        return;
      }
      this._armIdle(req);
      res.on('data', (chunk) => {
        if (this._req !== req) return;
        this._armIdle(req);
        this._bytes += chunk.length;
        this._parser.push(chunk);
      });
      res.on('end', () => {
        if (this._req === req) this._drop('stalled', 'The camera stopped sending video.');
      });
      res.on('error', () => {
        if (this._req === req) this._drop('stalled', 'The video connection broke.');
      });
    });
    req.on('error', (err) => {
      if (this._req === req) this._drop('error', `The video component is not answering (${/** @type {any} */ (err).code || err.message}).`);
    });
    this._req = req;
    this._statsTimer = setInterval(() => this.emit('stats', this.stats()), 1000);
    this._statsTimer.unref?.();
  }

  /** @param {any} req @param {number} status @param {string} rawBody */
  _onHttpError(req, status, rawBody) {
    if (this._req !== req) return;
    // go2rtc's text may name its source (the RTSP proxy URL with its token): never logged as is
    const body = this._redact(String(rawBody)).replace(/\brtsp:\/\/\S+/gi, 'rtsp://…');
    if (AUTH_LINE.test(body)) {
      this._authFailed = true;
      this._close();
      this._setState('error', 'The camera refused the video sign-in (Camera Account user name or password).');
      this._log('warn', `[tapo] stream: ${status} ${body.slice(0, 120)}; not retrying`);
      this.emit('auth-failed');
      return;
    }
    this._drop('error', status === 404 ? 'The video component does not know the camera stream.' : `The camera's video is not available (${body.slice(0, 160) || `HTTP ${status}`}).`);
  }

  /** @param {any} req */
  _armIdle(req) {
    if (this._idle) clearTimeout(this._idle);
    this._idle = setTimeout(() => {
      if (this._req === req) this._drop('stalled', 'No video from the camera for 5 seconds.');
    }, this._idleMs);
  }

  /** Lost the stream: close, then reconnect with backoff while needed. @param {RelayState} state @param {string} detail */
  _drop(state, detail) {
    this._close();
    if (!this._needed) {
      this._setState('off');
      return;
    }
    this._setState(state, detail);
    this._attempt++;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, this._attempt - 1));
    this._retry = setTimeout(() => {
      this._retry = null;
      this._connect();
    }, delay);
  }

  /** @param {import('./fmp4.js').Sample} s */
  _onSample(s) {
    const now = this._now();
    if (this._state !== 'live') {
      this._attempt = 0;
      this._setState('live');
    }
    this._frames.push(now);
    while (this._frames.length && now - this._frames[0] > 2000) this._frames.shift();
    this._byteLog.push([now, s.data.length]);
    while (this._byteLog.length && now - this._byteLog[0][0] > 2000) this._byteLog.shift();
    this._lastFrameAt = now;
    if (s.key) {
      if (this._lastKeyDts !== null && this.init) this._keyIntervals = [...this._keyIntervals.slice(-2), (s.dts - this._lastKeyDts) / this.init.timescale];
      this._lastKeyDts = s.dts;
    }
    this.emit('sample', { ...s, gen: this.gen });
  }

  _resetStats() {
    /** @type {number[]} */
    this._frames = [];
    /** @type {Array<[number, number]>} */
    this._byteLog = [];
    this._bytes = 0;
    this._lastFrameAt = 0;
    /** @type {number|null} */
    this._lastKeyDts = null;
    /** @type {number[]} */
    this._keyIntervals = [];
  }

  stats() {
    const now = this._now();
    const span = this._frames.length > 1 ? Math.max(0.5, (this._frames[this._frames.length - 1] - this._frames[0]) / 1000) : 2;
    const bytes = this._byteLog.reduce((a, [, n]) => a + n, 0);
    const ki = this._keyIntervals;
    return {
      fps: this._frames.length > 1 ? Math.round(((this._frames.length - 1) / span) * 10) / 10 : 0,
      kbps: Math.round((bytes * 8) / 2 / 1000),
      keyIntervalSec: ki.length ? Math.round((ki.reduce((a, b) => a + b, 0) / ki.length) * 10) / 10 : null,
      lastFrameAt: this._lastFrameAt,
      lastFrameAgoMs: this._lastFrameAt ? now - this._lastFrameAt : null,
      codec: this.init?.codec || null,
      width: this.init?.width || null,
      height: this.init?.height || null,
    };
  }
}
