// Mock of the whole window.lawnmower contract (§3) for browser development and Playwright.
//
// claude.send() streams canned replies word by word (a greeting, a code example, a Markdown
// showcase, a long answer, otherwise an echo). Messages mentioning "run" or "tool" make the
// mock "use" Bash: tool_use + permission_request, then it waits for respondPermission().
// "simulate error" produces an error event and a failed turn. interrupt(), reset(), the turn
// queue and status/session events behave like electron/claude-session.js. Settings live in
// memory with change events; voice.info() reports 'disabled' unless ?voice=fake (an in-page
// fake voice server, see mock-voice.js) or ?voice=<http url>&voiceToken=<t> (a real one,
// e.g. `python -m lawnmower_voice --fake`). Window/app methods are recorded no-ops.
// First-run problems: ?claude=missing (no CLI: the setup card) or ?claude=auth (every turn
// fails with "Not logged in"); claude.retry() then "finds" a working CLI (after
// ?claudeRetries=N failed attempts). voice.setup() answers with the manual command, as main
// does when it cannot open a terminal.

import { DEFAULT_SETTINGS, clone, deepMerge, isPlainObject } from '../app/settings-defaults.js';
import { FAKE_HEALTH, createFakeVoiceFetch } from './mock-voice.js';

/**
 * @typedef {object} MockOptions
 * @property {number} [wordDelayMs]   delay between streamed words (default 28)
 * @property {number} [firstTokenMs]  delay before the first text (default 450)
 * @property {number} [startupMs]     delay before status 'ready' (default 250)
 * @property {'disabled'|'fake'|string} [voice]  'fake', an http URL, or disabled (default)
 * @property {string} [voiceToken]
 * @property {Record<string, any>} [settings]     initial settings patch
 * @property {string} [platform]
 * @property {'ok'|'missing'|'auth'} [claude]      simulate a missing / logged-out Claude CLI
 * @property {number} [claudeRetries]             retry() calls that still fail (default 0)
 */

export const MOCK_NOT_FOUND = 'Claude CLI not found. Install Claude Code (https://code.claude.com/docs/en/setup), sign in once by running "claude" in a terminal, or set the CLI path in Settings.';
export const MOCK_NOT_LOGGED_IN = 'Not logged in · Please run /login';

export const MOCK_REPLIES = Object.freeze({
  greeting: "Hello! I'm Claude, floating on your desktop as a hologram. You can type to me here, or hold Space and talk once the local voice server is installed. What shall we do?",
  code: "Sure, here's a small JavaScript helper that debounces a function:\n\n```js\nexport function debounce(fn, ms = 200) {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\nWrap a handler with `debounce(save, 500)` and it only runs after the input has been quiet for half a second.",
  markdown: "## Formatting check\n\nHere is **bold**, *italic*, ~~struck~~ and `inline code`, plus a [link](https://www.anthropic.com).\n\n- First item\n- Second item\n  - nested detail\n1. Step one\n2. Step two\n\n| Feature | Status |\n|---|---|\n| Streaming | works |\n| Voice | ready |\n\n> A quote, for good measure.",
  long: "Holograms work by recording how light from an object interferes with a reference beam. The interference pattern stores both the brightness and the direction of the light, so when the pattern is lit again, it rebuilds the original wavefront.\n\nThat is why a true hologram shows parallax: move your head and you see around the object. What you see on your desktop right now is a cheat, of course. It's a real-time rendering made to look like one, with a glowing wireframe, bloom and a cloud of particles.\n\nStill, it's a fun way to give a voice assistant a face.",
  error: 'Let me try that.',
  tool: "Sure, I'll run the tests for you.",
  toolAllowed: 'Done. All 42 tests passed in about three seconds.',
  toolDenied: "Okay, I won't run it. Let me know if you change your mind.",
});

/** @param {string} text */
export function pickScript(text) {
  const t = text.toLowerCase();
  if (/simulate (an )?error/.test(t)) return { kind: 'error', say: MOCK_REPLIES.error };
  if (/\b(run|tool|tools)\b/.test(t)) {
    return {
      kind: 'tool',
      say: MOCK_REPLIES.tool,
      tool: { name: 'Bash', input: { command: 'npm test -- --reporter=dot', description: 'Run the test suite' }, summary: '42 passing (3.1s)' },
      allowed: MOCK_REPLIES.toolAllowed,
      denied: MOCK_REPLIES.toolDenied,
    };
  }
  if (/\b(code|function|script|javascript|python|snippet)\b/.test(t)) return { kind: 'say', say: MOCK_REPLIES.code };
  if (/\b(markdown|list|table|format|formatting)\b/.test(t)) return { kind: 'say', say: MOCK_REPLIES.markdown };
  if (/\b(story|long|explain|holograms?)\b/.test(t)) return { kind: 'say', say: MOCK_REPLIES.long };
  if (/\b(hi|hello|hey|greetings|good (morning|evening|afternoon))\b/.test(t)) return { kind: 'say', say: MOCK_REPLIES.greeting };
  const quoted = text.length > 160 ? `${text.slice(0, 157)}…` : text;
  return {
    kind: 'say',
    say: `You said: “${quoted}”. I'm the mock bridge, so all I can do is echo. Start the desktop app to talk to the real Claude CLI.`,
  };
}

/**
 * Like electron/hotkeys.js, minus the OS: two actions on the same shortcut is a conflict.
 * @param {Record<string, string>} hotkeys
 * @returns {Array<{ name: string, accelerator: string, reason: string }>}
 */
export function mockHotkeyConflicts(hotkeys) {
  const seen = new Map();
  const out = [];
  for (const name of ['toggleListen', 'toggleChat', 'stopSpeaking']) {
    const acc = typeof hotkeys?.[name] === 'string' ? hotkeys[name] : '';
    if (!acc) continue;
    const key = acc.toLowerCase().split('+').map((p) => p.trim()).sort().join('+');
    if (seen.has(key)) out.push({ name, accelerator: acc, reason: `same as ${seen.get(key)}` });
    else seen.set(key, name);
  }
  return out;
}

/** Numeric settings are clamped like electron/settings.js does. */
const NUMBER_RANGES = /** @type {Record<string, [number, number]>} */ ({
  'voice.ttsSpeed': [0.5, 2],
  'avatar.particles': [0, 2],
  'avatar.bloom': [0, 2],
});

/**
 * Light validation of a settings patch against the defaults' shapes (the real store in
 * electron/settings.js validates fully).
 * @param {Record<string, any>} base @param {unknown} patch
 */
function sanitizePatch(base, patch) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!isPlainObject(patch)) return out;
  for (const [group, gp] of Object.entries(patch)) {
    if (!isPlainObject(gp) || !isPlainObject(base[group])) continue;
    for (const [k, v] of Object.entries(gp)) {
      if (!(k in base[group])) continue;
      const def = /** @type {any} */ (DEFAULT_SETTINGS)[group]?.[k];
      const ok = def === null ? v === null || isPlainObject(v) : typeof v === typeof def;
      if (!ok) continue;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      const range = NUMBER_RANGES[`${group}.${k}`];
      (out[group] ||= {})[k] = range ? Math.min(range[1], Math.max(range[0], v)) : v;
    }
  }
  return out;
}

/**
 * Create the mock bridge.
 * @param {MockOptions} [options]
 */
export function createMockBridge(options = {}) {
  const opt = {
    wordDelayMs: 28,
    firstTokenMs: 450,
    startupMs: 250,
    voice: 'disabled',
    voiceToken: '',
    platform: 'browser',
    claude: 'ok',
    claudeRetries: 0,
    ...options,
  };
  /** @type {Record<string, Set<Function>>} */
  const listeners = { claude: new Set(), voice: new Set(), settings: new Set(), hotkey: new Set() };
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  let settings = deepMerge(DEFAULT_SETTINGS, opt.settings || {});

  /** @param {keyof typeof listeners} kind @param {any} payload */
  const deliver = (kind, payload) => {
    for (const cb of [...listeners[kind]]) {
      try {
        cb(clone(payload));
      } catch (err) {
        console.error(`[mock] ${kind} listener threw`, err);
      }
    }
  };
  /** @param {keyof typeof listeners} kind @param {Function} cb */
  const subscribe = (kind, cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    listeners[kind].add(cb);
    return () => listeners[kind].delete(cb);
  };
  // IPC is asynchronous; keep event order but deliver after the current task.
  const outbox = [];
  let flushing = false;
  /** @param {any} ev */
  const emit = (ev) => {
    outbox.push(ev);
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => {
      while (outbox.length) deliver('claude', outbox.shift());
      flushing = false;
    });
  };

  // ---------------------------------------------------------------- claude session
  let status = 'starting';
  let statusDetail = 'Starting Claude (mock)…';
  let sessionId = '';
  let turnCounter = 0;
  let permCounter = 0;
  /** @type {Array<{ turnId: string, text: string }>} */
  const queue = [];
  /** @type {any} */
  let active = null;
  /** @type {Map<string, { turnId: string, input: any, resolve: (d: any) => void }>} */
  const permissions = new Map();

  const setStatus = (s, detail = '') => {
    if (s === status && detail === statusDetail) return;
    status = s;
    statusDetail = detail;
    emit(detail ? { type: 'status', status: s, detail } : { type: 'status', status: s });
  };
  const newSession = () => {
    sessionId = `mock-${Math.random().toString(36).slice(2, 10)}`;
    emit({ type: 'session', sessionId, model: 'claude-mock', tools: settings.claude.mode === 'chat' ? [] : ['Read', 'Glob', 'Grep', 'Bash'] });
  };
  let ready = false;
  /** 'ok' | 'missing' | 'auth' — the simulated state of the user's CLI */
  let cli = opt.claude === 'missing' || opt.claude === 'auth' ? opt.claude : 'ok';
  let retriesLeft = Math.max(0, Number(opt.claudeRetries) || 0);
  /** @type {{ kind: string, detail: string }|null} */
  let problem = null;
  /** @param {{ kind: string, detail: string }|null} p */
  const setProblem = (p) => {
    if (JSON.stringify(p) === JSON.stringify(problem)) return;
    problem = p ? { ...p } : null;
    emit({ type: 'problem', problem: problem ? { ...problem } : null });
  };
  const startTimer = setTimeout(() => {
    if (cli === 'missing') {
      setProblem({ kind: 'cli-missing', detail: MOCK_NOT_FOUND });
      setStatus('error', MOCK_NOT_FOUND);
      return;
    }
    ready = true;
    emit({ type: 'status', status: 'starting', detail: statusDetail });
    newSession();
    setStatus('ready');
    pump();
  }, opt.startupMs);

  function pump() {
    if (!ready || active) return;
    const next = queue.shift();
    if (!next) {
      setStatus('ready');
      return;
    }
    runTurn(next);
  }

  /** @param {{ turnId: string, text: string }} q */
  async function runTurn(q) {
    const t0 = Date.now();
    /** @type {any} */
    const turn = { turnId: q.turnId, interrupted: false, wake: () => {}, open: false, full: '' };
    turn.ended = new Promise((r) => { turn.resolveEnded = r; });
    active = turn;
    setStatus('busy');
    emit({ type: 'turn_start', turnId: turn.turnId, text: q.text });
    const sleep = (ms) => new Promise((r) => {
      if (turn.interrupted) { r(undefined); return; }
      const timer = setTimeout(r, ms);
      turn.wake = () => { clearTimeout(timer); r(undefined); };
    });
    const say = async (text) => {
      for (const tok of text.match(/\S+\s*|\s+/g) || []) {
        if (turn.interrupted) return;
        turn.open = true;
        turn.full += tok;
        emit({ type: 'text_delta', turnId: turn.turnId, text: tok });
        await sleep(opt.wordDelayMs * (0.6 + Math.random() * 0.8));
      }
    };
    const endMessage = () => {
      if (!turn.open) return;
      turn.open = false;
      emit({ type: 'message_end', turnId: turn.turnId });
    };

    if (cli === 'auth') {
      // like ClaudeSession with a logged-out CLI: the synthetic reply, the problem, a failed turn
      await sleep(Math.min(60, opt.firstTokenMs));
      emit({ type: 'text_delta', turnId: turn.turnId, text: MOCK_NOT_LOGGED_IN });
      emit({ type: 'message_end', turnId: turn.turnId });
      setProblem({ kind: 'auth', detail: MOCK_NOT_LOGGED_IN });
      emit({ type: 'turn_end', turnId: turn.turnId, result: MOCK_NOT_LOGGED_IN, isError: true, durationMs: Date.now() - t0, costUsd: 0, sessionId });
      active = null;
      turn.resolveEnded();
      pump();
      return;
    }
    if (problem && problem.kind === 'auth') setProblem(null);
    const script = pickScript(q.text);
    let isError = false;
    await sleep(opt.firstTokenMs * 0.5);
    if (!turn.interrupted) emit({ type: 'thinking', turnId: turn.turnId });
    await sleep(opt.firstTokenMs * 0.5);
    if (!turn.interrupted) await say(script.say);
    if (script.kind === 'tool' && !turn.interrupted) {
      endMessage();
      const toolId = `toolu_mock_${turnCounter}`;
      emit({ type: 'tool_use', turnId: turn.turnId, id: toolId, name: script.tool.name, input: script.tool.input });
      const requestId = `perm-${++permCounter}`;
      const decision = await new Promise((resolve) => {
        permissions.set(requestId, { turnId: turn.turnId, toolName: script.tool.name, input: script.tool.input, resolve });
        turn.wake = () => { permissions.delete(requestId); resolve({ behavior: 'deny', message: 'The user interrupted this turn.' }); };
        emit({ type: 'permission_request', turnId: turn.turnId, requestId, toolName: script.tool.name, input: script.tool.input, description: script.tool.input.description });
      });
      if (!turn.interrupted) {
        const allowed = decision && decision.behavior === 'allow';
        emit({ type: 'tool_result', turnId: turn.turnId, id: toolId, isError: !allowed, summary: allowed ? script.tool.summary : String(decision?.message || 'The user denied this action.') });
        await sleep(opt.firstTokenMs * 0.4);
        await say(allowed ? script.allowed : script.denied);
      }
    }
    if (script.kind === 'error' && !turn.interrupted) {
      endMessage();
      emit({ type: 'error', turnId: turn.turnId, message: 'Simulated failure: the mock Claude CLI stopped unexpectedly.' });
      isError = true;
    }
    endMessage();
    /** @type {Record<string, any>} */
    const ev = {
      type: 'turn_end',
      turnId: turn.turnId,
      result: isError ? '' : turn.full,
      isError,
      durationMs: Date.now() - t0,
      costUsd: 0,
      sessionId,
    };
    if (turn.interrupted) ev.interrupted = true;
    emit(ev);
    active = null;
    turn.resolveEnded();
    pump();
  }

  const claude = {
    /** @param {string} text */
    async send(text) {
      if (typeof text !== 'string') throw new TypeError('text must be a string');
      const clean = text.replace(/\r\n?/g, '\n');
      if (!clean.trim()) throw new Error('Message is empty');
      if (clean.length > 100000) throw new Error('Message is too long (max 100000 characters)');
      if (cli === 'missing') {
        setStatus('error', MOCK_NOT_FOUND);
        throw new Error(MOCK_NOT_FOUND);
      }
      const turnId = `turn-${++turnCounter}-${Date.now().toString(36)}`;
      queue.push({ turnId, text: clean });
      // like the real session: the turn may start (turn_start) before send() resolves
      pump();
      return { turnId };
    },
    /** Drop a queued turn (turn_cancelled) or interrupt it when it is running. @param {string} turnId */
    async cancel(turnId) {
      if (typeof turnId !== 'string' || !turnId) throw new TypeError('turnId must be a string');
      const i = queue.findIndex((q) => q.turnId === turnId);
      if (i >= 0) {
        queue.splice(i, 1);
        emit({ type: 'turn_cancelled', turnId });
        if (!active && ready) setStatus('ready');
        return { cancelled: true, interrupted: false };
      }
      if (active && active.turnId === turnId) {
        await claude.interrupt();
        return { cancelled: false, interrupted: true };
      }
      return { cancelled: false, interrupted: false };
    },
    async interrupt() {
      const t = active;
      if (!t) return;
      if (!t.interrupted) {
        t.interrupted = true;
        for (const [id, p] of permissions) {
          if (p.turnId === t.turnId) {
            permissions.delete(id);
            p.resolve({ behavior: 'deny', message: 'The user interrupted this turn.' });
          }
        }
        t.wake();
      }
      await t.ended;
    },
    async reset() {
      for (const q of queue.splice(0)) emit({ type: 'error', turnId: q.turnId, message: 'The conversation was reset before this message was sent.' });
      if (active) await claude.interrupt();
      permissions.clear();
      sessionId = '';
      emit({ type: 'session', sessionId: '', model: '', tools: [] });
      setStatus('restarting', 'Starting a new conversation…');
      await new Promise((r) => setTimeout(r, Math.min(200, opt.startupMs)));
      newSession();
      setStatus('ready');
    },
    /** Setup card "Retry": the mock "finds" a working CLI (after claudeRetries failures). */
    async retry() {
      calls.push(['claude.retry']);
      if (retriesLeft > 0) {
        retriesLeft--;
        await new Promise((r) => setTimeout(r, 30));
        if (cli === 'missing') throw new Error(MOCK_NOT_FOUND);
        return;
      }
      cli = 'ok';
      setProblem(null);
      setStatus('restarting', 'Checking the Claude CLI again…');
      await new Promise((r) => setTimeout(r, Math.min(150, opt.startupMs)));
      if (!sessionId) newSession();
      ready = true;
      setStatus('ready');
      pump();
    },
    /** @param {string} requestId @param {{ behavior: string, message?: string, updatedInput?: object }} decision */
    async respondPermission(requestId, decision) {
      if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId must be a string');
      const p = permissions.get(requestId);
      if (!p) throw new Error('Unknown or expired permission request');
      if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) throw new Error('decision.behavior must be "allow" or "deny"');
      permissions.delete(requestId);
      p.resolve(decision);
    },
    async status() {
      return {
        status,
        detail: statusDetail || undefined,
        sessionId: sessionId || undefined,
        model: 'claude-mock',
        busy: !!active,
        queue: queue.length,
        cliPath: cli === 'missing' ? undefined : '(mock)',
        cliVersion: cli === 'missing' ? undefined : 'mock',
        problem: problem ? { ...problem } : undefined,
        mode: settings.claude.mode,
        activeTurnId: active ? active.turnId : undefined,
        queuedTurnIds: queue.map((q) => q.turnId),
        pendingPermissions: [...permissions.entries()].map(([requestId, p]) => ({
          requestId, turnId: p.turnId, toolName: p.toolName || 'Bash', input: p.input, description: p.input?.description,
        })),
      };
    },
    /** @param {(ev: any) => void} cb */
    onEvent: (cb) => subscribe('claude', cb),
  };

  // ---------------------------------------------------------------- voice
  const voiceFetch = opt.voice === 'fake' ? createFakeVoiceFetch({ token: 'mock-token' }) : null;
  /** @type {Record<string, any>|null} the last voice.setup() answer (VoiceInfo.setup) */
  let voiceSetup = null;
  const voiceInfo = () => {
    const info = baseVoiceInfo();
    return voiceSetup ? { ...info, setup: { ...voiceSetup } } : info;
  };
  const baseVoiceInfo = () => {
    if (!settings.voice.enabled) return { status: 'disabled', detail: 'Local voice is turned off in Settings; using the system voice.' };
    if (opt.voice === 'fake') {
      return { status: 'ready', url: 'http://127.0.0.1:59999', token: 'mock-token', detail: 'Fake voice server (mock bridge)', health: clone(FAKE_HEALTH) };
    }
    if (typeof opt.voice === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(opt.voice)) {
      return { status: 'ready', url: opt.voice.replace(/\/$/, ''), token: opt.voiceToken || '', detail: 'External voice server (mock bridge)' };
    }
    return { status: 'disabled', installed: false, detail: 'The local voice server is not available in the browser preview.' };
  };
  let lastVoice = JSON.stringify(voiceInfo());
  const voiceChanged = () => {
    const now = JSON.stringify(voiceInfo());
    if (now === lastVoice) return;
    lastVoice = now;
    deliver('voice', voiceInfo());
  };

  const voice = {
    async info() {
      return voiceInfo();
    },
    async restart() {
      deliver('voice', { status: 'starting', detail: 'Restarting the voice server…' });
      setTimeout(() => deliver('voice', voiceInfo()), 300);
    },
    /** "Set up local voice…": a browser cannot open a terminal, so (like main without one) answer with the command. @param {{ cpu?: boolean }} [o] */
    async setup(o = {}) {
      calls.push(['voice.setup', o]);
      const win = opt.platform === 'win32';
      const cmd = win ? 'powershell -ExecutionPolicy Bypass -File scripts\\setup-voice.ps1' : 'bash scripts/setup-voice.sh';
      voiceSetup = {
        state: 'manual',
        mode: 'manual',
        cpu: !!o.cpu,
        command: o.cpu ? `${cmd} ${win ? '-Cpu' : '--cpu'}` : cmd,
        detail: 'The browser preview cannot open a terminal. Run this command in one, then choose Restart voice.',
      };
      queueMicrotask(() => deliver('voice', voiceInfo()));
      return { ...voiceSetup };
    },
    onStatus: (cb) => subscribe('voice', cb),
  };

  // ---------------------------------------------------------------- settings
  const settingsApi = {
    async get() {
      return clone(settings);
    },
    /** @param {unknown} patch */
    async set(patch) {
      const clean = sanitizePatch(settings, patch);
      const next = deepMerge(settings, clean);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        settings = next;
        queueMicrotask(() => {
          deliver('settings', settings);
          voiceChanged();
        });
      }
      return clone(settings);
    },
    onChange: (cb) => subscribe('settings', cb),
  };

  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };

  const bridge = {
    claude,
    voice,
    settings: settingsApi,
    window: {
      setIgnoreMouse: record('setIgnoreMouse'),
      setSizePreset: record('setSizePreset'),
      setAlwaysOnTop: record('setAlwaysOnTop'),
      minimize: record('minimize'),
      hide: record('hide'),
      quit: record('quit'),
    },
    onHotkey: (cb) => subscribe('hotkey', cb),
    app: {
      async info() {
        return {
          version: '0.1.0',
          platform: opt.platform,
          electron: '',
          chrome: (/Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent || '') || [])[1] || '',
          mock: true,
          layout: null,
          clickThroughSupported: false,
          hotkeyConflicts: mockHotkeyConflicts(settings.hotkeys),
        };
      },
    },
    /** Test/dev hooks (not part of the contract). */
    __mock: {
      calls,
      voiceFetch,
      /** @param {'toggleListen'|'stopSpeaking'|'toggleChat'} name */
      hotkey: (name) => deliver('hotkey', name),
      /** @param {any} ev */
      emitClaude: (ev) => emit(ev),
      /** @param {any} info */
      emitVoice: (info) => deliver('voice', info),
      settings: () => clone(settings),
      pendingPermissions: () => [...permissions.keys()],
      dispose: () => clearTimeout(startTimer),
    },
  };
  return bridge;
}
