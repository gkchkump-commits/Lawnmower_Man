// The camera's DOM side (implements CameraView of src/vision/index.js):
//   * the toolbar camera button (on/off) and the always-visible "camera on" indicator in the top
//     left corner of the stage (the toolbar itself only shows on hover),
//   * the 📷 button in the composer (a snapshot with the next message),
//   * the privacy card shown before the camera is used the first time, and the error card,
//   * body[data-camera] (off|consent|starting|on|paused|error) and body[data-face] for CSS,
//   * the "Camera" info block of the settings drawer.
// Cards use the setup-card look and live in #cards with the other cards.

import { h, icon } from '../ui/dom.js';

const STATE_TEXT = {
  off: 'Camera: off',
  consent: 'Camera: waiting for your OK',
  starting: 'Camera: starting…',
  on: 'Camera: on',
  paused: 'Camera: paused (window hidden)',
  error: 'Camera: not available',
};

export class CameraUi {
  /**
   * @param {object} dom
   * @param {HTMLElement} dom.body
   * @param {HTMLElement} dom.cards        #cards
   * @param {HTMLButtonElement|null} dom.button     toolbar #btn-camera
   * @param {HTMLButtonElement|null} dom.indicator  #cam-live
   * @param {HTMLButtonElement|null} dom.shot       composer #shot
   * @param {object} cb
   * @param {() => void} cb.onToggle    toolbar button / indicator
   * @param {() => void} cb.onShot      📷
   * @param {(msg: string, level?: string) => void} [cb.toast]
   * @param {(cams: Array<{ id: string, label: string }>, o?: { known?: boolean }) => void} [cb.setDevices]
   * @param {() => void} [cb.changed]
   */
  constructor(dom, cb) {
    this.dom = dom;
    this.cb = cb;
    /** @type {HTMLElement|null} */
    this._consent = null;
    /** @type {HTMLElement|null} */
    this._error = null;
    dom.button?.addEventListener('click', () => cb.onToggle());
    dom.indicator?.addEventListener('click', () => cb.onToggle());
    dom.shot?.addEventListener('click', (e) => {
      e.preventDefault();
      cb.onShot();
    });
    this.setState({ state: 'off', tracking: 'off', present: false, looking: false, shotArmed: false, shareAlways: false, gate: true });
  }

  /** @param {{ state: string, tracking: string, present: boolean, looking: boolean, shotArmed: boolean, shareAlways: boolean, gate: boolean }} s */
  setState(s) {
    const { body, button, indicator, shot } = this.dom;
    setData(body, 'camera', s.state);
    setData(body, 'face', s.state === 'on' && s.tracking === 'on' ? (s.present ? (s.looking ? 'looking' : 'present') : 'absent') : '');
    setData(body, 'listenGate', s.gate ? '' : 'closed');
    const live = s.state === 'on' || s.state === 'starting';
    if (button) {
      button.setAttribute('aria-pressed', String(s.state !== 'off'));
      button.title = `${STATE_TEXT[/** @type {keyof typeof STATE_TEXT} */ (s.state)] || 'Camera'} — click to turn it ${s.state === 'off' ? 'on' : 'off'}`;
    }
    if (indicator) {
      indicator.hidden = !live;
      indicator.title = s.state === 'starting' ? 'The camera is starting' : `The camera is on${s.tracking === 'on' ? (s.present ? ' and sees you' : ' (nobody in view)') : ''}. Click to turn it off.`;
    }
    if (shot) {
      shot.hidden = s.state !== 'on';
      const pressed = s.shotArmed || s.shareAlways;
      shot.setAttribute('aria-pressed', String(pressed));
      shot.classList.toggle('always', s.shareAlways);
      shot.title = s.shareAlways
        ? 'Claude sees you: every message carries a snapshot (Settings › Camera › Let Claude see me)'
        : s.shotArmed
          ? 'A snapshot goes with your next message (click to cancel)'
          : '📷 Let Claude see you with your next message';
    }
  }

  /** @param {{ onAccept: () => void, onDecline: () => void }} o */
  showConsent(o) {
    this.hideConsent();
    const accept = h('button', { type: 'button', class: 'btn amber camera-accept' }, 'Turn on the camera');
    const decline = h('button', { type: 'button', class: 'btn ghost camera-decline' }, 'Not now');
    accept.addEventListener('click', () => o.onAccept());
    decline.addEventListener('click', () => o.onDecline());
    const card = h('section', { class: 'setup-card camera-card kind-camera', role: 'region', 'aria-labelledby': 'camera-consent-title', dataset: { camera: 'consent' } },
      h('div', { class: 'setup-head' }, icon('camera', 'icon'), h('h3', { class: 'setup-title', id: 'camera-consent-title' }, 'Let the avatar see you?')),
      h('ul', { class: 'setup-steps camera-points' },
        h('li', null, 'The camera runs only on this PC. Face tracking happens here, offline; no video is recorded or uploaded.'),
        h('li', null, 'It lets the avatar make eye contact, notice when you come and go, and smile back.'),
        h('li', null, 'Claude sees a picture only when you turn on "Let Claude see me" (Settings › Camera) or press 📷 for one message.')),
      h('p', { class: 'setup-note' }, 'A light in the corner shows while the camera is on. Turn it off any time with the camera button, the tray menu or Settings › Camera.'),
      h('div', { class: 'setup-actions camera-actions' }, decline, accept));
    this._consent = card;
    this._show(card);
    accept.focus();
  }

  hideConsent() {
    this._hide(this._consent);
    this._consent = null;
  }

  /**
   * @param {import('./camera.js').CameraErrorModel} m
   * @param {{ onRetry: () => void, onTurnOff: () => void }} o
   */
  showError(m, o) {
    this.hideError();
    const retry = h('button', { type: 'button', class: 'btn amber camera-retry' }, 'Try again');
    const off = h('button', { type: 'button', class: 'btn ghost camera-off' }, 'Turn the camera off');
    retry.addEventListener('click', () => o.onRetry());
    off.addEventListener('click', () => o.onTurnOff());
    const close = h('button', { type: 'button', class: 'icon-btn tiny setup-close', 'aria-label': 'Close', title: 'Close' }, icon('close', 'icon tiny'));
    close.addEventListener('click', () => this.hideError());
    const card = h('section', { class: `setup-card camera-card kind-camera-error camera-${m.kind}`, role: 'region', 'aria-labelledby': 'camera-error-title', dataset: { camera: 'error', kind: m.kind } },
      h('div', { class: 'setup-head' }, icon('warn', 'icon'), h('h3', { class: 'setup-title', id: 'camera-error-title' }, m.title), close),
      h('p', { class: 'setup-intro' }, m.intro),
      h('ol', { class: 'setup-steps' }, m.steps.map((t) => h('li', null, t))),
      m.detail ? h('p', { class: 'setup-detail' }, h('span', { class: 'k' }, 'Details: '), m.detail) : null,
      h('div', { class: 'setup-actions camera-actions' }, off, retry));
    this._error = card;
    this._show(card);
  }

  hideError() {
    this._hide(this._error);
    this._error = null;
  }

  /** @param {string} msg @param {string} [level] */
  toast(msg, level) {
    this.cb.toast?.(msg, level);
  }

  /** @param {Array<{ id: string, label: string }>} cams @param {{ known?: boolean }} [o] */
  setDevices(cams, o) {
    this.cb.setDevices?.(cams, o);
  }

  changed() {
    this.cb.changed?.();
  }

  /** @param {HTMLElement} card */
  _show(card) {
    this.dom.cards.prepend(card);
    requestAnimationFrame(() => card.classList.add('shown'));
  }

  /** @param {HTMLElement|null} card */
  _hide(card) {
    if (!card) return;
    card.classList.remove('shown');
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 200);
  }
}

/** Lines for the Camera info block of the settings drawer. @param {any} st CameraFeature.status */
export function cameraInfoLines(st) {
  const lines = [];
  const line = (/** @type {string} */ k, /** @type {string} */ v, cls = '') => lines.push(h('div', { class: cls }, h('span', { class: 'k' }, `${k}: `), v));
  const state = { off: 'off', consent: 'waiting for your OK (see the card)', starting: 'starting…', on: 'on', paused: 'paused while the window is hidden', error: 'not available' }[/** @type {string} */ (st.state)] || st.state;
  line('Camera', `${state}${st.state === 'on' && st.label ? ` (${st.label})` : ''}`, st.state === 'error' ? 'warn' : '');
  if (st.state === 'error' && st.error) lines.push(h('div', { class: 'warn' }, `${st.error.title}. ${st.error.steps?.[0] || ''}`));
  if (st.state === 'on') {
    const tracking = st.tracking === 'on'
      ? `on this PC (${st.mode === 'main' ? 'main thread' : 'worker'}, ${st.delegate || 'CPU'}) · ${st.rate}/s${st.lastMs ? ` · ${Math.round(st.lastMs)} ms` : ''}`
      : st.tracking === 'loading' ? 'loading…' : st.tracking === 'failed' ? `unavailable — ${st.trackingError}` : 'off';
    line('Face tracking', tracking, st.tracking === 'failed' ? 'warn' : '');
    if (st.tracking === 'on') {
      const you = st.present
        ? [st.looking ? 'looking at the screen' : 'in view', Number.isFinite(st.distanceCm) ? `about ${Math.round(st.distanceCm / 5) * 5} cm away` : '', st.smiling ? 'smiling' : '', st.talking ? 'talking' : ''].filter(Boolean).join(', ')
        : 'not in view';
      line('You', you);
    }
    if (!st.gate) lines.push(h('div', null, 'Hands-free is waiting for you to look at the screen.'));
  }
  return lines;
}

/** @param {HTMLElement} el @param {string} key @param {string} v */
function setData(el, key, v) {
  if (el.dataset[key] !== v) el.dataset[key] = v;
}
