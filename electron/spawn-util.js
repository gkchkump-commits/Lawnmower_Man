// Cross-platform child-process helpers shared by the Claude session and the voice sidecar.
//
// Windows notes (the primary target):
//  * `.exe` files are spawned directly (Node quotes arguments with MSVCRT rules).
//  * `.cmd` / `.bat` files cannot be spawned without a shell since Node's CVE-2024-27980 fix,
//    so they are run through `cmd.exe /d /s /c "<command line>"` with `windowsVerbatimArguments`.
//    Every argument is quoted + caret-escaped with the same algorithm as the widely used
//    `cross-spawn` package. Only OUR fixed arguments (flags, file paths, ids) ever travel on a
//    command line; user text is always sent over stdin.
//  * Process trees are killed with `taskkill /pid N /T /F` (the CLI may run tools/MCP servers).
//
// POSIX notes: children are started in their own process group (`detached: true`) so the
// whole group can be signalled on shutdown; stdin EOF still ends them if Electron dies.

import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Environment variables that make a nested Claude CLI (or Node/Electron child) misbehave when
 * inherited, e.g. when the app is launched from a terminal inside Claude Code: they would make
 * the child think it is a sub-process of another Claude session or force Electron's Node mode.
 */
export const STRIPPED_ENV_VARS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID', // verified: with SESSION_ID it pins the child to the parent's conversation
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'VITE_DEV_SERVER_URL',
]);

const STRIPPED_SET = new Set(STRIPPED_ENV_VARS.map((k) => k.toUpperCase()));

/**
 * Copy an environment without the variables in {@link STRIPPED_ENV_VARS} (case-insensitive, as
 * Windows environment names are), then apply `extra` on top.
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string|undefined>} [extra]
 * @param {string[]} [alsoStrip]
 * @returns {Record<string, string>}
 */
export function cleanChildEnv(env, extra = {}, alsoStrip = []) {
  const strip = new Set([...STRIPPED_SET, ...alsoStrip.map((k) => k.toUpperCase())]);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) continue;
    if (strip.has(k.toUpperCase())) continue;
    out[k] = String(v);
  }
  for (const [k, v] of Object.entries(extra)) {
    // Replace case-insensitively so we never end up with both "Path" and "PATH".
    for (const existing of Object.keys(out)) {
      if (existing !== k && existing.toUpperCase() === k.toUpperCase()) delete out[existing];
    }
    if (v === undefined || v === null) delete out[k];
    else out[k] = String(v);
  }
  return out;
}

/**
 * Case-insensitive environment lookup (Windows env names are case-insensitive, and injected
 * test environments are plain objects).
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string|undefined}
 */
export function getEnv(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) return env[k];
  return undefined;
}

// cmd.exe metacharacters (same set as cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape a command (the .cmd path itself) for `cmd.exe /s /c "…"`.
 * @param {string} command
 */
export function escapeCmdCommand(command) {
  return String(command).replace(CMD_META, '^$1');
}

/**
 * Quote one argument for a `cmd.exe /d /s /c "…"` command line: first MSVCRT quoting (so the
 * final program's argv parser sees exactly `arg`), then caret-escape cmd metacharacters so cmd.exe
 * passes everything through literally. `doubleEscape` is needed for npm `node_modules/.bin`
 * shims which re-parse `%*`.
 * @param {string} arg
 * @param {boolean} [doubleEscape]
 */
export function quoteCmdArg(arg, doubleEscape = false) {
  let s = String(arg);
  // Backslashes before a quote must be doubled, and the quote itself escaped.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes would escape our closing quote: double them.
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

/**
 * @typedef {object} SpawnSpec
 * @property {string} command
 * @property {string[]} args
 * @property {{ windowsVerbatimArguments?: boolean, windowsHide?: boolean, detached?: boolean }} options
 * @property {'direct'|'cmd'|'node'} kind
 * @property {Record<string, string>} envExtra  variables the child needs on top of its env
 *   (ELECTRON_RUN_AS_NODE=1 when a .js file is run with Electron's own binary)
 */

/**
 * Work out how to spawn `file args…` on the given platform.
 *  - `.js/.mjs/.cjs` → run with Node (`nodePath`, e.g. process.execPath outside Electron).
 *  - win32 `.cmd/.bat` → through cmd.exe with safe quoting.
 *  - anything else → directly.
 * @param {string} file
 * @param {string[]} args
 * @param {{ platform?: string, comspec?: string, nodePath?: string, nodeArgs?: string[] }} [opts]
 * @returns {SpawnSpec}
 */
export function buildSpawnSpec(file, args, opts = {}) {
  const platform = opts.platform || process.platform;
  const isWin = platform === 'win32';
  const ext = (isWin ? path.win32 : path.posix).extname(file).toLowerCase();
  const base = { windowsHide: true, detached: !isWin };

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const nodePath = opts.nodePath || process.execPath;
    // Inside Electron, process.execPath is the Electron binary: make it behave as plain Node.
    const envExtra = !opts.nodePath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    return { kind: 'node', command: nodePath, args: [...(opts.nodeArgs || []), file, ...args], options: base, envExtra };
  }

  if (isWin && (ext === '.cmd' || ext === '.bat')) {
    for (const a of args) {
      if (/[\r\n\0]/.test(String(a))) {
        throw new Error('Refusing to pass an argument containing a line break or NUL through cmd.exe');
      }
    }
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
    const normalized = path.win32.normalize(file);
    const line = [escapeCmdCommand(normalized), ...args.map((a) => quoteCmdArg(a, doubleEscape))].join(' ');
    return {
      kind: 'cmd',
      command: opts.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { ...base, windowsVerbatimArguments: true },
      envExtra: {},
    };
  }

  return { kind: 'direct', command: file, args: [...args], options: base, envExtra: {} };
}

/**
 * Spawn using {@link buildSpawnSpec}.
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions & { platform?: string, nodePath?: string, nodeArgs?: string[], spawnImpl?: typeof spawn }} [options]
 */
export function spawnPortable(file, args, options = {}) {
  const { platform, nodePath, nodeArgs, spawnImpl, ...spawnOptions } = options;
  const spec = buildSpawnSpec(file, args, {
    platform,
    nodePath,
    nodeArgs,
    comspec: getEnv(spawnOptions.env || process.env, 'ComSpec'),
  });
  const env = Object.keys(spec.envExtra).length
    ? { ...(spawnOptions.env || process.env), ...spec.envExtra }
    : spawnOptions.env;
  const child = (spawnImpl || spawn)(spec.command, spec.args, { ...spec.options, ...spawnOptions, env });
  return { child, spec };
}

/**
 * Resolve when the child has exited (or immediately if it already has).
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if it exited within the timeout
 */
export function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/**
 * Kill a child and its descendants. Windows: `taskkill /T /F`. POSIX: signal the process group
 * (children are spawned detached), SIGTERM then SIGKILL after `graceMs`.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ platform?: string, graceMs?: number, spawnImpl?: typeof spawn }} [opts]
 * @returns {Promise<void>}
 */
export async function killProcessTree(child, opts = {}) {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const platform = opts.platform || process.platform;
  const graceMs = opts.graceMs ?? 1500;
  const pid = child.pid;

  if (platform === 'win32') {
    await new Promise((resolve) => {
      try {
        const k = (opts.spawnImpl || spawn)('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        k.once('error', () => {
          try { child.kill(); } catch { /* already gone */ }
          resolve(undefined);
        });
        k.once('exit', () => resolve(undefined));
      } catch {
        try { child.kill(); } catch { /* already gone */ }
        resolve(undefined);
      }
    });
    if (!(await waitForExit(child, graceMs))) {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }

  const signalTree = (signal) => {
    try {
      process.kill(-pid, signal); // whole process group (spawned detached)
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };
  signalTree('SIGTERM');
  if (await waitForExit(child, graceMs)) return;
  signalTree('SIGKILL');
  await waitForExit(child, 1000);
}

/**
 * Fixed-size text ring buffer for a child's stderr (surfaced in error messages).
 */
export class TextRingBuffer {
  /** @param {number} [maxChars] */
  constructor(maxChars = 16 * 1024) {
    this.maxChars = maxChars;
    this.text = '';
  }
  /** @param {string|Buffer} chunk */
  push(chunk) {
    this.text += String(chunk);
    if (this.text.length > this.maxChars) this.text = this.text.slice(this.text.length - this.maxChars);
  }
  clear() {
    this.text = '';
  }
  /** Last `n` non-empty lines, joined. @param {number} [n] */
  tail(n = 12) {
    return this.text
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(-n)
      .join('\n');
  }
}

/**
 * Exponential backoff delay: base * 2^(attempt-1), capped.
 * @param {number} attempt 1-based
 * @param {number} baseMs
 * @param {number} maxMs
 */
export function backoffDelay(attempt, baseMs, maxMs) {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}
