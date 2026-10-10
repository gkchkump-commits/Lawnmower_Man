// Moving the avatar window by its head (and by the chat status bar / settings header).
//
// The main process does the moving: on a primary-button press over the head the renderer calls
// bridge.window.dragStart(); main then follows the global cursor until dragEnd(). This replaces
// CSS drag regions (-webkit-app-region), which on Windows fight the click-through gate: entering
// a drag region reads as the pointer leaving the page, the gate makes the window click-through,
// and the press lands on the desktop instead — the avatar looked "locked in place".
//
// Resizing works the same way: a press on a corner grip calls bridge.window.resizeStart(corner)
// and main resizes from that corner (the opposite one stays put) until resizeEnd().
//
// Pure state machine (no DOM): src/main.js feeds it pointer events; it holds the click-through
// gate interactive while a press lasts, so the release always reaches the renderer.

export class WindowDrag {
  /**
   * @param {object} deps
   * @param {{ dragStart?: () => void, dragEnd?: () => void, resizeStart?: (corner: string) => void, resizeEnd?: () => void }} deps.win  bridge.window
   * @param {() => boolean} deps.isLocked     settings.window.lockPosition (locks the size too)
   * @param {{ hold: (key: string, on: boolean) => void }} [deps.gate]  click-through gate
   * @param {(active: boolean, mode: 'drag'|'resize'|null, corner: Corner|null) => void} [deps.onChange]
   */
  constructor(deps) {
    this._win = deps.win;
    this._isLocked = deps.isLocked;
    this._gate = deps.gate;
    this._onChange = deps.onChange || (() => {});
    /** Pointer id of the press being tracked (null = no drag). */
    this.pointerId = /** @type {number|null} */ (null);
    /** What the press does: move the window or resize it from `corner`. */
    this.mode = /** @type {'drag'|'resize'|null} */ (null);
    this.corner = /** @type {Corner|null} */ (null);
  }

  /** The bridge can move the window (an older main process or the browser mock may not). */
  get supported() {
    return typeof this._win?.dragStart === 'function' && typeof this._win?.dragEnd === 'function';
  }

  /** The bridge can resize the window by a corner. */
  get resizeSupported() {
    return typeof this._win?.resizeStart === 'function' && typeof this._win?.resizeEnd === 'function';
  }

  get active() {
    return this.pointerId !== null;
  }

  /**
   * A press somewhere that may start a drag or a resize.
   * @param {{ button: number, pointerId: number, pointerType?: string }} e
   * @param {boolean|Corner} handle  true: on the head / a drag handle (not on a control);
   *   a corner: on that resize grip; false: neither
   * @returns {boolean} true when a drag or resize started (the caller should capture the pointer)
   */
  press(e, handle) {
    if (!handle || e.button !== 0 || this._isLocked()) return false;
    const corner = typeof handle === 'string' && CORNERS.includes(/** @type {Corner} */ (handle)) ? /** @type {Corner} */ (handle) : null;
    if (typeof handle === 'string' && !corner) return false;
    if (corner ? !this.resizeSupported : !this.supported) return false;
    if (this.active) this.release();
    this.pointerId = e.pointerId;
    this.mode = corner ? 'resize' : 'drag';
    this.corner = corner;
    this._gate?.hold('drag', true);
    try {
      if (corner) this._win.resizeStart?.(corner);
      else this._win.dragStart?.();
    } catch (err) {
      console.warn(`[drag] ${corner ? 'resizeStart' : 'dragStart'} failed`, err);
    }
    this._onChange(true, this.mode, corner);
    return true;
  }

  /**
   * The press ended (pointerup / pointercancel / lostpointercapture for this pointer, or the
   * window lost focus). Safe to call any number of times.
   * @param {{ pointerId?: number }} [e] omit to end whatever drag is active
   */
  release(e) {
    if (!this.active) return;
    if (e && e.pointerId !== undefined && e.pointerId !== this.pointerId) return;
    const mode = this.mode;
    this.pointerId = null;
    this.mode = null;
    this.corner = null;
    try {
      if (mode === 'resize') this._win.resizeEnd?.();
      else this._win.dragEnd?.();
    } catch (err) {
      console.warn(`[drag] ${mode === 'resize' ? 'resizeEnd' : 'dragEnd'} failed`, err);
    }
    this._gate?.hold('drag', false);
    this._onChange(false, null, null);
  }
}

/** @typedef {'tl'|'tr'|'bl'|'br'} Corner */
export const CORNERS = /** @type {readonly Corner[]} */ (['tl', 'tr', 'bl', 'br']);

/** Free avatar widths (settings.window.avatarWidth; electron/window-manager.js). */
export const MIN_AVATAR_WIDTH = 200;
export const MAX_AVATAR_WIDTH = 1200;
/** Avatar width of each size preset (the free width a preset window starts resizing from). */
export const PRESET_WIDTHS = Object.freeze({ small: 300, medium: 400, large: 560 });
/** One wheel step grows or shrinks the avatar by this factor. */
const WHEEL_STEP = 1.08;

/**
 * Next free avatar width for a Ctrl + wheel step (deltaY < 0 = wheel up = bigger), even and
 * within MIN/MAX_AVATAR_WIDTH, or null when it would not change.
 * @param {number} current  the avatar's width now (window.innerWidth) @param {number} deltaY
 * @returns {number|null}
 */
export function nextAvatarWidth(current, deltaY) {
  if (!Number.isFinite(deltaY) || deltaY === 0 || !Number.isFinite(current) || current <= 0) return null;
  const raw = deltaY < 0 ? current * WHEEL_STEP : current / WHEEL_STEP;
  const w = Math.round(Math.min(MAX_AVATAR_WIDTH, Math.max(MIN_AVATAR_WIDTH, raw)) / 2) * 2;
  return w === Math.round(current / 2) * 2 ? null : w;
}
