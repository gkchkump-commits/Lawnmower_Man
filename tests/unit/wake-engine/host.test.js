import { describe, it, expect } from 'vitest';
import { WakeHost, minimalEnv, SERVICE_NAME } from '../../../electron/wake/host.js';
import { fakeChannel, fakeClock, fakeUtilityProcess, fakeWebContents } from './fakes.js';

const init = { addon: '/w/sherpa-onnx.node', models: { giga: {}, vad: '/w/vad.onnx', zhen: null }, params: { sensitivity: 'normal', phrase: 'hey-jade' } };
const tick = () => new Promise((r) => setTimeout(r, 0));

function make(o = {}) {
  const up = fakeUtilityProcess();
  const clock = fakeClock();
  const logs = [];
  const host = new WakeHost({
    utilityProcess: up, MessageChannelMain: fakeChannel(), entry: '/app/electron/wake/utility/main.js',
    env: { PATH: '/bin', SystemRoot: 'C:\\Windows', TEMP: '/tmp', HOME: '/home/ada', LAWNMOWER_E2E: '1', LAWNMOWER_VOICE_TOKEN: 'x', ANTHROPIC_API_KEY: 'k', LAWNMOWER_TAPO_PASSWORD: 'p' },
    log: (l, m) => logs.push(`${l} ${m}`), now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...o,
  });
  return { host, up, clock, logs };
}

describe('WakeHost (utility supervision, contract §7.2)', () => {
  it('forks "Jade wake word" with a minimal environment and sends init; ready → ready', () => {
    const { host, up } = make();
    host.start(init);
    expect(up.forks).toHaveLength(1);
    const f = up.forks[0];
    expect(f.entry).toBe('/app/electron/wake/utility/main.js');
    expect(f.opts).toMatchObject({ serviceName: SERVICE_NAME, stdio: 'pipe' });
    expect(Object.keys(f.opts.env).sort()).toEqual(['LAWNMOWER_E2E', 'PATH', 'SystemRoot', 'TEMP']);
    expect(f.child.posted[0].m).toMatchObject({ t: 'init', addon: '/w/sherpa-onnx.node' });
    expect(host.state).toBe('starting');
    f.child.ready(['giga'], 2500);
    expect(host.state).toBe('ready');
    expect(host.models).toEqual(['giga']);
    expect(host.loadMs).toBe(2500);
  });

  it('no ready within 15 s → error "did not start", then the restart backoff', async () => {
    const { host, up, clock } = make();
    host.start(init);
    clock.advance(15000);
    expect(host.state).toBe('error');
    expect(host.detail).toBe('The wake-word engine did not start.');
    expect(up.forks[0].child.killed).toBe(true);
    await tick(); // the exit
    expect(host.state).toBe('starting');
    clock.advance(1000);
    expect(up.forks).toHaveLength(2);
  });

  it('a utility that reports its stages gets 20 s per stage, at most 60 s in all; the kill says where it was stuck', async () => {
    const { host, up, clock, logs } = make();
    host.start(init);
    const c = up.forks[0].child;
    clock.advance(10000);
    c.emit('message', { t: 'stage', s: 'started' });
    c.emit('message', { t: 'stage', s: 'addon' });
    clock.advance(12000); // 22 s after the fork: past the old 15 s, still loading
    c.emit('message', { t: 'stage', s: 'models' });
    expect(host.stage).toBe('models');
    clock.advance(19000); // 41 s
    expect(host.state).toBe('starting');
    expect(c.killed).toBeFalsy();
    clock.advance(1000); // 20 s after the last stage
    expect(host.state).toBe('error');
    expect(c.killed).toBe(true);
    expect(logs.join('\n')).toMatch(/stuck in stage 'models' after 42 s/);
    await tick(); // the exit
    expect(host.lastExit).toMatchObject({ stage: 'models', timedOut: true });
    expect(logs.join('\n')).toMatch(/exited \(code .*killed by us in stage 'models'\)/);
    expect(host.stage).toBe('off');
    // the cap: a stage every 14 s cannot keep a process alive past 60 s
    clock.advance(1000);
    const d = up.forks[1].child;
    for (let i = 0; i < 4; i++) {
      clock.advance(14000);
      d.emit('message', { t: 'stage', s: 'models' });
    }
    expect(d.killed).toBeFalsy(); // 56 s
    clock.advance(4000); // 60 s after this fork
    expect(d.killed).toBe(true);
  });

  it('a ready after slow stages is ready; bad stage names are ignored; a crash is logged with its code in hex', async () => {
    const { host, up, clock, logs } = make();
    host.start(init);
    const c = up.forks[0].child;
    c.emit('message', { t: 'stage', s: 'started' });
    c.emit('message', { t: 'stage', s: 'x'.repeat(40) });
    c.emit('message', { t: 'stage', s: 7 });
    expect(host.stage).toBe('started');
    clock.advance(18000);
    c.ready(['giga'], 17000);
    expect(host.state).toBe('ready');
    expect(host.stage).toBe('ready');
    clock.advance(25000); // past every ready deadline (the liveness check, 30 s, is separate)
    expect(c.killed).toBeFalsy();
    c.emit('message', { t: 'stage', s: 'models' }); // after ready: ignored
    expect(host.stage).toBe('ready');
    c.emit('exit', 3221225477);
    expect(host.lastExit).toMatchObject({ code: 3221225477, stage: 'ready', timedOut: false });
    expect(logs.join('\n')).toMatch(/exited \(code 3221225477, 0xc0000005; in stage 'ready'\)/);
  });

  it('restarts after 1 s, 5 s, then 30 s; at most 5 in 10 minutes', async () => {
    const { host, up, clock } = make();
    host.start(init);
    up.last.ready();
    const delays = [];
    for (let i = 0; i < 5; i++) {
      up.last.kill();
      await tick();
      const before = up.forks.length;
      let waited = 0;
      while (up.forks.length === before && waited < 60000) {
        clock.advance(100);
        waited += 100;
      }
      delays.push(waited);
      up.last.ready();
    }
    expect(delays).toEqual([1000, 5000, 30000, 30000, 30000]);
    expect(host.restarts).toBe(5);
    // the sixth crash within 10 minutes: no more restarts
    up.last.kill();
    await tick();
    expect(host.state).toBe('error');
    expect(host.detail).toBe('The wake-word engine keeps stopping; see the log.');
    clock.advance(120000);
    expect(up.forks).toHaveLength(6);
  });

  it('a crash after the 10-minute window has passed is restarted again', async () => {
    const { host, up, clock } = make();
    host.start(init);
    for (let i = 0; i < 5; i++) {
      up.last.ready();
      up.last.kill();
      await tick();
      clock.advance(31000);
    }
    up.last.ready();
    clock.advance(11 * 60 * 1000);
    up.last.kill();
    await tick();
    expect(host.state).toBe('starting');
    clock.advance(1000);
    expect(up.forks).toHaveLength(7);
  });

  it('a frozen (not crashed) utility: no answer for 30 s → killed and restarted like a crash (never "ready" while deaf)', async () => {
    const { host, up, clock, logs } = make();
    host.start(init);
    up.last.ready();
    const child = up.last;
    // it answers main's pings for a while
    child.postMessage = function (m, ports) {
      this.posted.push({ m, ports });
      if (m?.t === 'ping' && !this.frozen) queueMicrotask(() => this.emit('message', { t: 'pong', n: m.n }));
    };
    for (let i = 0; i < 6; i++) {
      clock.advance(10000);
      await tick();
    }
    expect(host.state).toBe('ready');
    expect(child.posted.filter((p) => p.m.t === 'ping').length).toBeGreaterThanOrEqual(5);
    child.frozen = true; // SIGSTOP, a deadlock in the addon…
    for (let i = 0; i < 4; i++) {
      clock.advance(10000);
      await tick();
    }
    expect(child.killed).toBe(true);
    expect(host.hung).toBe(1);
    expect(logs.some((l) => /has not answered for/.test(l))).toBe(true);
    await tick();
    expect(host.state).toBe('starting');
    clock.advance(1000);
    expect(up.forks).toHaveLength(2); // the normal backoff restart
  });

  it('a process that ignores the kill (stopped) is killed hard after 2 s', async () => {
    const killed = [];
    const { host, up, clock } = make({ killPid: (pid) => killed.push(pid), livenessMs: 15000 });
    host.start(init);
    up.last.ready();
    const child = up.last;
    child.kill = () => { child.killed = true; return true; }; // SIGTERM is pending: no exit
    clock.advance(20000);
    expect(child.killed).toBe(true);
    clock.advance(2000);
    expect(killed).toEqual([child.pid]);
  });

  it('retry() after "keeps stopping" starts a new process with a fresh restart budget; so does start()', async () => {
    const { host, up, clock } = make({ maxRestarts: 1 });
    host.start(init);
    up.last.ready();
    up.last.kill();
    await tick();
    clock.advance(1000);
    up.last.ready();
    up.last.kill();
    await tick();
    expect(host.state).toBe('error');
    expect(host.detail).toMatch(/keeps stopping/);
    host.retry();
    expect(up.forks).toHaveLength(3);
    up.last.ready();
    expect(host.state).toBe('ready');
    // the next crash is restarted again (a fresh budget), not "keeps stopping" at once
    up.last.kill();
    await tick();
    expect(host.state).toBe('starting');
    clock.advance(1000);
    expect(up.forks).toHaveLength(4);
    up.last.ready();
    up.last.kill();
    await tick();
    expect(host.state).toBe('error');
    host.start(init); // turning the wake word on again: fresh budget too
    up.last.ready();
    up.last.kill();
    await tick();
    expect(host.state).toBe('starting');
  });

  it('a fatal init error is not retried', async () => {
    const { host, up, clock } = make();
    host.start(init);
    up.last.emit('message', { t: 'error', fatal: true, message: 'the sherpa-onnx addon lacks createKeywordSpotter' });
    expect(host.state).toBe('error');
    expect(host.detail).toMatch(/could not start: the sherpa-onnx addon lacks/);
    up.last.kill();
    await tick();
    clock.advance(60000);
    expect(up.forks).toHaveLength(1);
    expect(host.state).toBe('error');
  });

  it('connect(): a fresh channel per request, port1 to the avatar, port2 to the utility, gen grows', () => {
    const { host, up } = make();
    const wc = fakeWebContents();
    expect(host.connect(wc)).toEqual({ ok: false, gen: 0 }); // not running: remembered for later
    host.start(init);
    expect(wc.sent).toHaveLength(1); // the fork handed it a port by itself
    expect(wc.sent[0]).toMatchObject({ channel: 'lm:wake:port', payload: { gen: 1 } });
    up.last.ready();
    const r = host.connect(wc);
    expect(r).toEqual({ ok: true, gen: 2 });
    const [a, b] = [wc.sent[0].ports[0], wc.sent[1].ports[0]];
    expect(a).not.toBe(b);
    const toUtility = up.last.posted.filter((p) => p.m.t === 'port');
    expect(toUtility.map((p) => p.m.gen)).toEqual([1, 2]);
    expect(toUtility[1].ports[0].id).toBe(b.id.replace('p1', 'p2'));
  });

  it('after a crash the renderer that asked gets a new port (new gen) by itself', async () => {
    const { host, up, clock } = make();
    const wc = fakeWebContents();
    host.start(init);
    up.last.ready();
    host.connect(wc);
    const gen = host.gen;
    up.last.kill();
    await tick();
    clock.advance(1000);
    expect(wc.sent[wc.sent.length - 1].payload.gen).toBe(gen + 1);
    expect(up.last.posted.some((p) => p.m.t === 'port' && p.m.gen === gen + 1)).toBe(true);
  });

  it('stop() is bounded: { t:"stop" }, then kill after 2 s', async () => {
    const { host, up, clock } = make();
    host.start(init);
    up.last.ready();
    const child = up.last;
    const p = host.stop();
    expect(child.posted.some((x) => x.m.t === 'stop')).toBe(true);
    clock.advance(2000);
    await p;
    expect(child.killed).toBe(true);
    expect(host.state).toBe('off');
    clock.advance(60000);
    expect(up.forks).toHaveLength(1); // a stop is not a crash
  });

  it('stop() returns as soon as the utility exits', async () => {
    const { host, up } = make();
    host.start(init);
    up.last.onStop = () => up.last.emit('exit', 0);
    await host.stop();
    expect(host.state).toBe('off');
    expect(up.last.killed).toBe(false);
  });

  it('restart(init) replaces the process without counting it as a crash; stats and hits are kept', async () => {
    const { host, up } = make();
    host.start(init);
    up.last.ready(['giga']);
    up.last.emit('message', { t: 'stats', cpuMsPerSecSpeech: 70, activeSec: 3, hits: [{ id: 1, keyword: 'HEY_JADE' }] });
    expect(host.lastHits).toEqual([{ id: 1, keyword: 'HEY_JADE' }]);
    host.restart({ ...init, models: { ...init.models, zhen: { encoder: 'e' } } });
    await tick();
    expect(up.forks).toHaveLength(2);
    expect(host.restarts).toBe(0);
    expect(up.forks[1].child.posted[0].m.models.zhen).toEqual({ encoder: 'e' });
  });

  it('sendSettings() reaches the running utility and the next init', () => {
    const { host, up } = make();
    host.start(init);
    host.sendSettings({ sensitivity: 'high', phrase: 'jade' });
    expect(up.last.posted.at(-1).m).toEqual({ t: 'settings', params: { sensitivity: 'high', phrase: 'jade' } });
    expect(host._init.params).toEqual({ sensitivity: 'high', phrase: 'jade' });
  });

  it('logs the utility\'s output with a [wake] prefix, rate-limited', () => {
    const { host, up, logs } = make();
    host.start(init);
    up.last.stdout.emit('data', Buffer.from('hello\n[wake] thresholds now zhen 0.1\n'));
    expect(logs).toContain('info [wake] hello');
    expect(logs).toContain('info [wake] thresholds now zhen 0.1');
    up.last.stderr.emit('data', Buffer.from(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')));
    expect(logs.filter((l) => /\[wake\] line/.test(l)).length).toBeLessThanOrEqual(40);
  });
});

describe('minimalEnv', () => {
  it('keeps PATH, SystemRoot, TEMP/TMP and LAWNMOWER_* without secrets', () => {
    expect(minimalEnv({ Path: 'C:\\x', SYSTEMROOT: 'C:\\Windows', TMP: 't', USERPROFILE: 'u', LAWNMOWER_WAKE_DIR: 'w', LAWNMOWER_MCP_TOKEN: 's', LAWNMOWER_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o' }))
      .toEqual({ Path: 'C:\\x', SYSTEMROOT: 'C:\\Windows', TMP: 't', LAWNMOWER_WAKE_DIR: 'w' });
  });

  it('on Windows also the system variables (folders, CPU facts), still nothing about the user and no secrets', () => {
    const env = {
      Path: 'C:\\x', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', ProgramData: 'C:\\ProgramData', 'ProgramFiles(x86)': 'C:\\P86',
      NUMBER_OF_PROCESSORS: '4', PROCESSOR_ARCHITECTURE: 'AMD64', DriverData: 'C:\\Windows\\System32\\Drivers\\DriverData', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\ada', APPDATA: 'a', LOCALAPPDATA: 'l', USERNAME: 'ada', COMPUTERNAME: 'PC', ANTHROPIC_API_KEY: 'k', LAWNMOWER_MCP_TOKEN: 's',
    };
    expect(Object.keys(minimalEnv(env, 'win32')).sort()).toEqual(['ComSpec', 'DriverData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'Path', 'ProgramData', 'ProgramFiles(x86)', 'SystemDrive', 'SystemRoot', 'windir']);
    expect(Object.keys(minimalEnv(env, 'linux')).sort()).toEqual(['Path', 'SystemRoot']);
  });
});
