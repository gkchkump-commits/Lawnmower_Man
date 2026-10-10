// Preload of the "Home camera" window (sandboxed, contextIsolation): exposes EXACTLY
// window.lawnmowerCamera (contract §6.2) — the camera, its settings groups (main accepts only
// tapo/security from this window) and app info. No Claude API, no raw ipcRenderer.
// The worker's MessagePort cannot cross contextBridge: it is forwarded to the page with
// window.postMessage (Electron's MessagePort tutorial); the page accepts it only when
// event.source === window and data.type === 'lm:tapo:port'.
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
      console.error(`[lawnmowerCamera] ${channel} listener threw`, err);
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

/** An event id given as a string or as { id }. @param {unknown} v */
const eventRef = (v) => (typeof v === 'string' ? { id: v } : v);

const api = {
  settings: {
    get: () => invoke('lm:settings:get'),
    // only { tapo, security } (main rejects other groups from this window)
    set: (patch) => invoke('lm:settings:set', patch),
    onChange: (cb) => subscribe('lm:settings:changed', cb),
  },
  tapo: {
    status: () => invoke('lm:tapo:status'),
    onStatus: (cb) => subscribe('lm:tapo:status', cb),
    onEvent: (cb) => subscribe('lm:tapo:event', cb),
    onOpenEvent: (cb) => subscribe('lm:tapo:open-event', cb),
    onCalibration: (cb) => subscribe('lm:tapo:calibration', cb),
    // the password goes to main once and never comes back (status says hasPassword)
    setCredentials: (o) => invoke('lm:tapo:set-credentials', o),
    clearCredentials: () => invoke('lm:tapo:clear-credentials'),
    test: (o) => invoke('lm:tapo:test', o),
    discover: () => invoke('lm:tapo:discover'),
    ptz: (cmd) => invoke('lm:tapo:ptz', cmd),
    presets: (o) => invoke('lm:tapo:presets', o),
    savePreset: (o) => invoke('lm:tapo:preset-save', o),
    removePreset: (o) => invoke('lm:tapo:preset-remove', typeof o === 'string' ? { token: o } : o),
    // arm(true) / arm(false) / arm({ armed, immediate })
    arm: (o) => invoke('lm:tapo:arm', typeof o === 'object' && o !== null ? o : { armed: !!o }),
    calibrate: (req) => invoke('lm:tapo:calibrate', req),
    events: {
      list: (q) => invoke('lm:tapo:events-list', q),
      remove: (id) => invoke('lm:tapo:event-remove', eventRef(id)),
      ack: (id) => invoke('lm:tapo:event-ack', eventRef(id)),
      openFolder: () => invoke('lm:tapo:open-clips'),
    },
    setViewVisible: (v) => send('lm:tapo:view', { visible: !!v }),
    requestPort: () => invoke('lm:tapo:request-port'),
    // reconnect now (offline / a problem; never a refused sign-in)
    retry: () => invoke('lm:tapo:retry'),
    // the redacted diagnostic report ("Copy diagnostic report")
    diagnostics: () => invoke('lm:tapo:diagnostics'),
  },
  app: {
    info: () => invoke('lm:app:info'),
  },
};

ipcRenderer.on('lm:tapo:port', (event) => {
  window.postMessage({ type: 'lm:tapo:port' }, '*', event.ports);
});

contextBridge.exposeInMainWorld('lawnmowerCamera', api);
