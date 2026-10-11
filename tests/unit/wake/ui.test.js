// What "Hey Jade" shows (src/wake/ui.js, contract-wake §8.1, §4.2): the chip for every state,
// never colour alone (a slashed ear when the mic is off, blocked or muted), the drawer's info
// block with its action, and the wake log lines.
import { describe, expect, it } from 'vitest';
import { WAKE_STATES } from '../../../src/wake/machine.js';
import { WAKE_TEXT, badgeModel, chipModel, infoModel, logLine } from '../../../src/wake/ui.js';

describe('chipModel: one chip per state', () => {
  it('every state has a chip (off hides it)', () => {
    for (const state of WAKE_STATES) {
      const c = chipModel({ state });
      if (state === 'off') {
        expect(c.hidden).toBe(true);
        continue;
      }
      expect(c.hidden, state).toBe(false);
      expect(c.text.length, state).toBeGreaterThan(0);
      expect(['dim', 'on', 'warn', 'error']).toContain(c.tone);
    }
  });

  it('the texts of the contract (§8.1)', () => {
    expect(chipModel({ state: 'unavailable', code: 'no-voice' }).text).toBe('Hey Jade: needs the local voice');
    expect(chipModel({ state: 'unavailable', code: 'engine' }).text).toBe('Hey Jade: unavailable');
    expect(chipModel({ state: 'starting' }).text).toBe('Hey Jade: starting…');
    expect(chipModel({ state: 'muted' }).text).toBe('Microphone is muted');
    expect(chipModel({ state: 'waiting' })).toMatchObject({ text: 'Hey Jade', tone: 'dim', slashed: false });
  });

  it('slashed whenever the microphone is not listening for her (A11Y-4: not colour alone)', () => {
    for (const state of ['unavailable', 'paused', 'locked', 'blocked', 'muted']) expect(chipModel({ state }).slashed, state).toBe(true);
    for (const state of ['waiting', 'attention', 'listening', 'followup', 'look', 'busy', 'barge', 'starting']) expect(chipModel({ state }).slashed, state).toBe(false);
  });

  it('bright while she listens; the chip names why no key was needed (the label next to it says "Listening…")', () => {
    expect(chipModel({ state: 'listening' })).toMatchObject({ text: 'Hey Jade', tone: 'on' });
    expect(chipModel({ state: 'followup' })).toMatchObject({ text: 'Follow-up', tone: 'on' });
    expect(chipModel({ state: 'look' })).toMatchObject({ text: 'Look & talk', tone: 'on' });
    expect(chipModel({ state: 'attention' })).toMatchObject({ text: 'Hey Jade…', tone: 'on' });
    expect(chipModel({ state: 'barge' })).toMatchObject({ text: 'Hey Jade…', tone: 'on' });
  });

  it('the transcript check, the strict mode and a recording say so', () => {
    expect(chipModel({ state: 'waiting', fallback: true }).text).toBe('Hey Jade (transcript check)');
    expect(chipModel({ state: 'waiting', strict: true }).title).toMatch(/Stricter for a few minutes/);
    expect(chipModel({ state: 'waiting', recordingSec: 12.4 })).toMatchObject({ text: 'Recording test clip 0:12', tone: 'on' });
  });
});

describe('infoModel: the drawer line, its action, the notes', () => {
  it('no local voice: a short line (the voice block above has the reason) and "Set up local voice…"', () => {
    const i = infoModel({ state: 'unavailable', code: 'no-voice', reason: 'The local voice server is not running. Long explanation…' });
    expect(i.line).toBe('Hey Jade needs the local voice: it checks her name on this PC.');
    expect(i.tone).toBe('warn');
    expect(i.action).toEqual({ id: 'setupVoice', label: 'Set up local voice…' });
  });

  it('a missing engine shows its reason', () => {
    const i = infoModel({ state: 'unavailable', code: 'engine', reason: 'The wake-word engine is not installed; reinstall Lawnmower Man' });
    expect(i.line).toMatch(/not installed/);
    expect(i.action).toBeNull();
  });

  it('an engine that keeps stopping: Retry (main starts it again), where the log is, and no "basic model" note', () => {
    const i = infoModel({ state: 'unavailable', code: 'engine', engine: 'error', reason: 'The wake-word engine keeps stopping; see the log.', models: { zhen: 'missing', giga: 'ok' } });
    expect(i.action).toEqual({ id: 'wakeRestart', label: 'Retry' });
    expect(i.notes).toContain('Details: tray › Open logs');
    expect(i.notes.join(' ')).not.toMatch(/basic wake-word model/);
    // running on B alone: the note and the download are shown
    const b = infoModel({ state: 'waiting', models: { zhen: 'missing', giga: 'ok' } });
    expect(b.notes).toContain('Using the basic wake-word model');
    expect(b.action).toEqual({ id: 'wakeDownload', label: 'Download the extra wake-word model' });
  });

  it('blocked: Windows settings for a privacy block or a denial, Retry otherwise', () => {
    expect(infoModel({ state: 'blocked', code: 'os-blocked', reason: 'Windows is blocking the microphone for desktop apps' })).toMatchObject({
      line: 'Windows is blocking the microphone for desktop apps', tone: 'err', action: { id: 'wakeMicSettings', label: 'Open Windows microphone settings' },
    });
    expect(infoModel({ state: 'blocked', code: 'denied' }).action.id).toBe('wakeMicSettings');
    expect(infoModel({ state: 'blocked', code: 'in-use' }).action).toEqual({ id: 'wakeRetry', label: 'Retry' });
  });

  it('the echo canceller, the extra model, the echo test', () => {
    expect(infoModel({ state: 'waiting', echo: 'all' }).notes).toContain('Echo cancellation: all apps');
    expect(infoModel({ state: 'waiting', echo: 'app' }).notes[0]).toMatch(/this app/);
    expect(infoModel({ state: 'waiting', echo: 'off' }).notes).toContain('Echo cancellation: off');
    expect(infoModel({ state: 'waiting', models: { zhen: 'downloading' } }).notes).toContain('Using the basic wake-word model; the extra one is downloading');
    const failed = infoModel({ state: 'waiting', models: { zhen: 'failed' } });
    expect(failed.action).toEqual({ id: 'wakeDownload', label: 'Download the extra wake-word model' });
    expect(infoModel({ state: 'waiting', echoTesting: true }).notes).toContain('Testing the echo: listen…');
    expect(infoModel({ state: 'waiting', echoResult: WAKE_TEXT.echoGood }).notes).toContain(WAKE_TEXT.echoGood);
    // nothing about the mic while it is off
    expect(infoModel({ state: 'off', echo: 'all', models: { zhen: 'failed' } })).toMatchObject({ notes: [], action: null });
  });

  it('the log: newest first, local times, the latency when known', () => {
    const nowWall = new Date(2026, 9, 10, 9, 45, 0).getTime();
    const nowPerf = 1_000_000;
    const log = [
      { at: nowPerf - 4 * 60_000, outcome: 'woke', reason: 'woke', text: 'woke', latencyMs: 280 },
      { at: nowPerf - 2 * 60_000, outcome: 'ignored', reason: 'jude', text: 'ignored · sounded like “Hey Jude”' },
    ];
    expect(infoModel({ state: 'waiting', log, nowPerf, nowWall }).log).toEqual(['09:43 ignored · sounded like “Hey Jude”', '09:41 woke · 280 ms']);
    expect(logLine({ at: nowPerf, text: 'no command after 8 s' }, nowPerf, nowWall)).toBe('09:45 no command after 8 s');
  });
});

describe('the texts', () => {
  it('the offer says what the microphone does before you turn it on (§9.6)', () => {
    expect(WAKE_TEXT.offer).toMatch(/microphone stays on/);
    expect(WAKE_TEXT.offer).toMatch(/nothing is recorded or sent anywhere until you say my name/);
    expect(WAKE_TEXT.echoBad(1)).toMatch(/^I heard my own voice 1 time\./);
    expect(WAKE_TEXT.echoBad(3)).toMatch(/3 times/);
  });
});

describe('badgeModel: the always-visible microphone badge (outside the folding chat panel)', () => {
  it('shown exactly while the microphone is open for her name (slashed when muted or blocked); a click turns it off', () => {
    const shown = WAKE_STATES.filter((state) => !badgeModel({ state }).hidden);
    expect(shown.sort()).toEqual(['attention', 'barge', 'blocked', 'busy', 'followup', 'listening', 'look', 'muted', 'waiting']);
    for (const state of ['off', 'unavailable', 'starting', 'paused', 'locked']) expect(badgeModel({ state }).hidden, state).toBe(true);
    expect(badgeModel({ state: 'waiting' })).toMatchObject({ slashed: false, tone: 'dim' });
    expect(badgeModel({ state: 'listening' })).toMatchObject({ slashed: false, tone: 'on' });
    expect(badgeModel({ state: 'muted' })).toMatchObject({ slashed: true });
    expect(badgeModel({ state: 'blocked', reason: 'Windows is blocking the microphone' })).toMatchObject({ slashed: true, tone: 'error' });
    for (const state of shown) expect(badgeModel({ state }).title, state).toMatch(/turn “Hey Jade” off/);
  });

  it('"Recording test clip" only while the mic is tapped; "Cancel recording" in the drawer meanwhile', () => {
    expect(chipModel({ state: 'off', recordingSec: 5 }).text).not.toMatch(/Recording/);
    expect(chipModel({ state: 'waiting', recordingSec: 5 }).text).toBe('Recording test clip 0:05');
    expect(infoModel({ state: 'waiting', recordingSec: 5 }).action).toEqual({ id: 'wakeRecordCancel', label: 'Cancel recording' });
  });
});
