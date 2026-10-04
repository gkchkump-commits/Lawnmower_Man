// Locate the user's Claude CLI.
//
// Order: settings override → PATH (honouring PATHEXT on Windows) → well-known install
// locations → `npm config get prefix` → not found. GUI-launched apps (Start menu, Finder,
// desktop launchers) often get a minimal PATH, which is why the known locations matter.
//
// Everything platform-related is injectable (fs, env, platform, homedir, exec) so both the
// Windows and the POSIX logic are unit-tested on any OS.

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSpawnSpec, cleanChildEnv, getEnv } from './spawn-util.js';

/**
 * @typedef {object} ResolveOptions
 * @property {string} [override]      settings.claude.cliPath ('' = auto)
 * @property {Record<string,string|undefined>} [env]
 * @property {string} [platform]
 * @property {string} [homedir]
 * @property {Pick<typeof nodeFs, 'statSync'|'accessSync'|'readdirSync'>} [fs]
 * @property {boolean} [probeVersion]  run `claude --version` (default true)
 * @property {number} [timeoutMs]      version probe timeout
 * @property {(file: string, args: string[], timeoutMs: number) => Promise<{ code: number|null, stdout: string, stderr: string }>} [run]
 * @property {boolean} [useNpmPrefix]  ask npm for its global prefix as a last resort (default true)
 */

/**
 * @typedef {object} ResolveResult
 * @property {string|null} path
 * @property {'settings'|'path'|'known'|'npm'|null} source
 * @property {string} [version]
 * @property {string} [error]     set when not found
 * @property {boolean} [notFound]  no CLI executable was found at all
 * @property {string} [warning]   e.g. configured override missing, version probe failed
 * @property {string[]} tried     candidates checked, in order (diagnostics)
 */

/** @param {string} platform */
const pathLib = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Expand `~`, `%VAR%` (Windows) and `$VAR` / `${VAR}` (POSIX) in a user-supplied path.
 * @param {string} p @param {{ env: Record<string,string|undefined>, platform: string, homedir: string }} ctx
 */
export function expandUserPath(p, { env, platform, homedir }) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = homedir + s.slice(1);
  if (platform === 'win32') s = s.replace(/%([^%]+)%/g, (m, name) => getEnv(env, name) ?? m);
  else s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => getEnv(env, name) ?? m);
  return s;
}

/**
 * Is `p` an (executable) regular file?
 * @param {string} p @param {ResolveOptions['fs']} fs @param {string} platform
 */
function isExecutableFile(p, fs, platform) {
  try {
    const st = /** @type {any} */ (fs).statSync(p);
    if (!st || !st.isFile()) return false;
    if (platform !== 'win32') /** @type {any} */ (fs).accessSync(p, nodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p @param {ResolveOptions['fs']} fs */
function isDirectory(p, fs) {
  try {
    return /** @type {any} */ (fs).statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Executable names to try for a bare command on this platform.
 * Windows: PATHEXT order, but `.exe` before `.cmd`/`.bat` (the native installer ships an .exe;
 * the npm shim is a .cmd). A bare extension-less `claude` (npm's sh shim) is never used there.
 * @param {string} name @param {Record<string,string|undefined>} env @param {string} platform
 */
export function executableNames(name, env, platform) {
  if (platform !== 'win32') return [name];
  const pathext = (getEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  const rank = (/** @type {string} */ e) => (e === '.exe' ? 0 : e === '.cmd' ? 1 : e === '.bat' ? 2 : 3);
  const exts = [...new Set(pathext)].filter((e) => ['.exe', '.cmd', '.bat', '.com'].includes(e));
  exts.sort((a, b) => rank(a) - rank(b));
  if (!exts.length) exts.push('.exe', '.cmd');
  return exts.map((e) => name + e);
}

/**
 * Search PATH for `name`.
 * @returns {{ found: string|null, tried: string[] }}
 */
export function findOnPath(name, { env = process.env, platform = process.platform, fs = nodeFs } = {}) {
  const P = pathLib(platform);
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (getEnv(env, 'PATH') || '')
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const names = executableNames(name, env, platform);
  const tried = [];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = P.join(dir, n);
      tried.push(candidate);
      if (isExecutableFile(candidate, fs, platform)) return { found: candidate, tried };
    }
  }
  return { found: null, tried };
}

/**
 * Well-known install locations, most likely first.
 * @param {{ env: Record<string,string|undefined>, platform: string, homedir: string, fs: any }} ctx
 * @returns {string[]}
 */
export function knownLocations({ env, platform, homedir, fs }) {
  const P = pathLib(platform);
  const home = homedir;
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {string|undefined|null} */ base, /** @type {string[]} */ ...rest) => {
    if (base) out.push(P.join(base, ...rest));
  };

  if (platform === 'win32') {
    const userProfile = getEnv(env, 'USERPROFILE') || home;
    const appData = getEnv(env, 'APPDATA') || P.join(userProfile, 'AppData', 'Roaming');
    const localAppData = getEnv(env, 'LOCALAPPDATA') || P.join(userProfile, 'AppData', 'Local');
    add(userProfile, '.local', 'bin', 'claude.exe'); // native installer
    add(appData, 'npm', 'claude.cmd'); // npm global (default prefix)
    add(userProfile, '.claude', 'local', 'claude.exe');
    add(userProfile, '.claude', 'local', 'claude.cmd');
    add(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'); // winget install Anthropic.ClaudeCode
    add(localAppData, 'Volta', 'bin', 'claude.exe');
    add(localAppData, 'pnpm', 'claude.cmd');
    add(userProfile, 'scoop', 'shims', 'claude.exe');
    add(userProfile, '.bun', 'bin', 'claude.exe');
    add(getEnv(env, 'npm_config_prefix'), 'claude.cmd');
    add(getEnv(env, 'ProgramFiles'), 'nodejs', 'claude.cmd');
    return [...new Set(out)];
  }

  add(home, '.local', 'bin', 'claude'); // native installer
  add(home, '.claude', 'local', 'claude'); // "local" npm install
  add(getEnv(env, 'npm_config_prefix'), 'bin', 'claude');
  add(getEnv(env, 'NVM_BIN'), 'claude');
  out.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude');
  add(home, '.npm-global', 'bin', 'claude');
  add(home, '.volta', 'bin', 'claude');
  add(home, '.bun', 'bin', 'claude');
  add(home, '.local', 'share', 'pnpm', 'claude');
  add(home, 'Library', 'pnpm', 'claude');
  // nvm installs: newest Node version first.
  const nvmDir = getEnv(env, 'NVM_DIR') || P.join(home, '.nvm');
  try {
    const versions = /** @type {string[]} */ (fs.readdirSync(P.join(nvmDir, 'versions', 'node')));
    versions
      .filter((v) => /^v?\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => compareVersions(b, a))
      .forEach((v) => add(nvmDir, 'versions', 'node', v, 'bin', 'claude'));
  } catch {
    /* no nvm */
  }
  return [...new Set(out)];
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/**
 * Run a short command and capture output, with a hard timeout. Uses the same spawn rules as the
 * session (cmd.exe for .cmd shims), never a shell.
 * @param {string} file @param {string[]} args @param {number} timeoutMs
 * @param {{ env?: Record<string,string|undefined>, platform?: string }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runCapture(file, args, timeoutMs, opts = {}) {
  return new Promise((resolve) => {
    let spec;
    try {
      spec = buildSpawnSpec(file, args, { platform: opts.platform, comspec: getEnv(opts.env || process.env, 'ComSpec') });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: /** @type {Error} */ (err).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    const finish = (/** @type {number|null} */ code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    try {
      child = spawn(spec.command, spec.args, {
        ...spec.options,
        detached: false,
        env: cleanChildEnv(opts.env || process.env, spec.envExtra),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: /** @type {Error} */ (err).message });
      return;
    }
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${timeoutMs} ms)`;
      try { child.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < 65536) stderr += d; });
    child.once('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}

/**
 * `claude --version` → "2.1.288 (Claude Code)".
 * @param {string} cliPath
 * @param {{ timeoutMs?: number, run?: ResolveOptions['run'], env?: Record<string,string|undefined>, platform?: string }} [opts]
 * @returns {Promise<{ version?: string, error?: string }>}
 */
export async function probeVersion(cliPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const run = opts.run || ((f, a, t) => runCapture(f, a, t, { env: opts.env, platform: opts.platform }));
  const r = await run(cliPath, ['--version'], timeoutMs);
  const line = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (r.code === 0 && line) return { version: line.slice(0, 200) };
  const why = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
  return { error: `"${cliPath} --version" failed${r.code !== null ? ` (exit ${r.code})` : ''}${why ? `: ${why}` : ''}` };
}

/** Official install guide (verified 2026-10: native installer, WinGet, Homebrew, npm). */
export const INSTALL_DOCS_URL = 'https://code.claude.com/docs/en/setup';

export const NOT_FOUND_MESSAGE =
  `Claude CLI not found. Install Claude Code (${INSTALL_DOCS_URL}), ` +
  'sign in once by running "claude" in a terminal, or set the CLI path in Settings.';

/**
 * Resolve the Claude CLI executable.
 * @param {ResolveOptions} [opts]
 * @returns {Promise<ResolveResult>}
 */
export async function resolveClaudeCli(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const homedir = opts.homedir || os.homedir();
  const fs = opts.fs || nodeFs;
  const P = pathLib(platform);
  /** @type {string[]} */
  const tried = [];
  /** @type {string|undefined} */
  let warning;

  /** @type {{ path: string, source: ResolveResult['source'] } | null} */
  let hit = null;

  // 1. Explicit override from settings.
  if (opts.override && String(opts.override).trim()) {
    const p = expandUserPath(opts.override, { env, platform, homedir });
    tried.push(p);
    if (isExecutableFile(p, fs, platform)) {
      hit = { path: p, source: 'settings' };
    } else if (isDirectory(p, fs)) {
      for (const n of executableNames('claude', env, platform)) {
        const c = P.join(p, n);
        tried.push(c);
        if (isExecutableFile(c, fs, platform)) {
          hit = { path: c, source: 'settings' };
          break;
        }
      }
    }
    if (!hit) warning = `Configured Claude CLI path "${opts.override}" was not found; using auto-detection.`;
  }

  // 2. PATH.
  if (!hit) {
    const r = findOnPath('claude', { env, platform, fs });
    tried.push(...r.tried);
    if (r.found) hit = { path: r.found, source: 'path' };
  }

  // 3. Known install locations.
  if (!hit) {
    for (const c of knownLocations({ env, platform, homedir, fs })) {
      tried.push(c);
      if (isExecutableFile(c, fs, platform)) {
        hit = { path: c, source: 'known' };
        break;
      }
    }
  }

  // 4. npm global prefix (slow; last resort).
  if (!hit && opts.useNpmPrefix !== false) {
    const run = opts.run || ((f, a, t) => runCapture(f, a, t, { env, platform }));
    const npm = findOnPath('npm', { env, platform, fs }).found;
    if (npm) {
      const r = await run(npm, ['config', 'get', 'prefix'], 8000);
      const prefix = (r.stdout || '').trim().split(/\r?\n/)[0];
      if (r.code === 0 && prefix) {
        const c = platform === 'win32' ? P.join(prefix, 'claude.cmd') : P.join(prefix, 'bin', 'claude');
        tried.push(c);
        if (isExecutableFile(c, fs, platform)) hit = { path: c, source: 'npm' };
      }
    }
  }

  if (!hit) return { path: null, source: null, error: NOT_FOUND_MESSAGE, notFound: true, warning, tried };

  /** @type {ResolveResult} */
  const result = { path: hit.path, source: hit.source, tried, warning };
  if (opts.probeVersion !== false) {
    const v = await probeVersion(hit.path, { timeoutMs: opts.timeoutMs, run: opts.run, env, platform });
    if (v.version) result.version = v.version;
    else result.warning = [warning, v.error].filter(Boolean).join(' ');
  }
  return result;
}

/**
 * Windows: merge the PATH that is stored in the registry (machine + user, as a new terminal
 * would see it) into `env.PATH`, so a CLI installed after the app started (WinGet, npm, the
 * native installer adding %USERPROFILE%\.local\bin) is found by "Retry" without restarting
 * the app. Entries are only ever added (at the end), never removed or reordered, and only
 * absolute paths are accepted. Read through PowerShell so non-ASCII user names survive
 * (reg.exe prints in the OEM code page). No-op on other platforms.
 * @param {{ env?: Record<string, string|undefined>, platform?: string,
 *   run?: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number|null, stdout: string, stderr: string }> }} [o]
 * @returns {Promise<string[]>} the entries that were added
 */
export async function refreshPathFromRegistry(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  if (platform !== 'win32') return [];
  const systemRoot = getEnv(env, 'SystemRoot') || 'C:\\Windows';
  const ps = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "[Environment]::GetEnvironmentVariable('Path', 'Machine'); [Environment]::GetEnvironmentVariable('Path', 'User')";
  const run = o.run || ((f, a, t) => runCapture(f, a, t, { env, platform }));
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], 15000);
  if (r.code !== 0) return [];
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const current = String(env[pathKey] || '');
  const have = new Set(current.split(';').map((d) => d.trim().replace(/[\\/]+$/, '').toLowerCase()).filter(Boolean));
  const added = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    for (const raw of line.split(';')) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      if (!dir || !path.win32.isAbsolute(dir) || /[\0\r\n]/.test(dir)) continue;
      const key = dir.replace(/[\\/]+$/, '').toLowerCase();
      if (have.has(key)) continue;
      have.add(key);
      added.push(dir);
    }
  }
  if (added.length) env[pathKey] = [current.replace(/;+$/, ''), ...added].filter(Boolean).join(';');
  return added;
}
