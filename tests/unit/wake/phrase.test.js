// Stage 2 and the transcript rules (contract-wake §8.6) on the texts the eval measured:
// Whisper's real outputs for stage-1 hits (eval.md §7.2) and the fixture sentences (§11.4).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENDERS, HEY_LIKE, JADE_LIKE, RIVAL, STOP_LISTENING, STOP_WORDS,
  confirmCall, decideCommand, normalize, selfTalk, stripCall, veto,
} from '../../../src/wake/phrase.js';

const HALLUCINATION = /^(?:thank you\.?|thanks for watching!?|thank you for watching!?|you\.?|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?)$/i;

describe('normalize', () => {
  it('lower-cases, keeps apostrophes (curly ones too) and splits on everything else', () => {
    expect(normalize('Hey, Jade!')).toEqual(['hey', 'jade']);
    expect(normalize('That’s all.')).toEqual(["that's", 'all']);
    expect(normalize('  hey-jade  what\'s up? ')).toEqual(['hey', 'jade', "what's", 'up']);
    expect(normalize('')).toEqual([]);
    expect(normalize(undefined)).toEqual([]);
  });

  it('word classes', () => {
    for (const w of ['jade', 'jaid', 'jayde', 'jada', 'gade', 'jades', 'jeid']) expect(JADE_LIKE.test(w), w).toBe(true);
    for (const w of ['jude', 'jay', 'jane', 'james', 'jaden', 'jed', 'jayden', 'jd']) expect(JADE_LIKE.test(w), w).toBe(false);
    for (const w of ['jude', 'judah', 'judy', 'jay', 'joey', 'jake', 'dave']) expect(RIVAL.test(w), w).toBe(true);
    for (const w of ['hey', 'hi', 'a', 'i', 'oh', 'hello']) expect(HEY_LIKE.test(w), w).toBe(true);
  });
});

describe('veto (the wake segment)', () => {
  /** [transcript, expected reason or 'ok'] */
  const FULL = [
    // the fixture positives (and Whisper's spellings of them)
    ['Hey Jade.', 'ok'],
    ['Hey Jade, what time is it?', 'ok'],
    ['Hey, Jade!', 'ok'],
    ['Hey Jade. What\'s the weather tomorrow?', 'ok'],
    ['Jade, what\'s on my calendar today?', 'ok'],
    ['hey jade stop', 'ok'],
    ['So, hey Jade, tell me a joke.', 'ok'],
    // Whisper's misreadings of a clean "Hey Jade." that the veto keeps (eval §0.1: 23 % of them)
    ['I enjoyed it.', 'ok'],
    ['Hey Jayden!', 'ok'],
    // rival names and the song
    ['Hey Jude.', 'jude'],
    ['Hey Jude, don\'t make it bad.', 'jude'],
    ['Hey Judah.', 'jude'],
    ['Hey Jay', 'rival'],
    ['Hey Jane!', 'rival'],
    ['Hey James', 'rival'],
    ['Hey Jake, how are you?', 'rival'],
    ['Hey, Jack.', 'rival'],
    ['Hey, Joey!', 'rival'],
    ['Hey Joe!', 'rival'],
    // her own lines
    ['My name is Jade, and I run on Claude.', 'self'],
    ['Jade here. What can I do for you?', 'self'],
    ['You can call me Jade.', 'self'],
    ['I\'m Jade, your holographic assistant.', 'self'],
    ['Jade is listening.', 'self'],
    ['Okay, Jade is on it.', 'self'],
    ['Say Jade and I\'ll listen.', 'self'],
    // not a call
    ['Just say hey Jade whenever you need me.', 'no-call'],
    ['AJ', 'no-call'],
    ['KJ', 'no-call'],
    ['She wore the jade necklace.', 'no-call'],
    ['so to speak. hey jane', 'no-call'],
    ['', 'empty'],
    ['...', 'empty'],
  ];

  it.each(FULL)('full: %j → %s', (text, want) => {
    const r = veto(text, 'full');
    expect(r.ok ? 'ok' : /** @type {any} */ (r).reason).toBe(want);
  });

  it('known limits, asserted so they are not fixed silently', () => {
    // the documented false accept of the eval (AGC mix, held-out): a hey-like first word
    expect(veto('I hope you enjoy it.').ok).toBe(true);
    // a "Hey Jay" clip Whisper wrote as "Hey JD": not a rival, starts with "hey"
    expect(veto('Hey JD').ok).toBe(true);
    // her allowed line with the name inside: stage 2 cannot tell, the text mask does (self-mask.js)
    expect(veto('Sure, Jade can help with that.').ok).toBe(true);
    // stage 1 does not fire on other assistants' names; if it did, stage 2 would let it through
    expect(veto('Hey Siri, set a timer.').ok).toBe(true);
  });

  it("'jude' (sensitivity More): only Jude and her own lines are rejected", () => {
    expect(veto('Hey Jay', 'jude').ok).toBe(true);
    expect(veto('AJ', 'jude').ok).toBe(true);
    expect(veto('Hey Jane!', 'jude').ok).toBe(true);
    expect(veto('Hey Jude.', 'jude')).toEqual({ ok: false, reason: 'jude' });
    expect(veto('Jade here.', 'jude')).toEqual({ ok: false, reason: 'self' });
    expect(veto('Okay Jade', 'jude')).toEqual({ ok: false, reason: 'self' });
    expect(veto('', 'jude')).toEqual({ ok: false, reason: 'empty' });
  });

  it('selfTalk looks at the first six words only; "Jade here/is/can" only at the start', () => {
    expect(selfTalk(normalize('you know my name is Jade'))).toBe(true);
    expect(selfTalk(normalize('one two three four five my name is Jade'))).toBe(false);
    expect(selfTalk(normalize('This is Jade, your assistant'))).toBe(true);
    expect(selfTalk(normalize('Jade again.'))).toBe(true);
    expect(selfTalk(normalize('Hey Jade, is it going to rain?'))).toBe(false);
    expect(selfTalk(normalize('Hey Jade, can you hear me?'))).toBe(false);
    expect(selfTalk(normalize('Jade can help with that'))).toBe(true);
    expect(selfTalk(normalize('just okay Jade'))).toBe(true);
  });

  it('every sentence of the committed wake fixtures (when present) gets the expected verdict', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const file = path.join(root, 'tests/fixtures/wake/manifest.tsv');
    if (!existsSync(file)) return; // lane A's fixtures; the texts are covered above
    const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    const header = rows[0][0] === 'id' ? rows.shift() : ['id', 'class', 'text'];
    const col = (r, name) => r[header.indexOf(name)];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const cls = col(r, 'class');
      const text = col(r, 'text');
      const v = veto(text);
      if (cls === 'pos' || cls === 'name' || cls === 'pause') expect(v.ok, `${cls}: ${text}`).toBe(true);
      if (cls === 'jude') expect(v, `${cls}: ${text}`).toEqual({ ok: false, reason: 'jude' });
      if (cls === 'selfbad') expect(v.ok, `${cls}: ${text}`).toBe(false);
    }
  });
});

describe('stripCall', () => {
  it.each([
    ['So, hey Jade, tell me a joke.', 'tell me a joke.'],
    ['Hey, Jade.', ''],
    ['hey hey jade stop', 'stop'],
    ['Jade, what\'s on my calendar today?', 'what\'s on my calendar today?'],
    ['Hey Jade what time is it', 'what time is it'],
    ['Hey Jade — read me the last three commits.', 'read me the last three commits.'],
    ['de, what time is it?', 'de, what time is it?'],
    ['What time is it?', 'What time is it?'],
    ['Hey Jude', 'Hey Jude'],
    ['jade.', ''],
    ['Hey Jade, play hey Jade by the radio', 'play hey Jade by the radio'],
  ])('%j → %j', (text, want) => {
    expect(stripCall(text)).toBe(want);
  });

  it('removes at most two words in front of the call', () => {
    expect(stripCall('one two hey Jade go')).toBe('go');
    expect(stripCall('one two three hey Jade go')).toBe('one two three hey Jade go');
  });
});

describe('ENDERS, STOP_WORDS, STOP_LISTENING', () => {
  it('match the whole (normalized) command', () => {
    for (const t of ['thanks', 'thank you', 'thanks jade', "that's all", 'no thanks', 'goodbye', 'bye', 'never mind', 'nevermind', 'nothing', 'forget it', 'stop']) expect(ENDERS.test(t), t).toBe(true);
    for (const t of ['thanks for the tip about the weather', 'stop the music', 'nothing much happened']) expect(ENDERS.test(t), t).toBe(false);
    for (const t of ['stop', 'cancel', 'be quiet', 'quiet', 'shut up', 'cancel that', 'stop talking', "that's enough"]) expect(STOP_WORDS.test(t), t).toBe(true);
    for (const t of ['stop listening', 'go to sleep', 'mic off', 'turn the mic off', 'turn microphone off']) expect(STOP_LISTENING.test(t), t).toBe(true);
    expect(STOP_WORDS.test('stop listening')).toBe(false);
  });
});

describe('decideCommand', () => {
  const cmd = (text, o = {}) => decideCommand(text, { kind: 'command', hallucination: HALLUCINATION, speechMs: 1200, ...o });

  it('sends the command with the call stripped (the interceptor gets "camera left")', () => {
    expect(cmd('what time is it?')).toEqual({ action: 'send', text: 'what time is it?' });
    expect(cmd('Jade, camera left.')).toEqual({ action: 'send', text: 'camera left.' });
    expect(cmd('So, hey Jade, tell me a joke.')).toEqual({ action: 'send', text: 'tell me a joke.' });
  });

  it('a capture that held only the end of her name or a noise keeps the command window open', () => {
    expect(cmd('')).toEqual({ action: 'again', reason: 'empty' });
    expect(cmd('Jade.')).toEqual({ action: 'again', reason: 'empty' });
    expect(cmd('Thank you.', { speechMs: 400 })).toEqual({ action: 'again', reason: 'empty' });
    // the same words with a real utterance behind them are an ender
    expect(cmd('Thank you.', { speechMs: 1800 })).toEqual({ action: 'end', reason: 'ender' });
  });

  it('follow-up and look captures drop silently instead', () => {
    expect(decideCommand('', { kind: 'followup' })).toEqual({ action: 'drop', reason: 'empty' });
    expect(decideCommand('you.', { kind: 'look', hallucination: HALLUCINATION, speechMs: 300 })).toEqual({ action: 'drop', reason: 'empty' });
    expect(decideCommand('And tomorrow?', { kind: 'followup' })).toEqual({ action: 'send', text: 'And tomorrow?' });
    expect(decideCommand('Hey Jade, and tomorrow?', { kind: 'followup' })).toEqual({ action: 'send', text: 'and tomorrow?' });
  });

  it('stop words interrupt only when something runs; enders close the window', () => {
    expect(cmd('stop', { turnRunning: true })).toEqual({ action: 'interrupt', reason: 'stop' });
    expect(cmd('Be quiet.', { turnRunning: true })).toEqual({ action: 'interrupt', reason: 'stop' });
    expect(cmd('never mind', { turnRunning: true })).toEqual({ action: 'interrupt', reason: 'stop' });
    expect(cmd('stop')).toEqual({ action: 'end', reason: 'ender' });
    expect(cmd('Cancel.')).toEqual({ action: 'end', reason: 'stop' });
    expect(cmd('Thanks, Jade.')).toEqual({ action: 'end', reason: 'ender' });
    expect(cmd("That's all.")).toEqual({ action: 'end', reason: 'ender' });
  });

  it('"stop listening" turns the wake word off; failed STT drops', () => {
    expect(cmd('Stop listening.')).toEqual({ action: 'local', run: 'stop-listening' });
    expect(cmd('turn the microphone off')).toEqual({ action: 'local', run: 'stop-listening' });
    expect(cmd('anything', { failed: true })).toEqual({ action: 'drop', reason: 'stt-failed' });
  });
});

describe('confirmCall (the transcript fallback)', () => {
  it('a greeting and her name at the start', () => {
    expect(confirmCall('Hey Jade, what time is it?')).toBe(true);
    expect(confirmCall('So hey Jade, tell me a joke')).toBe(true);
    expect(confirmCall('Hi Jade')).toBe(true);
    expect(confirmCall('Jade, what time is it?')).toBe(false);
    expect(confirmCall('Jade, what time is it?', 'jade')).toBe(true);
    expect(confirmCall('Hey Jude')).toBe(false);
    expect(confirmCall('I enjoyed it.')).toBe(false);
    expect(confirmCall('the weather is nice and hey jade')).toBe(false);
    expect(confirmCall('Jade here.', 'jade')).toBe(false);
  });
});
