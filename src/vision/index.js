// The camera feature: the avatar can see you (docs/CAMERA.md).
//
//   settings.camera.enabled → (first time: the privacy card) → CameraCapture opens the webcam →
//   FaceTracker (MediaPipe, worker) → AttentionTracker → behaviours, each behind its setting:
//     followFace         eye contact through the GazeArbiter (a moving cursor still wins)
//     presence           away > 2 min while idle → sleep; back → wake with a brow raise + smile
//     mirrorExpressions  a gentle smile back when the user smiles
//     greet              back after ≥ 10 min → a short hidden prompt so Claude says hello
//     lookToTalk         hands-free only listens while the user looks at the screen
//   and the pictures for Claude: shareWithClaude (every message) or the 📷 one-shot, through the
//   controller's snapshot provider.
//
// The camera only runs while it is enabled AND the window can be seen; it is released (the
// camera light goes off) while the window is hidden or minimized. Face tracking slows down when
// nobody is there or the avatar sleeps. Nothing is stored or sent anywhere except a snapshot in
// a Claude turn.
//
// Everything outside is injected (camera, tracker, controller, avatar, gaze, UI, storage, clock),
// so the behaviour is unit-tested with fakes.

import { Emitter } from '../app/emitter.js';
import { AttentionTracker } from './attention.js';
import { CameraCapture, describeCameraError, listCameras } from './camera.js';
import { FaceTracker } from './face-tracker.js';
import { faceGaze } from './gaze.js';
import { PresenceMachine } from './presence.js';
import { captureSnapshot } from './snapshot.js';

/** Detections per second: someone in view / looking for someone / the avatar sleeps. */
export const TRACK_RATES = Object.freeze({ tracking: 12, searching: 4, sleeping: 2 });
/** The smile the avatar answers a smile with, and the wake-up greeting expression. */
export const MIRROR_SMILE = 0.5;
export const WELCOME = Object.freeze({ browUp: 0.7, browMs: 700, smile: 0.55, smileMs: 1800 });
/** localStorage key: the privacy card was accepted once on this PC. */
export const CONSENT_KEY = 'lawnmower.camera.consent.v1';

/**
 * The hidden prompt of the camera greeting. It goes to Claude only; the transcript shows a note.
 * @param {number} minutes
 */
export function greetingPrompt(minutes) {
  return `(Automatic note from the Lawnmower Man app, not typed by the user: the camera shows that the user just sat back down at the computer after about ${minutes} minutes away. Greet them briefly and warmly, in one short spoken sentence. You don't need to mention the camera.)`;
}

/**
 * @typedef {'off'|'consent'|'starting'|'on'|'paused'|'error'} CameraState
 * @typedef {'off'|'loading'|'on'|'failed'} TrackingState
 */

/**
 * The DOM side (src/vision/ui.js implements it).
 * @typedef {object} CameraView
 * @property {(s: { state: CameraState, tracking: TrackingState, present: boolean, looking: boolean, shotArmed: boolean, shareAlways: boolean, gate: boolean }) => void} [setState]
 * @property {(o: { onAccept: () => void, onDecline: () => void }) => void} [showConsent]
 * @property {() => void} [hideConsent]
 * @property {(m: import('./camera.js').CameraErrorModel, o: { onRetry: () => void, onTurnOff: () => void }) => void} [showError]
 * @property {() => void} [hideError]
 * @property {(msg: string, level?: 'info'|'warn'|'error'|'success') => void} [toast]
 * @property {(cams: Array<{ id: string, label: string }>) => void} [setDevices]
 * @property {() => void} [changed]  something the info panel shows changed
 */

export class CameraFeature extends Emitter {
  /**
   * @param {object} d
   * @param {() => any} d.getSettings          the full settings (withDefaults applied)
   * @param {(patch: object) => Promise<any>} d.saveSettings
   * @param {any} d.controller                  src/app/controller.js Controller
   * @param {() => any} d.getAvatar             the current avatar (it is replaced on renderer changes)
   * @param {import('./gaze.js').GazeArbiter} d.gaze
   * @param {CameraView} [d.view]
   * @param {CameraCapture} [d.camera]
   * @param {FaceTracker} [d.tracker]
   * @param {() => FaceTracker} [d.createTracker]
   * @param {AttentionTracker} [d.attention]
   * @param {PresenceMachine} [d.presence]
   * @param {{ get: (k: string) => string|null, set: (k: string, v: string) => void }} [d.storage]
   * @param {(video: HTMLVideoElement) => Promise<import('./snapshot.js').Snapshot>} [d.capture]
   * @param {() => Promise<Array<{ id: string, label: string }>>} [d.listCameras]
   * @param {() => boolean} [d.userBusy]        e.g. the user is typing (no greeting then)
   * @param {string} [d.platform]
   * @param {() => number} [d.now]
   * @param {(fn: () => void, ms: number) => any} [d.setTimeout]
   * @param {(id: any) => void} [d.clearTimeout]
   */
  constructor(d) {
    super();
    this.d = d;
    this._now = d.now || (() => performance.now());
    this._setTimeout = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = d.clearTimeout || ((id) => clearTimeout(id));
    this.view = d.view || {};
    this.camera = d.camera || new CameraCapture();
    this._createTracker = d.createTracker || (() => d.tracker || new FaceTracker());
    this.attention = d.attention || new AttentionTracker();
    this.presence = d.presence || new PresenceMachine({}, this._now());
    this._capture = d.capture || captureSnapshot;
    this._listCameras = d.listCameras || (() => listCameras());
    this._storage = d.storage || browserStorage();
    this.platform = d.platform || 'win32';

    /** @type {CameraState} */
    this.state = 'off';
    /** @type {TrackingState} */
    this.tracking = 'off';
    /** @type {FaceTracker|null} */
    this.tracker = null;
    this.visible = true;
    /** the 📷 button: a snapshot goes with the next message */
    this.shotArmed = false;
    this.error = /** @type {import('./camera.js').CameraErrorModel|null} */ (null);
    this.trackingError = '';
    this._gate = true;
    this._mirror = 0;
    this._browUntil = 0;
    this._smileUntil = 0;
    this._expr = { smile: -1, browUp: -1, avatar: /** @type {any} */ (null) };
    this._exprTimer = null;
    this._lastActivityNote = -Infinity;
    this._startGen = 0;
    this._offs = /** @type {Array<() => void>} */ ([]);
    this._settings = d.getSettings();

    d.controller.setSnapshotProvider?.({
      wants: (/** @type {{ hidden: boolean }} */ o) => this._wantsSnapshot(o),
      capture: (/** @type {{ hidden: boolean }} */ o) => this._takeSnapshot(o),
    });
    this._offs.push(this.camera.on('ended', () => this._onCameraEnded()));
    // once per missing camera, not on every start (each restore of the window starts it again)
    this._fallbackWarned = '';
    this._offs.push(this.camera.on('device-fallback', (/** @type {string} */ id) => {
      if (id === this._fallbackWarned) return;
      this._fallbackWarned = id;
      this.view.toast?.('The chosen camera is not connected; using the default camera.', 'warn');
    }));
  }

  /** The camera stream is live. */
  get active() {
    return this.state === 'on';
  }

  /** What the info panel and tests read. */
  get status() {
    const a = this.attention.state;
    return {
      state: this.state,
      tracking: this.tracking,
      mode: this.tracker?.mode || '',
      delegate: this.tracker?.delegate || '',
      rate: this.tracker?.rate || 0,
      lastMs: this.tracker?.lastMs || 0,
      frames: this.tracker?.frames || 0,
      label: this.camera.label,
      present: a.present,
      looking: a.looking,
      smiling: a.smiling,
      talking: a.talking,
      distanceCm: a.distanceCm,
      gate: this._gate,
      shotArmed: this.shotArmed,
      error: this.error,
      trackingError: this.trackingError,
    };
  }

  // ------------------------------------------------------------------------------------------
  // inputs

  /** New settings (also call once at start). @param {any} settings */
  applySettings(settings) {
    const prev = this._settings;
    this._settings = settings;
    const c = settings.camera || {};
    const p = prev?.camera || {};
    if (!c.enabled) {
      if (this.state !== 'off') this._turnOff();
    } else if (this.state === 'off') {
      this._begin();
    } else if (c.deviceId !== p.deviceId && (this.state === 'on' || this.state === 'error' || this.state === 'starting')) {
      this._start(); // another camera
    }
    if (!c.followFace) this.d.gaze.setFace(null);
    if (!c.mirrorExpressions) this._mirror = 0;
    this._applyExpression();
    this._updateGate();
    this._render();
  }

  /** The window became visible / hidden or minimized. @param {boolean} visible */
  setVisible(visible) {
    const v = !!visible;
    if (v === this.visible) return;
    this.visible = v;
    if (!v) {
      if (this.state === 'on' || this.state === 'starting') this._pause();
    } else if (this.state === 'paused') {
      this._start();
    }
  }

  /** 📷: arm (or disarm) a snapshot for the next message. @returns {boolean} armed */
  toggleShot() {
    if (!this.active) {
      this.shotArmed = false;
      this.view.toast?.('Turn the camera on first (the camera button above).', 'info');
    } else {
      this.shotArmed = !this.shotArmed;
    }
    this._render();
    return this.shotArmed;
  }

  /** Toolbar button / indicator: turn the camera on or off. */
  toggle() {
    const on = !this._settings.camera?.enabled;
    return this.d.saveSettings({ camera: { enabled: on } });
  }

  /** Re-list the cameras for the device picker (drawer opened, devices changed, camera started). */
  async refreshDevices() {
    try {
      this.view.setDevices?.(await this._listCameras());
    } catch { /* no devices API */ }
  }

  dispose() {
    this._turnOff();
    for (const off of this._offs) off();
    this._offs = [];
    this.d.controller.setSnapshotProvider?.(null);
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle

  _begin() {
    if (this._storage.get(CONSENT_KEY) === 'yes') {
      this._start();
      return;
    }
    // first time: explain before anything is opened
    this.state = 'consent';
    this.view.showConsent?.({
      onAccept: () => {
        this._storage.set(CONSENT_KEY, 'yes');
        this.view.hideConsent?.();
        if (this.state === 'consent') this._start();
      },
      onDecline: () => {
        this.view.hideConsent?.();
        if (this.state === 'consent') {
          this.state = 'off';
          this._render();
        }
        this.d.saveSettings({ camera: { enabled: false } })?.catch?.(() => {});
      },
    });
    this._render();
  }

  async _start() {
    const gen = ++this._startGen;
    this.view.hideError?.();
    this.error = null;
    if (!this.visible) {
      this.state = 'paused';
      this._render();
      return;
    }
    this.state = 'starting';
    this._render();
    try {
      await this.camera.start(this._settings.camera?.deviceId || '');
    } catch (err) {
      if (gen !== this._startGen || /** @type {any} */ (err)?.superseded) return;
      this.state = 'error';
      this.error = describeCameraError(err, this.platform);
      console.warn('[camera] could not start:', /** @type {any} */ (err)?.name, /** @type {any} */ (err)?.message);
      this.view.showError?.(this.error, {
        onRetry: () => this._start(),
        onTurnOff: () => this.d.saveSettings({ camera: { enabled: false } })?.catch?.(() => {}),
      });
      this._render();
      return;
    }
    if (gen !== this._startGen) return;
    // the chosen camera works (again): warn again if it goes missing later
    if (this.camera.deviceId && this.camera.deviceId === this._settings.camera?.deviceId) this._fallbackWarned = '';
    this.state = 'on';
    this.attention.reset(this._now());
    this.presence.reset(this._now());
    this._render();
    this.refreshDevices(); // labels are known now
    this._startTracking(gen);
  }

  /** @param {number} gen */
  _startTracking(gen) {
    if (this.tracker && this.tracking === 'failed') {
      // it gave up before (e.g. the GPU context was lost): try once more with this camera start
      this.tracker.dispose();
      this.tracker = null;
    }
    if (!this.tracker) {
      const t = this._createTracker();
      this.tracker = t;
      this.tracking = 'loading';
      this.trackingError = '';
      this._offs.push(t.on('observation', (o) => this._onObservation(o)));
      this._offs.push(t.on('ready', () => {
        this.tracking = 'on';
        this._render();
      }));
      this._offs.push(t.on('error', (err) => {
        if (!err?.fatal) {
          console.warn('[camera] face tracking:', err?.message || err);
          return;
        }
        this.tracking = 'failed';
        this.trackingError = String(err.message || err);
        console.warn('[camera] face tracking unavailable:', this.trackingError);
        this.view.toast?.(`Face tracking is not available (${this.trackingError}). Snapshots for Claude still work.`, 'warn');
        this._updateGate();
        this._render();
      }));
      t.start().catch(() => { /* reported through 'error' */ });
    }
    if (gen !== this._startGen) return;
    this.tracker.setVideo(this.camera.video);
    this._updateRate();
  }

  _pause() {
    this._startGen++;
    this.camera.stop();
    this.tracker?.setVideo(null);
    this.tracker?.setRate(0);
    this.state = 'paused';
    this._lostSight();
    this._render();
  }

  _turnOff() {
    this._startGen++;
    this.view.hideConsent?.();
    this.view.hideError?.();
    this.camera.stop();
    this.tracker?.dispose();
    this.tracker = null;
    this.tracking = 'off';
    this.trackingError = '';
    this.state = 'off';
    this.error = null;
    this.shotArmed = false;
    this._lostSight();
    this._render();
  }

  _onCameraEnded() {
    if (this.state !== 'on') return;
    this.tracker?.setVideo(null);
    this.state = 'error';
    this.error = describeCameraError({ name: 'NotReadableError', message: 'The camera stopped (unplugged, or taken over by another app).' }, this.platform);
    this.view.showError?.(this.error, {
      onRetry: () => this._start(),
      onTurnOff: () => this.d.saveSettings({ camera: { enabled: false } })?.catch?.(() => {}),
    });
    this._lostSight();
    this._render();
  }

  /** The camera stopped seeing: release everything a face drove. */
  _lostSight() {
    this.attention.reset(this._now());
    this.presence.reset(this._now());
    this.d.gaze.setFace(null);
    this._mirror = 0;
    this._applyExpression();
    this._updateGate();
  }

  // ------------------------------------------------------------------------------------------
  // behaviours

  /** @param {{ obs: any, t: number }} o */
  _onObservation(o) {
    if (this.state !== 'on') return;
    const t = o.t;
    const s = this._settings.camera || {};
    const ctl = this.d.controller;
    const wasPresent = this.attention.state.present;
    const wasLooking = this.attention.state.looking;
    const att = this.attention.update(o.obs, t);

    for (const ev of this.presence.update(att.present, t, { idle: this._idle(), sleeping: !!ctl.sleeping, lastSeen: att.lastSeen })) {
      if (ev.type === 'away') {
        if (s.presence) ctl.sleep?.();
      } else if (ev.type === 'back') {
        if (s.presence && ev.welcome) this._welcome(t);
        if (s.greet && ev.greet) this._greet(ev.awayMs, t);
      }
    }
    // someone is there: keep the avatar awake (it dozes after a while without any input)
    if (s.presence && att.present && t - this._lastActivityNote >= 1000) {
      this._lastActivityNote = t;
      if (!ctl.sleeping) ctl.noteActivity?.();
    }
    this.d.gaze.setFace(s.followFace && att.present ? faceGaze(att) : null);
    this._mirror = s.mirrorExpressions && att.present && att.smiling ? MIRROR_SMILE : 0;
    this._applyExpression();
    this._updateGate();
    this._updateRate();
    if (att.present !== wasPresent || att.looking !== wasLooking) this._render();
    this.view.changed?.();
  }

  /** @param {number} t */
  _welcome(t) {
    const ctl = this.d.controller;
    if (ctl.sleeping) ctl.noteActivity?.(); // wakes it
    this._browUntil = t + WELCOME.browMs;
    this._smileUntil = t + WELCOME.smileMs;
    this._applyExpression();
  }

  /** @param {number} awayMs @param {number} t */
  _greet(awayMs, t) {
    const ctl = this.d.controller;
    // never during a turn, while listening, with a card open, or while the user types
    if (!ctl.isIdle?.() || ctl.claudeProblem || (ctl.claudeStatus && ctl.claudeStatus.status && !['ready', 'busy'].includes(ctl.claudeStatus.status))) return;
    if (this.d.userBusy?.()) return;
    const minutes = Math.max(1, Math.round(awayMs / 60_000));
    const sent = ctl.sendText(greetingPrompt(minutes), {
      source: 'camera',
      hidden: true,
      note: `You're back after ${minutes} min, so the camera asked Claude to say hello.`,
    });
    if (sent) this.presence.markGreeted(t);
  }

  _idle() {
    const ctl = this.d.controller;
    return typeof ctl.isIdle === 'function' ? ctl.isIdle() : ctl.state === 'idle';
  }

  /** smile = max(mirror, welcome), browUp = welcome flash; sent only when it changes. */
  _applyExpression() {
    const now = this._now();
    const smile = Math.max(this._mirror, now < this._smileUntil ? WELCOME.smile : 0);
    const browUp = now < this._browUntil ? WELCOME.browUp : 0;
    const avatar = this.d.getAvatar?.();
    if (avatar && (smile !== this._expr.smile || browUp !== this._expr.browUp || avatar !== this._expr.avatar)) {
      this._expr = { smile, browUp, avatar };
      avatar.setExpression?.({ smile, browUp });
    }
    this._clearTimeout(this._exprTimer);
    this._exprTimer = null;
    const next = [this._browUntil, this._smileUntil].filter((x) => x > now);
    if (next.length) this._exprTimer = this._setTimeout(() => this._applyExpression(), Math.min(...next) - now + 5);
  }

  /** look-to-talk: hands-free listens only while the user looks at the screen. */
  _updateGate() {
    const s = this._settings;
    const gating = !!s.camera?.lookToTalk && !!s.voice?.handsFree && this.state === 'on' && this.tracking === 'on';
    const a = this.attention.state;
    const open = !gating || (a.present && a.looking);
    if (open === this._gate) return;
    this._gate = open;
    this.d.controller.setListenGate?.(open);
    this._render();
  }

  _updateRate() {
    if (!this.tracker) return;
    let hz = 0;
    if (this.state === 'on' && this.visible) {
      if (this.d.controller.sleeping) hz = TRACK_RATES.sleeping;
      else hz = this.attention.state.present ? TRACK_RATES.tracking : TRACK_RATES.searching;
    }
    this.tracker.setRate(hz);
  }

  // ------------------------------------------------------------------------------------------
  // snapshots for Claude

  /**
   * A picture goes only with a message the user sends (and so sees in the chat, with its
   * thumbnail): never with the app's own hidden prompts such as the greeting.
   * @param {{ hidden?: boolean }} o
   */
  _wantsSnapshot(o) {
    if (!this.active || !this.camera.video || o?.hidden) return false;
    return !!this._settings.camera?.shareWithClaude || this.shotArmed;
  }

  /** @param {{ hidden?: boolean }} o */
  async _takeSnapshot(o) {
    if (!o?.hidden && this.shotArmed) {
      this.shotArmed = false; // one message only
      this._render();
    }
    const video = this.camera.video;
    if (!video) throw new Error('the camera is off');
    const snap = await this._capture(video);
    return [snap];
  }

  _render() {
    this.view.setState?.({
      state: this.state,
      tracking: this.tracking,
      present: this.attention.state.present,
      looking: this.attention.state.looking,
      shotArmed: this.shotArmed,
      shareAlways: !!this._settings.camera?.shareWithClaude,
      gate: this._gate,
    });
    this.view.changed?.();
    this.emit('state', this.state);
  }
}

/** localStorage, or memory when it is unavailable. */
function browserStorage() {
  const mem = new Map();
  return {
    get(/** @type {string} */ k) {
      try {
        return globalThis.localStorage?.getItem(k) ?? mem.get(k) ?? null;
      } catch {
        return mem.get(k) ?? null;
      }
    },
    set(/** @type {string} */ k, /** @type {string} */ v) {
      mem.set(k, v);
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch { /* private mode */ }
    },
  };
}
