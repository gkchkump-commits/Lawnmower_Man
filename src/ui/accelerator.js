// Keyboard event → Electron accelerator string ("CommandOrControl+Alt+Space"), and back to a
// readable label ("Ctrl+Alt+Space"). Used by the hotkey recorder in the settings drawer; the
// main process validates the result again (electron/settings.js normalizeAccelerator).

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'Hyper', 'Super', 'Fn']);

const CODE_KEYS = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  PrintScreen: 'PrintScreen', MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
};

/** @param {string} code */
function keyFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) >= 1 && Number(m[1]) <= 24) return `F${m[1]}`;
  return /** @type {any} */ (CODE_KEYS)[code] || null;
}

/**
 * @param {{ key: string, code: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} e
 * @param {string} [platform] 'win32' | 'darwin' | 'linux'
 * @returns {null | { accelerator: string } | { error: string }} null = still recording (modifier only)
 */
export function acceleratorFromEvent(e, platform = 'win32') {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyFromCode(e.code);
  if (!key) return { error: `The key "${e.key}" can't be used in a shortcut.` };
  const mac = platform === 'darwin';
  const mods = [];
  if (mac) {
    if (e.metaKey) mods.push('CommandOrControl');
    if (e.ctrlKey) mods.push('Control');
  } else {
    if (e.ctrlKey) mods.push('CommandOrControl');
    if (e.metaKey) mods.push('Super');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const fkey = /^F\d+$/.test(key) || /^Media/.test(key);
  if (!mods.length && !fkey) return { error: 'Use at least one modifier (Ctrl, Alt, Shift…) so the shortcut doesn’t steal normal typing.' };
  if (mods.length === 1 && mods[0] === 'Shift' && !fkey) return { error: 'Shift alone is not enough; add Ctrl or Alt.' };
  return { accelerator: [...mods, key].join('+') };
}

/**
 * Readable label for an accelerator.
 * @param {string} acc @param {string} [platform]
 */
export function formatAccelerator(acc, platform = 'win32') {
  if (!acc) return 'Off';
  const mac = platform === 'darwin';
  return acc.split('+').map((p) => {
    switch (p) {
      case 'CommandOrControl': case 'CmdOrCtrl': return mac ? '⌘' : 'Ctrl';
      case 'Command': case 'Cmd': return '⌘';
      case 'Control': case 'Ctrl': return mac ? '⌃' : 'Ctrl';
      case 'Alt': case 'Option': return mac ? '⌥' : 'Alt';
      case 'Shift': return mac ? '⇧' : 'Shift';
      case 'Super': case 'Meta': return mac ? '⌘' : 'Win';
      default: return p;
    }
  }).join(mac ? '' : '+');
}
