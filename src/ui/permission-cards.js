// Permission approval cards (agent mode): tool name, a summary of what it wants to do, and
// Allow / Deny. Nothing is ever approved automatically; buttons are the only way to answer.
//
// Safety rules (the card is the only approval gate, in an always-on-top, click-through window):
//  * the buttons arm only ARM_MS after the card appears, and a click counts only when its
//    pointerdown also happened on that button after arming — so a click aimed at the window
//    underneath, landing just as a card pops up, cannot approve anything;
//  * when the summary had to shorten what Allow approves, Allow stays disabled until the user
//    opens "Show all";
//  * nothing is focused automatically.

import { h, icon } from './dom.js';

const RISK_LABEL = { danger: 'runs a command', write: 'changes files', read: 'reads files', web: 'uses the web', other: 'uses a tool' };

/** How long a new card ignores clicks (ms). */
export const ARM_MS = 600;

/**
 * Click gating for one card, independent of the DOM (unit-tested).
 * @param {{ now?: () => number, armMs?: number, needsReview?: boolean }} [o]
 */
export function createDecisionGate(o = {}) {
  const now = o.now || (() => (globalThis.performance?.now?.() ?? Date.now()));
  const shownAt = now();
  const armMs = o.armMs ?? ARM_MS;
  let reviewed = !o.needsReview;
  /** @type {{ button: string, at: number }|null} */
  let down = null;
  const armed = () => now() - shownAt >= armMs;
  return {
    armed,
    get reviewed() { return reviewed; },
    /** the user opened "Show all" */
    review() { reviewed = true; },
    /** May this button be pressed right now? @param {'allow'|'deny'} button */
    enabled(button) {
      return armed() && (button !== 'allow' || reviewed);
    },
    /** @param {'allow'|'deny'} button */
    pointerDown(button) {
      down = armed() ? { button, at: now() } : null;
    },
    /**
     * Should this click decide? Pointer clicks need a pointerdown on the same button after
     * arming; keyboard activation (detail 0: the button had to be focused on purpose) only
     * needs arming.
     * @param {'allow'|'deny'} button @param {number} detail MouseEvent.detail
     */
    accept(button, detail) {
      if (!this.enabled(button)) return false;
      if (detail === 0) return true;
      const ok = !!down && down.button === button;
      down = null;
      return ok;
    },
  };
}

export class PermissionCards {
  /**
   * @param {HTMLElement} root
   * @param {{ onDecision: (requestId: string, allow: boolean) => void, armMs?: number }} o
   */
  constructor(root, o) {
    this.root = root;
    this.onDecision = o.onDecision;
    this.armMs = o.armMs ?? ARM_MS;
    /** @type {Map<string, HTMLElement>} */
    this.cards = new Map();
  }

  get count() {
    return this.cards.size;
  }

  /**
   * @param {{ requestId: string, toolName: string, description?: string,
   *   summary: import('../app/permission.js').PermissionSummary,
   *   fullSummary?: import('../app/permission.js').PermissionSummary }} req
   */
  show(req) {
    if (this.cards.has(req.requestId)) return;
    const s = req.summary;
    const gate = createDecisionGate({ armMs: this.armMs, needsReview: !!s.truncated });
    const titleId = `perm-title-${this.cards.size}-${Date.now().toString(36)}`;
    let decided = false;

    /** @param {'allow'|'deny'} which @param {string} label @param {string} cls */
    const button = (which, label, cls) => h('button', {
      type: 'button',
      class: cls,
      disabled: true,
      onpointerdown: () => gate.pointerDown(which),
      onclick: (/** @type {MouseEvent} */ e) => {
        if (decided || !gate.accept(which, e.detail)) return;
        decided = true;
        card.classList.add('deciding');
        for (const b of card.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = true;
        this.onDecision(req.requestId, which === 'allow');
      },
    }, label);
    const deny = /** @type {HTMLButtonElement} */ (button('deny', 'Deny', 'btn ghost perm-deny'));
    const allow = /** @type {HTMLButtonElement} */ (button('allow', 'Allow', 'btn amber perm-allow'));
    const syncButtons = () => {
      if (decided) return;
      deny.disabled = !gate.enabled('deny');
      allow.disabled = !gate.enabled('allow');
      allow.title = gate.reviewed ? '' : 'Show the whole request before allowing it';
    };

    const body = h('div', { class: 'perm-body' });
    const renderBody = (/** @type {import('../app/permission.js').PermissionSummary} */ sum, /** @type {boolean} */ expanded) => {
      body.replaceChildren();
      const explanation = sum.explanation || (req.description && req.description !== sum.title ? req.description : '');
      if (explanation) body.append(h('p', { class: 'perm-desc' }, h('span', { class: 'k' }, 'Claude says: '), explanation));
      if (sum.target) body.append(h('pre', { class: 'perm-target' }, sum.target));
      const details = [];
      if (sum.detail) details.push(h('pre', { class: 'perm-detail' }, sum.detail));
      if (sum.fields.length) {
        details.push(h('dl', { class: 'perm-fields' }, sum.fields.map((f) => [h('dt', null, f.label), h('dd', null, f.value)])));
      }
      if (details.length) {
        const more = h('details', { class: 'perm-more' }, h('summary', null, 'Details'), details);
        if (expanded) /** @type {HTMLDetailsElement} */ (more).open = true;
        body.append(more);
      }
      if (sum.truncated && !expanded) {
        body.append(h('button', {
          type: 'button',
          class: 'btn ghost perm-showall',
          onclick: () => {
            gate.review();
            renderBody(req.fullSummary || sum, true);
            syncButtons();
          },
        }, `Show all ${sum.hiddenChars ? `(${sum.hiddenChars.toLocaleString()} more characters)` : ''}`.trim()));
      }
    };
    renderBody(s, false);

    const card = h('div', {
      class: `perm-card risk-${s.risk}${s.truncated ? ' truncated' : ''}`,
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
    body,
    h('div', { class: 'perm-actions' }, deny, allow));
    this.cards.set(req.requestId, card);
    this.root.appendChild(card);
    requestAnimationFrame(() => card.classList.add('shown'));
    // arm the buttons once the card has been visible for a moment
    setTimeout(() => {
      card.classList.add('armed');
      syncButtons();
    }, this.armMs + 20);
    syncButtons();
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
