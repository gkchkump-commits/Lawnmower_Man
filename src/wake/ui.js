// What "Hey Jade" looks like (contract-wake §8.1, §9.6): the status-bar chip, body[data-wake],
// the drawer's wakeInfo block (state, reason and its action, echo mode, the last 20 wake
// events), the one-time offer card, the follow-up dimming and a polite live region.
//
// The texts are pure functions (chipModel, infoModel, logLine) so they are unit-tested; WakeUi
// only puts them into the DOM.

import { h } from '../ui/dom.js';
import { earIcon } from './ear.js';
import './wake.css';

/** Texts the user reads (one place, so the docs and tests can find them). */
export const WAKE_TEXT = Object.freeze({
  offerTitle: 'New: talk hands-free',
  offer: 'Say “Hey Jade” and I’ll listen. The microphone stays on while the app runs (Windows shows it in use); nothing is recorded or sent anywhere until you say my name.',
  turnOn: 'Turn on',
  notNow: 'Not now',
  echoGood: 'Echo cancellation: good. I did not hear myself.',
  echoBad: (/** @type {number} */ n) => `I heard my own voice ${n} time${n === 1 ? '' : 's'}. Saying my name while I talk may stop me by mistake: use headphones, or turn off “Interrupt with her name”.`,
});

/** @typedef {import('./machine.js').WakeUiState} WakeUiState */

/**
 * @typedef {object} WakeModel
 * @property {WakeUiState} state
 * @property {string} [reason]
 * @property {string} [code]
 * @property {boolean} [strict]
 * @property {boolean} [fallback]
 * @property {'all'|'app'|'off'} [echo]
 * @property {{ zhen?: string, giga?: string, vad?: string }} [models]
 * @property {Array<{ at: number, outcome: string, reason: string, text: string, latencyMs?: number, heardMs?: number }>} [log]
 * @property {number|null} [recordingSec]  seconds recorded of the test clip (null: not recording)
 * @property {string} [echoResult]          the last "Test my echo" result
 * @property {boolean} [echoTesting]
 * @property {boolean} [canSpeak]   her replies are spoken (Test my echo needs her voice)
 * @property {string} [engine]      main's engine state ('error': it kept stopping or could not start)
 * @property {boolean} [windows]     on Windows (a privacy block can look like "in use")
 * @property {number} [nowPerf]  performance.now() of this model (to show log times)
 * @property {number} [nowWall]  Date.now() of this model
 */

const ACTIVE = new Set(['attention', 'listening', 'followup', 'look', 'barge']);
/** the states in which the mic is tapped for her name (a test clip can only record then) */
const TAPPED = new Set(['waiting', 'busy', ...ACTIVE]);

/**
 * The chip in the status bar. hidden while the wake word is off.
 * @param {WakeModel} m
 * @returns {{ hidden: boolean, text: string, title: string, slashed: boolean, tone: 'dim'|'on'|'warn'|'error' }}
 */
export function chipModel(m) {
  const s = m.state;
  const r = m.reason || '';
  if (m.recordingSec != null && TAPPED.has(s)) return { hidden: false, text: `Recording test clip ${clock(m.recordingSec)}`, title: 'Recording 30 s for a test clip (only on request, saved on this PC)', slashed: false, tone: 'on' };
  switch (s) {
    case 'off': return { hidden: true, text: '', title: '', slashed: false, tone: 'dim' };
    case 'unavailable':
      return m.code === 'no-voice'
        ? { hidden: false, text: 'Hey Jade: needs the local voice', title: r || 'Hey Jade needs the local voice (Settings › Voice)', slashed: true, tone: 'warn' }
        : { hidden: false, text: 'Hey Jade: unavailable', title: r || 'The wake-word engine is not available', slashed: true, tone: 'warn' };
    case 'starting': return { hidden: false, text: 'Hey Jade: starting…', title: r, slashed: false, tone: 'dim' };
    case 'paused': return { hidden: false, text: 'Hey Jade: paused', title: 'Paused while the window is hidden (Settings › Voice › Listen while hidden)', slashed: true, tone: 'dim' };
    case 'locked': return { hidden: false, text: 'Hey Jade: PC locked', title: 'The microphone is off while the PC is locked', slashed: true, tone: 'dim' };
    case 'blocked': return { hidden: false, text: 'Microphone blocked', title: r || 'The microphone could not be opened', slashed: true, tone: 'error' };
    case 'muted': return { hidden: false, text: 'Microphone is muted', title: 'Your microphone is muted (Windows or the device)', slashed: true, tone: 'warn' };
    // the status label next to it already says "Listening…": the chip says why no key was needed
    case 'listening': return { hidden: false, text: 'Hey Jade', title: 'Jade is listening: say what you need', slashed: false, tone: 'on' };
    case 'followup': return { hidden: false, text: 'Follow-up', title: 'Go on: no name needed for a few seconds', slashed: false, tone: 'on' };
    case 'look': return { hidden: false, text: 'Look & talk', title: 'You are looking at her: no name needed', slashed: false, tone: 'on' };
    case 'attention':
    case 'barge': return { hidden: false, text: 'Hey Jade…', title: 'She heard her name and is checking it', slashed: false, tone: 'on' };
    default: {
      // waiting, busy
      const title = m.fallback
        ? 'Transcript check: the wake-word engine is not running, so speech is transcribed on this PC to hear her name; nothing is kept or sent unless it starts with “Hey Jade”'
        : 'Listening for “Hey Jade”. Nothing is recorded or sent until you say her name.';
      return { hidden: false, text: m.fallback ? 'Hey Jade (transcript check)' : 'Hey Jade', title: m.strict ? `${title} Stricter for a few minutes after several mistakes in a row.` : title, slashed: false, tone: 'dim' };
    }
  }
}

/** the states in which the microphone is open for her name (or open but muted, or failing) */
const BADGE = new Set(['waiting', 'busy', 'muted', 'blocked', ...ACTIVE]);

/**
 * The always-visible "microphone on" badge in the stage's corner (outside the chat panel, which
 * folds away in minimal mode): an ear while the mic is open for her name, slashed when muted or
 * blocked; a click turns "Hey Jade" off.
 * @param {WakeModel} m
 * @returns {{ hidden: boolean, slashed: boolean, tone: 'dim'|'on'|'warn'|'error', title: string }}
 */
export function badgeModel(m) {
  const s = m.state;
  if (!BADGE.has(s)) return { hidden: true, slashed: false, tone: 'dim', title: '' };
  const off = ' Click to turn “Hey Jade” off.';
  if (s === 'muted') return { hidden: false, slashed: true, tone: 'warn', title: `Your microphone is muted.${off}` };
  if (s === 'blocked') return { hidden: false, slashed: true, tone: 'error', title: `The microphone is blocked (${m.reason || 'it could not be opened'}).${off}` };
  if (ACTIVE.has(s) && s !== 'busy') return { hidden: false, slashed: false, tone: 'on', title: `Jade is listening.${off}` };
  return { hidden: false, slashed: false, tone: 'dim', title: `The microphone is on for “Hey Jade”; nothing is recorded or sent until you say her name.${off}` };
}

/** mm:ss @param {number} sec */
function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * One line of the wake log: "09:41 woke · 280 ms", "09:41 woke · 520 ms (noticed after 230 ms)",
 * "09:43 ignored · sounded like “Hey Jude”". latencyMs: end of her name → listening (with the
 * check); heardMs: end of her name → her eyes brighten (the laptop checklist's timing).
 * @param {{ at: number, text: string, latencyMs?: number, heardMs?: number }} e  at: performance.now() ms
 * @param {number} nowPerf @param {number} nowWall
 */
export function logLine(e, nowPerf, nowWall) {
  const d = new Date(nowWall - (nowPerf - e.at));
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const lat = Number.isFinite(e.latencyMs) ? ` · ${e.latencyMs} ms` : '';
  const heard = Number.isFinite(e.heardMs) ? ` (noticed after ${e.heardMs} ms)` : '';
  return `${hh}:${mm} ${e.text}${lat}${heard}`;
}

/**
 * The drawer's wakeInfo: one status line, the reason with its action, notes, the log.
 * @param {WakeModel} m
 * @returns {{ line: string, tone: ''|'warn'|'err', action: null | { id: string, label: string }, notes: string[], log: string[] }}
 */
export function infoModel(m) {
  const c = chipModel(m);
  const notes = [];
  /** @type {null | { id: string, label: string }} */
  let action = null;
  let line = c.text;
  let tone = /** @type {''|'warn'|'err'} */ ('');
  switch (m.state) {
    case 'off':
      line = 'Off. Turn on “Hey Jade” to talk without a key.';
      break;
    case 'waiting':
    case 'busy':
      line = m.fallback ? 'Transcript check: listening for “Hey Jade” without the wake-word engine' : 'Listening for “Hey Jade”';
      break;
    case 'unavailable':
      tone = 'warn';
      if (m.code === 'no-voice') {
        // the voice block above already says why the local voice is not running
        line = 'Hey Jade needs the local voice: it checks her name on this PC.';
        action = { id: 'setupVoice', label: 'Set up local voice…' };
      } else {
        line = m.reason || c.text;
        // the engine kept stopping or could not start: start it again (a fresh restart budget);
        // the details are in the app's log (tray › Open logs folder)
        if (m.code === 'engine' && m.engine === 'error') {
          action = { id: 'wakeRestart', label: 'Retry' };
          notes.push('Details: tray › Open logs folder');
        }
      }
      break;
    case 'blocked':
      line = m.reason || c.text;
      tone = 'err';
      // on Windows "in use" may be the privacy switch (not always reported): its settings, and
      // the quiet retries go on by themselves
      action = m.code === 'os-blocked' || m.code === 'denied' || (m.code === 'in-use' && m.windows)
        ? { id: 'wakeMicSettings', label: 'Open Windows microphone settings' }
        : { id: 'wakeRetry', label: 'Retry' };
      if (m.code === 'in-use' && m.windows) notes.push('She tries the microphone again by herself (after 5 s, 15 s, then every minute).');
      break;
    case 'muted':
      tone = 'warn';
      break;
    default:
      if (ACTIVE.has(m.state)) line = c.title || c.text;
      else if (m.reason) line = `${c.text} (${m.reason})`;
  }
  if (m.state !== 'off' && m.state !== 'unavailable') {
    if (m.echo === 'all') notes.push('Echo cancellation: all apps');
    else if (m.echo === 'app') notes.push('Echo cancellation: this app (other apps’ sound is not removed)');
    else if (m.echo === 'off' && (m.state === 'waiting' || m.state === 'busy' || ACTIVE.has(m.state))) notes.push('Echo cancellation: off');
    if (m.strict) notes.push('Stricter for a few minutes: there were several mistakes in a row');
  }
  const zhen = m.models?.zhen;
  // which model runs only matters while the engine runs (not when it cannot start at all)
  const engineRuns = m.state !== 'off' && !(m.state === 'unavailable' && m.code === 'engine');
  if (engineRuns && zhen && zhen !== 'ok') {
    if (zhen === 'downloading') notes.push('Using the basic wake-word model; the extra one is downloading');
    else if (zhen === 'failed' || zhen === 'missing') {
      notes.push(zhen === 'failed' ? 'Using the basic wake-word model; the extra one could not be downloaded' : 'Using the basic wake-word model');
      if (!action) action = { id: 'wakeDownload', label: 'Download the extra wake-word model' };
    }
    // model B alone reacts about 0.25 s later (review: 593 vs 268 ms to the attention cue)
    if (zhen === 'downloading' || zhen === 'failed' || zhen === 'missing') notes.push('She hears her name faster and more reliably once the extra wake-word model is there.');
  }
  // a test clip being recorded can be stopped without saving anything
  if (m.recordingSec != null) action = { id: 'wakeRecordCancel', label: 'Cancel recording' };
  if (m.echoTesting) notes.push('Testing the echo: listen…');
  else if (m.echoResult) notes.push(m.echoResult);
  const nowPerf = m.nowPerf ?? 0;
  const nowWall = m.nowWall ?? Date.now();
  const log = (m.log || []).slice().reverse().map((e) => logLine(e, nowPerf, nowWall));
  return { line, tone, action, notes, log };
}

export class WakeUi {
  /**
   * @param {object} o
   * @param {HTMLElement} o.body
   * @param {{ setWake: (chip: ReturnType<typeof chipModel>, m: WakeModel) => void }} o.view  AppView (body[data-wake*], the chip)
   * @param {HTMLElement} o.cards  #cards
   * @param {any} [o.drawer]       SettingsDrawer
   * @param {(msg: string, level?: string) => void} o.toast
   * @param {(action: string) => void} o.onAction
   * @param {HTMLButtonElement|null} [o.badge]  #wake-mic (the always-visible microphone badge)
   */
  constructor(o) {
    this.o = o;
    this.body = o.body;
    this.badge = o.badge || null;
    this._badgeSlashed = /** @type {boolean|null} */ (null);
    this.live = h('div', { class: 'wake-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.body.append(this.live);
    this._lastAnnounce = -Infinity;
    this._pending = '';
    this._announceTimer = 0;
    /** @type {HTMLElement|null} */
    this.card = null;
    this._hints = new Set();
    this._infoKey = '';
  }

  /** @param {WakeModel} m */
  render(m) {
    if (m.state !== 'followup' && this.body.dataset.wakeDim) this.body.dataset.wakeDim = '';
    this.o.view.setWake(chipModel(m), m);
    this._renderBadge(m);
    this._renderInfo(m);
  }

  /** @param {WakeModel} m */
  _renderBadge(m) {
    const el = this.badge;
    if (!el) return;
    const b = badgeModel(m);
    el.hidden = b.hidden;
    if (b.hidden) return;
    if (this._badgeSlashed !== b.slashed) {
      this._badgeSlashed = b.slashed;
      el.replaceChildren(earIcon(b.slashed));
    }
    el.dataset.tone = b.tone;
    el.title = b.title;
    el.setAttribute('aria-label', b.title);
  }

  /** @param {WakeModel} m */
  _renderInfo(m) {
    const d = this.o.drawer;
    if (!d) return;
    const info = infoModel(m);
    const enabled = m.state !== 'off';
    // the rows other than the switch and the info are only for an enabled wake word
    for (const p of ['wake.phrase', 'wake.sensitivity', 'wake.followUpSec', 'wake.bargeIn', 'wake.sounds', 'wake.whileHidden']) {
      const c = d.controls.get(p);
      if (c) c.row.hidden = !enabled;
    }
    const fb = d.controls.get('wake.transcriptFallback');
    if (fb) fb.row.hidden = !(enabled && (m.code === 'engine' || m.fallback));
    const working = m.state === 'waiting';
    d.setAction?.('wakeEchoTest', { hidden: !working && !m.echoTesting, disabled: !!m.echoTesting || m.recordingSec != null || m.canSpeak === false, title: m.canSpeak === false ? 'Needs Settings › Voice › Speak replies' : '' });
    d.setAction?.('wakeRecord', { hidden: !working && m.recordingSec == null, disabled: m.recordingSec != null || !!m.echoTesting, label: m.recordingSec != null ? `Recording… ${clock(m.recordingSec)}` : 'Record a test clip (30 s)…' });
    const key = JSON.stringify(info);
    if (key === this._infoKey) return;
    this._infoKey = key;
    const nodes = [h('div', { class: `wake-line ${info.tone}` }, info.line)];
    for (const n of info.notes) nodes.push(h('div', { class: 'wake-note' }, n));
    if (info.action) {
      const a = info.action;
      nodes.push(h('button', { type: 'button', class: 'btn subtle wake-action', dataset: { action: a.id }, onclick: () => this.o.onAction(a.id) }, a.label));
    }
    if (info.log.length) {
      nodes.push(h('details', { class: 'wake-log' },
        h('summary', null, `Last ${info.log.length} wake event${info.log.length === 1 ? '' : 's'}`),
        h('ol', null, info.log.map((l) => h('li', null, l)))));
    }
    d.setInfo('wakeInfo', nodes);
  }

  /** The glow dims over the last 1.5 s of a follow-up window. @param {boolean} on */
  setDim(on) {
    this.body.dataset.wakeDim = on ? '1' : '';
  }

  /** A polite announcement, at most one per 2 s (the latest wins). @param {string} text */
  announce(text) {
    const now = performance.now();
    this._pending = text;
    if (now - this._lastAnnounce >= 2000) {
      this._flushAnnounce();
      return;
    }
    clearTimeout(this._announceTimer);
    this._announceTimer = /** @type {any} */ (setTimeout(() => this._flushAnnounce(), 2000 - (now - this._lastAnnounce)));
  }

  _flushAnnounce() {
    this._lastAnnounce = performance.now();
    this.live.textContent = this._pending;
    this._pending = '';
  }

  /** A one-time hint (digital silence, a Bluetooth headset). @param {string} text */
  hint(text) {
    if (this._hints.has(text)) return;
    this._hints.add(text);
    this.o.toast(text, 'warn');
  }

  /**
   * The one-time offer card (§9.6).
   * @param {{ onTurnOn: () => void, onNotNow: () => void }} o
   */
  showOffer(o) {
    if (this.card) return;
    const on = h('button', { type: 'button', class: 'btn amber', dataset: { wakeOffer: 'on' } }, WAKE_TEXT.turnOn);
    const later = h('button', { type: 'button', class: 'btn ghost', dataset: { wakeOffer: 'later' } }, WAKE_TEXT.notNow);
    const ear = earIcon(false);
    ear.classList.add('icon');
    const card = h('section', { class: 'setup-card wake-card', role: 'region', 'aria-labelledby': 'wake-offer-title' },
      h('div', { class: 'setup-head' }, ear, h('h3', { class: 'setup-title', id: 'wake-offer-title' }, WAKE_TEXT.offerTitle)),
      h('p', { class: 'setup-intro' }, WAKE_TEXT.offer),
      h('div', { class: 'setup-actions wake-actions' }, later, on));
    const done = (/** @type {boolean} */ yes) => {
      this.hideOffer();
      (yes ? o.onTurnOn : o.onNotNow)();
    };
    on.addEventListener('click', () => done(true));
    later.addEventListener('click', () => done(false));
    this.card = card;
    this.o.cards.prepend(card);
    requestAnimationFrame(() => card.classList.add('shown'));
  }

  hideOffer() {
    const card = this.card;
    if (!card) return;
    this.card = null;
    card.classList.remove('shown');
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 200);
  }

  dispose() {
    clearTimeout(this._announceTimer);
    this.hideOffer();
    this.live.remove();
  }
}

