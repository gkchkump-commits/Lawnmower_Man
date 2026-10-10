// ClaudeSession: one persistent `claude -p` process in stream-json mode = one conversation.
//
// Implements contract §3.1 (ClaudeEvent) and §3.2 (CLI protocol):
//  * spawn once (cwd = working folder, created on demand) and send the `initialize` control
//    request; the process is "ready" once it answers,
//  * strictly ordered turn queue: one active turn at a time, the next one is written to stdin
//    only after the previous `result` (turn_end),
//  * stdout → ClaudeEvents (text_delta, thinking, tool_use, tool_result, permission_request,
//    message_end, turn_end, session, status, error); unknown message types are ignored,
//  * permission prompts (`control_request` can_use_tool) are answered via respondPermission(),
//  * interrupt() sends an `interrupt` control request; if the turn has not ended within
//    `interruptTimeoutMs` the CLI is killed and restarted with --resume,
//  * unexpected exits restart the CLI with exponential backoff and --resume <sessionId>;
//    a failed resume (e.g. "No conversation found") falls back to a fresh conversation,
//  * the session id is persisted through `onSessionId` so the next launch can resume it.
//
// Events: 'event' (ClaudeEvent). Pure Node (no Electron import) so it is tested end-to-end
// against tests/fixtures/fake-claude.mjs.

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { JsonLineParser, encodeJsonLine } from './stream-json.js';
import {
  spawnPortable,
  cleanChildEnv,
  killProcessTree,
  waitForExit,
  TextRingBuffer,
  backoffDelay,
} from './spawn-util.js';
import { resolveClaudeCli, expandUserPath } from './claude-path.js';
import { buildPersona, personaFileName } from './persona.js';

/** Tools enabled in assistant mode: read-only file access + web. */
export const ASSISTANT_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';
/**
 * Tools pre-approved in assistant mode. A bare tool name allows every input, so Read/Glob/Grep
 * are deliberately NOT listed: the CLI then allows reads inside the working folder by itself and
 * asks (an approval card) for anything outside it. WebFetch always asks, because a fetch URL can
 * carry data out (prompt injection); only WebSearch runs without a card.
 */
export const ASSISTANT_ALLOWED_TOOLS = 'WebSearch';
/** Longest single user turn we accept (characters). */
export const MAX_TURN_CHARS = 100_000;
/** Images a user turn may carry (webcam snapshots, docs/CAMERA.md). */
export const MAX_TURN_IMAGES = 2;
/** Largest image we pass on, in characters of base64 (~1.1 MB of image data). */
export const MAX_IMAGE_BASE64 = 1.5 * 1024 * 1024;
/** Image types the Claude API accepts in an image content block (and that we pass on). */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/**
 * @typedef {{ mediaType: 'image/jpeg'|'image/png'|'image/webp', data: string }} TurnImage
 *   data: base64 without a data: prefix (electron/ipc-validate.js checks it fully)
 */

/**
 * The content blocks of a user turn: the text first, then one base64 image block per image
 * (the stream-json format the CLI accepts: `{"type":"image","source":{"type":"base64",…}}`).
 * @param {string} text @param {TurnImage[]} [images]
 */
export function userMessageContent(text, images = []) {
  /** @type {Array<Record<string, any>>} */
  const content = [{ type: 'text', text }];
  for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  return content;
}

/**
 * Light shape check of send() options (main validates IPC input fully in ipc-validate.js).
 * @param {unknown} o @returns {TurnImage[]}
 */
function turnImages(o) {
  const images = o && typeof o === 'object' ? /** @type {any} */ (o).images : undefined;
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new TypeError('images must be an array');
  if (images.length > MAX_TURN_IMAGES) throw new Error(`A message can carry at most ${MAX_TURN_IMAGES} images`);
  return images.map((img) => {
    if (!img || !IMAGE_MEDIA_TYPES.includes(img.mediaType) || typeof img.data !== 'string' || !img.data || img.data.length > MAX_IMAGE_BASE64) {
      throw new Error('Invalid image (expected { mediaType: image/jpeg|png|webp, data: base64 })');
    }
    return { mediaType: img.mediaType, data: img.data };
  });
}

/**
 * How the Claude CLI words a missing or expired login (code.claude.com/docs/en/errors, checked
 * 2026-10): "Not logged in · Please run /login", "Invalid API key · Please run /login",
 * "OAuth token revoked/has expired", "Login expired", "API Error: 401 Invalid authentication
 * credentials", "This organization has been disabled" (a stale ANTHROPIC_API_KEY), …
 * Only error results, CLI error messages and stderr are matched, never normal replies.
 */
const AUTH_ERROR_RE = /not logged in|please run \/login|login expired|authentication required|sign in again|invalid api key|oauth (?:token|session)[^.\n]{0,40}(?:expired|revoked|refreshed)|oauth error|failed to authenticate|invalid authentication credentials|authentication_(?:error|failed)|api error: 401|organization has been disabled|access has not been granted/i;

/**
 * Classify CLI error text: 'auth' when it says the user must (re-)login, otherwise null.
 * @param {unknown} text
 * @returns {'auth'|null}
 */
export function classifyClaudeError(text) {
  return typeof text === 'string' && AUTH_ERROR_RE.test(text) ? 'auth' : null;
}

/** First meaningful line of an error text, shortened (for the setup card). @param {string} text */
function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('[ede_diagnostic]')) || '';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** App tool names that may reach --allowedTools / --disallowedTools (contract §10.1). */
export const MCP_TOOL_NAME = /^mcp__[a-z0-9-]+__[a-z][a-z0-9_]{0,63}$/;
/** Names of the app's in-process MCP servers (they become the `mcp__<name>__` prefix). */
const MCP_SERVER_NAME = /^[a-z0-9-]{1,64}$/;
/**
 * The loopback HTTP fallback ("G2", contract §10.4): the --mcp-config file names this variable
 * instead of the bearer token, and the token itself travels only in the CLI's environment.
 */
export const MCP_TOKEN_ENV = 'LM_MCP_TOKEN';

/**
 * An in-process MCP server the app offers to Claude (the camera: electron/tapo/camera-mcp.js).
 * `handle` answers one JSON-RPC message (null for a notification). `startHttp` / `stopHttp`
 * serve the same handle() over loopback Streamable HTTP for a CLI that does not take
 * in-process servers: startHttp() resolves { url: 'http://127.0.0.1:<port>/mcp', token } and is
 * idempotent while running (same url and token); the endpoint wants `Authorization: Bearer
 * <token>` and refuses any request with an Origin header or another Host.
 * @typedef {{ name: string, handle: (message: object) => Promise<object|null>,
 *             startHttp?: () => Promise<{ url: string, token: string }>, stopHttp?: () => Promise<void> }} SdkMcpServer
 */

/** @param {unknown} list @param {string} what */
function toolList(list, what) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError(`${what} must be an array`);
  for (const t of list) if (typeof t !== 'string' || !MCP_TOOL_NAME.test(t)) throw new Error(`Invalid tool name in ${what}: ${JSON.stringify(t)}`);
  return [...new Set(list)];
}

const SAFE_MODEL = /^[A-Za-z0-9._:@/[\]-]{1,100}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'auto']);

/**
 * @typedef {object} ClaudeSettings  settings.claude (contract §4)
 * @property {string} cliPath
 * @property {string} model
 * @property {string} effort
 * @property {'chat'|'assistant'|'agent'} mode
 * @property {string} workdir
 * @property {string} persona
 * @property {boolean} resumeLastSession
 * @property {string} lastSessionId
 */

/**
 * Build the CLI argument list (contract §3.2). Values that reach the command line are
 * re-validated here (defense in depth; settings.js validates them too).
 *
 * App tools (the home camera, contract §10): `allowedTools` are pre-approved (no card),
 * `disallowedTools` are removed from the CLI; only `mcp__<server>__<tool>` names are accepted.
 * `mcpConfigFile` loads the app's servers over loopback HTTP (the fallback for a CLI that does
 * not take in-process servers); chat mode still passes --strict-mcp-config, so the user's own
 * MCP servers stay out.
 * @param {{ mode?: string, model?: string, effort?: string, resumeSessionId?: string,
 *           personaFile: string, agentPermissionMode?: string, strictMcpInChat?: boolean,
 *           allowedTools?: string[], disallowedTools?: string[], mcpConfigFile?: string,
 *           extraArgs?: string[] }} o
 * @returns {string[]}
 */
export function buildClaudeArgs(o) {
  const allowed = toolList(o.allowedTools, 'allowedTools');
  const denied = toolList(o.disallowedTools, 'disallowedTools');
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
  ];
  if (o.model) {
    if (!SAFE_MODEL.test(o.model)) throw new Error(`Invalid model name: ${JSON.stringify(o.model)}`);
    args.push('--model', o.model);
  }
  if (o.effort) {
    if (!EFFORTS.has(o.effort)) throw new Error(`Invalid effort level: ${JSON.stringify(o.effort)}`);
    args.push('--effort', o.effort);
  }
  if (o.resumeSessionId) {
    if (!SAFE_SESSION_ID.test(o.resumeSessionId)) throw new Error('Invalid session id');
    args.push('--resume', o.resumeSessionId);
  }
  if (!o.personaFile) throw new Error('personaFile is required');
  // Only the user's own settings (~/.claude/settings.json). Project/local settings in the working
  // folder are NOT loaded: `-p` mode shows no workspace-trust prompt, so a cloned repository's
  // .claude/settings.json hooks would otherwise run commands with no approval at all.
  args.push('--setting-sources', 'user');
  switch (o.mode) {
    case 'assistant':
      args.push('--tools', ASSISTANT_TOOLS, '--allowedTools', [ASSISTANT_ALLOWED_TOOLS, ...allowed].join(','), '--append-system-prompt-file', o.personaFile);
      break;
    case 'agent':
      args.push('--append-system-prompt-file', o.personaFile);
      if (o.agentPermissionMode) {
        if (!PERMISSION_MODES.has(o.agentPermissionMode)) throw new Error('Invalid permission mode');
        args.push('--permission-mode', o.agentPermissionMode);
      }
      if (allowed.length) args.push('--allowedTools', allowed.join(','));
      break;
    default:
      // Pure conversation: no built-in tools, and skip the user's MCP servers too (they would
      // add tools and slow every launch). The app's own tools (the camera) still come in: as
      // in-process servers (initialize.sdkMcpServers) or through mcpConfigFile.
      args.push('--tools', '', '--system-prompt-file', o.personaFile);
      if (o.strictMcpInChat !== false) args.push('--strict-mcp-config');
      if (allowed.length) args.push('--allowedTools', allowed.join(','));
  }
  if (denied.length) args.push('--disallowedTools', denied.join(','));
  if (o.mcpConfigFile) args.push('--mcp-config', o.mcpConfigFile);
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs.map(String));
  return args;
}

/**
 * settings.claude.workdir → absolute folder ('' = <home>/LawnmowerMan).
 * @param {string} setting @param {{ homedir?: string, env?: Record<string,string|undefined>, platform?: string }} [ctx]
 */
export function resolveWorkdir(setting, ctx = {}) {
  const homedir = ctx.homedir || os.homedir();
  const platform = ctx.platform || process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const raw = typeof setting === 'string' ? setting.trim() : '';
  if (!raw) return P.join(homedir, 'LawnmowerMan');
  return P.resolve(expandUserPath(raw, { env: ctx.env || process.env, platform, homedir }));
}

/**
 * Condense tool_result content (string or content blocks) into a short one-line summary.
 * @param {unknown} content @param {number} [max]
 */
export function summarizeToolResult(content, max = 300) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[image]';
        return b.type ? `[${b.type}]` : '';
      })
      .filter(Boolean)
      .join(' ');
  } else if (content && typeof content === 'object') {
    try { text = JSON.stringify(content); } catch { text = ''; }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} n */
const finiteOrUndef = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/**
 * Something the user has to fix outside the app before Claude can answer (shown as a setup card).
 * @typedef {{ kind: 'cli-missing'|'auth', detail: string }} ClaudeProblem
 */

/**
 * @typedef {object} ClaudeSessionOptions
 * @property {() => ClaudeSettings} getSettings  returns the current settings.claude
 * @property {string} personaDir                 where persona files are written (userData/persona)
 * @property {(sessionId: string) => void} [onSessionId]  persist the session id ('' = cleared)
 * @property {string} [cliPath]       explicit CLI path, bypassing auto-detection (tests, env override)
 * @property {(o: import('./claude-path.js').ResolveOptions) => Promise<import('./claude-path.js').ResolveResult>} [resolveCli]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [platform]
 * @property {string} [homedir]
 * @property {number} [interruptTimeoutMs]  default 5000
 * @property {number} [initTimeoutMs]       default 20000
 * @property {number} [stopGraceMs]         default 2000
 * @property {{ baseDelayMs?: number, maxDelayMs?: number, maxAttempts?: number, stableMs?: number }} [restart]
 * @property {string} [agentPermissionMode] e.g. 'acceptEdits' (default: none → every edit asks)
 * @property {string[]} [extraArgs]         appended to the CLI args (diagnostics/tests)
 * @property {() => SdkMcpServer[]} [getSdkMcpServers]  the app's in-process MCP servers (contract §10.1)
 * @property {() => { allow: string[], deny: string[] }} [getToolPermissions]  pre-approved / removed app tools
 * @property {() => Record<string, any>} [getPersonaContext]  passed to buildPersona(mode, { context })
 * @property {string} [mcpDir]              where the HTTP fallback's --mcp-config file is written
 *                                          (default: <personaDir>/../mcp, i.e. <userData>/mcp)
 * @property {(level: 'debug'|'info'|'warn'|'error', msg: string) => void} [log]
 */

/**
 * @typedef {object} Turn
 * @property {string} turnId
 * @property {string} text
 * @property {boolean} messageOpen
 * @property {Set<string>} streamedIds   message ids seen via stream_event message_start
 * @property {Set<string>} endedIds      message ids whose message_end was emitted (fallback)
 * @property {Set<string>} toolIds
 * @property {Set<string>} thinkingKeys
 * @property {number} messageIndex
 * @property {boolean} interrupted
 * @property {NodeJS.Timeout|null} interruptTimer
 * @property {Promise<void>} ended
 * @property {() => void} resolveEnded
 */

export class ClaudeSession extends EventEmitter {
  /** @param {ClaudeSessionOptions} opts */
  constructor(opts) {
    super();
    if (!opts || typeof opts.getSettings !== 'function') throw new TypeError('getSettings is required');
    if (!opts.personaDir) throw new TypeError('personaDir is required');
    this._getSettings = opts.getSettings;
    this._personaDir = opts.personaDir;
    this._onSessionId = opts.onSessionId || (() => {});
    this._cliOverride = opts.cliPath || '';
    this._resolver = opts.resolveCli || resolveClaudeCli;
    this._env = opts.env || process.env;
    this._platform = opts.platform || process.platform;
    this._homedir = opts.homedir || os.homedir();
    this._interruptTimeoutMs = opts.interruptTimeoutMs ?? 5000;
    this._initTimeoutMs = opts.initTimeoutMs ?? 20000;
    this._stopGraceMs = opts.stopGraceMs ?? 2000;
    /** Kills still in flight for processes already detached (interrupt fallback, restarts). @type {Set<Promise<void>>} */
    this._killing = new Set();
    this._restartCfg = {
      baseDelayMs: opts.restart?.baseDelayMs ?? 1000,
      maxDelayMs: opts.restart?.maxDelayMs ?? 30000,
      maxAttempts: opts.restart?.maxAttempts ?? 6,
      stableMs: opts.restart?.stableMs ?? 60000,
    };
    this._agentPermissionMode = opts.agentPermissionMode || '';
    this._extraArgs = opts.extraArgs || [];
    this._log = opts.log || (() => {});
    this._getSdkMcpServers = opts.getSdkMcpServers || (() => []);
    this._getToolPermissions = opts.getToolPermissions || (() => ({ allow: [], deny: [] }));
    this._getPersonaContext = opts.getPersonaContext || (() => ({}));
    this._mcpDir = opts.mcpDir || path.join(path.dirname(this._personaDir), 'mcp');
    /**
     * How the app's MCP servers reach the CLI: 'sdk' (in-process over the control channel,
     * contract §10.1) until a CLI shows that it ignores them; then 'http' (loopback, §10.4) for
     * the rest of this app session.
     * @type {'sdk'|'http'}
     */
    this._mcpTransport = 'sdk';
    /** Servers whose HTTP endpoint we started (stopped when no longer used). @type {Map<string, SdkMcpServer>} */
    this._httpServers = new Map();
    /** @type {Set<string>} */
    this._warned = new Set();

    const s = this._safeSettings();
    /** Current conversation id ('' = none yet). Restarts always resume it. */
    this._sessionId = s.resumeLastSession && SAFE_SESSION_ID.test(s.lastSessionId || '') ? s.lastSessionId : '';
    this._model = '';
    /** @type {string[]} */
    this._tools = [];
    /** @type {'starting'|'ready'|'busy'|'restarting'|'exited'|'error'} */
    this._status = 'exited';
    this._statusDetail = '';
    /** @type {any} */
    this._procInfo = null;
    this._ready = false;
    /** @type {Promise<void>|null} */
    this._starting = null;
    /** @type {NodeJS.Timeout|null} */
    this._restartTimer = null;
    this._failures = 0;
    this._stopped = false;
    this._pendingRestart = false;
    /** @type {{ key: string, path: string, version?: string, source?: string }|null} */
    this._cli = null;
    /** @type {{ turnId: string, text: string, images: TurnImage[] }[]} */
    this._queue = [];
    /** @type {Turn|null} */
    this._active = null;
    /** @type {Map<string, { input: Record<string, any>, toolName: string, turnId: string|null, info: any, description?: string }>} */
    this._permissions = new Map();
    /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout|null, info: any, subtype: string }>} */
    this._controls = new Map();
    this._turnCounter = 0;
    this._controlCounter = 0;
    this._lastStderr = new TextRingBuffer(8 * 1024);
    /** @type {ClaudeProblem|null} */
    this._problem = null;
  }

  // -------------------------------------------------------------------------------------------
  // Public API (mirrors window.lawnmower.claude)

  /** Start the CLI (resolves once it is ready). Safe to call repeatedly. */
  start() {
    this._stopped = false;
    return this._ensureRunning();
  }

  /**
   * Queue a user turn. Resolves as soon as it is queued (the reply streams as events).
   * Rejects if the text is invalid or the Claude CLI cannot be found at all.
   * @param {string} text
   * @param {{ images?: TurnImage[] }} [opts]  images go into the turn after the text
   * @returns {Promise<{ turnId: string }>}
   */
  async send(text, opts) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const clean = text.replace(/\r\n?/g, '\n');
    if (!clean.trim()) throw new Error('Message is empty');
    if (clean.length > MAX_TURN_CHARS) throw new Error(`Message is too long (max ${MAX_TURN_CHARS} characters)`);
    const images = turnImages(opts);
    this._stopped = false;

    // Fail fast (and visibly) when there is no CLI at all, instead of queueing forever.
    if (!this._procInfo && !this._starting) {
      await this._resolveCli(this._safeSettings()).catch((err) => {
        this._cliUnavailable(err);
        throw err;
      });
    }

    const turnId = `turn-${++this._turnCounter}-${Date.now().toString(36)}`;
    this._queue.push({ turnId, text: clean, images });
    if (!this._procInfo && !this._starting) {
      // Not running (never started, stopped, gave up, or waiting in backoff): start now.
      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      if (this._status === 'error') this._failures = 0;
      this._ensureRunning().catch((err) => this._log('warn', `[claude] start failed: ${err.message}`));
    } else {
      this._pump();
    }
    return { turnId };
  }

  /** Stop the current turn. Resolves when that turn has ended (bounded by the fallback). */
  async interrupt() {
    const t = this._active;
    if (!t) return;
    if (!t.interrupted) {
      t.interrupted = true;
      // Unblock the CLI if it is waiting on an approval card for this turn.
      for (const [id, p] of this._permissions) {
        if (p.turnId === t.turnId) {
          this._permissions.delete(id);
          this._writePermissionResponse(id, { behavior: 'deny', message: 'The user interrupted this turn.' });
        }
      }
      this._sendControl({ subtype: 'interrupt' }, 0).catch(() => { /* fallback timer handles it */ });
      t.interruptTimer = setTimeout(() => this._interruptFallback(t), this._interruptTimeoutMs);
    }
    await t.ended;
  }

  /** Start a fresh conversation (drops the queue and the current session id). */
  async reset() {
    this._stopped = false;
    this._pendingRestart = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    // A process that is still starting would carry the old --resume id: let it finish, then
    // replace it like any other.
    if (this._starting) await this._starting.catch(() => {});
    const info = this._procInfo;
    this._detach(info);
    // The user asked for this (tray / New conversation): an interruption, not a failure.
    if (this._active) {
      this._active.interrupted = true;
      this._endTurn({ result: '', isError: true });
    }
    this._failQueued('The conversation was reset before this message was sent.');
    this._permissions.clear();
    this._setSessionId('');
    this._model = '';
    this._tools = [];
    this._failures = 0;
    // Tell the renderer the conversation is gone (e.g. reset from the tray): an empty session.
    this._emit({ type: 'session', sessionId: '', model: '', tools: [] });
    this._setStatus('restarting', 'Starting a new conversation…');
    if (info) await this._killInfo(info, { graceful: true });
    await this._ensureRunning();
  }

  /**
   * "Retry" on the setup card: forget the detected CLI (so it is searched for again: it may
   * have just been installed), clear the setup problem and the crash counter, and start the
   * CLI again. A process that is already running is replaced (resuming the same conversation)
   * so a login the user just completed is picked up; a turn that is still running is left
   * alone. Never installs anything. Rejects when there is still no CLI.
   * @returns {Promise<void>}
   */
  async retry() {
    this._stopped = false;
    this._cli = null;
    this._failures = 0;
    this._setProblem(null);
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._starting) await this._starting.catch(() => {});
    if (this._active) return; // never kill a reply mid-way; the next turn shows any problem again
    const info = this._procInfo;
    if (info) {
      this._detach(info);
      this._setStatus('restarting', 'Checking the Claude CLI again…');
      await this._killInfo(info, { graceful: true });
    }
    await this._ensureRunning();
  }

  /**
   * Answer a permission_request.
   * @param {string} requestId
   * @param {{ behavior: 'allow'|'deny', message?: string, updatedInput?: Record<string, any> }} decision
   */
  respondPermission(requestId, decision) {
    if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId must be a string');
    const p = this._permissions.get(requestId);
    if (!p || p.info !== this._procInfo) {
      this._permissions.delete(requestId);
      throw new Error('Unknown or expired permission request');
    }
    const behavior = decision && decision.behavior;
    /** @type {Record<string, any>} */
    let response;
    if (behavior === 'allow') {
      response = { behavior: 'allow', updatedInput: isPlainObject(decision.updatedInput) ? decision.updatedInput : p.input };
    } else if (behavior === 'deny') {
      const msg = typeof decision.message === 'string' && decision.message.trim() ? decision.message.trim().slice(0, 2000) : 'The user denied this action.';
      response = { behavior: 'deny', message: msg };
    } else {
      throw new Error('decision.behavior must be "allow" or "deny"');
    }
    this._permissions.delete(requestId);
    this._writePermissionResponse(requestId, response);
  }

  /**
   * Drop a turn that has not started yet (it never reaches the CLI) and emit `turn_cancelled`.
   * A turn that is already running is interrupted instead. Unknown/finished ids are ignored.
   * @param {string} turnId
   * @returns {Promise<{ cancelled: boolean, interrupted: boolean }>}
   */
  async cancel(turnId) {
    if (typeof turnId !== 'string' || !turnId) throw new TypeError('turnId must be a string');
    const i = this._queue.findIndex((q) => q.turnId === turnId);
    if (i >= 0) {
      this._queue.splice(i, 1);
      this._emit({ type: 'turn_cancelled', turnId });
      this._pump(); // idle again → status 'ready'
      return { cancelled: true, interrupted: false };
    }
    if (this._active && this._active.turnId === turnId) {
      await this.interrupt();
      return { cancelled: false, interrupted: true };
    }
    return { cancelled: false, interrupted: false };
  }

  /**
   * @returns {{ status: string, sessionId?: string, model?: string, busy: boolean, queue: number, cliPath?: string, cliVersion?: string, detail?: string, mode: string,
   *   problem?: ClaudeProblem, activeTurnId?: string, queuedTurnIds: string[],
   *   pendingPermissions: Array<{ requestId: string, turnId: string|null, toolName: string, input: Record<string, any>, description?: string }> }}
   * `activeTurnId`, `queuedTurnIds` and `pendingPermissions` let a reloaded renderer pick up
   * where the previous one left off (events are not replayed).
   */
  status() {
    const pendingPermissions = [];
    for (const [requestId, p] of this._permissions) {
      if (p.info !== this._procInfo) continue;
      /** @type {{ requestId: string, turnId: string|null, toolName: string, input: Record<string, any>, description?: string }} */
      const entry = { requestId, turnId: p.turnId, toolName: p.toolName, input: p.input };
      if (p.description) entry.description = p.description;
      pendingPermissions.push(entry);
    }
    return {
      status: this._status,
      sessionId: this._sessionId || undefined,
      model: this._model || undefined,
      busy: !!this._active,
      queue: this._queue.length,
      cliPath: this._cli?.path,
      cliVersion: this._cli?.version,
      detail: this._statusDetail || undefined,
      problem: this._problem ? { ...this._problem } : undefined,
      mode: this._safeSettings().mode,
      activeTurnId: this._active ? this._active.turnId : undefined,
      queuedTurnIds: this._queue.map((q) => q.turnId),
      pendingPermissions,
    };
  }

  /**
   * React to a settings change. Restarts the CLI (resuming the same conversation) when a
   * spawn-relevant field changed; waits for the active turn to finish first.
   */
  applySettings() {
    const s = this._safeSettings();
    if ((this._cli && this._cli.key !== (this._cliOverride || s.cliPath || ''))) this._cli = null;
    const key = this._spawnKeyFor(s);
    if (!this._procInfo || this._procInfo.spawnKey === key) return;
    if (this._active) {
      this._pendingRestart = true;
      return;
    }
    this._restartForSettings();
  }

  /** Stop the CLI (app shutdown). */
  async stop() {
    this._stopped = true;
    this._pendingRestart = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const info = this._procInfo;
    this._detach(info);
    if (this._active) {
      this._active.interrupted = true;
      this._endTurn({ result: '', isError: true });
    }
    this._failQueued('Claude was stopped before this message was sent.');
    this._permissions.clear();
    if (info) await this._killInfo(info, { graceful: true });
    // A process detached by an interrupt fallback or a settings restart may still be exiting:
    // wait for it too, so "stopped" means no CLI process is left (on Windows a live process
    // also keeps its working folder locked).
    await Promise.allSettled([...this._killing]);
    await this._stopHttpServers(new Set());
    this._setStatus('exited', 'Stopped');
  }

  // -------------------------------------------------------------------------------------------
  // Process lifecycle

  _safeSettings() {
    /** @type {any} */
    let s = {};
    try {
      s = this._getSettings() || {};
    } catch (err) {
      this._log('error', `[claude] getSettings failed: ${/** @type {Error} */ (err).message}`);
    }
    return {
      cliPath: typeof s.cliPath === 'string' ? s.cliPath : '',
      model: typeof s.model === 'string' ? s.model : '',
      effort: typeof s.effort === 'string' ? s.effort : '',
      mode: s.mode === 'assistant' || s.mode === 'agent' ? s.mode : 'chat',
      workdir: typeof s.workdir === 'string' ? s.workdir : '',
      persona: typeof s.persona === 'string' ? s.persona : '',
      resumeLastSession: s.resumeLastSession !== false,
      lastSessionId: typeof s.lastSessionId === 'string' ? s.lastSessionId : '',
    };
  }

  /** @param {ReturnType<ClaudeSession['_safeSettings']>} s */
  _spawnKeyFor(s) {
    const m = this._mcpPlan();
    // a change of the app's tools, their permissions or the persona context restarts the CLI
    // (after the running turn), resuming the conversation
    return JSON.stringify([s.mode, s.model, s.effort, s.workdir, s.persona, this._cliOverride || s.cliPath, [m.names, m.allow, m.deny, m.context, m.transport]]);
  }

  /**
   * The app's MCP servers, tool permissions and persona context as they are now (no side
   * effects; called for every spawn-key comparison).
   * @returns {{ servers: SdkMcpServer[], names: string[], allow: string[], deny: string[], context: Record<string, any>, transport: 'none'|'sdk'|'http' }}
   */
  _mcpPlan() {
    /** @type {SdkMcpServer[]} */
    let servers = [];
    try {
      const list = this._getSdkMcpServers();
      servers = (Array.isArray(list) ? list : []).filter((sv) => {
        const ok = sv && typeof sv.name === 'string' && MCP_SERVER_NAME.test(sv.name) && typeof sv.handle === 'function';
        if (!ok) this._warnOnce(`server:${sv && sv.name}`, `[claude] ignoring an invalid MCP server entry ${JSON.stringify(sv && sv.name)}`);
        return ok;
      });
    } catch (err) {
      this._log('error', `[claude] getSdkMcpServers failed: ${/** @type {Error} */ (err).message}`);
    }
    const seen = new Set();
    servers = servers.filter((sv) => !seen.has(sv.name) && seen.add(sv.name));
    /** @type {{ allow?: unknown, deny?: unknown }} */
    let perms = {};
    try {
      perms = this._getToolPermissions() || {};
    } catch (err) {
      this._log('error', `[claude] getToolPermissions failed: ${/** @type {Error} */ (err).message}`);
    }
    const names = servers.map((sv) => sv.name);
    // only tools of servers that are actually offered; anything malformed is dropped (and logged)
    const pick = (/** @type {unknown} */ list) => (Array.isArray(list) ? list : []).filter((t) => {
      const ok = typeof t === 'string' && MCP_TOOL_NAME.test(t);
      if (!ok) this._warnOnce(`tool:${t}`, `[claude] ignoring an invalid tool permission ${JSON.stringify(t)}`);
      return ok && names.some((n) => t.startsWith(`mcp__${n}__`));
    }).sort();
    /** @type {Record<string, any>} */
    let context = {};
    try {
      const c = this._getPersonaContext();
      context = isPlainObject(c) ? JSON.parse(JSON.stringify(c)) : {};
    } catch (err) {
      this._log('error', `[claude] getPersonaContext failed: ${/** @type {Error} */ (err).message}`);
    }
    const http = this._mcpTransport === 'http' && servers.every((sv) => typeof sv.startHttp === 'function');
    return { servers, names, allow: pick(perms.allow), deny: pick(perms.deny), context, transport: !servers.length ? 'none' : http ? 'http' : 'sdk' };
  }

  /**
   * Serve the plan's servers over loopback HTTP and write the --mcp-config file (fallback G2).
   * @param {SdkMcpServer[]} servers
   * @returns {Promise<{ file: string, env: Record<string, string> }>}
   */
  async _startHttpServers(servers) {
    /** @type {Record<string, any>} */
    const mcpServers = {};
    /** @type {Record<string, string>} */
    const env = {};
    let i = 0;
    for (const sv of servers) {
      const ep = await /** @type {NonNullable<SdkMcpServer['startHttp']>} */ (sv.startHttp)();
      if (!ep || typeof ep.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//.test(ep.url) || typeof ep.token !== 'string' || !ep.token) {
        throw new Error(`${sv.name}: startHttp() did not return a loopback url and a token`);
      }
      this._httpServers.set(sv.name, sv);
      const tokenEnv = i++ === 0 ? MCP_TOKEN_ENV : `${MCP_TOKEN_ENV}_${i}`;
      env[tokenEnv] = ep.token;
      mcpServers[sv.name] = { type: 'http', url: ep.url, headers: { Authorization: `Bearer \${${tokenEnv}}` } };
    }
    nodeFs.mkdirSync(this._mcpDir, { recursive: true });
    const file = path.join(this._mcpDir, servers.length === 1 ? `${servers[0].name}.json` : 'app-servers.json');
    const tmp = `${file}.${process.pid}.tmp`;
    nodeFs.writeFileSync(tmp, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8');
    nodeFs.renameSync(tmp, file);
    // The CLI must reach 127.0.0.1 directly, also when the user has a proxy configured.
    const noProxy = [this._env.NO_PROXY, this._env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
    env.NO_PROXY = noProxy;
    return { file, env };
  }

  /** @param {string} key @param {string} msg */
  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._log('warn', msg);
  }

  /** Stop the HTTP endpoints we started that the next CLI no longer uses. @param {Set<string>} keep */
  async _stopHttpServers(keep) {
    const stops = [];
    for (const [name, sv] of this._httpServers) {
      if (keep.has(name)) continue;
      this._httpServers.delete(name);
      if (typeof sv.stopHttp === 'function') stops.push(Promise.resolve().then(() => /** @type {any} */ (sv).stopHttp()).catch((err) => this._log('warn', `[claude] stopping the ${name} MCP endpoint: ${err.message}`)));
    }
    await Promise.all(stops);
  }

  _ensureRunning() {
    if (this._ready && this._procInfo) return Promise.resolve();
    if (this._starting) return this._starting;
    if (this._procInfo) return this._procInfo.readyPromise;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const p = this._spawn().finally(() => {
      if (this._starting === p) this._starting = null;
    });
    this._starting = p;
    return p;
  }

  /** @param {ReturnType<ClaudeSession['_safeSettings']>} s */
  async _resolveCli(s) {
    const key = this._cliOverride || s.cliPath || '';
    if (this._cli && this._cli.key === key) return this._cli;
    if (this._cliOverride) {
      this._cli = { key, path: this._cliOverride, source: 'override' };
      return this._cli;
    }
    const r = await this._resolver({ override: s.cliPath, env: this._env, platform: this._platform, homedir: this._homedir });
    if (r.warning) this._log('warn', `[claude] ${r.warning}`);
    if (!r.path) {
      const err = /** @type {Error & { notFound?: boolean }} */ (new Error(r.error || 'Claude CLI not found'));
      err.notFound = true;
      throw err;
    }
    this._cli = { key, path: r.path, version: r.version, source: r.source || undefined };
    this._log('info', `[claude] using ${r.path}${r.version ? ` (${r.version})` : ''} [${r.source}]`);
    if (this._problem?.kind === 'cli-missing') this._setProblem(null);
    return this._cli;
  }

  /** The CLI could not be resolved: status 'error' (+ the setup card when it is missing). @param {Error & { notFound?: boolean }} err */
  _cliUnavailable(err) {
    if (err.notFound) this._setProblem({ kind: 'cli-missing', detail: err.message });
    this._setStatus('error', err.message);
  }

  async _spawn() {
    const s = this._safeSettings();
    let cli;
    try {
      cli = await this._resolveCli(s);
    } catch (err) {
      this._cliUnavailable(/** @type {Error} */ (err));
      this._failQueued(/** @type {Error} */ (err).message);
      throw err;
    }

    const workdir = resolveWorkdir(s.workdir, { homedir: this._homedir, env: this._env, platform: this._platform });
    // The app's own tools (contract §10): computed once per spawn and kept on `info`.
    const plan = this._mcpPlan();
    const spawnKey = this._spawnKeyFor(s);
    let personaFile;
    try {
      nodeFs.mkdirSync(workdir, { recursive: true });
    } catch (err) {
      const msg = `Cannot create the working folder ${workdir}: ${/** @type {Error} */ (err).message}`;
      this._setStatus('error', msg);
      this._failQueued(msg);
      throw new Error(msg);
    }
    try {
      personaFile = this._writePersona(s, workdir, plan.context);
    } catch (err) {
      const msg = `Cannot write the persona file: ${/** @type {Error} */ (err).message}`;
      this._setStatus('error', msg);
      this._failQueued(msg);
      throw new Error(msg);
    }

    /** @type {{ file: string, env: Record<string, string> }|null} */
    let http = null;
    let transport = plan.transport;
    if (transport === 'http') {
      try {
        http = await this._startHttpServers(plan.servers);
      } catch (err) {
        // without the endpoint the camera tools are simply missing this time; the in-process
        // route is offered again (it costs nothing)
        this._log('warn', `[claude] MCP over HTTP unavailable: ${/** @type {Error} */ (err).message}`);
        transport = 'sdk';
      }
    }
    await this._stopHttpServers(new Set(transport === 'http' ? plan.names : []));

    const resumeId = this._sessionId || '';
    const args = buildClaudeArgs({
      mode: s.mode,
      model: s.model,
      effort: s.effort,
      resumeSessionId: resumeId,
      personaFile,
      agentPermissionMode: s.mode === 'agent' ? this._agentPermissionMode : '',
      allowedTools: plan.allow,
      disallowedTools: plan.deny,
      mcpConfigFile: http ? http.file : '',
      extraArgs: this._extraArgs,
    });
    if (this._stopped) throw new Error('Claude session was stopped');

    this._setStatus('starting', `Starting Claude (${s.mode} mode)…`);
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      ({ child } = spawnPortable(cli.path, args, {
        cwd: workdir,
        env: cleanChildEnv(this._env, http ? http.env : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        platform: this._platform,
        windowsHide: true,
      }));
    } catch (err) {
      const msg = `Could not start the Claude CLI (${cli.path}): ${/** @type {Error} */ (err).message}`;
      this._setStatus('error', msg);
      throw new Error(msg);
    }
    const mcpNote = plan.names.length ? `, tools ${plan.names.join('+')} via ${transport === 'http' ? 'HTTP' : 'control channel'}` : '';
    this._log('info', `[claude] spawned pid ${child.pid} (${s.mode}${resumeId ? `, resume ${resumeId}` : ''}${mcpNote})`);

    const info = {
      proc: child,
      ready: false,
      readyAt: 0,
      exited: false,
      expectedExit: false,
      resumeId,
      spawnKey,
      /** The app's MCP servers as offered to this process. */
      mcp: {
        transport,
        names: plan.names,
        /** @type {Map<string, SdkMcpServer>} */
        servers: new Map(plan.servers.map((sv) => [sv.name, sv])),
        /** servers whose tools/list this process asked for (the in-process route works) */
        listed: new Set(),
        checked: false,
      },
      spawnedAt: Date.now(),
      stderr: new TextRingBuffer(16 * 1024),
      lastErrorText: '',
      lastSessionEvent: '',
      /** @type {JsonLineParser|null} */
      parser: null,
      /** @type {(v?: any) => void} */
      resolveReady: () => {},
      /** @type {(e: Error) => void} */
      rejectReady: () => {},
      /** @type {Promise<void>} */
      readyPromise: Promise.resolve(),
    };
    info.readyPromise = new Promise((resolve, reject) => {
      info.resolveReady = resolve;
      info.rejectReady = reject;
    });
    info.readyPromise.catch(() => { /* observed via status events */ });
    info.parser = new JsonLineParser({
      onMessage: (m) => this._handleMessage(info, m),
      onError: (err, line) => this._log('warn', `[claude] ${err.message}${line ? `: ${line.slice(0, 200)}` : ''}`),
    });

    this._procInfo = info;
    this._ready = false;

    child.stdout?.on('data', (chunk) => info.parser?.push(chunk));
    child.stderr?.on('data', (chunk) => {
      info.stderr.push(chunk);
      this._lastStderr.push(chunk);
      const text = String(chunk).trim();
      if (text) this._log('debug', `[claude:stderr] ${text.slice(0, 500)}`);
    });
    child.stdin?.on('error', (err) => this._log('warn', `[claude] stdin: ${err.message}`));
    child.once('error', (err) => {
      info.lastErrorText = err.message;
      this._log('error', `[claude] process error: ${err.message}`);
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'EACCES') {
        this._cli = null; // re-detect on the next attempt
        if (code === 'ENOENT') this._setProblem({ kind: 'cli-missing', detail: `The Claude CLI at ${cli.path} could not be started (${err.message}).` });
      }
      if (child.pid === undefined) this._onExit(info, null, null);
    });
    child.once('close', (code, signal) => this._onExit(info, code, signal));

    /** @type {Record<string, any>} */
    const init = { subtype: 'initialize' };
    if (transport === 'sdk' && plan.names.length) init.sdkMcpServers = plan.names;
    this._sendControl(init, this._initTimeoutMs).then(
      () => this._onReady(info),
      (err) => {
        if (info === this._procInfo && !info.exited) {
          this._log('warn', `[claude] initialize: ${err.message}; continuing anyway`);
          this._onReady(info);
        }
      },
    );
    return info.readyPromise;
  }

  /** @param {ReturnType<ClaudeSession['_safeSettings']>} s @param {string} workdir @param {Record<string, any>} [context] */
  _writePersona(s, workdir, context = {}) {
    nodeFs.mkdirSync(this._personaDir, { recursive: true });
    const file = path.join(this._personaDir, personaFileName(s.mode));
    const text = buildPersona(s.mode, { custom: s.persona, platform: this._platform, workdir, context });
    const tmp = `${file}.${process.pid}.tmp`;
    nodeFs.writeFileSync(tmp, text, 'utf8');
    nodeFs.renameSync(tmp, file);
    return file;
  }

  /** @param {any} info */
  _onReady(info) {
    if (info !== this._procInfo || info.ready || info.exited) return;
    info.ready = true;
    info.readyAt = Date.now();
    this._ready = true;
    info.resolveReady();
    // Settings may have changed while we were starting.
    if (info.spawnKey !== this._spawnKeyFor(this._safeSettings())) {
      this._restartForSettings();
      return;
    }
    this._setStatus('ready');
    this._pump();
  }

  /**
   * Forget the current process without killing it yet (its late output is then ignored).
   * @param {any} info
   */
  _detach(info) {
    if (!info) return;
    info.expectedExit = true;
    if (this._procInfo === info) {
      this._procInfo = null;
      this._ready = false;
    }
    this._rejectControls(info, new Error('Claude CLI stopped'));
  }

  /** @param {any} info @param {{ graceful?: boolean }} [o] */
  async _killInfo(info, o = {}) {
    if (!info || info.exited) return;
    info.expectedExit = true;
    const child = info.proc;
    const kill = (async () => {
      if (o.graceful) {
        try { child.stdin?.end(); } catch { /* ignore */ }
        if (await waitForExit(child, this._stopGraceMs)) return;
      }
      await killProcessTree(child, { platform: this._platform });
    })();
    this._killing.add(kill);
    try {
      await kill;
    } finally {
      this._killing.delete(kill);
    }
  }

  /** Restart (resuming the same conversation) so new settings take effect. Never throws. */
  async _restartForSettings() {
    try {
      const info = this._procInfo;
      this._pendingRestart = false;
      this._detach(info);
      this._setStatus('restarting', 'Applying new settings…');
      if (info) await this._killInfo(info, { graceful: true });
      if (this._stopped) return;
      await this._ensureRunning();
    } catch (err) {
      this._log('warn', `[claude] restart failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  /** The CLI ignored an interrupt: kill it and resume the conversation. Never throws. @param {Turn} t */
  async _interruptFallback(t) {
    try {
      if (this._active !== t) return;
      const secs = Math.round(this._interruptTimeoutMs / 1000);
      this._log('warn', `[claude] turn did not stop within ${secs}s of an interrupt; restarting the CLI`);
      const info = this._procInfo;
      this._detach(info);
      this._endTurn({ result: '', isError: true });
      this._setStatus('restarting', 'Claude did not stop in time; restarting…');
      if (info) await this._killInfo(info, { graceful: false });
      if (this._stopped) return;
      await this._ensureRunning();
    } catch (err) {
      this._log('warn', `[claude] restart after interrupt failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  /** @param {any} info @param {number|null} code @param {NodeJS.Signals|null} signal */
  _onExit(info, code, signal) {
    if (info.exited) return;
    info.exited = true;
    try { info.parser?.end(); } catch { /* ignore */ }
    const current = this._procInfo === info;
    if (current) {
      this._procInfo = null;
      this._ready = false;
    }
    this._rejectControls(info, new Error('Claude CLI exited'));
    for (const [id, p] of this._permissions) if (p.info === info) this._permissions.delete(id);
    const how = code !== null && code !== undefined ? `code ${code}` : signal ? `signal ${signal}` : 'spawn failure';
    this._log(info.expectedExit ? 'info' : 'warn', `[claude] process exited (${how})`);
    if (!info.ready) info.rejectReady(new Error(`Claude CLI exited during startup (${how})`));
    if (info.expectedExit || this._stopped || !current) return;

    // ---- Unexpected exit ----
    const tail = info.stderr.tail(8);
    const desc = `Claude CLI exited unexpectedly (${how})`;
    const detail = [desc, tail || info.lastErrorText].filter(Boolean).join(': ');
    this._noteErrorText(`${tail}\n${info.lastErrorText}`);
    if (this._active) {
      this._emit({ type: 'error', message: detail, turnId: this._active.turnId });
      this._endTurn({ result: '', isError: true });
    }
    if (info.readyAt && Date.now() - info.readyAt > this._restartCfg.stableMs) this._failures = 0;
    this._failures++;

    if (!info.ready && info.resumeId) {
      // Most likely the previous conversation can't be resumed (deleted, other folder, …).
      const notFound = /no conversation found/i.test(`${tail}\n${info.lastErrorText}`);
      this._log('warn', `[claude] resume of ${info.resumeId} failed; starting a new conversation`);
      this._emit({
        type: 'error',
        message: notFound
          ? 'The previous conversation could not be found, so a new one was started.'
          : `Could not resume the previous conversation (${tail || how}); starting a new one.`,
      });
      this._setSessionId('');
    }

    if (this._failures > this._restartCfg.maxAttempts) {
      const msg = `${detail}. Gave up after ${this._restartCfg.maxAttempts} restart attempts.`;
      this._setStatus('error', msg);
      this._failQueued(msg);
      return;
    }
    const delay = !info.ready && info.resumeId ? 0 : backoffDelay(this._failures, this._restartCfg.baseDelayMs, this._restartCfg.maxDelayMs);
    this._setStatus('restarting', `${desc}; restarting in ${Math.ceil(delay / 1000)}s (attempt ${this._failures}/${this._restartCfg.maxAttempts})`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._stopped) return;
      this._ensureRunning().catch((err) => this._log('warn', `[claude] restart failed: ${err.message}`));
    }, delay);
  }

  // -------------------------------------------------------------------------------------------
  // Turns

  _pump() {
    if (!this._ready || !this._procInfo || this._active || this._pendingRestart) return;
    const next = this._queue.shift();
    if (!next) {
      this._setStatus('ready');
      return;
    }
    /** @type {() => void} */
    let resolveEnded = () => {};
    const ended = new Promise((r) => { resolveEnded = () => r(undefined); });
    this._active = {
      turnId: next.turnId,
      text: next.text,
      messageOpen: false,
      streamedIds: new Set(),
      endedIds: new Set(),
      toolIds: new Set(),
      thinkingKeys: new Set(),
      messageIndex: 0,
      interrupted: false,
      interruptTimer: null,
      ended,
      resolveEnded,
    };
    this._setStatus('busy');
    this._emit({ type: 'turn_start', turnId: next.turnId, text: next.text });
    const ok = this._write({ type: 'user', message: { role: 'user', content: userMessageContent(next.text, next.images) } });
    if (!ok) this._log('warn', '[claude] could not write the turn to stdin; waiting for restart');
  }

  /** @param {{ result: string, isError: boolean, durationMs?: number, costUsd?: number, reset?: boolean }} r */
  _endTurn(r) {
    const t = this._active;
    if (!t) return;
    if (t.interruptTimer) clearTimeout(t.interruptTimer);
    if (t.messageOpen) {
      t.messageOpen = false;
      this._emit({ type: 'message_end', turnId: t.turnId });
    }
    for (const [id, p] of this._permissions) if (p.turnId === t.turnId) this._permissions.delete(id);
    this._active = null;
    /** @type {Record<string, any>} */
    const ev = { type: 'turn_end', turnId: t.turnId, result: r.result || '', isError: !!r.isError };
    if (r.durationMs !== undefined) ev.durationMs = r.durationMs;
    if (r.costUsd !== undefined) ev.costUsd = r.costUsd;
    if (this._sessionId) ev.sessionId = this._sessionId;
    if (t.interrupted) ev.interrupted = true;
    this._emit(ev);
    t.resolveEnded();
    if (this._pendingRestart && this._procInfo) {
      this._restartForSettings();
      return;
    }
    this._pump();
  }

  /** @param {string} message */
  _failQueued(message) {
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) this._emit({ type: 'error', message, turnId: q.turnId });
  }

  // -------------------------------------------------------------------------------------------
  // stdout message handling

  /** @param {any} info @param {Record<string, any>} msg */
  _handleMessage(info, msg) {
    if (info !== this._procInfo) return; // late output from a detached process
    switch (msg.type) {
      case 'control_response':
        this._onControlResponse(msg);
        break;
      case 'control_request':
        this._onControlRequest(info, msg);
        break;
      case 'control_cancel_request':
        if (typeof msg.request_id === 'string') this._permissions.delete(msg.request_id);
        break;
      case 'system':
        if (msg.subtype === 'init') this._onInit(info, msg);
        break;
      case 'stream_event':
        this._onStreamEvent(msg);
        break;
      case 'assistant':
        this._onAssistant(msg);
        break;
      case 'user':
        this._onUser(msg);
        break;
      case 'result':
        this._onResult(info, msg);
        break;
      default:
        // rate_limit_event, active_goal, autocompact_state, keep_alive, … and future types.
        break;
    }
  }

  /** @param {Record<string, any>} msg */
  _onControlResponse(msg) {
    const resp = msg.response || {};
    const id = resp.request_id;
    const pending = typeof id === 'string' ? this._controls.get(id) : undefined;
    if (!pending) return;
    this._controls.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (resp.subtype === 'error') pending.reject(new Error(String(resp.error || `${pending.subtype} failed`)));
    else pending.resolve(resp.response);
  }

  /** @param {any} info @param {Record<string, any>} msg */
  _onControlRequest(info, msg) {
    const id = msg.request_id;
    const req = msg.request || {};
    if (typeof id !== 'string' || !id) return;
    if (req.subtype === 'mcp_message') {
      this._onMcpMessage(info, id, req);
      return;
    }
    if (req.subtype !== 'can_use_tool') {
      // We don't implement hooks etc.; answer so the CLI never hangs on us.
      this._write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `Unsupported control request: ${req.subtype}` } });
      return;
    }
    const input = isPlainObject(req.input) ? req.input : {};
    const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'unknown';
    const t = this._active;
    if (t && t.interrupted) {
      this._writePermissionResponse(id, { behavior: 'deny', message: 'The user interrupted this turn.' });
      return;
    }
    const description = typeof req.description === 'string' && req.description ? req.description : typeof req.title === 'string' ? req.title : '';
    this._permissions.set(id, { input, toolName, turnId: t ? t.turnId : null, info, description });
    /** @type {Record<string, any>} */
    const ev = { type: 'permission_request', turnId: t ? t.turnId : null, requestId: id, toolName, input };
    if (description) ev.description = description;
    this._emit(ev);
  }

  /**
   * A JSON-RPC message from the CLI to one of the app's in-process MCP servers (contract §10.1):
   * answered as soon as the server has, independently of turns, so a tool call never waits on
   * anything else. Notifications get the empty success the Agent SDK sends.
   * @param {any} info @param {string} id @param {Record<string, any>} req
   */
  _onMcpMessage(info, id, req) {
    const name = typeof req.server_name === 'string' ? req.server_name : '';
    const server = info.mcp && info.mcp.transport === 'sdk' ? info.mcp.servers.get(name) : undefined;
    const reply = (/** @type {Record<string, any>} */ response) => {
      // a process replaced in the meantime never sees an answer meant for its predecessor
      if (info !== this._procInfo || info.exited) return;
      this._write({ type: 'control_response', response });
    };
    if (!server) {
      reply({ subtype: 'error', request_id: id, error: `SDK MCP server not found: ${name}` });
      return;
    }
    const message = req.message;
    if (!isPlainObject(message)) {
      reply({ subtype: 'error', request_id: id, error: 'mcp_message without a JSON-RPC message' });
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '(response)';
    this._log('debug', `[claude] mcp ${name} ${method}${typeof message.params?.name === 'string' ? ` ${message.params.name}` : ''}`);
    Promise.resolve()
      .then(() => server.handle(message))
      .then(
        (result) => {
          if (method === 'tools/list' && result && isPlainObject(result) && 'result' in result) info.mcp.listed.add(name);
          reply({ subtype: 'success', request_id: id, response: { mcp_response: result ?? { jsonrpc: '2.0', result: {}, id: 0 } } });
        },
        (err) => {
          const text = err && err.message ? String(err.message) : String(err);
          this._log('warn', `[claude] mcp ${name} ${method} failed: ${text}`);
          reply({ subtype: 'error', request_id: id, error: text.slice(0, 500) });
        },
      );
  }

  /**
   * The CLI's system/init after it was offered in-process servers: when their tools are missing
   * (a CLI that ignores initialize.sdkMcpServers), switch this app session to the loopback HTTP
   * route and restart the CLI after the running turn (resuming the conversation). Decided once
   * per process; a server still 'pending' is looked at again on the next init.
   * @param {any} info @param {Record<string, any>} msg
   */
  _checkSdkMcp(info, msg) {
    const m = info.mcp;
    if (!m || m.transport !== 'sdk' || m.checked || !m.names.length || this._mcpTransport !== 'sdk') return;
    const tools = Array.isArray(msg.tools) ? msg.tools.filter((t) => typeof t === 'string') : [];
    const listed = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
    const statusOf = (/** @type {string} */ name) => listed.find((x) => x && x.name === name)?.status;
    const missing = m.names.filter((/** @type {string} */ n) => !tools.some((t) => t.startsWith(`mcp__${n}__`)));
    if (!missing.length) {
      m.checked = true;
      return;
    }
    if (missing.every((/** @type {string} */ n) => statusOf(n) === 'pending')) return;
    m.checked = true;
    const version = this._cli?.version || 'unknown version';
    if (missing.some((/** @type {string} */ n) => m.listed.has(n) || statusOf(n) === 'connected')) {
      // the server is connected but its tools are not offered: HTTP would not change that
      this._log('warn', `[claude] ${missing.join(', ')} connected, but the CLI (${version}) does not list its tools`);
      return;
    }
    if (!missing.every((/** @type {string} */ n) => typeof m.servers.get(n)?.startHttp === 'function')) {
      this._log('warn', `[claude] the CLI (${version}) did not take the in-process tools of ${missing.join(', ')}, and there is no HTTP fallback`);
      return;
    }
    this._log('warn', `[claude] the CLI (${version}) did not take the in-process tools of ${missing.join(', ')}; serving them over loopback HTTP from the next turn on`);
    this._mcpTransport = 'http';
    this.applySettings(); // the spawn key changed: restart after the running turn
  }

  /** @param {any} info @param {Record<string, any>} msg */
  _onInit(info, msg) {
    if (typeof msg.session_id === 'string' && msg.session_id) this._setSessionId(msg.session_id);
    if (typeof msg.model === 'string') this._model = msg.model;
    this._tools = Array.isArray(msg.tools) ? msg.tools.filter((x) => typeof x === 'string') : [];
    if (!this._cli?.version && typeof msg.claude_code_version === 'string' && this._cli) this._cli.version = msg.claude_code_version;
    this._checkSdkMcp(info, msg);
    const key = JSON.stringify([this._sessionId, this._model, this._tools]);
    if (key === info.lastSessionEvent) return; // the CLI repeats init on every turn
    info.lastSessionEvent = key;
    this._emit({ type: 'session', sessionId: this._sessionId, model: this._model, tools: [...this._tools] });
  }

  /** @param {Record<string, any>} msg */
  _onStreamEvent(msg) {
    const t = this._active;
    if (!t || msg.parent_tool_use_id) return; // ignore sub-agent streams
    const ev = msg.event || {};
    switch (ev.type) {
      case 'message_start':
        t.messageIndex++;
        t.messageOpen = true;
        if (ev.message && typeof ev.message.id === 'string') t.streamedIds.add(ev.message.id);
        break;
      case 'content_block_start': {
        const type = ev.content_block && ev.content_block.type;
        if (type === 'thinking' || type === 'redacted_thinking') this._thinking(t, ev.index);
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          t.messageOpen = true;
          this._emit({ type: 'text_delta', turnId: t.turnId, text: d.text });
        } else if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
          this._thinking(t, ev.index);
        }
        break;
      }
      case 'message_stop':
        if (t.messageOpen) {
          t.messageOpen = false;
          this._emit({ type: 'message_end', turnId: t.turnId });
        }
        break;
      default:
        break;
    }
  }

  /** @param {Turn} t @param {unknown} index */
  _thinking(t, index) {
    const key = `${t.messageIndex}:${index}`;
    if (t.thinkingKeys.has(key)) return;
    t.thinkingKeys.add(key);
    this._emit({ type: 'thinking', turnId: t.turnId });
  }

  /** @param {Record<string, any>} msg */
  _onAssistant(msg) {
    const t = this._active;
    if (!t || msg.parent_tool_use_id) return;
    const m = msg.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    const id = typeof m.id === 'string' ? m.id : '';
    // The CLI reports a missing login as a synthetic assistant message with an error field.
    if (typeof msg.error === 'string' && /auth|login|credential/i.test(msg.error)) {
      const said = blocks.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
      this._setProblem({ kind: 'auth', detail: firstLine(said) || msg.error });
    }
    // Text normally arrives as stream deltas; only messages that were never streamed (e.g.
    // synthetic API-error messages, or a CLI without partial messages) are forwarded here.
    const streamed = id !== '' && t.streamedIds.has(id);
    let emittedText = false;
    blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'tool_use' && typeof b.id === 'string' && !t.toolIds.has(b.id)) {
        t.toolIds.add(b.id);
        this._emit({ type: 'tool_use', turnId: t.turnId, id: b.id, name: String(b.name || ''), input: isPlainObject(b.input) ? b.input : {} });
      } else if (!streamed && b.type === 'text' && typeof b.text === 'string' && b.text) {
        this._emit({ type: 'text_delta', turnId: t.turnId, text: b.text });
        emittedText = true;
      } else if (!streamed && (b.type === 'thinking' || b.type === 'redacted_thinking')) {
        this._thinking(t, `a${id}:${i}`);
      }
    });
    if (!streamed && (emittedText || blocks.length) && !(id && t.endedIds.has(id))) {
      if (id) t.endedIds.add(id);
      t.messageOpen = false;
      this._emit({ type: 'message_end', turnId: t.turnId });
    }
  }

  /** @param {Record<string, any>} msg */
  _onUser(msg) {
    const t = this._active;
    if (!t || msg.parent_tool_use_id) return;
    const content = msg.message && msg.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      this._emit({
        type: 'tool_result',
        turnId: t.turnId,
        id: String(b.tool_use_id || ''),
        isError: b.is_error === true,
        summary: summarizeToolResult(b.content),
      });
    }
  }

  /** @param {any} info @param {Record<string, any>} msg */
  _onResult(info, msg) {
    if (typeof msg.session_id === 'string' && SAFE_SESSION_ID.test(msg.session_id)) this._setSessionId(msg.session_id);
    const errors = Array.isArray(msg.errors)
      ? msg.errors.filter((e) => typeof e === 'string' && !e.startsWith('[ede_diagnostic]'))
      : [];
    if (!this._active) {
      // e.g. the startup error result of a failed --resume.
      if (errors.length) info.lastErrorText = errors.join('\n');
      this._noteErrorText(errors.join('\n'));
      return;
    }
    const isError = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
    let result = typeof msg.result === 'string' ? msg.result : '';
    if (!result && isError && errors.length) result = errors.join('\n');
    // Before turn_end, so the renderer shows the login card instead of a generic error.
    if (isError && !this._active.interrupted) this._noteErrorText(`${result}\n${errors.join('\n')}`);
    else if (!isError && this._problem?.kind === 'auth') this._setProblem(null); // logged in after all
    this._failures = 0;
    this._endTurn({ result, isError, durationMs: finiteOrUndef(msg.duration_ms), costUsd: finiteOrUndef(msg.total_cost_usd) });
  }

  // -------------------------------------------------------------------------------------------
  // stdin helpers

  /** @param {Record<string, any>} obj */
  _write(obj) {
    const info = this._procInfo;
    const stdin = info && info.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(encodeJsonLine(obj));
      return true;
    } catch (err) {
      this._log('warn', `[claude] write failed: ${/** @type {Error} */ (err).message}`);
      return false;
    }
  }

  /** @param {string} requestId @param {Record<string, any>} response */
  _writePermissionResponse(requestId, response) {
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  /**
   * Send a control request; resolves with the response payload.
   * @param {Record<string, any>} request @param {number} timeoutMs 0 = no timeout
   */
  _sendControl(request, timeoutMs) {
    const id = `lm_${++this._controlCounter}_${randomBytes(4).toString('hex')}`;
    const info = this._procInfo;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this._controls.delete(id);
            reject(new Error(`${request.subtype} timed out after ${timeoutMs} ms`));
          }, timeoutMs)
        : null;
      this._controls.set(id, { resolve, reject, timer, info, subtype: String(request.subtype) });
      if (!this._write({ type: 'control_request', request_id: id, request })) {
        if (timer) clearTimeout(timer);
        this._controls.delete(id);
        reject(new Error('Claude CLI is not running'));
      }
    });
  }

  /** @param {any} info @param {Error} err */
  _rejectControls(info, err) {
    for (const [id, c] of this._controls) {
      if (c.info !== info) continue;
      this._controls.delete(id);
      if (c.timer) clearTimeout(c.timer);
      c.reject(err);
    }
  }

  // -------------------------------------------------------------------------------------------

  /** @param {string} id */
  _setSessionId(id) {
    if (id === this._sessionId) return;
    this._sessionId = id;
    try {
      this._onSessionId(id);
    } catch (err) {
      this._log('error', `[claude] onSessionId failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * CLI error output (an error result, stderr of a failed start, …): show the login card when it
   * says the user is not (or no longer) logged in. @param {string} text
   */
  _noteErrorText(text) {
    if (classifyClaudeError(text) !== 'auth') return;
    const line = String(text).split(/\r?\n/).find((l) => classifyClaudeError(l)) || text;
    this._setProblem({ kind: 'auth', detail: firstLine(line) });
  }

  /** @param {ClaudeProblem|null} problem */
  _setProblem(problem) {
    const prev = this._problem;
    if (!problem && !prev) return;
    if (problem && prev && problem.kind === prev.kind && problem.detail === prev.detail) return;
    this._problem = problem ? { kind: problem.kind, detail: String(problem.detail || '') } : null;
    if (problem) this._log('warn', `[claude] setup problem: ${problem.kind}: ${problem.detail}`);
    this._emit({ type: 'problem', problem: this._problem ? { ...this._problem } : null });
  }

  /** @param {'starting'|'ready'|'busy'|'restarting'|'exited'|'error'} status @param {string} [detail] */
  _setStatus(status, detail = '') {
    if (status === this._status && detail === this._statusDetail) return;
    this._status = status;
    this._statusDetail = detail;
    /** @type {Record<string, any>} */
    const ev = { type: 'status', status };
    if (detail) ev.detail = detail;
    this._emit(ev);
  }

  /** @param {Record<string, any>} ev */
  _emit(ev) {
    try {
      this.emit('event', ev);
    } catch (err) {
      this._log('error', `[claude] event listener threw: ${/** @type {Error} */ (err).stack || err}`);
    }
  }
}
