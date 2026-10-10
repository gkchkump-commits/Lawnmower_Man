// Preload (sandboxed, contextIsolation): exposes EXACTLY the window.lawnmower contract
// (docs/ARCHITECTURE.md §3). No raw ipcRenderer is exposed; every listener registration returns
// an unsubscribe function. Channel names must match electron/main.js.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** @param {string} channel @param {...unknown} args */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
/** @param {string} channel @param {...unknown} args */
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

/**
 * Subscribe to a main → renderer channel; returns an unsubscribe function.
 * @param {string} channel @param {(payload: any) => void} cb
 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[lawnmower] ${channel} listener threw`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  claude: {
    // options: { images?: [{ mediaType, data }] } (webcam snapshots, validated in main)
    send: (text, options) => invoke('lm:claude:send', text, options),
    cancel: (turnId) => invoke('lm:claude:cancel', turnId),
    interrupt: () => invoke('lm:claude:interrupt'),
    reset: () => invoke('lm:claude:reset'),
    respondPermission: (requestId, decision) => invoke('lm:claude:respond-permission', requestId, decision),
    status: () => invoke('lm:claude:status'),
    // Setup card "Retry": look for the CLI again (it may have just been installed) and restart it.
    retry: () => invoke('lm:claude:retry'),
    onEvent: (cb) => subscribe('lm:claude:event', cb),
  },
  voice: {
    info: () => invoke('lm:voice:info'),
    restart: () => invoke('lm:voice:restart'),
    // "Set up local voice…": opens the bundled setup script in its own console window.
    setup: (options) => invoke('lm:voice:setup', options),
    // "Open setup log": main opens the setup log of its own voice home (no arguments).
    openSetupLog: () => invoke('lm:voice:open-setup-log'),
    onStatus: (cb) => subscribe('lm:voice:status', cb),
  },
  settings: {
    get: () => invoke('lm:settings:get'),
    set: (patch) => invoke('lm:settings:set', patch),
    onChange: (cb) => subscribe('lm:settings:changed', cb),
  },
  window: {
    setIgnoreMouse: (ignore) => send('lm:window:set-ignore-mouse', !!ignore),
    setSizePreset: (preset) => send('lm:window:set-size-preset', preset),
    setAlwaysOnTop: (on) => send('lm:window:set-always-on-top', !!on),
    // Moving the avatar: press on the head → main follows the global cursor until the release.
    dragStart: () => send('lm:window:drag-start'),
    dragEnd: () => send('lm:window:drag-end'),
    // Resizing: press on a corner grip ('tl' | 'tr' | 'bl' | 'br') → main resizes from that
    // corner until the release; setAvatarWidth(px) = a free size (Ctrl + wheel).
    resizeStart: (corner) => send('lm:window:resize-start', corner),
    resizeEnd: () => send('lm:window:resize-end'),
    setAvatarWidth: (width) => send('lm:window:set-avatar-width', width),
    resetPosition: () => send('lm:window:reset-position'),
    minimize: () => send('lm:window:minimize'),
    hide: () => send('lm:window:hide'),
    quit: () => send('lm:window:quit'),
    // { visible }: the window was shown / hidden / minimized / restored (the camera pauses)
    onVisibility: (cb) => subscribe('lm:window:visibility', cb),
  },
  onHotkey: (cb) => subscribe('lm:hotkey', cb),
  // Global cursor position {x, y} in CSS px relative to the window's top-left (may be outside).
  onCursor: (cb) => subscribe('lm:cursor', cb),
  app: {
    info: () => invoke('lm:app:info'),
  },
  // The Tapo home camera (docs/TAPO.md): status, arming (always with the exit delay from here),
  // pan/tilt, presets, the events list, and the camera window. Alerts and "look over there"
  // points arrive through onAlert / onLook. The camera window itself has its own preload
  // (preload-camera.cjs, window.lawnmowerCamera).
  tapo: {
    status: () => invoke('lm:tapo:status'),
    arm: (armed) => invoke('lm:tapo:arm', { armed: !!armed }),
    // { op: 'nudge'|'hold'|'heartbeat'|'release'|'stop'|'center'|'preset'|'preset-name'|'home', … }
    ptz: (cmd) => invoke('lm:tapo:ptz', cmd),
    presets: (o) => invoke('lm:tapo:presets', o),
    events: (q) => invoke('lm:tapo:events-list', q),
    // { eventId? }: show the camera window (and open that event's clip)
    openWindow: (o) => invoke('lm:tapo:window', { show: true, ...(o || {}) }),
    openClips: () => invoke('lm:tapo:open-clips'),
    onStatus: (cb) => subscribe('lm:tapo:status', cb),
    onAlert: (cb) => subscribe('lm:tapo:alert', cb),
    // { x, y, holdMs }: a point in this window's CSS px (the camera window's centre)
    onLook: (cb) => subscribe('lm:tapo:look', cb),
  },
};

contextBridge.exposeInMainWorld('lawnmower', api);
