import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Fmp4Parser, avcCodecString, hevcCodecString, isKeyFlags, readBoxes, rewriteFragment } from '../../../electron/tapo/fmp4.js';

const FIX = path.resolve('tests/unit/tapo/fixtures');
const G2R = fs.readFileSync(path.join(FIX, 'go2rtc-sample.mp4'));
const BFR = fs.readFileSync(path.join(FIX, 'bframes.mp4'));

/** Parse a whole file, pushed in chunks of `chunk` bytes. */
function parseAll(buf, chunk = 4096) {
  const p = new Fmp4Parser();
  const out = { init: null, samples: [], errors: [] };
  p.on('init', (i) => { out.init = i; });
  p.on('sample', (s) => out.samples.push(s));
  p.on('error', (e) => out.errors.push(e));
  for (let i = 0; i < buf.length; i += chunk) p.push(buf.subarray(i, i + chunk));
  return out;
}

describe('Fmp4Parser on go2rtc 1.9.14 output', () => {
  it('reads the init and one sample per fragment', () => {
    const r = parseAll(G2R);
    expect(r.errors).toEqual([]);
    expect(r.init).toMatchObject({ codec: 'avc1.64001f', width: 160, height: 90, timescale: 90000 });
    expect(r.init.description[0]).toBe(1); // avcC configurationVersion
    expect(r.init.description.subarray(1, 4).toString('hex')).toBe('64001f');
    const boxes = readBoxes(G2R).map((b) => b.type);
    expect(boxes.slice(0, 2)).toEqual(['ftyp', 'moov']);
    expect(r.init.initSegment.length).toBe(readBoxes(G2R)[0].size + readBoxes(G2R)[1].size);
    expect(r.samples.length).toBeGreaterThanOrEqual(40);
    expect(r.samples.every((s) => s.fragCount === 1)).toBe(true);
    expect(r.samples[0].key).toBe(true);
    const keys = r.samples.map((s, i) => (s.key ? i : -1)).filter((i) => i >= 0);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys[1] - keys[0]).toBe(15); // 1-second GOPs at 15 fps
    for (let i = 1; i < r.samples.length; i++) expect(r.samples[i].dts).toBeGreaterThan(r.samples[i - 1].dts);
    // AVCC: 4-byte lengths, a keyframe carries SPS + PPS + IDR in-band
    const nalTypes = (data) => {
      const t = [];
      for (let p = 0; p + 4 <= data.length;) {
        const n = data.readUInt32BE(p);
        t.push(data[p + 4] & 0x1f);
        p += 4 + n;
      }
      return t;
    };
    expect(nalTypes(r.samples[0].data)).toEqual(expect.arrayContaining([7, 8, 5]));
    expect(nalTypes(r.samples[1].data)).toEqual([1]);
  });

  it('gives the same result whatever the chunking', () => {
    const a = parseAll(G2R, 1 << 20);
    const b = parseAll(G2R, 7);
    expect(b.samples.length).toBe(a.samples.length);
    expect(b.samples.map((s) => s.dts)).toEqual(a.samples.map((s) => s.dts));
    expect(Buffer.compare(b.samples[5].data, a.samples[5].data)).toBe(0);
  });
});

describe('Fmp4Parser on B-frames (ffmpeg frag_every_frame)', () => {
  it('pts = dts + composition offset; keys only at GOP starts', () => {
    const r = parseAll(BFR);
    expect(r.errors).toEqual([]);
    expect(r.init.codec).toBe('avc1.64001f');
    expect(r.samples).toHaveLength(30);
    expect(r.samples.slice(0, 6).map((s) => [s.dts, s.pts])).toEqual([[0, 2048], [1024, 5120], [2048, 3072], [3072, 4096], [4096, 8192], [5120, 6144]]);
    expect(r.samples.filter((s) => s.key).length).toBe(2);
    expect(r.samples[0].key).toBe(true);
  });
});

describe('fragments', () => {
  it('rewriteFragment renumbers mfhd and shifts tfdt; the copy still parses', () => {
    const r = parseAll(G2R);
    const s = r.samples[10];
    const out = rewriteFragment(s.fragment, { seq: 3, baseTime: r.samples[0].dts });
    expect(out.length).toBe(s.fragment.length);
    expect(s.fragment.readUInt32BE(0)).toBe(out.readUInt32BE(0));
    const p = new Fmp4Parser();
    const got = [];
    p.on('sample', (x) => got.push(x));
    p.push(r.init.initSegment);
    p.push(out);
    expect(got).toHaveLength(1);
    expect(got[0].seq).toBe(3);
    expect(got[0].dts).toBe(s.dts - r.samples[0].dts);
    expect(Buffer.compare(got[0].data, s.data)).toBe(0);
  });

  it('handles 64-bit box sizes and refuses boxes over 16 MB', () => {
    const r = parseAll(G2R);
    const frag = r.samples[1].fragment;
    const [moof, mdat] = readBoxes(frag);
    const payload = frag.subarray(mdat.start + 8, mdat.end);
    const big = Buffer.alloc(16);
    big.writeUInt32BE(1, 0);
    big.write('mdat', 4, 'latin1');
    big.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    // the trun data offset counts from the moof start: 8 more header bytes → patch it
    const moofBuf = Buffer.from(frag.subarray(moof.start, moof.end));
    const trunAt = moofBuf.indexOf('trun', 0, 'latin1');
    moofBuf.writeInt32BE(moofBuf.readInt32BE(trunAt + 12) + 8, trunAt + 12);
    const p = new Fmp4Parser();
    const got = [];
    p.on('sample', (x) => got.push(x));
    p.push(r.init.initSegment);
    p.push(Buffer.concat([moofBuf, big, payload]));
    expect(got).toHaveLength(1);
    expect(Buffer.compare(got[0].data, r.samples[1].data)).toBe(0);
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(17 * 1024 * 1024, 0);
    huge.write('mdat', 4, 'latin1');
    const errs = [];
    const q = new Fmp4Parser();
    q.on('error', (e) => errs.push(e.message));
    q.push(huge);
    expect(errs[0]).toMatch(/16 MB/);
  });

  it('key flags', () => {
    expect(isKeyFlags(0x02000000)).toBe(true); // depends on no other sample (go2rtc's I-frames)
    expect(isKeyFlags(0x01010000)).toBe(false);
    expect(isKeyFlags(0x00010000)).toBe(false); // non-sync
    expect(isKeyFlags(0)).toBe(true);
  });
});

describe('codec strings', () => {
  it('avc and hevc (ISO/IEC 14496-15 Annex E)', () => {
    expect(avcCodecString(Buffer.from([1, 0x64, 0x00, 0x28, 0xff]))).toBe('avc1.640028');
    const hvcC = Buffer.alloc(23);
    hvcC[0] = 1;
    hvcC[1] = 0x01; // space 0, tier Main, profile 1
    hvcC.writeUInt32BE(0x60000000, 2);
    hvcC[6] = 0xb0;
    hvcC[12] = 93;
    expect(hevcCodecString(hvcC)).toBe('hvc1.1.6.L93.B0');
    hvcC[1] = 0x22; // tier High, profile 2
    hvcC.writeUInt32BE(0x20000000, 2);
    hvcC[6] = 0;
    hvcC[12] = 120;
    expect(hevcCodecString(hvcC, 'hev1')).toBe('hev1.2.4.H120');
  });
});
