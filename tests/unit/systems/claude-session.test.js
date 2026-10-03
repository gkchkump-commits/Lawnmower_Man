// End-to-end tests of ClaudeSession against tests/fixtures/fake-claude.mjs (a faithful emulation
// of `claude -p` stream-json, spawned through the session's cliPath override).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSISTANT_TOOLS,
  ClaudeSession,
  buildClaudeArgs,
  resolveWorkdir,
  summarizeToolResult,
} from '../../../electron/claude-session.js';

const FAKE = path.resolve('tests/fixtures/fake-claude.mjs');
const sessions = [];

afterEach(async () => {
  while (sessions.length) {
    const h = sessions.pop();
    await h.session.stop().catch(() => {});
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

/**
 * @param {{ settings?: object, env?: object, opts?: object }} [o]
 */
function harness(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-claude-'));
  const logFile = path.join(dir, 'argv.jsonl');
  const settings = {
    cliPath: '', model: '', effort: '', mode: 'chat', workdir: path.join(dir, 'work dir'), persona: '',
    resumeLastSession: true, lastSessionId: '',
    ...(o.settings || {}),
  };
  const persisted = [];
  const events = [];
  const logs = [];
  const session = new ClaudeSession({
    getSettings: () => settings,
    personaDir: path.join(dir, 'persona'),
    onSessionId: (id) => {
      persisted.push(id);
      settings.lastSessionId = id;
    },
    cliPath: FAKE,
    env: {
      ...process.env,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_parent',
      FAKE_MARKER: 'kept',
      FAKE_CLAUDE_LOG: logFile,
      FAKE_CLAUDE_STATE_DIR: path.join(dir, 'state'),
      ...(o.env || {}),
    },
    restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
    interruptTimeoutMs: 1500,
    log: (level, msg) => logs.push(`${level} ${msg}`),
    ...(o.opts || {}),
  });
  const listeners = new Set();
  session.on('event', (ev) => {
    events.push(ev);
    for (const l of [...listeners]) l(ev);
  });
  /** Wait for the first event (from now or already seen after `from`) matching pred. */
  const waitFor = (pred, { timeout = 8000, from = 0 } = {}) =>
    new Promise((resolve, reject) => {
      const seen = events.slice(from).find(pred);
      if (seen) return resolve(seen);
      const timer = setTimeout(() => {
        listeners.delete(l);
        reject(new Error(`timed out waiting for event; got: ${events.map((e) => e.type + (e.status ? `:${e.status}` : '')).join(', ')}\nlogs:\n${logs.join('\n')}`));
      }, timeout);
      const l = (ev) => {
        if (pred(ev)) {
          clearTimeout(timer);
          listeners.delete(l);
          resolve(ev);
        }
      };
      listeners.add(l);
    });
  const turnEnd = (turnId, opt) => waitFor((e) => e.type === 'turn_end' && e.turnId === turnId, opt);
  const argvLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const textOf = (turnId) => events.filter((e) => e.type === 'text_delta' && e.turnId === turnId).map((e) => e.text).join('');
  const h = { dir, settings, session, events, logs, persisted, waitFor, turnEnd, argvLog, textOf };
  sessions.push(h);
  return h;
}

describe('buildClaudeArgs (contract §3.2)', () => {
  const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  it('chat mode: no tools, full system prompt file, no MCP servers', () => {
    expect(buildClaudeArgs({ mode: 'chat', personaFile: '/p.txt' })).toEqual([...base, '--tools', '', '--system-prompt-file', '/p.txt', '--strict-mcp-config']);
  });
  it('assistant mode: read-only tools pre-approved, appended prompt', () => {
    expect(buildClaudeArgs({ mode: 'assistant', personaFile: '/p.txt', model: 'sonnet', effort: 'high', resumeSessionId: 'abc-123' })).toEqual([
      ...base, '--model', 'sonnet', '--effort', 'high', '--resume', 'abc-123',
      '--tools', ASSISTANT_TOOLS, '--allowedTools', ASSISTANT_TOOLS, '--append-system-prompt-file', '/p.txt',
    ]);
    expect(ASSISTANT_TOOLS).toBe('Read,Glob,Grep,WebSearch,WebFetch');
  });
  it('agent mode: default tools, optional permission mode', () => {
    expect(buildClaudeArgs({ mode: 'agent', personaFile: '/p.txt' })).toEqual([...base, '--append-system-prompt-file', '/p.txt']);
    expect(buildClaudeArgs({ mode: 'agent', personaFile: '/p.txt', agentPermissionMode: 'acceptEdits' }).slice(-2)).toEqual(['--permission-mode', 'acceptEdits']);
  });
  it('rejects unsafe values', () => {
    expect(() => buildClaudeArgs({ mode: 'chat', personaFile: '/p', model: 'x y' })).toThrow();
    expect(() => buildClaudeArgs({ mode: 'chat', personaFile: '/p', effort: 'ultra' })).toThrow();
    expect(() => buildClaudeArgs({ mode: 'chat', personaFile: '/p', resumeSessionId: '../x' })).toThrow();
    expect(() => buildClaudeArgs({ mode: 'agent', personaFile: '/p', agentPermissionMode: 'bypassPermissions' })).toThrow();
  });
});

describe('helpers', () => {
  it('resolveWorkdir defaults to ~/LawnmowerMan', () => {
    expect(resolveWorkdir('', { homedir: '/home/ada', platform: 'linux' })).toBe('/home/ada/LawnmowerMan');
    expect(resolveWorkdir('', { homedir: 'C:\\Users\\Ada', platform: 'win32' })).toBe('C:\\Users\\Ada\\LawnmowerMan');
    expect(resolveWorkdir('~/proj', { homedir: '/home/ada', platform: 'linux' })).toBe('/home/ada/proj');
  });
  it('summarizeToolResult handles strings, blocks and truncation', () => {
    expect(summarizeToolResult('  a\n\n b  ')).toBe('a b');
    expect(summarizeToolResult([{ type: 'text', text: 'hi' }, { type: 'image' }])).toBe('hi [image]');
    expect(summarizeToolResult('x'.repeat(500)).length).toBe(300);
    expect(summarizeToolResult(undefined)).toBe('');
  });
});

describe('ClaudeSession with the fake CLI', () => {
  it('runs a turn: status, session, streamed text, message_end, turn_end — in order', async () => {
    const h = harness();
    await h.session.start();
    const { turnId } = await h.session.send('hello there');
    const end = await h.turnEnd(turnId);
    expect(end).toMatchObject({ type: 'turn_end', turnId, result: 'You said: hello there', isError: false, durationMs: 12, costUsd: 0.0012 });
    expect(end.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.textOf(turnId)).toBe('You said: hello there');

    const seq = h.events.map((e) => (e.type === 'status' ? `status:${e.status}` : e.type));
    const firstText = seq.indexOf('text_delta');
    expect(seq.slice(0, 5)).toEqual(['status:starting', 'status:ready', 'status:busy', 'turn_start', 'session']);
    expect(firstText).toBeGreaterThan(seq.indexOf('turn_start'));
    expect(seq.indexOf('message_end')).toBeGreaterThan(seq.lastIndexOf('text_delta'));
    expect(seq.indexOf('turn_end')).toBeGreaterThan(seq.indexOf('message_end'));
    expect(seq[seq.length - 1]).toBe('status:ready');

    const session = h.events.find((e) => e.type === 'session');
    expect(session).toEqual({ type: 'session', sessionId: end.sessionId, model: 'fake-opus', tools: [] });
    expect(h.persisted).toEqual([end.sessionId]);
    expect(h.session.status()).toMatchObject({ status: 'ready', busy: false, queue: 0, sessionId: end.sessionId, model: 'fake-opus', cliPath: FAKE, mode: 'chat' });

    // Spawned with chat-mode flags, in the (created) working folder, with a cleaned env.
    const [run] = h.argvLog();
    expect(run.argv).toEqual(expect.arrayContaining(['--tools', '', '--system-prompt-file', '--strict-mcp-config']));
    expect(run.argv).not.toContain('--resume');
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(h.settings.workdir));
    expect(run.env).toEqual({
      CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null, CLAUDE_CODE_SESSION_ID: null, CLAUDE_CODE_REMOTE_SESSION_ID: null,
      ELECTRON_RUN_AS_NODE: null, FAKE_MARKER: 'kept',
    });
    const personaFile = run.argv[run.argv.indexOf('--system-prompt-file') + 1];
    const persona = fs.readFileSync(personaFile, 'utf8');
    expect(persona).toMatch(/Lawnmower Man/);
    expect(persona).toMatch(/read aloud/);
  });

  it('queues turns strictly in order, one at a time', async () => {
    const h = harness();
    const ids = [];
    for (const t of ['first', 'second', 'third']) ids.push((await h.session.send(t)).turnId);
    expect(h.session.status().queue).toBeGreaterThanOrEqual(2);
    await h.turnEnd(ids[2]);
    const marks = h.events.filter((e) => e.type === 'turn_start' || e.type === 'turn_end').map((e) => `${e.type}:${ids.indexOf(e.turnId)}`);
    expect(marks).toEqual(['turn_start:0', 'turn_end:0', 'turn_start:1', 'turn_end:1', 'turn_start:2', 'turn_end:2']);
    expect(h.textOf(ids[1])).toBe('You said: second');
    // One process for all three turns; "session" emitted once despite init on every turn.
    expect(h.argvLog()).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'session')).toHaveLength(1);
  });

  it('maps tool_use, permission_request (allow with original input), tool_result', async () => {
    const h = harness({ settings: { mode: 'agent' } });
    const { turnId } = await h.session.send('please use a tool');
    const perm = await h.waitFor((e) => e.type === 'permission_request');
    expect(perm).toMatchObject({ turnId, toolName: 'Bash', input: { command: 'echo hi', description: 'Say hi' }, description: 'Say hi' });
    const toolUse = h.events.find((e) => e.type === 'tool_use');
    expect(toolUse).toMatchObject({ turnId, name: 'Bash', input: { command: 'echo hi' } });
    h.session.respondPermission(perm.requestId, { behavior: 'allow' });
    const end = await h.turnEnd(turnId);
    expect(end.result).toBe('The command ran: echo hi');
    const result = h.events.find((e) => e.type === 'tool_result');
    expect(result).toEqual({ type: 'tool_result', turnId, id: toolUse.id, isError: false, summary: 'ran: echo hi' });
    // Two assistant messages (tool call, then answer) → two message_end events.
    expect(h.events.filter((e) => e.type === 'message_end' && e.turnId === turnId)).toHaveLength(2);
    expect(() => h.session.respondPermission(perm.requestId, { behavior: 'allow' })).toThrow(/Unknown or expired/);
    const [run] = h.argvLog();
    expect(run.argv).toContain('--append-system-prompt-file');
    expect(run.argv).not.toContain('--tools');
  });

  it('passes updatedInput on allow and the message on deny', async () => {
    const h = harness({ settings: { mode: 'agent' } });
    const t1 = (await h.session.send('tool please')).turnId;
    const p1 = await h.waitFor((e) => e.type === 'permission_request' && e.turnId === t1);
    h.session.respondPermission(p1.requestId, { behavior: 'allow', updatedInput: { command: 'echo edited' } });
    expect((await h.turnEnd(t1)).result).toBe('The command ran: echo edited');

    const t2 = (await h.session.send('tool again')).turnId;
    const p2 = await h.waitFor((e) => e.type === 'permission_request' && e.turnId === t2);
    expect(() => h.session.respondPermission(p2.requestId, { behavior: 'maybe' })).toThrow(/allow|deny/);
    h.session.respondPermission(p2.requestId, { behavior: 'deny', message: 'Not now' });
    expect((await h.turnEnd(t2)).result).toBe('Okay, I did not run it.');
    const denied = h.events.filter((e) => e.type === 'tool_result' && e.turnId === t2)[0];
    expect(denied).toMatchObject({ isError: true, summary: 'Not now' });
  });

  it('interrupts a streaming turn and keeps working afterwards', async () => {
    const h = harness();
    const { turnId } = await h.session.send('slow count please');
    await h.waitFor((e) => e.type === 'text_delta' && e.turnId === turnId);
    const t0 = Date.now();
    await h.session.interrupt();
    expect(Date.now() - t0).toBeLessThan(1400);
    const end = h.events.find((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(end).toMatchObject({ isError: true, interrupted: true });
    expect(h.argvLog()).toHaveLength(1); // no restart needed
    const next = (await h.session.send('after interrupt')).turnId;
    expect((await h.turnEnd(next)).result).toBe('You said: after interrupt');
  });

  it('interrupt while a permission card is open denies it and ends the turn', async () => {
    const h = harness({ settings: { mode: 'agent' } });
    const { turnId } = await h.session.send('tool time');
    await h.waitFor((e) => e.type === 'permission_request');
    await h.session.interrupt();
    const end = h.events.find((e) => e.type === 'turn_end' && e.turnId === turnId);
    expect(end).toBeTruthy();
    expect(end.interrupted).toBe(true);
  });

  it('falls back to kill + --resume when the CLI ignores an interrupt', async () => {
    const h = harness({ opts: { interruptTimeoutMs: 300 } });
    const first = (await h.session.send('remember this')).turnId;
    const sid = (await h.turnEnd(first)).sessionId;
    const { turnId } = await h.session.send('hang forever');
    await h.waitFor((e) => e.type === 'text_delta' && e.turnId === turnId);
    await h.session.interrupt();
    expect(h.events.find((e) => e.type === 'turn_end' && e.turnId === turnId)).toMatchObject({ isError: true, interrupted: true });
    const next = (await h.session.send('recall please')).turnId;
    const end = await h.turnEnd(next);
    expect(end.result).toBe('You previously said: hang forever');
    expect(end.sessionId).toBe(sid);
    const runs = h.argvLog();
    expect(runs).toHaveLength(2);
    expect(runs[1].argv.slice(runs[1].argv.indexOf('--resume'), runs[1].argv.indexOf('--resume') + 2)).toEqual(['--resume', sid]);
  });

  it('auto-restarts after a crash with --resume and keeps the conversation', async () => {
    const h = harness();
    const t1 = (await h.session.send('hello A')).turnId;
    const sid = (await h.turnEnd(t1)).sessionId;
    const t2 = (await h.session.send('crash now')).turnId;
    const err = await h.waitFor((e) => e.type === 'error' && e.turnId === t2);
    expect(err.message).toMatch(/exited unexpectedly \(code 3\)/);
    expect(err.message).toMatch(/simulated crash/); // stderr tail surfaced
    expect(await h.turnEnd(t2)).toMatchObject({ isError: true });
    await h.waitFor((e) => e.type === 'status' && e.status === 'restarting');
    const t3 = (await h.session.send('recall it')).turnId;
    const end = await h.turnEnd(t3);
    expect(end.result).toBe('You previously said: crash now');
    expect(end.sessionId).toBe(sid);
    const runs = h.argvLog();
    expect(runs.length).toBe(2);
    expect(runs[1].argv).toContain('--resume');
    expect(runs[1].argv).toContain(sid);
  });

  it('resumes the persisted session on start and starts fresh when it is gone', async () => {
    // 1) A real previous session is resumed.
    const a = harness();
    const t = (await a.session.send('my name is Ada')).turnId;
    const sid = (await a.turnEnd(t)).sessionId;
    await a.session.stop();
    const b = harness({ settings: { lastSessionId: sid }, env: { FAKE_CLAUDE_STATE_DIR: path.join(a.dir, 'state') } });
    const t2 = (await b.session.send('recall my name')).turnId;
    expect((await b.turnEnd(t2)).result).toBe('You previously said: my name is Ada');
    expect(b.argvLog()[0].argv).toContain(sid);

    // 2) resumeLastSession=false ignores it.
    const c = harness({ settings: { lastSessionId: sid, resumeLastSession: false } });
    await c.session.start();
    expect(c.argvLog()[0].argv).not.toContain('--resume');

    // 3) A missing session falls back to a fresh conversation.
    const d = harness({ settings: { lastSessionId: 'missing-1234' } });
    const start = d.session.start().catch(() => {});
    const err = await d.waitFor((e) => e.type === 'error' && !e.turnId);
    expect(err.message).toMatch(/could not be found/);
    await start;
    const t4 = (await d.session.send('fresh start')).turnId;
    const end = await d.turnEnd(t4);
    expect(end.isError).toBe(false);
    expect(d.persisted[0]).toBe('');
    expect(d.persisted[1]).toBe(end.sessionId);
    const runs = d.argvLog();
    expect(runs[0].argv).toContain('missing-1234');
    expect(runs[runs.length - 1].argv).not.toContain('--resume');
  });

  it('reset() starts a new conversation and drops queued turns', async () => {
    const h = harness();
    const t1 = (await h.session.send('one')).turnId;
    const sid1 = (await h.turnEnd(t1)).sessionId;
    const slow = (await h.session.send('slow one')).turnId;
    const queued = (await h.session.send('queued')).turnId;
    await h.waitFor((e) => e.type === 'text_delta' && e.turnId === slow);
    const mark = h.events.length;
    await h.session.reset();
    expect(h.events.slice(mark).find((e) => e.type === 'session')).toEqual({ type: 'session', sessionId: '', model: '', tools: [] });
    expect(h.events.find((e) => e.type === 'turn_end' && e.turnId === slow)).toMatchObject({ isError: true });
    expect(h.events.find((e) => e.type === 'error' && e.turnId === queued).message).toMatch(/reset/);
    expect(h.persisted).toContain('');
    const t2 = (await h.session.send('recall anything')).turnId;
    const end = await h.turnEnd(t2);
    expect(end.result).toBe('You have not said anything before.');
    expect(end.sessionId).not.toBe(sid1);
    expect(h.argvLog().pop().argv).not.toContain('--resume');
  });

  it('gives up after repeated startup failures and reports queued turns', async () => {
    const h = harness({ env: { FAKE_CLAUDE_EXIT_AT_START: '7' } });
    const { turnId } = await h.session.send('anyone there?');
    const err = await h.waitFor((e) => e.type === 'error' && e.turnId === turnId, { timeout: 10000 });
    expect(err.message).toMatch(/Gave up after 3 restart attempts/);
    expect(err.message).toMatch(/simulated startup failure/);
    expect(h.session.status().status).toBe('error');
    expect(h.argvLog()).toHaveLength(4);
  });

  it('applies settings changes after the active turn by restarting with --resume', async () => {
    const h = harness();
    const t1 = (await h.session.send('slow but steady')).turnId;
    await h.waitFor((e) => e.type === 'text_delta' && e.turnId === t1);
    h.settings.mode = 'assistant';
    h.settings.model = 'sonnet';
    h.session.applySettings();
    const end1 = await h.turnEnd(t1);
    expect(end1.isError).toBe(false); // not interrupted by the settings change
    const t2 = (await h.session.send('args please')).turnId;
    const end2 = await h.turnEnd(t2);
    const { argv } = JSON.parse(end2.result);
    expect(argv).toEqual(expect.arrayContaining(['--model', 'sonnet', '--allowedTools', ASSISTANT_TOOLS, '--resume', end1.sessionId]));
    expect(h.argvLog()).toHaveLength(2);
    // A change that does not affect the process does nothing.
    h.settings.resumeLastSession = false;
    h.session.applySettings();
    expect(h.argvLog()).toHaveLength(2);
  });

  it('handles thinking, non-streamed, sub-agent, error and huge outputs', async () => {
    const h = harness({ env: { FAKE_CLAUDE_CHUNKY: '1', FAKE_CLAUDE_CRLF: '1', FAKE_CLAUDE_BOM: '1' } });
    const think = (await h.session.send('think hard')).turnId;
    await h.turnEnd(think);
    expect(h.events.filter((e) => e.type === 'thinking' && e.turnId === think)).toHaveLength(1);
    expect(h.textOf(think)).toBe('Thought about it.');

    const nostream = (await h.session.send('nostream please')).turnId;
    await h.turnEnd(nostream);
    expect(h.textOf(nostream)).toBe('Synthetic reply without streaming.');
    expect(h.events.filter((e) => e.type === 'message_end' && e.turnId === nostream)).toHaveLength(1);

    const sub = (await h.session.send('subagent work')).turnId;
    await h.turnEnd(sub);
    expect(h.textOf(sub)).toBe('Main agent reply.');

    const bad = (await h.session.send('cause an error')).turnId;
    const end = await h.turnEnd(bad);
    expect(end.isError).toBe(true);
    expect(end.result).toBe('simulated error'); // diagnostics filtered out

    const huge = (await h.session.send('huge reply')).turnId;
    const hugeEnd = await h.turnEnd(huge, { timeout: 15000 });
    expect(hugeEnd.result).toBe(`huge:${1024 * 1024}`);
    expect(h.textOf(huge).length).toBe(1024 * 1024);
    expect(h.logs.filter((l) => /invalid JSON/.test(l))).toEqual([]);
  });

  it('validates send() input and reports a missing CLI', async () => {
    const h = harness();
    await expect(h.session.send('   ')).rejects.toThrow(/empty/);
    await expect(h.session.send(42)).rejects.toThrow(/string/);
    await expect(h.session.send('x'.repeat(100_001))).rejects.toThrow(/too long/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-nocli-'));
    const s = new ClaudeSession({
      getSettings: () => ({ mode: 'chat', workdir: dir }),
      personaDir: dir,
      resolveCli: async () => ({ path: null, source: null, error: 'Claude CLI not found. Install it.', tried: [] }),
    });
    const evs = [];
    s.on('event', (e) => evs.push(e));
    await expect(s.send('hi')).rejects.toThrow(/not found/);
    expect(evs.at(-1)).toEqual({ type: 'status', status: 'error', detail: 'Claude CLI not found. Install it.' });
    expect(s.status().status).toBe('error');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('waits for initialize but proceeds if the CLI never answers it', async () => {
    const h = harness({ env: { FAKE_CLAUDE_NO_INIT: '1' }, opts: { initTimeoutMs: 300 } });
    const { turnId } = await h.session.send('hello?');
    expect((await h.turnEnd(turnId)).result).toBe('You said: hello?');
    expect(h.logs.some((l) => /initialize timed out/.test(l))).toBe(true);
  });

  it('stop() ends the process and reports exited', async () => {
    const h = harness();
    await h.session.start();
    await h.session.stop();
    expect(h.session.status().status).toBe('exited');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'exited', detail: 'Stopped' });
  });
});
