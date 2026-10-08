// Presence: is the user at the computer? From the attention tracker's (already debounced)
// present/absent signal this decides when the avatar dozes off and when it greets the user.
//
//   away  the user has been gone for sleepAfterMs while the conversation is idle → the avatar
//         goes to sleep (once per absence; if a reply is still running, it waits for the end)
//   back  the user is in view again. `welcome`: they were gone long enough that the avatar
//         dozed off (or it was asleep anyway) → wake up with a brow raise and a smile.
//         `greet`: they were gone ≥ greetAfterMs and Claude has not greeted for greetEveryMs
//         → (with camera.greet on) Claude says hello.
//
// Pure: time is passed in; unit-tested.

export const PRESENCE_DEFAULTS = Object.freeze({
  sleepAfterMs: 2 * 60_000,
  greetAfterMs: 10 * 60_000,
  greetEveryMs: 30 * 60_000,
});

/**
 * @typedef {{ type: 'away', awayMs: number }
 *   | { type: 'back', awayMs: number, welcome: boolean, greet: boolean }} PresenceEvent
 */

export class PresenceMachine {
  /** @param {Partial<typeof PRESENCE_DEFAULTS>} [o] @param {number} [now] */
  constructor(o = {}, now = 0) {
    this.o = { ...PRESENCE_DEFAULTS, ...o };
    this.lastGreetAt = -Infinity;
    this.reset(now);
  }

  /**
   * Forget the current absence (the camera (re)started: nobody was watched before `now`, so a
   * user who is there right away is not "back").
   * @param {number} now
   */
  reset(now) {
    /** @type {number|null} since when nobody is in view (null: someone is) */
    this.absentSince = now;
    this.present = false;
    this._slept = false;
  }

  /**
   * @param {boolean} present  AttentionState.present
   * @param {number} now ms
   * @param {{ idle?: boolean, sleeping?: boolean, lastSeen?: number }} [ctx]  idle: no turn, speech,
   *   listening or card; lastSeen: when the face was last in view (the absence starts there, not
   *   when the tracker's hysteresis gave up on it)
   * @returns {PresenceEvent[]}
   */
  update(present, now, ctx = {}) {
    /** @type {PresenceEvent[]} */
    const out = [];
    if (present) {
      if (this.absentSince !== null) {
        const awayMs = Math.max(0, now - this.absentSince);
        const welcome = this._slept || !!ctx.sleeping || awayMs >= this.o.sleepAfterMs;
        const greet = awayMs >= this.o.greetAfterMs && now - this.lastGreetAt >= this.o.greetEveryMs;
        out.push({ type: 'back', awayMs, welcome, greet });
      }
      this.absentSince = null;
      this._slept = false;
      this.present = true;
      return out;
    }
    if (this.absentSince === null) {
      const seen = ctx.lastSeen;
      this.absentSince = typeof seen === 'number' && Number.isFinite(seen) && seen <= now ? seen : now;
    }
    this.present = false;
    const awayMs = now - this.absentSince;
    if (!this._slept && awayMs >= this.o.sleepAfterMs && ctx.idle !== false) {
      this._slept = true;
      out.push({ type: 'away', awayMs });
    }
    return out;
  }

  /** Claude greeted the user (rate limit). @param {number} now */
  markGreeted(now) {
    this.lastGreetAt = now;
  }
}
