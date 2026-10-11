import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs, redactReport, runProbe, truncateSerial } from '../../../tools/tapo-probe.mjs';
import { startFakeOnvif } from './helpers/fake-onvif.js';
import { startMiniRtsp } from './helpers/mini-rtsp.js';

const CLIP = path.resolve('tests/unit/tapo/fixtures/clip-160x90.h264');
const SECRETS = /se&cret|se%26cret|se&amp;cret|camacct|127\.0\.0\.1|192\.168\.1\.50|2c3f0b1a99887766/;

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

async function camera(o = {}) {
  const cam = await startFakeOnvif(o.onvif);
  cleanup.push(() => cam.close());
  const rtsp = await startMiniRtsp({ file: CLIP, path: '/stream1', ...(o.rtsp || {}) });
  cleanup.push(() => rtsp.close());
  return { cam, rtsp };
}

/** @param {string[]} args @param {Record<string, string>} env */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/tapo-probe.mjs', ...args], { env: { PATH: process.env.PATH || '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('tapo-probe helpers', () => {
  it('arguments, serial and redaction', () => {
    expect(parseArgs(['--host', '192.168.1.50', '--user', 'camacct'])).toEqual({ host: '192.168.1.50', user: 'camacct', move: false, json: false, onvifPort: 2020, rtspPort: 554, help: false });
    expect(parseArgs(['--host', 'h', '--user', 'u', '--move', '--json', '--onvif-port', '8000', '--rtsp-port', '8554'])).toMatchObject({ move: true, json: true, onvifPort: 8000, rtspPort: 8554 });
    expect(parseArgs(['--help']).help).toBe(true);
    for (const bad of [[], ['--host', 'h'], ['--host', '--user', 'u'], ['--host', 'h', '--user', 'u', '--onvif-port', '0'], ['--host', 'h', '--user', 'u', '--password', 'x']]) {
      expect(() => parseArgs(bad), bad.join(' ')).toThrow();
    }
    expect(truncateSerial('2c3f0b1a99887766')).toBe('2c3f…');
    expect(truncateSerial(undefined)).toBe('');
    const r = redactReport({ a: 'rtsp://camacct:se&cret@192.168.1.50:554/stream1', b: 'se%26cret', c: 'se&amp;cret', d: 'host 10.0.0.7', fw: '1.5.4 Build 260702' }, { password: 'se&cret', username: 'camacct', hosts: ['10.0.0.7'] });
    expect(JSON.stringify(r)).not.toMatch(SECRETS);
    expect(r).toEqual({ a: 'rtsp://***:***@<ip>:554/stream1', b: '***', c: '***', d: 'host <camera>', fw: '1.5.4 Build 260702' });
  });
});

describe('runProbe', () => {
  it('reports every step, stream URIs, RTSP paths and one PullPoint round; --move pans right, back, and stops', async () => {
    const { cam, rtsp } = await camera();
    const report = await runProbe({ host: '127.0.0.1', user: 'camacct', password: 'se&cret', onvifPort: cam.port, rtspPort: rtsp.port, move: true, allowLoopback: true });
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => [s.id, s.ok])).toEqual([['host', true], ['tcp2020', true], ['clock', true], ['auth', true], ['services', true], ['profiles', true], ['ptz', true], ['events', true], ['rtsp', true]]);
    expect(report.device).toEqual({ manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', hardwareId: '2.0' });
    expect(report.serial).toBe('2c3f…');
    expect(report.streamUris.map((u) => u.uri)).toEqual(['rtsp://<ip>:554/stream1', 'rtsp://<ip>:554/stream2']);
    expect(report.rtspPaths.map((p) => [p.path, p.ok, p.status])).toEqual([['/stream1', true, 200], ['/stream2', false, 404], ['/stream8', false, 404]]);
    expect(report.rtspPaths[0].codecs).toEqual(['H264/90000']);
    expect(report.pullPoint).toMatchObject({ subscribed: true, unsubscribed: true });
    expect(typeof report.pullPoint.pulled).toBe('number');
    expect(report.move).toMatchObject({ ok: true, stopped: true });
    expect(report.move.steps.map((s) => s.x)).toEqual([0.2, -0.2]);
    // what the camera saw: the two moves, a Stop after them, and the subscription cancelled
    const ops = cam.calls.map((c) => c.op);
    const moves = cam.calls.filter((c) => c.op === 'RelativeMove');
    expect(moves.map((c) => c.args.x)).toEqual(['0.2', '-0.2']);
    expect(ops.lastIndexOf('Stop')).toBeGreaterThan(ops.lastIndexOf('RelativeMove'));
    expect(ops.filter((o) => o === 'Unsubscribe')).toHaveLength(1);
    expect(cam.state.ptz.x).toBeCloseTo(0, 5);
    // nothing secret in the report
    expect(JSON.stringify(report)).not.toMatch(SECRETS);
    expect(JSON.stringify(report)).toMatch(/<camera>/);
  });

  it('without --move nothing moves; a wrong password is tried once and the RTSP paths are not touched', async () => {
    const { cam, rtsp } = await camera();
    const ok = await runProbe({ host: '127.0.0.1', user: 'camacct', password: 'se&cret', onvifPort: cam.port, rtspPort: rtsp.port, allowLoopback: true });
    expect(ok.move).toBeUndefined();
    expect(cam.calls.some((c) => /Move/.test(c.op))).toBe(false);
    cam.calls.length = 0;
    const before = rtsp.log.requests.length;
    const bad = await runProbe({ host: '127.0.0.1', user: 'camacct', password: 'wrong-pass', onvifPort: cam.port, rtspPort: rtsp.port, allowLoopback: true });
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s) => s.id === 'auth')).toMatchObject({ ok: false, detail: 'The camera refused the user name or password.' });
    expect(bad.steps.filter((s) => s.ok === null).map((s) => s.id)).toEqual(['services', 'profiles', 'ptz', 'events', 'rtsp']);
    expect(cam.calls.filter((c) => c.op === 'GetDeviceInformation' && !c.authed).length).toBeLessThanOrEqual(2); // one attempt (+ one clock resync)
    expect(rtsp.log.requests.length).toBe(before);
    expect(bad.rtspPaths).toBeUndefined();
    expect(JSON.stringify(bad)).not.toMatch(/wrong-pass/);
  });
});

describe('tapo-probe CLI', () => {
  it('prints a redacted JSON report and exits 0; usage errors and a missing password exit 2', async () => {
    const { cam, rtsp } = await camera();
    const r = await runCli(['--host', '127.0.0.1', '--user', 'camacct', '--json', '--onvif-port', String(cam.port), '--rtsp-port', String(rtsp.port)], { TAPO_PASSWORD: 'se&cret', LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' });
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ tool: 'tapo-probe', ok: true, options: { move: false } });
    expect(r.stdout + r.stderr).not.toMatch(SECRETS);
    const text = await runCli(['--host', '127.0.0.1', '--user', 'camacct', '--onvif-port', String(cam.port), '--rtsp-port', String(rtsp.port)], { TAPO_PASSWORD: 'se&cret', LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' });
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/ok {3}Sign-in: Signed in to tp-link Tapo C211/);
    expect(text.stdout).toMatch(/Everything works\./);
    expect(text.stdout).not.toMatch(SECRETS);
    // a loopback camera without the test switch is refused (LAN only)
    const lan = await runCli(['--host', '127.0.0.1', '--user', 'camacct', '--onvif-port', String(cam.port)], { TAPO_PASSWORD: 'se&cret' });
    expect(lan.code).toBe(1);
    expect(lan.stdout).toMatch(/FAIL Camera address/);
    const usage = await runCli(['--host', '127.0.0.1'], {});
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/--host and --user are required/);
    const nopw = await runCli(['--host', '127.0.0.1', '--user', 'camacct'], {});
    expect(nopw.code).toBe(2);
    expect(nopw.stderr).toMatch(/TAPO_PASSWORD/);
  }, 30000);
});
