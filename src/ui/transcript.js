// Chat transcript: user and Claude bubbles, streamed Markdown, tool chips, notes.
//
// Claude's text is re-rendered from its Markdown source at most once per animation frame while
// streaming (cheap for chat-sized replies, and it keeps half-finished code fences/tables
// rendering sensibly). Rendering goes through ui/markdown.js (DOM nodes only, no innerHTML).
// The view sticks to the bottom unless the user scrolled up to read.

import { clear, h, icon } from './dom.js';
import { markdownToFragment } from './markdown.js';

const STICK_PX = 28;

export class Transcript {
  /**
   * @param {HTMLElement} root  scrolling container (role=log)
   * @param {{ maxMessages?: number, onCopied?: (ok: boolean) => void }} [o]
   */
  constructor(root, o = {}) {
    this.root = root;
    this.maxMessages = o.maxMessages ?? 200;
    this.onCopied = o.onCopied || (() => {});
    /** @type {Map<string, any>} */
    this._turns = new Map();
    /** @type {Map<number, HTMLElement>} */
    this._users = new Map();
    this._ids = 0;
    /** @type {Set<any>} */
    this._dirty = new Set();
    this._raf = 0;
    this._stick = true;
    root.addEventListener('scroll', () => {
      this._stick = root.scrollHeight - root.scrollTop - root.clientHeight < STICK_PX;
    }, { passive: true });
    root.addEventListener('click', (e) => this._onClick(e));
  }

  /** Number of message elements. */
  get size() {
    return this.root.querySelectorAll('.msg').length;
  }

  /**
   * @param {string} text @param {{ source?: 'text'|'voice' }} [o]
   * @returns {number} message id
   */
  addUser(text, o = {}) {
    const id = ++this._ids;
    const msg = h('div', { class: `msg msg-user${o.source === 'voice' ? ' from-voice' : ''}`, dataset: { id: String(id) } },
      h('div', { class: 'bubble' },
        o.source === 'voice' ? h('span', { class: 'msg-src', title: 'Spoken' }, icon('mic', 'icon tiny')) : null,
        h('span', { class: 'msg-text' }, text)));
    this._append(msg, true);
    this._users.set(id, msg);
    return id;
  }

  /**
   * failed: could not be sent / was dropped by an error; cancelled: skipped because the user
   * stopped or sent something newer before it started.
   * @param {number} id @param {'failed'|'cancelled'} status @param {string} [detail]
   */
  markUser(id, status, detail) {
    const msg = this._users.get(id);
    if (!msg || (status !== 'failed' && status !== 'cancelled')) return;
    msg.classList.add(status);
    msg.querySelector('.msg-note')?.remove();
    const note = status === 'cancelled' ? 'Not sent — stopped' : `Not sent${detail ? ` — ${detail}` : ''}`;
    msg.appendChild(h('div', { class: 'msg-note' }, note));
    this._scroll();
  }

  /** @param {string} turnId */
  startAssistant(turnId) {
    if (this._turns.has(turnId)) return this._turns.get(turnId);
    const bubble = h('div', { class: 'bubble' });
    const msg = h('div', { class: 'msg msg-claude streaming empty', dataset: { turn: turnId } }, bubble);
    const turn = { id: turnId, msg, bubble, segments: /** @type {any[]} */ ([]), tools: new Map(), ended: false };
    this._turns.set(turnId, turn);
    this._append(msg, false);
    return turn;
  }

  /** @param {string} turnId @param {string} delta */
  appendAssistant(turnId, delta) {
    if (!delta) return;
    const t = this._turns.get(turnId) || this.startAssistant(turnId);
    let seg = t.segments[t.segments.length - 1];
    if (!seg || seg.kind !== 'text') {
      seg = { kind: 'text', text: '', el: h('div', { class: 'md' }) };
      t.segments.push(seg);
      t.bubble.appendChild(seg.el);
    }
    seg.text += delta;
    t.msg.classList.remove('empty');
    this._markDirty(seg);
  }

  /** @param {string} turnId @param {{ id: string, name: string, label: string }} tool */
  addTool(turnId, tool) {
    const t = this._turns.get(turnId) || this.startAssistant(turnId);
    const chip = h('div', { class: 'tool-chip running', dataset: { tool: tool.name }, title: tool.name },
      icon('tool', 'icon tiny'), h('span', { class: 'tool-label' }, tool.label || tool.name), h('span', { class: 'tool-state', 'aria-hidden': 'true' }));
    t.segments.push({ kind: 'tool', el: chip });
    t.tools.set(tool.id, chip);
    t.bubble.appendChild(chip);
    t.msg.classList.remove('empty');
    this._scroll();
  }

  /** @param {string} turnId @param {{ id: string, isError: boolean, summary: string }} r */
  toolResult(turnId, r) {
    const chip = this._turns.get(turnId)?.tools.get(r.id);
    if (!chip) return;
    chip.classList.remove('running');
    chip.classList.add(r.isError ? 'failed' : 'done');
    if (r.summary) chip.setAttribute('title', r.summary);
  }

  /** @param {string} turnId @param {string} text */
  noteInTurn(turnId, text) {
    const t = this._turns.get(turnId);
    if (!t) return;
    t.bubble.appendChild(h('div', { class: 'turn-note' }, text));
    t.segments.push({ kind: 'note' });
    this._scroll();
  }

  /**
   * @param {string} turnId
   * @param {{ isError?: boolean, interrupted?: boolean, empty?: boolean, result?: string }} info
   */
  endAssistant(turnId, info = {}) {
    const t = this._turns.get(turnId) || (info.empty && !info.isError && !info.interrupted ? null : this.startAssistant(turnId));
    if (!t) return;
    t.ended = true;
    this._flush();
    t.msg.classList.remove('streaming');
    if (info.interrupted) {
      t.msg.classList.add('interrupted');
      t.bubble.appendChild(h('span', { class: 'tag' }, 'stopped'));
    }
    if (info.isError) {
      t.msg.classList.add('error');
      if (info.empty && info.result) t.bubble.appendChild(h('div', { class: 'turn-error' }, info.result));
    }
    if (!t.segments.length && !info.isError && !info.interrupted) {
      t.msg.remove(); // nothing to show
      this._turns.delete(turnId);
    } else if (!t.segments.length) {
      t.msg.classList.remove('empty');
    }
    this._scroll();
  }

  /** @param {string} turnId @param {string} message */
  errorAssistant(turnId, message) {
    const t = this._turns.get(turnId) || this.startAssistant(turnId);
    t.msg.classList.remove('empty');
    t.msg.classList.add('error');
    t.bubble.appendChild(h('div', { class: 'turn-error' }, message));
    t.segments.push({ kind: 'error' });
    this._scroll();
  }

  /** A system line ("New conversation"). @param {string} text @param {string} [kind] */
  note(text, kind = 'info') {
    this._append(h('div', { class: `msg msg-note ${kind}` }, h('span', null, text)), false);
  }

  clear() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._dirty.clear();
    clear(this.root);
    this._turns.clear();
    this._users.clear();
    this._stick = true;
  }

  /** Plain text of the latest Claude message (for captions / tests). */
  lastAssistantText() {
    const all = this.root.querySelectorAll('.msg-claude .bubble');
    return all.length ? all[all.length - 1].textContent || '' : '';
  }

  // ------------------------------------------------------------------------------------------

  /** @param {any} seg */
  _markDirty(seg) {
    this._dirty.add(seg);
    if (!this._raf) this._raf = requestAnimationFrame(() => this._flush());
  }

  _flush() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (!this._dirty.size) return;
    for (const seg of this._dirty) {
      clear(seg.el);
      seg.el.appendChild(markdownToFragment(seg.text));
    }
    this._dirty.clear();
    this._scroll();
  }

  /** @param {HTMLElement} el @param {boolean} forceStick */
  _append(el, forceStick) {
    this.root.appendChild(el);
    const msgs = this.root.querySelectorAll('.msg');
    for (let i = 0; i < msgs.length - this.maxMessages; i++) {
      const m = /** @type {HTMLElement} */ (msgs[i]);
      if (m.dataset.turn) this._turns.delete(m.dataset.turn);
      if (m.dataset.id) this._users.delete(Number(m.dataset.id));
      m.remove();
    }
    if (forceStick) this._stick = true;
    this._scroll();
  }

  _scroll() {
    if (!this._stick) return;
    this.root.scrollTop = this.root.scrollHeight;
  }

  /** @param {MouseEvent} e */
  async _onClick(e) {
    const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-action="copy-code"]'));
    if (!btn) return;
    e.preventDefault();
    const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent ?? '';
    const ok = await copyText(code);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
    this.onCopied(ok);
  }
}

/** Copy text to the clipboard (async API, then a legacy fallback). @param {string} text */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    /** @type {HTMLTextAreaElement} */ (ta).value = text;
    document.body.appendChild(ta);
    /** @type {HTMLTextAreaElement} */ (ta).select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
