// The Home camera window's header (contract §9.2): the camera's name and connection badge, the
// big arm control (Disarmed → Arming… 28 s → Armed), the REC light while a clip is recorded,
// and the buttons for the side panel, settings and help.

import { h } from '../../ui/dom.js';
import { armState, connectionBadge } from '../status.js';
import { tapoIcon } from './icons.js';

export class Header {
  /**
   * @param {HTMLElement} root
   * @param {{ onArm: () => void, onSettings: () => void, onHelp: () => void, onToggleSide: () => void, onRetry: () => void }} o
   */
  constructor(root, o) {
    this.root = root;
    this.name = h('h1', { class: 'cam-name' }, 'Home camera');
    this.badge = h('span', { class: 'badge tone-busy', role: 'status' }, h('span', { class: 'badge-dot', 'aria-hidden': 'true' }), h('span', { class: 'badge-text' }, 'Starting…'));
    this.retry = h('button', { type: 'button', class: 'btn subtle-inline retry', hidden: true, onclick: () => o.onRetry() }, tapoIcon('refresh', 'icon tiny'), 'Retry');
    this.rec = h('span', { class: 'rec', hidden: true, title: 'A clip is being recorded' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), 'REC');
    this.armIcon = tapoIcon('disarmed', 'icon arm-icon');
    this.armLabel = h('span', { class: 'arm-label' }, 'Disarmed');
    this.armAction = h('span', { class: 'arm-action' }, 'Arm');
    this.arm = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'arm', dataset: { mode: 'disarmed' }, 'aria-live': 'polite', onclick: () => o.onArm() },
      this.armIcon, h('span', { class: 'arm-text' }, this.armLabel, this.armAction)));
    const side = h('button', { type: 'button', class: 'icon-btn head-btn', 'aria-label': 'Show or hide presets and events', title: 'Presets and events (E)', onclick: () => o.onToggleSide() }, tapoIcon('sidebar'));
    const gear = h('button', { type: 'button', class: 'icon-btn head-btn', id: 'btn-settings', 'aria-label': 'Camera settings', title: 'Camera settings', onclick: () => o.onSettings() }, tapoIcon('gear'));
    const help = h('button', { type: 'button', class: 'icon-btn head-btn', 'aria-label': 'Keyboard and mouse help', title: 'Keyboard and mouse (?)', onclick: () => o.onHelp() }, tapoIcon('help'));
    this.sideBtn = side;
    root.append(
      h('div', { class: 'head-left' }, tapoIcon('camera', 'icon head-cam'), this.name, this.badge, this.retry, this.rec),
      h('div', { class: 'head-right' }, this.arm, side, gear, help),
    );
    /** @type {any} */
    this.status = null;
  }

  /** @param {any} st TapoStatus @param {number} nowMs */
  update(st, nowMs) {
    this.status = st;
    const name = st?.name || 'camera';
    this.name.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    const b = connectionBadge(st);
    this.badge.className = `badge tone-${b.tone}`;
    this.badge.title = b.title;
    /** @type {HTMLElement} */ (this.badge.querySelector('.badge-text')).textContent = b.text;
    this.retry.hidden = !(st && (st.connection === 'auth-failed' || st.connection === 'unreachable' || st.connection === 'error'));
    this.rec.hidden = !st?.security?.recording;
    this.tick(nowMs);
  }

  /** The arm control (also called every 250 ms for the countdown). @param {number} nowMs */
  tick(nowMs) {
    const st = this.status;
    const a = armState(st, nowMs);
    const usable = !!st?.enabled && !!st?.configured;
    this.arm.dataset.mode = a.mode;
    this.arm.disabled = !usable && a.mode === 'disarmed';
    this.armLabel.textContent = a.label;
    this.armAction.textContent = a.action;
    const icon = a.mode === 'disarmed' ? 'disarmed' : 'armed';
    if (this.armIcon.dataset.icon !== icon) {
      const next = tapoIcon(icon, 'icon arm-icon');
      next.dataset.icon = icon;
      this.armIcon.replaceWith(next);
      this.armIcon = next;
    }
    this.arm.title = a.mode === 'disarmed'
      ? (usable ? `Arm: watch for people and movement${st?.security ? '' : ''} (A)` : 'Set the camera up first')
      : a.mode === 'arming' ? 'Arming: leave the room. Click to cancel (A)' : a.blind ? `${a.label}: nothing is being watched right now. Click to disarm (A)` : 'Armed: watching. Click to disarm (A)';
    this.arm.dataset.blind = a.blind ? '1' : '';
    this.arm.setAttribute('aria-label', `${a.label}. ${a.action}`);
  }

  /** @param {boolean} open */
  setSideOpen(open) {
    this.sideBtn.setAttribute('aria-pressed', String(!!open));
  }
}
