// Integration: the app's fMP4 parser (electron/tapo/fmp4.js, lane A) on lane C's independently
// made fixtures (tests/fixtures/tapo, contract §11.3): the sample go2rtc 1.9.14 served when fed
// by the simulator (tools/tapo-sim/capture-go2rtc-sample.mjs) and two B-frame encodes, one moof
// per frame and one moof per GOP (tools/tapo-sim/make-fixtures.sh). Skipped until lane A merges.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, laneModules } from './helpers.js';
import { VIEW } from '../../../tools/tapo-sim/geometry.mjs';
import { loadFixtures } from '../../../tools/tapo-sim/fixtures.mjs';

const FIX = path.join(ROOT, 'tests/fixtures/tapo');
const lane = await laneModules(['electron/tapo/fmp4.js']);

/** @param {string} file @returns {{ init: any, samples: any[], errors: string[] }} */
function parse(file) {
  const { Fmp4Parser } = lane.mods['electron/tapo/fmp4.js'];
  const p = new Fmp4Parser();
  /** @type {any} */
  let init = null;
  /** @type {any[]} */
  const samples = [];
  /** @type {string[]} */
  const errors = [];
  p.on('init', (/** @type {any} */ i) => { init = i; });
  p.on('sample', (/** @type {any} */ s) => samples.push(s));
  p.on('error', (/** @type {Error} */ e) => errors.push(e.message));
  const buf = fs.readFileSync(path.join(FIX, file));
  // in odd-sized pieces, as the HTTP body arrives
  for (let o = 0; o < buf.length; o += 7001) p.push(buf.subarray(o, o + 7001));
  p.end?.();
  return { init, samples, errors };
}

/** NAL unit types of a length-prefixed (AVCC) sample. @param {Buffer} d */
function nalTypes(d) {
  const out = [];
  for (let o = 0; o + 4 <= d.length;) {
    const n = d.readUInt32BE(o);
    out.push(d[o + 4] & 31);
    o += 4 + n;
  }
  return out;
}

describe.skipIf(!lane.ok)(`fMP4 parser × lane C fixtures${lane.reason}`, () => {
  it('go2rtc-sample.mp4: the stream go2rtc serves from the simulator, frame by frame', () => {
    const { init, samples, errors } = parse('go2rtc-sample.mp4');
    expect(errors).toEqual([]);
    // the codec string comes from the simulator's SPS (profile-level-id 64001F)
    expect(init.codec).toBe(`avc1.${loadFixtures().stream1.profileLevelId.toLowerCase()}`);
    expect([init.width, init.height]).toEqual([VIEW.width, VIEW.height]);
    expect(init.timescale).toBe(90000);
    expect(samples.length).toBeGreaterThanOrEqual(40); // 3 s at 15 fps
    expect(samples.every((s) => s.fragCount === 1)).toBe(true); // one moof per frame
    expect(samples[0].key).toBe(true);
    for (let i = 1; i < samples.length; i++) expect(samples[i].dts).toBeGreaterThan(samples[i - 1].dts);
    const keys = samples.filter((s) => s.key);
    // one IDR per 1-second GOP plus the scene cut of the pan during the capture
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const k of keys) expect(nalTypes(k.data)).toEqual([7, 8, 5]); // SPS + PPS in-band, AUDs dropped
    for (const s of samples.filter((x) => !x.key)) expect(nalTypes(s.data)).toEqual([1]);
    const span = (samples.at(-1).dts + samples.at(-1).duration - samples[0].dts) / init.timescale;
    expect(span).toBeGreaterThan(2.5);
    expect(span).toBeLessThan(3.5);
  });

  it('bframes.mp4 / bframes-gop.mp4: reordered frames, one moof per frame or per GOP, same samples', () => {
    const a = parse('bframes.mp4');
    const b = parse('bframes-gop.mp4');
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.samples.length).toBe(30);
    expect(b.samples.length).toBe(30);
    expect(new Set(a.samples.map((s) => s.fragCount))).toEqual(new Set([1]));
    expect(new Set(b.samples.map((s) => s.fragCount))).toEqual(new Set([15])); // multi-sample trun
    for (const { init, samples } of [a, b]) {
      expect(init.codec).toMatch(/^avc1\.6400[0-9a-f]{2}$/);
      expect(samples.filter((s) => s.key).length).toBe(2);
      expect(samples[0].key).toBe(true);
      // presentation order differs from decode order (B-frames), and is a gapless 15 fps grid
      const pts = samples.map((s) => s.pts);
      expect(pts).not.toEqual([...pts].sort((x, y) => x - y));
      const sorted = [...pts].sort((x, y) => x - y);
      const step = init.timescale / 15;
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBe(step);
      for (const s of samples) expect(s.pts).toBeGreaterThanOrEqual(s.dts);
    }
    // the two fragmentations carry the same frames with the same timing
    for (let i = 0; i < 30; i++) {
      expect(b.samples[i].data.equals(a.samples[i].data)).toBe(true);
      expect([b.samples[i].dts, b.samples[i].pts, b.samples[i].key]).toEqual([a.samples[i].dts, a.samples[i].pts, a.samples[i].key]);
    }
  });
});
