// Presence: is the user at the computer? From the attention tracker's (already debounced)
// present/absent signal this decides when the avatar dozes off and when it greets the user.
//
//   away  the user has been gone for sleepAfterMs while the conversation is idle → the avatar
//         goes to sleep (once per absence; if a reply is still running, it waits for the end)
//   back  the user is in view: the first time since the camera started (`first`), or again
//         after an absence. `welcome`: the avatar dozed off (or was asleep anyway), or it is the
//         first sight → wake up with a brow raise and a smile. `greet`: the first sight, or
//         back after ≥ greetAfterMs, and no greeting for greetEveryMs → (camera.greeting)
//         the avatar says hello.
//
// Pure: time is passed in; unit-tested.

export const PRESENCE_DEFAULTS = Object.freeze({
  sleepAfterMs: 2 * 60_000,
  greetAfterMs: 2 * 60_000,
  greetEveryMs: 5 * 60_000,
});

/**
 * @typedef {{ type: 'away', awayMs: number }
 *   | { type: 'back', awayMs: number, first: boolean, welcome: boolean, greet: boolean }} PresenceEvent
 */

export class PresenceMachine {
  /** @param {Partial<typeof PRESENCE_DEFAULTS>} [o] @param {number} [now] */
  constructor(o = {}, now = 0) {
    this.o = { ...PRESENCE_DEFAULTS, ...o };
    this.lastGreetAt = -Infinity;
    this.reset(now, true);
  }

  /**
   * Forget the current absence: the camera (re)started, nobody was watched before `now`, so a
   * user who is there right away is not coming "back". With `first` the next face in view is
   * the first sight (the camera was just turned on: the avatar says hello).
   * @param {number} now @param {boolean} [first]
   */
  reset(now, first = false) {
    /** @type {number|null} since when nobody is in view (null: someone is) */
    this.absentSince = now;
    this.present = false;
    this._slept = false;
    this._first = !!first;
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
        const first = this._first;
        const welcome = first || this._slept || !!ctx.sleeping || awayMs >= this.o.sleepAfterMs;
        const greet = (first || awayMs >= this.o.greetAfterMs) && now - this.lastGreetAt >= this.o.greetEveryMs;
        out.push({ type: 'back', awayMs, first, welcome, greet });
      }
      this.absentSince = null;
      this._slept = false;
      this._first = false;
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

  /** The avatar greeted the user (rate limit). @param {number} now */
  markGreeted(now) {
    this.lastGreetAt = now;
  }
}
