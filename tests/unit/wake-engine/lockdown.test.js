// The utility's in-process guard (electron/wake/utility/lockdown.js): imported first, it refuses
// the Node modules that reach the network or run processes and removes the network globals.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCKED_MODULES, isBlocked } from '../../../electron/wake/utility/lockdown.js';
import { checkPcm } from '../../../electron/wake/utility/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the wake-word utility opens no sockets (in-process guard)', () => {
  it('is the first import of utility/main.js', () => {
    const src = fs.readFileSync(path.join(root, 'electron/wake/utility/main.js'), 'utf8');
    const imports = [...src.matchAll(/^import .*?['"](.+?)['"];/gm)].map((m) => m[1]);
    expect(imports[0]).toBe('./lockdown.js');
  });

  it('blocks net, http(s), dgram, tls, child_process, workers and the inspector; keeps fs, v8, vm', () => {
    for (const m of ['net', 'node:net', 'http', 'https', 'node:http2', 'dgram', 'tls', 'dns', 'child_process', 'node:worker_threads', 'inspector', 'dns/promises']) expect(isBlocked(m), m).toBe(true);
    for (const m of ['fs', 'node:fs', 'node:v8', 'vm', 'node:module', 'events', 'path']) expect(isBlocked(m), m).toBe(false);
    expect(BLOCKED_MODULES).toContain('net');
  });

  it('in a fresh Node process: require and import of them fail, fetch is gone, the addon path (process.dlopen) stays', () => {
    const probe = `
      import { lockdown } from ${JSON.stringify(pathToFileURL(path.join(root, 'electron/wake/utility/lockdown.js')).href)};
      import { createRequire } from 'node:module';
      lockdown();
      const req = createRequire(import.meta.url);
      const out = {};
      for (const m of ['node:net', 'http', 'node:child_process', 'node:fs']) { try { req(m); out[m] = 'ok'; } catch { out[m] = 'blocked'; } }
      try { await import('node:dgram'); out.dgram = 'ok'; } catch { out.dgram = 'blocked'; }
      try { process.binding('tcp_wrap'); out.binding = 'ok'; } catch { out.binding = 'blocked'; }
      out.fetch = typeof globalThis.fetch;
      out.dlopen = typeof process.dlopen;
      console.log(JSON.stringify(out));`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }).trim());
    expect(r).toEqual({ 'node:net': 'blocked', http: 'blocked', 'node:child_process': 'blocked', 'node:fs': 'ok', dgram: 'blocked', binding: 'blocked', fetch: 'undefined', dlopen: 'function' });
  });

  it('a pcm frame must be a whole Float32Array (a view of a 4 MB buffer would be copied whole)', () => {
    const big = new Float32Array(1024 * 1024);
    expect(checkPcm({ pcm: big.subarray(0, 4096), at: 0 }, null)).toMatchObject({ ok: false });
    expect(checkPcm({ pcm: new Float32Array(4096), at: 0 }, null)).toEqual({ ok: true });
  });
});
