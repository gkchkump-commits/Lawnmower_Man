// Click-through gate: decides when the transparent window should let mouse clicks pass to the
// desktop (bridge.window.setIgnoreMouse(true)) and when it must be interactive.
//
// The renderer probes on every pointer move: interactive = pointer over the visible avatar
// (avatar.hitTest) or over a UI element. To avoid flicker at the silhouette edge:
//   * spatial hysteresis: while interactive, the probe is also satisfied within `marginPx`
//     of the avatar (the caller passes probes at offset points),
//   * temporal hysteresis: becoming interactive is immediate, becoming click-through waits
//     until the pointer has been outside for `leaveDelayMs`,
//   * the bridge is only called when the decision actually changes.
// "Holds" (an open drawer, a focused input, a pressed button, a drag) force interactivity.

export class ClickThroughGate {
  /**
   * @param {object} deps
   * @param {(ignore: boolean) => void} deps.apply   bridge.window.setIgnoreMouse
   * @param {number} [deps.leaveDelayMs]           default 140
   * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
   * @param {(id: any) => void} [deps.clearTimeout]
   */
  constructor(deps) {
    this._apply = deps.apply;
    this.leaveDelayMs = deps.leaveDelayMs ?? 140;
    this._setTimeout = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = deps.clearTimeout || ((id) => clearTimeout(id));
    this.enabled = false;
    /** Decision last sent to the bridge (null = never sent). */
    this.ignoring = /** @type {boolean|null} */ (null);
    /** @type {Set<string>} */
    this._holds = new Set();
    this._timer = null;
    this._lastInteractive = true;
  }

  /** Interactive right now (from the caller's point of view). */
  get interactive() {
    return this.ignoring !== true;
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this._cancel();
      this._send(false); // fail-safe: interactive
    } else {
      this._send(false); // known starting point: interactive
      this.update(this._lastInteractive);
    }
  }

  /**
   * Force interactivity while `key` is held (e.g. 'drawer', 'focus', 'pointerdown').
   * @param {string} key @param {boolean} on
   */
  hold(key, on) {
    if (on) this._holds.add(key);
    else this._holds.delete(key);
    if (on) {
      this._cancel();
      this._send(false);
    } else {
      this.update(this._lastInteractive);
    }
  }

  /**
   * Report the latest probe result (pointer over something interactive?).
   * @param {boolean} overInteractive
   */
  update(overInteractive) {
    this._lastInteractive = !!overInteractive;
    if (!this.enabled) return;
    const wantIgnore = !overInteractive && this._holds.size === 0;
    if (!wantIgnore) {
      this._cancel();
      this._send(false);
      return;
    }
    if (this.ignoring === true || this._timer) return;
    this._timer = this._setTimeout(() => {
      this._timer = null;
      if (this.enabled && !this._lastInteractive && this._holds.size === 0) this._send(true);
    }, this.leaveDelayMs);
  }

  /** The pointer left the window entirely. */
  leave() {
    this.update(false);
  }

  dispose() {
    this._cancel();
  }

  _cancel() {
    if (this._timer) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** @param {boolean} ignore */
  _send(ignore) {
    if (this.ignoring === ignore) return;
    this.ignoring = ignore;
    try {
      this._apply(ignore);
    } catch (err) {
      console.warn('[click-through] setIgnoreMouse failed', err);
    }
  }
}

/**
 * Probe the avatar with spatial hysteresis: when currently interactive, points within
 * `margin` px around the pointer also count as "over the avatar".
 * @param {(x: number, y: number) => boolean} hitTest
 * @param {number} x @param {number} y
 * @param {boolean} currentlyInteractive
 * @param {number} [margin]
 */
export function probeAvatar(hitTest, x, y, currentlyInteractive, margin = 10) {
  if (hitTest(x, y)) return true;
  if (!currentlyInteractive) return false;
  return hitTest(x + margin, y) || hitTest(x - margin, y) || hitTest(x, y + margin) || hitTest(x, y - margin);
}
