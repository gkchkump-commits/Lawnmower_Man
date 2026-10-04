import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  STRIPPED_ENV_VARS,
  TextRingBuffer,
  backoffDelay,
  buildSpawnSpec,
  cleanChildEnv,
  getEnv,
  killProcessTree,
  quoteCmdArg,
} from '../../../electron/spawn-util.js';

describe('cleanChildEnv', () => {
  it('strips nested-CLI / Electron variables case-insensitively and applies extras', () => {
    const env = { PATH: '/bin', CLAUDECODE: '1', claude_code_entrypoint: 'cli', ELECTRON_RUN_AS_NODE: '1', KEEP: 'x', UNDEF: undefined };
    const out = cleanChildEnv(env, { EXTRA: 'y' });
    expect(out).toEqual({ PATH: '/bin', KEEP: 'x', EXTRA: 'y' });
    expect(STRIPPED_ENV_VARS).toContain('CLAUDECODE');
  });
  it('replaces case-variant keys instead of duplicating them (Windows Path)', () => {
    const out = cleanChildEnv({ Path: 'C:\\a' }, { PATH: 'C:\\b' });
    expect(out).toEqual({ PATH: 'C:\\b' });
  });
  it('getEnv is case-insensitive', () => {
    expect(getEnv({ Path: 'x' }, 'PATH')).toBe('x');
    expect(getEnv({}, 'PATH')).toBeUndefined();
  });
});

describe('quoteCmdArg (cmd.exe + MSVCRT)', () => {
  it.each([
    ['simple', '^"simple^"'],
    ['', '^"^"'],
    ['C:\\Users\\Ada Lovelace\\persona.txt', '^"C:\\Users\\Ada^ Lovelace\\persona.txt^"'],
    ['Read,Glob,Grep', '^"Read^,Glob^,Grep^"'],
    ['a&b|c<d>e^f', '^"a^&b^|c^<d^>e^^f^"'],
    ['100%', '^"100^%^"'],
    ['trailing\\', '^"trailing\\\\^"'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['(x)!', '^"^(x^)^!^"'],
  ])('%j', (arg, expected) => {
    expect(quoteCmdArg(arg)).toBe(expected);
  });
});

describe('buildSpawnSpec', () => {
  it('spawns .exe directly on Windows', () => {
    const s = buildSpawnSpec('C:\\Users\\A\\.local\\bin\\claude.exe', ['-p', '--tools', ''], { platform: 'win32' });
    expect(s.kind).toBe('direct');
    expect(s.command).toBe('C:\\Users\\A\\.local\\bin\\claude.exe');
    expect(s.args).toEqual(['-p', '--tools', '']);
    expect(s.options.windowsHide).toBe(true);
    expect(s.options.detached).toBe(false);
  });

  it('routes .cmd through cmd.exe /d /s /c with verbatim, escaped arguments', () => {
    const s = buildSpawnSpec('C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd', ['-p', '--tools', '', '--system-prompt-file', 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Lawnmower Man\\persona\\persona-chat.txt'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(s.kind).toBe('cmd');
    expect(s.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(s.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(s.options.windowsVerbatimArguments).toBe(true);
    expect(s.args[3]).toBe(
      '"C:\\Users\\Ada^ Lovelace\\AppData\\Roaming\\npm\\claude.cmd ^"-p^" ^"--tools^" ^"^" ^"--system-prompt-file^" ^"C:\\Users\\Ada^ Lovelace\\AppData\\Roaming\\Lawnmower^ Man\\persona\\persona-chat.txt^""',
    );
  });

  it('double-escapes for node_modules/.bin shims', () => {
    const s = buildSpawnSpec('C:\\p\\node_modules\\.bin\\claude.cmd', ['a b'], { platform: 'win32' });
    expect(s.args[3]).toContain('^^^"a^^^ b^^^"');
  });

  it('refuses line breaks on the cmd.exe path', () => {
    expect(() => buildSpawnSpec('C:\\x\\claude.cmd', ['a\nb'], { platform: 'win32' })).toThrow(/line break/);
  });

  it('runs .js/.mjs files with node and spawns detached on POSIX', () => {
    const s = buildSpawnSpec('/x/cli.mjs', ['--version'], { platform: 'linux', nodePath: '/usr/bin/node' });
    expect(s).toMatchObject({ kind: 'node', command: '/usr/bin/node', args: ['/x/cli.mjs', '--version'] });
    expect(s.options.detached).toBe(true);
    const d = buildSpawnSpec('/usr/bin/claude', ['-p'], { platform: 'linux' });
    expect(d).toMatchObject({ kind: 'direct', command: '/usr/bin/claude', args: ['-p'] });
  });
});

describe('killProcessTree', () => {
  it.skipIf(process.platform === 'win32')('kills a child and its grandchildren (process group)', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 100));
    await killProcessTree(child, { graceMs: 500 });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // The whole group goes away (grandchildren are reaped asynchronously, so poll briefly).
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && groupAlive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(groupAlive()).toBe(false);
  });
  it('is a no-op for exited children', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    await expect(killProcessTree(child)).resolves.toBeUndefined();
  });
});

describe('misc', () => {
  it('TextRingBuffer keeps the tail', () => {
    const b = new TextRingBuffer(10);
    b.push('hello\n');
    b.push('world\nmore');
    expect(b.text.length).toBeLessThanOrEqual(10);
    expect(b.tail(1)).toBe('more');
  });
  it('backoffDelay doubles and caps', () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffDelay(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});
