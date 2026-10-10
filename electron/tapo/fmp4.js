// Fragmented-MP4 parser for go2rtc's /api/stream.mp4 (contract §8.6). Pure Node.
//
// go2rtc 1.9.14 writes ftyp + moov (avc1/avcC, mdhd timescale 90000, mvex/trex), then one
// moof + mdat per frame: tfhd flags 0x020038 (default-base-is-moof + default duration/size/
// flags; the keyframe flag lives in tfhd.default_sample_flags), tfdt version 1, trun flags
// 0x000001. Multi-sample truns with per-sample fields and composition offsets (B-frames) are
// handled too. Samples come out as AVCC/HVCC access units for WebCodecs, with the fragment's
// original bytes for the recorder (stream copy, no re-mux).

import { EventEmitter } from 'node:events';

export const MAX_BOX_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ codec: string, description: Buffer, width: number, height: number, timescale: number,
 *   initSegment: Buffer, trackId: number }} TrackInit
 * @typedef {{ key: boolean, dts: number, pts: number, duration: number, data: Buffer, fragment: Buffer,
 *   seq: number, fragIndex: number, fragCount: number }} Sample
 * @typedef {{ type: string, start: number, size: number, header: number, end: number }} Box
 */

/** @param {number} n */
const hex2 = (n) => n.toString(16).padStart(2, '0');

/** 'avc1.' + profile, compatibility and level bytes of the avcC (RFC 6381). @param {Buffer} avcC @param {string} [fourcc] */
export function avcCodecString(avcC, fourcc = 'avc1') {
  if (!avcC || avcC.length < 4) throw new Error('avcC too short');
  return `${fourcc}.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

/** ISO/IEC 14496-15 Annex E: hvc1.<space><profile>.<compat reversed>.<tier><level>[.<constraints>] @param {Buffer} hvcC @param {string} [fourcc] */
export function hevcCodecString(hvcC, fourcc = 'hvc1') {
  if (!hvcC || hvcC.length < 13) throw new Error('hvcC too short');
  const b1 = hvcC[1];
  const space = ['', 'A', 'B', 'C'][b1 >> 6];
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 0x1f;
  let compat = hvcC.readUInt32BE(2);
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const level = hvcC[12];
  const cons = [...hvcC.subarray(6, 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const tail = cons.map((b) => b.toString(16).toUpperCase()).join('.');
  return `${fourcc}.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${level}${tail ? `.${tail}` : ''}`;
}

/**
 * The boxes in buf[start..end) (one level). Throws on a malformed size.
 * @param {Buffer} buf @param {number} [start] @param {number} [end]
 * @returns {Box[]}
 */
export function readBoxes(buf, start = 0, end = buf.length) {
  /** @type {Box[]} */
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error(`truncated 64-bit ${type} box`);
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} box too large`);
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Error(`bad ${type} box size ${size}`);
    out.push({ type, start: p, size, header, end: p + size });
    p += size;
  }
  return out;
}

/** @param {Buffer} buf @param {Box} box @param {string} type */
function childBox(buf, box, type) {
  return readBoxes(buf, box.start + box.header, box.end).find((b) => b.type === type) || null;
}

/** @param {Buffer} buf @param {Box} box @param {string} type */
function childBoxes(buf, box, type) {
  return readBoxes(buf, box.start + box.header, box.end).filter((b) => b.type === type);
}

/** @param {Buffer} buf @param {Box} box @param {string} p 'mdia/minf/stbl' */
function boxPath(buf, box, p) {
  /** @type {Box|null} */
  let cur = box;
  for (const seg of p.split('/')) {
    if (!cur) return null;
    cur = childBox(buf, cur, seg);
  }
  return cur;
}

/**
 * Parse the moov: the first video track's codec, size, timescale and the trex defaults.
 * @param {Buffer} buf @param {Box} moov
 */
export function parseMoov(buf, moov) {
  const trex = new Map();
  const mvex = childBox(buf, moov, 'mvex');
  if (mvex) {
    for (const t of childBoxes(buf, mvex, 'trex')) {
      const o = t.start + t.header + 4;
      trex.set(buf.readUInt32BE(o), { duration: buf.readUInt32BE(o + 8), size: buf.readUInt32BE(o + 12), flags: buf.readUInt32BE(o + 16) });
    }
  }
  for (const trak of childBoxes(buf, moov, 'trak')) {
    const hdlr = boxPath(buf, trak, 'mdia/hdlr');
    if (!hdlr || buf.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) !== 'vide') continue;
    const tkhd = childBox(buf, trak, 'tkhd');
    const mdhd = boxPath(buf, trak, 'mdia/mdhd');
    const stsd = boxPath(buf, trak, 'mdia/minf/stbl/stsd');
    if (!tkhd || !mdhd || !stsd) continue;
    const tv = buf[tkhd.start + tkhd.header];
    const trackId = buf.readUInt32BE(tkhd.start + tkhd.header + (tv === 1 ? 20 : 12));
    const mv = buf[mdhd.start + mdhd.header];
    const timescale = buf.readUInt32BE(mdhd.start + mdhd.header + (mv === 1 ? 20 : 12));
    // stsd: version/flags(4) entry_count(4), then the sample entries
    const entries = readBoxes(buf, stsd.start + stsd.header + 8, stsd.end);
    const entry = entries.find((e) => ['avc1', 'avc3', 'hvc1', 'hev1'].includes(e.type));
    if (!entry) throw new Error(`unsupported video sample entry ${entries.map((e) => e.type).join(',') || '(none)'}`);
    const base = entry.start + entry.header;
    const width = buf.readUInt16BE(base + 24);
    const height = buf.readUInt16BE(base + 26);
    const configs = readBoxes(buf, base + 78, entry.end);
    const isHevc = entry.type === 'hvc1' || entry.type === 'hev1';
    const cfg = configs.find((c) => c.type === (isHevc ? 'hvcC' : 'avcC'));
    if (!cfg) throw new Error(`${entry.type} without ${isHevc ? 'hvcC' : 'avcC'}`);
    const description = Buffer.from(buf.subarray(cfg.start + cfg.header, cfg.end));
    const codec = isHevc ? hevcCodecString(description, entry.type) : avcCodecString(description, entry.type);
    return { trackId, timescale, width, height, codec, description, trex: trex.get(trackId) || { duration: 0, size: 0, flags: 0 } };
  }
  throw new Error('no video track in the stream');
}

/** Sync sample? sample_depends_on == 2 (no other), or depends_on unknown and not a non-sync sample. @param {number} flags */
export function isKeyFlags(flags) {
  const dependsOn = (flags >>> 24) & 3;
  return dependsOn === 2 || (dependsOn === 0 && !(flags & 0x00010000));
}

/**
 * The samples of one moof + mdat (both in `frag`, moof at 0).
 * @param {Buffer} frag
 * @param {{ trackId: number, trex: { duration: number, size: number, flags: number } }} track
 * @param {number} nextDts where the previous fragment ended (when a traf has no tfdt)
 */
export function parseFragment(frag, track, nextDts) {
  const [moof] = readBoxes(frag, 0, frag.length).filter((b) => b.type === 'moof');
  if (!moof) throw new Error('fragment without moof');
  const mfhd = childBox(frag, moof, 'mfhd');
  const seq = mfhd ? frag.readUInt32BE(mfhd.start + mfhd.header + 4) : 0;
  /** @type {Array<Omit<Sample, 'fragment'|'seq'|'fragIndex'|'fragCount'>>} */
  const samples = [];
  let endDts = nextDts;
  for (const traf of childBoxes(frag, moof, 'traf')) {
    const tfhd = childBox(frag, traf, 'tfhd');
    if (!tfhd) continue;
    let o = tfhd.start + tfhd.header;
    const tf = frag.readUInt32BE(o) & 0xffffff;
    o += 4;
    const trackId = frag.readUInt32BE(o);
    o += 4;
    if (trackId !== track.trackId) continue;
    // default-base-is-moof (go2rtc, ffmpeg's default_base_moof), and the first traf without an
    // explicit base: offsets count from the moof's first byte
    const base = 0;
    if (tf & 0x01) throw new Error('fragments with an absolute base_data_offset are not supported');
    if (tf & 0x02) o += 4;
    let defDuration = track.trex.duration;
    let defSize = track.trex.size;
    let defFlags = track.trex.flags;
    if (tf & 0x08) { defDuration = frag.readUInt32BE(o); o += 4; }
    if (tf & 0x10) { defSize = frag.readUInt32BE(o); o += 4; }
    if (tf & 0x20) { defFlags = frag.readUInt32BE(o); o += 4; }
    const tfdt = childBox(frag, traf, 'tfdt');
    let dts = endDts;
    if (tfdt) {
      const v = frag[tfdt.start + tfdt.header];
      dts = v === 1 ? Number(frag.readBigUInt64BE(tfdt.start + tfdt.header + 4)) : frag.readUInt32BE(tfdt.start + tfdt.header + 4);
    }
    const mdat = readBoxes(frag, 0, frag.length).find((b) => b.type === 'mdat');
    let dataPos = mdat ? mdat.start + mdat.header : moof.end;
    for (const trun of childBoxes(frag, traf, 'trun')) {
      let p = trun.start + trun.header;
      const word = frag.readUInt32BE(p);
      const version = word >>> 24;
      const flags = word & 0xffffff;
      p += 4;
      const count = frag.readUInt32BE(p);
      p += 4;
      if (flags & 0x01) {
        dataPos = base + frag.readInt32BE(p);
        p += 4;
      }
      let firstFlags = null;
      if (flags & 0x04) {
        firstFlags = frag.readUInt32BE(p);
        p += 4;
      }
      for (let i = 0; i < count; i++) {
        let duration = defDuration;
        let size = defSize;
        let sflags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
        let cto = 0;
        if (flags & 0x100) { duration = frag.readUInt32BE(p); p += 4; }
        if (flags & 0x200) { size = frag.readUInt32BE(p); p += 4; }
        if (flags & 0x400) { sflags = frag.readUInt32BE(p); p += 4; }
        if (flags & 0x800) { cto = version === 0 ? frag.readUInt32BE(p) : frag.readInt32BE(p); p += 4; }
        if (dataPos < 0 || dataPos + size > frag.length) throw new Error('sample data outside the fragment');
        samples.push({ key: isKeyFlags(sflags), dts, pts: dts + cto, duration, data: frag.subarray(dataPos, dataPos + size) });
        dataPos += size;
        dts += duration;
      }
    }
    endDts = dts;
  }
  return { seq, samples, endDts };
}

/**
 * A copy of a moof+mdat with a new mfhd.sequence_number and tfdt.baseMediaDecodeTime − baseTime
 * (sizes do not change, and with default-base-is-moof the data offsets stay valid).
 * @param {Buffer} fragment @param {{ seq: number, baseTime: number }} o
 */
export function rewriteFragment(fragment, o) {
  const out = Buffer.from(fragment);
  const moof = readBoxes(out).find((b) => b.type === 'moof');
  if (!moof) throw new Error('fragment without moof');
  const mfhd = childBox(out, moof, 'mfhd');
  if (mfhd) out.writeUInt32BE(o.seq >>> 0, mfhd.start + mfhd.header + 4);
  for (const traf of childBoxes(out, moof, 'traf')) {
    const tfdt = childBox(out, traf, 'tfdt');
    if (!tfdt) continue;
    const at = tfdt.start + tfdt.header + 4;
    if (out[tfdt.start + tfdt.header] === 1) {
      const v = out.readBigUInt64BE(at) - BigInt(Math.max(0, Math.round(o.baseTime)));
      out.writeBigUInt64BE(v < 0n ? 0n : v, at);
    } else {
      out.writeUInt32BE(Math.max(0, out.readUInt32BE(at) - Math.max(0, Math.round(o.baseTime))), at);
    }
  }
  return out;
}

/**
 * Streaming parser: push() the HTTP body as it arrives. Events: 'init' (TrackInit, again after
 * reset()), 'sample' (Sample), 'error' (Error; parsing stops until reset()).
 */
export class Fmp4Parser extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    /** @type {Buffer[]} */
    this._chunks = [];
    this._len = 0;
    /** @type {Buffer|null} */
    this._ftyp = null;
    /** @type {ReturnType<typeof parseMoov>|null} */
    this.track = null;
    /** @type {TrackInit|null} */
    this.init = null;
    /** @type {Buffer|null} a moof waiting for its mdat */
    this._moof = null;
    this._nextDts = 0;
    this._failed = false;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    if (this._failed || !chunk || !chunk.length) return;
    this._chunks.push(chunk);
    this._len += chunk.length;
    try {
      this._drain();
    } catch (err) {
      this._failed = true;
      this.emit('error', err);
    }
  }

  end() {
    this._chunks = [];
    this._len = 0;
    this._moof = null;
  }

  /** @param {number} n */
  _peek(n) {
    if (this._chunks.length > 1 && this._chunks[0].length < n) {
      const all = Buffer.concat(this._chunks, this._len);
      this._chunks = [all];
    }
    return this._chunks[0].subarray(0, n);
  }

  /** @param {number} n */
  _take(n) {
    const all = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._len);
    const box = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this._chunks = rest.length ? [rest] : [];
    this._len = rest.length;
    return box;
  }

  _drain() {
    while (this._len >= 8) {
      const head = this._peek(Math.min(16, this._len));
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) {
        if (this._len < 16) return;
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(MAX_BOX_BYTES)) throw new Error(`${type} box larger than 16 MB`);
        size = Number(big);
      } else if (size === 0) {
        throw new Error(`${type} box with open-ended size in a live stream`);
      }
      if (size < 8) throw new Error(`bad ${type} box size ${size}`);
      if (size > MAX_BOX_BYTES) throw new Error(`${type} box larger than 16 MB`);
      if (this._len < size) return;
      this._onBox(type, this._take(size));
    }
  }

  /** @param {string} type @param {Buffer} box */
  _onBox(type, box) {
    switch (type) {
      case 'ftyp':
        this._ftyp = box;
        return;
      case 'moov': {
        const [moov] = readBoxes(box);
        this.track = parseMoov(box, moov);
        const initSegment = Buffer.concat(this._ftyp ? [this._ftyp, box] : [box]);
        this.init = { codec: this.track.codec, description: this.track.description, width: this.track.width, height: this.track.height, timescale: this.track.timescale, initSegment, trackId: this.track.trackId };
        this.emit('init', this.init);
        return;
      }
      case 'moof':
        this._moof = box;
        return;
      case 'mdat': {
        if (!this._moof || !this.track) return; // data before the init / without its moof
        const fragment = Buffer.concat([this._moof, box]);
        this._moof = null;
        const { seq, samples, endDts } = parseFragment(fragment, this.track, this._nextDts);
        this._nextDts = endDts;
        samples.forEach((s, i) => this.emit('sample', { ...s, fragment, seq, fragIndex: i, fragCount: samples.length }));
        return;
      }
      default:
        // styp, sidx, free, …: nothing we need
    }
  }
}
