// Status line under the composer: conversation state · Claude CLI status · voice status.

import { h } from './dom.js';

export const STATE_LABEL = Object.freeze({
  idle: 'Ready',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
});

/**
 * Text + tone for the Claude CLI status.
 * @param {{ status?: string, detail?: string, model?: string, mode?: string, problem?: { kind: string, detail?: string } }} st
 * @returns {{ text: string, tone: 'ok'|'busy'|'warn'|'error', title: string }}
 */
export function describeClaude(st = {}) {
  const model = st.model ? ` · ${shortModel(st.model)}` : '';
  const problem = /** @type {any} */ (st).problem;
  if (problem?.kind === 'cli-missing') return { text: 'Claude not installed', tone: 'error', title: problem.detail || 'The Claude CLI was not found' };
  if (problem?.kind === 'auth') return { text: 'Claude: sign in', tone: 'warn', title: problem.detail || 'The Claude CLI is not logged in' };
  switch (st.status) {
    case 'ready': return { text: `Claude${model}`, tone: 'ok', title: st.detail || 'Claude CLI is ready' };
    case 'busy': return { text: `Claude${model}`, tone: 'busy', title: 'Claude is working on a reply' };
    case 'starting': return { text: 'Claude starting…', tone: 'busy', title: st.detail || 'Starting the Claude CLI' };
    case 'restarting': return { text: 'Claude restarting…', tone: 'warn', title: st.detail || 'Restarting the Claude CLI' };
    case 'exited': return { text: 'Claude stopped', tone: 'warn', title: st.detail || 'The Claude CLI is not running' };
    case 'error': return { text: 'Claude unavailable', tone: 'error', title: st.detail || 'The Claude CLI failed' };
    default: return { text: 'Claude…', tone: 'busy', title: '' };
  }
}

/** "claude-sonnet-4-5-20250929" → "sonnet 4.5" (best effort). @param {string} m */
export function shortModel(m) {
  let s = String(m || '').trim().replace(/^claude-/i, '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  s = s.replace(/(\d)-(?=\d)/g, '$1.').replace(/-/g, ' ');
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

/**
 * Text + tone for the voice server status.
 * @param {{ status?: string, detail?: string, health?: any }} info
 * @param {{ tts: 'server'|'browser'|'none', stt: boolean }} caps
 */
export function describeVoice(info = {}, caps = { tts: 'none', stt: false }) {
  const h = info.health || {};
  if (info.status === 'ready') {
    const gpu = h.device?.cuda ? 'GPU' : 'CPU';
    const parts = [];
    if (h.device?.name) parts.push(h.device.name);
    if (h.device?.vramTotalMB) parts.push(`${Math.round(h.device.vramFreeMB ?? 0)}/${Math.round(h.device.vramTotalMB)} MB free`);
    if (h.stt?.model) parts.push(`STT ${h.stt.model}${h.stt.device ? ` (${h.stt.device})` : ''}`);
    if (h.tts?.backend) parts.push(`TTS ${h.tts.backend}${h.tts.device ? ` (${h.tts.device})` : ''}`);
    return { text: `Voice · ${gpu}`, tone: /** @type {const} */ ('ok'), title: parts.join(' · ') || info.detail || 'Local voice server ready' };
  }
  if (info.status === 'starting') return { text: 'Voice starting…', tone: /** @type {const} */ ('busy'), title: info.detail || 'Starting the local voice server' };
  if (info.status === 'error') return { text: caps.tts === 'browser' ? 'Voice · browser' : 'Voice error', tone: /** @type {const} */ ('error'), title: info.detail || 'The voice server failed' };
  if (caps.tts === 'browser') return { text: 'Voice · browser', tone: /** @type {const} */ ('warn'), title: `${info.detail || 'Local voice server not running'} — using the browser voice; voice input is off.` };
  return { text: 'Voice off', tone: /** @type {const} */ ('warn'), title: info.detail || 'No voice output available' };
}

export class StatusLine {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.dot = h('span', { class: 'status-dot', 'aria-hidden': 'true' });
    this.state = h('span', { class: 'status-state' }, STATE_LABEL.idle);
    this.claude = h('span', { class: 'status-claude chip-ok' }, 'Claude…');
    this.voice = h('button', { type: 'button', class: 'status-voice', title: '' }, 'Voice…');
    this.hands = h('span', { class: 'status-hands', hidden: true }, 'hands-free');
    root.append(this.dot, this.state, h('span', { class: 'status-sep' }, '·'), this.claude, h('span', { class: 'status-sep' }, '·'), this.voice, this.hands);
  }

  /** @param {string} s */
  setState(s) {
    this.state.textContent = /** @type {any} */ (STATE_LABEL)[s] || s;
  }

  /** @param {any} st */
  setClaude(st) {
    const d = describeClaude(st);
    this.claude.textContent = d.text;
    this.claude.className = `status-claude tone-${d.tone}`;
    this.claude.title = d.title;
  }

  /** @param {any} info @param {{ tts: any, stt: boolean }} caps */
  setVoice(info, caps) {
    const d = describeVoice(info, caps);
    this.voice.textContent = d.text;
    this.voice.className = `status-voice tone-${d.tone}`;
    this.voice.title = d.title;
  }

  /** @param {boolean} on */
  setHandsFree(on) {
    this.hands.hidden = !on;
  }
}
