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
    send: (text) => invoke('lm:claude:send', text),
    interrupt: () => invoke('lm:claude:interrupt'),
    reset: () => invoke('lm:claude:reset'),
    respondPermission: (requestId, decision) => invoke('lm:claude:respond-permission', requestId, decision),
    status: () => invoke('lm:claude:status'),
    onEvent: (cb) => subscribe('lm:claude:event', cb),
  },
  voice: {
    info: () => invoke('lm:voice:info'),
    restart: () => invoke('lm:voice:restart'),
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
    minimize: () => send('lm:window:minimize'),
    hide: () => send('lm:window:hide'),
    quit: () => send('lm:window:quit'),
  },
  onHotkey: (cb) => subscribe('lm:hotkey', cb),
  app: {
    info: () => invoke('lm:app:info'),
  },
};

contextBridge.exposeInMainWorld('lawnmower', api);
