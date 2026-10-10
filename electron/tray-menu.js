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
 * @property {boolean} [voiceInstalled]
 * @property {string} [voiceSetup]       'idle'|'running'|'done'|'failed'|'manual'
 * @property {string} [claudeProblem]    'cli-missing'|'auth'|''
 * @property {{ name: string, accelerator: string, reason: string }[]} [hotkeyConflicts]
 * @property {TapoTrayState} [tapo]       the home camera (electron/tapo); absent = no Home camera menu
 */

/**
 * @typedef {object} TapoTrayState
 * @property {boolean} enabled
 * @property {boolean} configured            host, Camera Account and password are set
 * @property {string} connection             TapoStatus.connection
 * @property {boolean} armed
 * @property {'yes'|'offline'|'no-video'} [watching]   armed but not watching (TapoStatus.security.watching)
 * @property {boolean} arming
 * @property {string} name
 */

/**
 * @typedef {object} TrayActions
 * @property {() => void} toggleVisible
 * @property {(on: boolean) => void} setAlwaysOnTop
 * @property {(on: boolean) => void} setClickThrough
 * @property {(on: boolean) => void} setShowChat
 * @property {(mode: 'chat'|'assistant'|'agent') => void} setMode
 * @property {(preset: 'small'|'medium'|'large') => void} setSizePreset
 * @property {(on: boolean) => void} [setLockPosition]
 * @property {() => void} [resetPosition]
 * @property {(on: boolean) => void} [setCamera]
 * @property {() => void} newConversation
 * @property {() => void} restartVoice
 * @property {() => void} [setupVoice]
 * @property {() => void} openSettingsFile
 * @property {() => void} openWorkdir
 * @property {() => void} openLogs
 * @property {() => void} quit
 * @property {() => void} [tapoShow]          show the camera window (turns the feature on when it is off)
 * @property {(on: boolean) => void} [tapoArm]
 * @property {() => void} [tapoOpenClips]
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
  const cam = st.tapo && st.tapo.enabled ? ` · Home camera: ${tapoLabel(st.tapo).toLowerCase()}` : '';
  return `Lawnmower Man — Claude: ${claudeLabel(st)} · Voice: ${st.voiceStatus || 'unknown'}${cam}`;
}

/** "armed" | "arming" | "online" | "offline" … for the tooltip and the menu. @param {TapoTrayState} t */
export function tapoLabel(t) {
  if (!t.enabled) return 'Off';
  if (!t.configured) return 'Not set up';
  if (t.armed) {
    if (t.arming) return 'Arming';
    // armed but blind must not read "Armed" (an unplugged or jammed camera looks protected)
    if (t.watching === 'offline' || ['unreachable', 'auth-failed', 'error', 'off', 'not-configured'].includes(String(t.connection))) return 'Armed · camera offline';
    if (t.watching === 'no-video') return 'Armed · not watching';
    return 'Armed';
  }
  if (t.connection === 'online') return 'Online';
  if (t.connection === 'connecting') return 'Connecting';
  if (t.connection === 'auth-failed') return 'Sign-in failed';
  return 'Offline';
}

/**
 * The "Home camera" submenu (after "Camera").
 * @param {TapoTrayState} t @param {TrayActions} a
 */
function tapoItem(t, a) {
  const status = !t.enabled ? 'Home camera is off' : !t.configured ? 'Not set up yet' : `${tapoLabel(t)}${t.armed ? '' : ' · Disarmed'}`;
  return {
    label: 'Home camera',
    submenu: [
      { label: status, enabled: false },
      { label: t.enabled && t.configured ? 'Show camera window' : 'Set up the home camera…', click: () => a.tapoShow?.() },
      { label: 'Armed', type: 'checkbox', checked: !!t.armed, enabled: !!(t.enabled && t.configured), click: (/** @type {any} */ item) => a.tapoArm?.(!!item?.checked) },
      { label: 'Open clips folder', enabled: !!t.enabled, click: () => a.tapoOpenClips?.() },
    ],
  };
}

/** @param {TrayState} st */
function claudeLabel(st) {
  if (st.claudeProblem === 'cli-missing') return 'not installed';
  if (st.claudeProblem === 'auth') return 'not signed in';
  return st.claudeStatus || 'unknown';
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
    { label: `Claude: ${cap(claudeLabel(st))}`, enabled: false, toolTip: st.claudeDetail || undefined },
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
      submenu: [
        ...(/** @type {const} */ (['small', 'medium', 'large'])).map((p) => ({
          label: SIZE_LABELS[p],
          type: 'radio',
          checked: s.window.avatarWidth == null && s.window.sizePreset === p,
          click: () => a.setSizePreset(p),
        })),
        // a free size from resizing (a corner grip, Ctrl + wheel): shown, picked by a preset above
        ...(s.window.avatarWidth != null
          ? [{ label: `Custom (${s.window.avatarWidth} px wide)`, type: 'radio', checked: true, enabled: false }]
          : []),
      ],
    },
    { label: 'Show chat panel', type: 'checkbox', checked: !!s.window.showChat, click: (/** @type {any} */ item) => a.setShowChat(!!item?.checked) },
    { label: 'Always on top', type: 'checkbox', checked: !!s.window.alwaysOnTop, click: (/** @type {any} */ item) => a.setAlwaysOnTop(!!item?.checked) },
    { label: 'Click-through background', type: 'checkbox', checked: !!s.window.clickThrough, click: (/** @type {any} */ item) => a.setClickThrough(!!item?.checked) },
    { label: 'Lock position', type: 'checkbox', checked: !!s.window.lockPosition, click: (/** @type {any} */ item) => a.setLockPosition?.(!!item?.checked) },
    { label: 'Reset position', click: () => a.resetPosition?.() },
    // the avatar can see you (docs/CAMERA.md); the first time, the window explains it before it starts
    { label: 'Camera', type: 'checkbox', checked: !!s.camera?.enabled, click: (/** @type {any} */ item) => a.setCamera?.(!!item?.checked) },
    // the Tapo home camera (docs/TAPO.md)
    ...(st.tapo ? [tapoItem(st.tapo, a)] : []),
    { type: 'separator' },
    { label: 'Restart voice', click: () => a.restartVoice() },
    st.voiceSetup === 'running'
      ? { label: 'Local voice setup is running…', enabled: false }
      : { label: st.voiceInstalled ? 'Set up local voice again…' : 'Set up local voice…', click: () => a.setupVoice?.() },
    { label: 'Open settings file', click: () => a.openSettingsFile() },
    { label: 'Open working folder', click: () => a.openWorkdir() },
    { label: 'Open logs folder', click: () => a.openLogs() },
    { type: 'separator' },
    { label: 'Quit Lawnmower Man', click: () => a.quit() },
  );
  return items;
}
