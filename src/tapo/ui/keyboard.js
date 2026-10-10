// Keyboard shortcuts of the Home camera window (contract §9.2), as a pure mapping from a key
// event to a command; main.js runs them. Arrows go through the D-pad's PressHold (a tap nudges,
// holding turns continuously). Nothing fires while the user types in a text field.

import { isTypingTarget } from '../../ui/dom.js';

/**
 * @typedef {{ type: 'arrow', dir: 'left'|'right'|'up'|'down', amount: 'small'|'medium'|'large' }
 *   | { type: 'home' } | { type: 'preset', index: number } | { type: 'snapshot' } | { type: 'arm' }
 *   | { type: 'events' } | { type: 'fullscreen' } | { type: 'escape' } | { type: 'help' }} KeyCommand
 */

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/**
 * @param {{ key: string, code?: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, target?: any }} e
 * @returns {KeyCommand|null}
 */
export function keyCommand(e) {
  if (!e || typeof e.key !== 'string') return null;
  if (e.key === 'Escape') return { type: 'escape' };
  if (isTypingTarget(e.target ?? null)) return null;
  if (e.ctrlKey || e.metaKey) return null; // browser / OS shortcuts (Ctrl+C, Ctrl+R …)
  const dir = /** @type {any} */ (ARROWS)[e.key];
  if (dir) return { type: 'arrow', dir, amount: e.shiftKey ? 'large' : e.altKey ? 'small' : 'medium' };
  if (e.altKey) return null;
  if (e.key === 'Home' || e.key === 'h' || e.key === 'H') return { type: 'home' };
  if (/^[1-8]$/.test(e.key)) return { type: 'preset', index: Number(e.key) - 1 };
  if (e.key === ' ' || e.code === 'Space') return { type: 'snapshot' };
  if (e.key === 'a' || e.key === 'A') return { type: 'arm' };
  if (e.key === 'e' || e.key === 'E') return { type: 'events' };
  if (e.key === 'f' || e.key === 'F') return { type: 'fullscreen' };
  if (e.key === '?') return { type: 'help' };
  return null;
}

/** An arrow key's direction (for keyup). @param {string} key */
export function arrowDir(key) {
  return /** @type {'left'|'right'|'up'|'down'|undefined} */ (/** @type {any} */ (ARROWS)[key]);
}
