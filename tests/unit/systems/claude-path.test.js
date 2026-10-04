import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  executableNames,
  expandUserPath,
  findOnPath,
  knownLocations,
  probeVersion,
  resolveClaudeCli,
} from '../../../electron/claude-path.js';

/**
 * Fake fs from a list of existing paths. Entries ending in "/" (posix) or "\\" (win) are
 * directories; posix files are executable unless listed in `noexec`.
 */
function fakeFs(entries, { noexec = [], dirs = {} } = {}) {
  const files = new Set(entries.filter((e) => !/[\\/]$/.test(e)));
  const directories = new Set(entries.filter((e) => /[\\/]$/.test(e)).map((e) => e.slice(0, -1)));
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    statSync(p) {
      if (files.has(p)) return { isFile: () => true, isDirectory: () => false };
      if (directories.has(p)) return { isFile: () => false, isDirectory: () => true };
      throw enoent(p);
    },
    accessSync(p) {
      if (!files.has(p) || noexec.includes(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    readdirSync(p) {
      if (dirs[p]) return dirs[p];
      throw enoent(p);
    },
  };
}

const noRun = async () => ({ code: 1, stdout: '', stderr: 'npm not available in test' });
const versionRun = async (file, args) => {
  if (args[0] === '--version') return { code: 0, stdout: '2.1.288 (Claude Code)\n', stderr: '' };
  return { code: 1, stdout: '', stderr: '' };
};

const WIN_ENV = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs\\;"C:\\Quoted Dir"',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  USERPROFILE: 'C:\\Users\\Ada Lovelace',
  APPDATA: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Ada Lovelace\\AppData\\Local',
};

describe('executableNames', () => {
  it('uses PATHEXT on Windows with .exe before .cmd', () => {
    expect(executableNames('claude', { PATHEXT: '.COM;.CMD;.EXE;.BAT' }, 'win32')).toEqual(['claude.exe', 'claude.cmd', 'claude.bat', 'claude.com']);
    expect(executableNames('claude', {}, 'win32')).toEqual(['claude.exe', 'claude.cmd', 'claude.bat', 'claude.com']);
  });
  it('is the bare name on POSIX', () => {
    expect(executableNames('claude', {}, 'linux')).toEqual(['claude']);
  });
});

describe('expandUserPath', () => {
  it('expands ~ and env vars per platform', () => {
    expect(expandUserPath('~/bin/claude', { env: {}, platform: 'linux', homedir: '/home/ada' })).toBe('/home/ada/bin/claude');
    expect(expandUserPath('$HOME/x', { env: { HOME: '/h' }, platform: 'linux', homedir: '/h' })).toBe('/h/x');
    expect(expandUserPath('"%USERPROFILE%\\.local\\bin\\claude.exe"', { env: WIN_ENV, platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace' }))
      .toBe('C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe');
  });
});

describe('findOnPath', () => {
  it('finds claude.cmd on a Windows PATH (case-insensitive Path var, quoted entries)', () => {
    const fs = fakeFs(['C:\\Quoted Dir\\claude.cmd']);
    const r = findOnPath('claude', { env: WIN_ENV, platform: 'win32', fs });
    expect(r.found).toBe('C:\\Quoted Dir\\claude.cmd');
  });
  it('prefers claude.exe over claude.cmd in the same directory', () => {
    const fs = fakeFs(['C:\\Program Files\\nodejs\\claude.cmd', 'C:\\Program Files\\nodejs\\claude.exe']);
    expect(findOnPath('claude', { env: WIN_ENV, platform: 'win32', fs }).found).toBe('C:\\Program Files\\nodejs\\claude.exe');
  });
  it('never picks the extension-less sh shim on Windows', () => {
    const fs = fakeFs(['C:\\Program Files\\nodejs\\claude']);
    expect(findOnPath('claude', { env: WIN_ENV, platform: 'win32', fs }).found).toBeNull();
  });
  it('requires the executable bit on POSIX', () => {
    const fs = fakeFs(['/usr/bin/claude', '/opt/x/claude'], { noexec: ['/usr/bin/claude'] });
    const r = findOnPath('claude', { env: { PATH: '/usr/bin:/opt/x' }, platform: 'linux', fs });
    expect(r.found).toBe('/opt/x/claude');
    expect(r.tried).toEqual(['/usr/bin/claude', '/opt/x/claude']);
  });
});

describe('knownLocations', () => {
  it('lists the Windows native installer and npm shim first', () => {
    const list = knownLocations({ env: WIN_ENV, platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace', fs: fakeFs([]) });
    expect(list[0]).toBe('C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe');
    expect(list[1]).toBe('C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd');
  });
  it('includes POSIX locations and nvm versions newest first', () => {
    const fs = fakeFs([], { dirs: { '/home/ada/.nvm/versions/node': ['v18.20.0', 'v22.12.0', 'v20.1.0', 'junk'] } });
    const list = knownLocations({ env: {}, platform: 'linux', homedir: '/home/ada', fs });
    expect(list.slice(0, 2)).toEqual(['/home/ada/.local/bin/claude', '/home/ada/.claude/local/claude']);
    expect(list).toContain('/usr/local/bin/claude');
    const nvm = list.filter((p) => p.includes('.nvm'));
    expect(nvm).toEqual([
      '/home/ada/.nvm/versions/node/v22.12.0/bin/claude',
      '/home/ada/.nvm/versions/node/v20.1.0/bin/claude',
      '/home/ada/.nvm/versions/node/v18.20.0/bin/claude',
    ]);
  });
});

describe('resolveClaudeCli', () => {
  it('uses a valid settings override (with version probe)', async () => {
    const fs = fakeFs(['D:\\tools\\claude.exe']);
    const r = await resolveClaudeCli({ override: 'D:\\tools\\claude.exe', env: WIN_ENV, platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace', fs, run: versionRun });
    expect(r).toMatchObject({ path: 'D:\\tools\\claude.exe', source: 'settings', version: '2.1.288 (Claude Code)' });
  });

  it('accepts a directory override', async () => {
    const fs = fakeFs(['/opt/claude/', '/opt/claude/claude']);
    const r = await resolveClaudeCli({ override: '/opt/claude', env: {}, platform: 'linux', homedir: '/home/a', fs, run: versionRun });
    expect(r.path).toBe('/opt/claude/claude');
  });

  it('falls back to auto-detection (with a warning) when the override is missing', async () => {
    const fs = fakeFs(['C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe']);
    const r = await resolveClaudeCli({ override: 'C:\\nope\\claude.exe', env: { ...WIN_ENV, Path: '' }, platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace', fs, run: versionRun });
    expect(r.source).toBe('known');
    expect(r.path).toBe('C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe');
    expect(r.warning).toMatch(/was not found/);
  });

  it('finds the npm global shim on Windows when PATH is minimal', async () => {
    const fs = fakeFs(['C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd']);
    const r = await resolveClaudeCli({ env: { ...WIN_ENV, Path: 'C:\\Windows' }, platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace', fs, run: versionRun });
    expect(r).toMatchObject({ source: 'known', path: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd' });
  });

  it('prefers PATH over known locations on Linux', async () => {
    const fs = fakeFs(['/usr/local/bin/claude', '/home/ada/.local/bin/claude']);
    const r = await resolveClaudeCli({ env: { PATH: '/usr/local/bin' }, platform: 'linux', homedir: '/home/ada', fs, run: versionRun });
    expect(r).toMatchObject({ source: 'path', path: '/usr/local/bin/claude' });
  });

  it('uses the npm prefix as a last resort', async () => {
    const fs = fakeFs(['/usr/bin/npm', '/srv/npm-global/bin/claude']);
    const run = async (file, args) => {
      if (file === '/usr/bin/npm') return { code: 0, stdout: '/srv/npm-global\n', stderr: '' };
      return versionRun(file, args);
    };
    const r = await resolveClaudeCli({ env: { PATH: '/usr/bin' }, platform: 'linux', homedir: '/home/ada', fs, run });
    expect(r).toMatchObject({ source: 'npm', path: '/srv/npm-global/bin/claude' });
  });

  it('reports not found with guidance', async () => {
    const r = await resolveClaudeCli({ env: { PATH: '' }, platform: 'linux', homedir: '/home/ada', fs: fakeFs([]), run: noRun });
    expect(r.path).toBeNull();
    expect(r.error).toMatch(/Claude CLI not found/);
    expect(r.tried.length).toBeGreaterThan(5);
  });

  it('keeps the path but warns when the version probe fails', async () => {
    const fs = fakeFs(['/usr/bin/claude']);
    const run = async () => ({ code: null, stdout: '', stderr: '(timed out after 10 ms)' });
    const r = await resolveClaudeCli({ env: { PATH: '/usr/bin' }, platform: 'linux', homedir: '/h', fs, run });
    expect(r.path).toBe('/usr/bin/claude');
    expect(r.version).toBeUndefined();
    expect(r.warning).toMatch(/--version" failed/);
  });
});

describe('probeVersion (real process)', () => {
  it('runs the fake CLI', async () => {
    const fake = path.resolve('tests/fixtures/fake-claude.mjs');
    const r = await probeVersion(fake, { timeoutMs: 10000 });
    expect(r.version).toBe('9.9.9 (Fake Claude)');
  });
  it('reports a missing binary', async () => {
    const r = await probeVersion('/definitely/not/here/claude', { timeoutMs: 5000 });
    expect(r.error).toBeTruthy();
  });
});
