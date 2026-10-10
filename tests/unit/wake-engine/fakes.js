// Fakes for the wake engine's main-process tests: a utilityProcess, MessageChannelMain, a
// webContents, a manual clock.
import { EventEmitter } from 'node:events';

export class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.posted = [];
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  postMessage(m, ports) {
    this.posted.push({ m, ports });
    if (m && m.t === 'stop' && this.onStop) this.onStop();
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 1));
    return true;
  }

  /** the utility answers init */
  ready(models = ['zhen', 'giga'], loadMs = 2000) {
    this.emit('message', { t: 'ready', models, loadMs });
  }
}

export function fakeUtilityProcess() {
  let pid = 1000;
  const up = {
    forks: /** @type {Array<{ entry: string, args: string[], opts: any, child: FakeChild }>} */ ([]),
    fork(entry, args, opts) {
      const child = new FakeChild(++pid);
      up.forks.push({ entry, args, opts, child });
      return child;
    },
    get last() {
      return up.forks[up.forks.length - 1].child;
    },
  };
  return up;
}

export class FakePort {
  constructor(id) {
    this.id = id;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

export function fakeChannel() {
  let n = 0;
  return class MessageChannelMain {
    constructor() {
      n++;
      this.port1 = new FakePort(`p1-${n}`);
      this.port2 = new FakePort(`p2-${n}`);
    }
  };
}

export function fakeWebContents() {
  return {
    sent: [],
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    postMessage(channel, payload, ports) { this.sent.push({ channel, payload, ports }); },
  };
}

/** A manual clock with setTimeout/clearTimeout. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = ++id;
      timers.set(t, { at: now + ms, fn });
      return /** @type {any} */ (t);
    },
    clearTimeout: (t) => { timers.delete(t); },
    /** advance and run due timers in order */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [t, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [t, v];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
