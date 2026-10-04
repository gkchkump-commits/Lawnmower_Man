// Setup cards: persistent first-run help over the avatar (not a toast) — "Install Claude Code",
// "Sign in to Claude Code", "Set up local voice" — rendered from src/app/setup-help.js models.
// Commands are shown verbatim with a Copy button; the app never runs them. "Retry" asks main to
// look for the CLI again and restart it (window.lawnmower.claude.retry()).

import { copyText } from './transcript.js';
import { h, icon } from './dom.js';

export class SetupCards {
  /**
   * @param {HTMLElement} root  the #cards container (shared with the approval cards)
   * @param {{ onRetry?: (kind: string) => Promise<void>, onCopied?: (ok: boolean) => void }} [o]
   */
  constructor(root, o = {}) {
    this.root = root;
    this.onRetry = o.onRetry || (async () => {});
    this.onCopied = o.onCopied || (() => {});
    /** @type {Map<string, { el: HTMLElement, key: string }>} slot → card */
    this.cards = new Map();
  }

  /** @param {string} slot */
  has(slot) {
    return this.cards.has(slot);
  }

  /**
   * Show (or replace) the card in a slot ('claude' | 'voice'); null removes it.
   * @param {string} slot @param {import('../app/setup-help.js').SetupCardModel|null} model
   */
  show(slot, model) {
    if (!model) {
      this.remove(slot);
      return;
    }
    const key = JSON.stringify(model);
    const existing = this.cards.get(slot);
    if (existing && existing.key === key) return;
    const card = this._render(slot, model);
    if (existing) existing.el.replaceWith(card);
    else this.root.prepend(card);
    this.cards.set(slot, { el: card, key });
    requestAnimationFrame(() => card.classList.add('shown'));
  }

  /** @param {string} slot */
  remove(slot) {
    const c = this.cards.get(slot);
    if (!c) return;
    this.cards.delete(slot);
    c.el.classList.remove('shown');
    c.el.classList.add('leaving');
    setTimeout(() => c.el.remove(), 200);
  }

  /** @param {string} slot @param {import('../app/setup-help.js').SetupCardModel} m */
  _render(slot, m) {
    const titleId = `setup-title-${slot}`;
    const commandRow = (/** @type {string} */ cmd, /** @type {string} */ label) => {
      const btn = h('button', { type: 'button', class: 'icon-btn tiny setup-copy', title: 'Copy', 'aria-label': `Copy: ${cmd}` }, icon('copy', 'icon tiny'));
      btn.addEventListener('click', async () => {
        const ok = await copyText(cmd);
        btn.classList.toggle('copied', ok);
        setTimeout(() => btn.classList.remove('copied'), 1500);
        this.onCopied(ok);
      });
      return h('div', { class: 'setup-cmd' },
        label ? h('div', { class: 'setup-cmd-label' }, label) : null,
        h('div', { class: 'setup-cmd-row' }, h('code', { class: 'setup-code' }, cmd), btn));
    };
    const steps = h('ol', { class: 'setup-steps' }, m.steps.map((s) => h('li', null,
      h('span', null, s.text),
      s.command ? commandRow(s.command, s.commandLabel || '') : null)));
    const more = m.more && m.more.length
      ? h('details', { class: 'setup-more' }, h('summary', null, 'Other ways to install'), m.more.map((x) => commandRow(x.command, x.label)))
      : null;

    const retry = m.retry
      ? h('button', { type: 'button', class: 'btn amber setup-retry' }, 'Retry')
      : null;
    if (retry) {
      retry.addEventListener('click', async () => {
        const b = /** @type {HTMLButtonElement} */ (retry);
        b.disabled = true;
        b.textContent = 'Checking…';
        card.classList.add('busy');
        try {
          await this.onRetry(m.kind);
        } finally {
          // the card is replaced or removed when the problem changes; otherwise allow another try
          b.disabled = false;
          b.textContent = 'Retry';
          card.classList.remove('busy');
        }
      });
    }
    const close = h('button', { type: 'button', class: 'icon-btn tiny setup-close', 'aria-label': 'Close', title: m.retry ? 'Hide (it comes back if the problem persists)' : 'Close' }, icon('close', 'icon tiny'));
    close.addEventListener('click', () => this.remove(slot));

    const card = h('section', { class: `setup-card kind-${m.kind}`, role: 'region', 'aria-labelledby': titleId, dataset: { setup: m.kind } },
      h('div', { class: 'setup-head' },
        icon(m.kind === 'voice-manual' ? 'voice' : 'info', 'icon'),
        h('h3', { class: 'setup-title', id: titleId }, m.title),
        close),
      h('p', { class: 'setup-intro' }, m.intro),
      m.detail ? h('p', { class: 'setup-detail' }, h('span', { class: 'k' }, 'Claude CLI: '), m.detail) : null,
      steps,
      more,
      m.note ? h('p', { class: 'setup-note' }, m.note) : null,
      h('div', { class: 'setup-actions' },
        m.link ? h('a', { class: 'setup-link', href: m.link.url, target: '_blank', rel: 'noopener noreferrer' }, `${m.link.label} ↗`) : null,
        retry || h('button', { type: 'button', class: 'btn ghost', onclick: () => this.remove(slot) }, 'Close')));
    return card;
  }
}
