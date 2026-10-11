// Regression tests for low findings (fixer round), at the service level: an ended event keeps its
// duration in the list row and the player, and a clip that finishes after its event ended is no
// new "update" of a live event (the camera window toasted it as "seen just now" again), and a
// calibration measurement that comes too late makes the wizard ask instead of fail.
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { MAX_CHUNKS_BEHIND, SHIFT_REF_TIMEOUT_MS, SHIFT_SLACK_MS, TapoService } from '../../../electron/tapo/tapo-service.js';
import { FakeRelay, FakeSidecar, memorySafeStorage, tempSettings } from './helpers/fakes.js';
import { tmpDir } from '../helpers/tmp.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function offlineService(now) {
  const clips = tmpDir('lm-low-');
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', username: 'camacct', name: 'camera' },
    security: { armDelaySec: 0, postRollSec: 10, cooldownSec: 60, clipsDir: clips, cameraEvents: false, confirmLocally: false },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  const service = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: { alerts: { notify: () => true }, createSidecar: () => new FakeSidecar(), createRelay: () => new FakeRelay(), detector: 'stub' },
    env: {}, now,
  });
  cleanup.push(() => service.stop());
  await service.store.scan();
  const events = [];
  service.on('security-event', (e) => events.push(e));
  return { service, events };
}

describe('an ended event', () => {
  it('carries its duration, and its clip finishing later is reported as "end", with the bytes', async () => {
    let now = Date.parse('2026-10-10T14:00:00Z');
    const { service, events } = await offlineService(() => now);
    service.engine.onStream('live', now - 60_000);
    service.arm({ armed: true, immediate: true });
    service._apply(service.engine.onCamera({ kind: 'person', active: true, at: now }));
    const id = events[0].event.id;
    service._onClipStart({ id, rel: `2026-10-10/140000-person-${id.slice(-4)}.mp4` });
    now += 4000;
    service._apply(service.engine.onCamera({ kind: 'person', active: false, at: now }));
    now += 10_500;
    service._apply(service.engine.tick(now));
    const end = events.find((e) => e.phase === 'end');
    expect(end.event.durationSec).toBeCloseTo(14.5, 1);
    await new Promise((r) => setTimeout(r, 50)); // the store writes
    events.length = 0;
    service._onClipEnd({ id, rel: `2026-10-10/140000-person-${id.slice(-4)}.mp4`, bytes: 123_456 });
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('end');
    expect(events[0].event).toMatchObject({ id, bytes: 123_456, durationSec: 14.5 });
  });

  it('a clip that ends while its event goes on (a long visit, split clips) is an "update"', async () => {
    let now = Date.parse('2026-10-10T15:00:00Z');
    const { service, events } = await offlineService(() => now);
    service.engine.onStream('live', now - 60_000);
    service.arm({ armed: true, immediate: true });
    service._apply(service.engine.onCamera({ kind: 'person', active: true, at: now }));
    const id = events[0].event.id;
    events.length = 0;
    now += 1000;
    service._onClipEnd({ id, rel: `2026-10-10/150000-person-${id.slice(-4)}.mp4`, bytes: 10 });
    expect(events.map((e) => e.phase)).toEqual(['update']);
  });
});

describe('calibration on a busy PC', () => {
  it('a picture measurement that comes too late is "not measurable" (the wizard asks), not a failed calibration', async () => {
    const { service } = await offlineService(() => Date.now());
    const sent = [];
    service._port = { postMessage: (m) => sent.push(m), close() {} }; // a worker that never answers
    expect(service._shiftSlackMs).toBe(SHIFT_SLACK_MS);
    expect(SHIFT_SLACK_MS).toBeGreaterThanOrEqual(20_000); // a worker stalled ~16 s still answers in time
    service._shiftSlackMs = 300; // (the test does not wait 25 s)
    const t0 = Date.now();
    const r = await service._shiftMeasure(100, true);
    expect(r).toEqual({ dx: 0, dy: 0, score: 0, settledMs: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100 + 300 - 50);
    expect(sent).toEqual([expect.objectContaining({ t: 'shift-measure', timeoutMs: 100, expectMove: true })]);
    service._port = null;
    await expect(service._shiftMeasure(100)).rejects.toThrow(/camera window is not running/);
  }, 15_000);
});

describe('calibration: the reference picture', () => {
  // (updated on purpose for the gated protocol: a worker that never answers used to mean "go on
  // and let the measurement decide"; now it means "no reference", and the wizard measures nothing)
  it('main moves the camera only once the worker has a still reference; a worker that never answers gives none', async () => {
    const { service } = await offlineService(() => Date.now());
    service.relay.state = 'live';
    const sent = [];
    let answer = null;
    const port = { postMessage: (m) => { sent.push(m); if (m.t === 'shift-ref') answer = m; }, close() {} };
    service._port = port;
    let done = null;
    const p = service._shiftRef(1234.5).then((r) => { done = r; });
    await new Promise((r) => setTimeout(r, 600));
    expect(sent.map((m) => m.t)).toContain('shift-ref');
    expect(answer.after).toBe(1234.5); // only pictures that reached main after the last move
    expect(done).toBe(null); // still waiting for the worker
    service._onWorkerMessage(port, { t: 'shift-ref-ok', id: answer.id, gated: true, ok: true, still: true, at: 1300 });
    await p;
    expect(done).toEqual({ ok: true, at: 1300, still: true });
    // a worker that never answers: no reference after the timeout
    expect(SHIFT_REF_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    service._shiftRefTimeoutMs = 300;
    const t0 = Date.now();
    expect(await service._shiftRef(2000)).toEqual({ ok: false, reason: 'The camera picture did not arrive in time.' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300 + 300 - 50);
  }, 15_000);
});

describe('a PC that cannot decode in real time', () => {
  it('main stops sending video chunks once the worker is MAX_CHUNKS_BEHIND behind, and resumes at a key frame', async () => {
    const { service } = await offlineService(() => Date.now());
    const sent = [];
    const port = { postMessage: (m) => sent.push(m), close() {} };
    service._port = port;
    service._flow = { seq: 0, acked: 0, acks: false, skipping: false, dropped: 0 };
    let n = 0;
    const sample = () => {
      const i = n++;
      service._onSample({ gen: 1, key: i % 15 === 0, pts: i * 6000, duration: 6000, data: Buffer.alloc(8), fragIndex: 0 });
    };
    const chunks = () => sent.filter((m) => m.t === 'chunk');
    // a worker that never acknowledges (an older one): everything goes out, as before
    for (let i = 0; i < 40; i++) sample();
    expect(chunks()).toHaveLength(40);
    // a worker that acknowledges, then falls behind
    service._onWorkerMessage(port, { t: 'ack', seq: 40 });
    for (let i = 0; i < 60; i++) sample(); // nothing acknowledged meanwhile
    const after = chunks().slice(40);
    expect(after.length).toBeLessThanOrEqual(MAX_CHUNKS_BEHIND + 1);
    expect(service._flow.dropped).toBeGreaterThan(30);
    // it catches up: the next chunk sent is a key frame
    service._onWorkerMessage(port, { t: 'ack', seq: service._flow.seq });
    const before = chunks().length;
    while (chunks().length === before) sample();
    expect(chunks().at(-1).key).toBe(true);
    sample();
    expect(chunks().at(-1).key).toBe(false); // and the deltas after it again
    // an acknowledgement from the future is ignored
    service._onWorkerMessage(port, { t: 'ack', seq: 1e9 });
    expect(service._flow.acked).toBeLessThanOrEqual(service._flow.seq);
  });
});
