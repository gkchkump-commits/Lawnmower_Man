// The avatar and the Home camera (contract §9.5, §9.7): what the hologram does when the camera
// sees something, and the simple camera commands it runs itself.
//
//   lm:tapo:alert → wake up, say the line ("Someone is at the front door camera."); busy (a reply,
//                   the user talking) → a toast now and the line once the avatar is free (≤ 60 s);
//                   with security.describe: after the line, a hidden turn asks Claude for one
//                   sentence about the attached snapshot — only when nothing else was going on
//   lm:tapo:look  → the eyes and head turn toward the camera window (like the cursor does)
//   lm:tapo:status → the ARMED pill, the drawer's status line, the presets for "look at the door"
//   intercept()   → "camera left", "look at the door", "arm the camera", "show me the camera":
//                   run here, confirmed with a short spoken line; no Claude turn
//
// Everything is injected, so it is unit-tested with fakes.

import { gazeFromPoint } from '../app/gaze.js';
import { Emitter } from '../app/emitter.js';
import { armedLine, parseCameraIntent } from './intents.js';
import { formatClock, ptzMessage } from './status.js';

/** A line that could not be said is said later, if the avatar is free within this long. */
export const RETRY_SAY_MS = 60_000;
/** How long the describe request waits for the avatar to finish the alert line. */
export const DESCRIBE_WAIT_MS = 30_000;
/** How often the presets (for "look at the door") are read again while online. */
export const PRESETS_REFRESH_MS = 5 * 60_000;

/**
 * The hidden prompt that asks Claude to describe an alert snapshot (§9.5).
 * @param {string} name the camera's name @param {number} atMs when the person was detected
 */
export function describePrompt(name, atMs) {
  return `(Automatic note from the Lawnmower Man app, not typed by the user: the home security camera "${name}" detected a person at ${formatClock(atMs)}. The picture is attached. In one short spoken sentence, tell the user what you see. Do not guess who it is.)`;
}

export const DESCRIBE_NOTE = 'Home camera: asked Claude what it sees';

/**
 * @typedef {object} AvatarLinkView
 * @property {(message: string, level?: 'info'|'warn'|'error'|'success') => void} [toast]
 * @property {(status: any) => void} [setStatus]  the ARMED pill and the drawer line
 */

export class TapoAvatarLink extends Emitter {
  /**
   * @param {object} d
   * @param {any} d.bridge            window.lawnmower (with .tapo)
   * @param {any} d.controller        src/app/controller.js
   * @param {{ cursor: (g: [number, number], holdMs?: number) => void }} [d.gaze]  GazeArbiter
   * @param {() => any} [d.getAvatar]
   * @param {AvatarLinkView} [d.view]
   * @param {() => any} d.getSettings
   * @param {() => { left: number, top: number, width: number, height: number }|null} [d.getStage]  the avatar stage's rect
   * @param {() => number} [d.now]  wall clock (ms)
   * @param {(fn: () => void, ms: number) => any} [d.setTimeout]
   * @param {(id: any) => void} [d.clearTimeout]
   * @param {(fn: () => void, ms: number) => any} [d.setInterval]
   * @param {(id: any) => void} [d.clearInterval]
   */
  constructor(d) {
    super();
    this.d = d;
    this.bridge = d.bridge;
    this.controller = d.controller;
    this.view = d.view || {};
    this._now = d.now || (() => Date.now());
    this._st = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._ct = d.clearTimeout || ((id) => clearTimeout(id));
    this._si = d.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._ci = d.clearInterval || ((id) => clearInterval(id));
    /** @type {any} TapoStatus */
    this.status = null;
    /** @type {Array<{ token: string, name: string }>} */
    this.presets = [];
    this._presetsAt = -Infinity;
    /** @type {Array<() => void>} */
    this._offs = [];
    /** @type {Set<() => void>} pending waits for the avatar to be free */
    this._waits = new Set();
    this.started = false;
  }

  get available() {
    return !!this.bridge?.tapo;
  }

  start() {
    if (this.started || !this.available) return;
    this.started = true;
    const t = this.bridge.tapo;
    if (typeof t.onAlert === 'function') this._offs.push(t.onAlert((/** @type {any} */ a) => this.onAlert(a)));
    if (typeof t.onLook === 'function') this._offs.push(t.onLook((/** @type {any} */ p) => this.onLook(p)));
    if (typeof t.onStatus === 'function') this._offs.push(t.onStatus((/** @type {any} */ s) => this.onStatus(s)));
    // status events sent before this window loaded are not replayed: ask once
    Promise.resolve().then(() => t.status()).then((s) => {
      if (s && !this.status) this.onStatus(s);
    }, (err) => console.warn('[tapo] status() failed', err));
  }

  dispose() {
    for (const off of this._offs) {
      try { off?.(); } catch { /* ignore */ }
    }
    this._offs = [];
    for (const cancel of [...this._waits]) cancel();
    this.started = false;
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------
  // main → avatar

  /** @param {any} st TapoStatus */
  onStatus(st) {
    if (!st || typeof st !== 'object') return;
    const was = this.status?.connection;
    this.status = st;
    this.view.setStatus?.(st);
    this.emit('status', st);
    if (st.connection === 'online' && (was !== 'online' || this._now() - this._presetsAt > PRESETS_REFRESH_MS)) this.refreshPresets();
  }

  async refreshPresets() {
    this._presetsAt = this._now();
    try {
      const list = await this.bridge.tapo.presets();
      this.presets = Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string') : [];
    } catch (err) {
      console.warn('[tapo] presets() failed', err);
    }
  }

  /** main's lm:tapo:alert (AvatarAlert, contract §8.11). @param {any} a */
  onAlert(a) {
    if (!a || typeof a !== 'object' || typeof a.line !== 'string' || !a.line.trim()) return;
    const c = this.controller;
    const at = this._now();
    // decided before the line is said: describe only if nothing else was going on
    const describe = !!(a.describe && a.snapshot && typeof a.snapshot.data === 'string' && c.isIdle());
    c.wake();
    this.emit('alert', a);
    if (!a.quiet) {
      if (!c.say(a.line)) {
        this.view.toast?.(a.line, 'warn');
        this._whenFree(() => c.say(a.line), RETRY_SAY_MS);
      }
    }
    if (describe) {
      const activityBefore = c.lastActivityAt;
      this._whenFree(() => {
        // the user started something meanwhile: no description over their conversation
        if (c.lastActivityAt !== activityBefore) return;
        c.sendText(describePrompt(a.cameraName || this.getSettings().tapo?.name || 'camera', Number(a.at) || at), {
          hidden: true, source: 'camera', note: DESCRIBE_NOTE, images: [{ mediaType: a.snapshot.mediaType || 'image/jpeg', data: a.snapshot.data }],
        });
      }, DESCRIBE_WAIT_MS);
    }
  }

  /** main's lm:tapo:look: a point in this window's CSS px (the camera window's centre). @param {any} p */
  onLook(p) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    const rect = this.d.getStage?.();
    if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const g = gazeFromPoint(x, y, rect);
    if (!g) return;
    const hold = Math.min(15_000, Math.max(500, Number(p.holdMs) || 4000));
    this.d.gaze?.cursor(g, hold);
    this.emit('look', { g, holdMs: hold });
  }

  getSettings() {
    return this.d.getSettings() || {};
  }

  // ------------------------------------------------------------------------------------------
  // local commands

  /**
   * The controller's command interceptor: true = a camera command, handled here.
   * @param {string} text @param {{ source?: string }} [_o]
   */
  intercept(text, _o = {}) {
    const s = this.getSettings();
    if (!this.available || !s.tapo?.enabled || s.security?.voiceCommands === false) return false;
    const intent = parseCameraIntent(text, { presets: this.presets.map((p) => p.name), name: s.tapo?.name || 'camera' });
    if (!intent) return false;
    // only turning needs the camera; arming, disarming and the window are local (review: "disarm
    // the camera" with the camera offline went to Claude, which has no disarm)
    if (intent.kind === 'ptz' && this.status?.connection !== 'online') return false;
    this.emit('intent', intent);
    this._run(intent).catch((err) => this._confirm(`The camera did not answer: ${err?.message || err}`, 'error'));
    return true;
  }

  /** @param {import('./intents.js').CameraIntent} intent */
  async _run(intent) {
    const t = this.bridge.tapo;
    if (intent.kind === 'ptz') {
      const r = await t.ptz(intent.cmd);
      if (r?.ok) this._confirm(intent.say);
      else this._confirm(ptzMessage(r), 'warn');
      return;
    }
    if (intent.kind === 'arm') {
      const r = await t.arm(intent.armed);
      if (!intent.armed) {
        this._confirm(r && !r.armed && !r.arming ? 'Disarmed.' : 'The camera is still armed.', r && !r.armed && !r.arming ? 'info' : 'warn');
        return;
      }
      const left = r?.arming && Number.isFinite(r.armingEndsAt) ? (r.armingEndsAt - this._now()) / 1000 : 0;
      this._confirm(r?.armed || r?.arming ? armedLine(left > 0 ? Math.round(left) : 0) : 'The camera could not be armed.', r?.armed || r?.arming ? 'info' : 'warn');
      return;
    }
    if (intent.kind === 'open') {
      await t.openWindow();
      this._confirm(intent.say);
    }
  }

  /** Say it (a toast when the avatar cannot speak now). @param {string} line @param {'info'|'warn'|'error'} [level] */
  _confirm(line, level = 'info') {
    if (!line) return;
    if (!this.controller.say(line)) this.view.toast?.(line, level === 'info' ? 'info' : level);
  }

  /**
   * Run `fn` once the avatar is free (now, or as soon as it is within `timeoutMs`).
   * @param {() => void} fn @param {number} timeoutMs
   */
  _whenFree(fn, timeoutMs) {
    const c = this.controller;
    let done = false;
    /** @type {Array<() => void>} */
    const offs = [];
    const finish = (/** @type {boolean} */ run) => {
      if (done) return;
      done = true;
      for (const off of offs) off();
      this._waits.delete(cancel);
      if (run) fn();
    };
    const cancel = () => finish(false);
    const check = () => {
      if (c.isIdle()) finish(true);
    };
    // the state events cover most of it; the poll covers a line whose speech failed silently
    if (typeof c.on === 'function') offs.push(c.on('state', () => this._st(check, 0)));
    const poll = this._si(check, 500);
    offs.push(() => this._ci(poll));
    const timer = this._st(() => finish(false), timeoutMs);
    offs.push(() => this._ct(timer));
    this._waits.add(cancel);
    this._st(check, 0);
  }
}
