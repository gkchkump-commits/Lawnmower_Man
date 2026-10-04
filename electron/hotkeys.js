// Global shortcuts from settings.hotkeys. Re-registers on change and reports conflicts
// (an accelerator already taken by another app, duplicated between our own actions, or invalid).

import { normalizeAccelerator } from './settings.js';

export const HOTKEY_NAMES = /** @type {const} */ (['toggleListen', 'toggleChat', 'stopSpeaking']);

const ALIASES = { cmdorctrl: 'commandorcontrol', ctrl: 'control', cmd: 'command', option: 'alt', esc: 'escape', return: 'enter' };

/**
 * Comparable identity of an accelerator: aliases folded, modifier order ignored.
 * @param {string} acc
 */
export function acceleratorKey(acc) {
  const parts = acc.split('+').map((p) => {
    const l = p.trim().toLowerCase();
    return /** @type {Record<string,string>} */ (ALIASES)[l] || l;
  });
  const key = parts.pop();
  return [...parts.sort(), key].join('+');
}

/**
 * @typedef {{ name: string, accelerator: string, reason: string }} HotkeyConflict
 */

export class HotkeyManager {
  /**
   * @param {{ globalShortcut: { register: (acc: string, cb: () => void) => boolean, unregister: (acc: string) => void },
   *           onHotkey: (name: string) => void, log?: (level: string, msg: string) => void }} o
   */
  constructor(o) {
    this._gs = o.globalShortcut;
    this._onHotkey = o.onHotkey;
    this._log = o.log || (() => {});
    /** @type {Map<string, string>} accelerator → name */
    this._registered = new Map();
    /** @type {HotkeyConflict[]} */
    this.conflicts = [];
  }

  /**
   * Register the given hotkeys (replacing ours from before).
   * @param {Record<string, string>} hotkeys
   * @returns {{ registered: Record<string, string>, conflicts: HotkeyConflict[] }}
   */
  apply(hotkeys) {
    this.dispose();
    /** @type {Record<string, string>} */
    const registered = {};
    /** @type {HotkeyConflict[]} */
    const conflicts = [];
    /** @type {Map<string, string>} canonical (lowercase) → name */
    const seen = new Map();
    for (const name of HOTKEY_NAMES) {
      const raw = hotkeys ? hotkeys[name] : '';
      if (!raw) continue;
      const acc = normalizeAccelerator(raw);
      if (!acc) {
        conflicts.push({ name, accelerator: String(raw), reason: 'invalid shortcut' });
        continue;
      }
      const key = acceleratorKey(acc);
      if (seen.has(key)) {
        conflicts.push({ name, accelerator: acc, reason: `same as ${seen.get(key)}` });
        continue;
      }
      seen.set(key, name);
      let ok = false;
      try {
        ok = this._gs.register(acc, () => {
          try {
            this._onHotkey(name);
          } catch (err) {
            this._log('error', `[hotkeys] handler for ${name} threw: ${err}`);
          }
        });
      } catch (err) {
        conflicts.push({ name, accelerator: acc, reason: `rejected by the system (${/** @type {Error} */ (err).message})` });
        continue;
      }
      if (ok) {
        this._registered.set(acc, name);
        registered[name] = acc;
      } else {
        conflicts.push({ name, accelerator: acc, reason: 'already used by another application' });
      }
    }
    for (const c of conflicts) this._log('warn', `[hotkeys] ${c.name} (${c.accelerator}): ${c.reason}`);
    this.conflicts = conflicts;
    return { registered, conflicts };
  }

  /** Unregister everything we registered. */
  dispose() {
    for (const acc of this._registered.keys()) {
      try {
        this._gs.unregister(acc);
      } catch {
        /* ignore */
      }
    }
    this._registered.clear();
  }
}
