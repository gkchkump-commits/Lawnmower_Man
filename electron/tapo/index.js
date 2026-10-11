// createTapo(): the home camera feature for electron/main.js (contract §3.2, §8.11). It builds
// the TapoService, the "Home camera" window, notifications and the IPC channels, and hands
// main.js what it wires: the app:// clip mount, the MCP server for ClaudeSession, the tray
// entries, settings changes and shutdown. Electron objects come in through `o.electron`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers';

import { CredentialStore } from './credentials.js';
import { TapoService, defaultClipsDir } from './tapo-service.js';
import { AlertManager } from './alerts.js';
import { createCameraWindow, cameraWindowUrl } from './camera-window.js';
import { registerTapoIpc } from './ipc.js';
import { go2rtcBinaryPath } from './go2rtc.js';

/** The app:// clip mount: our clip and snapshot names only (contract §8.7). */
export const CLIP_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{6}-(person|motion|tamper)-[a-z0-9]{4}\.(mp4|jpg)$/;
const LOOK_HOLD_MS = 4000;

/**
 * Where the camera window's worker loads the MediaPipe runtime and the person model from.
 * @param {string|null|undefined} devServerUrl
 */
export function detectorAssets(devServerUrl) {
  const base = devServerUrl || 'app://lawnmower/';
  return { wasmBase: `${base}assets/vision/wasm/`, modelUrl: `${base}assets/security/efficientdet_lite0_int8.tflite` };
}

/**
 * @typedef {object} CreateTapoOptions
 * @property {{ app: any, ipcMain: any, safeStorage: any, Notification: any, nativeImage: any, shell: any, screen: any, BrowserWindow: any, MessageChannelMain: any, dialog?: any,
 *   powerSaveBlocker?: any, powerMonitor?: any }} electron
 * @property {any} settings                    the SettingsStore (get / update)
 * @property {(level: string, msg: string) => void} log
 * @property {string} userData
 * @property {string} appRoot
 * @property {string} [resourcesPath]
 * @property {boolean} isPackaged
 * @property {string|null} [devServerUrl]
 * @property {{ devServerUrl?: string|null }} [trust]
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [appVersion]
 * @property {string} preloadCamera            path of electron/preload-camera.cjs
 * @property {(event: any, kinds: Array<'avatar'|'camera'>) => void} isTrustedSender   throws when not allowed
 * @property {() => any} getAvatarWindow
 * @property {(channel: string, payload: unknown) => void} sendToAvatar
 * @property {() => void} showAvatar           bring the avatar back without focus
 * @property {any} [icon]
 * @property {string} [platform]               process.platform (tests)
 */

/** @param {CreateTapoOptions} o */
export function createTapo(o) {
  const { app, ipcMain, safeStorage, Notification, nativeImage, shell, screen, BrowserWindow, MessageChannelMain, powerSaveBlocker, powerMonitor } = o.electron;
  const env = o.env || process.env;
  const log = o.log;
  const settings = o.settings;
  const configDir = path.join(o.userData, 'tapo');
  let videos;
  try {
    videos = app.getPath('videos');
  } catch {
    videos = path.join(os.homedir(), 'Videos');
  }
  let quitting = false;
  app.on?.('before-quit', () => { quitting = true; });

  const credentials = new CredentialStore({ dir: configDir, safeStorage, log });
  /** @type {import('./camera-window.js').CameraWindow|null} */
  let cam = null;

  const alerts = new AlertManager({
    Notification,
    nativeImage,
    log,
    record: env.LAWNMOWER_E2E === '1',
    onClick: (eventId) => {
      const w = ensureWindow();
      w?.show({ focus: true });
      if (eventId) sendToCamera('lm:tapo:open-event', { id: eventId });
    },
  });

  const service = new TapoService({
    settings,
    credentials,
    paths: { configDir, defaultClipsDir: defaultClipsDir(videos) },
    deps: {
      go2rtcBinary: go2rtcBinaryPath({ isPackaged: o.isPackaged, resourcesPath: o.resourcesPath, appRoot: o.appRoot, env }),
      MessageChannelMain,
      alerts,
      openPath: (p) => shell.openPath(p),
      detector: env.LAWNMOWER_TAPO_FAKE_DETECTOR === '1' ? 'stub' : 'mediapipe',
      assets: detectorAssets(o.devServerUrl),
    },
    log,
    env,
    appVersion: o.appVersion,
  });

  /** @param {string} channel @param {unknown} payload */
  function sendToCamera(channel, payload) {
    const wc = cam?.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed?.()) return; // a crashed page reloads and asks again
    try {
      wc.send(channel, payload);
    } catch (err) {
      log('warn', `[ipc] send ${channel} to the camera window failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  // --- the camera window -------------------------------------------------------------------
  let windowVisible = false;
  let pageView = true; // the page reports when its live view is not on screen (setup open)
  const updateView = () => service.setViewVisible(windowVisible && pageView);

  /** The avatar glances toward the camera window (avatar-window CSS px). */
  function lookAtCamera() {
    const aw = o.getAvatarWindow();
    if (!aw || aw.isDestroyed?.() || !cam || !cam.visible()) return;
    const a = aw.getContentBounds();
    const c = cam.center();
    o.sendToAvatar('lm:tapo:look', { x: Math.round(c.x - a.x), y: Math.round(c.y - a.y), holdMs: LOOK_HOLD_MS });
  }

  function ensureWindow() {
    if (cam) return cam;
    const t = settings.get().tapo;
    if (!t.enabled) return null;
    cam = createCameraWindow({
      BrowserWindow,
      preload: o.preloadCamera,
      url: cameraWindowUrl(o.devServerUrl),
      bounds: t.windowBounds,
      onTop: t.windowOnTop,
      title: `Home camera — ${service.cameraName()}`,
      devTools: !o.isPackaged || !!env.LAWNMOWER_DEVTOOLS,
      icon: o.icon,
      screen,
      isQuitting: () => quitting,
      log,
    });
    const w = cam;
    w.on('visibility', (/** @type {boolean} */ v) => {
      windowVisible = v;
      updateView();
      if (v) lookAtCamera();
      else service.stopHold('camera window hidden');
    });
    w.on('blur', () => service.stopHold('camera window blur'));
    w.on('gone', () => service.stopHold('camera window renderer gone'));
    w.on('bounds', (/** @type {any} */ b) => settings.update({ tapo: { windowBounds: b } }));
    w.on('load', () => { pageView = true; });
    w.on('closed', () => {
      if (cam === w) cam = null;
      windowVisible = false;
      updateView();
    });
    return w;
  }

  function destroyWindow() {
    const w = cam;
    cam = null;
    windowVisible = false;
    updateView();
    w?.destroy();
  }

  // --- the PC itself (review: an armed camera stopped watching when Windows slept) -----------
  // While armed (or arming) the PC must not go to sleep: nothing would watch the camera then.
  /** @type {number|null} */
  let blocker = null;
  const syncPower = () => {
    const want = !!(settings.get().tapo.enabled && service.engine.state.armed);
    try {
      if (want && blocker === null && powerSaveBlocker) {
        blocker = powerSaveBlocker.start('prevent-app-suspension');
        log('info', '[tapo] armed: keeping the PC awake');
      } else if (!want && blocker !== null) {
        powerSaveBlocker?.stop(blocker);
        blocker = null;
        log('info', '[tapo] disarmed: the PC may sleep again');
      }
    } catch (err) {
      log('warn', `[tapo] power save blocker: ${/** @type {Error} */ (err).message}`);
    }
  };
  // after sleep the connection is stale: reconnect at once
  const onResume = () => service.onResume();
  powerMonitor?.on?.('resume', onResume);
  /** "Start Lawnmower Man with Windows" (security.startAtLogin): hidden, in the tray; installed builds only. */
  const syncLogin = () => {
    if (!o.isPackaged || typeof app.setLoginItemSettings !== 'function' || !['win32', 'darwin'].includes(o.platform || process.platform)) return;
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.get().security.startAtLogin, args: ['--hidden'] });
    } catch (err) {
      log('warn', `[tapo] start with Windows: ${/** @type {Error} */ (err).message}`);
    }
  };
  syncLogin();

  // --- service → windows -------------------------------------------------------------------
  service.on('status', (/** @type {any} */ st) => {
    o.sendToAvatar('lm:tapo:status', st);
    sendToCamera('lm:tapo:status', st);
    cam?.setTitle(st.name);
    syncPower();
  });
  service.on('security-event', (/** @type {any} */ e) => sendToCamera('lm:tapo:event', e));
  service.on('calibration', (/** @type {any} */ st) => sendToCamera('lm:tapo:calibration', st));
  service.on('alert', (/** @type {any} */ alert, /** @type {{ showAvatar?: boolean }} */ opts = {}) => {
    if (opts.showAvatar) o.showAvatar();
    o.sendToAvatar('lm:tapo:alert', alert);
    if (opts.showAvatar) lookAtCamera();
  });

  const unregisterIpc = registerTapoIpc({
    ipcMain,
    isTrustedSender: o.isTrustedSender,
    service: /** @type {any} */ ({
      // the service, plus the camera window's own view state for lm:tapo:view
      ...bind(service),
      setViewVisible: (/** @type {boolean} */ v) => {
        pageView = !!v;
        updateView();
      },
    }),
    onWindow: ({ show, eventId }) => {
      if (!show) {
        cam?.hide();
        return;
      }
      const w = ensureWindow();
      if (!w) throw new Error('Turn the home camera on first (Settings › Home camera).');
      w.show({ focus: true });
      if (eventId) sendToCamera('lm:tapo:open-event', { id: eventId });
    },
    log,
  });

  // --- start -------------------------------------------------------------------------------
  // The window opens on the next turn of the event loop: main.js registers the app:// protocol
  // (with protocolMounts()) right after createTapo(), and the camera page loads through it.
  setImmediate(() => {
    if (!quitting && !cam && settings.get().tapo.enabled) ensureWindow();
  });
  const ready = service.start().catch((err) => log('error', `[tapo] start failed: ${err && err.stack ? err.stack : err}`));

  const trayActions = {
    tapoShow: () => {
      if (!settings.get().tapo.enabled) settings.update({ tapo: { enabled: true } });
      const w = ensureWindow();
      w?.show({ focus: true });
    },
    tapoArm: (/** @type {boolean} */ on) => {
      try {
        service.arm({ armed: !!on, immediate: false });
      } catch (err) {
        log('warn', `[tapo] arm: ${/** @type {Error} */ (err).message}`);
      }
    },
    tapoOpenClips: () => {
      service.openClips().then((r) => { if (!r.ok) log('warn', `[tapo] open clips: ${r.error}`); }).catch(() => {});
    },
  };

  return {
    service,
    ready,
    /** The camera window (main.js: isTrustedSender 'camera', lm:settings:changed). */
    cameraWindow: () => (cam && !cam.win.isDestroyed() ? cam.win : null),
    /** For createAppProtocolHandler({ mounts }). */
    protocolMounts: () => [{ prefix: '/__clips/', getRoot: () => service.clipsDir(), pattern: CLIP_PATTERN, range: true }],
    /**
     * For ClaudeSession({ getSdkMcpServers }): [] unless the camera is on and set up. Each server:
     * { name: 'lawnmower-camera', handle(msg): Promise<object|null>, startHttp(): Promise<{ url, token }>, stopHttp(): Promise<void> }.
     */
    mcpServers: () => (settings.get().tapo.enabled && service.configured() ? [service.mcpServer()] : []),
    toolPermissions: () => service.toolPermissions(),
    personaContext: () => service.personaContext(),
    /** main.js onSettingsChanged. @param {any} next @param {any} prev */
    applySettings: (next, prev) => {
      service.applySettings(next, prev);
      syncPower();
      if (next.security.startAtLogin !== prev?.security?.startAtLogin) syncLogin();
      if (next.tapo.enabled && !cam) ensureWindow();
      if (!next.tapo.enabled && cam) destroyWindow();
      if (cam && next.tapo.windowOnTop !== prev?.tapo?.windowOnTop) cam.setOnTop(next.tapo.windowOnTop);
      if (cam && next.tapo.name !== prev?.tapo?.name) cam.setTitle(next.tapo.name);
    },
    /** TrayState.tapo */
    trayState: () => {
      const st = service.status();
      return { enabled: st.enabled, configured: st.configured, connection: st.connection, armed: st.security.armed, arming: st.security.arming, watching: st.security.watching, name: st.name };
    },
    trayActions,
    /** Bounded (≈ 4 s): Stop PTZ, Unsubscribe, finish the clip, kill go2rtc; then the window. */
    stop: async () => {
      quitting = true;
      await service.stop();
      unregisterIpc();
      powerMonitor?.removeListener?.('resume', onResume);
      if (blocker !== null) {
        try { powerSaveBlocker?.stop(blocker); } catch { /* gone */ }
        blocker = null;
      }
      destroyWindow();
    },
    /** Quitting would leave an armed camera unwatched (main.js asks first). */
    isArmed: () => !!(settings.get().tapo.enabled && service.engine.state.armed),
    /** scripts/tapo-e2e.mjs (LAWNMOWER_E2E=1 only; main.js adds it to globalThis.__lawnmowerE2E). */
    e2e: {
      status: () => service.status(),
      trayState: () => {
        const st = service.status();
        return { enabled: st.enabled, configured: st.configured, connection: st.connection, armed: st.security.armed, arming: st.security.arming, watching: st.security.watching, name: st.name };
      },
      go2rtcEnviron: () => {
        const pid = service.sidecar.pid;
        try {
          return pid && process.platform === 'linux' ? fs.readFileSync(`/proc/${pid}/environ`, 'utf8') : null;
        } catch {
          return null;
        }
      },
      notifications: () => alerts.shown.slice(),
      setPassword: (/** @type {string} */ pw) => service.setCredentials({ username: settings.get().tapo.username, password: pw }),
      clipsDir: () => service.clipsDir(),
      workerStats: () => service.workerStats(),
      go2rtcPid: () => service.sidecar.pid,
      credentialsFile: () => path.join(configDir, 'credentials.json'),
      hasClipsDir: () => fs.existsSync(service.clipsDir()),
    },
  };
}

/** The service's methods bound to it (for the IPC adapter). @param {any} s */
function bind(s) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of ['status', 'setCredentials', 'clearCredentials', 'test', 'discover', 'ptz', 'presets', 'savePreset', 'removePreset', 'arm', 'calibrate', 'listEvents', 'removeEvent', 'ackEvent', 'openClips', 'attachWorker', 'retry', 'diagnostics']) {
    out[k] = s[k].bind(s);
  }
  return out;
}
