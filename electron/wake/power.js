// The PC locks, sleeps, unlocks, wakes (contract-wake §7.9, §2.3): the avatar window releases the
// microphone while the PC is locked or suspended, so nobody in the room can drive an agent
// session then. powerMonitor events → lm:wake:power { state } to the avatar.

/** powerMonitor event → the state the renderer gets. */
export const POWER_EVENTS = Object.freeze({ 'lock-screen': 'locked', 'unlock-screen': 'unlocked', suspend: 'suspended', resume: 'resumed' });

export const POWER_STATES = Object.freeze(['locked', 'unlocked', 'suspended', 'resumed']);

/**
 * @param {{ on?: Function, removeListener?: Function }|null|undefined} powerMonitor
 * @param {(state: 'locked'|'unlocked'|'suspended'|'resumed') => void} send
 * @returns {{ stop: () => void, emit: (state: string) => void, last: () => string|null }}
 */
export function watchPower(powerMonitor, send) {
  /** @type {string|null} */
  let last = null;
  /** @type {Array<[string, Function]>} */
  const subs = [];
  const emit = (/** @type {string} */ state) => {
    if (!POWER_STATES.includes(state)) throw new Error(`unknown power state ${state}`);
    last = state;
    send(/** @type {any} */ (state));
  };
  for (const [ev, state] of Object.entries(POWER_EVENTS)) {
    const fn = () => emit(state);
    try {
      powerMonitor?.on?.(ev, fn);
      subs.push([ev, fn]);
    } catch { /* not supported on this platform */ }
  }
  return {
    stop: () => {
      for (const [ev, fn] of subs) {
        try { powerMonitor?.removeListener?.(ev, fn); } catch { /* gone */ }
      }
      subs.length = 0;
    },
    emit,
    last: () => last,
  };
}
