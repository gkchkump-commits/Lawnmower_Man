// Jade (contract-wake §10.1): her name, what she runs on, that she is not human, and that she never
// says the words that wake her up, in every mode and with a custom persona; the "How the user calls
// you" section only while the wake word is on. Also the persona file ClaudeSession writes.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPersona, IDENTITY_RULES, PERSONA_VERSION, SPEECH_RULES, wakeSection } from '../../../electron/persona.js';
import { ClaudeSession } from '../../../electron/claude-session.js';

const MODES = /** @type {const} */ (['chat', 'assistant', 'agent']);
const NOW = new Date(2026, 9, 10, 12);
const WAKE_ON = { wake: { enabled: true, followUp: true, bargeIn: true } };
const CAMERA = { camera: { name: 'front door camera', canSee: true, canMove: true } };
/** Her name after a greeting, "okay" or "say": the phrases that wake her (eval.md §6.1). */
const FORBIDDEN = /\b(hey|hi|okay|ok|say)\W+jade\b/i;
const PROHIBITION = '- Never put a greeting, "okay" or "say" directly in front of your name';

/** @param {'chat'|'assistant'|'agent'} mode @param {object} [o] */
const persona = (mode, o = {}) => buildPersona(mode, { platform: 'win32', now: NOW, workdir: 'C:\\Users\\Ada\\LawnmowerMan', ...o });

/** Every combination of mode, custom persona and app context the app can produce. */
function* allPersonas() {
  for (const mode of MODES) {
    for (const custom of ['', 'You are a calm, precise lab assistant.']) {
      for (const context of [undefined, {}, CAMERA, WAKE_ON, { ...CAMERA, ...WAKE_ON }, { wake: { enabled: true, followUp: false, bargeIn: false } }]) {
        yield { mode, custom, context, text: persona(mode, { custom, context }) };
      }
    }
  }
}

describe('Jade: who she is, in every mode', () => {
  it('PERSONA_VERSION is 2 (Jade)', () => {
    expect(PERSONA_VERSION).toBe(2);
  });

  for (const mode of MODES) {
    it(`${mode}: her name is Jade, she runs on Claude by Anthropic and is not human`, () => {
      const p = persona(mode);
      expect(p).toContain('Your name is Jade.');
      expect(p).toMatch(/runs on Claude, an AI model made by Anthropic/);
      expect(p).toContain('You are not a human and never claim to be one');
      expect(p).toContain('never claim to be a different AI');
      expect(p).toContain('"Lawnmower Man" is the name of the app you appear in, not your name.');
      expect(p).toContain(IDENTITY_RULES);
      expect(p).toContain(SPEECH_RULES);
      // the character is never introduced as Claude or as "Lawnmower Man" any more
      expect(p).not.toMatch(/You are Claude\b/);
      expect(p).not.toMatch(/running as "Lawnmower Man"/);
    });

    it(`${mode}: a custom persona keeps the identity block (and the speech rules)`, () => {
      const p = persona(mode, { custom: 'You are Captain Nemo, a gruff submarine captain.' });
      expect(p).toContain('Captain Nemo');
      expect(p).toContain(IDENTITY_RULES);
      expect(p).toContain(SPEECH_RULES);
      expect(p).not.toMatch(/quietly witty/); // the built-in character is replaced
    });

    it(`${mode}: the wake-word section appears only while the wake word is on`, () => {
      expect(persona(mode)).not.toContain('How the user calls you');
      expect(persona(mode, { context: {} })).toBe(persona(mode));
      expect(persona(mode, { context: { wake: { enabled: false, followUp: true, bargeIn: true } } })).toBe(persona(mode));
      const on = persona(mode, { context: WAKE_ON });
      expect(on).toContain(wakeSection(WAKE_ON.wake));
      expect(on).toContain('the app removes that call before you see their message');
      expect(on).toContain('without your name');
      expect(on).toContain('interrupted you on purpose');
      const bare = persona(mode, { context: { wake: { enabled: true, followUp: false, bargeIn: false } } });
      expect(bare).toContain('How the user calls you');
      expect(bare).not.toContain('without your name');
      expect(bare).not.toContain('interrupted you on purpose');
    });
  }

  it('chat mode: character, identity, speech rules, capabilities, camera, wake, context, in that order', () => {
    const p = persona('chat', { context: { ...CAMERA, ...WAKE_ON } });
    expect(p.startsWith('You are Jade, a holographic desktop companion')).toBe(true);
    const at = (/** @type {string} */ s) => {
      const i = p.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [at('You are Jade'), at('Your name\n'), at('How your replies are delivered'), at('What you can and cannot do'), at('Home camera\n'), at('How the user calls you'), at('Context\n')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(p).toMatch(/Today's date is Saturday, October 10, 2026\. The user is on Windows\./);
  });

  it('assistant/agent: the preamble names Jade; identity follows the persona, wake comes before the working folder', () => {
    for (const mode of /** @type {const} */ (['assistant', 'agent'])) {
      const p = persona(mode, { context: { ...CAMERA, ...WAKE_ON } });
      expect(p.startsWith('You are currently running inside "Lawnmower Man", a holographic desktop avatar app, as Jade: your words are spoken aloud')).toBe(true);
      const order = ['Persona\n', 'Your name\n', 'How your replies are delivered', 'What you can and cannot do', 'Home camera\n', 'How the user calls you', 'Your working folder is'].map((s) => p.indexOf(s));
      expect(order.every((i) => i > 0), `${mode}: ${order}`).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

describe('Jade never models the words that wake her up', () => {
  it('no line of any built-in persona puts a greeting, okay or say in front of her name, except the quoted prohibition itself', () => {
    let checked = 0;
    for (const { mode, custom, context, text } of allPersonas()) {
      for (const line of text.split('\n')) {
        const where = `${mode}/${custom ? 'custom' : 'built-in'}/${JSON.stringify(context)}: ${line}`;
        if (line.startsWith(PROHIBITION)) {
          // the prohibition lists the phrases in quotes; outside the quotes it is clean too
          expect(line.replace(/"[^"]*"/g, '""'), where).not.toMatch(FORBIDDEN);
          expect(line).toContain('"hey Jade", "hi Jade", "okay Jade", "OK Jade" or "say Jade"');
        } else {
          expect(line, where).not.toMatch(FORBIDDEN);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('the prohibition is a single line, present once in every persona', () => {
    for (const { text } of allPersonas()) {
      expect(text.split('\n').filter((l) => l.startsWith(PROHIBITION))).toHaveLength(1);
    }
  });

  it('the pattern itself catches the phrases it is meant to (a guard for the structural check)', () => {
    for (const bad of ['Just say hey Jade whenever you need me.', 'Okay, Jade is on it.', 'Say Jade and I\'ll listen.', 'hi, jade', 'OK Jade']) expect(bad).toMatch(FORBIDDEN);
    for (const fine of ['Hi, I\'m Jade.', 'My name is Jade, and I run on Claude.', 'say hey, then my name', 'the jade necklace']) expect(fine).not.toMatch(FORBIDDEN);
  });

  it('she is told how to explain the wake word without saying it', () => {
    expect(IDENTITY_RULES).toContain('say hey, then my name');
    expect(wakeSection({ enabled: true })).toContain('tell them to say "hey" and then your name');
    expect(wakeSection({ enabled: true })).toContain('the app\'s settings show the exact words');
  });
});

describe('the persona file ClaudeSession writes (fake CLI)', () => {
  /** @type {Array<{ dir: string, session: ClaudeSession }>} */
  const made = [];
  afterEach(async () => {
    while (made.length) {
      const m = made.pop();
      await m.session.stop().catch(() => {});
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  /** @param {'chat'|'assistant'|'agent'} mode @param {object} context */
  async function personaFileFor(mode, context) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-jade-'));
    const logFile = path.join(dir, 'argv.jsonl');
    const settings = { cliPath: '', model: '', effort: '', mode, workdir: path.join(dir, 'work'), persona: '', resumeLastSession: false, lastSessionId: '' };
    const live = { context };
    const session = new ClaudeSession({
      getSettings: () => settings,
      personaDir: path.join(dir, 'persona'),
      cliPath: path.resolve('tests/fixtures/fake-claude.mjs'),
      env: { ...process.env, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE_DIR: path.join(dir, 'state') },
      restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
      log: () => {},
      getPersonaContext: () => live.context,
    });
    made.push({ dir, session });
    /** @type {any[]} */
    const events = [];
    session.on('event', (ev) => events.push(ev));
    const waitTurn = async (/** @type {string} */ turnId) => {
      const t0 = Date.now();
      while (!events.some((e) => e.type === 'turn_end' && e.turnId === turnId)) {
        if (Date.now() - t0 > 8000) throw new Error(`no turn_end: ${events.map((e) => e.type)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitTurn((await session.send('hello')).turnId);
    const read = () => {
      const runs = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const argv = runs.at(-1).argv;
      const flag = mode === 'chat' ? '--system-prompt-file' : '--append-system-prompt-file';
      return { runs: runs.length, text: fs.readFileSync(argv[argv.indexOf(flag) + 1], 'utf8') };
    };
    return { session, live, read, waitTurn, events };
  }

  it('chat and agent: Jade with the wake section; turning the wake word off rewrites the file after a restart', async () => {
    for (const mode of /** @type {const} */ (['chat', 'agent'])) {
      const h = await personaFileFor(mode, WAKE_ON);
      const first = h.read();
      expect(first.text).toContain('Your name is Jade.');
      expect(first.text).toContain('How the user calls you');
      h.live.context = {};
      h.session.applySettings(); // what main does on a settings change (syncClaudeTools)
      await h.waitTurn((await h.session.send('again')).turnId);
      const second = h.read();
      expect(second.runs).toBe(2); // the CLI restarted with the new persona
      expect(second.text).toContain('Your name is Jade.');
      expect(second.text).not.toContain('How the user calls you');
    }
  });
});
