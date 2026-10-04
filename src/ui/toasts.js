// Toast notifications: short, deduplicated, auto-dismissing (paused on hover), click to close.

import { h, icon } from './dom.js';

const TIMEOUT = { info: 4000, success: 2500, warn: 6500, error: 9000 };
const ICON = { info: 'info', success: 'check', warn: 'warn', error: 'warn' };

export class Toasts {
  /** @param {HTMLElement} root @param {{ max?: number }} [o] */
  constructor(root, o = {}) {
    this.root = root;
    this.max = o.max ?? 3;
    /** @type {Map<string, { el: HTMLElement, timer: any, count: number, level: string }>} */
    this.items = new Map();
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} [level]
   * @param {{ timeoutMs?: number }} [o]
   */
  show(message, level = 'info', o = {}) {
    const text = String(message || '').trim();
    if (!text) return;
    const key = `${level}:${text}`;
    const existing = this.items.get(key);
    if (existing) {
      existing.count++;
      existing.el.querySelector('.toast-count').textContent = `×${existing.count}`;
      this._arm(key, o.timeoutMs);
      return;
    }
    const el = h('div', {
      class: `toast ${level}`,
      role: level === 'error' ? 'alert' : 'status',
      onclick: () => this.dismiss(key),
      onmouseenter: () => clearTimeout(this.items.get(key)?.timer),
      onmouseleave: () => this._arm(key, o.timeoutMs),
    }, icon(/** @type {any} */ (ICON[level] || 'info'), 'icon tiny'), h('span', { class: 'toast-text' }, text), h('span', { class: 'toast-count' }));
    this.items.set(key, { el, timer: 0, count: 1, level });
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('shown'));
    this._arm(key, o.timeoutMs);
    // keep only the newest few
    const keys = [...this.items.keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - this.max))) this.dismiss(k);
  }

  /** @param {string} key */
  dismiss(key) {
    const it = this.items.get(key);
    if (!it) return;
    clearTimeout(it.timer);
    this.items.delete(key);
    it.el.classList.remove('shown');
    it.el.classList.add('leaving');
    setTimeout(() => it.el.remove(), 200);
  }

  clear() {
    for (const k of [...this.items.keys()]) this.dismiss(k);
  }

  /** @param {string} key @param {number} [ms] */
  _arm(key, ms) {
    const it = this.items.get(key);
    if (!it) return;
    clearTimeout(it.timer);
    it.timer = setTimeout(() => this.dismiss(key), ms ?? TIMEOUT[it.level] ?? 4000);
  }
}
