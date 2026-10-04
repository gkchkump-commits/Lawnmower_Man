// WAV encode/decode and base64 helpers. Pure (no Web Audio), so it is unit-tested in Node and
// usable from the mic (upload to /stt) and the player (decode /tts audio without relying on
// decodeAudioData, which resamples and is asynchronous).

/**
 * Encode mono float samples (-1..1) as a 16-bit PCM WAV file.
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeAscii(v, 36, 'data');
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    v.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return buf;
}

/**
 * @typedef {object} DecodedWav
 * @property {number} sampleRate
 * @property {number} channels     channels in the file (samples are mixed down to mono)
 * @property {Float32Array} samples mono, -1..1
 * @property {number} durationSec
 */

/**
 * Decode a WAV file (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) to mono.
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {DecodedWav}
 */
export function decodeWav(input) {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || readAscii(v, 0) !== 'RIFF' || readAscii(v, 8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = readAscii(v, p);
    let size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true); // sub-format GUID
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body;
      if (size === 0xffffffff || body + size > bytes.length) size = bytes.length - body; // streamed/truncated
      dataLen = size;
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate) throw new Error('WAV has an invalid format');
  const bps = bits / 8;
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && (bits === 32 || bits === 64))) {
    throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  }
  const frames = Math.floor(dataLen / (bps * channels));
  const out = new Float32Array(frames);
  const read = sampleReader(v, format, bits);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = dataOff + f * bps * channels;
    for (let c = 0; c < channels; c++) acc += read(base + c * bps);
    out[f] = acc / channels;
  }
  return { sampleRate, channels, samples: out, durationSec: frames / sampleRate };
}

/** @param {DataView} v @param {number} format @param {number} bits @returns {(o: number) => number} */
function sampleReader(v, format, bits) {
  if (format === 3) return bits === 64 ? (o) => v.getFloat64(o, true) : (o) => v.getFloat32(o, true);
  switch (bits) {
    case 8: return (o) => (v.getUint8(o) - 128) / 128;
    case 16: return (o) => v.getInt16(o, true) / 32768;
    case 24: return (o) => {
      const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16);
      return x / 8388608;
    };
    default: return (o) => v.getInt32(o, true) / 2147483648;
  }
}

/** @param {DataView} v @param {number} o @param {string} s */
function writeAscii(v, o, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
}

/** @param {DataView} v @param {number} o */
function readAscii(v, o) {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

/**
 * Decode base64 (standard or URL-safe, padding optional) to bytes.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(/** @type {any} */ (globalThis).Buffer.from(padded, 'base64'));
}

/**
 * Encode bytes as standard base64.
 * @param {Uint8Array|ArrayBuffer} input
 */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + step)));
  return btoa(bin);
}
