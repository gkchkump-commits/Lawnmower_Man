// The live view (contract §9.2): the canvas the security worker draws on, and everything over
// it in the DOM — person boxes, a crosshair under the pointer, the "moving…" hint, the
// placeholders (offline, privacy mode, a format this PC cannot decode…). A single click turns
// the camera to that spot (click-to-center, in video coordinates with the letterbox bars
// excluded); a double-click toggles full screen, so a single click waits a moment to be sure.
/* global ResizeObserver */

import { append, clear, h } from '../../ui/dom.js';
import { boxToView, letterbox, uvAt } from '../geometry.js';
import { tapoIcon } from './icons.js';

export { letterbox, uvAt };

/** How long a single click waits for a second one (a double-click toggles full screen). */
export const DOUBLE_CLICK_MS = 260;

export class LiveView {
  /**
   * @param {HTMLElement} root  #live
   * @param {object} o
   * @param {(uv: { u: number, v: number }) => void} o.onCenter
   * @param {() => void} o.onToggleFullscreen
   * @param {(size: { width: number, height: number, dpr: number }) => void} o.onResize
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.video = { width: 16, height: 9 };
    this.centerEnabled = true;
    this.canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
    this.boxes = h('div', { class: 'live-boxes', 'aria-hidden': 'true' });
    this.cross = h('div', { class: 'live-cross', hidden: true, 'aria-hidden': 'true' });
    this.ping = h('div', { class: 'live-ping', hidden: true, 'aria-hidden': 'true' });
    this.moving = h('div', { class: 'live-moving', hidden: true, role: 'status' }, h('span', { class: 'live-moving-dot' }), 'Turning…');
    this.placeholder = h('div', { class: 'live-placeholder', hidden: true, role: 'status' });
    this.hint = h('div', { class: 'live-hint', hidden: true }, tapoIcon('target', 'icon tiny'), 'Click the picture to turn the camera there · double-click for full screen');
    root.append(this.boxes, this.cross, this.ping, this.moving, this.placeholder, this.hint);
    /** @type {any[]} */
    this._persons = [];
    this._clickTimer = 0;
    this._rect = { width: 0, height: 0 };

    root.addEventListener('pointermove', (e) => this._move(e));
    root.addEventListener('pointerleave', () => {
      this.cross.hidden = true;
    });
    root.addEventListener('click', (e) => this._click(e));
    root.addEventListener('dblclick', (e) => {
      if (this._fromControl(e)) return;
      clearTimeout(this._clickTimer);
      this._clickTimer = 0;
      o.onToggleFullscreen();
    });
    const ro = new ResizeObserver(() => this._resized());
    ro.observe(root);
    this._resized();
  }

  /** @param {Event} e */
  _fromControl(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    return !!t?.closest?.('button, a, input, select, .dpad, .live-placeholder .btn');
  }

  _resized() {
    const r = this.root.getBoundingClientRect();
    this._rect = { width: r.width, height: r.height };
    this.o.onResize({ width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 });
    this._drawBoxes();
  }

  /** The decoded video's size (only its aspect matters). @param {number} width @param {number} height */
  setVideoSize(width, height) {
    if (!(width > 0) || !(height > 0)) return;
    if (width === this.video.width && height === this.video.height) return;
    this.video = { width, height };
    this._drawBoxes();
  }

  /** The video rectangle inside the view (CSS px). */
  videoRect() {
    return letterbox(this.video.width, this.video.height, this._rect.width, this._rect.height);
  }

  /** @param {PointerEvent} e */
  _move(e) {
    if (!this.centerEnabled || this._fromControl(e) || !this.placeholder.hidden) {
      this.cross.hidden = true;
      return;
    }
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const uv = uvAt(x, y, r.width, r.height, this.video.width, this.video.height);
    this.cross.hidden = !uv;
    if (uv) this.cross.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** @param {MouseEvent} e */
  _click(e) {
    if (this._fromControl(e) || e.button !== 0) return;
    if (!this.centerEnabled || !this.placeholder.hidden) return;
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const uv = uvAt(x, y, r.width, r.height, this.video.width, this.video.height);
    if (!uv) return;
    if (this._clickTimer) return; // the second click of a double-click
    this._showPing(x, y);
    this._clickTimer = /** @type {any} */ (setTimeout(() => {
      this._clickTimer = 0;
      this.hint.hidden = true;
      this.o.onCenter(uv);
    }, DOUBLE_CLICK_MS));
  }

  /** @param {number} x @param {number} y */
  _showPing(x, y) {
    this.ping.hidden = false;
    this.ping.style.transform = `translate(${x}px, ${y}px)`;
    this.ping.classList.remove('go');
    void this.ping.offsetWidth; // restart the animation
    this.ping.classList.add('go');
  }

  /** @param {boolean} on @param {string} [why] */
  setCenterEnabled(on, why = '') {
    this.centerEnabled = !!on;
    this.root.classList.toggle('no-center', !on);
    this.root.title = on ? '' : why;
    if (!on) this.cross.hidden = true;
  }

  /** @param {boolean} on */
  setMoving(on) {
    this.moving.hidden = !on;
  }

  /** @param {boolean} on */
  showHint(on) {
    this.hint.hidden = !on;
  }

  /**
   * @param {{ kind: string, title: string, detail: string, tone: string }|null} p
   * @param {{ label: string, onClick: () => void }|null} [action]
   */
  setPlaceholder(p, action = null) {
    const el = this.placeholder;
    if (!p) {
      el.hidden = true;
      delete this.root.dataset.placeholder;
      return;
    }
    const key = `${p.kind}|${p.title}|${p.detail}|${action?.label || ''}`;
    this.root.dataset.placeholder = p.kind;
    if (!el.hidden && el.dataset.key === key) return;
    el.dataset.key = key;
    clear(el);
    el.className = `live-placeholder tone-${p.tone}`;
    const ico = { offline: 'warn', auth: 'warn', privacy: 'shield', codec: 'warn', 'video-error': 'warn', missing: 'warn', stalled: 'refresh', setup: 'gear', off: 'camera' }[p.kind] || 'camera';
    append(el, [
      p.tone === 'busy' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : tapoIcon(/** @type {any} */ (ico), 'icon live-ph-icon'),
      h('div', { class: 'live-ph-title' }, p.title),
      p.detail ? h('div', { class: 'live-ph-detail' }, p.detail) : null,
      action ? h('button', { type: 'button', class: 'btn amber live-ph-action', onclick: action.onClick }, action.label) : null,
    ]);
    el.hidden = false;
    this.cross.hidden = true;
  }

  /** Person boxes to draw (video fractions). @param {Array<{ score: number, box: number[] }>} persons */
  setPersons(persons) {
    this._persons = Array.isArray(persons) ? persons.slice(0, 10) : [];
    this._drawBoxes();
  }

  _drawBoxes() {
    clear(this.boxes);
    if (!this._persons.length) return;
    const v = this.videoRect();
    for (const p of this._persons) {
      const r = boxToView(/** @type {[number, number, number, number]} */ (p.box), v);
      this.boxes.append(h('div', {
        class: 'live-box',
        style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` },
      }, h('span', { class: 'live-box-label' }, `Person ${Math.round(p.score * 100)}%`)));
    }
  }
}
