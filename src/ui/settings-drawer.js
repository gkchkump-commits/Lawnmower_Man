// Settings drawer: every user-facing setting (contract §4) as a compact control.
//
// Controls write through `onChange(patch)` immediately (sliders are throttled); the drawer is
// refreshed from the authoritative settings with update() whenever main reports a change, so
// a value the main process rejected snaps back. Focused text fields are not overwritten while
// the user is typing.
/* global Node */

import { patchFor, getPath } from '../app/settings-defaults.js';
import { MAX_AVATAR_WIDTH, MIN_AVATAR_WIDTH, PRESET_WIDTHS } from '../app/window-drag.js';
import { acceleratorFromEvent, formatAccelerator } from './accelerator.js';
import { clear, h, icon } from './dom.js';

/**
 * @typedef {object} Field
 * @property {'select'|'segmented'|'toggle'|'range'|'text'|'hotkey'|'button'|'info'} type
 * @property {string} [path]
 * @property {string} [label]
 * @property {string} [hint]
 * @property {Array<[any, string]>} [options]
 * @property {number} [min] @property {number} [max] @property {number} [step]
 * @property {(v: number) => string} [format]
 * @property {string[]} [suggestions]
 * @property {string} [placeholder]
 * @property {string} [emptyValue]  text fields: value saved when the field is cleared
 * @property {string} [action]
 * @property {string} [id]
 * @property {string} [variant]
 * @property {(settings: any) => any} [value]  what the control shows, when not simply the value at `path`
 */

/** How the lip-sync offset reads: "0 ms", "+40 ms (mouth later)", "-40 ms (mouth earlier)". @param {number} v */
export function lipSyncLabel(v) {
  const ms = Math.round(Number(v) || 0);
  return ms === 0 ? '0 ms' : ms > 0 ? `+${ms} ms (mouth later)` : `\u2212${-ms} ms (mouth earlier)`;
}
const LIPSYNC_HINT = 'Mouth before the voice (e.g. Bluetooth headphones)? Move it right. Test lip-sync says a line with many m, b and p.';

/** The voice character's hint: what it applies to, with the voice that is speaking now. */
export const VOICE_FX_HINT = Object.freeze({
  server: 'Applies to the local voice',
  system: 'Applies to the local voice, not the system voice speaking now',
});

/** @type {Array<{ id: string, title: string, fields: Field[] }>} */
export const SECTIONS = [
  {
    id: 'claude',
    title: 'Claude',
    fields: [
      { type: 'select', path: 'claude.mode', label: 'Mode', options: [['chat', 'Chat — conversation only'], ['assistant', 'Assistant — read files & web'], ['agent', 'Agent — full Claude Code (asks first)']] },
      { type: 'text', path: 'claude.model', label: 'Model', placeholder: 'CLI default', suggestions: ['sonnet', 'opus', 'haiku'] },
      { type: 'select', path: 'claude.effort', label: 'Effort', options: [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']] },
      { type: 'text', path: 'claude.workdir', label: 'Work folder', placeholder: 'Default: ~/LawnmowerMan' },
      { type: 'text', path: 'claude.cliPath', label: 'CLI path', placeholder: 'Auto-detect' },
      { type: 'button', label: 'New conversation', action: 'newConversation' },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    fields: [
      { type: 'info', id: 'voiceInfo' },
      { type: 'toggle', path: 'voice.enabled', label: 'Local voice (GPU)', hint: 'Speech recognition and natural speech on your GPU' },
      { type: 'toggle', path: 'voice.speakReplies', label: 'Speak replies' },
      { type: 'toggle', path: 'voice.handsFree', label: 'Hands-free', hint: 'Listen whenever idle; pauses while speaking' },
      { type: 'select', path: 'voice.ttsVoice', label: 'Voice', options: [] },
      // shown instead of the Kokoro list while the local voice is not running (Web Speech voices)
      { type: 'select', path: 'voice.systemVoice', label: 'Voice', options: [['', 'Automatic (most natural voice)']] },
      { type: 'range', path: 'voice.ttsSpeed', label: 'Speed', min: 0.5, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
      // the local voice's character (src/audio/voicefx.js); the system voice cannot be processed
      { type: 'select', path: 'voice.character', label: 'Character', hint: VOICE_FX_HINT.server, options: [['synth', 'Synth — hologram AI'], ['vocoder', 'Vocoder — fully synthetic'], ['robot', 'Robot — monotone, metallic'], ['natural', 'Natural — unprocessed']] },
      { type: 'range', path: 'voice.fxAmount', label: 'Intensity', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      // the mouth's timing against the voice (src/audio/lipsync.js setOffset), both voices
      { type: 'range', path: 'voice.lipSyncOffsetMs', label: 'Lip-sync timing', min: -200, max: 200, step: 5, format: lipSyncLabel, hint: LIPSYNC_HINT },
      { type: 'button', label: 'Test lip-sync', action: 'testLipSync', variant: 'ghost' },
      { type: 'select', path: 'voice.device', label: 'Device', options: [['auto', 'Auto'], ['cuda', 'GPU (CUDA)'], ['cpu', 'CPU']] },
      { type: 'text', path: 'voice.sttModel', label: 'Speech model', suggestions: ['large-v3-turbo', 'distil-large-v3', 'medium.en', 'small.en', 'base.en'] },
      { type: 'button', label: 'Restart voice server', action: 'restartVoice', variant: 'ghost' },
      { type: 'button', label: 'Set up local voice…', action: 'setupVoice', variant: 'subtle' },
    ],
  },
  {
    id: 'avatar',
    title: 'Avatar',
    fields: [
      { type: 'segmented', path: 'avatar.renderer', label: 'Renderer', options: [['relief', 'Relief'], ['procedural', 'Procedural']] },
      { type: 'text', path: 'avatar.pack', label: 'Pack', placeholder: 'reference', emptyValue: 'reference' },
      { type: 'segmented', path: 'avatar.quality', label: 'Quality', options: [['low', 'Low'], ['medium', 'Med'], ['high', 'High']] },
      { type: 'range', path: 'avatar.particles', label: 'Particles', min: 0, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { type: 'range', path: 'avatar.bloom', label: 'Glow', min: 0, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { type: 'toggle', path: 'avatar.followCursor', label: 'Eyes follow the cursor' },
      // how much the voice moves the head, brows and face (nods, glances, brows on questions)
      { type: 'range', path: 'avatar.expressiveness', label: 'Expressiveness', min: 0, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      // how much it moves on its own: looks around, shifts its posture, small gestures (src/avatar/behavior.js)
      { type: 'range', path: 'avatar.liveliness', label: 'Liveliness', hint: 'How much it moves on its own: looks around, shifts, small gestures', min: 0, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { type: 'toggle', path: 'avatar.projector', label: 'Projector light', hint: 'A cone of light under the bust, as if projected' },
    ],
  },
  {
    // the avatar can see you (docs/CAMERA.md); everything but a snapshot for Claude stays on this PC
    id: 'camera',
    title: 'Camera',
    fields: [
      { type: 'info', id: 'cameraInfo' },
      { type: 'toggle', path: 'camera.enabled', label: 'Camera', hint: 'Face tracking runs on this PC only' },
      { type: 'select', path: 'camera.deviceId', label: 'Device', options: [['', 'Default camera']] },
      { type: 'toggle', path: 'camera.followFace', label: 'Eye contact', hint: 'Looks at you; a moving cursor still wins' },
      { type: 'toggle', path: 'camera.presence', label: 'Notice when I leave', hint: 'Dozes off when you are away, wakes up when you are back' },
      { type: 'toggle', path: 'camera.mirrorExpressions', label: 'Smile back' },
      { type: 'toggle', path: 'camera.shareWithClaude', label: 'Let Claude see me', hint: 'A snapshot goes with every message you send' },
      { type: 'segmented', path: 'camera.greeting', label: 'Greet me', options: [['off', 'Off'], ['hello', 'Hello'], ['claude', 'Claude']], hint: 'When it first sees you and when you are back. Claude = a personal hello from Claude (a short reply)' },
      { type: 'toggle', path: 'camera.lookToTalk', label: 'Listen only when I look', hint: 'Hands-free mode listens only while you look at the screen' },
    ],
  },
  // ---- Home camera (a Tapo pan/tilt camera as home security; src/tapo/, docs/TAPO.md) --------
  {
    id: 'tapo',
    title: 'Home camera',
    fields: [
      { type: 'info', id: 'tapoInfo' },
      { type: 'toggle', path: 'tapo.enabled', label: 'Home camera', hint: 'A Tapo pan/tilt camera on your network' },
      // armed goes through bridge.tapo.arm (src/main.js), so the exit delay applies
      { type: 'segmented', path: 'security.armed', label: 'Security', options: [[false, 'Disarmed'], [true, 'Armed']] },
      { type: 'toggle', path: 'security.announce', label: 'Say when someone is there', hint: '“Someone is at the camera.”' },
      { type: 'toggle', path: 'security.describe', label: 'Claude describes alerts', hint: 'Sends the alert picture to Claude for one sentence about it (asks first)' },
      { type: 'button', label: 'Open camera window…', action: 'openTapo' },
      { type: 'button', label: 'Open clips folder', action: 'openTapoClips', variant: 'ghost' },
    ],
  },
  // ---- end Home camera -----------------------------------------------------------------------
  {
    id: 'window',
    title: 'Window',
    fields: [
      // a free size (from a corner grip, Ctrl + wheel or the slider) selects no preset
      { type: 'segmented', path: 'window.sizePreset', label: 'Size', options: [['small', 'S'], ['medium', 'M'], ['large', 'L']], value: (s) => (s.window.avatarWidth == null ? s.window.sizePreset : '') },
      { type: 'range', path: 'window.avatarWidth', label: 'Width', min: MIN_AVATAR_WIDTH, max: MAX_AVATAR_WIDTH, step: 10, format: (v) => `${Math.round(v)} px`,
        value: (s) => s.window.avatarWidth ?? PRESET_WIDTHS[/** @type {'small'|'medium'|'large'} */ (s.window.sizePreset)] ?? PRESET_WIDTHS.medium,
        hint: 'Or drag a corner of the window, or Ctrl + mouse wheel over the head' },
      { type: 'toggle', path: 'window.showChat', label: 'Chat panel', hint: 'Off = the panel drops down below the face only when needed' },
      { type: 'toggle', path: 'window.alwaysOnTop', label: 'Always on top' },
      { type: 'toggle', path: 'window.clickThrough', label: 'Click-through', hint: 'Clicks on empty space reach the desktop' },
      { type: 'toggle', path: 'window.lockPosition', label: 'Lock position', hint: 'Off = drag the head to move the avatar, a corner to resize it' },
      { type: 'toggle', path: 'window.snapToEdges', label: 'Snap to screen edges', hint: 'Locks flush against edges and corners while you drag' },
      { type: 'button', label: 'Reset position', action: 'resetPosition', variant: 'ghost' },
    ],
  },
  {
    id: 'hotkeys',
    title: 'Shortcuts',
    fields: [
      { type: 'hotkey', path: 'hotkeys.toggleListen', label: 'Talk / interrupt' },
      { type: 'hotkey', path: 'hotkeys.stopSpeaking', label: 'Stop speaking' },
      { type: 'hotkey', path: 'hotkeys.toggleChat', label: 'Show / hide chat' },
      { type: 'info', id: 'hotkeyInfo' },
    ],
  },
  {
    id: 'about',
    title: 'About',
    fields: [{ type: 'info', id: 'about' }],
  },
];

export class SettingsDrawer {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {(patch: object, path: string, value: any) => void} o.onChange
   * @param {(action: string) => void} o.onAction
   * @param {(open: boolean) => void} [o.onToggle]
   * @param {string} [o.platform]
   */
  constructor(root, o) {
    this.root = root;
    this.onChange = o.onChange;
    this.onAction = o.onAction;
    this.onToggle = o.onToggle || (() => {});
    this.platform = o.platform || 'win32';
    /** @type {Map<string, { set: (v: any) => void, el: HTMLElement, row: HTMLElement, value?: (settings: any) => any }>} */
    this.controls = new Map();
    /** @type {Map<string, HTMLElement>} */
    this.infos = new Map();
    /** @type {Map<string, HTMLButtonElement>} action buttons */
    this.actions = new Map();
    this.settings = null;
    this._recording = null;
    this._build();
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    if (this.isOpen) return;
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('open'));
    this.onToggle(true);
    /** @type {HTMLElement|null} */ (this.root.querySelector('.drawer-close'))?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this._stopRecording();
    this.root.classList.remove('open');
    this.root.hidden = true;
    this.onToggle(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** @param {any} settings */
  update(settings) {
    this.settings = settings;
    for (const [path, c] of this.controls) {
      const v = c.value ? c.value(settings) : getPath(settings, path);
      if (v !== undefined) c.set(v);
    }
    // the intensity of 'natural' means nothing
    const amount = this.controls.get('voice.fxAmount');
    if (amount) {
      const off = getPath(settings, 'voice.character') === 'natural';
      amount.row.classList.toggle('disabled', off);
      /** @type {HTMLInputElement} */ (amount.el).disabled = off;
      amount.row.title = off ? 'Natural plays the voice unprocessed' : '';
    }
  }

  /** Replace the content of an info block. @param {string} id @param {...any} nodes */
  setInfo(id, ...nodes) {
    const el = this.infos.get(id);
    if (!el) return;
    clear(el);
    for (const n of nodes.flat()) if (n !== null && n !== undefined && n !== false) el.append(n instanceof Node ? n : document.createTextNode(String(n)));
    el.hidden = !el.childNodes.length;
  }

  /** Server voices for the TTS voice picker. @param {Array<{ id: string, name?: string, lang?: string, gender?: string }>} voices */
  setVoiceOptions(voices) {
    const sel = /** @type {HTMLSelectElement|undefined} */ (this.controls.get('voice.ttsVoice')?.el);
    if (!sel) return;
    const current = this.settings ? getPath(this.settings, 'voice.ttsVoice') : sel.value;
    clear(sel);
    const list = Array.isArray(voices) && voices.length ? voices : [];
    for (const v of list) {
      const label = `${v.name || v.id}${v.lang ? ` · ${v.lang}` : ''}${v.gender ? ` · ${v.gender === 'f' ? '♀' : v.gender === 'm' ? '♂' : v.gender}` : ''}`;
      sel.append(h('option', { value: v.id }, label));
    }
    if (current && !list.some((v) => v.id === current)) sel.append(h('option', { value: current }, list.length ? `${current} (not installed)` : current));
    sel.value = current || '';
    sel.disabled = !list.length;
    sel.title = list.length ? '' : 'Voices are listed when the local voice server is running';
  }

  /**
   * System (Web Speech) voices for the picker used while the local voice is not running.
   * '' = automatic; a saved voice that is not installed any more stays listed as such.
   * @param {Array<{ id: string, name: string, lang?: string }>} voices
   */
  setSystemVoiceOptions(voices) {
    const sel = /** @type {HTMLSelectElement|undefined} */ (this.controls.get('voice.systemVoice')?.el);
    if (!sel) return;
    const current = this.settings ? String(getPath(this.settings, 'voice.systemVoice') ?? '') : sel.value;
    const list = Array.isArray(voices) ? voices : [];
    clear(sel);
    sel.append(h('option', { value: '' }, 'Automatic (most natural voice)'));
    for (const v of list) {
      const lang = v.lang && !String(v.name).includes(v.lang) ? ` · ${v.lang}` : '';
      sel.append(h('option', { value: v.id }, `${v.name}${lang}`));
    }
    if (current && !list.some((v) => v.id === current)) sel.append(h('option', { value: current }, `${current} (not installed)`));
    sel.value = current;
    sel.title = list.length ? 'System voice, used while the local voice is not running' : 'No system voices were found on this computer';
  }

  /**
   * Cameras for the camera picker ('' = the system default). A saved camera that is not in the
   * list stays listed: "(not connected)" when the list can be trusted, plain "Saved camera"
   * while the camera is off (the page sees no device ids then).
   * @param {Array<{ id: string, label: string }>} cams @param {{ known?: boolean }} [o]
   */
  setCameraOptions(cams, o = {}) {
    const sel = /** @type {HTMLSelectElement|undefined} */ (this.controls.get('camera.deviceId')?.el);
    if (!sel) return;
    const current = this.settings ? String(getPath(this.settings, 'camera.deviceId') ?? '') : sel.value;
    const list = Array.isArray(cams) ? cams : [];
    clear(sel);
    sel.append(h('option', { value: '' }, 'Default camera'));
    for (const c of list) sel.append(h('option', { value: c.id }, c.label));
    if (current && !list.some((c) => c.id === current)) sel.append(h('option', { value: current }, o.known === false ? 'Saved camera' : 'Saved camera (not connected)'));
    sel.value = current;
    sel.title = list.length ? '' : 'Cameras are listed once the camera has been turned on';
  }

  /**
   * Which voice list applies right now: the local voice server's (Kokoro) or the system's.
   * @param {'server'|'system'} source
   */
  setVoiceSource(source) {
    const server = this.controls.get('voice.ttsVoice');
    const system = this.controls.get('voice.systemVoice');
    if (server) server.row.hidden = source !== 'server';
    if (system) system.row.hidden = source === 'server';
    const hint = this.controls.get('voice.character')?.row.querySelector('.field-hint');
    if (hint) hint.textContent = source === 'server' ? VOICE_FX_HINT.server : VOICE_FX_HINT.system;
  }

  /** Relabel / hide / disable an action button. @param {string} action @param {{ label?: string, hidden?: boolean, disabled?: boolean, title?: string }} o */
  setAction(action, o) {
    const b = this.actions.get(action);
    if (!b) return;
    if (o.label !== undefined) b.textContent = o.label;
    if (o.hidden !== undefined) /** @type {HTMLElement} */ (b.parentElement).hidden = o.hidden;
    if (o.disabled !== undefined) b.disabled = o.disabled;
    if (o.title !== undefined) b.title = o.title;
  }

  /** Disable a control with an explanation (e.g. click-through on Linux). @param {string} path @param {string} reason */
  disable(path, reason) {
    const c = this.controls.get(path);
    if (!c) return;
    c.row.classList.add('disabled');
    /** @type {any} */ (c.el).disabled = true;
    c.row.title = reason;
    const hint = c.row.querySelector('.field-hint');
    if (hint) hint.textContent = reason;
  }

  // ------------------------------------------------------------------------------------------

  _build() {
    clear(this.root);
    const body = h('div', { class: 'drawer-body' });
    this.root.append(
      h('header', { class: 'drawer-head' },
        h('h2', null, icon('gear', 'icon'), 'Settings'),
        h('button', { type: 'button', class: 'icon-btn drawer-close', 'aria-label': 'Close settings', onclick: () => this.close() }, icon('close'))),
      body,
    );
    for (const sec of SECTIONS) {
      const s = h('section', { class: 'drawer-section', dataset: { section: sec.id } }, h('h3', null, sec.title));
      for (const f of sec.fields) s.append(this._field(f));
      body.append(s);
    }
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this._recording) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  /** @param {Field} f */
  _field(f) {
    if (f.type === 'info') {
      const el = h('div', { class: 'field-info', hidden: true, dataset: { info: f.id } });
      this.infos.set(/** @type {string} */ (f.id), el);
      return el;
    }
    if (f.type === 'button') {
      const b = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: `btn ${f.variant || 'subtle'}`, dataset: { action: f.action }, onclick: () => this.onAction(/** @type {string} */ (f.action)) }, f.label));
      this.actions.set(/** @type {string} */ (f.action), b);
      return h('div', { class: 'field field-button' }, b);
    }
    const path = /** @type {string} */ (f.path);
    const id = `set-${path.replace(/\./g, '-')}`;
    const label = h('label', { class: 'field-label', for: id }, f.label);
    // a select or slider with a hint stacks the hint under its label (like a toggle)
    const labelled = () => (f.hint ? h('div', { class: 'field-text' }, label, h('div', { class: 'field-hint' }, f.hint)) : label);
    const row = h('div', { class: `field field-${f.type}`, dataset: { path } });
    const commit = (v) => this.onChange(patchFor(path, v), path, v);
    let el;
    /** @type {(v: any) => void} */
    let set;
    switch (f.type) {
      case 'select': {
        el = h('select', { id, onchange: () => commit(/** @type {HTMLSelectElement} */ (el).value) });
        for (const [v, l] of f.options || []) el.append(h('option', { value: v }, l));
        set = (v) => {
          const sel = /** @type {HTMLSelectElement} */ (el);
          if ([...sel.options].every((o) => o.value !== String(v))) sel.append(h('option', { value: v }, String(v)));
          sel.value = String(v);
        };
        row.append(labelled(), el);
        break;
      }
      case 'segmented': {
        el = h('div', { id, class: 'segmented', role: 'radiogroup', 'aria-label': f.label });
        const buttons = (f.options || []).map(([v, l]) => {
          const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value: v }, onclick: () => {
            set(v);
            commit(v);
          } }, l);
          el.append(b);
          return b;
        });
        set = (v) => {
          for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(v)));
        };
        row.append(h('span', { class: 'field-label' }, f.label), el);
        break;
      }
      case 'toggle': {
        el = h('button', { id, type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', onclick: () => {
          const on = el.getAttribute('aria-checked') !== 'true';
          set(on);
          commit(on);
        } }, h('span', { class: 'switch-knob' }));
        set = (v) => el.setAttribute('aria-checked', String(!!v));
        const text = h('div', { class: 'field-text' }, label, f.hint ? h('div', { class: 'field-hint' }, f.hint) : null);
        row.append(text, el);
        break;
      }
      case 'range': {
        const out = h('output', { for: id, class: 'range-value' });
        const fmt = f.format || ((v) => String(v));
        let timer = 0;
        let last = 0;
        el = h('input', { id, type: 'range', min: f.min, max: f.max, step: f.step, oninput: () => {
          const v = Number(/** @type {HTMLInputElement} */ (el).value);
          out.textContent = fmt(v);
          // throttle while dragging; the final value is committed on change
          clearTimeout(timer);
          const now = performance.now();
          if (now - last > 150) {
            last = now;
            commit(v);
          } else {
            timer = /** @type {any} */ (setTimeout(() => commit(v), 150));
          }
        }, onchange: () => {
          clearTimeout(timer);
          commit(Number(/** @type {HTMLInputElement} */ (el).value));
        } });
        set = (v) => {
          if (document.activeElement !== el) /** @type {HTMLInputElement} */ (el).value = String(v);
          out.textContent = fmt(Number(v));
        };
        row.append(labelled(), h('div', { class: 'range-wrap' }, el, out));
        break;
      }
      case 'text': {
        const listId = f.suggestions ? `${id}-list` : undefined;
        el = h('input', { id, type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: f.placeholder || '', list: listId,
          onchange: () => commit(/** @type {HTMLInputElement} */ (el).value.trim() || (f.emptyValue ?? '')),
          onkeydown: (e) => { if (e.key === 'Enter') /** @type {HTMLInputElement} */ (el).blur(); } });
        set = (v) => {
          if (document.activeElement !== el) /** @type {HTMLInputElement} */ (el).value = String(v ?? '');
        };
        row.append(label, el);
        if (listId) row.append(h('datalist', { id: listId }, (f.suggestions || []).map((s) => h('option', { value: s }))));
        break;
      }
      case 'hotkey': {
        el = h('button', { id, type: 'button', class: 'hotkey', onclick: () => this._record(path, el, set) });
        const clearBtn = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': `Disable ${f.label}`, title: 'Disable', onclick: () => {
          this._stopRecording();
          set('');
          commit('');
        } }, icon('close', 'icon tiny'));
        set = (v) => {
          el.dataset.value = String(v ?? '');
          if (this._recording?.el !== el) el.textContent = formatAccelerator(String(v ?? ''), this.platform);
        };
        row.append(label, h('div', { class: 'hotkey-wrap' }, el, clearBtn));
        break;
      }
      default:
        el = h('span');
        set = () => {};
    }
    this.controls.set(path, { set, el, row, value: f.value });
    return row;
  }

  /** @param {string} path @param {HTMLElement} el @param {(v: any) => void} set */
  _record(path, el, set) {
    if (this._recording) {
      const same = this._recording.el === el;
      this._stopRecording();
      if (same) return;
    }
    el.classList.add('recording');
    el.textContent = 'Press keys…';
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        this._stopRecording();
        return;
      }
      const r = acceleratorFromEvent(e, this.platform);
      if (!r) return; // modifier only: keep listening
      if ('error' in r) {
        el.textContent = r.error.length > 38 ? 'Add Ctrl/Alt…' : r.error;
        el.title = r.error;
        return;
      }
      this._stopRecording();
      set(r.accelerator);
      this.onChange(patchFor(path, r.accelerator), path, r.accelerator);
    };
    window.addEventListener('keydown', onKey, true);
    this._recording = { el, path, onKey, set };
  }

  _stopRecording() {
    const r = this._recording;
    if (!r) return;
    window.removeEventListener('keydown', r.onKey, true);
    r.el.classList.remove('recording');
    r.el.title = '';
    this._recording = null;
    r.el.textContent = formatAccelerator(r.el.dataset.value || '', this.platform);
  }
}
