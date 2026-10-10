// Camera setup and settings (contract §9.2 "Setup", §14): shown instead of the live view when
// the camera is not set up yet, and from the gear. The connection (name, address, Camera
// Account, ports, stream) is entered, tested and then saved together; everything else saves
// as it changes. The password field is never filled in: the renderer never sees the password,
// it only knows whether one is saved.

import { clear, h } from '../../ui/dom.js';
import { getPath, patchFor } from '../../app/settings-defaults.js';
import { DESCRIBE_CONSENT, hasDescribeConsent, rememberDescribeConsent } from '../consent.js';
import { checkHost, checkPassword, checkPort, checkQuietHours, checkUsername } from '../validate.js';
import { tapoIcon } from './icons.js';
import { openDialog } from './dialogs.js';

export const CHECKLIST_KEY = 'lawnmower.tapo.checklist.v1';

/** The Tapo app steps (contract §14), in the user's words. */
export const TAPO_STEPS = Object.freeze([
  { id: 'app', title: 'The camera works in the Tapo app', text: 'Update the Tapo app and the camera’s firmware if it offers to.' },
  { id: 'account', title: 'Create a Camera Account', text: 'In the Tapo app: tap the camera › the gear (Settings) › Advanced Settings › Camera Account › “Understand and Agree to Use”. Choose a user name and a password (6–32 characters). This is not your TP-Link login.' },
  { id: 'quality', title: 'Set the video quality to the best', text: 'Tapo app › camera › the live view’s quality button › 2K / Best.' },
  { id: 'detection', title: 'Turn on motion and person detection', text: 'Tapo app › camera › Settings › Detection. Optional, but alerts come faster and more reliably.' },
  { id: 'privacy', title: 'Turn privacy mode off', text: 'Privacy mode stops the video and the motors.' },
  { id: 'care', title: 'Not both Tapo Care and a microSD card', text: 'Cloud recording and a memory card at the same time switch off the access this app uses.' },
  { id: 'address', title: 'Give the camera a fixed address', text: 'In your router: a “DHCP reservation” for the camera, so its address never changes. Keep the PC and the camera on the same network (not guest Wi-Fi), and never forward ports 554 or 2020.' },
]);

/** @param {string} id */
const field = (id) => `tapo-set-${id}`;

export class SetupPanel {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {any} o.bridge                 window.lawnmowerCamera
   * @param {(patch: any) => Promise<any>} o.saveSettings  resolves with the settings main kept
   * @param {(msg: string, level?: string) => void} o.toast
   * @param {() => void} o.onCalibrate
   * @param {() => void} o.onClose
   * @param {{ getItem: Function, setItem: Function }|null} [o.storage]
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.bridge = o.bridge;
    this.storage = o.storage === undefined ? safeLocalStorage() : o.storage;
    /** @type {any} */
    this.settings = null;
    /** @type {any} */
    this.status = null;
    /** @type {Map<string, (s: any) => void>} refreshers of the live (immediately saved) fields */
    this.live = new Map();
    this._build();
  }

  get shown() {
    return !this.root.hidden;
  }

  /** @param {{ focus?: 'password'|'host' }} [o] */
  show(o = {}) {
    this.root.hidden = false;
    this._fillConnection();
    this._sync();
    requestAnimationFrame(() => {
      if (o.focus === 'password') {
        this.inputs.password.scrollIntoView({ block: 'center' });
        this.inputs.password.focus({ preventScroll: true });
      } else if (!this.inputs.host.value) {
        // the first visit starts at the top (the Tapo app checklist), the cursor already in the address
        this.root.scrollTop = 0;
        this.inputs.host.focus({ preventScroll: true });
      }
    });
  }

  hide() {
    this.root.hidden = true;
  }

  /** @param {any} status @param {any} settings */
  update(status, settings) {
    const first = !this.settings;
    this.status = status;
    this.settings = settings;
    if (first) this._fillConnection();
    this._sync();
  }

  // ------------------------------------------------------------------------------------------

  _build() {
    clear(this.root);
    const close = h('button', { type: 'button', class: 'icon-btn setup-close', 'aria-label': 'Close the settings', title: 'Back to the camera', onclick: () => this.o.onClose() }, tapoIcon('close'));
    this.closeBtn = close;
    this.title = h('h2', { class: 'setup-h' }, 'Set up your camera');
    this.intro = h('p', { class: 'setup-lead' }, 'Lawnmower Man talks to your Tapo camera directly over your home network. Nothing goes through the internet.');

    // ---- in the Tapo app
    const done = this._checklist();
    this.steps = h('details', { class: 'setup-sec checklist' },
      h('summary', null, h('span', { class: 'sec-title' }, '1. In the Tapo app on your phone'), this.stepsCount = h('span', { class: 'sec-note' })),
      h('ol', { class: 'steps' }, TAPO_STEPS.map((s) => {
        const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: `step-${s.id}`, checked: !!done[s.id] }));
        box.addEventListener('change', () => {
          const d = this._checklist();
          d[s.id] = box.checked;
          try {
            this.storage?.setItem(CHECKLIST_KEY, JSON.stringify(d));
          } catch { /* not remembered */ }
          this._countSteps();
        });
        return h('li', { class: 'step' }, h('label', { for: `step-${s.id}` }, box, h('span', { class: 'step-text' }, h('strong', null, s.title), h('span', null, s.text))));
      })));

    // ---- connection
    const input = (/** @type {string} */ id, /** @type {Record<string, any>} */ attrs = {}) => /** @type {HTMLInputElement} */ (h('input', { id: field(id), type: 'text', spellcheck: 'false', autocomplete: 'off', ...attrs }));
    this.inputs = {
      name: input('name', { maxlength: 40, placeholder: 'camera' }),
      host: input('host', { placeholder: '192.168.1.50', inputmode: 'url' }),
      username: input('username', { maxlength: 64, autocomplete: 'username' }),
      password: input('password', { type: 'password', maxlength: 128, autocomplete: 'new-password' }),
      onvifPort: input('onvifPort', { inputmode: 'numeric', maxlength: 5 }),
      rtspPort: input('rtspPort', { inputmode: 'numeric', maxlength: 5 }),
    };
    this.streamSel = /** @type {HTMLSelectElement} */ (h('select', { id: field('stream') },
      h('option', { value: 'stream1' }, 'stream1 — full quality'), h('option', { value: 'stream2' }, 'stream2 — small (640×360)')));
    /** @type {Record<string, HTMLElement>} */
    this.errors = {};
    const row = (/** @type {string} */ id, /** @type {string} */ label, /** @type {HTMLElement} */ control, /** @type {string} */ hint = '', /** @type {any} */ extra = null) => {
      const err = h('div', { class: 'form-error', id: `${field(id)}-error`, hidden: true, role: 'alert' });
      this.errors[id] = err;
      control.setAttribute('aria-describedby', `${field(id)}-error`);
      return h('div', { class: 'form-row' }, h('label', { class: 'form-label', for: field(id) }, label),
        h('div', { class: 'form-control' }, h('div', { class: 'form-inline' }, control, extra), hint ? h('div', { class: 'form-hint' }, hint) : null, err));
    };
    this.findBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn ghost', onclick: () => this._discover() }, tapoIcon('search', 'icon tiny'), 'Find cameras'));
    this.found = h('div', { class: 'found', hidden: true });
    this.showPw = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Show the password', title: 'Show the password', 'aria-pressed': 'false', onclick: () => {
      const on = this.inputs.password.type === 'password';
      this.inputs.password.type = on ? 'text' : 'password';
      this.showPw.setAttribute('aria-pressed', String(on));
    } }, tapoIcon('eye', 'icon tiny')));
    this.pwState = h('div', { class: 'form-hint pw-state' });
    this.forgetBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'link-btn', onclick: () => this._forget() }, 'Forget the saved password'));
    this.testBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn ghost', onclick: () => this._test() }, 'Test connection'));
    this.saveBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn amber', onclick: () => this._save() }, 'Save'));
    this.report = h('div', { class: 'report', hidden: true, 'aria-live': 'polite' });
    const ports = h('details', { class: 'sub' }, h('summary', null, 'Ports and stream (only if you changed them)'),
      row('onvifPort', 'ONVIF port', this.inputs.onvifPort, 'Tapo: 2020'),
      row('rtspPort', 'Video (RTSP) port', this.inputs.rtspPort, 'Tapo: 554'),
      row('stream', 'Video stream', this.streamSel, 'stream2 is lighter if this PC struggles or cannot decode stream1'));
    this.connect = h('section', { class: 'setup-sec open' },
      h('h3', { class: 'sec-title' }, '2. Connect'),
      row('host', 'Camera address', this.inputs.host, 'Its IP address on your network. The Tapo app shows it under camera › Settings › Device Info.', this.findBtn),
      this.found,
      row('username', 'Camera Account user name', this.inputs.username),
      h('div', { class: 'form-row' }, h('label', { class: 'form-label', for: field('password') }, 'Camera Account password'),
        h('div', { class: 'form-control' }, h('div', { class: 'form-inline' }, this.inputs.password, this.showPw), this.pwState, this.errors.password = h('div', { class: 'form-error', id: `${field('password')}-error`, hidden: true, role: 'alert' }), this.forgetBtn)),
      row('name', 'What do you call it?', this.inputs.name, 'The avatar says “Someone is at the …”. For example: front door camera, hallway camera.'),
      ports,
      h('div', { class: 'form-actions' }, this.testBtn, this.saveBtn),
      this.report);
    this.inputs.password.setAttribute('aria-describedby', `${field('password')}-error`);
    for (const k of /** @type {const} */ (['host', 'username', 'password', 'name', 'onvifPort', 'rtspPort'])) {
      this.inputs[k].addEventListener('input', () => this._clearError(k));
      this.inputs[k].addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') this._save();
      });
    }

    // ---- pan and tilt
    this.calibBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn ghost', onclick: () => this.o.onCalibrate() }, tapoIcon('calibrate', 'icon tiny'), 'Calibrate…'));
    this.calibNote = h('div', { class: 'form-hint' });
    const ptz = h('details', { class: 'setup-sec' }, h('summary', null, h('span', { class: 'sec-title' }, '3. Pan and tilt')),
      h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, 'Directions'), h('div', { class: 'form-control' }, this.calibBtn, this.calibNote)),
      this._toggle('tapo.invertPan', 'Swap left and right', 'If the camera turns the wrong way left/right'),
      this._toggle('tapo.invertTilt', 'Swap up and down', 'If the camera tilts the wrong way'),
      this._select('tapo.ptz', 'How it moves', [['auto', 'Automatic'], ['relative', 'Steps (relative moves)'], ['continuous', 'Continuous'], ['off', 'Off (no pan and tilt)']]),
      this._range('tapo.stepMedium', 'Arrow step', 0.05, 0.8, 0.05, (v) => `${Math.round(v * 100)} % of the view`),
      this._range('tapo.holdSpeed', 'Speed when held', 0.1, 1, 0.05, (v) => `${Math.round(v * 100)} %`));

    // ---- alerts and recording
    const alerts = h('details', { class: 'setup-sec' }, h('summary', null, h('span', { class: 'sec-title' }, '4. Alerts and recording')),
      this._range('security.armDelaySec', 'Time to leave after arming', 0, 120, 5, (v) => (v ? `${v} s` : 'none')),
      this._select('security.notify', 'Windows notification for', [['person', 'People'], ['motion', 'People and movement'], ['off', 'Nothing']]),
      this._select('security.record', 'Save a video clip for', [['person', 'People'], ['motion', 'People and movement'], ['off', 'Nothing']]),
      this._segmented('security.sensitivity', 'Sensitivity', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
      this._toggle('security.announce', 'The avatar says it', '“Someone is at the front door camera.”'),
      this._toggle('security.showOnAlert', 'Bring the avatar back on an alert', 'Even when it is hidden in the tray'),
      this._text('security.quietHours', 'Quiet hours', '23:00-07:00', 'No spoken alerts and silent notifications in this time', checkQuietHours),
      this._range('security.cooldownSec', 'At most one alert every', 10, 600, 10, (v) => (v < 60 ? `${v} s` : `${Math.round(v / 6) / 10} min`)),
      this._toggle('security.people', 'Watch for people'),
      this._toggle('security.motion', 'List movement too', 'Movement alone is listed, not announced'),
      this._toggle('security.cameraEvents', 'Use the camera’s own detection', 'Its motion and person events (if turned on in the Tapo app)'),
      this._toggle('security.confirmLocally', 'Double-check people on this PC', 'Fewer false alarms: an alert needs this PC’s person detector to agree'),
      this._range('security.retentionDays', 'Keep clips for', 1, 90, 1, (v) => `${v} day${v === 1 ? '' : 's'}`),
      this._range('security.maxStorageGB', 'Use at most', 0.5, 50, 0.5, (v) => `${v} GB`),
      this._text('security.clipsDir', 'Clips folder', 'Videos\\Lawnmower Man\\Security', 'Leave empty for the default'));

    // ---- Claude
    this.seeNote = h('div', { class: 'form-hint warn', hidden: true }, 'Claude can then look through the camera whenever it decides to, without asking you.');
    const claude = h('details', { class: 'setup-sec' }, h('summary', null, h('span', { class: 'sec-title' }, '5. Claude and the avatar')),
      this._toggle('security.voiceCommands', 'Quick commands', '“camera left”, “look at the door”, “arm the camera” work at once, without asking Claude'),
      this._select('security.claudeSee', 'Claude may look through the camera', [['ask', 'Ask me every time'], ['always', 'Always'], ['never', 'Never']], 'When you ask it to check'),
      this.seeNote,
      this._select('security.claudeMove', 'Claude may turn the camera', [['ask', 'Ask me every time'], ['always', 'Always'], ['never', 'Never']]),
      this._toggle('security.describe', 'Claude describes alerts', 'Sends the alert picture to Claude for one sentence about it', { consent: true }));

    // ---- window
    const win = h('details', { class: 'setup-sec' }, h('summary', null, h('span', { class: 'sec-title' }, '6. This window')),
      this._toggle('tapo.windowOnTop', 'Always on top'),
      this._toggle('tapo.showDetections', 'Show person boxes while disarmed', 'Uses a little more CPU'));

    this.root.append(h('div', { class: 'setup-inner' },
      h('header', { class: 'setup-top' }, this.title, close), this.intro, this.steps, this.connect, ptz, alerts, claude, win));
    this._countSteps();
    // the user opened or closed the checklist: leave it that way
    this.steps.querySelector('summary')?.addEventListener('click', () => { this.steps.dataset.touched = '1'; });
  }

  _checklist() {
    try {
      const v = JSON.parse(this.storage?.getItem(CHECKLIST_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  _countSteps() {
    const d = this._checklist();
    const n = TAPO_STEPS.filter((s) => d[s.id]).length;
    this.stepsCount.textContent = `${n} of ${TAPO_STEPS.length} done`;
  }

  _fillConnection() {
    const t = this.settings?.tapo;
    if (!t) return;
    this.inputs.name.value = t.name || '';
    this.inputs.host.value = t.host || '';
    this.inputs.username.value = t.username || '';
    this.inputs.onvifPort.value = String(t.onvifPort ?? 2020);
    this.inputs.rtspPort.value = String(t.rtspPort ?? 554);
    this.streamSel.value = t.stream || 'stream1';
    this.inputs.password.value = '';
  }

  _sync() {
    const st = this.status;
    const s = this.settings;
    const configured = !!st?.configured;
    this.title.textContent = configured ? 'Camera settings' : 'Set up your camera';
    this.intro.hidden = configured;
    this.closeBtn.hidden = !configured;
    if (!configured && !this.steps.dataset.touched) this.steps.open = true;
    const has = !!st?.hasPassword;
    this.inputs.password.placeholder = has ? 'Saved ✓ — type a new one to change it' : '';
    this.pwState.textContent = !has ? 'The password is kept encrypted on this PC and never shown again.'
      : st.persistence === 'memory' ? 'Saved until Lawnmower Man closes: this PC cannot encrypt it, so you will be asked again next time.'
        : 'Saved, encrypted on this PC.';
    this.pwState.classList.toggle('warn', has && st.persistence === 'memory');
    this.forgetBtn.hidden = !has;
    const cal = s?.tapo?.calibratedAt;
    this.calibNote.textContent = cal ? `Calibrated on ${new Date(cal).toLocaleDateString()}.` : 'Not calibrated yet: the arrows may turn the wrong way until you do (about 30 seconds).';
    this.calibBtn.disabled = !st?.ptz?.available;
    this.calibBtn.title = st?.ptz?.available ? 'The camera turns a little left, right, up and down to learn its directions' : 'Pan and tilt are not available right now';
    this.seeNote.hidden = getPath(s || {}, 'security.claudeSee') !== 'always';
    if (s) for (const refresh of this.live.values()) refresh(s);
  }

  // ---- connection: test and save ------------------------------------------------------------

  /** @param {string} k */
  _clearError(k) {
    const e = this.errors[k];
    if (e) {
      e.hidden = true;
      e.textContent = '';
    }
    this.inputs[/** @type {'host'} */ (k)]?.removeAttribute('aria-invalid');
  }

  /** @param {string} k @param {string} msg */
  _error(k, msg) {
    const e = this.errors[k];
    if (!e) return;
    e.textContent = msg;
    e.hidden = false;
    this.inputs[/** @type {'host'} */ (k)]?.setAttribute('aria-invalid', 'true');
  }

  /**
   * @param {{ needPassword: boolean }} o
   * @returns {null | { name: string, host: string, username: string, password: string, onvifPort: number, rtspPort: number, stream: string }}
   */
  _collect(o) {
    let ok = true;
    const host = checkHost(this.inputs.host.value);
    if (!host.ok) {
      this._error('host', host.error);
      ok = false;
    }
    const user = checkUsername(this.inputs.username.value);
    if (!user.ok) {
      this._error('username', user.error);
      ok = false;
    }
    let password = '';
    if (this.inputs.password.value || o.needPassword) {
      const p = checkPassword(this.inputs.password.value);
      if (!p.ok) {
        this._error('password', p.error);
        ok = false;
      } else {
        password = p.value;
        if (p.warning) this.o.toast(p.warning, 'warn');
      }
    }
    const op = checkPort(this.inputs.onvifPort.value || '2020');
    const rp = checkPort(this.inputs.rtspPort.value || '554');
    if (!op.ok) {
      this._error('onvifPort', op.error);
      ok = false;
    }
    if (!rp.ok) {
      this._error('rtspPort', rp.error);
      ok = false;
    }
    const name = this.inputs.name.value.trim().replace(/\s+/g, ' ').slice(0, 40) || 'camera';
    if (!ok) {
      /** @type {HTMLElement|null} */ (this.root.querySelector('[aria-invalid="true"]'))?.focus();
      // the ports live in a folded section
      if (!op.ok || !rp.ok) /** @type {HTMLDetailsElement} */ (this.inputs.onvifPort.closest('details')).open = true;
      return null;
    }
    return { name, host: /** @type {any} */ (host).value, username: /** @type {any} */ (user).value, password, onvifPort: /** @type {any} */ (op).value, rtspPort: /** @type {any} */ (rp).value, stream: this.streamSel.value };
  }

  async _test() {
    const c = this._collect({ needPassword: !this.status?.hasPassword });
    if (!c) return;
    this.testBtn.disabled = true;
    this._renderReport({ busy: true });
    try {
      /** @type {Record<string, any>} */
      const over = { host: c.host, onvifPort: c.onvifPort, rtspPort: c.rtspPort, username: c.username };
      if (c.password) over.password = c.password;
      this._renderReport(await this.bridge.tapo.test(over));
    } catch (err) {
      this._renderReport({ ok: false, steps: [{ id: 'error', label: 'Test', ok: false, detail: String(/** @type {any} */ (err)?.message || err) }] });
    } finally {
      this.testBtn.disabled = false;
    }
  }

  /** @param {any} r TestReport (or { busy }) */
  _renderReport(r) {
    const el = this.report;
    clear(el);
    el.hidden = false;
    if (r.busy) {
      el.className = 'report busy';
      el.append(h('div', { class: 'report-head' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Testing the connection… (the camera does not move)'));
      return;
    }
    el.className = `report ${r.ok ? 'ok' : 'fail'}`;
    el.append(h('div', { class: 'report-head' }, tapoIcon(r.ok ? 'check' : 'warn', 'icon'), r.ok ? 'Everything works. Press Save.' : 'Something is not right yet:'));
    const list = h('ol', { class: 'report-steps' });
    for (const s of Array.isArray(r.steps) ? r.steps : []) {
      const state = s.ok === true ? 'ok' : s.ok === false ? 'fail' : 'skip';
      list.append(h('li', { class: `report-step ${state}`, dataset: { step: String(s.id || '') } },
        h('span', { class: 'report-mark', 'aria-label': state === 'ok' ? 'passed' : state === 'fail' ? 'failed' : 'skipped' }, state === 'ok' ? '✓' : state === 'fail' ? '✗' : '–'),
        h('span', { class: 'report-text' }, h('strong', null, String(s.label || s.id || '')), s.detail ? h('span', null, ` ${s.detail}`) : null,
          s.hint ? h('span', { class: 'report-hint' }, String(s.hint)) : null)));
    }
    el.append(list);
  }

  async _save() {
    const needPassword = !this.status?.hasPassword;
    const c = this._collect({ needPassword });
    if (!c) return;
    this.saveBtn.disabled = true;
    const wasConfigured = !!this.status?.configured;
    try {
      const patch = { tapo: { enabled: true, name: c.name, host: c.host, username: c.username, onvifPort: c.onvifPort, rtspPort: c.rtspPort, stream: c.stream } };
      const saved = await this.o.saveSettings(patch);
      const kept = saved?.tapo;
      if (kept && kept.host !== c.host) {
        this._error('host', 'This address was not accepted: it must be on your home network.');
        return;
      }
      if (c.password) {
        await this.bridge.tapo.setCredentials({ username: c.username, password: c.password });
        this.inputs.password.value = '';
        this.inputs.password.type = 'password';
      }
      this.o.toast(wasConfigured ? 'Saved.' : 'Saved. Connecting to the camera…', 'success');
      if (!wasConfigured) this.o.onClose();
    } catch (err) {
      this.o.toast(`Could not save: ${/** @type {any} */ (err)?.message || err}`, 'error');
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  async _discover() {
    this.findBtn.disabled = true;
    const label = this.findBtn.lastChild;
    if (label) label.textContent = 'Searching…';
    clear(this.found);
    try {
      const list = await this.bridge.tapo.discover();
      this.found.hidden = false;
      if (!Array.isArray(list) || !list.length) {
        this.found.append(h('p', { class: 'form-hint' }, 'No camera answered. Make sure it is on the same network, or type its address (the Tapo app shows it under Device Info). Windows may ask once whether Lawnmower Man may use the network.'));
      } else {
        this.found.append(h('p', { class: 'form-hint' }, list.length === 1 ? 'Found one camera:' : `Found ${list.length} cameras:`));
        for (const c of list.slice(0, 8)) {
          this.found.append(h('button', { type: 'button', class: 'found-cam', onclick: () => {
            this.inputs.host.value = c.host;
            this._clearError('host');
            this.found.hidden = true;
            this.inputs.username.focus();
          } }, tapoIcon('camera', 'icon tiny'), h('strong', null, c.name || c.model || 'Camera'), h('span', null, c.host)));
        }
      }
    } catch (err) {
      this.found.hidden = false;
      this.found.append(h('p', { class: 'form-error' }, `Searching failed: ${/** @type {any} */ (err)?.message || err}. Type the address instead.`));
    } finally {
      this.findBtn.disabled = false;
      if (label) label.textContent = 'Find cameras';
    }
  }

  async _forget() {
    try {
      await this.bridge.tapo.clearCredentials();
      this.o.toast('The saved password was removed.', 'info');
    } catch (err) {
      this.o.toast(`Could not remove it: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
  }

  // ---- immediately saved fields --------------------------------------------------------------

  /** @param {string} path @param {any} value */
  async _commit(path, value) {
    try {
      const saved = await this.o.saveSettings(patchFor(path, value));
      const got = saved ? getPath(saved, path) : undefined;
      if (saved && typeof value !== 'number' && JSON.stringify(got) !== JSON.stringify(value)) this.o.toast('That value was not accepted.', 'warn');
    } catch (err) {
      this.o.toast(`Could not save the setting: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
  }

  /** @param {string} path @param {string} label @param {string} [hint] @param {{ consent?: boolean }} [o] */
  _toggle(path, label, hint = '', o = {}) {
    const id = field(path.replace('.', '-'));
    const sw = /** @type {HTMLButtonElement} */ (h('button', { id, type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false' }, h('span', { class: 'switch-knob' })));
    sw.addEventListener('click', async () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      if (on && o.consent && !hasDescribeConsent()) {
        const ok = await askDescribeConsent();
        if (!ok) return;
      }
      sw.setAttribute('aria-checked', String(on));
      this._commit(path, on);
    });
    this.live.set(path, (s) => sw.setAttribute('aria-checked', String(!!getPath(s, path))));
    return h('div', { class: 'field field-toggle', dataset: { path } }, h('div', { class: 'field-text' }, h('label', { class: 'field-label', for: id }, label), hint ? h('div', { class: 'field-hint' }, hint) : null), sw);
  }

  /** @param {string} path @param {string} label @param {Array<[string, string]>} options @param {string} [hint] */
  _select(path, label, options, hint = '') {
    const id = field(path.replace('.', '-'));
    const sel = /** @type {HTMLSelectElement} */ (h('select', { id }, options.map(([v, l]) => h('option', { value: v }, l))));
    sel.addEventListener('change', () => this._commit(path, sel.value));
    this.live.set(path, (s) => {
      if (document.activeElement !== sel) sel.value = String(getPath(s, path));
    });
    return h('div', { class: 'field field-select', dataset: { path } }, h('div', { class: 'field-text' }, h('label', { class: 'field-label', for: id }, label), hint ? h('div', { class: 'field-hint' }, hint) : null), sel);
  }

  /** @param {string} path @param {string} label @param {Array<[string, string]>} options */
  _segmented(path, label, options) {
    const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
    const buttons = options.map(([v, l]) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value: v } }, l);
      b.addEventListener('click', () => {
        for (const x of buttons) x.setAttribute('aria-checked', String(x === b));
        this._commit(path, v);
      });
      el.append(b);
      return b;
    });
    this.live.set(path, (s) => {
      const v = String(getPath(s, path));
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === v));
    });
    return h('div', { class: 'field field-segmented', dataset: { path } }, h('span', { class: 'field-label' }, label), el);
  }

  /** @param {string} path @param {string} label @param {number} min @param {number} max @param {number} step @param {(v: number) => string} fmt */
  _range(path, label, min, max, step, fmt) {
    const id = field(path.replace('.', '-'));
    const out = h('output', { for: id, class: 'range-value' });
    const input = /** @type {HTMLInputElement} */ (h('input', { id, type: 'range', min, max, step }));
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
    });
    input.addEventListener('change', () => this._commit(path, Number(input.value)));
    this.live.set(path, (s) => {
      const v = Number(getPath(s, path));
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = fmt(v);
    });
    return h('div', { class: 'field field-range', dataset: { path } }, h('label', { class: 'field-label', for: id }, label), h('div', { class: 'range-wrap wide' }, input, out));
  }

  /**
   * @param {string} path @param {string} label @param {string} placeholder @param {string} hint
   * @param {(v: string) => { ok: boolean, value?: any, error?: string }} [check]
   */
  _text(path, label, placeholder, hint, check) {
    const id = field(path.replace('.', '-'));
    const input = /** @type {HTMLInputElement} */ (h('input', { id, type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder }));
    const err = h('div', { class: 'form-error', hidden: true });
    input.addEventListener('change', () => {
      const r = check ? check(input.value) : { ok: true, value: input.value.trim() };
      err.hidden = r.ok;
      err.textContent = r.ok ? '' : String(r.error || '');
      if (r.ok) this._commit(path, r.value);
    });
    this.live.set(path, (s) => {
      if (document.activeElement !== input) input.value = String(getPath(s, path) ?? '');
    });
    return h('div', { class: 'field field-text-input', dataset: { path } }, h('div', { class: 'field-text' }, h('label', { class: 'field-label', for: id }, label), h('div', { class: 'field-hint' }, hint)), h('div', { class: 'text-wrap' }, input, err));
  }
}

/** The consent card for "Claude describes alerts". Resolves true when accepted. */
export function askDescribeConsent() {
  return new Promise((resolve) => {
    let yes = false;
    const accept = h('button', { type: 'button', class: 'btn amber' }, DESCRIBE_CONSENT.accept);
    const decline = h('button', { type: 'button', class: 'btn ghost' }, DESCRIBE_CONSENT.decline);
    const dlg = openDialog({
      id: 'describe-consent',
      title: DESCRIBE_CONSENT.title,
      icon: 'shield',
      className: 'dlg-small dlg-consent',
      body: h('ul', { class: 'consent-points' }, DESCRIBE_CONSENT.points.map((p) => h('li', null, p))),
      actions: [decline, accept],
      onClose: () => resolve(yes),
    });
    accept.addEventListener('click', () => {
      yes = true;
      rememberDescribeConsent();
      dlg.close();
    });
    decline.addEventListener('click', () => dlg.close());
    decline.focus();
  });
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
