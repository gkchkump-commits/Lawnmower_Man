// First-run problems the user has to fix outside the app: no Claude CLI, or a CLI that is not
// logged in. ClaudeSession reports them as `problem` events (the renderer's setup card), and
// retry() re-detects the CLI and restarts it without restarting the app.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSession, classifyClaudeError } from '../../../electron/claude-session.js';
import { knownLocations, refreshPathFromRegistry, NOT_FOUND_MESSAGE, INSTALL_DOCS_URL } from '../../../electron/claude-path.js';

const FAKE = path.resolve('tests/fixtures/fake-claude.mjs');
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** @param {{ env?: object, resolveCli?: Function, cliPath?: string }} o */
function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-setup-'));
  const settings = { cliPath: '', model: '', effort: '', mode: 'chat', workdir: path.join(dir, 'work'), persona: '', resumeLastSession: true, lastSessionId: '' };
  const events = [];
  const logFile = path.join(dir, 'argv.jsonl');
  const session = new ClaudeSession({
    getSettings: () => settings,
    personaDir: path.join(dir, 'persona'),
    onSessionId: (id) => { settings.lastSessionId = id; },
    cliPath: o.cliPath,
    resolveCli: o.resolveCli,
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE_DIR: path.join(dir, 'state'), ...(o.env || {}) },
    restart: { baseDelayMs: 20, maxDelayMs: 50, maxAttempts: 1 },
  });
  session.on('event', (e) => events.push(e));
  cleanups.push(async () => {
    await session.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const waitFor = async (pred, timeout = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > timeout) throw new Error(`timed out; events: ${events.map((e) => e.type + (e.status ? `:${e.status}` : '')).join(', ')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const argv = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv) : []);
  return { dir, settings, session, events, waitFor, argv };
}

describe('classifyClaudeError', () => {
  it('recognises the login errors the CLI prints', () => {
    for (const t of [
      'Not logged in · Please run /login',
      'Invalid API key · Please run /login',
      'Login expired · Please run /login',
      'Failed to authenticate: OAuth token revoked',
      'OAuth token has expired',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'API Error: 401 Invalid authentication credentials',
      'Authentication required · Sign in again to continue',
      'API Error: 400 {"type":"error","error":{"message":"This organization has been disabled"}}',
      '{"type":"authentication_error"}',
    ]) expect(classifyClaudeError(t), t).toBe('auth');
  });
  it('ignores ordinary failures', () => {
    for (const t of ['', 'Something went wrong.', 'simulated error', 'Claude CLI exited unexpectedly (code 3)', 'The server answered 401 to the fetch', undefined, 42]) {
      expect(classifyClaudeError(t), String(t)).toBe(null);
    }
  });
});

describe('ClaudeSession setup problems', () => {
  it('reports a missing CLI as a problem, and retry() finds it once it is installed', async () => {
    let installed = false;
    let calls = 0;
    const h = make({
      resolveCli: async () => {
        calls++;
        return installed
          ? { path: FAKE, source: 'known', version: '9.9.9 (Fake Claude)', tried: [] }
          : { path: null, source: null, error: NOT_FOUND_MESSAGE, notFound: true, tried: [] };
      },
    });
    await expect(h.session.start()).rejects.toThrow(/not found/i);
    const problem = await h.waitFor((e) => e.type === 'problem' && e.problem);
    expect(problem.problem).toEqual({ kind: 'cli-missing', detail: NOT_FOUND_MESSAGE });
    expect(h.session.status()).toMatchObject({ status: 'error', problem: { kind: 'cli-missing' } });
    // still missing: Retry rejects and the card stays
    await expect(h.session.retry()).rejects.toThrow(/not found/i);
    expect(h.session.status().problem?.kind).toBe('cli-missing');

    installed = true; // the user ran the installer in a terminal
    const before = calls;
    await h.session.retry();
    expect(calls).toBeGreaterThan(before); // re-detected, not the cached result
    expect(h.session.status().status).toBe('ready');
    expect(h.session.status().problem).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'problem').at(-1)).toEqual({ type: 'problem', problem: null });
    const { turnId } = await h.session.send('hello');
    const end = await h.waitFor((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(end).toMatchObject({ isError: false, result: 'You said: hello' });
  });

  it('a CLI path that vanished (ENOENT) is a missing CLI too', async () => {
    const h = make({ cliPath: path.join(os.tmpdir(), 'definitely-missing-claude-binary') });
    await h.session.start().catch(() => {});
    const p = await h.waitFor((e) => e.type === 'problem' && e.problem);
    expect(p.problem.kind).toBe('cli-missing');
  });

  it('detects "not logged in", shows it before turn_end, and Retry after logging in clears it', async () => {
    const h0 = make({ cliPath: FAKE });
    const loginFile = path.join(h0.dir, 'logged-in');
    const h = make({ cliPath: FAKE, env: { FAKE_CLAUDE_AUTH_FILE: loginFile } });
    const { turnId } = await h.session.send('hi');
    const end = await h.waitFor((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(end.isError).toBe(true);
    const iProblem = h.events.findIndex((e) => e.type === 'problem' && e.problem);
    const iEnd = h.events.indexOf(end);
    expect(iProblem).toBeGreaterThanOrEqual(0);
    expect(iProblem).toBeLessThan(iEnd); // the card replaces the generic error toast
    expect(h.events[iProblem].problem).toEqual({ kind: 'auth', detail: 'Not logged in · Please run /login' });
    expect(h.session.status().problem).toEqual({ kind: 'auth', detail: 'Not logged in · Please run /login' });

    fs.writeFileSync(loginFile, 'ok'); // the user ran `claude` and signed in
    const spawnsBefore = h.argv().length;
    await h.session.retry();
    expect(h.session.status().problem).toBeUndefined();
    expect(h.argv().length).toBe(spawnsBefore + 1); // the CLI was restarted to pick up the login
    expect(h.argv().at(-1)).toContain('--resume'); // … in the same conversation
    const t2 = await h.session.send('hi again');
    const end2 = await h.waitFor((e) => e.type === 'turn_end' && e.turnId === t2.turnId);
    expect(end2).toMatchObject({ isError: false, result: 'You said: hi again' });
  });

  it('a successful turn clears a stale login problem', async () => {
    const h = make({ cliPath: FAKE });
    const a = await h.session.send('notloggedin');
    await h.waitFor((e) => e.type === 'turn_end' && e.turnId === a.turnId);
    expect(h.session.status().problem?.kind).toBe('auth');
    const b = await h.session.send('hello');
    await h.waitFor((e) => e.type === 'turn_end' && e.turnId === b.turnId);
    expect(h.session.status().problem).toBeUndefined();
  });

  it('a startup failure whose stderr asks for /login is a login problem', async () => {
    const h = make({ cliPath: FAKE, env: { FAKE_CLAUDE_EXIT_AT_START: '1', FAKE_CLAUDE_START_MESSAGE: 'Invalid API key · Please run /login' } });
    await h.session.start().catch(() => {});
    const p = await h.waitFor((e) => e.type === 'problem' && e.problem);
    expect(p.problem).toEqual({ kind: 'auth', detail: 'Invalid API key · Please run /login' });
  });

  it('ordinary errors are not setup problems', async () => {
    const h = make({ cliPath: FAKE });
    const { turnId } = await h.session.send('error please');
    await h.waitFor((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(h.events.some((e) => e.type === 'problem')).toBe(false);
  });
});

describe('finding a freshly installed CLI', () => {
  it('knows the WinGet links folder and points at the current install docs', () => {
    const locs = knownLocations({ env: { USERPROFILE: 'C:\\Users\\José Ñ', LOCALAPPDATA: 'C:\\Users\\José Ñ\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\José Ñ', fs });
    expect(locs[0]).toBe('C:\\Users\\José Ñ\\.local\\bin\\claude.exe');
    expect(locs).toContain('C:\\Users\\José Ñ\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe');
    expect(NOT_FOUND_MESSAGE).toContain(INSTALL_DOCS_URL);
    expect(INSTALL_DOCS_URL).toBe('https://code.claude.com/docs/en/setup');
  });

  it('refreshPathFromRegistry appends new absolute entries only (Windows), via PowerShell', async () => {
    const env = { Path: 'C:\\Windows\\System32;C:\\Users\\José Ñ\\AppData\\Local\\Microsoft\\WindowsApps\\', SystemRoot: 'C:\\Windows' };
    const calls = [];
    const run = async (file, args) => {
      calls.push({ file, args });
      return {
        code: 0,
        stderr: '',
        stdout: 'C:\\Windows\\system32;C:\\Program Files\\nodejs\\;relative\\dir\r\n'
          + 'C:\\Users\\José Ñ\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\José Ñ\\.local\\bin;"C:\\Users\\José Ñ\\AppData\\Roaming\\npm"\r\n',
      };
    };
    const added = await refreshPathFromRegistry({ env, platform: 'win32', run });
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0].args).toContain('-NonInteractive');
    expect(added).toEqual(['C:\\Program Files\\nodejs\\', 'C:\\Users\\José Ñ\\.local\\bin', 'C:\\Users\\José Ñ\\AppData\\Roaming\\npm']);
    expect(env.Path.split(';').slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\Users\\José Ñ\\AppData\\Local\\Microsoft\\WindowsApps\\']);
    expect(env.Path.endsWith(';C:\\Users\\José Ñ\\AppData\\Roaming\\npm')).toBe(true);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    // nothing new the second time; failures and other platforms change nothing
    expect(await refreshPathFromRegistry({ env, platform: 'win32', run })).toEqual([]);
    expect(await refreshPathFromRegistry({ env, platform: 'win32', run: async () => ({ code: 1, stdout: 'C:\\x', stderr: 'no' }) })).toEqual([]);
    const posix = { PATH: '/usr/bin' };
    expect(await refreshPathFromRegistry({ env: posix, platform: 'linux', run })).toEqual([]);
    expect(posix.PATH).toBe('/usr/bin');
  });
});
