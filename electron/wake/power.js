// The PC locks, sleeps, unlocks, wakes (contract-wake §7.9, §2.3): the avatar window releases the
// microphone while the PC is locked or suspended, so nobody in the room can drive an agent
// session then. powerMonitor events → lm:wake:power { state, seq } to the avatar.
//
// The screen lock and sleep are tracked separately: a PC locked (Win+L), then asleep, then woken
// at the lock screen is still locked ('resumed' ends only the sleep). snapshot() is part of the
// engine status, so a window that (re)loads while the PC is locked starts locked; refresh() asks
// the OS (powerMonitor.getSystemIdleState) whether the screen is locked, at a status request and
// when the PC wakes up. 'resumed' is sent only RESUME_SETTLE_MS after the PC woke and after another
// look at the lock state, so a lock screen that Windows reports just after waking never finds the
// microphone open.

/** powerMonitor event → the state the renderer gets. */
export const POWER_EVENTS = Object.freeze({ 'lock-screen': 'locked', 'unlock-screen': 'unlocked', suspend: 'suspended', resume: 'resumed' });

export const POWER_STATES = Object.freeze(['locked', 'unlocked', 'suspended', 'resumed']);

/** How long after the PC woke up 'resumed' is sent (the lock screen's event may come first). */
export const RESUME_SETTLE_MS = 1000;

/** @typedef {{ locked: boolean, suspended: boolean, seq: number }} PowerSnapshot */

/**
 * @param {{ on?: Function, removeListener?: Function, getSystemIdleState?: (threshold: number) => string }|null|undefined} powerMonitor
 * @param {(state: 'locked'|'unlocked'|'suspended'|'resumed', seq: number) => void} send
 * @param {{ setTimeout?: (fn: () => void, ms: number) => any, clearTimeout?: (t: any) => void, settleMs?: number }} [o]
 * @returns {{ stop: () => void, emit: (state: string) => void, last: () => string|null, snapshot: () => PowerSnapshot, refresh: () => string }}
 */
export function watchPower(powerMonitor, send, o = {}) {
  const set = o.setTimeout || setTimeout;
  const clear = o.clearTimeout || clearTimeout;
  const settleMs = o.settleMs ?? RESUME_SETTLE_MS;
  /** @type {string|null} */
  let last = null;
  let screenLocked = false;
  let suspended = false;
  let seq = 0;
  /** @type {any} */
  let resumeTimer = null;
  /** @type {Array<[string, Function]>} */
  const subs = [];
  const emit = (/** @type {string} */ state) => {
    if (!POWER_STATES.includes(state)) throw new Error(`unknown power state ${state}`);
    last = state;
    if (state === 'locked') screenLocked = true;
    else if (state === 'suspended') suspended = true;
    else if (state === 'resumed') suspended = false;
    else {
      // unlocked: someone signed in, so the PC is awake as well
      screenLocked = false;
      suspended = false;
    }
    seq++;
    send(/** @type {any} */ (state), seq);
  };
  /** Ask the OS: 'locked' | 'active' | 'idle' | 'unknown'. A lock it reports is sent. */
  const refresh = () => {
    let s = 'unknown';
    try {
      s = String(powerMonitor?.getSystemIdleState?.(0) ?? 'unknown');
    } catch { /* not supported here */ }
    // it only ever sets the lock: where the OS cannot tell, its 'active' must not unlock anything
    if (s === 'locked' && !screenLocked) emit('locked');
    return s;
  };
  for (const [ev, state] of Object.entries(POWER_EVENTS)) {
    const fn = ev === 'resume'
      ? () => {
        // the PC woke up: still asleep for the renderer until the lock state is known
        refresh();
        if (resumeTimer) clear(resumeTimer);
        resumeTimer = set(() => {
          resumeTimer = null;
          refresh();
          emit('resumed');
        }, settleMs);
      }
      : () => emit(state);
    try {
      powerMonitor?.on?.(ev, fn);
      subs.push([ev, fn]);
    } catch { /* not supported on this platform */ }
  }
  return {
    stop: () => {
      if (resumeTimer) clear(resumeTimer);
      resumeTimer = null;
      for (const [ev, fn] of subs) {
        try { powerMonitor?.removeListener?.(ev, fn); } catch { /* gone */ }
      }
      subs.length = 0;
    },
    emit,
    last: () => last,
    snapshot: () => ({ locked: screenLocked, suspended, seq }),
    refresh,
  };
}
