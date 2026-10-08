// Moving the avatar window by its head (and by the chat status bar / settings header).
//
// The main process does the moving: on a primary-button press over the head the renderer calls
// bridge.window.dragStart(); main then follows the global cursor until dragEnd(). This replaces
// CSS drag regions (-webkit-app-region), which on Windows fight the click-through gate: entering
// a drag region reads as the pointer leaving the page, the gate makes the window click-through,
// and the press lands on the desktop instead — the avatar looked "locked in place".
//
// Pure state machine (no DOM): src/main.js feeds it pointer events; it holds the click-through
// gate interactive while a press lasts, so the release always reaches the renderer.

export class WindowDrag {
  /**
   * @param {object} deps
   * @param {{ dragStart?: () => void, dragEnd?: () => void }} deps.win  bridge.window
   * @param {() => boolean} deps.isLocked     settings.window.lockPosition
   * @param {{ hold: (key: string, on: boolean) => void }} [deps.gate]  click-through gate
   * @param {(dragging: boolean) => void} [deps.onChange]
   */
  constructor(deps) {
    this._win = deps.win;
    this._isLocked = deps.isLocked;
    this._gate = deps.gate;
    this._onChange = deps.onChange || (() => {});
    /** Pointer id of the press being tracked (null = no drag). */
    this.pointerId = /** @type {number|null} */ (null);
  }

  /** The bridge can move the window (an older main process or the browser mock may not). */
  get supported() {
    return typeof this._win?.dragStart === 'function' && typeof this._win?.dragEnd === 'function';
  }

  get active() {
    return this.pointerId !== null;
  }

  /**
   * A press somewhere that may start a drag.
   * @param {{ button: number, pointerId: number, pointerType?: string }} e
   * @param {boolean} onHandle  the press is on the head / a drag handle (not on a control)
   * @returns {boolean} true when a drag started (the caller should capture the pointer)
   */
  press(e, onHandle) {
    if (!onHandle || e.button !== 0 || !this.supported || this._isLocked()) return false;
    if (this.active) this.release();
    this.pointerId = e.pointerId;
    this._gate?.hold('drag', true);
    try {
      this._win.dragStart?.();
    } catch (err) {
      console.warn('[drag] dragStart failed', err);
    }
    this._onChange(true);
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
    this.pointerId = null;
    try {
      this._win.dragEnd?.();
    } catch (err) {
      console.warn('[drag] dragEnd failed', err);
    }
    this._gate?.hold('drag', false);
    this._onChange(false);
  }
}

/** Size presets in order, for Ctrl + mouse wheel over the head. */
const PRESETS = /** @type {const} */ (['small', 'medium', 'large']);

/**
 * Next size preset for a wheel step (deltaY < 0 = wheel up = bigger), or null at either end.
 * @param {string} current @param {number} deltaY
 * @returns {'small'|'medium'|'large'|null}
 */
export function nextSizePreset(current, deltaY) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  const i = Math.max(0, PRESETS.indexOf(/** @type {any} */ (current)));
  const j = deltaY < 0 ? i + 1 : i - 1;
  return j >= 0 && j < PRESETS.length && j !== i ? PRESETS[j] : null;
}
