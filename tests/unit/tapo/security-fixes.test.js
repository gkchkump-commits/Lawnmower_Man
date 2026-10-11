// Regression tests for the security review (fixer round), at the service level: Claude never
// hears the camera's address, and an armed camera is never turned without a card.
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { FakeMessageChannelMain, FakeRelay, FakeSidecar, memorySafeStorage, tempSettings, until } from './helpers/fakes.js';
import { tmpDir } from '../helpers/tmp.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function service(o = {}) {
  const clips = tmpDir('lm-sec-clips-');
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: 1, username: 'camacct', name: 'front door camera' },
    security: { clipsDir: clips, armDelaySec: 0, ...(o.security || {}) },
  });
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  await credentials.setPassword('se&cret', { host: '127.0.0.1' });
  const svc = new TapoService({
    settings: store, credentials, paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: clips },
    deps: { MessageChannelMain: FakeMessageChannelMain, createSidecar: () => new FakeSidecar(), createRelay: () => new FakeRelay(), detector: 'stub' },
    env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' },
  });
  store.on('change', (n, p) => svc.applySettings(n, p));
  cleanup.push(() => svc.stop());
  return { svc, store };
}

describe('Claude and the camera', () => {
  it('camera_status on an unreachable camera does not tell Claude its address', async () => {
    const { svc } = await service();
    await svc.start();
    await until(() => svc.status().connection === 'unreachable', 10000);
    expect(svc.status().detail).toContain('127.0.0.1'); // the user's own status line may name it
    const res = await svc.mcpServer().handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'camera_status', arguments: {} } });
    const text = res.result.content.map((c) => c.text).join(' ');
    expect(text).toMatch(/not reachable/);
    expect(text).not.toContain('127.0.0.1');
  }, 20000);

  it('"always" may turn the camera without a card — but not while it is armed', async () => {
    const { svc } = await service({ security: { claudeSee: 'always', claudeMove: 'always' } });
    expect(svc.toolPermissions().allow).toEqual(expect.arrayContaining(['mcp__lawnmower-camera__camera_look', 'mcp__lawnmower-camera__camera_snapshot']));
    svc.arm({ armed: true, immediate: true });
    expect(svc.toolPermissions().allow).not.toContain('mcp__lawnmower-camera__camera_look');
    expect(svc.toolPermissions().allow).toContain('mcp__lawnmower-camera__camera_snapshot');
    svc.arm({ armed: false });
    expect(svc.toolPermissions().allow).toContain('mcp__lawnmower-camera__camera_look');
  });
});
