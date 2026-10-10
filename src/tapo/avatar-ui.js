// The Home camera's bits in the avatar window's DOM: the ARMED pill in the status bar (click:
// the camera window) and the consent card for "Claude describes alerts" (same look as the
// webcam's privacy card, in #cards).

import { h, icon } from '../ui/dom.js';
import { DESCRIBE_CONSENT, rememberDescribeConsent } from './consent.js';
import { armState } from './status.js';
import './avatar.css';

export class ArmedPill {
  /** @param {HTMLElement} statusRoot the status bar (#status) @param {{ onClick: () => void }} o */
  constructor(statusRoot, o) {
    this.el = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'status-armed', hidden: true, onclick: () => o.onClick() },
      h('span', { class: 'status-armed-dot', 'aria-hidden': 'true' }), h('span', { class: 'status-armed-text' }, 'armed')));
    const hands = statusRoot.querySelector('.status-hands');
    if (hands) statusRoot.insertBefore(this.el, hands);
    else statusRoot.append(this.el);
    this._timer = 0;
    /** @type {any} */
    this.status = null;
  }

  /** @param {any} st TapoStatus */
  update(st) {
    this.status = st;
    clearInterval(this._timer);
    this._timer = 0;
    this._render();
    if (st?.security?.arming) this._timer = /** @type {any} */ (setInterval(() => this._render(), 500));
  }

  _render() {
    const st = this.status;
    const a = armState(st, Date.now());
    const on = !!st?.enabled && a.mode !== 'disarmed';
    this.el.hidden = !on;
    if (!on) return;
    this.el.dataset.mode = a.mode;
    const name = st.name || 'camera';
    /** @type {HTMLElement} */ (this.el.querySelector('.status-armed-text')).textContent = a.mode === 'arming' ? `arming ${a.secondsLeft} s` : 'armed';
    this.el.title = a.mode === 'arming' ? `The ${name} is arming. Click to open the camera window.` : `The ${name} is armed and watching. Click to open the camera window.`;
  }
}

/**
 * The consent card for security.describe. Resolves true when accepted (and remembers it).
 * @param {HTMLElement} cards #cards
 * @returns {Promise<boolean>}
 */
export function showDescribeConsent(cards) {
  return new Promise((resolve) => {
    const accept = h('button', { type: 'button', class: 'btn amber' }, DESCRIBE_CONSENT.accept);
    const decline = h('button', { type: 'button', class: 'btn ghost' }, DESCRIBE_CONSENT.decline);
    const card = h('section', { class: 'setup-card camera-card tapo-consent', role: 'region', 'aria-labelledby': 'tapo-consent-title' },
      h('div', { class: 'setup-head' }, icon('shield', 'icon'), h('h3', { class: 'setup-title', id: 'tapo-consent-title' }, DESCRIBE_CONSENT.title)),
      h('ul', { class: 'setup-steps camera-points' }, DESCRIBE_CONSENT.points.map((p) => h('li', null, p))),
      h('div', { class: 'setup-actions camera-actions' }, decline, accept));
    const done = (/** @type {boolean} */ yes) => {
      if (yes) rememberDescribeConsent();
      card.classList.remove('shown');
      card.classList.add('leaving');
      setTimeout(() => card.remove(), 200);
      resolve(yes);
    };
    accept.addEventListener('click', () => done(true));
    decline.addEventListener('click', () => done(false));
    cards.prepend(card);
    requestAnimationFrame(() => card.classList.add('shown'));
    accept.focus();
  });
}
