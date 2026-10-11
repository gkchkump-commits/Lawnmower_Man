// The Home camera's video decoder (contract §9.4): WebCodecs VideoDecoder in the security
// worker, fed with the camera's own H.264/H.265 samples that main relays from go2rtc. Hardware
// first (D3D11VA on the RTX 5070), software otherwise; a codec this PC cannot decode at all
// (H.265 without hardware support) is reported so the window can say what to do.
//
// Rules: every chunk is fed (P-frames depend on the frames before them); decoding starts only at
// a key frame after a config or a reset; a backlog of more than 30 chunks (a slow PC) drops
// everything up to the next key frame; a decoder error closes the decoder, which is re-created
// at the next key frame. Every decoded VideoFrame goes to `onFrame`, which owns it (it must
// close it), with its arrival stamp: the `rx` main put on the chunk (main's monotonic receive
// time), matched by the frame's timestamp (B-frames come out in another order), or undefined
// for a chunk without one (an older main).
//
// VideoDecoder and EncodedVideoChunk are injected so this is unit-tested with fakes.

export const MAX_DECODE_QUEUE = 30;
/** Arrival stamps kept for chunks not decoded yet (a decoder that drops frames must not leak). */
const MAX_PENDING_STAMPS = 120;
const FPS_WINDOW_MS = 2000;

/**
 * @typedef {object} DecoderConfigMsg
 * @property {number} gen @property {string} codec @property {ArrayBuffer|Uint8Array} [description]
 * @property {number} width @property {number} height
 */

export class StreamDecoder {
  /**
   * @param {object} o
   * @param {any} o.VideoDecoder
   * @param {any} o.EncodedVideoChunk
   * @param {(frame: any, rx?: number) => void} o.onFrame  rx: the chunk's arrival stamp (main's clock)
   * @param {(e: { message: string, fatal: boolean }) => void} [o.onError]
   * @param {() => number} [o.now]  ms clock
   */
  constructor(o) {
    this.VideoDecoder = o.VideoDecoder;
    this.EncodedVideoChunk = o.EncodedVideoChunk;
    this.onFrame = o.onFrame;
    this.onError = o.onError || (() => {});
    this._now = o.now || (() => performance.now());
    /** @type {any} */
    this.decoder = null;
    /** @type {any} the VideoDecoderConfig in use (null: none / unsupported) */
    this.config = null;
    this.gen = -1;
    this.waitKey = true;
    this.dropped = 0;
    /** null until a config was checked */
    this.configSupported = /** @type {boolean|null} */ (null);
    /** @type {'prefer-hardware'|'no-preference'|null} */
    this.acceleration = null;
    this.codec = '';
    this._seq = 0;
    /** @type {number[]} output times within the last FPS_WINDOW_MS */
    this._outputs = [];
    this.frames = 0;
    /** chunk timestamp (µs) → main's arrival stamp, until the frame is decoded @type {Map<number, number>} */
    this._stamps = new Map();
  }

  get available() {
    return typeof this.VideoDecoder === 'function';
  }

  /**
   * A new stream configuration (main parsed the init segment). Checks support, hardware first.
   * @param {DecoderConfigMsg} msg
   * @returns {Promise<boolean>} supported
   */
  async configure(msg) {
    const seq = ++this._seq;
    this._close();
    this._stamps.clear();
    this.gen = msg.gen;
    this.waitKey = true;
    this.codec = String(msg.codec || '');
    this.config = null;
    this.acceleration = null;
    if (!this.available) {
      this.configSupported = false;
      this.onError({ message: 'This window has no video decoder (WebCodecs is missing).', fatal: true });
      return false;
    }
    const base = { codec: this.codec, codedWidth: msg.width, codedHeight: msg.height };
    if (msg.description && msg.description.byteLength) /** @type {any} */ (base).description = msg.description;
    for (const hardwareAcceleration of /** @type {const} */ (['prefer-hardware', 'no-preference'])) {
      let ok = false;
      try {
        const r = await this.VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration });
        ok = !!r?.supported;
      } catch {
        ok = false;
      }
      if (seq !== this._seq) return false; // a newer config arrived meanwhile
      if (ok) {
        this.config = { ...base, hardwareAcceleration, optimizeForLatency: true };
        this.acceleration = hardwareAcceleration;
        break;
      }
    }
    this.configSupported = !!this.config;
    if (!this.config) return false;
    this._open();
    return true;
  }

  /**
   * One encoded sample.
   * @param {{ gen: number, key: boolean, ts: number, dur?: number, rx?: number, data: ArrayBuffer|Uint8Array }} msg
   */
  chunk(msg) {
    if (msg.gen !== this.gen || !this.config) return;
    if (this.waitKey && !msg.key) return;
    if (!this.decoder || this.decoder.state === 'closed') {
      if (!msg.key) return;
      this._open(); // after an error: start again at a key frame
      if (!this.decoder) return;
    }
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // the PC cannot keep up: skip to the next key frame instead of falling further behind
      this.waitKey = true;
      this.dropped++;
      return;
    }
    if (msg.key) this.waitKey = false;
    if (typeof msg.rx === 'number' && Number.isFinite(msg.rx)) {
      this._stamps.set(msg.ts, msg.rx);
      if (this._stamps.size > MAX_PENDING_STAMPS) this._stamps.delete(this._stamps.keys().next().value);
    }
    try {
      this.decoder.decode(new this.EncodedVideoChunk({
        type: msg.key ? 'key' : 'delta',
        timestamp: msg.ts,
        duration: msg.dur || undefined,
        data: msg.data,
      }));
    } catch (err) {
      this._fail(err);
    }
  }

  /** The stream reconnected: forget the old one, wait for its new config and a key frame. @param {number} gen */
  reset(gen) {
    this._seq++;
    this._close();
    this._stamps.clear();
    this.gen = gen;
    this.config = null;
    this.waitKey = true;
  }

  /** The stream is not needed any more: free the decoder. */
  idle() {
    this.reset(-1);
  }

  /** Frames decoded per second over the last 2 s. */
  fps() {
    const now = this._now();
    while (this._outputs.length && now - this._outputs[0] > FPS_WINDOW_MS) this._outputs.shift();
    if (this._outputs.length < 2) return this._outputs.length ? 1000 / FPS_WINDOW_MS : 0;
    const span = Math.max(1, now - this._outputs[0]);
    return Math.round(((this._outputs.length - 1) / span) * 1000 * 10) / 10;
  }

  stats() {
    return {
      fps: this.fps(),
      decodeQueue: this.decoder?.decodeQueueSize ?? 0,
      dropped: this.dropped,
      decoder: this.acceleration || 'no-preference',
      configSupported: this.configSupported !== false,
    };
  }

  _open() {
    if (!this.config) return;
    try {
      const dec = new this.VideoDecoder({
        output: (/** @type {any} */ frame) => {
          if (dec !== this.decoder) {
            frame.close();
            return;
          }
          this.frames++;
          this._outputs.push(this._now());
          if (this._outputs.length > 120) this._outputs.shift();
          const ts = Number(frame.timestamp);
          const rx = this._stamps.get(ts);
          this._stamps.delete(ts);
          try {
            this.onFrame(frame, rx);
          } catch (err) {
            frame.close();
            this.onError({ message: `frame handling failed: ${/** @type {Error} */ (err)?.message || err}`, fatal: false });
          }
        },
        error: (/** @type {any} */ err) => {
          if (dec === this.decoder) this._fail(err);
        },
      });
      dec.configure(this.config);
      this.decoder = dec;
      this.waitKey = true;
    } catch (err) {
      this.decoder = null;
      this.onError({ message: `the video decoder could not start: ${/** @type {Error} */ (err)?.message || err}`, fatal: false });
    }
  }

  /** @param {unknown} err */
  _fail(err) {
    this._close();
    this.waitKey = true;
    this.onError({ message: `video decoding failed: ${/** @type {Error} */ (err)?.message || err}`, fatal: false });
  }

  _close() {
    const d = this.decoder;
    this.decoder = null;
    if (d && d.state !== 'closed') {
      try {
        d.close();
      } catch { /* already closed */ }
    }
  }
}
