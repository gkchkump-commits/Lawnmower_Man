// Electron stand-ins for the camera window and createTapo() tests: BrowserWindow (with the
// events CameraWindow listens to), ipcMain (handlers called like Electron calls them), and a
// Notification class that records what it showed.

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/** A BrowserWindow stand-in with the bits CameraWindow uses. */
export class FakeBrowserWindow extends EventEmitter {
  /** @type {FakeBrowserWindow[]} */
  static all = [];
  constructor(opts) {
    super();
    FakeBrowserWindow.all.push(this);
    this.opts = opts;
    this.bounds = { x: opts.x ?? 100, y: opts.y ?? 100, width: opts.width, height: opts.height };
    this.shown = false;
    this.minimized = false;
    this.destroyed = false;
    this.centered = false;
    this.loads = [];
    this.title = opts.title;
    this.onTop = opts.alwaysOnTop;
    this.focused = 0;
    this.webContents = Object.assign(new EventEmitter(), { reload: vi.fn(), toggleDevTools: vi.fn(), isDestroyed: () => this.destroyed, send: vi.fn(), postMessage: vi.fn() });
  }
  center() { this.centered = true; }
  setMenuBarVisibility() {}
  loadURL(u) { this.loads.push(u); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.shown; }
  isMinimized() { return this.minimized; }
  isMaximized() { return false; }
  show() { this.shown = true; this.emit('show'); }
  showInactive() { this.shown = true; this.emit('show'); }
  focus() { this.focused++; }
  restore() { this.minimized = false; this.emit('restore'); }
  minimize() { this.minimized = true; this.emit('minimize'); }
  hide() { this.shown = false; this.emit('hide'); }
  getBounds() { return { ...this.bounds }; }
  setTitle(t) { this.title = t; }
  setAlwaysOnTop(on) { this.onTop = on; }
  /** what the user's close button does */
  userClose() {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', e);
    if (!e.defaultPrevented) this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}


/** ipcMain stand-in: `invoke(channel, event, ...args)` runs a handler like Electron does. */
export function fakeIpcMain() {
  const m = /** @type {any} */ (new EventEmitter());
  m.handlers = new Map();
  m.handle = (/** @type {string} */ ch, /** @type {Function} */ fn) => {
    if (m.handlers.has(ch)) throw new Error(`second handler for ${ch}`);
    m.handlers.set(ch, fn);
  };
  m.removeHandler = (/** @type {string} */ ch) => m.handlers.delete(ch);
  m.invoke = (/** @type {string} */ ch, /** @type {any} */ event, /** @type {any[]} */ ...args) => m.handlers.get(ch)(event, ...args);
  return m;
}

/** Electron's Notification, recording each instance. */
export class FakeNotification extends EventEmitter {
  /** @type {FakeNotification[]} */
  static shown = [];
  static isSupported() {
    return true;
  }
  /** @param {any} opts */
  constructor(opts) {
    super();
    this.opts = opts;
  }
  show() {
    FakeNotification.shown.push(this);
  }
}
