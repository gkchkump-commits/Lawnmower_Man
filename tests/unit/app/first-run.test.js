// First-run renderer logic: setup-card models, the controller's handling of main's `problem`
// events, the mock bridge's simulations, and the system (Web Speech) voice choice.
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_DOCS, CLAUDE_INSTALL, claudeSetupModel, voiceManualModel } from '../../../src/app/setup-help.js';
import { DEFAULT_SETTINGS } from '../../../src/app/settings-defaults.js';
import { MOCK_NOT_FOUND, MOCK_NOT_LOGGED_IN, createMockBridge } from '../../../src/bridge/mock.js';
import { WebSpeechTTS } from '../../../src/speech/web-speech.js';
import { describeClaude } from '../../../src/ui/status.js';
import { Controller } from '../../../src/app/controller.js';
import { deepMerge } from '../../../src/app/settings-defaults.js';
import { fakeAvatar, fakeBridge, fakeMic, fakePlayer, fakeStt, fakeTts, fakeView } from './helpers.js';

/** @param {{ status?: object }} [o] */
function makeController(o = {}) {
  const bridge = fakeBridge();
  if (o.status) bridge.claude.status = async () => ({ busy: false, queue: 0, ...o.status });
  const view = fakeView();
  const controller = new Controller({ bridge, view, avatar: fakeAvatar(), player: fakePlayer(), tts: fakeTts(), stt: fakeStt(), mic: fakeMic(), settings: deepMerge(DEFAULT_SETTINGS, {}), sleepAfterMs: 0 });
  return { bridge, view, controller };
}

describe('setup card models', () => {
  it('missing CLI: the official installer for the platform first, the login step, Retry', () => {
    const win = claudeSetupModel({ kind: 'cli-missing', detail: 'Claude CLI not found.' }, 'win32');
    expect(win.title).toBe('Install Claude Code');
    expect(win.steps[0]).toMatchObject({ text: 'Open PowerShell and run:', command: 'irm https://claude.ai/install.ps1 | iex' });
    expect(win.steps[1].command).toBe('claude');
    expect(win.more.map((m) => m.command)).toEqual([
      'winget install Anthropic.ClaudeCode',
      'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
      'npm install -g @anthropic-ai/claude-code',
    ]);
    expect(win.retry).toBe(true);
    expect(win.link.url).toBe(CLAUDE_DOCS.setup);
    expect(win.note).toMatch(/never runs these commands/);
    expect(win.detail).toBe('Claude CLI not found.');

    const linux = claudeSetupModel({ kind: 'cli-missing' }, 'linux');
    expect(linux.steps[0].command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claudeSetupModel({ kind: 'cli-missing' }, 'darwin').more.map((m) => m.command)).toContain('brew install --cask claude-code');
    expect(claudeSetupModel({ kind: 'cli-missing' }, 'freebsd').steps[0].command).toBe(CLAUDE_INSTALL.linux[0].command);
  });

  it('not logged in: run claude, sign in, Retry; unknown kinds have no card', () => {
    const m = claudeSetupModel({ kind: 'auth', detail: MOCK_NOT_LOGGED_IN }, 'win32');
    expect(m.title).toBe('Sign in to Claude Code');
    expect(m.steps[0]).toMatchObject({ command: 'claude' });
    expect(m.note).toMatch(/ANTHROPIC_API_KEY/);
    expect(m.detail).toBe(MOCK_NOT_LOGGED_IN);
    expect(m.link.url).toBe(CLAUDE_DOCS.login);
    expect(claudeSetupModel({ kind: 'other' }, 'win32')).toBeNull();
    expect(claudeSetupModel(null, 'win32')).toBeNull();
  });

  it('manual voice setup shows the command, without Retry', () => {
    expect(voiceManualModel({ state: 'manual', command: 'bash scripts/setup-voice.sh --cpu' })).toMatchObject({ kind: 'voice-manual', retry: false, steps: [{ command: 'bash scripts/setup-voice.sh --cpu' }, {}] });
    expect(voiceManualModel({ state: 'running' })).toBeNull();
  });

  it('the status line says what is wrong', () => {
    expect(describeClaude({ status: 'error', problem: { kind: 'cli-missing', detail: 'x' } })).toMatchObject({ text: 'Claude not installed', tone: 'error' });
    expect(describeClaude({ status: 'ready', problem: { kind: 'auth', detail: 'y' } })).toMatchObject({ text: 'Claude: sign in', tone: 'warn', title: 'y' });
    expect(describeClaude({ status: 'ready' }).text).toBe('Claude');
  });
});

describe('controller: setup problems from main', () => {
  it('shows the card instead of duplicate error toasts, and hides it when fixed', async () => {
    const h = makeController();
    await h.controller.start();
    const toasts = () => h.view.calls.filter((c) => c[0] === 'toast');
    h.controller.handleClaudeEvent({ type: 'problem', problem: { kind: 'cli-missing', detail: MOCK_NOT_FOUND } });
    h.controller.handleClaudeEvent({ type: 'status', status: 'error', detail: MOCK_NOT_FOUND });
    expect(h.view.calls.filter((c) => c[0] === 'setClaudeProblem').at(-1)[1]).toEqual({ kind: 'cli-missing', detail: MOCK_NOT_FOUND });
    expect(toasts()).toEqual([]);
    expect(h.controller.claudeStatus.problem.kind).toBe('cli-missing');

    // a login problem: the failed turn gets no generic "Claude: …" toast
    h.controller.handleClaudeEvent({ type: 'problem', problem: { kind: 'auth', detail: MOCK_NOT_LOGGED_IN } });
    h.controller.handleClaudeEvent({ type: 'turn_start', turnId: 't1', text: 'hi' });
    h.controller.handleClaudeEvent({ type: 'text_delta', turnId: 't1', text: MOCK_NOT_LOGGED_IN });
    h.controller.handleClaudeEvent({ type: 'turn_end', turnId: 't1', result: MOCK_NOT_LOGGED_IN, isError: true });
    expect(toasts()).toEqual([]);

    h.controller.handleClaudeEvent({ type: 'problem', problem: null });
    expect(h.view.calls.filter((c) => c[0] === 'setClaudeProblem').at(-1)[1]).toBeNull();
    expect(h.controller.claudeProblem).toBeNull();
    // without a problem, errors toast as before
    h.controller.handleClaudeEvent({ type: 'turn_start', turnId: 't2', text: 'x' });
    h.controller.handleClaudeEvent({ type: 'turn_end', turnId: 't2', result: 'boom', isError: true });
    expect(toasts().at(-1)[1]).toMatch(/boom/);
  });

  it('picks the problem up from status() after a reload', async () => {
    const h = makeController({ status: { status: 'error', detail: MOCK_NOT_FOUND, problem: { kind: 'cli-missing', detail: MOCK_NOT_FOUND } } });
    await h.controller.start();
    expect(h.view.calls.filter((c) => c[0] === 'setClaudeProblem').at(-1)[1]).toEqual({ kind: 'cli-missing', detail: MOCK_NOT_FOUND });
    expect(h.view.calls.filter((c) => c[0] === 'toast')).toEqual([]);
  });
});

describe('mock bridge: first-run simulations', () => {
  const FAST = { wordDelayMs: 0, firstTokenMs: 5, startupMs: 5 };
  const collect = (b) => {
    const events = [];
    b.claude.onEvent((e) => events.push(e));
    return events;
  };
  const until = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('?claude=missing: problem + error status, send fails, retry finds the CLI (after N failures)', async () => {
    const b = createMockBridge({ ...FAST, claude: 'missing', claudeRetries: 1 });
    const events = collect(b);
    await until(() => events.some((e) => e.type === 'problem'));
    expect(events.find((e) => e.type === 'problem').problem).toEqual({ kind: 'cli-missing', detail: MOCK_NOT_FOUND });
    expect((await b.claude.status()).problem.kind).toBe('cli-missing');
    await expect(b.claude.send('hi')).rejects.toThrow(/not found/);
    await expect(b.claude.retry()).rejects.toThrow(/not found/);
    await b.claude.retry();
    expect((await b.claude.status())).toMatchObject({ status: 'ready', problem: undefined });
    await until(() => events.some((e) => e.type === 'problem' && e.problem === null));
    const { turnId } = await b.claude.send('hello');
    await until(() => events.some((e) => e.type === 'turn_end' && e.turnId === turnId));
    b.__mock.dispose();
  });

  it('?claude=auth: a turn fails with "Not logged in", the problem comes first; retry clears it', async () => {
    const b = createMockBridge({ ...FAST, claude: 'auth' });
    const events = collect(b);
    const { turnId } = await b.claude.send('hi');
    await until(() => events.some((e) => e.type === 'turn_end' && e.turnId === turnId));
    const iProblem = events.findIndex((e) => e.type === 'problem');
    const iEnd = events.findIndex((e) => e.type === 'turn_end');
    expect(iProblem).toBeGreaterThan(-1);
    expect(iProblem).toBeLessThan(iEnd);
    expect(events[iEnd]).toMatchObject({ isError: true, result: MOCK_NOT_LOGGED_IN });
    await b.claude.retry();
    const t2 = await b.claude.send('hello');
    await until(() => events.some((e) => e.type === 'turn_end' && e.turnId === t2.turnId));
    expect(events.filter((e) => e.type === 'turn_end').at(-1).isError).toBe(false);
    b.__mock.dispose();
  });

  it('voice.setup() answers with the manual command (no terminal in a browser) and reports it in voice info', async () => {
    const b = createMockBridge({ ...FAST, platform: 'win32' });
    const infos = [];
    b.voice.onStatus((i) => infos.push(i));
    const r = await b.voice.setup({ cpu: true });
    expect(r).toMatchObject({ state: 'manual', cpu: true, command: 'powershell -ExecutionPolicy Bypass -File scripts\\setup-voice.ps1 -Cpu' });
    await until(() => infos.length > 0);
    expect(infos.at(-1).setup.state).toBe('manual');
    expect((await b.voice.info()).setup.command).toContain('setup-voice.ps1');
    expect(b.__mock.calls).toContainEqual(['voice.setup', { cpu: true }]);
    b.__mock.dispose();
  });

  it('accepts voice.systemVoice like the main store', async () => {
    expect(DEFAULT_SETTINGS.voice.systemVoice).toBe('');
    const b = createMockBridge(FAST);
    const s = await b.settings.set({ voice: { systemVoice: 'Microsoft Aria Online (Natural) - English (United States)' } });
    expect(s.voice.systemVoice).toBe('Microsoft Aria Online (Natural) - English (United States)');
    expect((await b.settings.set({ voice: { systemVoice: 42 } })).voice.systemVoice).toBe('Microsoft Aria Online (Natural) - English (United States)');
    b.__mock.dispose();
  });
});

describe('system voice (Web Speech)', () => {
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'david-uri', localService: true },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'aria-uri' },
    { name: 'Microsoft Hedda - German (Germany)', lang: 'de-DE', voiceURI: 'hedda-uri' },
    { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'Google UK English Female' },
  ];
  /** A synth whose voices arrive later (voiceschanged), like Chromium. */
  const lateSynth = () => {
    const listeners = new Set();
    let list = [];
    return {
      getVoices: () => list,
      addEventListener: (t, cb) => listeners.add(cb),
      removeEventListener: (t, cb) => listeners.delete(cb),
      arrive(v) {
        list = v;
        for (const cb of [...listeners]) cb();
      },
    };
  };

  it('lists every voice, best match first, and tells listeners when voices change', async () => {
    const synth = lateSynth();
    const ws = new WebSpeechTTS({ synth: /** @type {any} */ (synth), Utterance: /** @type {any} */ (class {}) });
    const changed = vi.fn();
    ws.onVoicesChanged(changed);
    const ready = ws.init(1000);
    expect(ws.allVoices()).toEqual([]);
    synth.arrive(voices);
    expect(await ready).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toHaveBeenCalled();
    expect(ws.allVoices().map((v) => v.id)).toEqual(['aria-uri', 'Google UK English Female', 'david-uri', 'hedda-uri']);
    expect(ws.voice.name).toMatch(/Aria/);
    synth.arrive([...voices, { name: 'New Voice', lang: 'en-US', voiceURI: 'new' }]);
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses the chosen voice (by URI or name, any language) and falls back when it is gone', async () => {
    const synth = lateSynth();
    synth.arrive(voices);
    const ws = new WebSpeechTTS({ synth: /** @type {any} */ (synth), Utterance: /** @type {any} */ (class {}) });
    await ws.init(10);
    ws.setPreferred('david-uri');
    expect(ws.voice.name).toMatch(/David/);
    expect(ws.preferredMissing).toBe(false);
    ws.setPreferred('Microsoft Hedda - German (Germany)');
    expect(ws.voice.lang).toBe('de-DE');
    ws.setPreferred('gone-uri');
    expect(ws.voice.name).toMatch(/Aria/);
    expect(ws.preferredMissing).toBe(true);
    ws.setPreferred('');
    expect(ws.preferredMissing).toBe(false);
    expect(ws.voice.name).toMatch(/Aria/);
  });
});
