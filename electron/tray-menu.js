// Tray context-menu template (pure: returns Electron MenuItemConstructorOptions-like objects so
// it can be unit-tested; main.js passes it to Menu.buildFromTemplate).

/**
 * @typedef {object} TrayState
 * @property {boolean} visible
 * @property {import('./settings.js').Settings} settings
 * @property {string} claudeStatus
 * @property {string} [claudeDetail]
 * @property {string} voiceStatus
 * @property {string} [voiceDetail]
 * @property {{ name: string, accelerator: string, reason: string }[]} [hotkeyConflicts]
 */

/**
 * @typedef {object} TrayActions
 * @property {() => void} toggleVisible
 * @property {(on: boolean) => void} setAlwaysOnTop
 * @property {(on: boolean) => void} setClickThrough
 * @property {(on: boolean) => void} setShowChat
 * @property {(mode: 'chat'|'assistant'|'agent') => void} setMode
 * @property {(preset: 'small'|'medium'|'large') => void} setSizePreset
 * @property {() => void} newConversation
 * @property {() => void} restartVoice
 * @property {() => void} openSettingsFile
 * @property {() => void} openWorkdir
 * @property {() => void} openLogs
 * @property {() => void} quit
 */

const MODE_LABELS = { chat: 'Chat (no tools)', assistant: 'Assistant (read files + web)', agent: 'Agent (all tools, asks first)' };
const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' };

/** @param {string} s */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Short status line for the tooltip.
 * @param {TrayState} st
 */
export function trayTooltip(st) {
  return `Lawnmower Man — Claude: ${st.claudeStatus || 'unknown'} · Voice: ${st.voiceStatus || 'unknown'}`;
}

/**
 * @param {TrayState} st @param {TrayActions} a
 * @returns {Array<Record<string, any>>}
 */
export function buildTrayTemplate(st, a) {
  const s = st.settings;
  /** @type {Array<Record<string, any>>} */
  const items = [
    { label: st.visible ? 'Hide avatar' : 'Show avatar', click: () => a.toggleVisible() },
    { type: 'separator' },
    { label: `Claude: ${cap(st.claudeStatus || 'unknown')}`, enabled: false, toolTip: st.claudeDetail || undefined },
    { label: `Voice: ${cap(st.voiceStatus || 'unknown')}`, enabled: false, toolTip: st.voiceDetail || undefined },
  ];
  for (const c of st.hotkeyConflicts || []) {
    items.push({ label: `Shortcut ${c.accelerator} unavailable (${c.reason})`, enabled: false });
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Mode',
      submenu: /** @type {const} */ (['chat', 'assistant', 'agent']).map((m) => ({
        label: MODE_LABELS[m],
        type: 'radio',
        checked: s.claude.mode === m,
        click: () => a.setMode(m),
      })),
    },
    { label: 'New conversation', click: () => a.newConversation() },
    { type: 'separator' },
    {
      label: 'Size',
      submenu: /** @type {const} */ (['small', 'medium', 'large']).map((p) => ({
        label: SIZE_LABELS[p],
        type: 'radio',
        checked: s.window.sizePreset === p,
        click: () => a.setSizePreset(p),
      })),
    },
    { label: 'Show chat panel', type: 'checkbox', checked: !!s.window.showChat, click: (/** @type {any} */ item) => a.setShowChat(!!item?.checked) },
    { label: 'Always on top', type: 'checkbox', checked: !!s.window.alwaysOnTop, click: (/** @type {any} */ item) => a.setAlwaysOnTop(!!item?.checked) },
    { label: 'Click-through background', type: 'checkbox', checked: !!s.window.clickThrough, click: (/** @type {any} */ item) => a.setClickThrough(!!item?.checked) },
    { type: 'separator' },
    { label: 'Restart voice', click: () => a.restartVoice() },
    { label: 'Open settings file', click: () => a.openSettingsFile() },
    { label: 'Open working folder', click: () => a.openWorkdir() },
    { label: 'Open logs folder', click: () => a.openLogs() },
    { type: 'separator' },
    { label: 'Quit Lawnmower Man', click: () => a.quit() },
  );
  return items;
}
