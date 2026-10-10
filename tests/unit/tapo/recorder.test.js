import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fmp4Parser, readBoxes } from '../../../electron/tapo/fmp4.js';
import { ClipRecorder } from '../../../electron/tapo/recorder.js';

const G2R = fs.readFileSync(path.resolve('tests/unit/tapo/fixtures/go2rtc-sample.mp4'));

function samplesOf(buf) {
  const p = new Fmp4Parser();
  const out = { init: null, samples: [] };
  p.on('init', (i) => { out.init = i; });
  p.on('sample', (s) => out.samples.push(s));
  p.push(buf);
  return out;
}
const SRC = samplesOf(G2R);
const ID = '20261010-140312-a1b2';

let dir;
let settings;
const make = (o = {}) => new ClipRecorder({ getDir: () => dir, getSettings: () => settings, now: () => new Date(2026, 9, 10, 14, 3, 30).getTime(), ...o });
const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rec-'));
  settings = { preRollSec: 1, maxClipSec: 120 };
});

describe('ClipRecorder', () => {
  it('starts the clip at a keyframe of the pre-roll, renumbers and rebases the fragments', async () => {
    const r = make();
    r.onInit(SRC.init);
    SRC.samples.slice(0, 30).forEach((s) => r.onSample(s));
    const started = r.start(ID, { kind: 'person' });
    expect(started.rel).toBe('2026-10-10/140312-person-a1b2.mp4');
    expect(fs.existsSync(`${started.file}.part`)).toBe(true);
    expect(r.recording).toBe(true);
    SRC.samples.slice(30).forEach((s) => r.onSample(s));
    const info = await r.stop(ID, { reason: 'event end' });
    expect(fs.existsSync(started.file)).toBe(true);
    expect(fs.existsSync(`${started.file}.part`)).toBe(false);
    const clip = samplesOf(fs.readFileSync(started.file));
    expect(clip.init.codec).toBe('avc1.64001f');
    // pre-roll 1 s = the GOP that started at frame 15
    expect(clip.samples).toHaveLength(SRC.samples.length - 15);
    expect(clip.samples[0].key).toBe(true);
    expect(clip.samples[0].dts).toBe(0);
    expect(clip.samples.map((s) => s.seq)).toEqual(clip.samples.map((_, i) => i + 1));
    expect(Buffer.compare(clip.samples[0].data, SRC.samples[15].data)).toBe(0);
    expect(info).toMatchObject({ id: ID, rel: started.rel, reason: 'event end' });
    expect(info.bytes).toBe(fs.statSync(started.file).size);
    expect(info.durationSec).toBeCloseTo((SRC.samples.length - 15) / 15, 1);
    expect(readBoxes(fs.readFileSync(started.file)).slice(0, 2).map((b) => b.type)).toEqual(['ftyp', 'moov']);
  });

  it('held from an event\'s start, the pre-roll counts back from the start, not from now (review: motion → person)', async () => {
    settings.preRollSec = 1;
    // without the hold: started at frame 45, the clip begins at the GOP of frame 30 or later
    const plain = make();
    plain.onInit(SRC.init);
    SRC.samples.forEach((s) => plain.onSample(s));
    const a = plain.start('20261010-140314-c3d4', { kind: 'person' });
    await plain.stop('20261010-140314-c3d4');
    const plainFirst = samplesOf(fs.readFileSync(a.file)).samples[0];
    expect(Buffer.compare(plainFirst.data, SRC.samples[15].data)).not.toBe(0);
    // held at frame 30 (the motion started), recorded at the end (it became a person)
    const r = make();
    r.onInit(SRC.init);
    SRC.samples.slice(0, 31).forEach((s) => r.onSample(s));
    r.holdPreRoll(true);
    SRC.samples.slice(31).forEach((s) => r.onSample(s));
    const { file } = r.start(ID, { kind: 'person' });
    r.holdPreRoll(false);
    await r.stop(ID);
    const clip = samplesOf(fs.readFileSync(file)).samples;
    expect(Buffer.compare(clip[0].data, SRC.samples[15].data)).toBe(0); // 1 s before frame 30
    expect(clip).toHaveLength(SRC.samples.length - 15);
    // released, the ring is trimmed back to the normal pre-roll
    expect(r._ring[0].startDts).toBeGreaterThan(SRC.samples[15].dts);
  });

  it('pre-roll granularity is one GOP; the memory cap keeps at least the newest GOP', async () => {
    settings.preRollSec = 0;
    const r = make();
    r.onInit(SRC.init);
    SRC.samples.slice(0, 40).forEach((s) => r.onSample(s));
    const { file } = r.start(ID, { kind: 'motion' });
    await r.stop(ID);
    expect(samplesOf(fs.readFileSync(file)).samples).toHaveLength(10); // frames 30..39
    settings.preRollSec = 15;
    const tiny = make({ maxRingBytes: 1000 });
    tiny.onInit(SRC.init);
    SRC.samples.slice(0, 40).forEach((s) => tiny.onSample(s));
    const b = tiny.start('20261010-140313-b2c3', { kind: 'motion' });
    await tiny.stop('20261010-140313-b2c3');
    expect(samplesOf(fs.readFileSync(b.file)).samples).toHaveLength(10);
  });

  it('a clip without a ring waits for the next keyframe; no stream → no clip', async () => {
    const r = make();
    expect(r.start(ID, { kind: 'person' })).toBeNull();
    r.onInit(SRC.init);
    const { file } = r.start(ID, { kind: 'person' });
    SRC.samples.slice(3).forEach((s) => r.onSample(s)); // frames 3.. : the first key is 15
    await r.stop(ID);
    const clip = samplesOf(fs.readFileSync(file));
    expect(clip.samples[0].key).toBe(true);
    expect(clip.samples).toHaveLength(SRC.samples.length - 15);
  });

  it('rolls over to a follow-up clip at maxClipSec on a keyframe, without a gap', async () => {
    settings.maxClipSec = 1;
    settings.preRollSec = 0;
    const clips = [];
    const r = make();
    r.on('clip-start', (c) => clips.push(c.rel));
    let t = new Date(2026, 9, 10, 14, 3, 30).getTime();
    r._now = () => (t += 1000);
    r.onInit(SRC.init);
    r.onSample(SRC.samples[0]);
    r.start(ID, { kind: 'person' });
    SRC.samples.slice(1).forEach((s) => r.onSample(s));
    await r.stop(ID);
    await waitFor(() => clips.every((rel) => fs.existsSync(path.join(dir, rel))));
    expect(clips.length).toBe(3);
    const counts = clips.map((rel) => samplesOf(fs.readFileSync(path.join(dir, rel))).samples.length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(SRC.samples.length);
    for (const rel of clips) expect(samplesOf(fs.readFileSync(path.join(dir, rel))).samples[0].dts).toBe(0);
    expect(new Set(clips).size).toBe(3);
    expect(clips.every((rel) => rel.endsWith('-person-a1b2.mp4'))).toBe(true);
  });

  it('a stream reconnect continues the event in a follow-up clip', async () => {
    const r = make();
    const clips = [];
    r.on('clip-start', (c) => clips.push(c.rel));
    r.onInit(SRC.init);
    SRC.samples.slice(0, 20).forEach((s) => r.onSample(s));
    r.start(ID, { kind: 'person' });
    r.onInit(SRC.init); // new generation
    SRC.samples.forEach((s) => r.onSample(s));
    await r.stop(ID);
    expect(clips).toHaveLength(2);
    expect(samplesOf(fs.readFileSync(path.join(dir, clips[1]))).samples).toHaveLength(SRC.samples.length);
  });

  it('a disk error ends the clip and is reported (the event stays)', async () => {
    const errors = [];
    const failing = { ...fs, write: (fd, buf, off, len, pos, cb) => cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })) };
    const r = make({ fs: /** @type {any} */ (failing) });
    r.on('error', (e) => errors.push(e.code));
    r.onInit(SRC.init);
    SRC.samples.slice(0, 20).forEach((s) => r.onSample(s));
    r.start(ID, { kind: 'person' });
    SRC.samples.slice(20).forEach((s) => r.onSample(s));
    const info = await r.stop(ID);
    expect(errors).toContain('ENOSPC');
    expect(info).toBeNull();
    expect(r.recording).toBe(false);
  });

  it('cannot create the folder → null and an error', () => {
    const errors = [];
    const r = make({ fs: /** @type {any} */ ({ ...fs, mkdirSync: () => { throw new Error('EACCES'); } }) });
    r.on('error', (e) => errors.push(e.message));
    r.onInit(SRC.init);
    expect(r.start(ID, { kind: 'person' })).toBeNull();
    expect(errors).toEqual(['EACCES']);
  });
});
