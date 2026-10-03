// Minimal event emitter for renderer modules (works in Node tests too).

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe; returns an unsubscribe function.
   * @param {string} event @param {(...args: any[]) => void} cb
   * @returns {() => void}
   */
  on(event, cb) {
    let set = this._listeners.get(event);
    if (!set) this._listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** @param {string} event @param {(...args: any[]) => void} cb */
  once(event, cb) {
    const off = this.on(event, (...args) => {
      off();
      cb(...args);
    });
    return off;
  }

  /** @param {string} event @param {...any} args */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[lawnmower] "${event}" listener failed`, err);
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}
