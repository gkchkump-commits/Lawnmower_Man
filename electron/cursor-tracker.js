// Global cursor follow: while the avatar window is visible, poll the OS cursor position (~30 Hz)
// and report it to the renderer in the window's content coordinates (CSS px, relative to the
// window's top-left corner; it may lie outside the window). Nothing is sent while the position
// relative to the window is unchanged, so an idle mouse costs one cheap poll per tick.
//
// Pure (no Electron import): the caller injects the cursor/bounds getters, so it is unit-tested
// with fakes.

/**
 * @typedef {object} CursorTrackerOptions
 * @property {() => { x: number, y: number }} getPoint            screen.getCursorScreenPoint()
 * @property {() => ({ x: number, y: number }|null)} getOrigin      window content origin in screen DIP (null = no window)
 * @property {() => boolean} isActive                               window exists, is visible and not minimized
 * @property {(p: { x: number, y: number }) => void} send           deliver to the renderer
 * @property {number} [intervalMs]                                  default 33 (~30 Hz)
 * @property {(fn: () => void, ms: number) => any} [setInterval]
 * @property {(id: any) => void} [clearInterval]
 */

export const CURSOR_POLL_MS = 33;

export class CursorTracker {
  /** @param {CursorTrackerOptions} o */
  constructor(o) {
    this._getPoint = o.getPoint;
    this._getOrigin = o.getOrigin;
    this._isActive = o.isActive;
    this._send = o.send;
    this.intervalMs = o.intervalMs ?? CURSOR_POLL_MS;
    this._setInterval = o.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = o.clearInterval || ((id) => clearInterval(id));
    /** @type {any} */
    this._timer = null;
    /** @type {{ x: number, y: number }|null} */
    this._last = null;
  }

  get running() {
    return this._timer !== null;
  }

  /** Start polling (idempotent). */
  start() {
    if (this._timer !== null) return;
    this._timer = this._setInterval(() => this.poll(), this.intervalMs);
    this._timer?.unref?.();
  }

  /** Stop polling; the next start() re-sends the current position. */
  stop() {
    if (this._timer !== null) this._clearInterval(this._timer);
    this._timer = null;
    this._last = null;
  }

  /** Forget the last sent position (e.g. after a renderer reload) so the next poll re-sends it. */
  reset() {
    this._last = null;
  }

  /**
   * Poll once. Returns the position sent, or null when nothing was sent.
   * @returns {{ x: number, y: number }|null}
   */
  poll() {
    let p;
    let origin;
    try {
      if (!this._isActive()) return null;
      p = this._getPoint();
      origin = this._getOrigin();
    } catch {
      return null; // window destroyed mid-poll, display change, …
    }
    if (!p || !origin || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
    const pos = { x: Math.round(p.x - origin.x), y: Math.round(p.y - origin.y) };
    if (this._last && this._last.x === pos.x && this._last.y === pos.y) return null;
    this._last = pos;
    try {
      this._send(pos);
    } catch {
      /* the renderer is gone; the next poll tries again */
    }
    return pos;
  }
}
