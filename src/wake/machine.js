// The "Hey Jade" listening state machine (contract-wake §8): pure, with an injected clock.
//
// step(input) takes one event and returns the actions to perform; src/wake/feature.js wires
// both ends (mic, port, controller, player, UI). Nothing here touches the DOM, audio or timers:
// the feature calls step({ type: 'tick' }) at nextDeadline().
//
// States (body[data-wake], the status chip, the tray tooltip):
//   off · unavailable · starting · paused · locked · blocked · muted     (the mic is closed, or
//                                                                         open but unusable)
//   waiting     listening for her name: the tap feeds the wake-word engine, nothing is transcribed
//   attention   stage 1 fired, the wake segment is being checked (silent; she looks up)
//   listening   verified (or the hotkey): the command is captured, after the "wake" chime
//   followup    her reply finished: a few seconds to go on without her name
//   look        look-and-talk: the camera sees you looking at her, no name needed
//   busy        a turn runs (transcribing, thinking, speaking); her name still works
//   barge       stage 1 fired while she speaks: her voice is ducked until it is verified
//
// Inputs: settings · availability · power · visibility · micOk · micError · micMute · hit ·
// verified · captured · utterance · captureNoSpeech · captureCancelled · speechStart ·
// conversation · turnDone · presence · manual · audio · tick.
// Actions: openMic · releaseMic · capture · cancelCapture · show · verify · resetDetector ·
// earcon · duck · unduck · stopSpeaking · quiet · showWindow · gaze · fastWake · setStrict ·
// dim · decision · disable · say · hint · announce · log · report · noteActivity.
// The IDs in brackets in the comments are the rules of ux.md.

import { decideCommand, confirmCall, stripCall } from './phrase.js';

export const WAKE = Object.freeze({
  // wake segment and command cut (stage 1's last token is ≈ 90 ms before the word's end). The
  // segment is short and ends where stage 1 decided (≤ segMaxAfterEndMs after the keyword, audio
  // the ring already holds): words before the call (TV, a lead-in) stay out of it, "Hey Jude" is
  // not cut to "Hey, Ju-" (review: 2.5 s → 1.2 s took TV-bed calls from 11/40 to 32/40 accepted,
  // mid-utterance calls from 8/28 to 14/28, clean 48/50 either way)
  ringMs: 3000, segMaxBeforeEndMs: 1200, segMaxAfterEndMs: 600, cutAfterKeywordMs: 150,
  /** less of the call than this still in the ring: nothing to check */
  segMinMs: 400,
  verifyTimeoutMs: Object.freeze({ cuda: 2500, cpu: 8000 }),
  commandWindowMs: 8000, followUpTailMs: 350, followUpAbsentMs: 3000,
  lookDwellMs: 600, lookGraceMs: 1500,
  selfPreMs: 100, selfTailMs: 400, selfEchoWindowMs: 10000, selfEchoJaccard: 0.8,
  burstCount: 3, burstWindowMs: 60000, burstStrictMs: 300000,
  duckDb: -15, duckRampMs: 60, unduckMs: 300, stopFadeMs: 60,
  earconVadMaskMs: 100, errorRetryMs: Object.freeze([5000, 15000, 60000]),
  logSize: 20,
  // not in the contract's table: the follow-up glow dims over the last 1.5 s (FUP-7); a mic
  // that delivers exact zeros this long gets one hint (WIN-4); a mic failure this soon after a
  // voice interaction is said out loud once (A11Y-9); turned off this soon after the engine
  // stopped (main's status first, then the setting), the mic still gets its "off" sound
  dimMs: 1500, digitalSilenceMs: 10000, voiceRecentMs: 30000, offGraceMs: 1500,
  // a watchdog: a capture whose window ended this long ago with no word and no end from the
  // controller is over all the same (so a lost event never leaves her stuck "listening")
  captureGraceMs: 2500,
  // …and an utterance being transcribed that never comes back with a text (an aborted /stt): the
  // episode ends this long after the capture ended, so her name works again (a long command on
  // the CPU takes seconds; this bounds a lost answer, not a slow one)
  decideMaxMs: 30000,
});

/** @typedef {'off'|'unavailable'|'starting'|'paused'|'locked'|'blocked'|'muted'|'waiting'|'attention'|'listening'|'followup'|'look'|'busy'|'barge'} WakeUiState */
export const WAKE_STATES = /** @type {const} */ (['off', 'unavailable', 'starting', 'paused', 'locked', 'blocked', 'muted', 'waiting', 'attention', 'listening', 'followup', 'look', 'busy', 'barge']);
/** the states in which the microphone is (or is about to be) open for her name */
export const ACTIVE_STATES = Object.freeze(['attention', 'listening', 'followup', 'look', 'busy', 'barge']);

/** What the wake log says for each reason class (never text or audio). */
export const LOG_TEXT = Object.freeze({
  woke: 'woke',
  manual: 'listening (hotkey)',
  jude: 'ignored · sounded like “Hey Jude”',
  rival: 'ignored · another name',
  self: 'ignored · my own voice',
  system: 'ignored · the system voice',
  echo: 'ignored · my own voice',
  'no-call': 'ignored · not a call',
  empty: 'ignored · nothing understood',
  lost: 'ignored · the audio was no longer buffered',
  timeout: 'ignored · the check took too long',
  'stt-failed': 'ignored · speech recognition failed',
  'no-command': 'no command after 8 s',
  sent: 'sent',
  ender: 'closed',
  stop: 'stopped her',
  'barge-off': 'ignored · interrupting is off',
  'barge-echo': 'ignored · she was speaking with the system voice',
  busy: 'ignored · busy',
  strict: 'many mistakes in a row: stricter for 5 min',
  'stop-listening': 'stopped listening (by voice)',
});

/** A Bluetooth headset microphone: Windows switches the headphones to telephone quality (WIN-6). */
export const HEADSET_LABEL = /hands-free|headset|bluetooth|\bAG Audio\b/i;

export const HINTS = Object.freeze({
  silence: 'Jade can’t hear anything; check the microphone in Windows settings.',
  headset: 'Use the laptop’s microphone for “Hey Jade” to keep your headphones in high quality.',
});

export const SPOKEN = Object.freeze({
  blocked: 'I can’t hear you; the microphone is blocked.',
  stopped: 'Okay, I stopped listening. Turn me back on in the tray.',
});

const ONE_PER_RUN = new Set(['silence', 'headset']);

/**
 * The wake segment for a hit, in 16 kHz sample indices: from ≤ 1.2 s before the end of the keyword
 * (not before its stream) to where stage 1 decided (at least 150 ms, at most 600 ms after the end),
 * and the command cut (150 ms after the end).
 * @param {{ streamAt?: number, endAt?: number, emitAt?: number }} hit
 * @returns {{ from: number, to: number, cut: number }}
 */
export function wakeSegment(hit) {
  const ms = (/** @type {number} */ v) => Math.round((v / 1000) * 16000);
  const endAt = Number(hit.endAt) || 0;
  const cut = endAt + ms(WAKE.cutAfterKeywordMs);
  const emitAt = Number(hit.emitAt);
  const to = Number.isFinite(emitAt) ? Math.min(endAt + ms(WAKE.segMaxAfterEndMs), Math.max(cut, emitAt)) : cut;
  const from = Math.max(Number(hit.streamAt) || 0, endAt - ms(WAKE.segMaxBeforeEndMs));
  return { from, to, cut };
}

/** Rejections that count toward the media-burst rule: a song or a show naming someone else, never a failed or unclear check. */
const BURST_REASONS = new Set(['jude', 'rival']);

/**
 * @typedef {object} WakeSettings
 * @property {boolean} enabled
 * @property {'hey-jade'|'jade'} phrase
 * @property {'low'|'normal'|'high'} sensitivity
 * @property {number} followUpSec
 * @property {boolean} bargeIn
 * @property {'off'|'start'|'start-end'} sounds
 * @property {boolean} whileHidden
 * @property {boolean} transcriptFallback
 * @property {boolean} [lookToTalk]   camera.lookToTalk
 */

/**
 * @typedef {object} Availability
 * @property {'ready'|'starting'|'off'} stt      the local voice's speech recognition
 * @property {string} [sttReason]
 * @property {'off'|'starting'|'ready'|'missing'|'error'} engine   main's wake-word engine
 * @property {string} [engineDetail]
 * @property {'cuda'|'cpu'|null} [device]        where /stt runs (the verification timeout)
 */

/** @typedef {{ type: string, [k: string]: any }} Action */

const DEFAULT_SETTINGS = /** @type {WakeSettings} */ ({
  enabled: false, phrase: 'hey-jade', sensitivity: 'normal', followUpSec: 6, bargeIn: true,
  sounds: 'start', whileHidden: true, transcriptFallback: false, lookToTalk: false,
});

export class WakeMachine {
  /**
   * @param {{ now?: () => number, hallucination?: RegExp, settings?: Partial<WakeSettings> }} [o]
   */
  constructor(o = {}) {
    this._now = o.now || (() => performance.now());
    this.hallucination = o.hallucination || null;
    /** @type {WakeSettings} */
    this.s = { ...DEFAULT_SETTINGS, ...(o.settings || {}) };
    /** @type {Availability} */
    this.avail = { stt: 'off', sttReason: '', engine: 'off', engineDetail: '', device: null };
    // the screen lock and sleep are separate: a PC that was locked, then slept, then woke is still
    // locked until it is unlocked (a 'resumed' at the lock screen must not open the mic)
    this.screenLocked = false;
    this.suspended = false;
    /** the newest power event (main's sequence number): an older status snapshot is ignored */
    this._powerSeq = -1;
    this.hidden = false;
    /** 'closed' | 'opening' | 'open' | 'blocked' */
    this.mic = 'closed';
    this.micReason = '';
    this.micCode = '';
    this.micRetryAt = Infinity;
    this.micRetryN = 0;
    this.muted = false;
    this.echo = /** @type {'all'|'app'|'off'} */ ('off');
    this.micLabel = '';
    /** @type {{ state: string, speaking: boolean, kind: 'audio'|'speech'|null, turnRunning: boolean }} */
    this.conv = { state: 'idle', speaking: false, kind: null, turnRunning: false };
    /** the episode that owns a capture or a verification @type {null|Record<string, any>} */
    this.active = null;
    /** a window interrupted by "muted", resumed with its remaining time */
    this.frozen = /** @type {null|{ kind: string, remainingMs: number, verdict: string }} */ (null);
    /** @type {number[]} rejected stage-1 fires (the media-burst rule) */
    this.burst = [];
    this.strictUntil = -Infinity;
    this.lastFollowTurn = /** @type {string|null} */ (null);
    this.presence = { camera: false, present: false, looking: false, lastFaceAt: -Infinity, lookSince: /** @type {number|null} */ (null), lookLostAt: /** @type {number|null} */ (null) };
    this.hints = new Set();
    this.lastVoiceAt = -Infinity;
    this.saidBlocked = false;
    this.dimAt = Infinity;
    this.dimOn = false;
    /** @type {Array<{ at: number, outcome: string, reason: string, text: string, latencyMs?: number }>} */
    this.log = [];
    this._ids = 0;
    this._reported = '';
    this._base = /** @type {{ state: WakeUiState, reason: string, code: string, fallback: boolean }} */ ({ state: 'off', reason: '', code: '', fallback: false });
    this._strictOn = false;
    /** the last time the mic was open for her name (waiting or muted) */
    this._runAt = -Infinity;
  }

  // ------------------------------------------------------------------------------------------
  // what the feature and the controller read

  /** @returns {WakeUiState} */
  get state() {
    const b = this._base.state;
    if (b !== 'waiting') return b;
    const a = this.active;
    if (a) {
      if (a.phase === 'deciding') return 'busy';
      if (a.kind === 'attention') return a.show ? 'attention' : 'waiting';
      return /** @type {WakeUiState} */ (a.kind);
    }
    return this.conv.state === 'idle' ? 'waiting' : 'busy';
  }

  get reason() {
    return this._base.reason;
  }

  /** Why the wake word does not run, as a code: 'no-voice' | 'engine' | 'denied' | 'os-blocked' | 'in-use' | 'no-device' | … */
  get code() {
    return this._base.code;
  }

  /** Wake mode is on and running: the name is required (the controller's "listen to everything" is off). */
  get running() {
    return this._base.state === 'waiting';
  }

  /** The transcript check runs instead of the engine (§8.7). */
  get fallback() {
    return this._base.state === 'waiting' && this._base.fallback;
  }

  get strict() {
    return this._now() < this.strictUntil;
  }

  /** The PC is locked or asleep: the mic stays released (§2.3, T15). */
  get locked() {
    return this.screenLocked || this.suspended;
  }

  /** The earliest time step({ type: 'tick' }) has something to do (ms on the clock), or Infinity. */
  nextDeadline() {
    let t = Infinity;
    const a = this.active;
    if (a && a.verdict === 'pending') t = Math.min(t, a.verifyDeadline);
    if (a && a.phase === 'capture' && !a.speechStarted && Number.isFinite(a.windowEnd)) t = Math.min(t, a.windowEnd + WAKE.captureGraceMs);
    if (a && a.phase === 'deciding' && Number.isFinite(a.decidingSince)) t = Math.min(t, a.decidingSince + WAKE.decideMaxMs);
    if (this._strictOn) t = Math.min(t, this.strictUntil);
    if (this.mic === 'blocked' && this._base.state === 'blocked') t = Math.min(t, this.micRetryAt);
    if (this.dimAt < Infinity && !this.dimOn) t = Math.min(t, this.dimAt);
    const p = this.presence;
    if (this.s.lookToTalk && p.camera) {
      if (!a && p.looking && p.lookSince != null) t = Math.min(t, p.lookSince + WAKE.lookDwellMs);
      if (a && a.kind === 'look' && !a.speechStarted && p.lookLostAt != null) t = Math.min(t, p.lookLostAt + WAKE.lookGraceMs);
    }
    return t;
  }

  // ------------------------------------------------------------------------------------------

  /**
   * @param {{ type: string, [k: string]: any }} input
   * @returns {Action[]}
   */
  step(input) {
    /** @type {Action[]} */
    const out = [];
    const now = this._now();
    switch (input?.type) {
      case 'settings': this._settings(input, out, now); break;
      case 'availability': this.avail = { ...this.avail, ...pick(input, ['stt', 'sttReason', 'engine', 'engineDetail', 'device']) }; break;
      case 'power': this._power(input); break;
      case 'visibility': this.hidden = input.visible === false; break;
      case 'micOk': this._micOk(input, out); break;
      case 'micError': this._micError(input, out, now); break;
      case 'micMute': this._mute(!!input.muted, out, now); break;
      case 'hit': this._hit(input, out, now); break;
      case 'verified': this._verified(input, out, now); break;
      case 'utterance': this._utterance(input, out, now); break;
      case 'captureNoSpeech': this._noSpeech(input, out); break;
      case 'captureCancelled': this._cancelled(input, out); break;
      case 'speechStart':
        if (this.active && this.active.phase === 'capture') this.active.speechStarted = true;
        break;
      case 'captured':
        // our capture's utterance ended: the controller transcribes it now ('busy')
        if (this.active && this.active.id === String(input.meta?.wakeId) && this.active.phase === 'capture') {
          this.active.phase = 'deciding';
          this.active.decidingSince = now;
        }
        break;
      case 'conversation': this._conversation(input); break;
      case 'turnDone': this._turnDone(input, out, now); break;
      case 'presence': this._presence(input, now); break;
      case 'manual': this._manual(input, out, now); break;
      case 'audio':
        if (Number(input.zeroRunMs) >= WAKE.digitalSilenceMs && !this.muted && this._base.state === 'waiting') this._hint('silence', out);
        break;
      case 'tick': break;
      default: return out;
    }
    this._tick(out, now);
    this._reconcile(out, now);
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // inputs

  _settings(input, out, now) {
    const prevOn = this.s.enabled;
    // main stops the engine as the setting changes, and its status can arrive first: a mic that
    // was listening a moment ago still gets its "off" sound
    const wasRunning = this._base.state === 'waiting' || this._base.state === 'muted' || now - this._runAt < WAKE.offGraceMs;
    const w = input.wake || {};
    this.s = {
      ...this.s,
      ...pick(w, ['enabled', 'phrase', 'sensitivity', 'followUpSec', 'bargeIn', 'sounds', 'whileHidden', 'transcriptFallback']),
      ...(input.lookToTalk !== undefined ? { lookToTalk: !!input.lookToTalk } : {}),
    };
    this.s.enabled = !!this.s.enabled;
    if (prevOn && !this.s.enabled && wasRunning) {
      if (this.s.sounds !== 'off') out.push({ type: 'earcon', name: 'micOff' });
      out.push({ type: 'announce', text: 'Microphone off' });
    }
  }

  /**
   * A power event ({ state, seq? }) or main's snapshot ({ snapshot: { locked, suspended, seq } },
   * which a reloaded window starts from). 'resumed' ends only the sleep: a PC locked before it
   * slept stays locked until 'unlocked' (T15, PRIV-6).
   */
  _power(input) {
    const snap = input.snapshot;
    if (snap && typeof snap === 'object') {
      const seq = Number(snap.seq);
      if (Number.isFinite(seq) && seq < this._powerSeq) return; // an event newer than it was applied
      if (Number.isFinite(seq)) this._powerSeq = seq;
      this.screenLocked = !!snap.locked;
      this.suspended = !!snap.suspended;
      return;
    }
    const seq = Number(input.seq);
    if (Number.isFinite(seq)) {
      if (seq < this._powerSeq) return;
      this._powerSeq = seq;
    }
    switch (input.state) {
      case 'locked': this.screenLocked = true; break;
      case 'suspended': this.suspended = true; break;
      case 'resumed': this.suspended = false; break;
      // unlocked: someone signed in, so the PC is awake too (a lost 'resumed' must not keep it locked)
      case 'unlocked': this.screenLocked = false; this.suspended = false; break;
      default: break;
    }
  }

  _micOk(input, out) {
    if (this.mic === 'closed') return; // released meanwhile
    this.mic = 'open';
    this.micRetryN = 0;
    this.micRetryAt = Infinity;
    this.micReason = '';
    this.micCode = '';
    this.saidBlocked = false;
    this.muted = !!input.muted;
    this.echo = input.echo === 'all' ? 'all' : input.echo === true || input.echo === 'app' ? 'app' : 'off';
    this.micLabel = String(input.label || '');
    if (HEADSET_LABEL.test(this.micLabel)) this._hint('headset', out);
  }

  _micError(input, out, now) {
    if (this.mic === 'closed' && input.reason !== 'ended') return;
    if (input.reason === 'ended') {
      // the device went away or the track ended: open the default again right away (WIN-5)
      this.mic = 'closed';
      this._endEpisode(out, 'mic');
      return;
    }
    const reason = String(input.reason || 'other');
    this.mic = 'blocked';
    this.micCode = reason;
    this.micReason = String(input.message || 'The microphone could not be started.');
    const steps = WAKE.errorRetryMs;
    this.micRetryAt = now + steps[Math.min(this.micRetryN, steps.length - 1)];
    this.micRetryN++;
    this._endEpisode(out, 'mic');
    if (!this.saidBlocked && now - this.lastVoiceAt < WAKE.voiceRecentMs) {
      this.saidBlocked = true;
      out.push({ type: 'say', text: SPOKEN.blocked });
    }
  }

  _mute(muted, out, now) {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) {
      // freeze the window: what is left of it resumes on unmute (WIN-3)
      const a = this.active;
      if (a && a.phase === 'capture' && (a.kind === 'listening' || a.kind === 'followup')) {
        this.frozen = { kind: a.kind, remainingMs: Math.max(0, a.windowEnd - now), verdict: a.verdict };
      }
      this._endEpisode(out, 'muted');
      out.push({ type: 'announce', text: 'Microphone muted' });
    }
  }

  /** @param {Record<string, any>} hit */
  _hit(hit, out, now) {
    if (this._base.state !== 'waiting' || this._base.fallback) return;
    const kw = hit.keyword;
    if (kw === 'HEY_JUDE') {
      // her own "Hey Jude" (she talks about the Beatles) is neither logged nor counted
      if (hit.masked) return;
      this._log(now, 'ignored', 'jude');
      this._burst(now);
      return;
    }
    if (kw === 'JADE') {
      // the bare name works only as phrase 'jade' and never while she speaks
      if (this.s.phrase !== 'jade' || this.conv.speaking || this.conv.state === 'speaking') return;
    } else if (kw !== 'HEY_JADE') {
      return;
    }
    if (hit.masked) {
      this._log(now, 'ignored', hit.masked === 'system' ? 'system' : 'self');
      return;
    }
    if (this.active) return; // one wake at a time; a call inside a capture is stripped from its text
    const conv = { ...this.conv, ...(hit.conv || {}) };
    const { from, to, cut } = wakeSegment(hit);
    const id = String(hit.id ?? `h${++this._ids}`);
    const speaking = conv.state === 'speaking' || conv.speaking;
    let kind = 'attention';
    if (speaking) {
      if (!this.s.bargeIn) {
        this._log(now, 'ignored', 'barge-off');
        return;
      }
      if (conv.kind === 'speech' && this.echo !== 'all') {
        // the system voice is outside Chromium's echo reference unless it cancels all apps (BRG-6)
        this._log(now, 'ignored', 'barge-echo');
        return;
      }
      kind = 'barge';
    } else if (conv.state !== 'idle' && conv.state !== 'thinking') {
      this._log(now, 'ignored', 'busy');
      return;
    }
    const show = kind === 'attention' && !this.strict;
    this.active = {
      kind, id, verdict: 'pending', show, phase: 'capture', hitAt: now, keyword: kw,
      verifyDeadline: now + (WAKE.verifyTimeoutMs[this.avail.device === 'cuda' ? 'cuda' : 'cpu']),
      windowEnd: now + WAKE.commandWindowMs, speechStarted: false,
    };
    const meta = { wakeId: id, kind: 'command' };
    out.push({ type: 'resetDetector' });
    if (kind === 'barge') out.push({ type: 'duck' });
    out.push({ type: 'capture', kind: 'command', fromSample: cut, noSpeechMs: WAKE.commandWindowMs, show, meta });
    out.push({ type: 'verify', id, from, to, keyword: kw });
    if (show) {
      // the attention cue: she looks up, fast out of a doze (ACK-1, ACK-5)
      out.push({ type: 'gaze' }, { type: 'fastWake' });
    }
  }

  _verified(input, out, now) {
    const a = this.active;
    if (!a || a.id !== String(input.id) || a.verdict !== 'pending') return;
    if (input.ok) this._accept(a, out, now, input);
    else this._reject(a, String(input.reason || 'no-call'), out, now);
  }

  _accept(a, out, now, input = {}) {
    a.verdict = 'accept';
    const wasBarge = a.kind === 'barge';
    a.kind = 'listening';
    a.windowEnd = Math.max(a.windowEnd, now + 1000);
    this.lastVoiceAt = now;
    this._log(now, 'woke', 'woke', input.latencyMs);
    if (wasBarge) out.push({ type: 'stopSpeaking' }, { type: 'unduck', afterMs: WAKE.stopFadeMs, rampMs: 30 });
    else if (this.conv.turnRunning || this.conv.state === 'thinking') out.push({ type: 'quiet' }); // a reply that starts now stays silent
    if (!a.show) out.push({ type: 'show' });
    a.show = true;
    out.push({ type: 'noteActivity' }, { type: 'showWindow' });
    if (a.phase === 'capture') {
      // "keep talking": only while the command is still being captured (ACK-2, ACK-4)
      if (this.s.sounds !== 'off') out.push({ type: 'earcon', name: 'wake' });
      out.push({ type: 'announce', text: 'Listening' });
    }
    if (a.held) {
      const held = a.held;
      a.held = null;
      this._decide(a, held, out, now);
    }
  }

  _reject(a, reason, out, now) {
    this.active = null;
    // silently: no sound, no toast, no chat entry (ACK-3)
    if (a.phase === 'capture') out.push({ type: 'cancelCapture', meta: { wakeId: a.id } });
    if (a.kind === 'barge') out.push({ type: 'unduck', rampMs: WAKE.unduckMs });
    if (a.held) out.push({ type: 'decision', id: a.id, decision: { action: 'drop', reason } });
    this._log(now, 'ignored', reason);
    // only a confident "someone else was called" counts (TV-3): a retry after a check that heard
    // nothing, failed or timed out must not make her harder to wake
    if (BURST_REASONS.has(reason)) this._burst(now);
  }

  _burst(now) {
    this.burst = this.burst.filter((t) => now - t < WAKE.burstWindowMs);
    this.burst.push(now);
    if (this.burst.length >= WAKE.burstCount && !this.strict) {
      // the "Hey Jude" song, a TV run: stricter thresholds and no attention cue for 5 min (TV-3, ACK-8)
      this.strictUntil = now + WAKE.burstStrictMs;
      this._log(now, 'strict', 'strict');
    } else if (this.burst.length >= WAKE.burstCount) {
      this.strictUntil = now + WAKE.burstStrictMs;
    }
  }

  /** An utterance of one of our captures was transcribed. */
  _utterance(input, out, now) {
    const meta = input.meta || {};
    if (meta.kind === 'fallback') {
      this._fallbackUtterance(input, out, now);
      return;
    }
    const a = this.active;
    if (!a || a.id !== String(meta.wakeId)) {
      out.push({ type: 'decision', id: meta.wakeId, decision: { action: 'drop', reason: 'stale' } });
      return;
    }
    if (a.phase !== 'deciding') a.decidingSince = now;
    a.phase = 'deciding';
    if (a.verdict === 'pending') {
      // held until the wake segment's verdict (T6)
      a.held = input;
      return;
    }
    this._decide(a, input, out, now);
  }

  _decide(a, input, out, now) {
    const kind = a.kind === 'followup' || a.kind === 'look' ? a.kind : 'command';
    let d = decideCommand(String(input.text || ''), {
      kind,
      turnRunning: !!this.conv.turnRunning,
      speechMs: Number(input.speechMs) || 0,
      hallucination: this.hallucination || undefined,
      failed: !!input.failed,
    });
    if (d.action === 'send' && input.echo) d = { action: 'drop', reason: 'echo' };
    if (d.action === 'again') {
      const remaining = a.windowEnd - now;
      if (remaining > 500) {
        a.phase = 'capture';
        a.speechStarted = false;
        out.push({ type: 'capture', kind: 'command', noSpeechMs: Math.round(remaining), show: true, meta: { wakeId: a.id, kind: 'command' } });
        out.push({ type: 'decision', id: a.id, decision: d });
        return;
      }
      d = { action: 'drop', reason: 'no-command' };
    }
    this.active = null;
    this.lastVoiceAt = now;
    switch (d.action) {
      case 'send':
        this._log(now, 'sent', 'sent');
        break;
      case 'interrupt':
        this._log(now, 'stopped', 'stop');
        break;
      case 'end':
        if (this.s.sounds === 'start-end') out.push({ type: 'earcon', name: 'done' });
        out.push({ type: 'announce', text: 'Stopped listening' });
        break;
      case 'local':
        this._log(now, 'off', 'stop-listening');
        out.push({ type: 'disable' }, { type: 'say', text: SPOKEN.stopped, afterIdle: true });
        break;
      default:
        if (d.reason === 'no-command') this._log(now, 'no command', 'no-command');
        else if (d.reason === 'echo') this._log(now, 'ignored', 'echo');
        out.push({ type: 'announce', text: 'Stopped listening' });
    }
    out.push({ type: 'decision', id: a.id, decision: d });
  }

  /** The transcript check (no engine): every utterance of the hands-free VAD, the confirm rule. */
  _fallbackUtterance(input, out, now) {
    const id = `f${++this._ids}`;
    const text = String(input.text || '');
    if (this.active || input.failed || !confirmCall(text, this.s.phrase)) {
      // not a call: discarded at once, never shown or logged (PRIV-3)
      out.push({ type: 'decision', id: input.meta?.wakeId, decision: { action: 'drop', reason: 'no-call' } });
      return;
    }
    this.lastVoiceAt = now;
    this._log(now, 'woke', 'woke');
    if (!stripCall(text)) {
      // "Hey Jade." alone: the command window, with the chime
      this.active = { kind: 'listening', id, verdict: 'none', show: true, phase: 'capture', windowEnd: now + WAKE.commandWindowMs, speechStarted: false };
      out.push({ type: 'capture', kind: 'command', noSpeechMs: WAKE.commandWindowMs, show: true, meta: { wakeId: id, kind: 'command' } });
      if (this.s.sounds !== 'off') out.push({ type: 'earcon', name: 'wake' });
      out.push({ type: 'noteActivity' }, { type: 'showWindow' }, { type: 'decision', id: input.meta?.wakeId, decision: { action: 'again', reason: 'call only' } });
      return;
    }
    // "Hey Jade, what time is it?" in one breath: no chime, straight to the reply (ACK-4)
    const a = { kind: 'listening', id, verdict: 'none', show: true, phase: 'deciding', windowEnd: now };
    this.active = a;
    out.push({ type: 'noteActivity' }, { type: 'showWindow' });
    this._decide(a, { ...input }, out, now);
    // _decide answers with this episode's id; the controller asked with the fallback meta
    const last = out[out.length - 1];
    if (last?.type === 'decision') last.id = input.meta?.wakeId;
  }

  _noSpeech(input, out) {
    const a = this.active;
    const meta = input.meta || {};
    if (!a || a.id !== String(meta.wakeId)) return;
    this.active = null;
    const now = this._now();
    // (an unverified wake that heard nothing more: its verdict no longer matters)
    if (a.kind === 'listening') this._log(now, 'no command', 'no-command');
    if (a.kind === 'barge') out.push({ type: 'unduck', rampMs: WAKE.unduckMs });
    if ((a.kind === 'listening' || a.kind === 'followup') && this.s.sounds === 'start-end') out.push({ type: 'earcon', name: 'done' });
    if (a.kind === 'listening' || a.kind === 'followup') out.push({ type: 'announce', text: 'Stopped listening' });
  }

  _cancelled(input, out) {
    const a = this.active;
    const meta = input.meta || {};
    if (!a || a.id !== String(meta.wakeId)) return;
    // push-to-talk, typing or Esc took over (T14), also while it was being transcribed: silently
    this.active = null;
    if (a.kind === 'barge') out.push({ type: 'unduck', rampMs: WAKE.unduckMs });
    if (a.held) out.push({ type: 'decision', id: a.id, decision: { action: 'drop', reason: 'cancelled' } });
  }

  _conversation(input) {
    this.conv = { ...this.conv, ...pick(input, ['state', 'speaking', 'kind', 'turnRunning']) };
  }

  _turnDone(info, out, now) {
    if (this._base.state !== 'waiting' || this.active) return;
    if (!(Number(this.s.followUpSec) > 0)) return;
    const turnId = info.turnId ? String(info.turnId) : '';
    // only after a reply to a voice turn, once per turn, never with a card waiting (FUP-1, FUP-5)
    if (!info.voiceTurn || !turnId || info.permissionPending || info.say || turnId === this.lastFollowTurn) return;
    // the camera says you walked away: TV speech must not slip in (FUP-6)
    const p = this.presence;
    if (p.camera && !p.present && now - p.lastFaceAt >= WAKE.followUpAbsentMs) return;
    this.lastFollowTurn = turnId;
    this._openFollowUp(Number(this.s.followUpSec) * 1000, out, now);
  }

  _openFollowUp(windowMs, out, now) {
    const id = `u${++this._ids}`;
    this.active = { kind: 'followup', id, verdict: 'none', show: true, phase: 'capture', windowEnd: now + windowMs, speechStarted: false };
    this.dimAt = now + Math.max(0, windowMs - WAKE.dimMs);
    this.dimOn = false;
    out.push({ type: 'capture', kind: 'followup', noSpeechMs: Math.round(windowMs), show: true, meta: { wakeId: id, kind: 'followup' } });
  }

  _presence(input, now) {
    const p = this.presence;
    p.camera = !!input.camera;
    p.present = !!input.present;
    if (p.present) p.lastFaceAt = now;
    const looking = p.present && !!input.looking;
    if (looking && !p.looking) {
      p.lookSince = now;
      p.lookLostAt = null;
    } else if (!looking && p.looking) {
      p.lookSince = null;
      p.lookLostAt = now;
    }
    p.looking = looking;
  }

  _manual(input, out, now) {
    if (this._base.state !== 'waiting') return;
    const a = this.active;
    if (a) {
      if (a.kind === 'listening' && a.phase === 'capture') return; // already listening
      if (a.phase === 'capture') out.push({ type: 'cancelCapture', meta: { wakeId: a.id } });
      if (a.kind === 'barge') out.push({ type: 'unduck', rampMs: 0 });
      if (a.held) out.push({ type: 'decision', id: a.id, decision: { action: 'drop', reason: 'manual' } });
    }
    const id = `m${++this._ids}`;
    this.active = { kind: 'listening', id, verdict: 'none', show: true, phase: 'capture', windowEnd: now + WAKE.commandWindowMs, speechStarted: false, from: input.from };
    this.lastVoiceAt = now;
    this._log(now, 'listening', 'manual');
    out.push({ type: 'capture', kind: 'command', noSpeechMs: WAKE.commandWindowMs, show: true, meta: { wakeId: id, kind: 'command' } });
    if (this.s.sounds !== 'off') out.push({ type: 'earcon', name: 'wake' });
    out.push({ type: 'announce', text: 'Listening' });
  }

  // ------------------------------------------------------------------------------------------

  /** Deadlines: the verification timeout, the strict timer, look-and-talk, the dimming. */
  _tick(out, now) {
    const a = this.active;
    if (a && a.verdict === 'pending' && now >= a.verifyDeadline) this._reject(a, 'timeout', out, now);
    const w = this.active;
    if (w && w.phase === 'capture' && !w.speechStarted && now >= w.windowEnd + WAKE.captureGraceMs) {
      // the controller never said how the capture ended: end it here
      if (w.kind === 'listening') this._log(now, 'no command', 'no-command');
      this._endEpisode(out, 'watchdog');
    }
    const d = this.active;
    if (d && d.phase === 'deciding' && Number.isFinite(d.decidingSince) && now >= d.decidingSince + WAKE.decideMaxMs) {
      // its transcript never came (the answer was lost): her name must work again
      this._endEpisode(out, 'watchdog');
    }
    const p = this.presence;
    const cur = this.active;
    if (this.s.lookToTalk && p.camera && this._base.state === 'waiting' && !this._base.fallback) {
      if (!cur && p.looking && p.lookSince != null && now - p.lookSince >= WAKE.lookDwellMs && this.conv.state === 'idle') {
        // look and talk: while you look at her, no name is needed (T9)
        const id = `l${++this._ids}`;
        this.active = { kind: 'look', id, verdict: 'none', show: true, phase: 'capture', windowEnd: Infinity, speechStarted: false };
        out.push({ type: 'capture', kind: 'look', noSpeechMs: Infinity, show: true, meta: { wakeId: id, kind: 'look' } });
      } else if (cur && cur.kind === 'look' && cur.phase === 'capture' && !cur.speechStarted && !p.looking && p.lookLostAt != null && now - p.lookLostAt >= WAKE.lookGraceMs) {
        this.active = null;
        out.push({ type: 'cancelCapture', meta: { wakeId: cur.id } });
      }
    }
    if (this.dimAt < Infinity) {
      const f = this.active;
      if (!f || f.kind !== 'followup') {
        this.dimAt = Infinity;
        if (this.dimOn) out.push({ type: 'dim', on: false });
        this.dimOn = false;
      } else if (!this.dimOn && now >= this.dimAt && !f.speechStarted) {
        this.dimOn = true;
        out.push({ type: 'dim', on: true });
      } else if (this.dimOn && f.speechStarted) {
        this.dimOn = false;
        out.push({ type: 'dim', on: false });
      }
    }
  }

  /** The base state from the flags; opens and releases the mic; reports changes. */
  _reconcile(out, now) {
    const prevState = this.state;
    const pre = this._computeBase(false);
    // an episode ends before the mic is released: its capture is cancelled first, so the device
    // can close at once instead of 20 s later (PRIV-5, PRIV-6: locked or off during a capture)
    if (pre.state !== 'waiting' && this.active) this._endEpisode(out, pre.state);
    // the microphone: open for her name, released otherwise (§2.4)
    const wantMic = pre.state === 'waiting' && !pre.fallback;
    if (!wantMic) {
      if (this.mic === 'open' || this.mic === 'opening') out.push({ type: 'releaseMic' });
      this.mic = 'closed';
      this.micRetryN = 0;
      this.micRetryAt = Infinity;
      this.muted = false;
    } else if (this.mic === 'closed') {
      this.mic = 'opening';
      out.push({ type: 'openMic', echo: 'all' });
    } else if (this.mic === 'blocked' && now >= this.micRetryAt) {
      // retry quietly at 5 s, 15 s, 60 s, then every 60 s (WIN-2); micError sets the next one
      this.micRetryAt = Infinity;
      out.push({ type: 'openMic', echo: 'all', retry: true });
    }
    this._base = this._computeBase();
    if (this._base.state === 'waiting' || this._base.state === 'muted') this._runAt = now;
    else if (this._base.state === 'off') this._runAt = -Infinity;
    if (this._base.state !== 'waiting' && this.active) this._endEpisode(out, this._base.state);
    if (this._base.state === 'waiting' && !this.muted && this.frozen && !this.active) {
      const f = this.frozen;
      this.frozen = null;
      if (f.remainingMs > 300) {
        if (f.kind === 'followup') this._openFollowUp(f.remainingMs, out, now);
        else {
          const id = `m${++this._ids}`;
          this.active = { kind: 'listening', id, verdict: 'none', show: true, phase: 'capture', windowEnd: now + f.remainingMs, speechStarted: false };
          out.push({ type: 'capture', kind: 'command', noSpeechMs: Math.round(f.remainingMs), show: true, meta: { wakeId: id, kind: 'command' } });
        }
      }
    }
    if (this._base.state !== 'waiting' && this._base.state !== 'muted') this.frozen = null;
    // strict mode on / off (the port switches the engine to the 'low' thresholds)
    const strict = this.strict;
    if (strict !== this._strictOn) {
      this._strictOn = strict;
      out.push({ type: 'setStrict', on: strict });
      if (!strict) this.burst = [];
    }
    const state = this.state;
    const key = `${state}|${this._base.reason}|${this._base.fallback ? 1 : 0}|${strict ? 1 : 0}`;
    if (key !== this._reported) {
      this._reported = key;
      out.push({ type: 'report', state, reason: this._base.reason, code: this._base.code, fallback: this._base.fallback, strict });
      if ((prevState === 'listening' || prevState === 'followup' || prevState === 'look') && (state === 'off' || state === 'paused' || state === 'locked')) {
        out.push({ type: 'announce', text: 'Stopped listening' });
      }
    }
  }

  /**
   * @param {boolean} [withMic] false: whether the mic is wanted at all (ignores its own state)
   * @returns {{ state: WakeUiState, reason: string, code: string, fallback: boolean }}
   */
  _computeBase(withMic = true) {
    const s = this.s;
    const a = this.avail;
    if (!s.enabled) return { state: 'off', reason: '', code: '', fallback: false };
    if (this.locked) return { state: 'locked', reason: 'Paused while the PC is locked', code: 'locked', fallback: false };
    if (this.hidden && !s.whileHidden) return { state: 'paused', reason: 'Paused while the window is hidden', code: 'hidden', fallback: false };
    if (a.stt === 'starting') return { state: 'starting', reason: a.sttReason || 'The local voice is starting', code: 'voice-starting', fallback: false };
    if (a.stt !== 'ready') return { state: 'unavailable', reason: a.sttReason || 'Hey Jade needs the local voice', code: 'no-voice', fallback: false };
    const engineBad = a.engine === 'missing' || a.engine === 'error';
    if (engineBad && !s.transcriptFallback) return { state: 'unavailable', reason: a.engineDetail || 'The wake-word engine is not available', code: 'engine', fallback: false };
    if (!engineBad && a.engine !== 'ready') return { state: 'starting', reason: a.engineDetail || 'The wake-word engine is starting', code: 'engine-starting', fallback: false };
    const fallback = engineBad;
    if (withMic && !fallback) {
      if (this.mic === 'blocked') return { state: 'blocked', reason: this.micReason, code: this.micCode || 'blocked', fallback };
      if (this.mic !== 'open') return { state: 'starting', reason: 'Opening the microphone', code: 'mic-opening', fallback };
      if (this.muted) return { state: 'muted', reason: 'The microphone is muted', code: 'muted', fallback };
    }
    return { state: 'waiting', reason: fallback ? 'Transcript check (the wake-word engine is not running)' : '', code: fallback ? 'fallback' : '', fallback };
  }

  /** Abort the episode in progress (the mic went away, the PC locked, wake turned off…). */
  _endEpisode(out, _why) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.phase === 'capture') out.push({ type: 'cancelCapture', meta: { wakeId: a.id } });
    if (a.kind === 'barge') out.push({ type: 'unduck', rampMs: WAKE.unduckMs });
    if (a.held) out.push({ type: 'decision', id: a.id, decision: { action: 'drop', reason: 'aborted' } });
  }

  _hint(id, out) {
    if (ONE_PER_RUN.has(id) && this.hints.has(id)) return;
    this.hints.add(id);
    out.push({ type: 'hint', id, text: /** @type {any} */ (HINTS)[id] });
  }

  /** @param {number} at @param {string} outcome @param {string} reason @param {number} [latencyMs] */
  _log(at, outcome, reason, latencyMs) {
    const entry = { at, outcome, reason, text: /** @type {any} */ (LOG_TEXT)[reason] || reason };
    if (Number.isFinite(latencyMs)) /** @type {any} */ (entry).latencyMs = Math.round(/** @type {number} */ (latencyMs));
    this.log.push(entry);
    if (this.log.length > WAKE.logSize) this.log.splice(0, this.log.length - WAKE.logSize);
  }
}

/** @param {Record<string, any>} o @param {string[]} keys */
function pick(o, keys) {
  /** @type {Record<string, any>} */
  const r = {};
  for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k];
  return r;
}
