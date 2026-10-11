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
//   "camera <tool> <json>" → calls an app MCP tool, e.g. `camera camera_snapshot {}` (see below)
//   otherwise → "You said: <text>" in a few chunks
//
// App MCP servers (contract §10.5), like Claude Code 2.1.x with the Agent SDK control protocol:
//   initialize.sdkMcpServers → for each server, over control_request mcp_message: initialize
//   (protocolVersion 2025-06-18), notifications/initialized, tools/list; then the initialize
//   answer. `--mcp-config <file>` servers of type http get the same handshake as JSON-RPC POSTs
//   (${VAR} in url/headers expanded from the environment, as the CLI does). Their tools appear
//   in system/init as mcp__<server>__<tool> (minus --disallowedTools) with mcp_servers statuses.
//   `camera <tool> <json>`: tool_use, a can_use_tool prompt unless --allowedTools lists it, then
//   tools/call; the reply summarizes the result ("Tool camera_snapshot returned 1 image
//   (image/jpeg 640x360, 41234 bytes) and text: …", images checked like image blocks), "Tool
//   denied." on deny, "Tool unavailable." when the tool is not offered.
// Image content blocks after the text (webcam snapshots) are checked like the API does (base64
// source, JPEG/PNG/WebP whose bytes match the media type) and acknowledged in the reply:
// "You said: <text> [saw 1 image: image/jpeg 640x480, 41234 bytes]"; a malformed one gives an
// error result "invalid image" instead.
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
//   FAKE_CLAUDE_MCP_LOG=<file>    append one JSON line per initialize request and per MCP exchange
//   FAKE_CLAUDE_IGNORE_SDK_MCP=1  a CLI that ignores initialize.sdkMcpServers (no handshake, no tools)
//   FAKE_CLAUDE_HIDE_MCP_TOOLS=1  connects the app's servers but leaves their tools out of system/init
//   --resume <id starting with "missing">  → "No conversation found" + exit 1 (like the real CLI)

import fs from 'node:fs';
import http from 'node:http';
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
/** @param {string} name */
const listFlag = (name) => (flag(name) || '').split(/[,\s]+/).filter(Boolean);
const allowedTools = new Set(listFlag('--allowedTools'));
const disallowedTools = new Set(listFlag('--disallowedTools'));
const mcpConfigFile = flag('--mcp-config');

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

// ---- app MCP servers (in-process over the control channel, or HTTP from --mcp-config) ----
/** @type {Map<string, { via: 'sdk'|'http', url?: string, headers?: Record<string, string>, tools: string[], status: string }>} */
const mcpServers = new Map();
/** Answers to our mcp_message control requests. @type {Map<string, (r: any) => void>} */
const pendingMcp = new Map();
let mcpSeq = 0;

/** @param {object} entry */
function mcpLog(entry) {
  if (process.env.FAKE_CLAUDE_MCP_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_MCP_LOG, `${JSON.stringify(entry)}\n`);
}

/** `${VAR}` from the environment, as the CLI expands it in --mcp-config url/headers. @param {string} s */
const expandEnv = (s) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) => process.env[k] ?? '');

/** @type {Map<string, { url: string, headers: Record<string, string> }>} */
const configServers = new Map();
if (mcpConfigFile) {
  const cfg = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8'));
  for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
    if (/** @type {any} */ (s).type !== 'http') continue;
    configServers.set(name, {
      url: expandEnv(/** @type {any} */ (s).url),
      headers: Object.fromEntries(Object.entries(/** @type {any} */ (s).headers || {}).map(([k, v]) => [k, expandEnv(/** @type {string} */ (v))])),
    });
  }
}

/** One JSON-RPC message to an app server; resolves its JSON-RPC answer (null for 202). @param {string} server @param {Record<string, any>} message */
function mcpCall(server, message) {
  const s = mcpServers.get(server);
  if (!s) return Promise.reject(new Error(`no MCP server ${server}`));
  if (s.via === 'sdk') {
    const requestId = randomUUID();
    const answer = new Promise((resolve) => pendingMcp.set(requestId, resolve));
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: server, message } });
    return answer.then((r) => {
      mcpLog({ kind: 'mcp', via: 'sdk', server, message, response: r });
      if (!r || r.subtype !== 'success') throw new Error(`control error: ${r && r.error}`);
      return r.response ? r.response.mcp_response : null;
    });
  }
  return new Promise((resolve, reject) => {
    const u = new URL(/** @type {string} */ (s.url));
    const body = JSON.stringify(message);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { ...s.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        mcpLog({ kind: 'mcp', via: 'http', server, message, status: res.statusCode, response: text ? JSON.parse(text) : null });
        if (res.statusCode === 202) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(JSON.parse(text));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** initialize → notifications/initialized → tools/list. @param {string} server @returns {Promise<string[]>} */
async function mcpHandshake(server) {
  const init = await mcpCall(server, { jsonrpc: '2.0', id: ++mcpSeq, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '9.9.9' } } });
  if (!init || !init.result || typeof init.result.protocolVersion !== 'string') throw new Error(`bad initialize answer ${JSON.stringify(init)}`);
  await mcpCall(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await mcpCall(server, { jsonrpc: '2.0', id: ++mcpSeq, method: 'tools/list' });
  return ((list && list.result && list.result.tools) || []).map((/** @type {any} */ t) => String(t.name));
}

/** @param {Record<string, any>} request the initialize control request */
async function connectMcp(request) {
  mcpLog({ kind: 'initialize', request });
  const sdk = Array.isArray(request.sdkMcpServers) && !process.env.FAKE_CLAUDE_IGNORE_SDK_MCP ? request.sdkMcpServers : [];
  for (const name of sdk) mcpServers.set(String(name), { via: 'sdk', tools: [], status: 'pending' });
  for (const [name, c] of configServers) mcpServers.set(name, { via: 'http', ...c, tools: [], status: 'pending' });
  for (const [name, s] of mcpServers) {
    try {
      s.tools = await mcpHandshake(name);
      s.status = 'connected';
    } catch (err) {
      s.status = 'failed';
      process.stderr.write(`fake-claude: MCP server ${name} failed: ${err && err.message}\n`);
    }
  }
}

/** mcp__<server>__<tool> of every connected server, minus --disallowedTools. */
function mcpToolNames() {
  if (process.env.FAKE_CLAUDE_HIDE_MCP_TOOLS) return [];
  const out = [];
  for (const [name, s] of mcpServers) for (const t of s.tools) out.push(`mcp__${name}__${t}`);
  return out.filter((t) => !disallowedTools.has(t));
}

/**
 * Summarize a tools/call result like the model would see it (images checked like image blocks).
 * @param {string} tool @param {any} answer
 */
function describeToolResult(tool, answer) {
  if (!answer || answer.error) return `MCP error: ${answer && answer.error ? answer.error.message : 'no answer'}`;
  const r = answer.result || {};
  const content = Array.isArray(r.content) ? r.content : [];
  const texts = content.filter((b) => b && b.type === 'text').map((b) => String(b.text));
  if (r.isError) return `Tool ${tool} failed: ${texts.join(' ')}`;
  const images = [];
  for (const b of content.filter((x) => x && x.type === 'image')) {
    if (typeof b.data !== 'string' || !b.data || /^data:/.test(b.data) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.data)) return `Tool ${tool} returned an invalid image (not plain base64)`;
    const bytes = Buffer.from(b.data, 'base64');
    if (b.mimeType !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return `Tool ${tool} returned an invalid image (${b.mimeType})`;
    const size = jpegSize(bytes);
    images.push(`${b.mimeType}${size ? ` ${size}` : ''}, ${bytes.length} bytes`);
  }
  const parts = [];
  if (images.length) parts.push(`${images.length} image${images.length > 1 ? 's' : ''} (${images.join('; ')})`);
  if (texts.length) parts.push(`text: ${texts.join(' ')}`);
  return `Tool ${tool} returned ${parts.join(' and ') || 'nothing'}`;
}

/** `camera <tool> <json>`: one app tool call, with the permission flow of the real CLI. @param {string} tool @param {Record<string, any>} input */
async function cameraTurn(tool, input) {
  const server = 'lawnmower-camera';
  const full = `mcp__${server}__${tool}`;
  if (!mcpToolNames().includes(full)) {
    await streamText('Tool unavailable.');
    await result('Tool unavailable.');
    return;
  }
  const id = msgId();
  const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
  await se({ type: 'message_start', message: { id, content: [] } });
  await out({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'tool_use', id: toolUseId, name: full, input }] }, ...base() });
  await se({ type: 'message_stop' });
  let args = input;
  if (!allowedTools.has(full)) {
    const requestId = randomUUID();
    const decision = new Promise((resolve) => pendingPermissions.set(requestId, resolve));
    await out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: full, display_name: tool, input, permission_suggestions: [], tool_use_id: toolUseId } });
    const resp = await decision;
    if (current.interrupted) { await interruptedResult(); return; }
    if (!resp || resp.behavior !== 'allow') {
      await out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: (resp && resp.message) || 'denied', is_error: true }] }, ...base() });
      await streamText('Tool denied.');
      await result('Tool denied.');
      return;
    }
    if (resp.updatedInput && typeof resp.updatedInput === 'object') args = resp.updatedInput;
  }
  let answer;
  try {
    answer = await mcpCall(server, { jsonrpc: '2.0', id: ++mcpSeq, method: 'tools/call', params: { name: tool, arguments: args } });
  } catch (err) {
    answer = { error: { message: err && err.message } };
  }
  const summary = describeToolResult(tool, answer);
  const content = answer && answer.result && Array.isArray(answer.result.content) ? answer.result.content.map((b) => (b.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } } : b)) : summary;
  await out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: !!(answer && (answer.error || (answer.result && answer.result.isError))) }] }, ...base() });
  await streamText(summary);
  await result(summary);
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

/**
 * Check image blocks like the Messages API would and describe them for the reply.
 * @param {any[]} blocks @returns {{ ok: true, note: string }|{ ok: false, error: string }}
 */
function describeImages(blocks) {
  const seen = [];
  for (const b of blocks) {
    const src = b && b.source;
    if (!src || src.type !== 'base64' || typeof src.data !== 'string' || !src.data) return { ok: false, error: 'invalid image: expected a base64 source' };
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(src.media_type)) return { ok: false, error: `invalid image: unsupported media_type ${src.media_type}` };
    if (/^data:/.test(src.data)) return { ok: false, error: 'invalid image: data must not carry a data: prefix' };
    const bytes = Buffer.from(src.data, 'base64');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
    if ((src.media_type === 'image/jpeg' && !jpeg) || (src.media_type === 'image/png' && !png) || (src.media_type === 'image/webp' && !webp)) {
      return { ok: false, error: `invalid image: the data is not ${src.media_type}` };
    }
    const size = jpeg ? jpegSize(bytes) : png ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}` : '';
    seen.push(`${src.media_type}${size ? ` ${size}` : ''}, ${bytes.length} bytes`);
  }
  return { ok: true, note: seen.length ? ` [saw ${seen.length} image${seen.length > 1 ? 's' : ''}: ${seen.join('; ')}]` : '' };
}

/** Width x height from a JPEG's SOF marker ('' when not found). @param {Buffer} b */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return '';
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
    i += 2 + len;
  }
  return '';
}

async function runTurn(text, images = []) {
  current = { interrupted: false, hang: false };
  const prev = history.length ? history[history.length - 1] : null;
  history.push(text);
  saveHistory();

  await out({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: [...tools, ...mcpToolNames()],
    mcp_servers: [...mcpServers].map(([name, s]) => ({ name, status: s.status })), model,
    permissionMode: flag('--permission-mode') || 'default', claude_code_version: '9.9.9', uuid: randomUUID(),
  });
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

  const cam = /^camera\s+([a-z][a-z0-9_]*)\s*(\{[\s\S]*\})?\s*$/.exec(text.trim());
  if (cam) {
    /** @type {Record<string, any>} */
    let input = {};
    try {
      input = cam[2] ? JSON.parse(cam[2]) : {};
    } catch {
      input = {};
    }
    await cameraTurn(cam[1], input);
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

  const seen = describeImages(images);
  if (!seen.ok) {
    await streamText(`API Error: 400 ${seen.error}`);
    await result(`API Error: 400 ${seen.error}`, { isError: true, subtype: 'error_during_execution' });
    return;
  }
  let reply;
  if (lower.includes('args')) reply = JSON.stringify({ argv, cwd: process.cwd() });
  else if (lower.includes('recall')) reply = prev ? `You previously said: ${prev}` : 'You have not said anything before.';
  else reply = `You said: ${text}${seen.note}`;
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
      await runTurn(next.text, next.images);
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
      // the app's MCP servers connect before the CLI reports itself ready
      connectMcp(msg.request).finally(() => {
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], models: [], pid: process.pid, claude_code_version: '9.9.9' } } });
      });
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
    const mcp = pendingMcp.get(r.request_id);
    if (mcp) {
      pendingMcp.delete(r.request_id);
      mcp(r);
    }
    return;
  }
  if (msg.type === 'user') {
    const content = msg.message && msg.message.content;
    const text = Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(content || '');
    const images = Array.isArray(content) ? content.filter((b) => b && b.type === 'image') : [];
    queue.push({ text, images });
    drain();
  }
}
