// The "Home camera" window (contract §7): a normal framed window with the live view, controls,
// events and setup (src/tapo/, lane B). It stays alive while hidden — the security worker
// (decoding and detection) lives in it. Electron's BrowserWindow is injected.

import { EventEmitter } from 'node:events';

export const DEFAULT_SIZE = Object.freeze({ width: 960, height: 600 });
export const MIN_SIZE = Object.freeze({ width: 480, height: 320 });
const CRASH_WINDOW_MS = 10 * 60 * 1000;

/** @param {string|null|undefined} devServerUrl */
export function cameraWindowUrl(devServerUrl) {
  return devServerUrl ? `${devServerUrl}tapo/index.html` : 'app://lawnmower/tapo/index.html';
}

/** "Home camera — front door camera". @param {string} name */
export function cameraWindowTitle(name) {
  return `Home camera — ${String(name || 'camera').trim() || 'camera'}`;
}

/**
 * Saved bounds when they are still on a display (at least 100×60 px of the window visible),
 * else null (centered default).
 * @param {{ x: number, y: number, width: number, height: number }|null|undefined} b
 * @param {Array<{ workArea: { x: number, y: number, width: number, height: number } }>} displays
 */
export function usableBounds(b, displays) {
  if (!b) return null;
  const w = Math.max(MIN_SIZE.width, b.width);
  const h = Math.max(MIN_SIZE.height, b.height);
  const visible = displays.some(({ workArea: a }) => {
    const ix = Math.min(b.x + w, a.x + a.width) - Math.max(b.x, a.x);
    const iy = Math.min(b.y + h, a.y + a.height) - Math.max(b.y, a.y);
    return ix >= 100 && iy >= 60;
  });
  return visible ? { x: b.x, y: b.y, width: w, height: h } : null;
}

/**
 * @typedef {object} CameraWindowOptions
 * @property {any} BrowserWindow
 * @property {string} preload
 * @property {string} url
 * @property {{ x: number, y: number, width: number, height: number }|null} [bounds]
 * @property {boolean} [onTop]
 * @property {string} [title]
 * @property {boolean} [devTools]
 * @property {any} [icon]
 * @property {any} [screen]                  Electron screen (to check saved bounds)
 * @property {() => boolean} [isQuitting]    closing hides the window unless the app quits
 * @property {(level: string, msg: string) => void} [log]
 */

/**
 * Events: 'visibility' (visible: boolean — shown and not minimized), 'bounds' ({x,y,width,height},
 * debounced 400 ms), 'blur', 'gone' (renderer crashed; reloaded after 1 s, ≤ 3 times in 10 min),
 * 'load' (the page (re)loaded: a new worker will ask for its port).
 */
export class CameraWindow extends EventEmitter {
  /** @param {CameraWindowOptions} o */
  constructor(o) {
    super();
    this._o = o;
    this._log = o.log || (() => {});
    /** @type {number[]} */
    this._crashes = [];
    /** @type {NodeJS.Timeout|null} */
    this._boundsTimer = null;
    this._destroyed = false;
    const displays = o.screen ? o.screen.getAllDisplays() : [];
    const saved = o.screen ? usableBounds(o.bounds, displays) : o.bounds || null;
    const win = new o.BrowserWindow({
      ...(saved || DEFAULT_SIZE),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: o.title || cameraWindowTitle('camera'),
      backgroundColor: '#0b0f14',
      autoHideMenuBar: true,
      alwaysOnTop: !!o.onTop,
      ...(o.icon ? { icon: o.icon } : {}),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: o.preload,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: !!o.devTools,
      },
    });
    this.win = win;
    if (!saved && typeof win.center === 'function') win.center();
    win.setMenuBarVisibility?.(false);

    const visibility = () => this.emit('visibility', this.visible());
    win.on('show', visibility);
    win.on('hide', visibility);
    win.on('minimize', visibility);
    win.on('restore', visibility);
    win.on('blur', () => this.emit('blur'));
    for (const ev of ['move', 'resize']) {
      win.on(ev, () => {
        if (this._boundsTimer) clearTimeout(this._boundsTimer);
        this._boundsTimer = setTimeout(() => {
          this._boundsTimer = null;
          if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized?.()) this.emit('bounds', win.getBounds());
        }, 400);
      });
    }
    win.on('close', (/** @type {any} */ e) => {
      if (this._destroyed || (o.isQuitting && o.isQuitting())) return;
      e.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      this._destroyed = true;
      this.emit('closed');
    });
    const wc = win.webContents;
    wc.on('render-process-gone', (/** @type {any} */ _e, /** @type {any} */ d) => {
      this._log('error', `[tapo] camera window renderer gone: ${d?.reason} (exit ${d?.exitCode})`);
      this.emit('gone', d);
      if (this._destroyed || (o.isQuitting && o.isQuitting()) || d?.reason === 'clean-exit') return;
      const now = Date.now();
      this._crashes = [...this._crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (this._crashes.length > 3) {
        this._log('error', '[tapo] the camera window crashed 4 times in 10 minutes; not reloading it (camera events still count)');
        return;
      }
      setTimeout(() => this.load(), 1000);
    });
    wc.on('did-finish-load', () => this.emit('load'));
    wc.on('did-fail-load', (/** @type {any} */ _e, /** @type {number} */ code, /** @type {string} */ desc, /** @type {string} */ url) => this._log('error', `[tapo] camera window failed to load ${url}: ${desc} (${code})`));
    wc.on('console-message', (/** @type {any} */ e, /** @type {any[]} */ ...rest) => {
      const d = e && typeof e === 'object' && 'message' in e ? e : { level: rest[0], message: rest[1] };
      this._log(d.level === 'error' || d.level === 3 ? 'warn' : 'debug', `[camera-window] ${String(d.message).slice(0, 1000)}`);
    });
    if (o.devTools) {
      wc.on('before-input-event', (/** @type {any} */ event, /** @type {any} */ input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F12') {
          wc.toggleDevTools();
          event.preventDefault();
        } else if (input.key === 'F5' || ((input.control || input.meta) && String(input.key).toLowerCase() === 'r')) {
          wc.reload();
          event.preventDefault();
        }
      });
    }
    this.load();
  }

  load() {
    if (this._destroyed || this.win.isDestroyed()) return;
    this.win.loadURL(this._o.url).catch((/** @type {Error} */ err) => this._log('error', `[tapo] camera window: loadURL failed: ${err.message}`));
  }

  /** Shown and not minimized. */
  visible() {
    return !this._destroyed && !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized();
  }

  /** @param {{ focus?: boolean }} [o] */
  show(o = {}) {
    if (this._destroyed || this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    if (o.focus === false) this.win.showInactive();
    else {
      this.win.show();
      this.win.focus();
    }
  }

  hide() {
    if (!this._destroyed && !this.win.isDestroyed()) this.win.hide();
  }

  /** @param {string} name */
  setTitle(name) {
    if (!this._destroyed && !this.win.isDestroyed()) this.win.setTitle(cameraWindowTitle(name));
  }

  /** @param {boolean} on */
  setOnTop(on) {
    if (!this._destroyed && !this.win.isDestroyed()) this.win.setAlwaysOnTop(!!on);
  }

  /** The window's centre in screen coordinates (DIP). */
  center() {
    const b = this.win.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  get webContents() {
    return this._destroyed || this.win.isDestroyed() ? null : this.win.webContents;
  }

  /** Close for good (the feature was turned off, or the app quits). */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._boundsTimer) clearTimeout(this._boundsTimer);
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/** @param {CameraWindowOptions} o */
export function createCameraWindow(o) {
  return new CameraWindow(o);
}
