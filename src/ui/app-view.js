// AppView: the DOM side of the app — implements the controller's view callbacks
// (src/app/controller.js ControllerView) on top of the transcript, permission cards, toasts,
// status line and composer, and keeps body[data-*] attributes in sync for CSS:
//   data-state      idle | listening | transcribing | thinking | speaking
//   data-chat       full | minimal (no chat strip; the panel floats over the avatar)
//   data-panel      shown | hidden (minimal mode auto-hides the panel when idle)
//   data-attention  permission (a card is waiting)
//   data-listen     ptt | utterance while the mic records
//   data-handsfree  true when hands-free listening is armed
//   data-sleep      true when the avatar dozes

import { claudeSetupModel, voiceManualModel } from '../app/setup-help.js';
import { PermissionCards } from './permission-cards.js';
import { SetupCards } from './setup-cards.js';
import { StatusLine } from './status.js';
import { Toasts } from './toasts.js';
import { Transcript } from './transcript.js';

const HIDE_AFTER_MS = 6000;

export class AppView {
  /**
   * @param {{ body: HTMLElement, transcript: HTMLElement, cards: HTMLElement, toasts: HTMLElement, status: HTMLElement }} dom
   * @param {{ onPermission: (requestId: string, allow: boolean) => void, composer?: import('./composer.js').Composer,
   *   onRetryClaude?: () => Promise<void>, platform?: string }} o
   */
  constructor(dom, o) {
    this.dom = dom;
    this.composer = o.composer || null;
    this.transcript = new Transcript(dom.transcript, {
      onCopied: (ok) => this.toast(ok ? 'Copied to the clipboard.' : 'Could not copy to the clipboard.', ok ? 'success' : 'warn'),
    });
    this.cards = new PermissionCards(dom.cards, { onDecision: o.onPermission });
    this.platform = o.platform || 'linux';
    this.setup = new SetupCards(dom.cards, {
      onRetry: () => (o.onRetryClaude ? o.onRetryClaude() : Promise.resolve()),
      onCopied: (ok) => this.toast(ok ? 'Copied — paste it into the terminal.' : 'Could not copy to the clipboard.', ok ? 'success' : 'warn'),
    });
    this.toasts = new Toasts(dom.toasts);
    this.status = new StatusLine(dom.status);
    /** @type {Map<string, { turnId: string|null, toolName: string }>} */
    this._perm = new Map();
    this.state = 'idle';
    this.mode = 'full';
    this._lastPointer = 0;
    this._hideTimer = 0;
    this._micLevel = -1;
    this.voiceInfo = { status: 'stopped' };
    this.set('state', 'idle');
    this.set('panel', 'shown');
  }

  /** @param {string} key @param {string|boolean} value */
  set(key, value) {
    const v = String(value);
    if (this.dom.body.dataset[key] !== v) this.dom.body.dataset[key] = v;
  }

  // ---------------------------------------------------------------- controller view callbacks

  /** @param {string} s */
  setState(s) {
    this.state = s;
    this.set('state', s);
    this.status.setState(s);
    this.composer?.setBusy(s === 'thinking' || s === 'speaking' || s === 'transcribing');
    this.refreshPanel();
  }

  addUserMessage(text, o) {
    return this.transcript.addUser(text, o);
  }

  markUserMessage(id, status, detail) {
    this.transcript.markUser(id, status, detail);
  }

  assistantStart(turnId) {
    this.transcript.startAssistant(turnId);
  }

  assistantDelta(turnId, delta) {
    this.transcript.appendAssistant(turnId, delta);
  }

  assistantEnd(turnId, info) {
    this.transcript.endAssistant(turnId, info);
  }

  assistantError(turnId, message) {
    this.transcript.errorAssistant(turnId, message);
  }

  toolUse(turnId, tool) {
    this.transcript.addTool(turnId, tool);
  }

  toolResult(turnId, r) {
    this.transcript.toolResult(turnId, r);
  }

  showPermission(req) {
    this._perm.set(req.requestId, { turnId: req.turnId, toolName: req.toolName });
    this.cards.show(req);
    this.refreshPanel();
  }

  removePermission(requestId, outcome) {
    const p = this._perm.get(requestId);
    this._perm.delete(requestId);
    this.cards.remove(requestId, outcome);
    if (p && p.turnId && (outcome === 'allowed' || outcome === 'denied')) {
      this.transcript.noteInTurn(p.turnId, `${outcome === 'allowed' ? 'Allowed' : 'Denied'}: ${p.toolName}`);
    }
  }

  setAttention(on) {
    this.set('attention', on ? 'permission' : '');
    this.refreshPanel();
  }

  toast(message, level = 'info') {
    this.toasts.show(message, level);
  }

  setClaudeStatus(st) {
    this.status.setClaude(st);
  }

  /** First-run card for a missing or logged-out Claude CLI (null hides it). @param {{ kind: string, detail: string }|null} problem */
  setClaudeProblem(problem) {
    this.setup.show('claude', problem ? claudeSetupModel(problem, this.platform) : null);
    this.set('setup', problem ? problem.kind : '');
    this.refreshPanel();
  }

  /** The voice setup has to be run by hand: show its command (null hides the card). @param {any} setup VoiceInfo.setup */
  setVoiceSetup(setup) {
    this.setup.show('voice', setup && setup.state === 'manual' ? voiceManualModel(setup) : null);
  }

  /** @param {any} info @param {{ tts: any, stt: boolean }} caps */
  setVoiceStatus(info, caps) {
    this.voiceInfo = info;
    this.status.setVoice(info, caps);
  }

  setMicAvailable(ok, reason) {
    this.composer?.setMicAvailable(ok, reason);
    this.set('mic', ok ? 'available' : 'unavailable');
  }

  setHandsFree(on) {
    this.set('handsfree', !!on);
    this.status.setHandsFree(on);
  }

  setMicLevel(level) {
    const l = Math.round(Math.min(1, Math.max(0, level)) * 20) / 20;
    if (l === this._micLevel) return;
    this._micLevel = l;
    this.dom.body.style.setProperty('--mic-level', String(l));
  }

  setListening(mode) {
    this.set('listen', mode || '');
    if (!mode) this.setMicLevel(0);
  }

  clearTranscript() {
    this.transcript.clear();
    this.cards.clear();
    this._perm.clear();
    this.transcript.note('New conversation');
  }

  /** @param {string} text */
  addNote(text) {
    this.transcript.note(text);
  }

  setSleep(on) {
    this.set('sleep', !!on);
  }

  // ---------------------------------------------------------------- layout / auto-hide

  /** @param {'full'|'minimal'} mode */
  setMode(mode) {
    this.mode = mode;
    this.set('chat', mode);
    this.refreshPanel();
  }

  /** Pointer activity over the window (keeps the minimal-mode panel visible). */
  notePointer() {
    this._lastPointer = performance.now();
    if (this.mode === 'minimal' && this.dom.body.dataset.panel !== 'shown') this.refreshPanel();
  }

  /** The pointer left the window. */
  pointerLeft() {
    this._lastPointer = 0;
    this.refreshPanel();
  }

  refreshPanel() {
    clearTimeout(this._hideTimer);
    if (this.mode !== 'minimal') {
      this.set('panel', 'shown');
      return;
    }
    const now = performance.now();
    const active = this.state !== 'idle'
      || this.dom.body.dataset.attention === 'permission'
      || (this.composer && (document.activeElement === this.composer.dom.input || this.composer.text.trim()))
      || now - this._lastPointer < HIDE_AFTER_MS;
    if (active) {
      this.set('panel', 'shown');
      // re-check when the hover grace period runs out
      const wait = this.state === 'idle' ? Math.max(200, HIDE_AFTER_MS - (now - this._lastPointer)) : HIDE_AFTER_MS;
      this._hideTimer = /** @type {any} */ (setTimeout(() => this.refreshPanel(), wait));
    } else {
      this.set('panel', 'hidden');
    }
  }
}
