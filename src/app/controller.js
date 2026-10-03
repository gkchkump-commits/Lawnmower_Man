// Conversation controller: the renderer's state machine (contract §7).
//
//   idle → listening (mic, VAD) → transcribing (/stt) → thinking (Claude turn, no text yet)
//        → speaking (text → sentence chunker → TTS queue → ordered playback → lip-sync) → idle
//
// Typed text enters at "thinking". New input while Claude is busy pre-empts the current reply
// (speech stops, the turn is interrupted). Barge-in (hotkey / mic click while speaking) stops
// playback, flushes the speech queue, interrupts the turn and starts listening. Hands-free mode
// keeps a VAD listening while idle and pauses it whenever the avatar thinks or speaks
// (half-duplex, so it never hears itself).
//
// Everything it talks to is injected, so it is unit-tested with fakes:
//   bridge  window.lawnmower (contract §3) or the mock
//   avatar  createAvatar() API (setState, setMouth, setSpeechLevel, blink) — optional
//   player  AudioPlayer (enqueue/stop/current/level/spectrum/on)
//   tts     { available(), mode(), synthesize(text, {signal}) }
//   stt     { available(), unavailableReason(), transcribe(wav, {signal}) }
//   mic     Mic (start/stop/cancel/pause/resume/level/on) — optional
//   view    UI callbacks (all optional; see ControllerView)

import { LipSync } from '../audio/lipsync.js';
import { isAbortError } from '../speech/voice-client.js';
import { Emitter } from './emitter.js';
import { spokenPermissionPrompt, summarizeToolInput, toolChipLabel, toolCue, clip } from './permission.js';
import { SentenceChunker } from './sentence-chunker.js';
import { withDefaults } from './settings-defaults.js';
import { SpeechQueue } from './speech-queue.js';
import { toSpeechText } from './speech-text.js';

/** @typedef {'idle'|'listening'|'transcribing'|'thinking'|'speaking'} ConversationState */
export const CONVERSATION_STATES = /** @type {const} */ (['idle', 'listening', 'transcribing', 'thinking', 'speaking']);

/** Conversation state → avatar state. */
export const AVATAR_STATE = Object.freeze({ idle: 'idle', listening: 'listening', transcribing: 'thinking', thinking: 'thinking', speaking: 'speaking' });

/** Whisper's classic outputs for noise/silence; ignored for short utterances. */
const HALLUCINATION = /^(?:thank you\.?|thanks for watching!?|thank you for watching!?|you\.?|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?)$/i;

/**
 * @typedef {object} ControllerView
 * @property {(s: ConversationState) => void} [setState]
 * @property {(text: string, o: { source: 'text'|'voice' }) => any} [addUserMessage]  returns a message id
 * @property {(id: any, status: 'failed', detail?: string) => void} [markUserMessage]
 * @property {(turnId: string) => void} [assistantStart]
 * @property {(turnId: string, delta: string, full: string) => void} [assistantDelta]
 * @property {(turnId: string, info: { isError: boolean, interrupted: boolean, result: string, empty: boolean, durationMs?: number, costUsd?: number }) => void} [assistantEnd]
 * @property {(turnId: string, message: string) => void} [assistantError]
 * @property {(turnId: string, tool: { id: string, name: string, input: object, label: string }) => void} [toolUse]
 * @property {(turnId: string, res: { id: string, isError: boolean, summary: string }) => void} [toolResult]
 * @property {(req: object) => void} [showPermission]
 * @property {(requestId: string, outcome: 'allowed'|'denied'|'expired') => void} [removePermission]
 * @property {(on: boolean) => void} [setAttention]
 * @property {(message: string, level?: 'info'|'warn'|'error'|'success') => void} [toast]
 * @property {(status: object) => void} [setClaudeStatus]
 * @property {(available: boolean, reason: string) => void} [setMicAvailable]
 * @property {(on: boolean) => void} [setHandsFree]
 * @property {(level: number) => void} [setMicLevel]
 * @property {(mode: string|null) => void} [setListening]
 * @property {() => void} [clearTranscript]
 * @property {(text: string) => void} [addNote]
 * @property {(on: boolean) => void} [setSleep]
 */

/** @param {unknown} err */
const errMsg = (err) => (err && typeof err === 'object' && 'message' in err ? String(/** @type {any} */ (err).message) : String(err || 'unknown error'));

export class Controller extends Emitter {
  /**
   * @param {object} deps
   * @param {any} deps.bridge
   * @param {any} [deps.avatar]
   * @param {any} deps.player
   * @param {any} deps.tts
   * @param {any} deps.stt
   * @param {any} [deps.mic]
   * @param {ControllerView} [deps.view]
   * @param {any} [deps.settings]
   * @param {SpeechQueue} [deps.speechQueue]
   * @param {LipSync} [deps.lipsync]
   * @param {() => number} [deps.now]  milliseconds clock
   * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
   * @param {(id: any) => void} [deps.clearTimeout]
   * @param {number} [deps.sleepAfterMs]  idle time before the avatar dozes off (default 10 min; 0 = never)
   */
  constructor(deps) {
    super();
    this.bridge = deps.bridge;
    this.avatar = deps.avatar || null;
    this.player = deps.player;
    this.tts = deps.tts;
    this.stt = deps.stt;
    this.mic = deps.mic || null;
    /** @type {ControllerView} */
    this.view = deps.view || {};
    this.settings = withDefaults(deps.settings);
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()));
    this._setTimeout = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = deps.clearTimeout || ((id) => clearTimeout(id));
    this.sleepAfterMs = deps.sleepAfterMs ?? 10 * 60 * 1000;
    this.speech = deps.speechQueue || new SpeechQueue({ tts: this.tts, player: this.player });
    this.lipsync = deps.lipsync || new LipSync({ player: this.player, now: () => this._now() / 1000 });

    /** @type {ConversationState} */
    this.state = 'idle';
    /** @type {Map<string, any>} */
    this.turns = new Map();
    /** @type {string|null} */
    this.activeTurnId = null;
    this.pendingSends = 0;
    /** @type {Map<string, { requestId: string, turnId: string|null, toolName: string, input: object }>} */
    this.permissions = new Map();
    /** @type {null | { mode: 'ptt'|'utterance' }} */
    this.listen = null;
    this.handsFree = false;
    this.claudeStatus = /** @type {Record<string, any>} */ ({ status: 'starting' });

    this._offs = /** @type {Array<() => void>} */ ([]);
    this._userMsgByTurn = new Map();
    this._errorFlash = false;
    this._errorTimer = null;
    this._resumeTimer = null;
    this._thinkTimer = null;
    this._mouthActive = false;
    /** @type {AbortController|null} */
    this._sttAbort = null;
    /** @type {Promise<boolean>|null} */
    this._micStarting = null;
    this._lastSpeechErrorAt = -Infinity;
    this._lastActivity = this._now();
    this.sleeping = false;
    this._started = false;
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle

  /** Subscribe to the bridge, speech queue and mic; fetch the current Claude status. */
  async start() {
    if (this._started) return;
    this._started = true;
    const b = this.bridge;
    this._offs.push(b.claude.onEvent((ev) => this.handleClaudeEvent(ev)));
    this._offs.push(this.speech.on('playing', () => this._onSpeechPlaying()));
    this._offs.push(this.speech.on('idle', () => this._maybeIdle()));
    this._offs.push(this.speech.on('error', (err) => this._onSpeechError(err)));
    if (this.mic) {
      this._offs.push(this.mic.on('utterance', (u) => this._onMicUtterance(u)));
      this._offs.push(this.mic.on('speechstart', () => this._onMicSpeechStart()));
      this._offs.push(this.mic.on('discard', (d) => this._onMicDiscard(d)));
      this._offs.push(this.mic.on('error', (err) => this._onMicError(err)));
    }
    this.view.setState?.(this.state);
    this.avatar?.setState?.(AVATAR_STATE[this.state]);
    try {
      // status events sent before the page loaded are not replayed: ask once
      const st = await b.claude.status();
      if (st && typeof st === 'object') {
        this.claudeStatus = { ...this.claudeStatus, ...st };
        this.view.setClaudeStatus?.(this.claudeStatus);
        if (st.status === 'error') this._toast(st.detail || 'The Claude CLI is not available.', 'error');
        if (st.sessionId) this._noteResumed(st.sessionId);
      }
    } catch (err) {
      console.warn('[controller] claude.status() failed', err);
    }
    this.voiceChanged();
  }

  dispose() {
    for (const off of this._offs) {
      try { off(); } catch { /* ignore */ }
    }
    this._offs = [];
    this._clearTimeout(this._errorTimer);
    this._clearTimeout(this._resumeTimer);
    this._clearTimeout(this._thinkTimer);
    this._sttAbort?.abort();
    this.speech.clear();
    this.lipsync.dispose?.();
    this.mic?.cancel?.();
    this.removeAllListeners();
  }

  /**
   * New settings (from bridge.settings.onChange).
   * @param {any} settings
   */
  applySettings(settings) {
    const prev = this.settings;
    this.settings = withDefaults(settings);
    if (prev.voice.speakReplies && !this.settings.voice.speakReplies && this.speech.busy) this.stopSpeaking();
    this._syncHandsFree();
  }

  /** The voice server status / capabilities changed (after the VoiceClient was reconfigured). */
  voiceChanged() {
    const sttOk = !!this.mic && this.stt.available();
    this.view.setMicAvailable?.(sttOk, sttOk ? '' : (this.mic ? this.stt.unavailableReason?.() || 'Voice input is unavailable.' : 'No microphone support in this window.'));
    this._syncHandsFree();
  }

  /** Swap the avatar (renderer change). @param {any} avatar */
  setAvatar(avatar) {
    this.avatar = avatar || null;
    this.avatar?.setState?.(this._errorFlash ? 'error' : this.sleeping ? 'sleep' : AVATAR_STATE[this.state]);
  }

  // ------------------------------------------------------------------------------------------
  // user actions

  /**
   * Send a user message (typed, or transcribed speech).
   * @param {string} text @param {{ source?: 'text'|'voice' }} [o]
   * @returns {boolean} false when the text was empty
   */
  sendText(text, o = {}) {
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!clean) return false;
    this.noteActivity();
    if (this.listen) this._cancelListening();
    if (this.activeTurnId || this.pendingSends > 0 || this.speech.busy) this._preempt();
    const msgId = this.view.addUserMessage?.(clean, { source: o.source || 'text' });
    this.pendingSends++;
    this._setState('thinking');
    Promise.resolve()
      .then(() => this.bridge.claude.send(clean))
      .then((r) => {
        if (!r || typeof r.turnId !== 'string') return;
        this._userMsgByTurn.set(r.turnId, msgId);
        const t = this.turns.get(r.turnId);
        if (t) t.userMsgId = msgId;
      }, (err) => {
        this.pendingSends = Math.max(0, this.pendingSends - 1);
        this.view.markUserMessage?.(msgId, 'failed', errMsg(err));
        this._toast(`Could not send the message: ${errMsg(err)}`, 'error');
        this._flashError();
        this._maybeIdle();
      });
    return true;
  }

  /**
   * Start listening. mode 'utterance' ends automatically at the end of speech; 'ptt' records
   * until stopListening().
   * @param {'ptt'|'utterance'} [mode]
   * @returns {Promise<boolean>}
   */
  startListening(mode = 'utterance') {
    this.noteActivity();
    if (!this.mic || !this.stt.available()) {
      this._toast(this.stt.unavailableReason?.() || 'Voice input is unavailable.', 'info');
      return Promise.resolve(false);
    }
    if (this.listen) return this._micStarting || Promise.resolve(true);
    // barge-in: stop talking and stop the current reply
    if (this.speech.busy || this.activeTurnId) this._preempt();
    this._sttAbort?.abort();
    const l = { mode };
    this.listen = l;
    this._setState('listening');
    this.view.setListening?.(mode);
    const p = Promise.resolve()
      .then(() => this.mic.start(mode))
      .then(() => true, (err) => {
        if (this.listen === l) {
          this.listen = null;
          this.view.setListening?.(null);
          this._toast(errMsg(err), 'error');
          this._flashError();
          this._setState('idle');
          this._maybeIdle();
        }
        return false;
      })
      .finally(() => {
        if (this._micStarting === p) this._micStarting = null;
      });
    this._micStarting = p;
    return p;
  }

  /** Finish listening (push-to-talk released / mic clicked again) and transcribe. */
  async stopListening() {
    const l = this.listen;
    if (!l) return;
    if (this._micStarting) {
      const ok = await this._micStarting;
      if (!ok) return;
    }
    if (this.listen !== l) return;
    this.listen = null;
    this.view.setListening?.(null);
    let res = null;
    try {
      res = await this.mic.stop();
    } catch (err) {
      this._toast(errMsg(err), 'error');
    }
    if (!res) {
      this._toast("I didn't hear anything.", 'info');
      this._setState('idle');
      this._maybeIdle();
      return;
    }
    await this._transcribe(res);
  }

  /** Hotkey / mic-button toggle: stop+send while listening; barge in while busy; else listen. */
  toggleListening() {
    this.noteActivity();
    if (this.listen) return this.stopListening();
    const busy = this.speech.busy || !!this.activeTurnId;
    if (!this.mic || !this.stt.available()) {
      // no voice input: the hotkey still stops a reply; otherwise explain how to enable it
      if (busy) this.interrupt();
      else this._toast(this.stt.unavailableReason?.() || 'Voice input is unavailable.', 'info');
      return Promise.resolve();
    }
    if (this.handsFree && !busy && this.state === 'idle') {
      this._toast('Hands-free listening is on — just start talking.', 'info');
      return Promise.resolve();
    }
    return this.bargeIn();
  }

  /** Stop speaking, interrupt the reply and listen (or just stop when voice input is off). */
  async bargeIn() {
    this.noteActivity();
    this._preempt();
    if (this.handsFree) {
      this._maybeIdle();
      return;
    }
    if (this.mic && this.stt.available()) await this.startListening('utterance');
    else this._maybeIdle();
  }

  /**
   * Stop the voice; the reply keeps streaming into the chat but is no longer spoken.
   * @returns {boolean} false when nothing was being spoken
   */
  stopSpeaking() {
    this.noteActivity();
    if (!this.speech.busy) return false;
    this._silenceTurns();
    this.speech.clear();
    this._maybeIdle();
    return true;
  }

  /** Stop the current reply entirely (speech and the Claude turn). @returns {boolean} */
  interrupt() {
    this.noteActivity();
    const busy = !!this.activeTurnId || this.speech.busy;
    this._preempt();
    this._maybeIdle();
    return busy;
  }

  /** Cancel listening/transcribing without sending anything. */
  cancelListening() {
    if (!this.listen && this.state !== 'transcribing') return false;
    this._cancelListening();
    this._setState('idle');
    this._maybeIdle();
    return true;
  }

  /**
   * Answer a permission card.
   * @param {string} requestId @param {boolean} allow
   */
  async respondPermission(requestId, allow) {
    this.noteActivity();
    const p = this.permissions.get(requestId);
    if (!p) return false;
    this.permissions.delete(requestId);
    this.view.removePermission?.(requestId, allow ? 'allowed' : 'denied');
    if (!this.permissions.size) this.view.setAttention?.(false);
    const decision = allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: 'The user denied this action.' };
    try {
      await this.bridge.claude.respondPermission(requestId, decision);
      return true;
    } catch (err) {
      this._toast(`That request is no longer active (${errMsg(err)}).`, 'warn');
      return false;
    }
  }

  /** Start a fresh conversation. */
  async newConversation() {
    this.noteActivity();
    this._cancelListening();
    this._preempt();
    try {
      await this.bridge.claude.reset();
    } catch (err) {
      this._toast(`Could not start a new conversation: ${errMsg(err)}`, 'error');
    }
  }

  /** Pointer/keyboard activity: wakes the avatar and postpones sleep. */
  noteActivity() {
    this._lastActivity = this._now();
    if (this.sleeping) {
      this.sleeping = false;
      this.view.setSleep?.(false);
      if (!this._errorFlash) this.avatar?.setState?.(AVATAR_STATE[this.state]);
    }
  }

  /**
   * Per-frame update: lip-sync → avatar, mic level → view, sleep timer.
   * @param {number} dt seconds since last tick @param {number} [nowSec]
   */
  tick(dt, nowSec = this._now() / 1000) {
    if (this.player.current || this._mouthActive) {
      const m = this.lipsync.update(dt, nowSec);
      if (this.player.current) this._mouthActive = true;
      else if (m.jaw < 0.01 && m.level < 0.01) this._mouthActive = false;
      if (this.avatar) {
        this.avatar.setMouth?.(this._mouthActive ? { jaw: m.jaw, wide: m.wide, round: m.round } : { jaw: 0, wide: 0, round: 0 });
        this.avatar.setSpeechLevel?.(this._mouthActive ? m.level : 0);
      }
    }
    if (this.mic && (this.listen || this.handsFree)) this.view.setMicLevel?.(this.mic.paused ? 0 : this.mic.level || 0);
    if (this.sleepAfterMs > 0 && !this.sleeping && this.state === 'idle' && !this.listen && !this.permissions.size
      && this._now() - this._lastActivity > this.sleepAfterMs) {
      this.sleeping = true;
      this.view.setSleep?.(true);
      if (!this._errorFlash) this.avatar?.setState?.('sleep');
    }
  }

  // ------------------------------------------------------------------------------------------
  // Claude events

  /** @param {any} ev a ClaudeEvent (contract §3.1) */
  handleClaudeEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'status': return this._onStatus(ev);
      case 'session': return this._onSession(ev);
      case 'turn_start': return this._onTurnStart(ev);
      case 'text_delta': return this._onTextDelta(ev);
      case 'thinking':
        this._busyThinking();
        return undefined;
      case 'tool_use': return this._onToolUse(ev);
      case 'tool_result':
        this.view.toolResult?.(ev.turnId, { id: String(ev.id || ''), isError: !!ev.isError, summary: String(ev.summary || '') });
        return undefined;
      case 'permission_request': return this._onPermission(ev);
      case 'message_end': {
        const t = this.turns.get(ev.turnId);
        if (t && this._speaks(t)) this._enqueue(t, t.chunker.flush());
        return undefined;
      }
      case 'turn_end': return this._onTurnEnd(ev);
      case 'error': return this._onError(ev);
      default: return undefined; // unknown event types are ignored
    }
  }

  _onStatus(ev) {
    this.claudeStatus = { ...this.claudeStatus, status: ev.status, detail: ev.detail || '' };
    this.view.setClaudeStatus?.(this.claudeStatus);
    if (ev.status === 'restarting' || ev.status === 'exited' || ev.status === 'error') this._dropAllPermissions();
    if (ev.status === 'error') {
      this._toast(ev.detail || 'The Claude CLI reported an error.', 'error');
      this._flashError();
    }
  }

  _onSession(ev) {
    if (!ev.sessionId) {
      // reset (from the app or the tray): forget the conversation
      this._silenceTurns();
      this.speech.clear();
      this.turns.clear();
      this._userMsgByTurn.clear();
      this.activeTurnId = null;
      this.pendingSends = 0;
      this._dropAllPermissions();
      this.view.clearTranscript?.();
      this._maybeIdle();
    }
    this.claudeStatus = { ...this.claudeStatus, sessionId: ev.sessionId || '', model: ev.model || this.claudeStatus.model };
    this.view.setClaudeStatus?.(this.claudeStatus);
    if (ev.sessionId) this._noteResumed(ev.sessionId);
  }

  /**
   * The first session of this window: if it is the persisted one, the CLI resumed the previous
   * conversation (Claude remembers it, but this window shows no history), so say so.
   * @param {string} sessionId
   */
  _noteResumed(sessionId) {
    if (this._sessionNoted) return;
    this._sessionNoted = true;
    const c = this.settings.claude;
    if (c.resumeLastSession && c.lastSessionId && sessionId === c.lastSessionId && this.turns.size === 0) {
      this.view.addNote?.('Continuing your previous conversation');
    }
  }

  _onTurnStart(ev) {
    const t = this._turn(ev.turnId);
    if (!t.started) {
      t.started = true;
      this.pendingSends = Math.max(0, this.pendingSends - 1);
      this.view.assistantStart?.(ev.turnId);
    }
    if (t.userMsgId === undefined) t.userMsgId = this._userMsgByTurn.get(ev.turnId);
    this.activeTurnId = ev.turnId;
    if (this.state !== 'speaking' && !this.listen && this.state !== 'transcribing') this._setState('thinking');
  }

  _onTextDelta(ev) {
    if (typeof ev.text !== 'string' || !ev.text) return;
    const t = this._turn(ev.turnId);
    if (!t.started) {
      t.started = true;
      this.view.assistantStart?.(ev.turnId);
    }
    t.text += ev.text;
    t.gotText = true;
    this.view.assistantDelta?.(ev.turnId, ev.text, t.text);
    if (this._speaks(t)) {
      this._enqueue(t, t.chunker.push(ev.text));
    } else if (!t.silenced && ev.turnId === this.activeTurnId && !this.listen && this.state !== 'transcribing' && !this._ttsWanted()) {
      // text-only replies: "speaking" while the text streams
      this._setState('speaking');
    }
  }

  _onToolUse(ev) {
    const t = this._turn(ev.turnId);
    t.tools++;
    const name = String(ev.name || '');
    const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
    this.view.toolUse?.(ev.turnId, { id: String(ev.id || ''), name, input, label: toolChipLabel(name, input) });
    this._busyThinking();
    // a short spoken cue when Claude goes straight to a tool without saying anything
    if (this._speaks(t) && !t.cueSaid && !t.spoke && !this.speech.busy) {
      t.cueSaid = true;
      this.speech.push(toolCue(name), { turnId: t.id, kind: 'cue' });
    }
  }

  _onPermission(ev) {
    if (typeof ev.requestId !== 'string' || !ev.requestId) return;
    const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
    const toolName = String(ev.toolName || 'tool');
    const turnId = typeof ev.turnId === 'string' ? ev.turnId : null;
    this.permissions.set(ev.requestId, { requestId: ev.requestId, turnId, toolName, input });
    this.view.showPermission?.({
      requestId: ev.requestId,
      turnId,
      toolName,
      input,
      description: typeof ev.description === 'string' ? ev.description : '',
      summary: summarizeToolInput(toolName, input),
    });
    this.view.setAttention?.(true);
    this.noteActivity();
    this.avatar?.blink?.();
    const t = turnId ? this._turn(turnId) : null;
    if (this.settings.voice.speakReplies && this.tts.available() && !(t && t.silenced)) {
      if (t) this._enqueue(t, t.chunker.flush()); // what was said before the request comes first
      this.speech.push(spokenPermissionPrompt(toolName, input), { turnId, kind: 'prompt' });
    }
    this._busyThinking();
    this.emit('permission', ev);
  }

  _onTurnEnd(ev) {
    const t = this._turn(ev.turnId);
    t.ended = true;
    const result = typeof ev.result === 'string' ? ev.result : '';
    if (!t.gotText && result && !ev.isError) {
      // nothing streamed (rare): show and speak the final result instead
      if (!t.started) {
        t.started = true;
        this.view.assistantStart?.(ev.turnId);
      }
      t.text = result;
      t.gotText = true;
      this.view.assistantDelta?.(ev.turnId, result, result);
      if (this._speaks(t)) this._enqueue(t, t.chunker.push(result));
    }
    if (this._speaks(t)) this._enqueue(t, t.chunker.flush());
    this.view.assistantEnd?.(ev.turnId, {
      isError: !!ev.isError,
      interrupted: !!ev.interrupted || t.silenced,
      result,
      empty: !t.gotText,
      durationMs: ev.durationMs,
      costUsd: ev.costUsd,
    });
    for (const [id, p] of this.permissions) if (p.turnId === ev.turnId) this._dropPermission(id);
    if (ev.isError && !ev.interrupted && !t.silenced && !(t.errorShown && !result)) {
      this._toast(result ? `Claude: ${clip(result, 240)}` : 'Claude could not finish this reply.', 'error');
      this._flashError();
    }
    if (this.activeTurnId === ev.turnId) this.activeTurnId = null;
    this._pruneTurns();
    this._maybeIdle();
  }

  _onError(ev) {
    const msg = typeof ev.message === 'string' && ev.message ? ev.message : 'Something went wrong.';
    if (typeof ev.turnId === 'string' && ev.turnId) {
      const t = this.turns.get(ev.turnId);
      if (!t || !t.started) {
        // a queued message that was dropped before it started
        this.pendingSends = Math.max(0, this.pendingSends - 1);
        const msgId = this._userMsgByTurn.get(ev.turnId);
        if (msgId !== undefined) this.view.markUserMessage?.(msgId, 'failed', msg);
        this.turns.delete(ev.turnId);
      } else {
        t.errorShown = true;
        this.view.assistantError?.(ev.turnId, msg);
      }
    }
    this._toast(msg, 'error');
    this._flashError();
    this._maybeIdle();
  }

  // ------------------------------------------------------------------------------------------
  // speech

  /** Speech output is wanted (enabled and possible). */
  _ttsWanted() {
    return !!this.settings.voice.speakReplies && this.tts.available();
  }

  /** @param {any} t */
  _speaks(t) {
    return !t.silenced && this._ttsWanted();
  }

  /** @param {any} t @param {string[]} chunks */
  _enqueue(t, chunks) {
    for (const c of chunks) {
      const text = toSpeechText(c);
      if (!text) continue;
      t.spoke = true;
      this.speech.push(text, { turnId: t.id, kind: 'reply' });
    }
  }

  _onSpeechPlaying() {
    if (this.listen || this.state === 'transcribing') return;
    this._setState('speaking');
  }

  /** @param {Error} err */
  _onSpeechError(err) {
    const now = this._now();
    if (now - this._lastSpeechErrorAt > 30000) {
      this._lastSpeechErrorAt = now;
      this._toast(`Voice output failed: ${errMsg(err)}`, 'warn');
    }
  }

  _silenceTurns() {
    for (const t of this.turns.values()) t.silenced = true;
  }

  /** New input while busy: silence everything and interrupt the running turn. */
  _preempt() {
    this._silenceTurns();
    this.speech.clear();
    if (this.activeTurnId) {
      Promise.resolve()
        .then(() => this.bridge.claude.interrupt())
        .catch((err) => console.warn('[controller] interrupt failed', err));
    }
  }

  // ------------------------------------------------------------------------------------------
  // voice input

  _cancelListening() {
    if (this.listen) {
      this.listen = null;
      this.view.setListening?.(null);
      try { this.mic?.cancel(); } catch { /* ignore */ }
    }
    if (this._sttAbort) {
      this._sttAbort.abort();
      this._sttAbort = null;
    }
  }

  /** @param {{ wav: ArrayBuffer, durationMs: number, speechMs: number }} u */
  _onMicUtterance(u) {
    if (this.listen && this.listen.mode === 'utterance') {
      this.listen = null;
      this.view.setListening?.(null);
    } else if (!this.handsFree || this.listen) {
      return; // stray event (e.g. after cancel)
    }
    if (this.handsFree) this.mic.pause();
    this._transcribe(u);
  }

  _onMicSpeechStart() {
    if (this.handsFree && !this.listen && this.state === 'idle') this._setState('listening');
  }

  /** @param {{ reason: string }} d */
  _onMicDiscard(d) {
    if (d?.reason === 'no-speech' && this.listen?.mode === 'utterance') {
      this.listen = null;
      this.view.setListening?.(null);
      this._toast("I didn't hear anything.", 'info');
      this._setState('idle');
      this._maybeIdle();
    } else if (this.handsFree && !this.listen && this.state === 'listening') {
      this._setState('idle');
    }
  }

  /** @param {Error} err */
  _onMicError(err) {
    this._toast(errMsg(err), 'error');
    if (this.listen) {
      this.listen = null;
      this.view.setListening?.(null);
      this._setState('idle');
    }
    this._maybeIdle();
  }

  /** @param {{ wav: ArrayBuffer, durationMs: number, speechMs: number }} u */
  async _transcribe(u) {
    this._setState('transcribing');
    const ctrl = new AbortController();
    this._sttAbort = ctrl;
    let text = '';
    try {
      const r = await this.stt.transcribe(u.wav, { signal: ctrl.signal });
      text = String(r?.text || '').trim();
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err)) return;
      this._sttAbort = null;
      this._toast(`Speech recognition failed: ${errMsg(err)}`, 'error');
      this._flashError();
      this._setState('idle');
      this._maybeIdle();
      return;
    }
    if (ctrl.signal.aborted) return;
    this._sttAbort = null;
    if (!text || (HALLUCINATION.test(text) && (u.speechMs || 0) < 1500)) {
      this._toast("Sorry, I didn't catch that.", 'info');
      this._setState('idle');
      this._maybeIdle();
      return;
    }
    this.sendText(text, { source: 'voice' });
  }

  _syncHandsFree() {
    const want = !!this.settings.voice.handsFree && !!this.mic && this.stt.available();
    if (want !== this.handsFree) {
      this.handsFree = want;
      this.view.setHandsFree?.(want);
      if (!want && this.mic && this.mic.mode === 'handsfree') this.mic.cancel();
    }
    if (want) this._armHandsFree();
  }

  _armHandsFree() {
    if (!this.handsFree || !this.mic || this.listen) return;
    if (this.state !== 'idle') {
      if (this.mic.mode === 'handsfree') this.mic.pause();
      return;
    }
    if (this.mic.mode === 'handsfree') {
      this.mic.resume();
      return;
    }
    if (this.mic.mode) return; // another capture in progress
    Promise.resolve()
      .then(() => this.mic.start('handsfree'))
      .catch((err) => {
        this._toast(errMsg(err), 'error');
        this.handsFree = false;
        this.view.setHandsFree?.(false);
      });
  }

  // ------------------------------------------------------------------------------------------
  // state

  /** @param {ConversationState} s */
  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (this._thinkTimer) {
      this._clearTimeout(this._thinkTimer);
      this._thinkTimer = null;
    }
    if (s !== 'idle') this.noteActivity();
    this.view.setState?.(s);
    if (!this._errorFlash && !this.sleeping) this.avatar?.setState?.(AVATAR_STATE[s]);
    // half-duplex: hands-free listening pauses while the avatar is busy
    if (this.handsFree && this.mic && s !== 'idle' && s !== 'listening' && this.mic.mode === 'handsfree') this.mic.pause();
    this.emit('state', s);
  }

  _maybeIdle() {
    if (this.listen || this.state === 'transcribing') return;
    if (this.activeTurnId || this.pendingSends > 0) {
      // The reply is still running. If the voice has caught up (or was stopped), show
      // "thinking" — after a short delay, so the gap between two sentences doesn't flicker.
      if (this.state === 'speaking' && !this.speech.busy) {
        const t = this.activeTurnId ? this.turns.get(this.activeTurnId) : null;
        const textOnly = !this._ttsWanted() && !!t && !t.silenced;
        if (!textOnly) this._deferThinking(t && t.silenced ? 0 : 600);
      }
      return;
    }
    if (this.speech.busy) return;
    this._setState('idle');
    if (this.handsFree) {
      this._clearTimeout(this._resumeTimer);
      // short tail so the end of our own audio is not picked up
      this._resumeTimer = this._setTimeout(() => this._armHandsFree(), 350);
    }
  }

  /** @param {number} ms */
  _deferThinking(ms) {
    if (this._thinkTimer) return;
    const run = () => {
      this._thinkTimer = null;
      if (this.state === 'speaking' && !this.speech.busy && (this.activeTurnId || this.pendingSends > 0)) this._setState('thinking');
    };
    if (ms <= 0) run();
    else this._thinkTimer = this._setTimeout(run, ms);
  }

  /** Claude is working (thinking, tools, permission) — unless we are audibly speaking. */
  _busyThinking() {
    if (this.listen || this.state === 'transcribing') return;
    if (this.state === 'speaking' && this.speech.busy) return;
    this._setState('thinking');
  }

  _flashError() {
    if (!this.avatar) return;
    this._errorFlash = true;
    this.avatar.setState?.('error');
    this._clearTimeout(this._errorTimer);
    this._errorTimer = this._setTimeout(() => {
      this._errorFlash = false;
      this.avatar?.setState?.(this.sleeping ? 'sleep' : AVATAR_STATE[this.state]);
    }, 1400);
  }

  /** @param {string} message @param {'info'|'warn'|'error'|'success'} [level] */
  _toast(message, level = 'info') {
    this.view.toast?.(message, level);
    this.emit('toast', { message, level });
  }

  _dropAllPermissions() {
    for (const id of [...this.permissions.keys()]) this._dropPermission(id);
  }

  /** @param {string} id */
  _dropPermission(id) {
    if (!this.permissions.delete(id)) return;
    this.view.removePermission?.(id, 'expired');
    if (!this.permissions.size) this.view.setAttention?.(false);
  }

  /** @param {string} turnId */
  _turn(turnId) {
    const id = String(turnId || 'turn-unknown');
    let t = this.turns.get(id);
    if (!t) {
      t = { id, text: '', chunker: new SentenceChunker(), started: false, ended: false, silenced: false, gotText: false, spoke: false, cueSaid: false, tools: 0, userMsgId: undefined };
      this.turns.set(id, t);
    }
    return t;
  }

  _pruneTurns() {
    if (this.turns.size <= 40) return;
    for (const [id, t] of this.turns) {
      if (this.turns.size <= 20) break;
      if (t.ended && id !== this.activeTurnId) {
        this.turns.delete(id);
        this._userMsgByTurn.delete(id);
      }
    }
  }
}
