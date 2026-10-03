// Permission approval cards (agent mode): tool name, a summary of what it wants to do, and
// Allow / Deny. Nothing is ever approved automatically; buttons are the only way to answer.

import { h, icon } from './dom.js';

const RISK_LABEL = { danger: 'runs a command', write: 'changes files', read: 'reads files', web: 'uses the web', other: 'uses a tool' };

export class PermissionCards {
  /**
   * @param {HTMLElement} root
   * @param {{ onDecision: (requestId: string, allow: boolean) => void }} o
   */
  constructor(root, o) {
    this.root = root;
    this.onDecision = o.onDecision;
    /** @type {Map<string, HTMLElement>} */
    this.cards = new Map();
  }

  get count() {
    return this.cards.size;
  }

  /**
   * @param {{ requestId: string, toolName: string, description?: string,
   *   summary: import('../app/permission.js').PermissionSummary }} req
   */
  show(req) {
    if (this.cards.has(req.requestId)) return;
    const s = req.summary;
    const titleId = `perm-title-${this.cards.size}-${Date.now().toString(36)}`;
    const decide = (allow) => () => {
      card.classList.add('deciding');
      for (const b of card.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = true;
      this.onDecision(req.requestId, allow);
    };
    const details = [];
    if (s.detail) details.push(h('pre', { class: 'perm-detail' }, s.detail));
    if (s.fields.length) {
      details.push(h('dl', { class: 'perm-fields' }, s.fields.map((f) => [h('dt', null, f.label), h('dd', null, f.value)])));
    }
    if (req.description && req.description !== s.title) details.unshift(h('p', { class: 'perm-desc' }, req.description));
    const card = h('div', {
      class: `perm-card risk-${s.risk}`,
      role: 'alertdialog',
      'aria-labelledby': titleId,
      dataset: { request: req.requestId },
    },
    h('div', { class: 'perm-head' },
      icon('shield', 'icon'),
      h('span', { class: 'perm-ask' }, 'Claude wants to use'),
      h('span', { class: 'perm-tool' }, req.toolName),
      h('span', { class: `perm-risk ${s.risk}` }, RISK_LABEL[s.risk] || 'uses a tool')),
    h('div', { class: 'perm-title', id: titleId }, s.title),
    s.target ? h('pre', { class: 'perm-target' }, s.target) : null,
    details.length ? h('details', { class: 'perm-more' }, h('summary', null, 'Details'), details) : null,
    h('div', { class: 'perm-actions' },
      h('button', { type: 'button', class: 'btn ghost perm-deny', onclick: decide(false) }, 'Deny'),
      h('button', { type: 'button', class: 'btn amber perm-allow', onclick: decide(true) }, 'Allow')));
    this.cards.set(req.requestId, card);
    this.root.appendChild(card);
    requestAnimationFrame(() => card.classList.add('shown'));
  }

  /** @param {string} requestId @param {'allowed'|'denied'|'expired'} [outcome] */
  remove(requestId, outcome = 'expired') {
    const card = this.cards.get(requestId);
    if (!card) return;
    this.cards.delete(requestId);
    card.classList.add('leaving', outcome);
    card.setAttribute('aria-hidden', 'true');
    setTimeout(() => card.remove(), 220);
  }

  clear() {
    for (const id of [...this.cards.keys()]) this.remove(id);
  }
}
