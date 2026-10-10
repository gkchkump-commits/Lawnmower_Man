// Regression tests for low findings (fixer round), at the service level: an ended event keeps its
// duration in the list row and the player, and a clip that finishes after its event ended is no
// new "update" of a live event (the camera window toasted it as "seen just now" again).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { FakeRelay, FakeSidecar, memorySafeStorage, tempSettings } from './helpers/fakes.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function offlineService(now) {
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-low-'));
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
