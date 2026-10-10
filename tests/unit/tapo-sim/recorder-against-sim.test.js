// Integration: an event clip recorded from the real chain (simulator RTSP → go2rtc → StreamRelay
// → ClipRecorder, contract §8.7) while someone walks in front of the camera: the clip starts
// with the pre-roll ring at a keyframe (≥ 4 s before the event), parses with the app's own fMP4
// parser, its timeline starts at 0 and it shows the person segment. Skipped unless lane A's
// modules and the go2rtc binary are present.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { ROOT, laneModules, sleep, until } from './helpers.js';

const lane = await laneModules(['electron/tapo/go2rtc.js', 'electron/tapo/stream-relay.js', 'electron/tapo/recorder.js', 'electron/tapo/fmp4.js']);
const g2r = lane.mods['electron/tapo/go2rtc.js'];
const binary = g2r ? g2r.go2rtcBinaryPath({ isPackaged: false, resourcesPath: '', appRoot: ROOT, platform: process.platform, arch: process.arch, env: process.env }) : '';
const haveBinary = !!binary && fs.existsSync(binary);
const reason = lane.reason || (haveBinary ? '' : ` [SKIPPED: no go2rtc binary at ${binary || 'vendor/go2rtc'} (npm run fetch:go2rtc)]`);

describe.skipIf(!lane.ok || !haveBinary)(`event clip from go2rtc × simulator${reason}`, () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {any} */
  let sidecar;
  /** @type {any} */
  let relay;
  /** @type {string} */
  let dir;
  beforeAll(async () => {
    sim = await startSim();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rec-sim-'));
    sidecar = new g2r.Go2rtcSidecar({ binary, configDir: dir, log: () => {} });
    const ep = await sidecar.start({ host: '127.0.0.1', rtspPort: sim.rtspPort, stream: 'stream1', camUser: 'camacct', camPass: 'se&cret' });
    relay = new lane.mods['electron/tapo/stream-relay.js'].StreamRelay({ getEndpoint: () => ep, log: () => {} });
  });
  afterAll(async () => {
    relay?.setNeeded(false, 'test end');
    relay?.stop?.();
    await sidecar?.stop();
    await sim?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a person event → a clip with ≥ 4 s of pre-roll from a keyframe, readable, timeline from 0', async () => {
    const clips = path.join(dir, 'clips');
    const rec = new lane.mods['electron/tapo/recorder.js'].ClipRecorder({
      getDir: () => clips, getSettings: () => ({ preRollSec: 5, postRollSec: 3, maxClipSec: 120, record: 'person' }), log: () => {},
    });
    relay.on('init', (/** @type {any} */ i) => rec.onInit(i));
    relay.on('sample', (/** @type {any} */ s) => rec.onSample(s));
    relay.setNeeded(true, 'armed');
    await sleep(7500); // the ring fills (5 s pre-roll at GOP granularity)
    sim.set({ person: true });
    const started = Date.now();
    const now = new Date(started);
    const p2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const id = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}-a1b2`;
    expect(rec.start(id, { kind: 'person', startedAt: started })).toMatchObject({ file: expect.stringContaining('person') });
    await sleep(3000);
    sim.set({ person: false });
    const info = await rec.stop(id, { reason: 'test' });
    expect(info).toBeTruthy();
    const file = info.file;
    expect(file).toMatch(/\d{6}-person-[a-z0-9]{4}\.mp4$/);
    expect(fs.existsSync(`${file}.part`)).toBe(false);

    // read it back with the app's parser
    const { Fmp4Parser } = lane.mods['electron/tapo/fmp4.js'];
    const parser = new Fmp4Parser();
    /** @type {any[]} */
    const samples = [];
    /** @type {any} */
    let init = null;
    parser.on('init', (/** @type {any} */ i) => { init = i; });
    parser.on('sample', (/** @type {any} */ s) => samples.push(s));
    parser.push(fs.readFileSync(file));
    parser.end();
    expect(init).toMatchObject({ width: 640, height: 360 });
    expect(samples[0].key).toBe(true);
    expect(samples[0].dts).toBe(0);
    const last = samples.at(-1);
    const durationSec = (last.dts + last.duration) / init.timescale;
    expect(durationSec).toBeGreaterThan(4 + 2.5); // pre-roll ≥ 4 s + the ~3 s of the event
    // the person was in view while it recorded
    await until(() => sim.state.rtspSessions.live[0]?.segments.some((/** @type {any} */ s) => s.id === 'p0_t0_person'), { timeout: 1000 });
  }, 40_000);
});
