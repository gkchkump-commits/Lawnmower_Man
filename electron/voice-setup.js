// VoiceSetupRunner: "Set up local voice…" (tray menu, settings drawer). Runs the bundled
// scripts/setup-voice.ps1 (Windows) or setup-voice.sh (Linux) for the user in a VISIBLE console
// window — the setup downloads several GB, prints progress and may ask a question (install
// Python 3.12 with winget?) — and notices when it has finished, so the app can start the freshly
// installed voice server without a restart.
//
// Windows: a windowless Windows PowerShell (spawned with windowsHide) runs a fixed one-line
// `Start-Process powershell.exe …` and waits for it. Start-Process (ShellExecuteEx) gives the
// setup its own new console window, with real console handles, so Read-Host and the progress
// output work. That console runs a fixed bootstrap that invokes the script: if the script cannot
// even start (a parse error, an execution policy set by Group Policy, a bad switch), the error
// stays readable in the window and is reported to the app instead of the window just vanishing.
// Every path travels in environment variables, never on a command line and never through
// cmd.exe: spaces, non-ASCII letters and & ^ % ( ) ' in user or folder names are harmless. No
// -EncodedCommand / -WindowStyle Hidden (plain, readable command lines; security tools flag the
// encoded + hidden PowerShell pattern).
// Linux: the first terminal emulator found on PATH runs `bash setup-voice.sh …`; without one (or
// without a display) the user gets the command to copy instead.
//
// Completion: the script writes a JSON status file (-StatusFile / --status-file) just before it
// ends (and before "Press Enter to close this window"); it is polled every couple of seconds.
// The launcher's exit (the window was closed) is the fallback. Never runs anything elevated.
//
// Pure Node (no Electron import): spawn, fs and the terminal lookup are injectable for tests.

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { findOnPath } from './claude-path.js';
import { cleanChildEnv, getEnv } from './spawn-util.js';

/**
 * The bundled setup script: resources/scripts (packaged, see package.json extraResources) or
 * scripts/ in a git checkout.
 * @param {{ platform?: string, packaged: boolean, resourcesPath?: string, appRoot: string }} o
 */
export function setupScriptPath(o) {
  const platform = o.platform || process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'setup-voice.ps1' : 'setup-voice.sh';
  const base = o.packaged && o.resourcesPath ? P.join(o.resourcesPath, 'scripts') : P.join(o.appRoot, 'scripts');
  return P.join(base, name);
}

/**
 * Script switches for a run (fixed spellings only; paths are separate arguments).
 * @param {{ platform?: string, cpu?: boolean, check?: boolean, statusFile?: string, pause?: boolean }} o
 * @returns {string[]}
 */
export function setupScriptArgs(o) {
  const win = (o.platform || process.platform) === 'win32';
  const out = [];
  if (o.check) out.push(win ? '-CheckOnly' : '--check-only');
  else if (o.cpu) out.push(win ? '-Cpu' : '--cpu');
  if (o.pause !== false && !o.check) out.push(win ? '-PauseAtEnd' : '--pause-at-end');
  if (o.statusFile) out.push(win ? '-StatusFile' : '--status-file', o.statusFile);
  return out;
}

/**
 * Quote one argument for a Windows command line (CommandLineToArgvW / MSVCRT rules, as Node and
 * libuv do it). powershell.exe parses its own command line with these rules.
 * @param {string} arg
 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (/[\0\r\n]/.test(s)) throw new Error('Refusing to put a line break or NUL on a command line');
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * The windowless outer PowerShell: open the setup in a new console window and wait for it. One
 * line, no double quotes (it travels as a single -Command argument). The values come from the
 * environment (set by windowsSetupLaunch), never from string splicing.
 */
export const WINDOWS_LAUNCHER =
  "$ErrorActionPreference = 'Stop'; " +
  'try { ' +
  '$p = Start-Process -FilePath $env:LAWNMOWER_SETUP_SHELL -ArgumentList $env:LAWNMOWER_SETUP_ARGS -WorkingDirectory $env:LAWNMOWER_SETUP_CWD -PassThru; ' +
  '$null = $p.Handle; $p.WaitForExit(); exit $p.ExitCode ' +
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 97 }';

/**
 * What the visible console runs: the setup script with the switches from the environment
 * (LAWNMOWER_SETUP_FLAGS, comma-separated switch names; LAWNMOWER_SETUP_STATUS → -StatusFile).
 * When the script cannot start or dies outside its own error handling, the message is shown
 * (and, with PauseAtEnd, the window waits for Enter) and written to the status file, so the app
 * reports what went wrong. One line, no double quotes.
 */
export const WINDOWS_SETUP_BOOTSTRAP =
  "$lmScript = $env:LAWNMOWER_SETUP_SCRIPT; $lmStatus = $env:LAWNMOWER_SETUP_STATUS; $lmFlags = @(([string]$env:LAWNMOWER_SETUP_FLAGS).Split(',') | Where-Object { $_ }); " +
  "$lmArgs = @{}; foreach ($lmFlag in $lmFlags) { $lmArgs[$lmFlag] = $true }; if ($lmStatus) { $lmArgs['StatusFile'] = $lmStatus }; " +
  'try { & $lmScript @lmArgs; exit $LASTEXITCODE } catch { ' +
  "$lmError = $_.Exception.Message; Write-Host ''; Write-Host ('The voice setup could not run: ' + $lmError) -ForegroundColor Red; " +
  "if ($lmStatus -and -not (Test-Path -LiteralPath $lmStatus)) { try { [IO.File]::WriteAllText($lmStatus, (@{ ok = $false; error = $lmError } | ConvertTo-Json -Compress)) } catch { } }; " +
  "if ($lmFlags -contains 'PauseAtEnd') { [void](Read-Host 'Press Enter to close this window') }; exit 1 }";

/**
 * How to start the setup on Windows.
 * @param {{ script: string, args: string[], env?: Record<string, string|undefined>, cwd?: string }} o
 *   args: setupScriptArgs() — switches, plus -StatusFile <file>
 * @returns {{ file: string, args: string[], env: Record<string, string> }}
 */
export function windowsSetupLaunch(o) {
  const env = o.env || process.env;
  const systemRoot = getEnv(env, 'SystemRoot') || 'C:\\Windows';
  const ps = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  /** @type {string[]} */
  const flags = [];
  let statusFile = '';
  for (let i = 0; i < o.args.length; i++) {
    const a = o.args[i];
    if (a === '-StatusFile') statusFile = String(o.args[++i] ?? '');
    else if (/^-[A-Za-z]+$/.test(a)) flags.push(a.slice(1));
    else throw new Error(`Unexpected setup argument: ${a}`);
  }
  for (const v of [o.script, statusFile]) {
    if (/[\0\r\n]/.test(v)) throw new Error('Refusing a path with a line break or NUL');
  }
  return {
    file: ps,
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LAUNCHER],
    env: cleanChildEnv(env, {
      LAWNMOWER_SETUP_SHELL: ps,
      LAWNMOWER_SETUP_ARGS: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SETUP_BOOTSTRAP].map(quoteWindowsArg).join(' '),
      LAWNMOWER_SETUP_CWD: o.cwd || getEnv(env, 'USERPROFILE') || os.homedir(),
      LAWNMOWER_SETUP_SCRIPT: o.script,
      LAWNMOWER_SETUP_FLAGS: flags.join(','),
      LAWNMOWER_SETUP_STATUS: statusFile || undefined,
    }),
  };
}

/** NTSTATUS 0xC000013A (STATUS_CONTROL_C_EXIT): the console window was closed, or Ctrl+C. */
const CONSOLE_CLOSED = new Set([0xc000013a, 0xc000013a - 0x100000000]);

/** Why the setup window ended without a result, for the UI. @param {number|null} code @param {string} stderr */
export function describeEarlyExit(code, stderr) {
  if (code === 97 && stderr.trim()) return `could not open the setup window: ${stderr.trim().split(/\r?\n/)[0]}`;
  if (code !== null && CONSOLE_CLOSED.has(code)) return 'the setup window was closed before it finished';
  return `the setup window was closed before it finished (exit code ${code})`;
}

/**
 * Terminal emulators, preferred first, with how each runs a command (argv, no shell parsing).
 * @type {Array<{ name: string, args: (cmd: string[]) => string[] }>}
 */
export const LINUX_TERMINALS = [
  { name: 'gnome-terminal', args: (cmd) => ['--wait', '--', ...cmd] },
  { name: 'konsole', args: (cmd) => ['-e', ...cmd] },
  { name: 'xfce4-terminal', args: (cmd) => ['-x', ...cmd] },
  { name: 'mate-terminal', args: (cmd) => ['-x', ...cmd] },
  { name: 'kitty', args: (cmd) => [...cmd] },
  { name: 'alacritty', args: (cmd) => ['-e', ...cmd] },
  { name: 'wezterm', args: (cmd) => ['start', '--', ...cmd] },
  { name: 'foot', args: (cmd) => [...cmd] },
  { name: 'xterm', args: (cmd) => ['-e', ...cmd] },
];

/**
 * The first terminal emulator on PATH, or null (also without a graphical session).
 * @param {{ env?: Record<string, string|undefined>, fs?: any }} [o]
 */
export function findLinuxTerminal(o = {}) {
  const env = o.env || process.env;
  if (!getEnv(env, 'DISPLAY') && !getEnv(env, 'WAYLAND_DISPLAY')) return null;
  for (const t of LINUX_TERMINALS) {
    const found = findOnPath(t.name, { env, platform: 'linux', fs: o.fs || nodeFs }).found;
    if (found) return { ...t, path: found };
  }
  return null;
}

/** POSIX shell quoting for a command shown to the user. @param {string} s */
function shQuote(s) {
  return /^[A-Za-z0-9_./=:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** PowerShell quoting (single quotes are literal there: no $ expansion). @param {string} s */
function psQuote(s) {
  return /^[A-Za-z0-9_./:\\-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The command a user can paste into a terminal themselves (PowerShell on Windows).
 * @param {{ platform?: string, script: string, args?: string[] }} o
 */
export function manualSetupCommand(o) {
  const args = o.args || [];
  if ((o.platform || process.platform) === 'win32') {
    return ['powershell', '-ExecutionPolicy', 'Bypass', '-File', o.script, ...args].map(psQuote).join(' ');
  }
  return ['bash', o.script, ...args].map(shQuote).join(' ');
}

/**
 * @typedef {object} SetupResult  the script's status file
 * @property {boolean} ok
 * @property {boolean} [check]
 * @property {boolean} [cpu]
 * @property {boolean} [packaged]
 * @property {string} [voiceHome]
 * @property {string} [venv]
 * @property {string} [python]
 * @property {string} [error]      'python-missing' or a message
 */

/**
 * @typedef {object} SetupState
 * @property {'idle'|'running'|'done'|'failed'|'manual'} state
 * @property {string} [detail]      one line for the UI
 * @property {'console'|'terminal'|'manual'} [mode]
 * @property {string} [command]     manual mode: what to run in a terminal
 * @property {boolean} [cpu]
 * @property {boolean} [check]
 * @property {SetupResult} [result]
 */

/** Read and validate a status file; null when missing or not (yet) valid JSON. @param {string} file @param {any} fs */
export function readSetupStatus(file, fs = nodeFs) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') return null;
    /** @type {SetupResult} */
    const r = { ok: j.ok };
    for (const k of ['check', 'cpu', 'packaged']) if (typeof j[k] === 'boolean') /** @type {any} */ (r)[k] = j[k];
    for (const k of ['voiceHome', 'venv', 'python', 'error']) if (typeof j[k] === 'string') /** @type {any} */ (r)[k] = j[k].slice(0, 2000);
    return r;
  } catch {
    return null; // still being written
  }
}

/** One line for the UI from a failed result. @param {SetupResult} r */
export function describeSetupFailure(r) {
  if (r.error === 'python-missing') return 'Python 3.12 is needed. Install it (the setup window explains how), then run the setup again.';
  // one line for a toast / the drawer (a PowerShell parse error spans several lines)
  const msg = String(r.error || '').replace(/\s+/g, ' ').trim();
  return msg ? `The voice setup failed: ${msg.length > 400 ? `${msg.slice(0, 399)}…` : msg}` : 'The voice setup did not finish.';
}

/**
 * @typedef {object} VoiceSetupOptions
 * @property {string} script               setup-voice.ps1 / setup-voice.sh
 * @property {string} statusFile           where the script reports its result
 * @property {string} [platform]
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [cwd]                working folder for the console (default: home)
 * @property {typeof nodeSpawn} [spawnImpl]
 * @property {any} [fs]
 * @property {(o: { env: any }) => ({ name: string, path: string, args: (cmd: string[]) => string[] }|null)} [findTerminal]
 * @property {number} [pollMs]             status-file poll interval (default 2000)
 * @property {number} [maxWaitMs]          give up waiting for a detached terminal (default 6 h)
 * @property {(o: { cpu: boolean, check: boolean }) => Promise<void>|void} [beforeLaunch]
 *   runs right before the window opens (main stops the voice server: it locks venv files)
 * @property {(level: 'debug'|'info'|'warn'|'error', msg: string) => void} [log]
 */

export class VoiceSetupRunner extends EventEmitter {
  /** @param {VoiceSetupOptions} o */
  constructor(o) {
    super();
    if (!o || !o.script || !o.statusFile) throw new TypeError('script and statusFile are required');
    this._o = o;
    this._platform = o.platform || process.platform;
    this._fs = o.fs || nodeFs;
    this._spawn = o.spawnImpl || nodeSpawn;
    this._log = o.log || (() => {});
    this._pollMs = o.pollMs ?? 2000;
    this._maxWaitMs = o.maxWaitMs ?? 6 * 3600 * 1000;
    /** @type {SetupState} */
    this._state = { state: 'idle' };
    /** @type {import('node:child_process').ChildProcess|null} */
    this._child = null;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    this._runId = 0;
    this._launching = false;
  }

  /** @returns {SetupState} */
  get state() {
    return { ...this._state, result: this._state.result ? { ...this._state.result } : undefined };
  }

  get running() {
    return this._state.state === 'running' || this._launching;
  }

  /**
   * Open the setup. Resolves with the new state as soon as the window was started (or the
   * manual command is known); 'finished' is emitted later with the script's result.
   * @param {{ cpu?: boolean, check?: boolean }} [opts]
   * @returns {Promise<SetupState & { already?: boolean }>}
   */
  async start(opts = {}) {
    if (this.running) return { ...this.state, already: true };
    this._launching = true;
    try {
      return await this._start(opts);
    } finally {
      this._launching = false;
    }
  }

  /** @param {{ cpu?: boolean, check?: boolean }} opts */
  async _start(opts) {
    const { script, statusFile } = this._o;
    const cpu = !!opts.cpu;
    const check = !!opts.check;
    if (!this._exists(script)) {
      return this._set({ state: 'failed', cpu, check, detail: `The voice setup script is missing (${script}). Reinstall Lawnmower Man.` });
    }
    try {
      this._fs.rmSync(statusFile, { force: true });
    } catch { /* not there */ }
    const args = setupScriptArgs({ platform: this._platform, cpu, check, statusFile });

    /** @type {{ file: string, args: string[], env: Record<string, string> }|null} */
    let launch = null;
    /** @type {'console'|'terminal'} */
    let mode = 'console';
    const plainArgs = setupScriptArgs({ platform: this._platform, cpu, check, pause: false });
    const manual = manualSetupCommand({ platform: this._platform, script, args: plainArgs });
    if (this._platform === 'win32') {
      launch = windowsSetupLaunch({ script, args, env: this._o.env, cwd: this._o.cwd });
    } else if (this._platform === 'linux') {
      const env = this._o.env || process.env;
      const term = (this._o.findTerminal || findLinuxTerminal)({ env });
      if (term) {
        mode = 'terminal';
        launch = { file: term.path, args: term.args(['bash', script, ...args]), env: cleanChildEnv(env) };
      }
    }
    if (!launch) {
      return this._set({
        state: 'manual',
        mode: 'manual',
        cpu,
        check,
        command: manual,
        detail: 'Run this command in a terminal to set up the local voice, then choose Restart voice.',
      });
    }

    try {
      await this._o.beforeLaunch?.({ cpu, check });
    } catch (err) {
      this._log('warn', `[voice-setup] beforeLaunch: ${/** @type {Error} */ (err).message}`);
    }
    const runId = ++this._runId;
    const startedAt = Date.now();
    let child;
    try {
      child = this._spawn(launch.file, launch.args, {
        env: launch.env,
        cwd: this._o.cwd || os.homedir(),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true, // the hidden launcher only; the setup gets its own visible window
        detached: this._platform !== 'win32', // terminal keeps running if the app quits
      });
    } catch (err) {
      return this._launchFailed(/** @type {Error} */ (err), { cpu, check, command: manual });
    }
    this._child = child;
    let stderr = '';
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.once('error', (err) => {
      if (runId !== this._runId || !this.running) return;
      this._stopPolling();
      this._child = null;
      this._log('warn', `[voice-setup] could not start ${launch.file}: ${err.message}`);
      this._launchFailed(err, { cpu, check, command: manual });
    });
    child.once('exit', (code) => {
      if (runId !== this._runId) return;
      this._child = null;
      if (!this.running) return;
      const r = readSetupStatus(statusFile, this._fs);
      if (r) return this._finish(r);
      // A terminal that hands the command to a server process returns at once: keep polling.
      if (code === 0 && mode === 'terminal' && Date.now() - startedAt < 5000) return undefined;
      this._stopPolling();
      const why = describeEarlyExit(code, stderr);
      this._log('warn', `[voice-setup] ${why}`);
      return this._finish({ ok: false, error: why });
    });
    child.unref?.();
    this._log('info', `[voice-setup] started ${mode}: ${launch.file} (${cpu ? 'CPU' : 'GPU'}${check ? ', check only' : ''})`);
    this._set({
      state: 'running',
      mode,
      cpu,
      check,
      command: manual,
      detail: check ? 'Checking the voice setup…' : `The local voice setup is running in its own window (${cpu ? 'CPU version' : 'NVIDIA GPU version'}). Follow it there; Lawnmower Man starts the voice when it is done.`,
    });
    this._poll(runId, startedAt);
    return this.state;
  }

  /** Stop watching (app quit). The setup window itself keeps running. */
  dispose() {
    this._stopPolling();
    this._runId++;
    this._child = null;
  }

  // -------------------------------------------------------------------------------------------

  /** @param {number} runId @param {number} startedAt */
  _poll(runId, startedAt) {
    this._stopPolling();
    const tick = () => {
      this._timer = null;
      if (runId !== this._runId || !this.running) return;
      const r = readSetupStatus(this._o.statusFile, this._fs);
      if (r) {
        this._finish(r);
        return;
      }
      if (Date.now() - startedAt > this._maxWaitMs) {
        this._finish({ ok: false, error: 'no result from the setup window' });
        return;
      }
      this._timer = setTimeout(tick, this._pollMs);
      this._timer.unref?.();
    };
    this._timer = setTimeout(tick, this._pollMs);
    this._timer.unref?.();
  }

  _stopPolling() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /**
   * The window could not be opened: show the command instead, and report 'finished' (not ok) so
   * the caller starts the voice server again that beforeLaunch stopped.
   * @param {Error} err @param {{ cpu: boolean, check: boolean, command: string }} o
   */
  _launchFailed(err, o) {
    const st = this._set({ state: 'manual', mode: 'manual', ...o, detail: `Could not open a window for the setup (${err.message}). Run this in a terminal instead, then choose Restart voice:` });
    this.emit('finished', { ok: false, check: o.check, error: `could not open a window: ${err.message}`, launchFailed: true });
    return st;
  }

  /** @param {SetupResult} r */
  _finish(r) {
    this._stopPolling();
    const cur = this._state;
    const ok = !!r.ok;
    this._log(ok ? 'info' : 'warn', `[voice-setup] finished: ${JSON.stringify(r)}`);
    this._set({
      state: ok ? 'done' : 'failed',
      mode: cur.mode,
      cpu: typeof r.cpu === 'boolean' ? r.cpu : cur.cpu,
      check: cur.check,
      command: cur.command,
      result: r,
      detail: ok ? (cur.check ? 'The voice setup check passed.' : 'Local voice installed. Starting it…') : describeSetupFailure(r),
    });
    this.emit('finished', { ...r });
  }

  /** @param {SetupState} s */
  _set(s) {
    this._state = s;
    try {
      this.emit('state', this.state);
    } catch (err) {
      this._log('error', `[voice-setup] state listener threw: ${err}`);
    }
    return this.state;
  }

  /** @param {string} p */
  _exists(p) {
    try {
      return this._fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }
}
