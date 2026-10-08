// Camera capture: opens the chosen webcam (getUserMedia, video only, ~640×480) into a hidden,
// muted <video> element that the face tracker and snapshots read from; lists cameras for the
// settings drawer; turns getUserMedia failures into a card that says what to do (on Windows the
// usual culprits are the privacy switch for desktop apps and another app holding the camera).
//
// Events: 'ended' (the track stopped by itself: unplugged, taken over, sleep), 'device-fallback'
// (the saved camera is gone, the default one is used instead).

import { Emitter } from '../app/emitter.js';

/** @param {string} deviceId '' = the system default */
export function cameraConstraints(deviceId) {
  /** @type {MediaTrackConstraints} */
  const video = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  return { audio: false, video };
}

export class CameraCapture extends Emitter {
  /** @param {{ mediaDevices?: MediaDevices, doc?: Document, startTimeoutMs?: number }} [o] */
  constructor(o = {}) {
    super();
    this._md = o.mediaDevices || globalThis.navigator?.mediaDevices;
    this._doc = o.doc || globalThis.document;
    this._startTimeoutMs = o.startTimeoutMs ?? 10_000;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    this.deviceId = '';
    this.label = '';
    this._gen = 0;
  }

  get supported() {
    return !!this._md && typeof this._md.getUserMedia === 'function';
  }

  get running() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /**
   * Open the camera (stops a running one first). Resolves once frames arrive.
   * @param {string} [deviceId] '' = default; a camera that is gone falls back to the default
   */
  async start(deviceId = '') {
    this.stop();
    if (!this.supported) throw Object.assign(new Error('This window cannot use a camera'), { name: 'NotSupportedError' });
    const gen = ++this._gen;
    let stream;
    try {
      stream = await this._md.getUserMedia(cameraConstraints(deviceId));
    } catch (err) {
      const name = /** @type {any} */ (err)?.name;
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err;
      // the saved camera was unplugged or renamed: use the default one
      stream = await this._md.getUserMedia(cameraConstraints(''));
      this.emit('device-fallback', deviceId);
    }
    if (gen !== this._gen) {
      for (const t of stream.getTracks()) t.stop();
      throw Object.assign(new Error('The camera was stopped'), { name: 'AbortError', superseded: true });
    }
    const track = stream.getVideoTracks()[0];
    this.stream = stream;
    this.deviceId = track?.getSettings?.().deviceId || deviceId || '';
    this.label = track?.label || '';
    track?.addEventListener('ended', () => {
      if (gen === this._gen) this.emit('ended');
    });
    const v = /** @type {HTMLVideoElement} */ (this._doc.createElement('video'));
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.className = 'camera-feed';
    v.srcObject = stream;
    this.video = v;
    await Promise.race([
      v.play(),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The camera sends no picture'), { name: 'NoFramesError' })), this._startTimeoutMs)),
    ]).catch((err) => {
      if (gen === this._gen) this.stop();
      throw err;
    });
    return stream;
  }

  stop() {
    this._gen++;
    for (const t of this.stream?.getTracks() || []) {
      try { t.stop(); } catch { /* ignore */ }
    }
    this.stream = null;
    if (this.video) {
      try { this.video.pause(); } catch { /* ignore */ }
      this.video.srcObject = null;
    }
    this.video = null;
  }
}

/**
 * The cameras for the device picker. Labels are only known once the camera has been allowed
 * (before that: "Camera 1", …).
 * @param {MediaDevices} [md]
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function listCameras(md = globalThis.navigator?.mediaDevices) {
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  let devices = [];
  try {
    devices = await md.enumerateDevices();
  } catch {
    return [];
  }
  const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default');
  return cams.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/**
 * @typedef {object} CameraErrorModel
 * @property {'denied'|'busy'|'none'|'frames'|'unsupported'|'unknown'} kind
 * @property {string} title
 * @property {string} intro
 * @property {string[]} steps
 * @property {string} [detail]   the browser's own message
 */

/**
 * What went wrong when opening the camera, and what to do about it.
 * @param {any} err a getUserMedia rejection (DOMException) or our own error
 * @param {string} [platform] process.platform of the app
 * @returns {CameraErrorModel}
 */
export function describeCameraError(err, platform = 'win32') {
  const name = String(err?.name || '');
  const detail = String(err?.message || '').slice(0, 300) || undefined;
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return {
      kind: 'denied',
      title: 'The camera is blocked',
      intro: win
        ? 'Windows did not let Lawnmower Man use the camera.'
        : 'The system did not let Lawnmower Man use the camera.',
      steps: win
        ? [
            'Open Windows Settings: Privacy & security › Camera.',
            'Turn on "Camera access" and "Let desktop apps access your camera" (Lawnmower Man is a desktop app, so it is not listed by name).',
            'Some laptops also have a camera key (often F8 or F10) or a privacy shutter: make sure the camera is on.',
            'Then press Try again.',
          ]
        : mac
          ? ['Open System Settings: Privacy & Security › Camera and allow Lawnmower Man.', 'Then press Try again (macOS may need the app restarted).']
          : ['Check that no privacy setting or switch blocks the camera, and that your user may open /dev/video*.', 'Then press Try again.'],
      detail,
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      kind: 'busy',
      title: 'The camera is in use or could not start',
      intro: 'Another app is probably using the camera right now.',
      steps: [
        win ? 'Close apps that use the camera (Teams, Zoom, Skype, the Camera app, a browser tab with a video call…).' : 'Close apps that use the camera (video calls, a browser tab with a video call…).',
        'If no other app uses it, unplug and reconnect an external camera, or restart the computer.',
        'Then press Try again.',
      ],
      detail,
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      kind: 'none',
      title: 'No camera found',
      intro: 'Lawnmower Man could not find a camera on this computer.',
      steps: [
        'Connect a webcam, or switch the built-in one on (some laptops have a camera key or a shutter).',
        win ? 'In Device Manager, check that the camera is not disabled.' : 'Check that the camera is connected and recognised by the system.',
        'Then press Try again.',
      ],
      detail,
    };
  }
  if (name === 'NoFramesError') {
    return {
      kind: 'frames',
      title: 'The camera sends no picture',
      intro: 'The camera opened, but no picture arrived.',
      steps: ['Open the privacy shutter or press the camera key if your laptop has one.', 'Close other apps that use the camera, then press Try again.'],
      detail,
    };
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return { kind: 'unsupported', title: 'No camera support here', intro: 'This window cannot use a camera.', steps: ['Use the desktop app (the browser preview needs http://127.0.0.1 or localhost).'], detail };
  }
  return { kind: 'unknown', title: 'The camera could not start', intro: 'Something went wrong while opening the camera.', steps: ['Press Try again. If it keeps failing, restart the app and check the logs (tray › Open logs folder).'], detail };
}
