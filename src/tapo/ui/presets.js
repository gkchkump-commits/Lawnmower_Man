// Saved camera positions (contract §9.2 sidebar): the camera's own presets (including the ones
// made in the Tapo app) and, where the camera supports it, positions this app keeps. A click
// goes there; keys 1–8 too, in list order. "Save current position…" asks for a name; the star
// makes a position the home position (the D-pad's ⌂ and "camera home").

import { clear, h } from '../../ui/dom.js';
import { tapoIcon } from './icons.js';

export class PresetsPanel {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {(p: any) => void} o.onGo
   * @param {() => void} o.onSave
   * @param {() => void} o.onRefresh
   * @param {(p: any) => void} o.onSetHome
   * @param {(p: any) => void} o.onRemove
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    /** @type {any[]} */
    this.presets = [];
    this.homeToken = '';
    this.enabled = true;
    this.list = h('div', { class: 'preset-list', role: 'list' });
    this.empty = h('p', { class: 'side-empty', hidden: true }, 'No saved positions yet. Turn the camera, then press “Save current position…”. Positions saved in the Tapo app show up here too.');
    this.saveBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn ghost side-btn', onclick: () => o.onSave() }, tapoIcon('plus', 'icon tiny'), 'Save current position…'));
    const refresh = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Refresh the saved positions', title: 'Refresh (also loads positions saved in the Tapo app)', onclick: () => o.onRefresh() }, tapoIcon('refresh', 'icon tiny'));
    root.append(h('header', { class: 'side-head' }, h('h2', null, 'Positions'), refresh), this.list, this.empty, this.saveBtn);
  }

  /** @param {any[]} presets @param {string} homeToken */
  setPresets(presets, homeToken = '') {
    this.presets = Array.isArray(presets) ? presets : [];
    this.homeToken = homeToken;
    this._render();
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle('disabled', !on);
    this.saveBtn.disabled = !on;
    for (const b of this.list.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = !on;
  }

  _render() {
    clear(this.list);
    this.empty.hidden = this.presets.length > 0;
    this.presets.forEach((p, i) => {
      const home = !!p.home || (!!this.homeToken && p.token === this.homeToken);
      const go = h('button', { type: 'button', class: 'preset-go', title: `Go to ${p.name}${i < 8 ? ` (key ${i + 1})` : ''}`, dataset: { token: p.token }, onclick: () => this.o.onGo(p) },
        i < 8 ? h('kbd', { class: 'preset-key' }, String(i + 1)) : null,
        h('span', { class: 'preset-name' }, p.name),
        home ? h('span', { class: 'preset-home', title: 'Home position' }, tapoIcon('home', 'icon tiny')) : null);
      const star = h('button', { type: 'button', class: `icon-btn tiny preset-star${home ? ' on' : ''}`, 'aria-label': home ? `${p.name} is the home position` : `Make ${p.name} the home position`, title: home ? 'This is the home position' : 'Make this the home position', 'aria-pressed': String(home), onclick: () => this.o.onSetHome(p) }, tapoIcon('star', 'icon tiny'));
      const remove = h('button', { type: 'button', class: 'icon-btn tiny preset-remove', 'aria-label': `Remove ${p.name}`, title: 'Remove this position', onclick: () => this.o.onRemove(p) }, tapoIcon('close', 'icon tiny'));
      this.list.append(h('div', { class: 'preset', role: 'listitem' }, go, star, remove));
    });
    this.setEnabled(this.enabled);
  }
}
