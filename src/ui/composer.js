// Composer: the text input, send/stop button and mic button.
//
//   Enter sends, Shift+Enter inserts a newline (IME composition is respected); the textarea
//   grows up to four lines. While Claude is busy and the input is empty, the send button turns
//   into a stop button. The mic button starts listening on press; releasing after a long press
//   (≥ 350 ms) sends what was said (push-to-talk), a short click leaves it listening until the
//   end of speech (or the next click).
/* global getComputedStyle */

import { icon } from './dom.js';

const HOLD_MS = 350;

export class Composer {
  /**
   * @param {{ form: HTMLFormElement, input: HTMLTextAreaElement, send: HTMLButtonElement, mic: HTMLButtonElement }} dom
   * @param {{ onSend: (text: string) => boolean|void, onStop: () => void, onMicPress: () => void, onMicRelease: (heldMs: number) => void, onMicUnavailable: () => void }} cb
   */
  constructor(dom, cb) {
    this.dom = dom;
    this.cb = cb;
    this.busy = false;
    this.micAvailable = true;
    this._micDownAt = 0;
    this._micPointer = null;
    this._history = /** @type {string[]} */ ([]);
    this._histIdx = -1;

    const { form, input, send, mic } = dom;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submit();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this._submit();
      } else if (e.key === 'ArrowUp' && !input.value && this._history.length) {
        e.preventDefault();
        this._histIdx = this._histIdx < 0 ? this._history.length - 1 : Math.max(0, this._histIdx - 1);
        this.setText(this._history[this._histIdx]);
      } else if (e.key === 'ArrowDown' && this._histIdx >= 0) {
        e.preventDefault();
        this._histIdx++;
        if (this._histIdx >= this._history.length) {
          this._histIdx = -1;
          this.setText('');
        } else {
          this.setText(this._history[this._histIdx]);
        }
      }
    });
    input.addEventListener('input', () => {
      this._autosize();
      this._updateSend();
    });
    send.addEventListener('click', (e) => {
      if (this._sendIsStop()) {
        e.preventDefault();
        this.cb.onStop();
      }
    });
    mic.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!this.micAvailable) {
        this.cb.onMicUnavailable();
        return;
      }
      this._micDownAt = performance.now();
      this._micPointer = e.pointerId;
      try { mic.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.cb.onMicPress();
    });
    const release = (/** @type {PointerEvent} */ e) => {
      if (this._micPointer === null || e.pointerId !== this._micPointer) return;
      this._micPointer = null;
      const held = performance.now() - this._micDownAt;
      this.cb.onMicRelease(held);
    };
    mic.addEventListener('pointerup', release);
    mic.addEventListener('pointercancel', release);
    mic.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (!this.micAvailable) this.cb.onMicUnavailable();
        else {
          this.cb.onMicPress();
          this.cb.onMicRelease(0);
        }
      }
    });
    this._autosize();
    this._updateSend();
  }

  /** Long-press threshold for push-to-talk on the mic button. */
  static get HOLD_MS() {
    return HOLD_MS;
  }

  /** @param {boolean} busy Claude is thinking/speaking */
  setBusy(busy) {
    this.busy = !!busy;
    this._updateSend();
  }

  /** @param {boolean} ok @param {string} reason tooltip when unavailable */
  setMicAvailable(ok, reason) {
    this.micAvailable = !!ok;
    const mic = this.dom.mic;
    mic.setAttribute('aria-disabled', String(!ok));
    mic.classList.toggle('unavailable', !ok);
    mic.title = ok ? 'Talk — click, or hold to talk (Space)' : reason;
  }

  /** @param {string} text */
  setText(text) {
    this.dom.input.value = text;
    this._autosize();
    this._updateSend();
  }

  focus() {
    this.dom.input.focus();
  }

  get text() {
    return this.dom.input.value;
  }

  _submit() {
    if (this._sendIsStop()) {
      this.cb.onStop();
      return;
    }
    const text = this.dom.input.value;
    if (!text.trim()) return;
    if (this.cb.onSend(text) === false) return;
    this._history.push(text);
    if (this._history.length > 50) this._history.shift();
    this._histIdx = -1;
    this.setText('');
  }

  _sendIsStop() {
    return this.busy && !this.dom.input.value.trim();
  }

  _updateSend() {
    const stop = this._sendIsStop();
    const btn = this.dom.send;
    if (btn.dataset.mode === (stop ? 'stop' : 'send')) {
      btn.disabled = !stop && !this.dom.input.value.trim();
      return;
    }
    btn.dataset.mode = stop ? 'stop' : 'send';
    btn.replaceChildren(icon(stop ? 'stop' : 'send'));
    btn.setAttribute('aria-label', stop ? 'Stop' : 'Send');
    btn.title = stop ? 'Stop (Esc)' : 'Send (Enter)';
    btn.disabled = !stop && !this.dom.input.value.trim();
  }

  _autosize() {
    const ta = this.dom.input;
    ta.style.height = 'auto';
    const max = parseFloat(getComputedStyle(ta).lineHeight || '18') * 4 + 12;
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`;
    // no scrollbar (and no classic-scrollbar arrows on Linux) until it is really needed
    ta.style.overflowY = ta.scrollHeight > max + 1 ? 'auto' : 'hidden';
  }
}
