// The listening state machine (contract-wake §8.3), transition by transition, on a fake clock.
// IDs in brackets are the rules of ux.md.
import { describe, expect, it } from 'vitest';
import { HINTS, SPOKEN, WAKE, WakeMachine } from '../../../src/wake/machine.js';

const HALLUCINATION = /^(?:thank you\.?|thanks for watching!?|thank you for watching!?|you\.?|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?)$/i;
const SR = 16000;

function harness(settings = {}, o = {}) {
  let t = 1000;
  const m = new WakeMachine({ now: () => t, hallucination: HALLUCINATION, settings: { enabled: true, ...settings } });
  const all = [];
  const step = (input) => {
    const a = m.step(input);
    all.push(...a);
    return a;
  };
  const h = {
    m,
    all,
    step,
    get t() { return t; },
    /** advance the clock and tick */
    advance(ms) {
      t += ms;
      return step({ type: 'tick' });
    },
    /** local voice ready, engine ready, mic open */
    ready() {
      step({ type: 'availability', stt: 'ready', engine: 'ready', device: o.device === undefined ? 'cuda' : o.device });
      return step({ type: 'micOk', echo: o.echo ?? 'all', label: o.label ?? 'Microphone Array (Realtek(R) Audio)' });
    },
    /** a stage-1 hit whose keyword ends at sample `endAt` */
    hit(extra = {}) {
      const endAt = extra.endAt ?? 160000;
      return step({ type: 'hit', id: extra.id ?? 'w1', keyword: 'HEY_JADE', model: 'giga', streamAt: endAt - 22000, startAt: endAt - 9000, endAt, ...extra });
    },
    meta(kind = 'command') {
      return { wakeId: m.active?.id, kind };
    },
  };
  return h;
}
const types = (acts) => acts.map((a) => a.type);
const of = (acts, type) => acts.filter((a) => a.type === type);
const one = (acts, type) => acts.find((a) => a.type === type);

describe('T1 enable: the state follows what is available (§2.4)', () => {
  it('off → no local voice → starting → engine → waiting with the mic open', () => {
    const h = harness({ enabled: false });
    h.step({ type: 'tick' });
    expect(h.m.state).toBe('off');
    expect(types(h.all)).not.toContain('openMic');
    h.step({ type: 'settings', wake: { enabled: true } });
    expect(h.m.state).toBe('unavailable');
    expect(h.m.code).toBe('no-voice');
    h.step({ type: 'availability', stt: 'starting', sttReason: 'The voice server is starting…' });
    expect(h.m.state).toBe('starting');
    h.step({ type: 'availability', stt: 'ready', engine: 'starting' });
    expect(h.m.state).toBe('starting');
    expect(h.m.reason).toMatch(/engine is starting/);
    expect(types(h.all)).not.toContain('openMic'); // the mic stays closed until it can be used
    const a = h.step({ type: 'availability', engine: 'ready' });
    expect(one(a, 'openMic')).toEqual({ type: 'openMic', echo: 'all' });
    expect(h.m.state).toBe('starting');
    expect(h.m.reason).toBe('Opening the microphone');
    h.step({ type: 'micOk', echo: 'all' });
    expect(h.m.state).toBe('waiting');
    expect(h.m.running).toBe(true);
    expect(one(h.all.filter((x) => x.type === 'report').reverse(), 'report')).toMatchObject({ state: 'waiting' });
  });

  it('a missing engine: unavailable with its detail, or the transcript check if the user turned it on', () => {
    const h = harness();
    h.step({ type: 'availability', stt: 'ready', engine: 'missing', engineDetail: 'The wake-word engine is not installed; reinstall Lawnmower Man' });
    expect(h.m.state).toBe('unavailable');
    expect(h.m.reason).toMatch(/not installed/);
    h.step({ type: 'settings', wake: { transcriptFallback: true } });
    expect(h.m.state).toBe('waiting');
    expect(h.m.fallback).toBe(true);
    expect(types(h.all)).not.toContain('openMic'); // the controller's hands-free VAD owns the mic
  });

  it('turning it off releases the mic, with the micOff earcon once (PRIV-5)', () => {
    const h = harness();
    h.ready();
    const a = h.step({ type: 'settings', wake: { enabled: false } });
    expect(types(a)).toEqual(expect.arrayContaining(['earcon', 'releaseMic', 'announce']));
    expect(one(a, 'earcon').name).toBe('micOff');
    expect(h.m.state).toBe('off');
    expect(of(h.step({ type: 'settings', wake: { enabled: false } }), 'earcon')).toEqual([]);
  });

  it('main says the engine is off a moment before the setting arrives: the micOff earcon still plays', () => {
    const h = harness();
    h.ready();
    const a = h.step({ type: 'availability', engine: 'off' });
    expect(types(a)).toContain('releaseMic');
    expect(h.m.state).toBe('starting');
    h.advance(200);
    const b = h.step({ type: 'settings', wake: { enabled: false } });
    expect(one(b, 'earcon').name).toBe('micOff');
    expect(h.m.state).toBe('off');
    // but not when it had not been listening for a while
    const k = harness();
    k.ready();
    k.step({ type: 'availability', engine: 'off' });
    k.advance(5000);
    expect(of(k.step({ type: 'settings', wake: { enabled: false } }), 'earcon')).toEqual([]);
  });
});

describe('T2-T5 a wake: attention, then listening or back to waiting', () => {
  it('T2: a hit → attention: capture from the keyword end + 150 ms, the wake segment to /stt, she looks up (ACK-1)', () => {
    const h = harness();
    h.ready();
    const a = h.hit({ endAt: 160000 });
    expect(h.m.state).toBe('attention');
    const cap = one(a, 'capture');
    expect(cap).toMatchObject({ kind: 'command', fromSample: 160000 + 0.15 * SR, noSpeechMs: 8000, show: true });
    expect(cap.meta).toEqual({ wakeId: 'w1', kind: 'command' });
    expect(one(a, 'verify')).toEqual({ type: 'verify', id: 'w1', from: 160000 - 22000, to: 162400, keyword: 'HEY_JADE' });
    expect(types(a)).toEqual(expect.arrayContaining(['resetDetector', 'gaze', 'fastWake']));
    // no sound at stage 1 (ACK-1)
    expect(of(a, 'earcon')).toEqual([]);
  });

  it('the wake segment is at most 2.5 s before the end of "Jade"', () => {
    const h = harness();
    h.ready();
    const a = h.hit({ endAt: 200000, streamAt: 100000 });
    expect(one(a, 'verify').from).toBe(200000 - 2.5 * SR);
  });

  it('a hit masked by her own voice changes nothing and is logged (SELF-2)', () => {
    const h = harness();
    h.ready();
    const a = h.hit({ masked: 'self' });
    expect(h.m.state).toBe('waiting');
    expect(types(a).filter((x) => x !== 'report')).toEqual([]);
    expect(h.m.log.at(-1)).toMatchObject({ outcome: 'ignored', reason: 'self', text: 'ignored · my own voice' });
    h.hit({ masked: 'system' });
    expect(h.m.log.at(-1).reason).toBe('system');
  });

  it('T3: a HEY_JUDE label stays waiting and counts toward the media-burst rule', () => {
    const h = harness();
    h.ready();
    const a = h.hit({ keyword: 'HEY_JUDE' });
    expect(h.m.state).toBe('waiting');
    expect(of(a, 'capture')).toEqual([]);
    expect(h.m.log.at(-1).text).toBe('ignored · sounded like “Hey Jude”');
    expect(h.m.burst).toHaveLength(1);
  });

  it('T4: accept → listening with exactly one wake earcon (ACK-2)', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.advance(300);
    const a = h.step({ type: 'verified', id: 'w1', ok: true, latencyMs: 280 });
    expect(h.m.state).toBe('listening');
    expect(of(a, 'earcon')).toEqual([{ type: 'earcon', name: 'wake' }]);
    expect(types(a)).toEqual(expect.arrayContaining(['noteActivity', 'showWindow', 'announce']));
    expect(h.m.log.at(-1)).toMatchObject({ outcome: 'woke', latencyMs: 280 });
  });

  it('a capture whose end never arrives is ended by the watchdog (never stuck "listening")', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.step({ type: 'verified', id: 'w1', ok: true });
    expect(h.m.state).toBe('listening');
    // the mic's own 8 s no-speech end is lost (nothing calls captureNoSpeech)
    expect(h.m.nextDeadline()).toBe(1000 + WAKE.commandWindowMs + WAKE.captureGraceMs);
    h.advance(WAKE.commandWindowMs + WAKE.captureGraceMs - 1);
    expect(h.m.state).toBe('listening');
    const a = h.advance(1);
    expect(h.m.state).toBe('waiting');
    expect(one(a, 'cancelCapture')).toEqual({ type: 'cancelCapture', meta: { wakeId: 'w1' } });
    expect(h.m.log.at(-1).text).toBe('no command after 8 s');
    // a capture that heard speech is left to the controller
    const k = harness();
    k.ready();
    k.hit();
    k.step({ type: 'verified', id: 'w1', ok: true });
    k.step({ type: 'speechStart' });
    k.advance(WAKE.commandWindowMs + WAKE.captureGraceMs + 5000);
    expect(k.m.state).toBe('listening');
  });

  it("T4: no earcon with sounds 'off'", () => {
    const h = harness({ sounds: 'off' });
    h.ready();
    h.hit();
    expect(of(h.step({ type: 'verified', id: 'w1', ok: true }), 'earcon')).toEqual([]);
  });

  it('T5: reject → waiting at once: the capture is cancelled, no sound, no message (ACK-3)', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.advance(250);
    const a = h.step({ type: 'verified', id: 'w1', ok: false, reason: 'jude' });
    expect(h.m.state).toBe('waiting');
    expect(one(a, 'cancelCapture')).toEqual({ type: 'cancelCapture', meta: { wakeId: 'w1' } });
    for (const t of ['earcon', 'say', 'decision', 'hint']) expect(of(a, t), t).toEqual([]);
    expect(h.m.log.at(-1).text).toBe('ignored · sounded like “Hey Jude”');
    // a stale verdict changes nothing
    expect(types(h.step({ type: 'verified', id: 'w1', ok: true }))).toEqual([]);
  });

  it('T5: no verdict within 2.5 s (GPU) is a reject; 8 s on the CPU', () => {
    const h = harness();
    h.ready();
    h.hit();
    expect(h.m.nextDeadline()).toBe(h.t + 2500);
    h.advance(2499);
    expect(h.m.state).toBe('attention');
    const a = h.advance(1);
    expect(h.m.state).toBe('waiting');
    expect(types(a)).toContain('cancelCapture');
    expect(h.m.log.at(-1).reason).toBe('timeout');
    const c = harness({}, { device: 'cpu' });
    c.ready();
    c.hit();
    expect(c.m.nextDeadline() - c.t).toBe(WAKE.verifyTimeoutMs.cpu);
  });

  it('TV-3, ACK-8: 3 rejected fires in 60 s → strict for 5 min, and no attention cue meanwhile', () => {
    const h = harness();
    h.ready();
    h.hit({ keyword: 'HEY_JUDE' });
    h.advance(10_000);
    h.hit({ keyword: 'HEY_JUDE' });
    h.advance(10_000);
    const a = h.hit({ keyword: 'HEY_JUDE' });
    expect(one(a, 'setStrict')).toEqual({ type: 'setStrict', on: true });
    expect(h.m.strict).toBe(true);
    expect(one(a, 'report')).toMatchObject({ strict: true });
    // the next wake is verified without showing it
    const b = h.hit({ id: 'w9' });
    expect(one(b, 'capture').show).toBe(false);
    expect(types(b)).not.toContain('gaze');
    expect(h.m.state).toBe('waiting'); // hidden attention
    const c = h.step({ type: 'verified', id: 'w9', ok: true });
    expect(types(c)).toContain('show'); // shown once verified
    expect(h.m.state).toBe('listening');
    h.step({ type: 'captureNoSpeech', meta: { wakeId: 'w9' } });
    // strict ends 5 min after it began
    const d = h.advance(5 * 60_000);
    expect(one(d, 'setStrict')).toEqual({ type: 'setStrict', on: false });
  });

  it('two rejects spread over more than 60 s do not make it strict', () => {
    const h = harness();
    h.ready();
    h.hit({ keyword: 'HEY_JUDE' });
    h.advance(40_000);
    h.hit({ keyword: 'HEY_JUDE' });
    h.advance(40_000);
    h.hit({ keyword: 'HEY_JUDE' });
    expect(h.m.strict).toBe(false);
  });
});

describe('T6-T8 the command', () => {
  /** a verified wake, listening */
  const listening = (settings) => {
    const h = harness(settings);
    h.ready();
    h.hit();
    h.step({ type: 'verified', id: 'w1', ok: true });
    return h;
  };

  it('T7: the command is sent, with the call stripped; busy follows', () => {
    const h = listening();
    h.step({ type: 'captured', meta: h.meta() });
    expect(h.m.state).toBe('busy');
    const a = h.step({ type: 'utterance', meta: { wakeId: 'w1', kind: 'command' }, text: 'Jade, what time is it?', speechMs: 1400 });
    expect(one(a, 'decision')).toEqual({ type: 'decision', id: 'w1', decision: { action: 'send', text: 'what time is it?' } });
    expect(h.m.active).toBeNull();
    h.step({ type: 'conversation', state: 'thinking' });
    expect(h.m.state).toBe('busy');
  });

  it('T6: an utterance that arrives before the verdict waits for it; accept sends it, without the chime (ACK-4)', () => {
    const h = harness();
    h.ready();
    h.hit();
    const held = h.step({ type: 'utterance', meta: { wakeId: 'w1', kind: 'command' }, text: 'what time is it?', speechMs: 1400 });
    expect(of(held, 'decision')).toEqual([]);
    const a = h.step({ type: 'verified', id: 'w1', ok: true });
    expect(one(a, 'decision').decision).toEqual({ action: 'send', text: 'what time is it?' });
    expect(of(a, 'earcon')).toEqual([]);
  });

  it('T6: …and a reject drops it', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.step({ type: 'utterance', meta: { wakeId: 'w1', kind: 'command' }, text: "don't make it bad", speechMs: 1400 });
    const a = h.step({ type: 'verified', id: 'w1', ok: false, reason: 'jude' });
    expect(one(a, 'decision').decision).toEqual({ action: 'drop', reason: 'jude' });
    expect(of(a, 'cancelCapture')).toEqual([]); // the capture had already ended
  });

  it('T7: "stop" while a turn runs → interrupt (BRG-4); with nothing running it only closes', () => {
    const h = listening();
    h.step({ type: 'conversation', state: 'listening', turnRunning: true });
    expect(one(h.step({ type: 'utterance', meta: h.meta(), text: 'Stop.', speechMs: 600 }), 'decision').decision.action).toBe('interrupt');
    const k = listening();
    expect(one(k.step({ type: 'utterance', meta: k.meta(), text: 'Stop.', speechMs: 600 }), 'decision').decision.action).toBe('end');
  });

  it("T7: an ender closes the window ('done' earcon with Start + end)", () => {
    const h = listening({ sounds: 'start-end' });
    const a = h.step({ type: 'utterance', meta: h.meta(), text: 'Never mind.', speechMs: 700 });
    expect(one(a, 'decision').decision).toEqual({ action: 'end', reason: 'ender' });
    expect(of(a, 'earcon')).toEqual([{ type: 'earcon', name: 'done' }]);
    expect(h.m.state).toBe('waiting');
  });

  it('T7: "stop listening" turns the wake word off and says how to turn it back on (PRIV-5)', () => {
    const h = listening();
    const a = h.step({ type: 'utterance', meta: h.meta(), text: 'Stop listening.', speechMs: 800 });
    expect(one(a, 'decision').decision).toEqual({ action: 'local', run: 'stop-listening' });
    expect(types(a)).toContain('disable');
    expect(one(a, 'say')).toMatchObject({ text: SPOKEN.stopped });
  });

  it('T7: a capture that held only "-de" keeps listening for the rest of the 8 s (END-2)', () => {
    const h = listening();
    h.advance(1500);
    const a = h.step({ type: 'utterance', meta: h.meta(), text: 'Jade.', speechMs: 300 });
    const cap = one(a, 'capture');
    expect(cap.kind).toBe('command');
    expect(cap.noSpeechMs).toBeGreaterThan(6000);
    expect(cap.noSpeechMs).toBeLessThanOrEqual(8000);
    expect(one(a, 'decision').decision.action).toBe('again');
    expect(h.m.state).toBe('listening');
    // the second part is the command
    expect(one(h.step({ type: 'utterance', meta: h.meta(), text: 'What is the weather tomorrow?', speechMs: 1500 }), 'decision').decision.action).toBe('send');
  });

  it('T7: with almost nothing left of the window, an empty capture ends it', () => {
    const h = listening();
    h.advance(7800);
    const a = h.step({ type: 'utterance', meta: h.meta(), text: '', speechMs: 300 });
    expect(one(a, 'decision').decision).toEqual({ action: 'drop', reason: 'no-command' });
    expect(h.m.log.at(-1).text).toBe('no command after 8 s');
  });

  it('T8: no speech in 8 s → waiting, silently (END-3)', () => {
    const h = listening();
    h.advance(8000);
    const a = h.step({ type: 'captureNoSpeech', meta: { wakeId: 'w1' } });
    expect(h.m.state).toBe('waiting');
    for (const t of ['earcon', 'say', 'hint']) expect(of(a, t), t).toEqual([]);
    expect(h.m.log.at(-1).reason).toBe('no-command');
    // a stale event changes nothing
    expect(types(h.step({ type: 'captureNoSpeech', meta: { wakeId: 'w1' } }))).toEqual([]);
  });

  it('the echo check drops a transcript of her own sentence (SELF-5)', () => {
    const h = listening();
    const a = h.step({ type: 'utterance', meta: h.meta(), text: 'The weather tomorrow will be sunny.', speechMs: 1800, echo: true });
    expect(one(a, 'decision').decision).toEqual({ action: 'drop', reason: 'echo' });
  });

  it('failed speech recognition drops silently', () => {
    const h = listening();
    expect(one(h.step({ type: 'utterance', meta: h.meta(), text: '', failed: true }), 'decision').decision).toEqual({ action: 'drop', reason: 'stt-failed' });
  });

  it('a stale utterance is dropped', () => {
    const h = listening();
    expect(one(h.step({ type: 'utterance', meta: { wakeId: 'old', kind: 'command' }, text: 'hello' }), 'decision').decision.action).toBe('drop');
    expect(h.m.state).toBe('listening');
  });
});

describe('T10-T11 the follow-up window', () => {
  /** a voice turn finished: idle again */
  const replied = (settings, o) => {
    const h = harness(settings, o);
    h.ready();
    h.step({ type: 'conversation', state: 'speaking' });
    h.step({ type: 'conversation', state: 'idle' });
    return h;
  };

  it('opens after a voice turn, for followUpSec, no earcon at open (FUP-1, FUP-7)', () => {
    const h = replied();
    const a = h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true, spoke: true, permissionPending: false });
    expect(h.m.state).toBe('followup');
    expect(one(a, 'capture')).toMatchObject({ kind: 'followup', noSpeechMs: 6000, show: true });
    expect(of(a, 'earcon')).toEqual([]);
    // the glow dims over the last 1.5 s
    const d = h.advance(4500);
    expect(one(d, 'dim')).toEqual({ type: 'dim', on: true });
    const e = h.step({ type: 'captureNoSpeech', meta: h.meta('followup') });
    expect(h.m.state).toBe('waiting');
    expect(one(e, 'dim')).toEqual({ type: 'dim', on: false });
    expect(h.m.log).toEqual([]); // a closing window is not a wake event
  });

  it('a follow-up is sent without her name; enders and empty text close it (FUP-3, FUP-4)', () => {
    const h = replied();
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(one(h.step({ type: 'utterance', meta: h.meta('followup'), text: 'And tomorrow?', speechMs: 900 }), 'decision').decision).toEqual({ action: 'send', text: 'And tomorrow?' });
    const k = replied();
    k.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(one(k.step({ type: 'utterance', meta: k.meta('followup'), text: 'Thanks!', speechMs: 900 }), 'decision').decision.action).toBe('end');
    const e = replied();
    e.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(one(e.step({ type: 'utterance', meta: e.meta('followup'), text: 'you', speechMs: 300 }), 'decision').decision.action).toBe('drop');
  });

  it('not after a typed turn, a say() line, with a card pending, or 0 s (FUP-1)', () => {
    for (const info of [{ voiceTurn: false }, { voiceTurn: true, say: true }, { voiceTurn: true, permissionPending: true }, { voiceTurn: true, turnId: '' }]) {
      const h = replied();
      h.step({ type: 'turnDone', turnId: 't1', ...info });
      expect(h.m.state, JSON.stringify(info)).toBe('waiting');
    }
    const z = replied({ followUpSec: 0 });
    z.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(z.m.state).toBe('waiting');
  });

  it('not when the camera has seen no face for 3 s; it opens with a face, or without a camera (FUP-6)', () => {
    const h = replied();
    h.step({ type: 'presence', camera: true, present: true, looking: false });
    h.step({ type: 'presence', camera: true, present: false });
    h.advance(3000);
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(h.m.state).toBe('waiting');
    const k = replied();
    k.step({ type: 'presence', camera: true, present: true });
    k.advance(2000);
    k.step({ type: 'presence', camera: true, present: false });
    k.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    expect(k.m.state).toBe('followup');
  });

  it('once per turn; each reply opens a new window (FUP-5)', () => {
    const h = replied();
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    h.step({ type: 'captureNoSpeech', meta: h.meta('followup') });
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true }); // the same turn again (a say() after it)
    expect(h.m.state).toBe('waiting');
    h.step({ type: 'turnDone', turnId: 't2', voiceTurn: true });
    expect(h.m.state).toBe('followup');
  });

  it('a 10 s window', () => {
    const h = replied({ followUpSec: 10 });
    expect(one(h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true }), 'capture').noSpeechMs).toBe(10_000);
  });
});

describe('T9 look and talk', () => {
  it('looking at her for 600 ms opens a no-name capture; 1.5 s after looking away without speech it closes', () => {
    const h = harness({ lookToTalk: true });
    h.ready();
    h.step({ type: 'presence', camera: true, present: true, looking: true });
    expect(h.m.nextDeadline()).toBe(h.t + 600);
    h.advance(599);
    expect(h.m.state).toBe('waiting');
    const a = h.advance(1);
    expect(h.m.state).toBe('look');
    expect(one(a, 'capture')).toMatchObject({ kind: 'look', noSpeechMs: Infinity, show: true });
    h.step({ type: 'presence', camera: true, present: true, looking: false });
    h.advance(1499);
    expect(h.m.state).toBe('look');
    const b = h.advance(1);
    expect(types(b)).toContain('cancelCapture');
    expect(h.m.state).toBe('waiting');
  });

  it('speech that started keeps the capture; the utterance goes through the follow-up rules', () => {
    const h = harness({ lookToTalk: true });
    h.ready();
    h.step({ type: 'presence', camera: true, present: true, looking: true });
    h.advance(600);
    h.step({ type: 'speechStart' });
    h.step({ type: 'presence', camera: true, present: true, looking: false });
    h.advance(5000);
    expect(h.m.state).toBe('look');
    expect(one(h.step({ type: 'utterance', meta: h.meta('look'), text: 'Open my calendar.', speechMs: 1200 }), 'decision').decision).toEqual({ action: 'send', text: 'Open my calendar.' });
  });

  it('off without lookToTalk or without the camera', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'presence', camera: true, present: true, looking: true });
    h.advance(2000);
    expect(h.m.state).toBe('waiting');
  });
});

describe('T12 barge-in while she speaks', () => {
  const speaking = (settings, o) => {
    const h = harness(settings, o);
    h.ready();
    h.step({ type: 'conversation', state: 'speaking', speaking: true, kind: 'audio', turnRunning: true });
    expect(h.m.state).toBe('busy');
    return h;
  };

  it('her voice is ducked in the same step as the hit (≤ 100 ms, LAT-4); accept stops her and listens (BRG-2, BRG-3)', () => {
    const h = speaking();
    const a = h.hit({ conv: { state: 'speaking', speaking: true, kind: 'audio', turnRunning: true } });
    expect(types(a).slice(0, 3)).toEqual(['resetDetector', 'duck', 'capture']);
    expect(one(a, 'capture').show).toBe(false); // she keeps speaking, ducked, until it is verified
    expect(h.m.state).toBe('barge');
    const b = h.step({ type: 'verified', id: 'w1', ok: true });
    expect(types(b)).toEqual(expect.arrayContaining(['stopSpeaking', 'unduck', 'show', 'earcon']));
    expect(one(b, 'unduck')).toMatchObject({ afterMs: WAKE.stopFadeMs });
    expect(h.m.state).toBe('listening');
  });

  it('reject: her voice comes back within 300 ms and she goes on (BRG-2)', () => {
    const h = speaking();
    h.hit();
    const b = h.step({ type: 'verified', id: 'w1', ok: false, reason: 'self' });
    expect(one(b, 'unduck')).toEqual({ type: 'unduck', rampMs: 300 });
    expect(types(b)).toContain('cancelCapture');
    expect(types(b)).not.toContain('stopSpeaking');
    expect(h.m.state).toBe('busy');
  });

  it('"Hey Jade, stop" → interrupt (BRG-4)', () => {
    const h = speaking();
    h.hit();
    h.step({ type: 'verified', id: 'w1', ok: true });
    expect(one(h.step({ type: 'utterance', meta: h.meta(), text: 'stop', speechMs: 500 }), 'decision').decision.action).toBe('interrupt');
  });

  it('the system voice without the all-apps echo canceller: ignored (BRG-6); with it: barge', () => {
    const h = speaking({}, { echo: true });
    h.step({ type: 'conversation', state: 'speaking', speaking: true, kind: 'speech' });
    const a = h.hit();
    expect(types(a)).not.toContain('duck');
    expect(h.m.log.at(-1).reason).toBe('barge-echo');
    const k = speaking({}, { echo: 'all' });
    k.step({ type: 'conversation', state: 'speaking', speaking: true, kind: 'speech' });
    expect(types(k.hit())).toContain('duck');
  });

  it('"Interrupt with her name" off: ignored and logged', () => {
    const h = speaking({ bargeIn: false });
    expect(types(h.hit())).not.toContain('capture');
    expect(h.m.log.at(-1).reason).toBe('barge-off');
  });

  it('while thinking: the T2 flow without a duck; a reply that starts now stays silent (BRG-5)', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'conversation', state: 'thinking', turnRunning: true });
    const a = h.hit();
    expect(types(a)).not.toContain('duck');
    expect(h.m.state).toBe('attention');
    expect(types(h.step({ type: 'verified', id: 'w1', ok: true }))).toContain('quiet');
  });

  it('while transcribing or during push-to-talk: ignored', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'conversation', state: 'transcribing' });
    expect(types(h.hit())).not.toContain('capture');
    expect(h.m.log.at(-1).reason).toBe('busy');
  });
});

describe('T13 manual, T14 push-to-talk', () => {
  it('the hotkey while waiting → listening with the earcon, no verification', () => {
    const h = harness();
    h.ready();
    const a = h.step({ type: 'manual', from: 'hotkey' });
    expect(h.m.state).toBe('listening');
    expect(one(a, 'capture')).toMatchObject({ kind: 'command', noSpeechMs: 8000, show: true });
    expect(types(a)).not.toContain('verify');
    expect(of(a, 'earcon')).toEqual([{ type: 'earcon', name: 'wake' }]);
  });

  it('the hotkey during a follow-up replaces it', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    const a = h.step({ type: 'manual', from: 'hotkey' });
    expect(types(a)).toEqual(expect.arrayContaining(['cancelCapture', 'capture', 'earcon']));
    expect(h.m.state).toBe('listening');
  });

  it('T14: push-to-talk cancels our capture silently', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.step({ type: 'verified', id: 'w1', ok: true });
    const a = h.step({ type: 'captureCancelled', meta: { wakeId: 'w1' } });
    expect(types(a).filter((x) => x !== 'report')).toEqual([]);
    h.step({ type: 'conversation', state: 'listening' });
    expect(h.m.state).toBe('busy');
  });
});

describe('T15-T17 the PC, the window, the microphone', () => {
  it('T15: locked → the mic is released; unlocked → listening for her name again (PRIV-6, PRIV-7)', () => {
    const h = harness();
    h.ready();
    h.hit();
    const a = h.step({ type: 'power', state: 'locked' });
    expect(h.m.state).toBe('locked');
    expect(types(a)).toEqual(expect.arrayContaining(['cancelCapture', 'releaseMic']));
    expect(h.m.reason).toMatch(/locked/);
    const b = h.step({ type: 'power', state: 'unlocked' });
    expect(types(b)).toContain('openMic');
    h.step({ type: 'micOk', echo: 'all' });
    expect(h.m.state).toBe('waiting');
    h.step({ type: 'power', state: 'suspended' });
    expect(h.m.state).toBe('locked');
    h.step({ type: 'power', state: 'resumed' });
    expect(h.m.state).not.toBe('locked');
  });

  it('T15: locked, then asleep, then woken at the lock screen → still locked, the mic stays closed', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'power', state: 'locked', seq: 1 });
    h.step({ type: 'power', state: 'suspended', seq: 2 });
    const a = h.step({ type: 'power', state: 'resumed', seq: 3 });
    expect(h.m.state).toBe('locked');
    expect(types(a)).not.toContain('openMic');
    const b = h.step({ type: 'power', state: 'unlocked', seq: 4 });
    expect(types(b)).toContain('openMic');
    // asleep without a lock: waking up is enough
    h.step({ type: 'micOk', echo: 'all' });
    h.step({ type: 'power', state: 'suspended', seq: 5 });
    expect(h.m.state).toBe('locked');
    expect(types(h.step({ type: 'power', state: 'resumed', seq: 6 }))).toContain('openMic');
  });

  it('T15: main\'s snapshot (a window reloaded while the PC is locked) starts locked; an older one is ignored', () => {
    const h = harness();
    const a = h.step({ type: 'power', snapshot: { locked: true, suspended: false, seq: 7 } });
    h.ready();
    expect(h.m.state).toBe('locked');
    expect(types(h.all)).not.toContain('openMic');
    void a;
    h.step({ type: 'power', state: 'unlocked', seq: 8 });
    expect(types(h.all)).toContain('openMic');
    // a status computed before the unlock, delivered after it
    h.step({ type: 'power', snapshot: { locked: true, suspended: false, seq: 7 } });
    expect(h.m.locked).toBe(false);
  });

  it('PRIV-5, PRIV-6: locked or turned off during a capture → the capture is cancelled before the mic is released', () => {
    for (const kind of ['listening', 'followup']) {
      for (const how of ['lock', 'off']) {
        const h = harness();
        h.ready();
        if (kind === 'listening') h.step({ type: 'manual', from: 'hotkey' });
        else h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
        expect(h.m.state).toBe(kind);
        const a = how === 'lock' ? h.step({ type: 'power', state: 'locked' }) : h.step({ type: 'settings', wake: { enabled: false } });
        const t = types(a);
        expect(t).toContain('cancelCapture');
        expect(t).toContain('releaseMic');
        expect(t.indexOf('cancelCapture')).toBeLessThan(t.indexOf('releaseMic'));
      }
    }
  });

  it('T16: hidden with "Listen while hidden" off → paused (released); on → still waiting', () => {
    const h = harness({ whileHidden: false });
    h.ready();
    const a = h.step({ type: 'visibility', visible: false });
    expect(h.m.state).toBe('paused');
    expect(types(a)).toContain('releaseMic');
    h.step({ type: 'visibility', visible: true });
    expect(types(h.all)).toContain('openMic');
    const k = harness();
    k.ready();
    k.step({ type: 'visibility', visible: false });
    expect(k.m.state).toBe('waiting');
  });

  it('T17: blocked → retries at 5 s, 15 s, 60 s, then every 60 s (WIN-1, WIN-2)', () => {
    const h = harness();
    h.step({ type: 'availability', stt: 'ready', engine: 'ready' });
    h.step({ type: 'micError', reason: 'os-blocked', message: 'Windows is blocking the microphone for desktop apps' });
    expect(h.m.state).toBe('blocked');
    expect(h.m.code).toBe('os-blocked');
    expect(h.m.reason).toMatch(/Windows is blocking/);
    const retries = [];
    for (let s = 0; s < 200; s++) {
      const a = h.advance(1000);
      if (one(a, 'openMic')) {
        retries.push(s + 1);
        h.step({ type: 'micError', reason: 'in-use', message: 'in use' });
      }
    }
    expect(retries.slice(0, 5)).toEqual([5, 20, 80, 140, 200]);
    h.step({ type: 'micError', reason: 'in-use', message: 'in use' });
    h.advance(60_000);
    h.step({ type: 'micOk', echo: true });
    expect(h.m.state).toBe('waiting');
  });

  it('A11Y-9: a mic failure right after a voice interaction is said out loud, once', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'manual', from: 'hotkey' });
    h.advance(2000);
    const a = h.step({ type: 'micError', reason: 'in-use', message: 'in use' });
    expect(one(a, 'say')).toEqual({ type: 'say', text: SPOKEN.blocked });
    const b = h.advance(5000); // the retry
    const c = h.step({ type: 'micError', reason: 'in-use', message: 'in use' });
    expect(of([...b, ...c], 'say')).toEqual([]);
    // not long after the last voice interaction
    const k = harness();
    k.ready();
    k.advance(60_000);
    expect(of(k.step({ type: 'micError', reason: 'in-use' }), 'say')).toEqual([]);
  });

  it('WIN-5: a track that ends → the default mic is opened again at once', () => {
    const h = harness();
    h.ready();
    const a = h.step({ type: 'micError', reason: 'ended' });
    expect(one(a, 'openMic')).toBeTruthy();
    expect(h.m.state).toBe('starting');
    h.step({ type: 'micOk', echo: 'all' });
    expect(h.m.state).toBe('waiting');
  });

  it('WIN-3: mute → muted; a follow-up window is frozen and resumes with what was left of it', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'turnDone', turnId: 't1', voiceTurn: true });
    h.advance(2000);
    const a = h.step({ type: 'micMute', muted: true });
    expect(h.m.state).toBe('muted');
    expect(types(a)).toEqual(expect.arrayContaining(['cancelCapture', 'announce']));
    expect(types(a)).not.toContain('releaseMic'); // the device stays open
    h.advance(30_000); // muted for a long time: the window does not run out
    const b = h.step({ type: 'micMute', muted: false });
    expect(h.m.state).toBe('followup');
    expect(one(b, 'capture')).toMatchObject({ kind: 'followup', noSpeechMs: 4000 });
  });

  it('a mic that opens muted is muted', () => {
    const h = harness();
    h.step({ type: 'availability', stt: 'ready', engine: 'ready' });
    h.step({ type: 'micOk', echo: 'all', muted: true });
    expect(h.m.state).toBe('muted');
  });
});

describe('T18 hints', () => {
  it('digital silence for 10 s → one hint (WIN-4); a Bluetooth headset → one hint (WIN-6)', () => {
    const h = harness();
    h.ready();
    expect(of(h.step({ type: 'audio', zeroRunMs: 9000 }), 'hint')).toEqual([]);
    expect(of(h.step({ type: 'audio', zeroRunMs: 10_000 }), 'hint')).toEqual([{ type: 'hint', id: 'silence', text: HINTS.silence }]);
    expect(of(h.step({ type: 'audio', zeroRunMs: 20_000 }), 'hint')).toEqual([]);
    const k = harness({}, { label: 'Headset (WH-1000XM4 Hands-Free AG Audio)' });
    const a = k.ready();
    expect(one(a, 'hint')).toEqual({ type: 'hint', id: 'headset', text: HINTS.headset });
  });
});

describe('the bare name ("Jade, …") and the transcript check', () => {
  it("a JADE hit counts only with phrase 'jade' and never while she speaks", () => {
    const h = harness();
    h.ready();
    expect(types(h.hit({ keyword: 'JADE' }))).not.toContain('capture');
    const k = harness({ phrase: 'jade' });
    k.ready();
    expect(types(k.hit({ keyword: 'JADE' }))).toContain('capture');
    const s = harness({ phrase: 'jade' });
    s.ready();
    s.step({ type: 'conversation', state: 'speaking', speaking: true, kind: 'audio' });
    expect(types(s.hit({ keyword: 'JADE' }))).not.toContain('duck');
  });

  it('the transcript check: the confirm rule; "Hey Jade." alone opens the command window with the chime', () => {
    const h = harness({ transcriptFallback: true });
    h.step({ type: 'availability', stt: 'ready', engine: 'error' });
    expect(h.m.fallback).toBe(true);
    const meta = { wakeId: 'fb1', kind: 'fallback' };
    // background speech: discarded, not logged (PRIV-3)
    expect(one(h.step({ type: 'utterance', meta, text: 'the weather is nice today', speechMs: 2000 }), 'decision')).toEqual({ type: 'decision', id: 'fb1', decision: { action: 'drop', reason: 'no-call' } });
    expect(h.m.log).toEqual([]);
    // in one breath: sent, no chime (ACK-4)
    const a = h.step({ type: 'utterance', meta, text: 'Hey Jade, what time is it?', speechMs: 2000 });
    expect(one(a, 'decision')).toEqual({ type: 'decision', id: 'fb1', decision: { action: 'send', text: 'what time is it?' } });
    expect(of(a, 'earcon')).toEqual([]);
    const b = h.step({ type: 'utterance', meta, text: 'Hey Jade.', speechMs: 700 });
    expect(one(b, 'decision').decision.action).toBe('again');
    expect(one(b, 'capture')).toMatchObject({ kind: 'command', noSpeechMs: 8000 });
    expect(of(b, 'earcon')).toEqual([{ type: 'earcon', name: 'wake' }]);
    expect(h.m.state).toBe('listening');
    // stage-1 hits are not expected without the engine
    expect(types(h.hit({ id: 'x' }))).not.toContain('verify');
  });
});

describe('reports and announcements', () => {
  it('a report per state change, with the reason', () => {
    const h = harness();
    h.ready();
    h.hit();
    h.step({ type: 'verified', id: 'w1', ok: true });
    const states = of(h.all, 'report').map((r) => r.state);
    // (starting = opening the microphone)
    expect(states).toEqual(['starting', 'waiting', 'attention', 'listening']);
  });

  it('turning it off from a capture announces it', () => {
    const h = harness();
    h.ready();
    h.step({ type: 'manual', from: 'hotkey' });
    const a = h.step({ type: 'settings', wake: { enabled: false } });
    expect(of(a, 'announce').map((x) => x.text)).toEqual(expect.arrayContaining(['Microphone off']));
    expect(types(a)).toContain('cancelCapture');
  });

  it('the wake log keeps the last 20 events, reason classes only', () => {
    const h = harness();
    h.ready();
    for (let i = 0; i < 25; i++) {
      h.advance(61_000); // never strict
      h.hit({ keyword: 'HEY_JUDE' });
    }
    expect(h.m.log).toHaveLength(20);
    for (const e of h.m.log) expect(Object.keys(e).sort()).toEqual(['at', 'outcome', 'reason', 'text']);
  });
});
