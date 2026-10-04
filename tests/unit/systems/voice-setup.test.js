// "Set up local voice…": electron/voice-setup.js (launcher, polling, quoting) and the real
// setup scripts in -CheckOnly / --check-only mode in a packaged layout whose path has spaces,
// non-ASCII letters and cmd.exe metacharacters — the per-user voice folder the script reports
// must be the one the sidecar looks in (voiceVenvDirs / packagedVoiceHome).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LINUX_TERMINALS,
  VoiceSetupRunner,
  WINDOWS_LAUNCHER,
  WINDOWS_SETUP_BOOTSTRAP,
  describeEarlyExit,
  describeSetupFailure,
  findLinuxTerminal,
  manualSetupCommand,
  quoteWindowsArg,
  readSetupStatus,
  setupScriptArgs,
  setupScriptPath,
  windowsSetupLaunch,
} from '../../../electron/voice-setup.js';
import { packagedVoiceHome, voiceVenvDirs } from '../../../electron/voice-sidecar.js';
import { findOnPath } from '../../../electron/claude-path.js';

const ROOT = path.resolve('.');
const tmpDirs = [];
const tmp = (prefix = 'lm-vsetup-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** CommandLineToArgvW / MSVCRT (2008+) parsing, to prove quoteWindowsArg round-trips. */
function parseWindowsCommandLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2) arg += '"';
          else quoted = !quoted;
        } else {
          arg += '\\'.repeat(n);
          i--;
        }
      } else if (c === '"') {
        if (quoted && line[i + 1] === '"') { arg += '"'; i++; } else quoted = !quoted;
      } else if (!quoted && (c === ' ' || c === '\t')) {
        break;
      } else {
        arg += c;
      }
    }
    out.push(arg);
  }
  return out;
}

describe('setup script location and arguments', () => {
  it('uses resources/scripts when packaged and scripts/ in a checkout', () => {
    expect(setupScriptPath({ platform: 'win32', packaged: true, resourcesPath: 'C:\\Users\\José\\AppData\\Local\\Programs\\Lawnmower Man\\resources', appRoot: 'x' }))
      .toBe('C:\\Users\\José\\AppData\\Local\\Programs\\Lawnmower Man\\resources\\scripts\\setup-voice.ps1');
    expect(setupScriptPath({ platform: 'win32', packaged: false, appRoot: 'D:\\src\\Lawnmower_Man' })).toBe('D:\\src\\Lawnmower_Man\\scripts\\setup-voice.ps1');
    expect(setupScriptPath({ platform: 'linux', packaged: true, resourcesPath: '/tmp/.mount_x/resources', appRoot: '/x' })).toBe('/tmp/.mount_x/resources/scripts/setup-voice.sh');
    expect(setupScriptPath({ platform: 'linux', packaged: false, appRoot: '/home/u/lm' })).toBe('/home/u/lm/scripts/setup-voice.sh');
  });

  it('builds the script switches', () => {
    expect(setupScriptArgs({ platform: 'win32', cpu: true, statusFile: 'C:\\s t\\s.json' })).toEqual(['-Cpu', '-PauseAtEnd', '-StatusFile', 'C:\\s t\\s.json']);
    expect(setupScriptArgs({ platform: 'win32', check: true, cpu: true, statusFile: 'f' })).toEqual(['-CheckOnly', '-StatusFile', 'f']);
    expect(setupScriptArgs({ platform: 'linux', cpu: false, statusFile: '/s.json' })).toEqual(['--pause-at-end', '--status-file', '/s.json']);
    expect(setupScriptArgs({ platform: 'linux', cpu: true, pause: false })).toEqual(['--cpu']);
  });

  it('every switch the app passes exists in the scripts', () => {
    const ps1 = fs.readFileSync(path.join(ROOT, 'scripts/setup-voice.ps1'), 'utf8');
    for (const p of ['Cpu', 'PauseAtEnd', 'StatusFile', 'CheckOnly', 'Yes']) expect(ps1).toMatch(new RegExp(`\\$${p}\\b`));
    const sh = fs.readFileSync(path.join(ROOT, 'scripts/setup-voice.sh'), 'utf8');
    for (const p of ['--cpu', '--pause-at-end', '--status-file', '--check-only']) expect(sh).toContain(`${p})`);
    // Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page: keep them ASCII.
    expect(/[^\x00-\x7f]/.test(ps1)).toBe(false);
    expect(ps1).toContain('winget install -e --id Python.Python.3.12 --scope user');
  });
});

describe('Windows launch (quoting, no cmd.exe)', () => {
  it('quoteWindowsArg round-trips through the Windows argv parser', () => {
    const samples = [
      'plain', '', 'with space', 'C:\\Users\\José Müller\\AppData\\Local\\Programs\\Lawnmower Man\\resources\\scripts\\setup-voice.ps1',
      'trailing backslash\\', 'C:\\dir with space\\', 'say "hi"', 'a\\"b', 'a\\\\"b c', '& | < > ^ % ( ) ! ; , `', '%USERPROFILE%', 'tab\there', 'ünïcödé 日本',
    ];
    for (const s of samples) {
      const line = ['-File', ...[s, s]].map(quoteWindowsArg).join(' ');
      expect(parseWindowsCommandLine(line), JSON.stringify(s)).toEqual(['-File', s, s]);
    }
    expect(quoteWindowsArg('-Cpu')).toBe('-Cpu');
    expect(() => quoteWindowsArg('a\nb')).toThrow(/line break/);
  });

  it('starts a windowless Windows PowerShell that opens the script in a visible console', () => {
    const script = "C:\\Users\\Tom & Jerry O'Neil (x)\\AppData\\Local\\Programs\\Lawnmower Man\\resources\\scripts\\setup-voice.ps1";
    const status = "C:\\Users\\Tom & Jerry O'Neil (x)\\AppData\\Roaming\\Lawnmower Man\\voice-setup-status.json";
    const l = windowsSetupLaunch({
      script,
      args: setupScriptArgs({ platform: 'win32', cpu: true, statusFile: status }),
      env: { SystemRoot: 'C:\\WINDOWS', Path: 'C:\\x', ELECTRON_RUN_AS_NODE: '1', USERPROFILE: "C:\\Users\\Tom & Jerry O'Neil (x)" },
    });
    expect(l.file).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    // plain, readable command lines: no -EncodedCommand, no -WindowStyle Hidden (windowsHide hides it)
    expect(l.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LAUNCHER]);
    // the launcher and the bootstrap are fixed one-liners without double quotes; no path is
    // spliced into them or onto any command line
    for (const s of [WINDOWS_LAUNCHER, WINDOWS_SETUP_BOOTSTRAP]) {
      expect(s).not.toMatch(/["\r\n]/);
      expect(s).not.toMatch(/-NoNewWindow|cmd(\.exe)?\b|EncodedCommand|Invoke-Expression|\biex\b/i);
    }
    expect(l.args.join(' ')).not.toContain('Jerry');
    expect(l.env.LAWNMOWER_SETUP_ARGS).not.toContain('Jerry');
    // the bootstrap's variables live in the console's global scope, visible to the script by
    // dynamic scoping: the script must not use (or read before assigning) any of those names
    const ps1 = fs.readFileSync(path.join(ROOT, 'scripts/setup-voice.ps1'), 'utf8');
    for (const v of new Set(WINDOWS_SETUP_BOOTSTRAP.match(/\$lm[A-Za-z]+/g))) expect(ps1, v).not.toContain(v);
    expect(WINDOWS_SETUP_BOOTSTRAP.match(/\$(?!lm|env:|_\b|_\.|true|false|LASTEXITCODE)[A-Za-z]+/g)).toBeNull(); // nothing unprefixed
    expect(WINDOWS_LAUNCHER).toContain('Start-Process -FilePath $env:LAWNMOWER_SETUP_SHELL -ArgumentList $env:LAWNMOWER_SETUP_ARGS');
    expect(l.env.LAWNMOWER_SETUP_SHELL).toBe(l.file);
    expect(l.env.LAWNMOWER_SETUP_CWD).toBe("C:\\Users\\Tom & Jerry O'Neil (x)");
    expect(l.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(parseWindowsCommandLine(l.env.LAWNMOWER_SETUP_ARGS)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SETUP_BOOTSTRAP]);
    expect(l.env).toMatchObject({ LAWNMOWER_SETUP_SCRIPT: script, LAWNMOWER_SETUP_FLAGS: 'Cpu,PauseAtEnd', LAWNMOWER_SETUP_STATUS: status });

    const check = windowsSetupLaunch({ script, args: setupScriptArgs({ platform: 'win32', check: true }), env: { SystemRoot: 'C:\\WINDOWS' } });
    expect(check.env.LAWNMOWER_SETUP_FLAGS).toBe('CheckOnly');
    expect(check.env.LAWNMOWER_SETUP_STATUS).toBeUndefined();
    expect(() => windowsSetupLaunch({ script, args: ['C:\\stray'], env: {} })).toThrow(/Unexpected setup argument/);
    expect(() => windowsSetupLaunch({ script: 'C:\\a\nb.ps1', args: [], env: {} })).toThrow(/line break/);
  });

  it('describes a window that ended without a result', () => {
    expect(describeEarlyExit(3221225786, '')).toBe('the setup window was closed before it finished');
    expect(describeEarlyExit(-1073741510, '')).toBe('the setup window was closed before it finished');
    expect(describeEarlyExit(1, '')).toBe('the setup window was closed before it finished (exit code 1)');
    expect(describeEarlyExit(97, 'This command cannot be run due to the error: The system cannot find the file specified.\r\nmore')).toBe(
      'could not open the setup window: This command cannot be run due to the error: The system cannot find the file specified.');
    // a multi-line PowerShell parse error from the console bootstrap becomes one bounded line
    const parse = 'At C:\\x\\setup-voice.ps1:12 char:8\r\n+ if ($x {\r\n+        ~\r\nUnexpected token \'{\' in expression or statement.';
    expect(describeSetupFailure({ ok: false, error: parse })).toBe("The voice setup failed: At C:\\x\\setup-voice.ps1:12 char:8 + if ($x { + ~ Unexpected token '{' in expression or statement.");
    expect(describeSetupFailure({ ok: false, error: 'x'.repeat(5000) })).toHaveLength('The voice setup failed: '.length + 400);
    expect(describeSetupFailure({ ok: false })).toBe('The voice setup did not finish.');
  });

  it('the manual command is safe to paste into PowerShell / bash', () => {
    expect(manualSetupCommand({ platform: 'win32', script: "C:\\Users\\O'Neil $x\\setup-voice.ps1", args: ['-Cpu'] }))
      .toBe("powershell -ExecutionPolicy Bypass -File 'C:\\Users\\O''Neil $x\\setup-voice.ps1' -Cpu");
    expect(manualSetupCommand({ platform: 'linux', script: "/opt/Lawnmower Man/it's/setup-voice.sh", args: ['--cpu'] }))
      .toBe("bash '/opt/Lawnmower Man/it'\\''s/setup-voice.sh' --cpu");
  });
});

describe('Linux terminals', () => {
  it('needs a display, then takes the first terminal on PATH', () => {
    const files = new Set(['/usr/bin/xterm', '/usr/bin/konsole']);
    const fakeFs = {
      statSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return { isFile: () => true }; },
      accessSync: () => {},
    };
    expect(findLinuxTerminal({ env: { PATH: '/usr/bin' }, fs: fakeFs })).toBeNull();
    const t = findLinuxTerminal({ env: { PATH: '/usr/bin', DISPLAY: ':0' }, fs: fakeFs });
    expect(t.name).toBe('konsole');
    expect(t.path).toBe('/usr/bin/konsole');
    expect(t.args(['bash', '/a b/setup-voice.sh', '--cpu'])).toEqual(['-e', 'bash', '/a b/setup-voice.sh', '--cpu']);
    const gnome = LINUX_TERMINALS.find((x) => x.name === 'gnome-terminal');
    expect(gnome.args(['bash', 's'])).toEqual(['--wait', '--', 'bash', 's']);
  });
});

describe('readSetupStatus', () => {
  it('accepts the scripts\' JSON (with or without BOM) and rejects partial files', () => {
    const d = tmp();
    const f = path.join(d, 's.json');
    expect(readSetupStatus(f)).toBeNull();
    fs.writeFileSync(f, '\uFEFF{"ok":true,"cpu":false,"voiceHome":"C:\\\\x","error":"","junk":{"a":1}}');
    expect(readSetupStatus(f)).toEqual({ ok: true, cpu: false, voiceHome: 'C:\\x', error: '' });
    fs.writeFileSync(f, '{"ok":tr');
    expect(readSetupStatus(f)).toBeNull();
    fs.writeFileSync(f, '{"ok":"yes"}');
    expect(readSetupStatus(f)).toBeNull();
  });
});

/** A fake child process (EventEmitter with stderr). */
function fakeChild() {
  const c = new EventEmitter();
  c.stderr = new EventEmitter();
  c.unref = () => {};
  c.pid = 4242;
  return c;
}

describe('VoiceSetupRunner', () => {
  const make = (o = {}) => {
    const d = tmp();
    const script = path.join(d, o.platform === 'linux' ? 'setup-voice.sh' : 'setup-voice.ps1');
    fs.writeFileSync(script, '# fake');
    const statusFile = path.join(d, 'status dir', 'voice-setup-status.json');
    const children = [];
    const spawnImpl = vi.fn(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const beforeLaunch = vi.fn(async () => {});
    const r = new VoiceSetupRunner({ script, statusFile, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawnImpl, beforeLaunch, pollMs: 10, cwd: d, ...o });
    const states = [];
    r.on('state', (s) => states.push(s));
    const finished = new Promise((res) => r.once('finished', res));
    const writeStatus = (obj) => {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(obj));
    };
    return { r, d, script, statusFile, spawnImpl, children, beforeLaunch, states, finished, writeStatus };
  };

  it('Windows: opens the console, and finishes as soon as the script reports success', async () => {
    const h = make();
    fs.mkdirSync(path.dirname(h.statusFile), { recursive: true });
    fs.writeFileSync(h.statusFile, '{"ok":false,"error":"stale from an earlier run"}');
    const st = await h.r.start({ cpu: true });
    expect(st).toMatchObject({ state: 'running', mode: 'console', cpu: true });
    expect(fs.existsSync(h.statusFile)).toBe(false); // a stale result is never mistaken for this run
    expect(h.beforeLaunch).toHaveBeenCalledWith({ cpu: true, check: false });
    expect(h.beforeLaunch.mock.invocationCallOrder[0]).toBeLessThan(h.spawnImpl.mock.invocationCallOrder[0]);
    const [file, args, opts] = h.spawnImpl.mock.calls[0];
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LAUNCHER]);
    // windowsHide + no inherited stdio: the launcher itself has no window at all
    expect(opts).toMatchObject({ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    expect(opts.env).toMatchObject({ LAWNMOWER_SETUP_SCRIPT: h.script, LAWNMOWER_SETUP_FLAGS: 'Cpu,PauseAtEnd', LAWNMOWER_SETUP_STATUS: h.statusFile });
    // a second click while it runs does not open another window
    expect(await h.r.start()).toMatchObject({ state: 'running', already: true });
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);

    h.writeStatus({ ok: true, cpu: true, voiceHome: 'C:\\Users\\x\\AppData\\Local\\LawnmowerMan\\voice' });
    expect(await h.finished).toMatchObject({ ok: true, cpu: true });
    expect(h.r.state).toMatchObject({ state: 'done', detail: 'Local voice installed. Starting it…' });
    h.children[0].emit('exit', 0); // the user pressed Enter afterwards: nothing changes
    expect(h.r.state.state).toBe('done');
  });

  it('a window closed before the end is a failure; Python missing gets its own hint', async () => {
    const a = make();
    await a.r.start();
    a.children[0].emit('exit', 3221225786);
    expect(await a.finished).toMatchObject({ ok: false });
    expect(a.r.state.state).toBe('failed');
    expect(a.r.state.detail).toBe('The voice setup failed: the setup window was closed before it finished');

    const b = make();
    await b.r.start();
    b.children[0].stderr.emit('data', 'This command cannot be run due to the error: The system cannot find the file specified.\r\n');
    b.children[0].emit('exit', 97);
    await b.finished;
    expect(b.r.state.detail).toMatch(/could not open the setup window/);

    const c = make();
    await c.r.start();
    c.writeStatus({ ok: false, error: 'python-missing' });
    await c.finished;
    expect(c.r.state).toMatchObject({ state: 'failed' });
    expect(c.r.state.detail).toMatch(/Python 3\.12 is needed/);
  });

  it('a missing script fails; a launcher that cannot start falls back to the manual command', async () => {
    const h = make();
    fs.rmSync(h.script);
    expect(await h.r.start()).toMatchObject({ state: 'failed' });
    expect(h.spawnImpl).not.toHaveBeenCalled();

    const e = make();
    const st = await e.r.start();
    expect(st.state).toBe('running');
    e.children[0].emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    expect(e.r.state).toMatchObject({ state: 'manual', mode: 'manual' });
    expect(e.r.state.command).toContain('powershell -ExecutionPolicy Bypass -File');
    // beforeLaunch stopped the voice server: 'finished' (not ok) lets main start it again
    expect(await e.finished).toMatchObject({ ok: false, launchFailed: true });

    const t = make({ spawnImpl: vi.fn(() => { throw new Error('EPERM'); }) });
    expect(await t.r.start()).toMatchObject({ state: 'manual' });
    expect(await t.finished).toMatchObject({ ok: false, launchFailed: true });
  });

  it('Linux without a terminal: the command to run, nothing stopped or started', async () => {
    const h = make({ platform: 'linux', findTerminal: () => null });
    const st = await h.r.start({ cpu: true });
    expect(st).toMatchObject({ state: 'manual', mode: 'manual', cpu: true });
    expect(st.command).toBe(`bash ${h.script.includes(' ') ? `'${h.script}'` : h.script} --cpu`);
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(h.beforeLaunch).not.toHaveBeenCalled();
  });

  it('Linux: a terminal that returns at once (server-based) keeps being watched', async () => {
    const term = { name: 'gnome-terminal', path: '/usr/bin/gnome-terminal', args: (cmd) => ['--', ...cmd] };
    const h = make({ platform: 'linux', findTerminal: () => term });
    await h.r.start();
    const [file, args, opts] = h.spawnImpl.mock.calls[0];
    expect(file).toBe('/usr/bin/gnome-terminal');
    expect(args).toEqual(['--', 'bash', h.script, '--pause-at-end', '--status-file', h.statusFile]);
    expect(opts.detached).toBe(true);
    h.children[0].emit('exit', 0);
    expect(h.r.state.state).toBe('running');
    h.writeStatus({ ok: true });
    await h.finished;
    expect(h.r.state.state).toBe('done');
  });
});

// ------------------------------------------------------------------------------------------
// The real scripts, in a packaged layout: <dir with spaces & ñ>/resources/{app.asar,scripts,voice}

/** @param {string} base */
function packagedLayout(base) {
  const res = path.join(base, 'Lawnmower Man ñ & Co (x)', 'resources');
  fs.mkdirSync(path.join(res, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(res, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), '');
  for (const f of ['setup-voice.ps1', 'setup-voice.sh']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(res, 'scripts', f));
  fs.copyFileSync(path.join(ROOT, 'voice', 'pyproject.toml'), path.join(res, 'voice', 'pyproject.toml'));
  return res;
}

const bash = process.platform !== 'win32' ? findOnPath('bash').found : null;
const powershell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : process.env.LAWNMOWER_TEST_PWSH || findOnPath('pwsh').found;
const hasPowerShell = !!powershell && fs.existsSync(powershell);

describe.skipIf(!bash)('setup-voice.sh (real script)', () => {
  it('--check-only in a packaged layout reports the folder the sidecar looks in', () => {
    const base = tmp('lm-vsetup sh ');
    const res = packagedLayout(base);
    const xdg = path.join(base, 'xdg data é');
    const status = path.join(base, 'status dir', 's.json');
    const r = spawnSync(bash, [path.join(res, 'scripts', 'setup-voice.sh'), '--check-only', '--pause-at-end', '--status-file', status], {
      env: { ...process.env, XDG_DATA_HOME: xdg }, encoding: 'utf8', input: '', timeout: 60000,
    });
    expect(r.status, r.stderr).toBe(0);
    const j = readSetupStatus(status);
    const home = packagedVoiceHome({ platform: 'linux', env: { XDG_DATA_HOME: xdg } });
    expect(j).toMatchObject({ ok: true, check: true, packaged: true, voiceHome: home });
    expect(j.venv).toBe(voiceVenvDirs({ packaged: true, voiceDir: path.join(res, 'voice'), platform: 'linux', env: { XDG_DATA_HOME: xdg } })[0]);
    expect(fs.existsSync(home)).toBe(false); // check-only changes nothing
  });

  it('reports a missing Python as python-missing (and does not wait for Enter without a terminal)', () => {
    const base = tmp('lm-vsetup sh ');
    const res = packagedLayout(base);
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    for (const t of ['dirname', 'mkdir', 'date', 'uname', 'head', 'cat', 'df', 'awk', 'rm', 'cp']) {
      const found = findOnPath(t).found;
      if (found) fs.symlinkSync(found, path.join(bin, t));
    }
    const status = path.join(base, 's.json');
    const r = spawnSync(bash, [path.join(res, 'scripts', 'setup-voice.sh'), '--pause-at-end', '--status-file', status], {
      env: { PATH: bin, HOME: base, XDG_DATA_HOME: path.join(base, 'xdg') }, encoding: 'utf8', input: '', timeout: 60000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Python 3\.12 was not found/);
    expect(readSetupStatus(status)).toMatchObject({ ok: false, error: 'python-missing' });
  });

  it('VoiceSetupRunner drives the real script end to end (check mode, via a stand-in terminal)', async () => {
    const base = tmp('lm-vsetup run ');
    const res = packagedLayout(base);
    const xdg = path.join(base, 'xdg');
    const runner = new VoiceSetupRunner({
      script: path.join(res, 'scripts', 'setup-voice.sh'),
      statusFile: path.join(base, 'status.json'),
      platform: 'linux',
      env: { ...process.env, XDG_DATA_HOME: xdg },
      findTerminal: () => ({ name: 'env', path: findOnPath('env').found, args: (cmd) => cmd }),
      pollMs: 50,
    });
    const done = new Promise((r) => runner.once('finished', r));
    expect((await runner.start({ check: true })).state).toBe('running');
    const r = await done;
    expect(r).toMatchObject({ ok: true, check: true, voiceHome: packagedVoiceHome({ platform: 'linux', env: { XDG_DATA_HOME: xdg } }) });
    expect(runner.state.state).toBe('done');
  });
});

describe.skipIf(!hasPowerShell)('setup-voice.ps1 (real script)', () => {
  const run = (args, env) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args], { env: { ...process.env, ...env }, encoding: 'utf8', input: '', timeout: 120000 });

  it('-CheckOnly in a packaged layout reports the folder the sidecar looks in', () => {
    const base = tmp('lm-vsetup ps ');
    const res = packagedLayout(base);
    const local = path.join(base, 'Local AppData José');
    const status = path.join(base, 'status dir', 's.json');
    const r = run([path.join(res, 'scripts', 'setup-voice.ps1'), '-CheckOnly', '-PauseAtEnd', '-StatusFile', status], { LOCALAPPDATA: local });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const j = readSetupStatus(status);
    // On Windows this is exactly what the sidecar computes; pwsh elsewhere joins with "/".
    const home = process.platform === 'win32' ? packagedVoiceHome({ platform: 'win32', env: { LOCALAPPDATA: local } }) : path.join(local, 'LawnmowerMan', 'voice');
    expect(j).toMatchObject({ ok: true, check: true, packaged: true, voiceHome: home, venv: path.join(home, '.venv') });
    if (process.platform === 'win32') {
      expect(j.venv).toBe(voiceVenvDirs({ packaged: true, voiceDir: path.join(res, 'voice'), platform: 'win32', env: { LOCALAPPDATA: local } })[0]);
    }
  });

  // What the visible console runs (WINDOWS_SETUP_BOOTSTRAP). On Windows this is the real Windows
  // PowerShell 5.1 (ci.yml's Windows job), elsewhere PowerShell 7.
  const bootstrap = (env) => {
    const l = windowsSetupLaunch({ script: env.script, args: env.args, env: { ...process.env, ...env.extra } });
    return {
      env: l.env,
      run: () => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SETUP_BOOTSTRAP], { env: l.env, encoding: 'utf8', input: '', timeout: 120000 }),
    };
  };

  it('the console bootstrap runs the real script with the switches from the environment', () => {
    const base = tmp("lm-vsetup boot O'N ");
    const res = packagedLayout(base);
    const local = path.join(base, 'Local AppData José');
    const status = path.join(base, 'status dir', 's.json');
    fs.mkdirSync(path.dirname(status));
    const b = bootstrap({ script: path.join(res, 'scripts', 'setup-voice.ps1'), args: setupScriptArgs({ platform: 'win32', check: true, statusFile: status }), extra: { LOCALAPPDATA: local } });
    const r = b.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readSetupStatus(status)).toMatchObject({ ok: true, check: true, packaged: true });
  });

  it('a script that cannot even start is reported in the window and to the app (no silent close)', () => {
    const base = tmp('lm-vsetup boot bad ');
    const broken = path.join(base, 'setup-voice.ps1');
    fs.writeFileSync(broken, 'param([switch]$Cpu, [string]$StatusFile)\r\nif ($x {\r\n'); // a parse error
    const status = path.join(base, 's.json');
    const r = bootstrap({ script: broken, args: setupScriptArgs({ platform: 'win32', cpu: true, pause: false, statusFile: status }), extra: {} }).run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/The voice setup could not run: /);
    const j = readSetupStatus(status);
    expect(j).toMatchObject({ ok: false });
    expect(j.error).toMatch(/\S/);

    // an unknown switch (an older script than the app expects) is reported the same way
    const old = path.join(base, 'old.ps1');
    fs.writeFileSync(old, "[CmdletBinding()]\r\nparam([string]$StatusFile)\r\nWrite-Host 'old script'\r\nexit 0\r\n");
    const status2 = path.join(base, 's2.json');
    const r2 = bootstrap({ script: old, args: setupScriptArgs({ platform: 'win32', check: true, statusFile: status2 }), extra: {} }).run();
    expect(r2.status).toBe(1);
    expect(readSetupStatus(status2)).toMatchObject({ ok: false });
    expect(readSetupStatus(status2).error).toMatch(/CheckOnly/);
  });

  // The whole Windows chain — the windowless launcher one-liner, Start-Process, the bootstrap,
  // the script — with PowerShell 7 standing in for powershell.exe (off Windows Start-Process opens
  // no window, but quoting, environment and exit codes are the same).
  it.skipIf(process.platform === 'win32')('the launcher one-liner starts the bootstrap and passes its exit code back', () => {
    const base = tmp('lm-vsetup chain ñ & ');
    const res = packagedLayout(base);
    const local = path.join(base, 'Local AppData José');
    const status = path.join(base, 'status dir', 's.json');
    fs.mkdirSync(path.dirname(status));
    const l = windowsSetupLaunch({ script: path.join(res, 'scripts', 'setup-voice.ps1'), args: setupScriptArgs({ platform: 'win32', check: true, statusFile: status }), env: { ...process.env, LOCALAPPDATA: local }, cwd: base });
    const r = spawnSync(powershell, l.args, { env: { ...l.env, LAWNMOWER_SETUP_SHELL: powershell }, encoding: 'utf8', input: '', timeout: 120000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readSetupStatus(status)).toMatchObject({ ok: true, check: true, packaged: true, voiceHome: path.join(local, 'LawnmowerMan', 'voice') });

    const r2 = spawnSync(powershell, l.args, { env: { ...l.env, LAWNMOWER_SETUP_SHELL: path.join(base, 'no such shell') }, encoding: 'utf8', input: '', timeout: 60000 });
    expect(r2.status).toBe(97); // could not open the window: the runner reports stderr
    expect(r2.stderr.trim()).not.toBe('');
  });

  it('-CheckOnly in a checkout uses voice/.venv', () => {
    const base = tmp('lm-vsetup ps ');
    fs.mkdirSync(path.join(base, 'scripts'));
    fs.mkdirSync(path.join(base, 'voice'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'setup-voice.ps1'), path.join(base, 'scripts', 'setup-voice.ps1'));
    fs.copyFileSync(path.join(ROOT, 'voice', 'pyproject.toml'), path.join(base, 'voice', 'pyproject.toml'));
    const status = path.join(base, 's.json');
    const r = run([path.join(base, 'scripts', 'setup-voice.ps1'), '-CheckOnly', '-StatusFile', status], {});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readSetupStatus(status)).toMatchObject({ ok: true, packaged: false, voiceHome: path.join(base, 'voice') });
  });

  // The winget offer only runs on Windows; exercise its logic with pwsh elsewhere by loading the
  // script's functions on their own. The fake winget "installs" Python where winget --scope user
  // puts it (%LOCALAPPDATA%\Programs\Python\Python312\python.exe) WITHOUT putting it on this
  // process's PATH — exactly the stale-PATH situation in the setup window after a real install.
  it.skipIf(process.platform === 'win32' || !findOnPath('python3').found)('Install-Python: winget per user after "yes", then finds the new Python although PATH is stale', () => {
    const base = tmp('lm-vsetup winget ');
    const bin = path.join(base, 'bin');
    const localAppData = path.join(base, 'Local AppData José');
    const target = path.join(localAppData, 'Programs', 'Python', 'Python312');
    fs.mkdirSync(bin);
    const log = path.join(base, 'winget.log');
    fs.writeFileSync(path.join(bin, 'winget'), `#!/bin/sh\necho "$@" >> '${log}'\n/bin/mkdir -p '${target}'\n/bin/ln -s '${findOnPath('python3').found}' '${path.join(target, 'python.exe')}'\nexit 0\n`, { mode: 0o755 });
    const harness = path.join(base, 'harness.ps1');
    fs.writeFileSync(harness, [
      '$ErrorActionPreference = "Stop"',
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts', 'setup-voice.ps1').replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
      '$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)',
      'foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }',
      '$OnWindows = $true; $Yes = $true; $Python = ""',
      'function Write-Step([string]$Text) { Write-Host $Text }',
      '$py = Install-Python',
      'if (-not $py) { Write-Host "NO PYTHON"; exit 3 }',
      'Write-Host ("FOUND " + $py.Version + " " + $py.Path)',
    ].join('\n'));
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], {
      env: { PATH: bin, HOME: base, LOCALAPPDATA: localAppData }, encoding: 'utf8', input: '', timeout: 120000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/FOUND 3\.\d+/);
    expect(r.stdout).toContain(path.join('Programs', 'Python', 'Python312', 'python.exe'));
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements');
  });

  it.skipIf(process.platform === 'win32')('Install-Python without winget explains python.org and installs nothing', () => {
    const base = tmp('lm-vsetup nowinget ');
    const harness = path.join(base, 'harness.ps1');
    fs.writeFileSync(harness, [
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts', 'setup-voice.ps1').replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
      'foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }',
      '$OnWindows = $true; $Yes = $true',
      'if (Install-Python) { exit 4 } else { exit 0 }',
    ].join('\n'));
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], { env: { PATH: path.join(base, 'empty'), HOME: base }, encoding: 'utf8', input: '', timeout: 60000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('https://www.python.org/downloads/windows/');
  });
});
