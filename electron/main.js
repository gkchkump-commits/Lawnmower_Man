// Lawnmower Man — Electron main process (composition root).
//
// Responsibilities: single-instance app lifecycle, the transparent always-on-top avatar window,
// app:// protocol serving dist/, CSP + permission + navigation hardening, tray menu, global
// shortcuts, IPC for the window.lawnmower contract (docs/ARCHITECTURE.md §3), and supervision of
// the Claude CLI session and the local voice server.
//
// Dev/test environment overrides (all optional):
//   VITE_DEV_SERVER_URL        load the renderer from a loopback Vite dev server (ignored unless loopback)
//   LAWNMOWER_CLAUDE_CLI       explicit Claude CLI path (skips auto-detection)
//   LAWNMOWER_USER_DATA        alternative userData folder (portable / testing)
//   LAWNMOWER_VOICE_ARGS       extra args for the voice server (e.g. "--fake")
//   LAWNMOWER_AGENT_PERMISSION_MODE  e.g. "acceptEdits" for agent mode
//   LAWNMOWER_DEBUG=1          debug logging;  LAWNMOWER_DEVTOOLS=1  allow DevTools when packaged
//   LAWNMOWER_FORCE_CLICK_THROUGH=1  honour click-through on Linux too (no mouse-move forwarding there)
//   LAWNMOWER_E2E=1            expose a few main-process helpers to scripts/electron-e2e.mjs
//                              (globalThis.__lawnmowerE2E; main process only, never the renderer)
//
// These are honoured in packaged builds too, deliberately (scripts/electron-e2e.mjs --packaged
// drives the installed app with them). Threat model: the environment of a desktop process is set
// by the user who starts it, or by code that already runs as that user — and such code can just
// as well write settings.json (claude.cliPath and voice.pythonPath choose the programs we run),
// replace the CLI binary in %USERPROFILE%\.local\bin or start the app with its own flags. None of
// these variables crosses a privilege boundary or is reachable from the sandboxed renderer or a
// web page, so ignoring them when packaged would add no protection, only remove the test hook.

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
import { VoiceSidecar, packagedVoiceHome, voiceVenvDirs } from './voice-sidecar.js';
import { VoiceSetupRunner, setupLogPath, setupScriptPath } from './voice-setup.js';
import { refreshPathFromRegistry } from './claude-path.js';
import { CursorTracker } from './cursor-tracker.js';
import { windowLayout, placeWindow, resizeAnchored, reclamp, defaultBounds, dragBounds, settleDrop, DRAG_MAX_MS } from './window-manager.js';
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
  validateNoArgs,
  validatePermissionResponse,
  validateSettingsPatch,
  validateSetupOptions,
  validateSizePreset,
  validateTurnId,
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
  /** @type {VoiceSetupRunner|null} */ setup: null,
  /** @type {HotkeyManager|null} */ hotkeys: null,
  /** @type {CursorTracker|null} */ cursor: null,
  followCursor: true, // settings.avatar.followCursor, cached (read ~30 times a second)
  /** @type {ReturnType<typeof createLogger>} */ log: createLogger({ dir: null }),
  /** @type {boolean|null} */ ignoreMouse: null,
  /**
   * Window drag in progress (renderer pressed on the head): cursor and bounds at the press.
   * @type {{ from: {x:number,y:number}, start: {x:number,y:number,width:number,height:number}, moving: boolean, timer: NodeJS.Timeout, startedAt: number }|null}
   */
  drag: null,
  quitting: false,
  cleanedUp: false,
  rendererCrashes: 0,
  claudeStatus: 'starting',
  claudeDetail: '',
  /** @type {{ kind: string, detail: string }|null} */ claudeProblem: null,
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
  state.followCursor = settings.get().avatar.followCursor !== false;

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
    } else if (ev.type === 'problem') {
      state.claudeProblem = ev.problem || null;
      rebuildTray();
    }
  });
  state.claude = claude;

  // --- Voice ---
  // Packaged: the code ships in resources/voice, but the venv (and models) live in a per-user
  // folder (packagedVoiceHome) — the installer wipes the install directory on every update.
  const voiceDir = app.isPackaged ? path.join(process.resourcesPath, 'voice') : path.join(appRoot, 'voice');
  const voice = new VoiceSidecar({
    getSettings: () => settings.get().voice,
    voiceDir,
    venvDirs: voiceVenvDirs({ packaged: app.isPackaged, voiceDir }),
    log,
  });
  voice.on('status', () => {
    sendToRenderer('lm:voice:status', voiceInfo());
    rebuildTray();
  });
  state.voice = voice;

  // --- "Set up local voice…": the bundled setup script in a visible console window ---
  // The script logs every run to <voice home>/setup.log: the per-user folder of an installed app
  // (as packagedVoiceHome, where the script puts the venv), voice/ in a checkout.
  const voiceHome = app.isPackaged ? packagedVoiceHome() : voiceDir;
  const setup = new VoiceSetupRunner({
    script: setupScriptPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot }),
    statusFile: path.join(userData, 'voice-setup-status.json'),
    logFile: setupLogPath({ voiceHome }),
    beforeLaunch: async ({ check }) => {
      // The running voice server keeps files of the venv open (Windows locks them): stop it, and
      // keep it stopped — no restart, no crash backoff — until the setup has finished.
      if (!check) await voice.hold('setup');
    },
    log,
  });
  setup.on('state', () => {
    sendToRenderer('lm:voice:status', voiceInfo());
    rebuildTray();
  });
  setup.on('finished', (/** @type {any} */ r) => {
    if (r.check || setup.state.check) return; // a check run stopped nothing
    // Turn local voice on after a successful install (while the hold lasts, the settings change
    // does not start anything), then end the hold: that starts the new install — or brings back
    // the previous one after a failed or cancelled run.
    const enabling = r.ok && !settings.get().voice.enabled;
    if (enabling) settings.update({ voice: { enabled: true } });
    // Not held (beforeLaunch failed): turning voice on restarted it already, otherwise restart.
    if (!voice.release('setup') && !enabling) voice.restart();
  });
  state.setup = setup;

  // --- Global cursor follow (the eyes follow the mouse anywhere on the desktop) ---
  state.cursor = new CursorTracker({
    getPoint: () => screen.getCursorScreenPoint(),
    getOrigin: () => {
      const w = state.win;
      if (!w || w.isDestroyed()) return null;
      const b = w.getContentBounds();
      return { x: b.x, y: b.y };
    },
    isActive: () => cursorTrackingWanted(),
    send: (p) => sendToRenderer('lm:cursor', p),
  });

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
  endDrag();
  state.cursor?.stop();
  state.setup?.dispose(); // the setup window itself keeps running
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
    syncCursorTracking();
  });
  let moveTimer = /** @type {NodeJS.Timeout|null} */ (null);
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, 400);
  });
  const onVisibility = () => {
    endDrag();
    rebuildTray();
    syncCursorTracking();
  };
  win.on('show', onVisibility);
  win.on('hide', onVisibility);
  win.on('minimize', () => {
    endDrag();
    syncCursorTracking();
  });
  win.on('restore', syncCursorTracking);
  win.on('closed', () => {
    endDrag();
    if (state.win === win) state.win = null;
    syncCursorTracking();
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    state.log('error', `[main] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    // Fail safe: a click-through window with no live renderer could never turn interactive again
    // (and a drag it started could never end).
    endDrag();
    applyMouseIgnore(false);
    if (state.quitting || details.reason === 'clean-exit') return;
    if (++state.rendererCrashes <= 3) setTimeout(() => loadRenderer(win), 1000);
  });
  // Any (re)load — crash recovery, F5 in development — starts interactive; the new page turns
  // click-through on again once it has booted.
  win.webContents.on('did-start-loading', () => applyMouseIgnore(false));
  win.webContents.on('did-finish-load', () => state.cursor?.reset());
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
  // never click-through mid-drag: the button-up must reach the renderer
  const ignore = allowed && wantIgnore && !state.drag;
  if (state.ignoreMouse === ignore) return;
  state.ignoreMouse = ignore;
  win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
}

/** Poll the global cursor only while someone can see the eyes follow it. */
function cursorTrackingWanted() {
  const win = state.win;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
  return state.followCursor;
}

function syncCursorTracking() {
  if (!state.cursor) return;
  if (cursorTrackingWanted()) state.cursor.start();
  else state.cursor.stop();
}

/**
 * The renderer pressed the primary button on the head: follow the global cursor (~60 Hz) until
 * it reports the release. Moving starts only past DRAG_THRESHOLD, so a click stays a click.
 */
function startDrag() {
  const win = state.win;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  if (state.settings?.get().window.lockPosition) return;
  endDrag();
  applyMouseIgnore(false);
  const drag = {
    from: screen.getCursorScreenPoint(),
    start: win.getBounds(),
    moving: false,
    startedAt: Date.now(),
    timer: setInterval(() => stepDrag(), 16),
  };
  state.drag = drag;
}

function stepDrag() {
  const drag = state.drag;
  const win = state.win;
  if (!drag) return;
  if (!win || win.isDestroyed() || Date.now() - drag.startedAt > DRAG_MAX_MS) {
    endDrag();
    return;
  }
  const next = dragBounds(drag.start, drag.from, screen.getCursorScreenPoint(), drag.moving);
  if (!next) return;
  drag.moving = true;
  const cur = win.getBounds();
  // setBounds (not setPosition): on Windows with fractional display scaling setPosition can
  // grow the window by a pixel per call; fixed width/height keep the 2:3 avatar exact.
  if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) win.setBounds(next);
}

/** Pointer released (or the drag was abandoned): settle fully onto a display and save. */
function endDrag() {
  const drag = state.drag;
  if (!drag) return;
  clearInterval(drag.timer);
  state.drag = null;
  const win = state.win;
  if (!drag.moving || !win || win.isDestroyed()) return;
  stepDragFinal(win, drag);
}

/** @param {import('electron').BrowserWindow} win @param {NonNullable<typeof state.drag>} drag */
function stepDragFinal(win, drag) {
  const last = dragBounds(drag.start, drag.from, screen.getCursorScreenPoint(), true) || win.getBounds();
  const next = settleDrop(last, screen.getAllDisplays(), screen.getPrimaryDisplay());
  win.setBounds(next);
  savePosition();
}

/** "Reset position": back to the default corner of the display the window is on. */
function resetPosition() {
  const win = state.win;
  if (!win || win.isDestroyed()) return;
  endDrag();
  const b = win.getBounds();
  win.setBounds(defaultBounds({ width: b.width, height: b.height }, screen.getDisplayMatching(b).workArea));
  savePosition();
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

/** Work area of the display the window is on (primary before it exists). */
function currentWorkArea() {
  const win = state.win;
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return display.workArea;
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
  if (next.avatar.followCursor !== prev.avatar.followCursor) {
    state.followCursor = next.avatar.followCursor !== false;
    syncCursorTracking();
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
  setLockPosition: (/** @type {boolean} */ on) => state.settings?.update({ window: { lockPosition: on } }),
  resetPosition: () => resetPosition(),
  newConversation: () => {
    state.claude?.reset().catch((err) => state.log('warn', `[claude] reset failed: ${err.message}`));
  },
  restartVoice: () => {
    state.voice?.restart();
  },
  setupVoice: () => {
    runVoiceSetup().catch((err) => state.log('warn', `[voice-setup] ${err.message}`));
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
  const vinfo = state.voice ? state.voice.info() : { status: 'stopped' };
  const st = {
    visible: !!state.win && state.win.isVisible(),
    settings: state.settings.get(),
    claudeStatus: state.claudeStatus,
    claudeDetail: state.claudeDetail,
    voiceStatus: vinfo.status,
    voiceDetail: vinfo.detail,
    voiceInstalled: vinfo.installed,
    voiceSetup: state.setup ? state.setup.state.state : 'idle',
    claudeProblem: state.claudeProblem ? state.claudeProblem.kind : '',
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
  handle('lm:claude:cancel', (turnId) => claude.cancel(validateTurnId(turnId)));
  handle('lm:claude:interrupt', () => claude.interrupt());
  handle('lm:claude:reset', () => claude.reset());
  handle('lm:claude:respond-permission', (requestId, decision) => {
    const v = validatePermissionResponse(requestId, decision);
    claude.respondPermission(v.requestId, v.decision);
  });
  handle('lm:claude:status', () => claude.status());
  handle('lm:claude:retry', () => retryClaude());

  handle('lm:voice:info', () => voiceInfo());
  // Opens the setup in its own window and returns at once; progress arrives via onStatus.
  handle('lm:voice:setup', (opts) => runVoiceSetup(validateSetupOptions(opts)));
  // "Open setup log": no arguments — only ever the setup log of this app's voice home.
  handle('lm:voice:open-setup-log', (...args) => {
    validateNoArgs(args);
    return openSetupLog();
  });
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
      layout: windowLayout(s.window.sizePreset, s.window.showChat, currentWorkArea()),
      clickThroughSupported: CLICK_THROUGH_SUPPORTED,
      hotkeyConflicts: state.hotkeys ? state.hotkeys.conflicts : [],
      gpu: state.gpu,
      logFile: state.log.file,
    };
  });

  on('lm:window:set-ignore-mouse', (ignore) => applyMouseIgnore(validateBoolean(ignore, 'ignore')));
  on('lm:window:set-size-preset', (preset) => settings.update({ window: { sizePreset: validateSizePreset(preset) } }));
  on('lm:window:set-always-on-top', (onTop) => settings.update({ window: { alwaysOnTop: validateBoolean(onTop, 'alwaysOnTop') } }));
  on('lm:window:drag-start', (...args) => {
    validateNoArgs(args);
    startDrag();
  });
  on('lm:window:drag-end', (...args) => {
    validateNoArgs(args);
    endDrag();
  });
  on('lm:window:reset-position', (...args) => {
    validateNoArgs(args);
    resetPosition();
  });
  on('lm:window:minimize', () => state.win?.minimize());
  on('lm:window:hide', () => state.win?.hide());
  on('lm:window:quit', () => app.quit());
}

// ---------------------------------------------------------------------------------------------
// First-run helpers: Claude CLI "Retry", local voice setup

/**
 * The voice status for the renderer: the sidecar's info plus the setup window's state, and
 * `setupLog` (its path) when the setup has written a log.
 */
function voiceInfo() {
  /** @type {Record<string, any>} */
  const info = state.voice ? state.voice.info() : { status: 'stopped' };
  const log = state.setup ? state.setup.existingLog() : null;
  if (log) info.setupLog = log;
  const st = state.setup ? state.setup.state : null;
  if (st && st.state !== 'idle') {
    /** @type {Record<string, any>} */
    const setup = { state: st.state, detail: st.detail || '', cpu: !!st.cpu };
    if (st.mode) setup.mode = st.mode;
    if (st.command) setup.command = st.command;
    if (st.errorTail && st.errorTail.length) setup.errorTail = st.errorTail;
    return { ...info, setup };
  }
  return info;
}

/**
 * "Open setup log" (settings drawer): the log of the current voice home, in the user's text
 * editor. Never a path from the renderer or the status file: only the one main computed, and only
 * when it is a regular file.
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
async function openSetupLog() {
  const file = state.setup ? state.setup.existingLog() : null;
  if (!file) return { ok: false, error: 'There is no setup log yet. It is written when "Set up local voice…" runs.' };
  const err = await shell.openPath(file);
  if (err) {
    state.log('warn', `[voice-setup] could not open ${file}: ${err}`);
    return { ok: false, path: file, error: err };
  }
  return { ok: true, path: file };
}

/** "Retry" on the Claude setup card: see a CLI installed since start-up, then restart it. */
async function retryClaude() {
  if (process.platform === 'win32') {
    const added = await refreshPathFromRegistry().catch(() => []);
    if (added.length) state.log('info', `[claude] PATH refreshed from the registry: +${added.join(';')}`);
  }
  await /** @type {ClaudeSession} */ (state.claude).retry();
}

/** NVIDIA GPU present? null when Chromium cannot tell. @returns {Promise<boolean|null>} */
async function hasNvidiaGpu() {
  if (state.gpu && typeof state.gpu.nvidia === 'boolean') return state.gpu.nvidia;
  try {
    const info = /** @type {any} */ (await app.getGPUInfo('basic'));
    const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
    return devices.length ? devices.some((/** @type {any} */ d) => d.vendorId === 0x10de) : null;
  } catch {
    return null;
  }
}

/**
 * Tray / settings drawer "Set up local voice…". Without an NVIDIA GPU the CPU version is
 * installed (no 1.8 GB of CUDA wheels); when that is unknown the script asks.
 * @param {{ cpu?: boolean, check?: boolean }} [opts]
 */
async function runVoiceSetup(opts = {}) {
  const setup = /** @type {VoiceSetupRunner} */ (state.setup);
  const cpu = typeof opts.cpu === 'boolean' ? opts.cpu : (await hasNvidiaGpu()) === false;
  const r = await setup.start({ cpu, check: !!opts.check });
  if (r.state === 'running' && !r.already) showWindow(false);
  return r;
}

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
        nvidia: devices.length ? devices.some((/** @type {any} */ d) => d.vendorId === 0x10de) : undefined,
        webgl2: status?.webgl2,
        rasterization: status?.rasterization,
      };
      state.log('info', `[gpu] ${JSON.stringify(state.gpu)}`);
    })
    .catch((err) => state.log('warn', `[gpu] info unavailable: ${err && err.message}`));
}

/** Internals for the smoke test only. */
export const __test = { state, csp, applyMouseIgnore, applyWindowLayout, startDrag, stepDrag, endDrag, resetPosition, onSettingsChanged, trayActions, syncCursorTracking, runVoiceSetup, retryClaude, voiceInfo, openSetupLog };

// scripts/electron-e2e.mjs (also against the packaged app): main-process helpers it can reach
// through Playwright's app.evaluate(). Only with LAWNMOWER_E2E=1 (see the threat model above).
if (process.env.LAWNMOWER_E2E === '1') {
  /** @type {any} */ (globalThis).__lawnmowerE2E = {
    packaged: () => app.isPackaged,
    resourcesPath: () => process.resourcesPath,
    voiceVenvDirs: () => (state.voice ? /** @type {any} */ (state.voice)._venvDirs.slice() : []),
    setupScript: () => (state.setup ? /** @type {any} */ (state.setup)._o.script : ''),
    voiceSetupCheck: () => runVoiceSetup({ check: true }),
    voiceSetup: (/** @type {{ cpu?: boolean }} */ o) => runVoiceSetup({ cpu: !!(o && o.cpu) }),
    voiceInfo: () => voiceInfo(),
    voiceSetupState: () => (state.setup ? state.setup.state : null),
  };
}
