// The on-screen D-pad (contract §9.2) and the press-and-hold logic it shares with the arrow
// keys. A click is a nudge (a fixed turn); a press held longer than 300 ms turns the camera
// continuously, with a heartbeat every 250 ms; main stops the motors when the heartbeats stop
// (700 ms), so a lost release can never leave the camera grinding. Releasing, the pointer
// leaving, the window losing focus or being hidden all end a hold.

import { h } from '../../ui/dom.js';
import { tapoIcon } from './icons.js';

export const HOLD_MS = 300;
export const HEARTBEAT_MS = 250;

/** @typedef {'left'|'right'|'up'|'down'} Dir */
/** @typedef {'small'|'medium'|'large'} Amount */

export class PressHold {
  /**
   * @param {object} o
   * @param {(dir: Dir, amount: Amount) => void} o.onNudge  a short press
   * @param {(dir: Dir) => void} o.onHold                   held longer than holdMs
   * @param {() => void} o.onHeartbeat                      every heartbeatMs while held
   * @param {() => void} o.onRelease                        the end of a hold
   * @param {number} [o.holdMs] @param {number} [o.heartbeatMs]
   * @param {(fn: () => void, ms: number) => any} [o.setTimeout] @param {(id: any) => void} [o.clearTimeout]
   * @param {(fn: () => void, ms: number) => any} [o.setInterval] @param {(id: any) => void} [o.clearInterval]
   */
  constructor(o) {
    this.o = o;
    this.holdMs = o.holdMs ?? HOLD_MS;
    this.heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
    this._st = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._ct = o.clearTimeout || ((id) => clearTimeout(id));
    this._si = o.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._ci = o.clearInterval || ((id) => clearInterval(id));
    /** @type {{ dir: Dir, amount: Amount, holding: boolean, timer: any, beat: any }|null} */
    this.active = null;
  }

  get holding() {
    return !!this.active?.holding;
  }

  /** @param {Dir} dir @param {Amount} [amount] */
  press(dir, amount = 'medium') {
    if (this.active) {
      if (this.active.dir === dir) return; // key repeat / a second pointer on the same arrow
      this.release();
    }
    const a = { dir, amount, holding: false, timer: null, beat: null };
    a.timer = this._st(() => {
      if (this.active !== a) return;
      a.holding = true;
      this.o.onHold(dir);
      a.beat = this._si(() => {
        if (this.active === a) this.o.onHeartbeat();
      }, this.heartbeatMs);
    }, this.holdMs);
    this.active = a;
  }

  /** The press ended normally: a short press nudges, a hold stops. */
  release() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this._ct(a.timer);
    if (a.holding) {
      this._ci(a.beat);
      this.o.onRelease();
    } else {
      this.o.onNudge(a.dir, a.amount);
    }
  }

  /** The press was interrupted (pointer left, focus lost): stop a hold, never nudge. */
  cancel() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this._ct(a.timer);
    if (a.holding) {
      this._ci(a.beat);
      this.o.onRelease();
    }
  }
}

const LABELS = { up: 'Tilt up', down: 'Tilt down', left: 'Turn left', right: 'Turn right' };

export class DPad {
  /**
   * @param {HTMLElement} root
   * @param {{ hold: PressHold, onHome: () => void }} o
   */
  constructor(root, o) {
    this.root = root;
    this.hold = o.hold;
    /** @type {Record<string, HTMLButtonElement>} */
    this.buttons = {};
    root.classList.add('dpad');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Pan and tilt');
    for (const dir of /** @type {Dir[]} */ (['up', 'left', 'right', 'down'])) {
      const b = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: `dpad-btn dpad-${dir}`, 'aria-label': LABELS[dir], title: `${LABELS[dir]} (click: a step, hold: keep turning)`, dataset: { dir } }, tapoIcon(dir)));
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || b.disabled) return;
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId);
        } catch { /* the release still arrives */ }
        b.classList.add('pressed');
        this.hold.press(dir, e.shiftKey ? 'large' : e.altKey ? 'small' : 'medium');
      });
      const end = (/** @type {boolean} */ normal) => () => {
        b.classList.remove('pressed');
        if (normal) this.hold.release();
        else this.hold.cancel();
      };
      b.addEventListener('pointerup', end(true));
      b.addEventListener('pointercancel', end(false));
      b.addEventListener('lostpointercapture', end(false));
      // the keyboard (Enter/Space on a focused arrow) clicks without pointer events
      b.addEventListener('click', (e) => {
        if (e.detail === 0 && !b.disabled) {
          this.hold.press(dir, 'medium');
          this.hold.release();
        }
      });
      this.buttons[dir] = b;
    }
    const home = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'dpad-btn dpad-home', 'aria-label': 'Home position', title: 'Back to the home position (H)' }, tapoIcon('home')));
    home.addEventListener('click', () => o.onHome());
    this.buttons.home = home;
    root.append(this.buttons.up, this.buttons.left, home, this.buttons.right, this.buttons.down);
  }

  /** @param {boolean} on @param {string} [why] */
  setEnabled(on, why = '') {
    this.root.classList.toggle('disabled', !on);
    for (const b of Object.values(this.buttons)) {
      b.disabled = !on;
      if (!on) b.title = why;
      else if (b.dataset.dir) b.title = `${LABELS[/** @type {Dir} */ (b.dataset.dir)]} (click: a step, hold: keep turning)`;
      else b.title = 'Back to the home position (H)';
    }
    if (!on) this.hold.cancel();
  }
}
