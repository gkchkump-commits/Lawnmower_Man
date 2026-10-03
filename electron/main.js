// Lawnmower Man — Electron main process (composition root).
//
// Responsibilities: single-instance app lifecycle, the transparent always-on-top avatar window,
// app:// protocol serving dist/, CSP + permission + navigation hardening, tray menu, global
// shortcuts, IPC for the window.lawnmower contract (docs/ARCHITECTURE.md §3), and supervision of
// the Claude CLI session and the local voice server.
//
// Dev/test environment overrides (all optional):
//   VITE_DEV_SERVER_URL        load the renderer from a loopback Vite dev server
//   LAWNMOWER_CLAUDE_CLI       explicit Claude CLI path (skips auto-detection)
//   LAWNMOWER_USER_DATA        alternative userData folder (portable / testing)
//   LAWNMOWER_VOICE_ARGS       extra args for the voice server (e.g. "--fake")
//   LAWNMOWER_AGENT_PERMISSION_MODE  e.g. "acceptEdits" for agent mode
//   LAWNMOWER_DEBUG=1          debug logging;  LAWNMOWER_DEVTOOLS=1  allow DevTools when packaged
//   LAWNMOWER_FORCE_CLICK_THROUGH=1  honour click-through on Linux too (no mouse-move forwarding there)

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SettingsStore } from './settings.js';
import { ClaudeSession, resolveWorkdir } from './claude-session.js';
import { VoiceSidecar } from './voice-sidecar.js';
import { windowLayout, placeWindow, resizeAnchored, reclamp } from './window-manager.js';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  buildCsp,
  decidePermission,
  isSafeExternalUrl,
  isTrustedUrl,
  validateDevServerUrl,
  withCspHeader,
} from './security.js';
import { createAppProtocolHandler } from './app-protocol.js';
import {
  validateBoolean,
  validatePermissionResponse,
  validateSettingsPatch,
  validateSizePreset,
  validateTurnText,
} from './ipc-validate.js';
import { buildTrayTemplate, trayTooltip } from './tray-menu.js';
import { HotkeyManager } from './hotkeys.js';
import { renderIconPng } from './icon.js';
import { createLogger } from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const distDir = path.join(appRoot, 'dist');
const assetsDir = path.join(here, 'assets');
const devServerUrl = validateDevServerUrl(process.env.VITE_DEV_SERVER_URL);
const csp = buildCsp({ devServerUrl });
const trust = { devServerUrl };
/** setIgnoreMouseEvents(…, { forward: true }) only forwards mouse moves on Windows and macOS. */
const CLICK_THROUGH_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin' || !!process.env.LAWNMOWER_FORCE_CLICK_THROUGH;

/** Mutable app state (one window, one tray, one session). */
const state = {
  /** @type {import('electron').BrowserWindow|null} */ win: null,
  /** @type {import('electron').Tray|null} */ tray: null,
  /** @type {SettingsStore|null} */ settings: null,
  /** @type {ClaudeSession|null} */ claude: null,
  /** @type {VoiceSidecar|null} */ voice: null,
  /** @type {HotkeyManager|null} */ hotkeys: null,
  /** @type {ReturnType<typeof createLogger>} */ log: createLogger({ dir: null }),
  /** @type {boolean|null} */ ignoreMouse: null,
  quitting: false,
  cleanedUp: false,
  rendererCrashes: 0,
  claudeStatus: 'starting',
  claudeDetail: '',
  /** @type {Record<string, any>|null} */ gpu: null,
};

// ---------------------------------------------------------------------------------------------
// Before `ready`: privileged scheme, GPU switches, single-instance lock.

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

// Laptop hybrid graphics: prefer the discrete NVIDIA GPU, keep GPU raster/WebGL on even if the
// driver is on Chromium's blocklist, and allow audio playback without a click (spoken replies).
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
if (process.platform === 'win32') app.setAppUserModelId('com.lawnmower.avatar');
if (process.env.LAWNMOWER_USER_DATA) app.setPath('userData', path.resolve(process.env.LAWNMOWER_USER_DATA));

const gotLock = app.requestSingleInstanceLock();

/** Resolves once the app is initialised (used by the smoke test). */
export const mainReady = gotLock
  ? app.whenReady().then(init).catch((err) => {
      const msg = err && err.stack ? err.stack : String(err);
      state.log('error', `[main] startup failed: ${msg}`);
      try {
        dialog.showErrorBox('Lawnmower Man could not start', String(err && err.message ? err.message : err));
      } catch { /* no UI available */ }
      app.quit();
    })
  : Promise.resolve();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow(true));
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    state.quitting = true;
  });
  app.on('will-quit', (event) => {
    if (state.cleanedUp) return;
    event.preventDefault();
    state.cleanedUp = true;
    shutdown().finally(() => app.quit());
  });
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));
  if (process.versions.electron) {
    // Real Electron only (not when the smoke test imports this module under Node).
    for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(sig, () => app.quit());
    process.on('uncaughtException', (err) => state.log('error', `[main] uncaught: ${err && err.stack ? err.stack : err}`));
    process.on('unhandledRejection', (err) => state.log('error', `[main] unhandled rejection: ${err && /** @type {any} */ (err).stack ? /** @type {any} */ (err).stack : err}`));
  }
}

// ---------------------------------------------------------------------------------------------

async function init() {
  const userData = app.getPath('userData');
  const log = createLogger({ dir: path.join(userData, 'logs') });
  state.log = log;
  log('info', `[main] Lawnmower Man ${app.getVersion()} — Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, ${process.platform} ${process.arch}`);

  const settings = new SettingsStore({ dir: userData, log });
  settings.load();
  state.settings = settings;

  setupSessionSecurity(session.defaultSession);
  protocol.handle(APP_SCHEME, createAppProtocolHandler({ root: distDir, host: APP_HOST, csp, log }));
  Menu.setApplicationMenu(null);

  // --- Claude ---
  const claude = new ClaudeSession({
    getSettings: () => settings.get().claude,
    personaDir: path.join(userData, 'persona'),
    onSessionId: (id) => settings.update({ claude: { lastSessionId: id } }),
    cliPath: process.env.LAWNMOWER_CLAUDE_CLI || '',
    agentPermissionMode: process.env.LAWNMOWER_AGENT_PERMISSION_MODE || '',
    log,
  });
  claude.on('event', (ev) => {
    sendToRenderer('lm:claude:event', ev);
    if (ev.type === 'status') {
      state.claudeStatus = ev.status;
      state.claudeDetail = ev.detail || '';
      if (ev.status === 'error' && ev.detail) log('warn', `[claude] ${ev.detail}`);
      rebuildTray();
    }
  });
  state.claude = claude;

  // --- Voice ---
  const voiceDir = app.isPackaged ? path.join(process.resourcesPath, 'voice') : path.join(appRoot, 'voice');
  const voice = new VoiceSidecar({
    getSettings: () => settings.get().voice,
    voiceDir,
    venvDirs: [path.join(voiceDir, '.venv'), path.join(userData, 'voice-venv')],
    log,
  });
  voice.on('status', (info) => {
    sendToRenderer('lm:voice:status', info);
    rebuildTray();
  });
  state.voice = voice;

  registerIpc();
  createWindow();
  createTray();

  state.hotkeys = new HotkeyManager({
    globalShortcut,
    log,
    onHotkey: (name) => {
      if (name !== 'stopSpeaking' && state.win && !state.win.isVisible()) showWindow(false);
      sendToRenderer('lm:hotkey', name);
    },
  });
  state.hotkeys.apply(settings.get().hotkeys);

  settings.on('change', onSettingsChanged);
  for (const ev of /** @type {const} */ (['display-added', 'display-removed', 'display-metrics-changed'])) {
    screen.on(ev, () => reclampWindow());
  }

  // Start the brain and the voice in the background; status flows to the renderer as events.
  claude.start().catch((err) => log('warn', `[claude] ${err.message}`));
  voice.start().catch((err) => log('warn', `[voice] ${err.message}`));
  logGpuInfo();
}

/** Stop child processes and release OS resources (bounded so quitting never hangs). */
async function shutdown() {
  try {
    globalShortcut.unregisterAll();
  } catch { /* ignore */ }
  const timeout = new Promise((r) => setTimeout(r, 5000));
  await Promise.race([
    Promise.allSettled([state.claude?.stop(), state.voice?.stop()]),
    timeout,
  ]);
  try {
    state.tray?.destroy();
  } catch { /* ignore */ }
  state.tray = null;
  state.log('info', '[main] shutdown complete');
}

// ---------------------------------------------------------------------------------------------
// Security

/** @param {import('electron').Session} ses */
function setupSessionSecurity(ses) {
  // CSP for documents served over http (dev server); app:// responses carry it themselves.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      callback({ responseHeaders: withCspHeader(details.responseHeaders, csp) });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const d = /** @type {any} */ (details);
    const ok = decidePermission(permission, { url: d.requestingUrl, mediaTypes: d.mediaTypes }, trust);
    if (!ok) state.log('info', `[security] denied permission "${permission}" for ${d.requestingUrl}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const d = /** @type {any} */ (details) || {};
    return decidePermission(permission, { url: requestingOrigin || d.requestingUrl, mediaType: d.mediaType }, trust);
  });
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
}

/** Block navigation away from the app, new windows and webviews. @param {import('electron').WebContents} contents */
function hardenWebContents(contents) {
  const guard = (/** @type {import('electron').Event} */ event, /** @type {string} */ url) => {
    if (isTrustedUrl(url, trust)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    else state.log('warn', `[security] blocked navigation to ${url}`);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------------------------
// Window

function appIcon() {
  const file = path.join(assetsDir, 'icon.png');
  const img = fs.existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createFromBuffer(renderIconPng(256));
  return img;
}

function createWindow() {
  const s = /** @type {SettingsStore} */ (state.settings).get();
  const primary = screen.getPrimaryDisplay();
  const layout = windowLayout(s.window.sizePreset, s.window.showChat, primary.workArea);
  const bounds = placeWindow({ saved: s.window.position, size: layout, displays: screen.getAllDisplays(), primary });

  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    thickFrame: false,
    skipTaskbar: !!s.window.skipTaskbar,
    alwaysOnTop: !!s.window.alwaysOnTop,
    title: 'Lawnmower Man',
    icon: appIcon(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(here, 'preload.cjs'),
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged || !!process.env.LAWNMOWER_DEVTOOLS,
    },
  });
  state.win = win;
  state.ignoreMouse = null;
  if (s.window.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');

  win.once('ready-to-show', () => {
    win.show();
    applyMouseIgnore(false);
  });
  let moveTimer = /** @type {NodeJS.Timeout|null} */ (null);
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, 400);
  });
  win.on('show', rebuildTray);
  win.on('hide', rebuildTray);
  win.on('closed', () => {
    if (state.win === win) state.win = null;
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    state.log('error', `[main] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (state.quitting || details.reason === 'clean-exit') return;
    if (++state.rendererCrashes <= 3) setTimeout(() => loadRenderer(win), 1000);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    state.log('error', `[main] failed to load ${url}: ${desc} (${code})`);
  });
  win.webContents.on('console-message', (/** @type {any} */ e, ...rest) => {
    // Electron ≥ 35 passes a details object; older versions pass (level, message, line, sourceId).
    const d = e && typeof e === 'object' && 'message' in e ? e : { level: rest[0], message: rest[1] };
    const lvl = d.level === 'error' || d.level === 3 ? 'warn' : 'debug';
    state.log(lvl, `[renderer] ${String(d.message).slice(0, 1000)}`);
  });
  if (!app.isPackaged || process.env.LAWNMOWER_DEVTOOLS) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      } else if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
        win.webContents.reload();
        event.preventDefault();
      }
    });
  }

  loadRenderer(win);
  return win;
}

/** @param {import('electron').BrowserWindow} win */
function loadRenderer(win) {
  const url = devServerUrl || `${APP_ORIGIN}/index.html`;
  win.loadURL(url).catch((err) => state.log('error', `[main] loadURL(${url}) failed: ${err.message}`));
}

/** @param {boolean} focus */
function showWindow(focus) {
  const win = state.win;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (focus) win.show();
  else win.showInactive();
  if (focus) win.focus();
}

function toggleVisible() {
  const win = state.win;
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow(true);
}

/**
 * Click-through: with settings.window.clickThrough on, the renderer reports whether the pointer
 * is over transparent pixels; we then pass clicks to the desktop but keep forwarding mouse moves
 * so it can tell when the pointer is back over the avatar. Starts interactive (fail-safe).
 * @param {boolean} wantIgnore
 */
function applyMouseIgnore(wantIgnore) {
  const win = state.win;
  if (!win || win.isDestroyed()) return;
  // Without forwarded mouse moves (Linux) the renderer could never turn interactivity back on.
  const allowed = CLICK_THROUGH_SUPPORTED && !!state.settings?.get().window.clickThrough;
  const ignore = allowed && wantIgnore;
  if (state.ignoreMouse === ignore) return;
  state.ignoreMouse = ignore;
  win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}

function savePosition() {
  const win = state.win;
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  state.settings?.update({ window: { position: { x: b.x, y: b.y } } });
}

function applyWindowLayout() {
  const win = state.win;
  if (!win || win.isDestroyed()) return;
  const s = /** @type {SettingsStore} */ (state.settings).get().window;
  const cur = win.getBounds();
  const display = screen.getDisplayMatching(cur);
  const layout = windowLayout(s.sizePreset, s.showChat, display.workArea);
  if (cur.width === layout.width && cur.height === layout.height) return;
  const next = resizeAnchored(cur, layout, display.workArea);
  // Some window managers ignore programmatic resizes of non-resizable windows.
  win.setResizable(true);
  win.setBounds(next);
  win.setResizable(false);
}

function reclampWindow() {
  const win = state.win;
  if (!win || win.isDestroyed()) return;
  const next = reclamp(win.getBounds(), screen.getAllDisplays(), screen.getPrimaryDisplay());
  win.setBounds(next);
}

/**
 * @param {import('./settings.js').Settings} next
 * @param {import('./settings.js').Settings} prev
 */
function onSettingsChanged(next, prev) {
  sendToRenderer('lm:settings:changed', next);
  const changed = (/** @type {keyof import('./settings.js').Settings} */ group) => JSON.stringify(next[group]) !== JSON.stringify(prev[group]);

  const { lastSessionId: _a, ...claudeNext } = next.claude;
  const { lastSessionId: _b, ...claudePrev } = prev.claude;
  if (JSON.stringify(claudeNext) !== JSON.stringify(claudePrev)) state.claude?.applySettings();
  if (changed('voice')) state.voice?.applySettings();
  if (changed('hotkeys')) {
    state.hotkeys?.apply(next.hotkeys);
  }
  const win = state.win;
  if (win && !win.isDestroyed() && changed('window')) {
    if (next.window.alwaysOnTop !== prev.window.alwaysOnTop) {
      win.setAlwaysOnTop(next.window.alwaysOnTop, 'floating');
    }
    if (next.window.skipTaskbar !== prev.window.skipTaskbar) win.setSkipTaskbar(next.window.skipTaskbar);
    if (next.window.clickThrough !== prev.window.clickThrough && !next.window.clickThrough) applyMouseIgnore(false);
    if (next.window.sizePreset !== prev.window.sizePreset || next.window.showChat !== prev.window.showChat) applyWindowLayout();
  }
  if (changed('window') || changed('claude') || changed('hotkeys')) rebuildTray();
}

// ---------------------------------------------------------------------------------------------
// Tray

function trayImage() {
  const file = path.join(assetsDir, 'tray.png');
  if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  const img = nativeImage.createFromBuffer(renderIconPng(32), { scaleFactor: 2 });
  return img;
}

function createTray() {
  try {
    state.tray = new Tray(trayImage());
  } catch (err) {
    state.log('warn', `[main] tray unavailable: ${/** @type {Error} */ (err).message}`);
    return;
  }
  state.tray.on('click', toggleVisible);
  rebuildTray();
}

const trayActions = {
  toggleVisible,
  setAlwaysOnTop: (/** @type {boolean} */ on) => state.settings?.update({ window: { alwaysOnTop: on } }),
  setClickThrough: (/** @type {boolean} */ on) => state.settings?.update({ window: { clickThrough: on } }),
  setShowChat: (/** @type {boolean} */ on) => state.settings?.update({ window: { showChat: on } }),
  setMode: (/** @type {string} */ mode) => state.settings?.update({ claude: { mode } }),
  setSizePreset: (/** @type {string} */ preset) => state.settings?.update({ window: { sizePreset: preset } }),
  newConversation: () => {
    state.claude?.reset().catch((err) => state.log('warn', `[claude] reset failed: ${err.message}`));
  },
  restartVoice: () => {
    state.voice?.restart();
  },
  openSettingsFile: () => {
    if (state.settings) shell.openPath(state.settings.file).catch(() => {});
  },
  openWorkdir: () => {
    const dir = resolveWorkdir(state.settings?.get().claude.workdir || '');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* openPath reports it */ }
    shell.openPath(dir).catch(() => {});
  },
  openLogs: () => {
    if (state.log.dir) shell.openPath(state.log.dir).catch(() => {});
  },
  quit: () => app.quit(),
};

function rebuildTray() {
  const tray = state.tray;
  if (!tray || !state.settings) return;
  const voiceInfo = state.voice ? state.voice.info() : { status: 'stopped' };
  const st = {
    visible: !!state.win && state.win.isVisible(),
    settings: state.settings.get(),
    claudeStatus: state.claudeStatus,
    claudeDetail: state.claudeDetail,
    voiceStatus: voiceInfo.status,
    voiceDetail: voiceInfo.detail,
    hotkeyConflicts: state.hotkeys ? state.hotkeys.conflicts : [],
  };
  try {
    tray.setContextMenu(Menu.buildFromTemplate(/** @type {any} */ (buildTrayTemplate(/** @type {any} */ (st), /** @type {any} */ (trayActions)))));
    tray.setToolTip(trayTooltip(/** @type {any} */ (st)));
  } catch (err) {
    state.log('warn', `[main] tray update failed: ${/** @type {Error} */ (err).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// IPC (window.lawnmower)

/** @param {string} channel @param {unknown} payload */
function sendToRenderer(channel, payload) {
  const win = state.win;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (err) {
    state.log('warn', `[ipc] send ${channel} failed: ${/** @type {Error} */ (err).message}`);
  }
}

/** Only our own window/page may call us. @param {import('electron').IpcMainEvent|import('electron').IpcMainInvokeEvent} event */
function assertTrustedSender(event) {
  const win = state.win;
  const frameUrl = event.senderFrame ? event.senderFrame.url : '';
  if (!win || event.sender !== win.webContents || !isTrustedUrl(frameUrl, trust)) {
    throw new Error('IPC from an untrusted sender was rejected');
  }
}

/** @param {string} channel @param {(...args: any[]) => any} fn */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return fn(...args);
  });
}

/** @param {string} channel @param {(...args: any[]) => void} fn */
function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedSender(event);
      fn(...args);
    } catch (err) {
      state.log('warn', `[ipc] ${channel}: ${/** @type {Error} */ (err).message}`);
    }
  });
}

function registerIpc() {
  const claude = /** @type {ClaudeSession} */ (state.claude);
  const voice = /** @type {VoiceSidecar} */ (state.voice);
  const settings = /** @type {SettingsStore} */ (state.settings);

  handle('lm:claude:send', (text) => claude.send(validateTurnText(text)));
  handle('lm:claude:interrupt', () => claude.interrupt());
  handle('lm:claude:reset', () => claude.reset());
  handle('lm:claude:respond-permission', (requestId, decision) => {
    const v = validatePermissionResponse(requestId, decision);
    claude.respondPermission(v.requestId, v.decision);
  });
  handle('lm:claude:status', () => claude.status());

  handle('lm:voice:info', () => voice.info());
  // Fire-and-forget: a restart can take minutes (model loading); progress arrives via onStatus.
  handle('lm:voice:restart', () => {
    voice.restart();
  });

  handle('lm:settings:get', () => settings.get());
  handle('lm:settings:set', (patch) => settings.update(validateSettingsPatch(patch)).settings);

  handle('lm:app:info', () => {
    const s = settings.get();
    return {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      // Extensions beyond the contract (renderer may ignore):
      layout: windowLayout(s.window.sizePreset, s.window.showChat),
      clickThroughSupported: CLICK_THROUGH_SUPPORTED,
      hotkeyConflicts: state.hotkeys ? state.hotkeys.conflicts : [],
      gpu: state.gpu,
      logFile: state.log.file,
    };
  });

  on('lm:window:set-ignore-mouse', (ignore) => applyMouseIgnore(validateBoolean(ignore, 'ignore')));
  on('lm:window:set-size-preset', (preset) => settings.update({ window: { sizePreset: validateSizePreset(preset) } }));
  on('lm:window:set-always-on-top', (onTop) => settings.update({ window: { alwaysOnTop: validateBoolean(onTop, 'alwaysOnTop') } }));
  on('lm:window:minimize', () => state.win?.minimize());
  on('lm:window:hide', () => state.win?.hide());
  on('lm:window:quit', () => app.quit());
}

// ---------------------------------------------------------------------------------------------

/** Log which GPU Chromium uses (the RTX should be active, WebGL2 hardware accelerated). */
function logGpuInfo() {
  Promise.resolve()
    .then(() => app.getGPUInfo('basic'))
    .then((/** @type {any} */ info) => {
      const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
      const active = devices.find((d) => d.active) || devices[0] || null;
      const vendors = { 4318: 'NVIDIA', 4098: 'AMD', 32902: 'Intel' };
      const status = app.getGPUFeatureStatus();
      state.gpu = {
        active: active
          ? { vendor: /** @type {any} */ (vendors)[active.vendorId] || active.vendorId, deviceId: active.deviceId, driver: active.driverVersion }
          : null,
        devices: devices.length,
        webgl2: status?.webgl2,
        rasterization: status?.rasterization,
      };
      state.log('info', `[gpu] ${JSON.stringify(state.gpu)}`);
    })
    .catch((err) => state.log('warn', `[gpu] info unavailable: ${err && err.message}`));
}

/** Internals for the smoke test only. */
export const __test = { state, csp, applyMouseIgnore, applyWindowLayout, onSettingsChanged, trayActions };
