// Fakes for the TapoService tests: Electron's MessageChannelMain with a scripted "worker" on the
// far end, a stream relay that plays the go2rtc fixture in a loop, a go2rtc sidecar that does
// nothing, safeStorage in memory, and a settings store wired like main.js.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers';

import { Fmp4Parser, rewriteFragment } from '../../../../electron/tapo/fmp4.js';
import { SettingsStore } from '../../../../electron/settings.js';
import { tmpDir } from '../../helpers/tmp.js';

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

class FakePort extends EventEmitter {
  constructor() {
    super();
    /** @type {FakePort|null} */
    this.other = null;
    this.closed = false;
    /** @type {any[]} */
    this.sent = [];
  }
  /** @param {any} msg */
  postMessage(msg) {
    if (this.closed) throw new Error('port closed');
    this.sent.push(msg);
    const o = this.other;
    setImmediate(() => o && !o.closed && o.emit('message', { data: msg }));
  }
  start() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    if (this.other && !this.other.closed) this.other.close();
  }
}

/** MessageChannelMain stand-in. */
export class FakeMessageChannelMain {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/**
 * A webContents whose postMessage('lm:tapo:port', null, [port]) hands the port to a scripted
 * worker: it answers hello (ready), snap (a tiny JPEG), shift-measure (scripted shifts), and
 * records everything else. `send(msg)` posts a worker → main message.
 * @param {{ detector?: string }} [o]
 */
export function fakeCameraWindow(o = {}) {
  const w = {
    /** @type {FakePort|null} */
    port: null,
    received: /** @type {any[]} */ ([]),
    /** @type {Array<{ dx: number, dy: number, score: number }>} */
    shifts: [],
    /** the arrival stamp of the last reference picture (gated protocol) @type {number|null} */
    refAt: /** @type {number|null} */ (null),
    destroyed: false,
    isDestroyed: () => w.destroyed,
    /** @param {string} channel @param {any} _msg @param {FakePort[]} ports */
    postMessage(channel, _msg, ports) {
      if (channel !== 'lm:tapo:port') return;
      const port = ports[0];
      w.port = port;
      port.on('message', (/** @type {any} */ e) => {
        const m = e.data;
        w.received.push(m);
        if (m.t === 'hello') port.postMessage({ t: 'ready', detector: o.detector || 'on' });
        if (m.t === 'snap') {
          const ab = JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength);
          port.postMessage({ t: 'snap-ok', id: m.id, jpeg: ab, width: 160, height: 90, frameTs: 1 });
        }
        // the gated calibration protocol (`after` set): pictures from after the move, named by
        // their arrival stamps, as the current worker answers
        if (m.t === 'shift-ref' && m.id) {
          w.refAt = typeof m.after === 'number' ? m.after + 1 : null;
          port.postMessage(w.refAt === null ? { t: 'shift-ref-ok', id: m.id } : { t: 'shift-ref-ok', id: m.id, gated: true, ok: true, still: true, at: w.refAt });
        }
        if (m.t === 'shift-measure') {
          const gate = typeof m.after === 'number' ? { gated: true, at: m.after + 1, refAt: w.refAt, frames: 4, moved: true } : {};
          port.postMessage({ t: 'shift', id: m.id, ...(w.shifts.shift() || { dx: -0.2, dy: 0.15, score: 0.6 }), settledMs: 900, ...gate });
        }
      });
    },
    /** @param {any} msg */
    send(msg) {
      w.port?.postMessage(msg);
    },
    count: (/** @type {string} */ t) => w.received.filter((m) => m.t === t).length,
  };
  return w;
}

/** The go2rtc fixture's init and samples. */
export function fixtureStream() {
  const buf = fs.readFileSync(path.resolve('tests/unit/tapo/fixtures/go2rtc-sample.mp4'));
  const p = new Fmp4Parser();
  const out = { init: /** @type {any} */ (null), samples: /** @type {any[]} */ ([]) };
  p.on('init', (i) => { out.init = i; });
  p.on('sample', (s) => out.samples.push(s));
  p.push(buf);
  return out;
}

/** A StreamRelay stand-in: while needed, plays the fixture in a loop at 15 fps (re-timed). */
export class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.src = fixtureStream();
    this.state = 'off';
    this.gen = 0;
    this.init = null;
    this.needed = false;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.sent = 0;
  }
  /** @param {boolean} n */
  setNeeded(n) {
    if (n === this.needed) return;
    this.needed = n;
    if (n) this._start();
    else this._stop();
  }
  kick() {
    if (!this.needed) return;
    this._stop();
    this._start();
  }
  stop() {
    this.needed = false;
    this._stop();
  }
  stats() {
    return { fps: this.state === 'live' ? 15 : 0, kbps: 120, keyIntervalSec: 1, lastFrameAt: 0, lastFrameAgoMs: 0, codec: this.src.init.codec, width: 160, height: 90 };
  }
  _start() {
    this.gen++;
    this.emit('reset', { gen: this.gen });
    this.init = this.src.init;
    this.emit('init', { ...this.src.init, gen: this.gen });
    this.state = 'live';
    this.emit('state', 'live');
    const n = this.src.samples.length;
    const first = this.src.samples[0].dts;
    const span = this.src.samples[n - 1].dts + this.src.samples[n - 1].duration - first;
    let i = 0;
    this.timer = setInterval(() => {
      const s = this.src.samples[i % n];
      const shift = Math.floor(i / n) * span;
      const fragment = shift ? rewriteFragment(s.fragment, { seq: i + 1, baseTime: -shift }) : s.fragment;
      this.emit('sample', { ...s, dts: s.dts + shift, pts: s.pts + shift, fragment, gen: this.gen });
      this.sent++;
      i++;
    }, 1000 / 15);
  }
  _stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state !== 'off') {
      this.state = 'off';
      this.emit('state', 'off');
    }
  }
}

/** A Go2rtcSidecar stand-in. */
export class FakeSidecar extends EventEmitter {
  constructor() {
    super();
    this.starts = /** @type {any[]} */ ([]);
    this.state = 'stopped';
  }
  /** @param {any} p */
  async start(p) {
    this.starts.push(p);
    this.state = 'ready';
    this.emit('status', this.info());
    return { url: 'http://127.0.0.1:1', auth: 'Basic x' };
  }
  async stop() {
    this.state = 'stopped';
  }
  info() {
    return { state: this.state };
  }
  endpoint() {
    return this.state === 'ready' ? { url: 'http://127.0.0.1:1', auth: 'Basic x' } : null;
  }
  get pid() {
    return null;
  }
  resetFailures() {}
}

/** safeStorage that is "available" but keeps nothing secret (tests only). */
export function memorySafeStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (/** @type {string} */ s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
    decryptStringAsync: async (/** @type {Buffer} */ b) => ({ result: Buffer.from(String(b).slice(4), 'base64').toString(), shouldReEncrypt: false }),
  };
}

/** A real SettingsStore in a temp dir. @param {any} initial */
export function tempSettings(initial) {
  const dir = tmpDir('lm-tapo-svc-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 3, ...initial }));
  const store = new SettingsStore({ dir, platform: 'linux' });
  store.load();
  return { store, dir };
}

/** @param {() => boolean} fn @param {number} [timeoutMs] */
export async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
