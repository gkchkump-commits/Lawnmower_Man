#!/usr/bin/env node
// Fake Claude CLI for tests. Emulates the `claude -p` stream-json protocol as observed live
// with Claude Code 2.1.x (see docs/ARCHITECTURE.md §3.2):
//
//  stdin : control_request initialize | user messages | control_request interrupt |
//          control_response (answers to our can_use_tool prompts)
//  stdout: active_goal/autocompact_state (ignorable), control_response, system/init (every
//          turn), system/status, stream_event (message_start, content_block_start/delta/stop,
//          message_delta, message_stop), assistant, user (tool_result), rate_limit_event,
//          unknown future types, control_request can_use_tool, result.
//
// Behaviour is selected by keywords in the user's prompt:
//   "crash"   → stream one delta, print to stderr, exit(3)
//   "tool"    → tool_use + can_use_tool permission prompt; honours allow (updatedInput) / deny
//   "slow"    → 40 deltas, 50 ms apart (interruptible)
//   "hang"    → one delta, then ignores everything including interrupts
//   "think"   → a thinking block before the text
//   "error"   → result with subtype error_during_execution
//   "huge"    → a single ~1 MB text delta
//   "args"    → replies with JSON of argv (for --resume / flag checks)
//   "recall"  → replies with the previous user prompt of this session (memory check)
//   "nostream"→ assistant message without any stream_event (fallback path)
//   "subagent"→ includes a sub-agent stream (parent_tool_use_id set) that must be ignored
//   "notloggedin" → answers like a CLI without a login (see FAKE_CLAUDE_AUTH_FILE)
//   otherwise → "You said: <text>" in a few chunks
//
// Env:
//   FAKE_CLAUDE_STATE_DIR  persist per-session history (so --resume really resumes)
//   FAKE_CLAUDE_LOG        append one JSON line per process start: { argv, cwd, env }
//   FAKE_CLAUDE_CHUNKY=1   split output lines across writes (partial-chunk handling)
//   FAKE_CLAUDE_CRLF=1     CRLF line endings
//   FAKE_CLAUDE_BOM=1      UTF-8 BOM before the first line
//   FAKE_CLAUDE_NO_INIT=1  never answer the initialize request
//   FAKE_CLAUDE_EXIT_AT_START=<code>  exit immediately with that code (startup failure), printing
//                     FAKE_CLAUDE_START_MESSAGE (default "fake-claude: simulated startup failure")
//   FAKE_CLAUDE_IGNORE_SIGTERM=1  ignore SIGTERM (POSIX), so killing it takes the full grace period
//   FAKE_CLAUDE_AUTH_FILE=<path>  "not logged in" until that file exists (checked per turn): a
//                     synthetic assistant message with error "authentication_failed" and an
//                     error result "Not logged in · Please run /login", like the real CLI
//   --resume <id starting with "missing">  → "No conversation found" + exit 1 (like the real CLI)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}

/** @param {string} name */
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.env.FAKE_CLAUDE_LOG) {
  const envSubset = {};
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'ELECTRON_RUN_AS_NODE', 'FAKE_MARKER']) envSubset[k] = process.env[k] ?? null;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), env: envSubset, pid: process.pid })}\n`);
}

if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM) process.on('SIGTERM', () => {});

if (process.env.FAKE_CLAUDE_EXIT_AT_START) {
  process.stderr.write(`${process.env.FAKE_CLAUDE_START_MESSAGE || 'fake-claude: simulated startup failure'}\n`);
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT_AT_START) || 1);
}

// Validate the flags the app must always pass (catches arg-building regressions).
const required = [['--input-format', 'stream-json'], ['--output-format', 'stream-json']];
for (const [f, v] of required) {
  if (flag(f) !== v) {
    process.stderr.write(`fake-claude: expected ${f} ${v}\n`);
    process.exit(2);
  }
}
for (const f of ['-p', '--verbose', '--include-partial-messages']) {
  if (!argv.includes(f)) {
    process.stderr.write(`fake-claude: missing ${f}\n`);
    process.exit(2);
  }
}
for (const f of ['--system-prompt-file', '--append-system-prompt-file']) {
  const file = flag(f);
  if (file !== undefined && !fs.existsSync(file)) {
    process.stderr.write(`fake-claude: ${f} not found: ${file}\n`);
    process.exit(1);
  }
}

const NL = process.env.FAKE_CLAUDE_CRLF ? '\r\n' : '\n';
const chunky = !!process.env.FAKE_CLAUDE_CHUNKY;
const stateDir = process.env.FAKE_CLAUDE_STATE_DIR;
const model = flag('--model') || 'fake-opus';
const toolsArg = flag('--tools');
const tools = toolsArg === undefined ? ['Bash', 'Read', 'Write'] : toolsArg === '' ? [] : toolsArg.split(',');

const resumeId = flag('--resume');
let sessionId = resumeId || randomUUID();
/** @type {string[]} */
let history = [];

if (resumeId) {
  const file = stateDir ? path.join(stateDir, `${resumeId}.json`) : null;
  const missing = resumeId.startsWith('missing') || (file && !fs.existsSync(file));
  if (missing) {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resumeId, errors: [`No conversation found with session ID: ${resumeId}`] })}\n`);
    process.exit(1);
  }
  if (file) history = JSON.parse(fs.readFileSync(file, 'utf8')).history || [];
}

function saveHistory() {
  if (!stateDir) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${sessionId}.json`), JSON.stringify({ history }));
}

// ---- output (strictly ordered, optionally split into partial chunks) ----
let outChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {object} obj */
function out(obj) {
  const line = JSON.stringify(obj) + NL;
  outChain = outChain.then(async () => {
    if (chunky && line.length > 8) {
      const cut = Math.max(1, Math.floor(line.length / 3));
      process.stdout.write(line.slice(0, cut));
      await sleep(2);
      process.stdout.write(line.slice(cut));
    } else {
      process.stdout.write(line);
    }
  });
  return outChain;
}
/** @param {string} raw */
function outRaw(raw) {
  outChain = outChain.then(() => { process.stdout.write(raw); });
  return outChain;
}

if (process.env.FAKE_CLAUDE_BOM) outRaw('﻿');
out({ type: 'active_goal', value: null, uuid: randomUUID(), session_id: sessionId });
out({ type: 'autocompact_state', value: { enabled: true }, uuid: randomUUID(), session_id: sessionId });

const base = () => ({ session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() });
const se = (event, extra = {}) => out({ type: 'stream_event', event, ...base(), ...extra });

// ---- state ----
/** @type {{ text: string, resolve: () => void }[]} */
const queue = [];
let busy = false;
let current = null; // { interrupted: boolean, hang: boolean }
/** @type {Map<string, (resp: any) => void>} */
const pendingPermissions = new Map();

function msgId() {
  return `msg_fake_${randomUUID().slice(0, 8)}`;
}

/** Stream a text message: message_start … message_stop + assistant. Returns false if interrupted. */
async function streamText(text, { pieces = 3, delayMs = 5, parent = null } = {}) {
  const id = msgId();
  const extra = parent ? { parent_tool_use_id: parent } : {};
  await se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } }, extra);
  await se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, extra);
  const size = Math.max(1, Math.ceil(text.length / pieces));
  for (let i = 0; i < text.length; i += size) {
    if (current?.interrupted && !parent) return false;
    await se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }, extra);
    if (delayMs) await sleep(delayMs);
  }
  await out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] }, ...base(), ...extra });
  await se({ type: 'content_block_stop', index: 0 }, extra);
  await se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, extra);
  await se({ type: 'message_stop' }, extra);
  return true;
}

async function result(text, { isError = false, subtype = 'success' } = {}) {
  const r = { type: 'result', subtype, is_error: isError, duration_ms: 12, duration_api_ms: 10, num_turns: 1, session_id: sessionId, total_cost_usd: 0.0012, usage: {}, uuid: randomUUID() };
  if (text !== undefined) r.result = text;
  if (subtype !== 'success') r.errors = ['[ede_diagnostic] result_type=user', 'simulated error'];
  await out(r);
}

async function interruptedResult() {
  await out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, ...base() });
  await out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 5, session_id: sessionId, total_cost_usd: 0, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'], uuid: randomUUID() });
}

async function runTurn(text) {
  current = { interrupted: false, hang: false };
  const prev = history.length ? history[history.length - 1] : null;
  history.push(text);
  saveHistory();

  await out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools, mcp_servers: [], model, permissionMode: flag('--permission-mode') || 'default', claude_code_version: '9.9.9', uuid: randomUUID() });
  await out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId });
  await out({ type: 'weird_future_event', payload: { anything: true } });

  const lower = text.toLowerCase();

  const authFile = process.env.FAKE_CLAUDE_AUTH_FILE;
  if (lower.includes('notloggedin') || (authFile && !fs.existsSync(authFile))) {
    const t = 'Not logged in · Please run /login';
    await out({ type: 'assistant', message: { id: msgId(), type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: t }] }, error: 'authentication_failed', ...base() });
    await out({ type: 'result', subtype: 'success', is_error: true, duration_ms: 3, num_turns: 1, result: t, session_id: sessionId, total_cost_usd: 0, uuid: randomUUID() });
    return;
  }

  if (lower.includes('crash')) {
    const id = msgId();
    await se({ type: 'message_start', message: { id, content: [] } });
    await se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'About to' } });
    await outChain;
    process.stderr.write('fatal: simulated crash\n');
    process.exit(3);
  }

  if (lower.includes('hang')) {
    current.hang = true;
    const id = msgId();
    await se({ type: 'message_start', message: { id, content: [] } });
    await se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will never finish' } });
    await new Promise(() => {}); // never resolves; interrupts are ignored
  }

  if (lower.includes('error')) {
    await streamText('Something went wrong.');
    await result(undefined, { isError: true, subtype: 'error_during_execution' });
    return;
  }

  if (lower.includes('think')) {
    const id = msgId();
    await se({ type: 'message_start', message: { id, content: [] } });
    await se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    for (let i = 0; i < 3; i++) await se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } });
    await se({ type: 'content_block_stop', index: 0 });
    await se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    await se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Thought about it.' } });
    await out({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'thinking', thinking: 'hmm hmm hmm' }, { type: 'text', text: 'Thought about it.' }] }, ...base() });
    await se({ type: 'content_block_stop', index: 1 });
    await se({ type: 'message_stop' });
    await result('Thought about it.');
    return;
  }

  if (lower.includes('tool')) {
    const id = msgId();
    const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    const input = { command: 'echo hi', description: 'Say hi' };
    await se({ type: 'message_start', message: { id, content: [] } });
    await se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} } });
    await se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(0, 10) } });
    await se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(10) } });
    await out({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }] }, ...base() });
    await se({ type: 'content_block_stop', index: 0 });
    await se({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    await se({ type: 'message_stop' });

    const requestId = randomUUID();
    const decision = new Promise((resolve) => pendingPermissions.set(requestId, resolve));
    await out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: 'Say hi', permission_suggestions: [], tool_use_id: toolUseId } });
    const resp = await decision;
    if (current.interrupted) { await interruptedResult(); return; }
    if (resp && resp.behavior === 'allow') {
      const cmd = resp.updatedInput && typeof resp.updatedInput.command === 'string' ? resp.updatedInput.command : '?';
      await out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: `ran: ${cmd}`, is_error: false }] }, ...base() });
      await streamText(`The command ran: ${cmd}`);
      await result(`The command ran: ${cmd}`);
    } else {
      const why = resp && resp.message ? resp.message : 'denied';
      await out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: why, is_error: true }] }, ...base() });
      await streamText('Okay, I did not run it.');
      await result('Okay, I did not run it.');
    }
    return;
  }

  if (lower.includes('slow')) {
    const id = msgId();
    await se({ type: 'message_start', message: { id, content: [] } });
    for (let i = 0; i < 40; i++) {
      if (current.interrupted) { await interruptedResult(); return; }
      await se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i} ` } });
      await sleep(50);
    }
    await se({ type: 'message_stop' });
    await result('done counting');
    return;
  }

  if (lower.includes('huge')) {
    const big = 'x'.repeat(1024 * 1024);
    await streamText(big, { pieces: 1, delayMs: 0 });
    await result(`huge:${big.length}`);
    return;
  }

  if (lower.includes('nostream')) {
    const t = 'Synthetic reply without streaming.';
    await out({ type: 'assistant', message: { id: msgId(), role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: t }] }, ...base() });
    await result(t);
    return;
  }

  if (lower.includes('subagent')) {
    await streamText('SUBAGENT TEXT SHOULD BE IGNORED', { parent: 'toolu_parent_1' });
    await streamText('Main agent reply.');
    await result('Main agent reply.');
    return;
  }

  let reply;
  if (lower.includes('args')) reply = JSON.stringify({ argv, cwd: process.cwd() });
  else if (lower.includes('recall')) reply = prev ? `You previously said: ${prev}` : 'You have not said anything before.';
  else reply = `You said: ${text}`;
  const finished = await streamText(reply);
  if (!finished) { await interruptedResult(); return; }
  await out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, ...base() });
  await result(reply);
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const next = queue.shift();
    try {
      await runTurn(next.text);
    } catch (err) {
      process.stderr.write(`fake-claude internal error: ${err && err.stack}\n`);
    }
    current = null;
  }
  busy = false;
}

// ---- input ----
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuf += chunk;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`fake-claude: bad input line: ${line.slice(0, 100)}\n`);
      continue;
    }
    handleInput(msg);
  }
});
process.stdin.on('end', async () => {
  await outChain;
  process.exit(0);
});

function handleInput(msg) {
  if (msg.type === 'control_request') {
    const sub = msg.request && msg.request.subtype;
    if (sub === 'initialize') {
      if (process.env.FAKE_CLAUDE_NO_INIT) return;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], models: [], pid: process.pid } } });
    } else if (sub === 'interrupt') {
      if (current && current.hang) return; // simulate a CLI that ignores interrupts
      if (current) current.interrupted = true;
      for (const [id, resolve] of pendingPermissions) {
        pendingPermissions.delete(id);
        resolve({ behavior: 'deny', message: 'interrupted' });
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unknown subtype ${sub}` } });
    }
    return;
  }
  if (msg.type === 'control_response') {
    const r = msg.response || {};
    const resolve = pendingPermissions.get(r.request_id);
    if (resolve) {
      pendingPermissions.delete(r.request_id);
      resolve(r.response);
    }
    return;
  }
  if (msg.type === 'user') {
    const content = msg.message && msg.message.content;
    const text = Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(content || '');
    queue.push({ text });
    drain();
  }
}
