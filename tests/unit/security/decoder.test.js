// The WebCodecs decoder wrapper (src/tapo/worker/decoder.js) with a fake VideoDecoder.
import { describe, expect, it } from 'vitest';
import { MAX_DECODE_QUEUE, StreamDecoder } from '../../../src/tapo/worker/decoder.js';

function fakeCodecs({ hardware = true, software = true } = {}) {
  const made = [];
  class VideoDecoder {
    static async isConfigSupported(c) {
      const ok = c.hardwareAcceleration === 'prefer-hardware' ? hardware : software;
      return { supported: ok, config: c };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
      this.decoded = [];
      made.push(this);
    }

    configure(c) {
      this.config = c;
      this.state = 'configured';
    }

    decode(chunk) {
      this.decoded.push(chunk);
    }

    close() {
      this.state = 'closed';
    }

    /** test: the decoder produced a frame (of the chunk with this timestamp) */
    emit(timestamp = 0) {
      const frame = { closed: false, close() { this.closed = true; }, displayWidth: 640, displayHeight: 360, timestamp };
      this.init.output(frame);
      return frame;
    }
  }
  class EncodedVideoChunk {
    constructor(o) {
      Object.assign(this, o);
    }
  }
  return { VideoDecoder, EncodedVideoChunk, made };
}

const CONFIG = { gen: 1, codec: 'avc1.640028', description: new Uint8Array([1, 100, 0, 40]).buffer, width: 2304, height: 1296 };
const chunk = (key, o = {}) => ({ gen: 1, key, ts: 0, dur: 66666, data: new Uint8Array([0, 0, 0, 1]).buffer, ...o });

describe('StreamDecoder', () => {
  it('prefers hardware decoding and configures for low latency', async () => {
    const c = fakeCodecs();
    const d = new StreamDecoder({ ...c, onFrame: () => {} });
    expect(await d.configure(CONFIG)).toBe(true);
    expect(d.acceleration).toBe('prefer-hardware');
    expect(c.made[0].config).toMatchObject({ codec: 'avc1.640028', codedWidth: 2304, codedHeight: 1296, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
    expect(c.made[0].config.description).toBe(CONFIG.description);
  });

  it('falls back to software, and reports a codec nothing can decode', async () => {
    const sw = fakeCodecs({ hardware: false });
    const d1 = new StreamDecoder({ ...sw, onFrame: () => {} });
    expect(await d1.configure(CONFIG)).toBe(true);
    expect(d1.stats().decoder).toBe('no-preference');
    const none = fakeCodecs({ hardware: false, software: false });
    const d2 = new StreamDecoder({ ...none, onFrame: () => {} });
    expect(await d2.configure({ ...CONFIG, codec: 'hvc1.1.6.L120.B0' })).toBe(false);
    expect(d2.stats().configSupported).toBe(false);
    expect(none.made).toHaveLength(0);
  });

  it('starts at a key frame, feeds every chunk after it, and ignores other generations', async () => {
    const c = fakeCodecs();
    const d = new StreamDecoder({ ...c, onFrame: () => {} });
    await d.configure(CONFIG);
    d.chunk(chunk(false));
    d.chunk(chunk(true, { ts: 1 }));
    d.chunk(chunk(false, { ts: 2 }));
    d.chunk(chunk(false, { gen: 0, ts: 3 }));
    expect(c.made[0].decoded.map((x) => [x.type, x.timestamp])).toEqual([['key', 1], ['delta', 2]]);
  });

  it('drops to the next key frame when the decoder falls behind', async () => {
    const c = fakeCodecs();
    const d = new StreamDecoder({ ...c, onFrame: () => {} });
    await d.configure(CONFIG);
    d.chunk(chunk(true));
    c.made[0].decodeQueueSize = MAX_DECODE_QUEUE + 1;
    d.chunk(chunk(false));
    c.made[0].decodeQueueSize = 0;
    d.chunk(chunk(false));
    d.chunk(chunk(true, { ts: 9 }));
    expect(d.dropped).toBe(1);
    expect(c.made[0].decoded.map((x) => x.type)).toEqual(['key', 'key']);
  });

  it('a decoder error closes it; it is re-created at the next key frame', async () => {
    const c = fakeCodecs();
    const errors = [];
    const d = new StreamDecoder({ ...c, onFrame: () => {}, onError: (e) => errors.push(e) });
    await d.configure(CONFIG);
    d.chunk(chunk(true));
    c.made[0].init.error(new Error('bad bitstream'));
    expect(c.made[0].state).toBe('closed');
    expect(errors[0]).toMatchObject({ fatal: false });
    d.chunk(chunk(false));
    expect(c.made).toHaveLength(1);
    d.chunk(chunk(true, { ts: 5 }));
    expect(c.made).toHaveLength(2);
    expect(c.made[1].decoded.map((x) => x.timestamp)).toEqual([5]);
  });

  it('hands frames to onFrame; frames of a closed decoder are closed at once', async () => {
    const c = fakeCodecs();
    const got = [];
    let t = 0;
    const d = new StreamDecoder({ ...c, onFrame: (f) => got.push(f), now: () => t });
    await d.configure(CONFIG);
    d.chunk(chunk(true));
    for (let i = 0; i < 16; i++) {
      t += 66.7;
      c.made[0].emit();
    }
    expect(got).toHaveLength(16);
    expect(d.fps()).toBeGreaterThan(14);
    expect(d.fps()).toBeLessThan(16);
    const old = c.made[0];
    d.reset(2);
    const late = old.emit();
    expect(late.closed).toBe(true);
    expect(got).toHaveLength(16);
  });

  it('a newer config wins over one still being checked; idle() frees the decoder', async () => {
    const c = fakeCodecs();
    const d = new StreamDecoder({ ...c, onFrame: () => {} });
    const first = d.configure(CONFIG);
    const second = d.configure({ ...CONFIG, gen: 2 });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(c.made).toHaveLength(1);
    expect(d.gen).toBe(2);
    d.idle();
    expect(c.made[0].state).toBe('closed');
    d.chunk(chunk(true, { gen: 2 }));
    expect(c.made).toHaveLength(1);
  });

  it('hands each frame its chunk\'s arrival stamp (main\'s rx), matched by timestamp, also out of order', async () => {
    const c = fakeCodecs();
    const got = [];
    const d = new StreamDecoder({ ...c, onFrame: (f, rx) => got.push([f.timestamp, rx]) });
    await d.configure(CONFIG);
    d.chunk(chunk(true, { ts: 0, rx: 1000.5 }));
    d.chunk(chunk(false, { ts: 133_333, rx: 1066 })); // a P-frame sent before the B-frame it anchors
    d.chunk(chunk(false, { ts: 66_666, rx: 1070 }));
    d.chunk(chunk(false, { ts: 200_000 })); // no stamp (an older main)
    for (const ts of [0, 66_666, 133_333, 200_000]) c.made[0].emit(ts); // presentation order
    expect(got).toEqual([[0, 1000.5], [66_666, 1070], [133_333, 1066], [200_000, undefined]]);
    // a reconnect forgets the stamps of chunks that were never decoded
    d.chunk(chunk(false, { ts: 266_666, rx: 1200 }));
    d.reset(1);
    await d.configure(CONFIG);
    d.chunk(chunk(true, { ts: 300_000, rx: 1300 }));
    c.made[1].emit(266_666);
    c.made[1].emit(300_000);
    expect(got.slice(-2)).toEqual([[266_666, undefined], [300_000, 1300]]);
  });

  it('without WebCodecs it says so', async () => {
    const errors = [];
    const d = new StreamDecoder({ VideoDecoder: undefined, EncodedVideoChunk: undefined, onFrame: () => {}, onError: (e) => errors.push(e) });
    expect(await d.configure(CONFIG)).toBe(false);
    expect(errors[0].fatal).toBe(true);
  });
});
