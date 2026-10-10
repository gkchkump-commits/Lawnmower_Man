// The events list (contract §9.2 sidebar): what the camera saw while armed, newest first,
// grouped by day; a thumbnail, the time, what it was, how long, whether a clip was saved.
// Events not opened yet are bold. People / Motion filter. A click opens the clip player.

import { clear, h } from '../../ui/dom.js';
import { KIND_LABEL, dayLabel, formatClock, formatDuration } from '../status.js';
import { tapoIcon } from './icons.js';

export const PAGE_SIZE = 50;

export class EventsPanel {
  /**
   * @param {HTMLElement} root
   * @param {{ load: (q: any) => Promise<{ events: any[], total: number }>, onOpen: (ev: any) => void, onOpenFolder: () => void, now?: () => number }} o
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.now = o.now || (() => Date.now());
    /** @type {any[]} */
    this.events = [];
    this.total = 0;
    /** @type {'all'|'person'|'motion'} */
    this.filter = 'all';
    /** @type {any|null} the event happening now */
    this.active = null;
    this.list = h('div', { class: 'event-list', role: 'list', 'aria-label': 'Events' });
    this.empty = h('p', { class: 'side-empty', hidden: true }, 'Nothing yet. When the camera is armed, people and movement it sees are listed here, with a short video.');
    this.more = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn ghost side-btn', hidden: true, onclick: () => this.loadMore() }, 'Show older'));
    const seg = h('div', { class: 'segmented event-filter', role: 'radiogroup', 'aria-label': 'Show' });
    /** @type {HTMLButtonElement[]} */
    this.filterButtons = [];
    for (const [v, label] of /** @type {const} */ ([['all', 'All'], ['person', 'People'], ['motion', 'Motion']])) {
      const b = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === 'all'), dataset: { value: v }, onclick: () => this.setFilter(v) }, label));
      this.filterButtons.push(b);
      seg.append(b);
    }
    const folder = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Open the clips folder', title: 'Open the clips folder', onclick: () => o.onOpenFolder() }, tapoIcon('folder', 'icon tiny'));
    this.count = h('span', { class: 'side-count' });
    root.append(h('header', { class: 'side-head' }, h('h2', null, 'Events'), this.count, seg, folder), this.list, this.empty, this.more);
  }

  /** @param {'all'|'person'|'motion'} v */
  setFilter(v) {
    if (this.filter === v) return;
    this.filter = v;
    for (const b of this.filterButtons) b.setAttribute('aria-checked', String(b.dataset.value === v));
    this.reload();
  }

  _query() {
    return this.filter === 'all' ? {} : { kinds: [this.filter] };
  }

  async reload() {
    try {
      const r = await this.o.load({ ...this._query(), limit: PAGE_SIZE });
      this.events = Array.isArray(r?.events) ? r.events : [];
      this.total = Number(r?.total) || this.events.length;
    } catch (err) {
      console.warn('[tapo] events.list failed', err);
    }
    this._render();
  }

  async loadMore() {
    const last = this.events.at(-1);
    if (!last) return;
    try {
      const r = await this.o.load({ ...this._query(), limit: PAGE_SIZE, beforeMs: last.startedAt });
      const ids = new Set(this.events.map((e) => e.id));
      this.events.push(...(r?.events || []).filter((e) => !ids.has(e.id)));
    } catch (err) {
      console.warn('[tapo] events.list failed', err);
    }
    this._render();
  }

  /** main's lm:tapo:event. @param {{ phase: 'start'|'update'|'end', event: any }} m */
  onEvent(m) {
    const ev = m?.event;
    if (!ev?.id) return;
    if (m.phase === 'end') {
      if (this.active?.id === ev.id) this.active = null;
      const i = this.events.findIndex((e) => e.id === ev.id);
      if (i >= 0) this.events[i] = ev;
      else if (this._matches(ev)) {
        this.events.unshift(ev);
        this.total++;
      }
    } else {
      this.active = ev;
    }
    this._render();
  }

  /** @param {string} id */
  markRead(id) {
    const e = this.events.find((x) => x.id === id);
    if (e) e.acknowledged = true;
    this._render();
  }

  /** @param {string} id */
  remove(id) {
    const n = this.events.length;
    this.events = this.events.filter((e) => e.id !== id);
    if (this.events.length < n) this.total = Math.max(0, this.total - 1);
    this._render();
  }

  /** @param {string} id */
  find(id) {
    return this.events.find((e) => e.id === id) || (this.active?.id === id ? this.active : null);
  }

  /** @param {any} ev */
  _matches(ev) {
    return this.filter === 'all' || ev.kind === this.filter;
  }

  _render() {
    clear(this.list);
    const now = this.now();
    const items = this.events.slice();
    if (this.active && this._matches(this.active) && !items.some((e) => e.id === this.active.id)) items.unshift({ ...this.active, live: true });
    let day = '';
    for (const ev of items) {
      const d = dayLabel(ev.startedAt, now);
      if (d !== day) {
        day = d;
        this.list.append(h('div', { class: 'event-day', role: 'presentation' }, d));
      }
      this.list.append(this._item(ev));
    }
    this.empty.hidden = items.length > 0;
    this.more.hidden = this.events.length >= this.total || !this.events.length;
    // the event happening now counts too (it has a dot like the others)
    const unread = items.filter((e) => !e.acknowledged).length;
    this.count.textContent = unread ? `${unread} new` : '';
    this.count.hidden = !unread;
  }

  /** @param {any} ev */
  _item(ev) {
    const kind = /** @type {any} */ (KIND_LABEL)[ev.kind] || ev.kind;
    const meta = [];
    if (ev.live) meta.push(h('span', { class: 'tag live' }, 'now'));
    else if (Number.isFinite(ev.durationSec)) meta.push(h('span', null, formatDuration(ev.durationSec)));
    if (ev.unconfirmed) meta.push(h('span', { class: 'tag', title: 'Only the camera saw it; the app’s own person detector was not running' }, 'unconfirmed'));
    if (!ev.live && !ev.clipUrl) meta.push(h('span', { class: 'tag' }, 'no clip'));
    const thumb = ev.snapshotUrl
      ? h('img', { class: 'event-thumb', src: ev.snapshotUrl, alt: '', loading: 'lazy', decoding: 'async' })
      : h('span', { class: 'event-thumb none' }, tapoIcon(ev.kind === 'person' ? 'person' : 'motion', 'icon'));
    return h('button', {
      type: 'button',
      role: 'listitem',
      class: `event${ev.acknowledged ? '' : ' unread'}${ev.live ? ' live' : ''} kind-${ev.kind}`,
      dataset: { id: ev.id },
      title: ev.live ? 'Happening now' : ev.clipUrl ? 'Play the clip' : 'Show the picture',
      onclick: () => this.o.onOpen(ev),
    },
    thumb,
    h('span', { class: 'event-text' },
      h('span', { class: 'event-line' }, h('span', { class: 'event-time' }, formatClock(ev.startedAt)), h('span', { class: `kind kind-${ev.kind}` }, kind)),
      h('span', { class: 'event-meta' }, meta)),
    ev.acknowledged ? null : h('span', { class: 'event-dot', 'aria-label': 'new' }));
  }
}
