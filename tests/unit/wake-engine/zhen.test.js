import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ZhenManager, lastJsonLine, parseKwsReport } from '../../../electron/wake/zhen.js';

/** A fake Python: answers --check and the download from a script. */
function fakePython(script) {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    const step = script.shift() || { code: 1, stdout: '', stderr: 'no script' };
    if (step.hang) return child;
    setTimeout(() => {
      if (step.stdout) child.stdout.emit('data', Buffer.from(step.stdout));
      if (step.stderr) child.stderr.emit('data', Buffer.from(step.stderr));
      if (step.error) child.emit('error', new Error(step.error));
      else child.emit('close', step.code);
    }, 1);
    return child;
  };
  return { spawn, calls };
}

const report = (present, extra = {}) => `progress…\n${JSON.stringify({ modelsDir: '/m', ok: true, items: [], kws: { 'zh-en-3m': { dir: '/m/kws/zh-en-3m', present, downloaded: false, ...extra } } })}\n`;
const make = (script, o = {}) => {
  const py = fakePython(script);
  const z = new ZhenManager({
    locate: () => (o.noPython ? null : { python: '/venv/bin/python', cwd: '/app/voice' }),
    voiceEnabled: () => o.voiceOff !== true,
    env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
    spawn: py.spawn,
    ...o.zhen,
  });
  return { z, py };
};
const waitFor = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('ZhenManager (model A on the user\'s PC, contract §5.3)', () => {
  it('checks with --kws-only --check --json in the voice folder; present → ok', async () => {
    const { z, py } = make([{ code: 0, stdout: report(true) }]);
    expect(await z.check()).toBe('/m/kws/zh-en-3m');
    expect(z.state).toBe('ok');
    expect(z.modelsDir).toBe('/m');
    expect(py.calls[0].file).toBe('/venv/bin/python');
    expect(py.calls[0].args).toEqual(['-m', 'lawnmower_voice.download', '--kws-only', '--check', '--json']);
    expect(py.calls[0].opts.cwd).toBe('/app/voice');
    expect(py.calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(py.calls[0].opts.env.PYTHONUTF8).toBe('1');
  });

  it('absent → downloads once per app run in the background, then ready (B → A)', async () => {
    const { z, py } = make([{ code: 0, stdout: report(false) }, { code: 0, stdout: report(true, { downloaded: true }) }]);
    const ready = [];
    z.on('ready', (d) => ready.push(d));
    expect(await z.ensure()).toBeNull();
    expect(z.state).toBe('downloading');
    expect(py.calls[1].args).toEqual(['-m', 'lawnmower_voice.download', '--kws-only', '--json']);
    await waitFor(() => z.state !== 'downloading');
    expect(z.state).toBe('ok');
    expect(ready).toEqual(['/m/kws/zh-en-3m']);
    // a second ensure() this run does not download again
    const again = make([{ code: 0, stdout: report(false) }, { code: 1, stdout: report(false, { error: 'offline' }) }]);
    await again.z.ensure();
    await waitFor(() => again.z.state !== 'downloading');
    expect(again.z.state).toBe('failed');
    again.py.calls.length = 0;
    await again.z.ensure.call(Object.assign(again.z, { check: async () => null, state: 'missing' }));
    expect(again.py.calls).toHaveLength(0);
    expect(again.z.download({ auto: true })).toEqual({ ok: true, started: false });
  });

  it('a failed download → failed (Jade stays on model B); the retry button can start it again', async () => {
    const { z, py } = make([{ code: 1, stdout: report(false, { error: 'URLError: offline' }) }, { code: 0, stdout: report(true, { downloaded: true }) }]);
    z.state = 'missing';
    expect(z.download({ auto: true })).toEqual({ ok: true, started: true });
    expect(z.download()).toEqual({ ok: true, started: false }); // already running
    await waitFor(() => z.state !== 'downloading');
    expect(z.state).toBe('failed');
    expect(z.download()).toEqual({ ok: true, started: true }); // lm:wake:download
    await waitFor(() => z.state !== 'downloading');
    expect(z.state).toBe('ok');
    expect(py.calls).toHaveLength(2);
  });

  it('nothing runs while the voice is off or has no Python', async () => {
    const off = make([], { voiceOff: true });
    expect(await off.z.check()).toBeNull();
    expect(off.z.state).toBe('unavailable');
    expect(off.z.download()).toEqual({ ok: false, started: false });
    expect(off.py.calls).toHaveLength(0);
    const none = make([], { noPython: true });
    expect(await none.z.check()).toBeNull();
    expect(none.z.state).toBe('unavailable');
    expect(none.py.calls).toHaveLength(0);
  });

  it('garbage output or a crash → failed check, no download', async () => {
    const { z } = make([{ code: 1, stdout: 'Traceback…', stderr: 'ImportError: x' }]);
    expect(await z.ensure()).toBeNull();
    expect(z.state).toBe('failed');
    const spawnErr = make([{ error: 'ENOENT' }]);
    expect(await spawnErr.z.check()).toBeNull();
    expect(spawnErr.z.state).toBe('failed');
  });

  it('a hanging download is killed after the timeout', async () => {
    const { z } = make([{ hang: true }], { zhen: { downloadTimeoutMs: 20 } });
    z.state = 'missing';
    z.download();
    await waitFor(() => z.state !== 'downloading');
    expect(z.state).toBe('failed');
  });

  it('parses the downloader\'s report', () => {
    expect(lastJsonLine('a\n{"x":1}\n{bad\n')).toEqual({ x: 1 });
    expect(lastJsonLine('')).toBeNull();
    expect(parseKwsReport({ modelsDir: '/m', kws: { 'zh-en-3m': { dir: '/m/kws/zh-en-3m', present: true, downloaded: true } } }))
      .toEqual({ dir: '/m/kws/zh-en-3m', present: true, downloaded: true, modelsDir: '/m' });
    expect(parseKwsReport({ kws: {} })).toBeNull();
    expect(parseKwsReport(null)).toBeNull();
  });
});
