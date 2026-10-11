// WakeFeature: "Hey Jade" in the avatar window (contract-wake §9.5). It wires the pure state
// machine (src/wake/machine.js) to everything that has side effects:
//
//   mic tap (16 kHz) ──► WakePort ──► the utility's spotters ──► hit ──► SelfMask ──► machine
//   machine: capture → controller.wakeWordCapture   verify → ring → WAV → /stt → veto → machine
//            earcon / duck / unduck → AudioPlayer    stopSpeaking / quiet → controller
//            report → bridge.wake.report (the tray) and the UI (src/wake/ui.js)
//   controller → adapter: state, idle (follow-up), decide (the command), noSpeech, cancelled
//
// Nothing is transcribed before stage 1 fires: the tap only feeds the engine and a 3 s ring in
// the Mic. The wake segment (≤ 1.2 s before the end of "Jade" to where stage 1 decided, machine.js
// wakeSegment) is the only audio that goes to /stt for the check; the command is captured from
// 150 ms after the keyword's end.

import { HALLUCINATION } from '../app/controller.js';
import { Emitter } from '../app/emitter.js';
import { encodeWav } from '../audio/wav.js';
import { earconDurationMs, earconSamples } from './earcons.js';
import { WAKE, WakeMachine } from './machine.js';
import { veto } from './phrase.js';
import { WakePort } from './port.js';
import { SelfMask, TapClock, inputLatencySec } from './self-mask.js';
import { WAKE_TEXT } from './ui.js';

/** "Test my echo" says this twice: it is designed to fire stage 1 (contract-wake §8.5). */
export const ECHO_TEST_LINE = 'Just say hey Jade whenever you need me. Just say hey Jade whenever you need me.';
/** The echo test ends after this long whatever happens (a voice that never says "idle"). */
export const ECHO_TEST_MAX_MS = 20000;
/** What the echo test says when she cannot speak. */
export const ECHO_TEST_NO_VOICE = 'Turn on Settings › Voice › Speak replies to test the echo (she has to speak for it).';

const RATE = 16000;

/**
 * @typedef {object} WakeDeps
 * @property {any} bridge            window.lawnmower (bridge.wake, bridge.window.show)
 * @property {import('../app/controller.js').Controller} controller
 * @property {import('../audio/mic.js').Mic} mic
 * @property {import('../audio/player.js').AudioPlayer} player
 * @property {import('../app/speech-queue.js').SpeechQueue} [speech]  default controller.speech
 * @property {{ stt: any, tts: any }} services                         createSpeechServices()
 * @property {() => any} [voiceInfo]   VoiceClient.info (is the local voice starting?)
 * @property {() => any} [getAvatar]
 * @property {any} [gaze]              GazeArbiter
 * @property {any} [camera]            CameraFeature|null
 * @property {import('./ui.js').WakeUi|any} view
 * @property {() => any} getSettings
 * @property {(fields: Record<string, any>) => Promise<any>|void} saveWake  bridge.settings.set({ wake: fields }) via the app
 * @property {() => number} [now]
 * @property {any} [win]
 * @property {any} [mediaDevices]
 * @property {() => boolean} [reducedMotion]
 * @property {string} [platform]   process.platform (tests; default: the browser's)
 */

export class WakeFeature extends Emitter {
  /** @param {WakeDeps} d */
  constructor(d) {
    super();
    this.d = d;
    this.bridge = d.bridge;
    this.ctl = d.controller;
    this.mic = d.mic;
    this.player = d.player;
    this.speech = d.speech || d.controller.speech;
    this.view = d.view;
    this._now = d.now || (() => performance.now());
    this.machine = new WakeMachine({ now: this._now, hallucination: HALLUCINATION });
    this.mask = new SelfMask({ now: this._now, preMs: WAKE.selfPreMs, tailMs: WAKE.selfTailMs, echoWindowMs: WAKE.selfEchoWindowMs, jaccard: WAKE.selfEchoJaccard });
    this.clock = new TapClock();
    this.port = new WakePort({ bridge: this.bridge, win: d.win });
    /** @type {any} main's WakeEngineStatus */
    this.engine = { engine: 'off', detail: '', models: {} };
    this.hidden = false;
    this._settings = null;
    this._offs = /** @type {Array<() => void>} */ ([]);
    this._queue = /** @type {any[]} */ ([]);
    this._draining = false;
    this._timer = 0;
    this._micGen = 0;
    /** @type {Map<string, { id: string, from: number, to: number, keyword: string, abort: AbortController, started: boolean }>} */
    this._verifies = new Map();
    /** @type {Map<string, (d: any) => void>} decide() calls waiting for the machine's decision */
    this._decisions = new Map();
    this._fb = 0;
    /** @type {Map<string, number>} when each hit's keyword ended (performance.now) */
    this._hitEnd = new Map();
    this._sleepingAtHit = false;
    /** the hit that woke her from a doze (asleep again if it is rejected) */
    this._dozedAtHit = /** @type {any} */ (null);
    this._zeroRun = 0;
    this._reportTimer = 0;
    this._lastReport = '';
    this._pendingReport = null;
    this._renderTimer = 0;
    this._offered = false;
    this._started = false;
    /** @type {null | { hits: number, timer: any, cap: any, off: () => void, done: boolean }} */
    this._echoTest = null;
    this.echoResult = '';
    /** @type {null | { chunks: Float32Array[], n: number, max: number, startAt: number, next: number, hits: any[], timer: any, done: boolean }} */
    this._rec = null;
    /** running|fallback as the controller last heard it (hands-free follows it) */
    this._runKey = '';
    this._presenceKey = '';
    this._renderNow = false;
    this._lastWarn = 0;
    this._onTap = (/** @type {Float32Array} */ x, /** @type {{ at: number, arrivalPerf: number }} */ info) => this._tap(x, info);
    /** what the controller calls (src/app/controller.js WakeWordAdapter) */
    this.adapter = {
      active: () => this.machine.running,
      fallback: () => this.machine.fallback,
      manual: (/** @type {any} */ o) => this._step({ type: 'manual', from: o?.from || 'hotkey' }),
      idle: (/** @type {any} */ info) => this._step({ type: 'turnDone', ...info }),
      state: (/** @type {string} */ s) => this._step({ type: 'conversation', ...this._conv(s) }),
      decide: (/** @type {string} */ text, /** @type {any} */ meta, /** @type {any} */ o) => this._decide(text, meta, o || {}),
      noSpeech: (/** @type {any} */ meta) => this._step({ type: 'captureNoSpeech', meta }),
      captured: (/** @type {any} */ meta) => this._step({ type: 'captured', meta }),
      cancelled: (/** @type {any} */ meta) => this._step({ type: 'captureCancelled', meta }),
    };
  }

  /** The wake word's state (WakeUiState). */
  get state() {
    return this.machine.state;
  }

  /** The last 20 wake events (reason classes, never text or audio). */
  get log() {
    return this.machine.log.slice();
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle

  start() {
    if (this._started) return;
    this._started = true;
    const b = this.bridge;
    this.port.start();
    this._offs.push(this.port.on('hit', (h) => this._onHit(h)));
    // the port is the engine as far as this window is concerned: ready only once the utility
    // answered on it, "starting" again when it stops answering (main restarts a frozen one); a
    // new port (a restarted utility, a reloaded window) is told the strict mode it should be in
    this._offs.push(this.port.on('ready', () => {
      this.port.strict(this.machine.strict);
      this._onEngine({});
    }));
    this._offs.push(this.port.on('lost', () => this._onEngine({})));
    this._offs.push(this.port.on('stats', () => this._renderSoon()));
    this._offs.push(this.port.on('error', (e) => this._warn(`[wake] engine: ${e.message}`)));
    this._offs.push(this.speech.on('playing', (item) => this.mask.clipStart({ key: item?.clip, text: item?.text, kind: item?.clip?.kind })));
    this._offs.push(this.player.on('end', (clip) => this.mask.clipEnd(clip)));
    this._offs.push(this.mic.on('mute', (m) => this._step({ type: 'micMute', muted: !!m?.muted })));
    this._offs.push(this.mic.on('lost', () => this._step({ type: 'micError', reason: 'ended' })));
    this._offs.push(this.mic.on('speechstart', () => this._step({ type: 'speechStart' })));
    if (this.d.camera?.on) this._offs.push(this.d.camera.on('state', () => this._presence()));
    const md = this.d.mediaDevices ?? globalThis.navigator?.mediaDevices;
    if (md?.addEventListener) {
      const onChange = () => {
        if (this.mic.tapped && !this.mic.isOpen && !this.mic.mode) this._step({ type: 'micError', reason: 'ended' });
      };
      md.addEventListener('devicechange', onChange);
      this._offs.push(() => md.removeEventListener('devicechange', onChange));
    }
    if (typeof b.wake?.onStatus === 'function') this._offs.push(b.wake.onStatus((st) => this._onEngine(st)));
    if (typeof b.wake?.onPower === 'function') this._offs.push(b.wake.onPower((p) => this._step({ type: 'power', state: p?.state, seq: p?.seq })));
    this.ctl.setWakeWord(this.adapter);
    this.applySettings(this.d.getSettings());
    this.voiceChanged();
    this._presence();
    this._refreshEngine();
  }

  dispose() {
    for (const off of this._offs) {
      try { off(); } catch { /* ignore */ }
    }
    this._offs = [];
    clearTimeout(this._timer);
    clearTimeout(this._reportTimer);
    clearTimeout(this._renderTimer);
    this.ctl.setWakeWord(null);
    this._recAbort('');
    if (this._echoTest) {
      clearTimeout(this._echoTest.timer);
      clearTimeout(this._echoTest.cap);
      this._echoTest.off?.();
      this._echoTest = null;
    }
    for (const j of this._verifies.values()) j.abort.abort();
    this._verifies.clear();
    for (const r of this._decisions.values()) r({ action: 'drop', reason: 'disposed' });
    this._decisions.clear();
    this._releaseMic();
    this.port.dispose();
    this.removeAllListeners();
  }

  /** New settings (also once at start). @param {any} s */
  applySettings(s) {
    const prev = this._settings;
    this._settings = s;
    const w = s?.wake || {};
    this._step({ type: 'settings', wake: w, lookToTalk: !!s?.camera?.lookToTalk });
    if (prev && !prev.wake?.enabled && w.enabled) {
      // turned on by other means than the card: the same explanation once, as a toast (§9.6)
      if (!w.explained) {
        this.view.toast?.(WAKE_TEXT.offer, 'info');
        this.d.saveWake({ explained: true });
      }
      this.view.hideOffer?.();
      this._refreshEngine();
    }
    if (prev && prev.wake?.enabled && !w.enabled) this.port.close();
    this._maybeOffer();
    this.ctl.wakeWordChanged();
  }

  /** The window was shown or hidden (main's visibility events). @param {boolean} visible */
  setVisible(visible) {
    this.hidden = !visible;
    this._step({ type: 'visibility', visible: !!visible });
  }

  /** The local voice changed (ready, starting, gone): what the wake word can do follows. */
  voiceChanged() {
    const stt = this.d.services.stt;
    const info = this.d.voiceInfo?.() || {};
    const ready = !!stt.available();
    const starting = !ready && info.status === 'starting' && this._settings?.voice?.enabled !== false;
    this._step({
      type: 'availability',
      stt: ready ? 'ready' : starting ? 'starting' : 'off',
      sttReason: ready ? '' : starting ? 'The local voice is starting' : String(stt.unavailableReason?.() || 'Hey Jade needs the local voice'),
      device: stt.device?.() ?? null,
    });
    this._maybeOffer();
    this.ctl.wakeWordChanged();
  }

  /** The microphone badge was clicked: "Hey Jade" off (the mic is released at once). */
  turnOff() {
    if (!this._settings?.wake?.enabled) return false;
    Promise.resolve(this.d.saveWake({ enabled: false })).catch(() => {});
    this.view.toast?.('“Hey Jade” is off: the microphone is released. Turn it back on in the tray or in Settings › Voice.', 'info');
    return true;
  }

  /** "Retry" after a blocked microphone. */
  retryMic() {
    this._step({ type: 'micError', reason: 'ended' });
  }

  // ------------------------------------------------------------------------------------------
  // the engine (main) and the port

  _refreshEngine() {
    const fn = this.bridge.wake?.status;
    if (typeof fn !== 'function') return;
    Promise.resolve()
      .then(() => fn.call(this.bridge.wake))
      .then((st) => this._onEngine(st), (err) => this._warn(`[wake] status failed: ${err?.message || err}`));
  }

  /** @param {any} st WakeEngineStatus */
  _onEngine(st) {
    if (!st || typeof st !== 'object') return;
    this.engine = { ...this.engine, ...st };
    // main's lock/sleep state: a window (re)loaded while the PC is locked starts locked (§2.3)
    if (st.power && typeof st.power === 'object') this._step({ type: 'power', snapshot: st.power });
    const e = this.engine.engine;
    // main says ready, but nothing answers on the port (yet, or any more): still starting
    const deaf = e === 'ready' && !this.port.ready;
    this._step({
      type: 'availability',
      engine: deaf ? 'starting' : e === 'ready' || e === 'starting' || e === 'missing' || e === 'error' ? e : 'off',
      engineDetail: deaf ? (this.port.gen > 0 ? 'The wake-word engine is not answering; reconnecting.' : 'Connecting to the wake-word engine.') : String(this.engine.detail || ''),
    });
    // the utility runs only while the wake word is on; main pushes a new port after a restart
    if (e === 'ready' && this._settings?.wake?.enabled && !this.port.port) this.port.request();
    if (e !== 'ready' && e !== 'starting') this.port.close();
    this._renderSoon();
  }

  /** @param {any} h a validated hit (port.js) */
  _onHit(h) {
    if (this._rec) this._rec.hits.push({ id: h.id, atSec: Math.max(0, (h.endAt - this._rec.startAt) / RATE), keyword: h.keyword, outcome: 'heard' });
    if (this._echoTest) {
      // the echo test says a line that is made to wake her: count, never act
      if (h.keyword === 'HEY_JADE') this._echoTest.hits++;
      return;
    }
    const lat = inputLatencySec(this.machine.echo);
    const startPerf = this.clock.perf(h.startAt, lat);
    const endPerf = this.clock.perf(h.endAt, lat);
    const m = this.mask.masked(startPerf, endPerf);
    if (endPerf != null) this._hitEnd.set(h.id, endPerf);
    if (this._hitEnd.size > 50) this._hitEnd.delete(this._hitEnd.keys().next().value);
    this._sleepingAtHit = !!this.ctl.sleeping;
    // a stage-1 hit that the check then rejects must not keep her awake (the TV's "Hey Jake")
    if (!m && this._sleepingAtHit && !this.machine.active) this._dozedAtHit = h.id;
    if (m) this._recOutcome(h.id, `ignored: ${m.reason}`);
    this._step({ type: 'hit', ...h, masked: m ? m.reason : null, conv: this._conv() });
  }

  // ------------------------------------------------------------------------------------------
  // the tap

  /** @param {Float32Array} x @param {{ at: number, arrivalPerf: number }} info */
  _tap(x, info) {
    this.clock.push(info.at, x.length, info.arrivalPerf);
    this.port.post(x, info.at);
    // a driver that delivers exact zeros (WIN-4)
    let zero = true;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) {
      this._zeroRun += (x.length / RATE) * 1000;
      if (this._zeroRun >= WAKE.digitalSilenceMs && this._zeroRun - (x.length / RATE) * 1000 < WAKE.digitalSilenceMs) this._step({ type: 'audio', zeroRunMs: this._zeroRun });
    } else {
      this._zeroRun = 0;
    }
    for (const j of this._verifies.values()) if (!j.started) this._tryVerify(j);
    if (this._rec && !this._rec.done) this._recPush(x, info.at);
  }

  // ------------------------------------------------------------------------------------------
  // the machine

  /** Feed one input; actions run in order, inputs they cause are queued behind. @param {any} input */
  _step(input) {
    this._queue.push(input);
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._queue.length) {
        const next = this._queue.shift();
        let actions = [];
        try {
          actions = this.machine.step(next);
        } catch (err) {
          console.error('[wake] the state machine failed', err);
        }
        for (const a of actions) {
          try {
            this._run(a);
          } catch (err) {
            console.error(`[wake] action ${a.type} failed`, err);
          }
        }
        this._afterStep();
      }
    } finally {
      this._draining = false;
    }
    this._schedule();
    // a state change shows at once (body[data-wake], the chip); the rest is batched
    if (this._renderNow) {
      this._renderNow = false;
      this._render();
    }
  }

  /** @param {any} a */
  _run(a) {
    switch (a.type) {
      case 'openMic': return this._openMic(a);
      case 'releaseMic': return this._releaseMic();
      case 'capture': return this._capture(a);
      case 'cancelCapture':
        if (this.ctl.listen?.wake?.wakeId === a.meta?.wakeId) this.ctl.wakeWordCancel();
        return undefined;
      case 'show': return this.ctl.wakeWordShow();
      case 'verify': return this._verify(a);
      case 'resetDetector': return this.port.reset();
      case 'earcon': return this._earcon(a.name);
      case 'duck': return this.player.duck(WAKE.duckDb, WAKE.duckRampMs);
      case 'unduck': return this.player.unduck(a.rampMs ?? WAKE.unduckMs, a.afterMs || 0);
      case 'stopSpeaking':
        this.mask.allEnded();
        this.ctl.stopSpeaking();
        return undefined;
      case 'quiet': return this.ctl.wakeWordQuiet();
      case 'showWindow':
        if (this.hidden) this.bridge.window?.show?.();
        return undefined;
      case 'gaze': return this._gaze();
      case 'fastWake': return this._fastWake();
      case 'setStrict':
        this.port.strict(a.on);
        return undefined;
      case 'dim': return this.view.setDim?.(!!a.on);
      case 'decision': return this._resolve(a.id, a.decision);
      case 'disable': return this.d.saveWake({ enabled: false });
      case 'say': return this._say(a);
      case 'hint': return this.view.hint?.(a.text);
      case 'announce': return this.view.announce?.(a.text);
      case 'report': return this._report(a);
      case 'noteActivity':
        this._dozedAtHit = null; // a real wake: she stays awake
        return this.ctl.noteActivity();
      case 'rejected':
        // the hit woke her from a doze, but it was not a call: back to sleep once idle again
        if (this._dozedAtHit != null && String(this._dozedAtHit) === String(a.id)) {
          this._dozedAtHit = null;
          queueMicrotask(() => this.ctl.sleep?.());
        }
        return undefined;
      default: return undefined;
    }
  }

  _afterStep() {
    this._syncRunning();
    // a verification that no longer matters (rejected, timed out, the wake ended) is aborted
    const a = this.machine.active;
    for (const [id, j] of this._verifies) {
      if (!a || a.id !== id || a.verdict !== 'pending') {
        j.abort.abort();
        this._verifies.delete(id);
      }
    }
    this._renderSoon();
  }

  /**
   * Wake mode started or stopped running (locked, paused, the engine went away…): the controller's
   * hands-free follows at once, so the transcript check never goes on as plain hands-free while
   * the PC is locked, and a microphone nobody uses any more is released now (§2.3, §2.4).
   */
  _syncRunning() {
    const m = this.machine;
    const key = `${m.running ? 1 : 0}${m.fallback ? 1 : 0}`;
    if (key === this._runKey) return;
    this._runKey = key;
    if (!this._started) return;
    try { this.ctl.wakeWordChanged(); } catch (err) { console.warn('[wake] the controller hook failed', err); }
    const st = m.state;
    if (this._settings?.wake?.enabled && !m.running && st !== 'off' && !this.mic.mode && !this.mic.tapped && this.mic.isOpen) this.mic.close();
  }

  _schedule() {
    clearTimeout(this._timer);
    const t = this.machine.nextDeadline();
    if (!Number.isFinite(t)) return;
    this._timer = /** @type {any} */ (setTimeout(() => this._step({ type: 'tick' }), Math.max(10, t - this._now() + 1)));
  }

  /** What the controller is doing (for the machine). @param {string} [s] */
  _conv(s) {
    const c = this.ctl;
    const kind = this.player.kind ?? (this.d.services.tts?.mode?.() === 'server' ? 'audio' : 'speech');
    return {
      state: s ?? c.state,
      speaking: !!this.speech.busy,
      kind,
      turnRunning: !!c.activeTurnId || c.pendingSends > 0 || !!c.claudeStatus?.busy,
    };
  }

  // ------------------------------------------------------------------------------------------
  // actions

  /** @param {{ echo?: string }} a */
  _openMic(a) {
    const gen = ++this._micGen;
    this.mic.setEchoMode(a.echo === 'all' ? 'all' : 'app');
    this.mic.setTap(this._onTap);
    this.mic.open().then(() => {
      if (gen !== this._micGen) {
        // released while it opened
        if (!this.mic.tapped && !this.mic.mode) this.mic.close();
        return;
      }
      this._step({ type: 'micOk', label: this.mic.trackLabel, echo: this.mic.echoCancellation, muted: this.mic.muted });
    }, async (err) => {
      if (gen !== this._micGen) return;
      const { reason, message } = await this._classify(err);
      if (gen !== this._micGen) return;
      this._step({ type: 'micError', reason, message });
    });
  }

  /** @param {any} err @returns {Promise<{ reason: string, message: string }>} */
  async _classify(err) {
    const name = err?.name || '';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return { reason: 'no-device', message: 'No microphone was found' };
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotReadableError' || name === 'AbortError') {
      // Windows' privacy switch looks like "in use" to Chromium (ux.md WIN-1): ask main
      let access = 'unknown';
      try {
        access = String((await this.bridge.wake?.micAccess?.()) || 'unknown');
      } catch { /* unknown */ }
      if (access === 'denied' || access === 'restricted') return { reason: 'os-blocked', message: 'Windows is blocking the microphone for desktop apps' };
      if (name === 'NotAllowedError' || name === 'SecurityError') return { reason: 'denied', message: 'Microphone access was denied' };
      // whether Windows reports its privacy switch to an unpackaged app is not certain: say both
      return { reason: 'in-use', message: this._windows() ? 'The microphone could not be started: it may be in use by another app, or blocked in Windows privacy settings' : 'The microphone could not be started (it may be in use by another app)' };
    }
    return { reason: 'other', message: String(err?.message || 'The microphone could not be started') };
  }

  _releaseMic() {
    ++this._micGen;
    // a wake capture that still runs ends first: otherwise the Mic sees no tap when it finishes
    // and keeps the device for its 20 s idle time (PRIV-5, PRIV-6: within 1 s)
    if (this.ctl.listen?.wake) this.ctl.wakeWordCancel();
    // a test clip never goes on across a release (it would splice two sessions together)
    this._recAbort('The test clip was cancelled: the microphone was turned off.');
    this.mic.setTap(null);
    // closed now unless push-to-talk (or another capture of the controller) is using it
    if (!this.mic.mode) this.mic.close();
    this.clock.clear();
    this._zeroRun = 0;
  }

  /** @param {{ kind: string, fromSample?: number, noSpeechMs: number, show: boolean, meta: any }} a */
  _capture(a) {
    this.ctl.wakeWordCapture({ kind: /** @type {any} */ (a.kind), fromSample: a.fromSample, noSpeechMs: a.noSpeechMs, show: a.show, meta: a.meta })
      .then((ok) => {
        if (!ok) this._step({ type: 'captureCancelled', meta: a.meta });
      });
  }

  /** @param {{ id: string, from: number, to: number, keyword: string }} a */
  _verify(a) {
    const job = { id: String(a.id), from: a.from, to: a.to, keyword: a.keyword, abort: new AbortController(), started: false };
    this._verifies.set(job.id, job);
    this._tryVerify(job);
  }

  /** The wake segment is in the ring: transcribe it and apply the veto. */
  _tryVerify(job) {
    if (job.started || this.mic.samplesSeen < job.to) return;
    job.started = true;
    // a hit that arrived late (a busy PC): check what the ring still holds of the segment
    const from = Math.max(job.from, Number(this.mic.ringStart) || 0);
    const pcm = job.to - from >= Math.round((WAKE.segMinMs / 1000) * RATE) ? this.mic.ring(from, job.to) : null;
    if (!pcm) {
      this._step({ type: 'verified', id: job.id, ok: false, reason: 'lost' });
      return;
    }
    const wav = encodeWav(pcm, RATE);
    const sens = this._settings?.wake?.sensitivity;
    Promise.resolve()
      .then(() => this.d.services.stt.transcribe(wav, { signal: job.abort.signal }))
      .then((r) => {
        if (job.abort.signal.aborted) return;
        const text = String(r?.text || '');
        let v = veto(text, sens === 'high' ? 'jude' : 'full');
        if (v.ok && this.mask.echo(text)) v = { ok: false, reason: /** @type {any} */ ('echo') };
        const end = this._hitEnd.get(job.id);
        const latencyMs = end != null ? this._now() - end : undefined;
        this._recOutcome(job.id, v.ok ? 'woke' : `ignored: ${/** @type {any} */ (v).reason}`);
        this._step({ type: 'verified', id: job.id, ok: v.ok, reason: v.ok ? undefined : /** @type {any} */ (v).reason, latencyMs });
      }, (err) => {
        if (job.abort.signal.aborted || err?.name === 'AbortError') return;
        this._warn(`[wake] the check failed: ${err?.message || err}`);
        this._step({ type: 'verified', id: job.id, ok: false, reason: 'stt-failed' });
      });
  }

  /** @param {import('./earcons.js').EarconName} name */
  _earcon(name) {
    const rate = this.player.sampleRate || 48000;
    const r = this.player.playCue(earconSamples(name, rate), rate);
    // the earcon (or what is left of it after the echo canceller) is not the user speaking (ACK-7)
    const end = r?.endPerf ?? this._now() + earconDurationMs(name) + 40;
    this.mic.ignoreSpeechStartUntil(end + WAKE.earconVadMaskMs);
  }

  _gaze() {
    if (this.d.reducedMotion?.()) return; // brightness only (A11Y-3)
    if (this.d.camera?.status?.present) return; // eye contact already
    this.d.gaze?.cursor?.([0, 0.05], 1500);
  }

  _fastWake() {
    if (!this._sleepingAtHit) return;
    this._sleepingAtHit = false;
    this.d.getAvatar?.()?.setState?.('listening', { fast: true });
  }

  /** @param {{ text: string, afterIdle?: boolean }} a */
  _say(a) {
    const go = () => {
      if (!this.ctl.say(a.text)) this.view.toast?.(a.text, 'info');
    };
    if (a.afterIdle) setTimeout(go, 400);
    else go();
  }

  /** @param {{ state: string, reason?: string }} a */
  _report(a) {
    this._renderNow = true;
    this.emit('state', a.state);
    const fn = this.bridge.wake?.report;
    if (typeof fn !== 'function') return;
    const payload = { state: a.state, ...(a.reason ? { reason: String(a.reason).slice(0, 120) } : {}) };
    const key = JSON.stringify(payload);
    if (key === this._lastReport) return;
    // at most 4 a second to main (it coalesces the tray to 2)
    this._pendingReport = payload;
    if (this._reportTimer) return;
    const send = () => {
      this._reportTimer = 0;
      const p = this._pendingReport;
      this._pendingReport = null;
      if (!p) return;
      const k = JSON.stringify(p);
      if (k === this._lastReport) return;
      this._lastReport = k;
      try { fn.call(this.bridge.wake, p); } catch { /* ignore */ }
      this._reportTimer = /** @type {any} */ (setTimeout(send, 250));
    };
    send();
  }

  // ------------------------------------------------------------------------------------------
  // the controller's side

  /**
   * A wake capture's transcript (or the transcript check's): the machine decides.
   * @param {string} text @param {any} meta @param {{ speechMs?: number, failed?: boolean }} o
   * @returns {Promise<import('./phrase.js').WakeDecision>}
   */
  _decide(text, meta, o) {
    const m = meta?.kind === 'fallback' ? { ...meta, wakeId: `fb${++this._fb}` } : meta;
    const id = String(m?.wakeId ?? '');
    return new Promise((resolve) => {
      // a decision held for the verdict comes later (the verify timeout bounds that); never hang,
      // and never leave the machine's episode waiting either
      const safety = setTimeout(() => {
        this._resolve(id, { action: 'drop', reason: 'timeout' });
        if (m?.kind !== 'fallback') this._step({ type: 'captureCancelled', meta: m });
      }, WAKE.verifyTimeoutMs.cpu + 4000);
      this._decisions.set(id, (/** @type {any} */ d) => {
        clearTimeout(safety);
        resolve(d);
      });
      this._step({ type: 'utterance', meta: m, text, speechMs: o.speechMs || 0, failed: !!o.failed, echo: !!text && this.mask.echo(text) });
    });
  }

  /** @param {any} id @param {any} decision */
  _resolve(id, decision) {
    const r = this._decisions.get(String(id));
    if (!r) return;
    this._decisions.delete(String(id));
    r(decision);
  }

  _presence() {
    const cam = this.d.camera;
    const st = cam?.status || {};
    const on = !!cam && st.state === 'on' && st.tracking === 'on';
    const p = { camera: on, present: on && !!st.present, looking: on && !!st.looking };
    const key = JSON.stringify(p);
    if (key === this._presenceKey) return;
    this._presenceKey = key;
    this._step({ type: 'presence', ...p });
  }

  /** The one-time offer card: the first time the local voice is ready (§9.6). */
  _maybeOffer() {
    if (this._offered) return;
    const s = this._settings;
    if (!s || s.wake?.explained || s.wake?.enabled) return;
    if (!this.d.services.stt.available()) return;
    this._offered = true;
    this.view.showOffer?.({
      onTurnOn: () => this.d.saveWake({ enabled: true, explained: true }),
      onNotNow: () => this.d.saveWake({ explained: true }),
    });
  }

  // ------------------------------------------------------------------------------------------
  // Test my echo, Record a test clip

  /** She says a line made to wake her; the stage-1 hits are counted, the mask is off for it. */
  echoTest() {
    if (this._echoTest) return false;
    if (this.machine.state !== 'waiting') {
      this.view.toast?.('“Test my echo” works while she is listening for her name and nothing else is going on.', 'info');
      return false;
    }
    // the test needs her voice: with "Speak replies" off (or no voice) nothing would ever play
    if (!this._canSpeak()) {
      this.view.toast?.(ECHO_TEST_NO_VOICE, 'info');
      return false;
    }
    this.mask.exempt(ECHO_TEST_LINE);
    const t = { hits: 0, timer: /** @type {any} */ (0), cap: /** @type {any} */ (0), off: /** @type {() => void} */ (() => {}), done: false };
    this._echoTest = t;
    const end = (/** @type {string} */ result, /** @type {'success'|'warn'|'info'} */ tone) => {
      if (t.done) return;
      t.done = true;
      clearTimeout(t.timer);
      clearTimeout(t.cap);
      t.off();
      if (this._echoTest === t) this._echoTest = null;
      this.mask.unexempt(ECHO_TEST_LINE);
      if (result) {
        this.echoResult = result;
        this.view.toast?.(result, tone);
      }
      this._renderSoon();
    };
    if (!this.ctl.say(ECHO_TEST_LINE)) {
      end('', 'info');
      this.view.toast?.('Busy: try “Test my echo” once she is quiet.', 'info');
      return false;
    }
    if (!this.speech.busy) {
      // said in the chat but not spoken (the voice went away meanwhile): no test
      end('', 'info');
      this.view.toast?.(ECHO_TEST_NO_VOICE, 'info');
      return false;
    }
    this._renderSoon();
    const report = () => end(t.hits === 0 ? WAKE_TEXT.echoGood : WAKE_TEXT.echoBad(t.hits), t.hits === 0 ? 'success' : 'warn');
    t.off = this.speech.on('idle', () => {
      t.off();
      // her voice has ended: the tail for a late hit, then the result
      t.timer = setTimeout(report, 1200);
    });
    // whatever happens, the test (and the mask's exemption) ends
    t.cap = setTimeout(() => (t.hits ? report() : end('The echo test did not finish; try it again.', 'info')), ECHO_TEST_MAX_MS);
    return true;
  }

  /** @returns {boolean} the app runs on Windows */
  _windows() {
    if (typeof this.d.platform === 'string') return this.d.platform === 'win32';
    return /win/i.test(String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ''));
  }

  /** Her replies are spoken (the echo test needs her voice). */
  _canSpeak() {
    const tts = this.d.services.tts;
    const avail = typeof tts?.available === 'function' ? !!tts.available() : true;
    return this._settings?.voice?.speakReplies !== false && avail;
  }

  /** Record `sec` seconds of the tapped audio and the hits in it, then save them on this PC. */
  recordClip(sec = 30) {
    if (this._rec) return false;
    if (this.machine.state !== 'waiting' && this.machine.state !== 'busy') {
      this.view.toast?.('“Record a test clip” works while she is listening for her name.', 'info');
      return false;
    }
    const max = Math.round(Math.min(60, Math.max(1, sec)) * RATE);
    this._rec = { chunks: [], n: 0, max, startAt: this.mic.samplesSeen, next: this.mic.samplesSeen, hits: [], timer: setInterval(() => this._renderSoon(), 1000), done: false };
    this._renderSoon();
    return true;
  }

  /** "Cancel recording" (the drawer): nothing is saved. @returns {boolean} */
  cancelRecording() {
    if (!this._rec) return false;
    this._recAbort('The test clip was cancelled; nothing was saved.');
    return true;
  }

  /** Drop the test clip being recorded: nothing is saved. @param {string} why the toast ('' = none) */
  _recAbort(why) {
    const r = this._rec;
    if (!r || r.done) return;
    r.done = true;
    clearInterval(r.timer);
    r.chunks = [];
    this._rec = null;
    if (why) this.view.toast?.(why, 'info');
    this._renderSoon();
  }

  /** @param {Float32Array} x @param {number} [at] the sample index of x[0] */
  _recPush(x, at) {
    const r = /** @type {NonNullable<WakeFeature['_rec']>} */ (this._rec);
    // a gap (the mic reopened, a paused tap): the clip must be one piece of audio
    if (Number.isFinite(at) && at !== r.next) {
      this._recAbort('The test clip was cancelled: the microphone was interrupted.');
      return;
    }
    r.next += x.length;
    const take = Math.min(x.length, r.max - r.n);
    if (take > 0) {
      r.chunks.push(x.slice(0, take));
      r.n += take;
    }
    if (r.n >= r.max) this._recFinish();
  }

  _recFinish() {
    const r = this._rec;
    if (!r || r.done) return;
    r.done = true;
    clearInterval(r.timer);
    const all = new Float32Array(r.n);
    let o = 0;
    for (const c of r.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const wav = encodeWav(all, RATE);
    const hits = r.hits.slice(0, 200).map((h) => ({ atSec: Math.round(h.atSec * 100) / 100, keyword: h.keyword, outcome: h.outcome }));
    this._rec = null;
    this._renderSoon();
    const save = this.bridge.wake?.saveClip;
    if (typeof save !== 'function') return;
    Promise.resolve()
      .then(() => save.call(this.bridge.wake, { wav, hits }))
      .then((res) => {
        if (res?.ok) this.view.toast?.(`Saved the test clip${res.path ? `: ${res.path}` : ''}`, 'success');
        else this.view.toast?.(`The test clip could not be saved${res?.error ? `: ${res.error}` : ''}`, 'warn');
      }, (err) => this.view.toast?.(`The test clip could not be saved: ${err?.message || err}`, 'warn'));
  }

  /** @param {string} id @param {string} outcome */
  _recOutcome(id, outcome) {
    const h = this._rec?.hits.find((x) => x.id === id);
    if (h) h.outcome = outcome;
  }

  // ------------------------------------------------------------------------------------------
  // the view

  _renderSoon() {
    if (this._renderTimer) return;
    this._renderTimer = /** @type {any} */ (setTimeout(() => {
      this._renderTimer = 0;
      this._render();
    }, 50));
  }

  _render() {
    const m = this.machine;
    this.view.render?.({
      state: m.state,
      reason: m.reason,
      code: m.code,
      strict: m.strict,
      fallback: m.fallback,
      echo: m.echo,
      models: this.engine.models || {},
      log: m.log,
      recordingSec: this._rec ? this._rec.n / RATE : null,
      echoResult: this.echoResult,
      echoTesting: !!this._echoTest,
      canSpeak: this._canSpeak(),
      engine: String(this.engine.engine || ''),
      windows: this._windows(),
      nowPerf: this._now(),
      nowWall: Date.now(),
    });
  }

  /** @param {string} msg */
  _warn(msg) {
    const now = this._now();
    if (this._lastWarn && now - this._lastWarn < 5000) return;
    this._lastWarn = now;
    console.warn(msg);
  }
}
