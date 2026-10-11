// createWake(): the "Hey Jade" wake word's main-process side for electron/main.js
// (contract-wake §3.2, §7.1). It supervises the "Jade wake word" utility process (stage 1:
// sherpa-onnx keyword spotting on the avatar window's microphone audio, which reaches it over a
// direct MessagePort), fetches the extra zh-en model on the user's PC through the voice package,
// forwards lock/unlock/sleep to the avatar window, answers the lm:wake:* IPC channels and gives
// main.js the tray entry, the persona context and the e2e hooks. Electron objects are injected.
//
// The utility runs only while settings.wake.enabled is on (no cost otherwise). Stage 2 (Whisper on
// the GPU), the listening state machine, the earcons and the UI are the renderer's (src/wake/).

import { EventEmitter } from 'node:events';
import path from 'node:path';

import { LAYOUT, SHERPA_VERSION, buildConfig } from './config.js';
import { WakeHost, SERVICE_NAME } from './host.js';
import { ZhenManager } from './zhen.js';
import { addonPath, checkFiles, checkZhen, enginePaths, modelFiles, platformKey, resolveWakeDir, zhenDir } from './paths.js';
import { registerWakeIpc } from './ipc.js';
import { watchPower } from './power.js';
import { micAccessStatus, openMicSettings } from './mic-access.js';
import { saveTestClip } from './clips.js';
import { locatePython } from '../voice-sidecar.js';

/** The engine status is sent to the avatar at most this often; the tray state half as often. */
const STATUS_MIN_MS = 250;
const TRAY_MIN_MS = 500;
/** How long a start waits for the voice package's "is model A there?" before running on B alone. */
const ZHEN_CHECK_WAIT_MS = 5000;

/**
 * @typedef {object} WakeEngineStatus  (contract §6.4)
 * @property {'off'|'starting'|'ready'|'missing'|'error'} engine
 * @property {string} detail
 * @property {{ giga: 'ok'|'missing', zhen: 'ok'|'missing'|'downloading'|'failed'|'unavailable', vad: 'ok'|'missing' }} models
 * @property {string} version
 * @property {string} platform
 * @property {number} [loadMs]
 * @property {number} [cpuMsPerSecSpeech]
 * @property {number} restarts
 * @property {number} portGen
 * @property {{ locked: boolean, suspended: boolean, seq: number }} power  the PC's lock and sleep (a reloaded window starts from it)
 */

/**
 * @typedef {object} CreateWakeOptions
 * @property {{ app: any, ipcMain: any, utilityProcess: any, MessageChannelMain: any, powerMonitor?: any, systemPreferences?: any, shell: any }} electron
 * @property {any} settings                 the SettingsStore (get / update)
 * @property {(level: string, msg: string) => void} log
 * @property {string} userData
 * @property {string} appRoot                the app folder (inside app.asar when packaged)
 * @property {string} [resourcesPath]
 * @property {boolean} isPackaged
 * @property {Record<string, string|undefined>} [env]
 * @property {{ voiceDir: string, venvDirs: string[], getVoiceSettings: () => { enabled: boolean, pythonPath?: string } }} voice
 * @property {(event: any, kinds: Array<'avatar'|'camera'>) => void} isTrustedSender   throws when not allowed
 * @property {() => any} getAvatarWindow
 * @property {(channel: string, payload: unknown) => void} sendToAvatar
 * @property {() => void} showAvatar          bring the avatar back without focus
 * @property {string} [platform]              process.platform (tests)
 * @property {string} [arch]                  process.arch (tests)
 * @property {any} [zhen]                     a ZhenManager (tests)
 */

/** @param {CreateWakeOptions} o */
export function createWake(o) {
  const { app, ipcMain, utilityProcess, MessageChannelMain, powerMonitor, systemPreferences, shell } = o.electron;
  const env = o.env || process.env;
  const log = o.log;
  const settings = o.settings;
  const platform = o.platform || process.platform;
  const key = platformKey(platform, o.arch || process.arch);
  const wakeDir = resolveWakeDir({ isPackaged: o.isPackaged, resourcesPath: o.resourcesPath, appRoot: o.appRoot, env });
  const entry = path.join(o.appRoot, 'electron', 'wake', 'utility', 'main.js');
  /** @type {EventEmitter & Record<string, any>} */
  const svc = /** @type {any} */ (new EventEmitter());

  const host = new WakeHost({ utilityProcess, MessageChannelMain, entry, env, log });
  const zhen = o.zhen || new ZhenManager({
    locate: () => {
      const v = o.voice.getVoiceSettings();
      const r = locatePython({ pythonPath: v?.pythonPath || '', venvDirs: o.voice.venvDirs, platform });
      return r.python ? { python: r.python, cwd: o.voice.voiceDir } : null;
    },
    voiceEnabled: () => o.voice.getVoiceSettings()?.enabled !== false,
    env,
    log,
  });

  let files = checkFiles(wakeDir, { key });
  /** model A's folder of the running utility (null = B only) @type {string|null} */
  let runningZhen = null;
  let startSeq = 0;
  /** @type {{ state: string, reason: string }|null} */
  let uiState = null;
  let stopped = false;

  // --- the PC itself ---------------------------------------------------------------------------
  // (first: the engine status carries its snapshot)
  const power = watchPower(powerMonitor, (state, seq) => o.sendToAvatar('lm:wake:power', { state, seq }));

  const wake = () => settings.get().wake;
  const params = () => ({ sensitivity: wake().sensitivity, phrase: wake().phrase });

  /** @param {string|null} zdir */
  function initFor(zdir) {
    const p = enginePaths(wakeDir, key);
    return {
      addon: p.addon,
      models: { giga: p.giga, vad: p.vad, zhen: zdir ? modelFiles(zdir, 'zhen') : null },
      params: params(),
      config: buildConfig({ ...params(), hasZhen: !!zdir }),
    };
  }

  // --- the engine ------------------------------------------------------------------------------
  async function startEngine() {
    if (stopped || !wake().enabled) return;
    const seq = ++startSeq;
    files = checkFiles(wakeDir, { key });
    if (!files.ok) {
      log('warn', `[wake] the wake-word engine is incomplete in ${wakeDir}: ${files.missing.join(', ')}`);
      emitStatus();
      return;
    }
    let dir = zhenDir({ env, isPackaged: o.isPackaged, wakeDir, voiceModelsDir: zhen.modelsDir });
    if (dir) zhen.useDir(dir);
    /** @type {Promise<string|null>|null} */
    let checking = null;
    if (!dir) {
      checking = zhen.check().catch(() => null);
      const quick = await Promise.race([checking, new Promise((r) => setTimeout(() => r(undefined), ZHEN_CHECK_WAIT_MS))]);
      if (seq !== startSeq || stopped || !wake().enabled) return;
      if (typeof quick === 'string' && checkZhen(quick)) {
        dir = quick;
        checking = null;
      }
    }
    runningZhen = dir;
    host.start(initFor(dir));
    if (!dir && checking) {
      checking.then((late) => {
        if (seq !== startSeq || stopped || !wake().enabled) return;
        if (late && checkZhen(late)) useZhen(late);
        else if (zhen.state === 'missing') zhen.download({ auto: true });
      });
    }
    emitStatus();
  }

  /** Model A became available: restart the utility with it. @param {string} dir */
  function useZhen(dir) {
    if (stopped || !wake().enabled || runningZhen === dir || !checkZhen(dir)) return;
    runningZhen = dir;
    log('info', `[wake] restarting the wake-word engine with the zh-en model (${dir})`);
    host.restart(initFor(dir));
  }

  async function stopEngine() {
    startSeq++;
    runningZhen = null;
    await host.stop();
  }

  zhen.on('ready', (/** @type {string} */ dir) => useZhen(dir));
  zhen.on('change', () => emitStatus());
  host.on('status', () => emitStatus());
  host.on('stats', () => emitStatus());

  // --- status ----------------------------------------------------------------------------------
  /** @returns {WakeEngineStatus['models']['zhen']} */
  function zhenState() {
    if (runningZhen && host.models.includes('zhen')) return 'ok';
    const s = zhen.state;
    return s === 'ok' || s === 'downloading' || s === 'failed' || s === 'unavailable' ? s : 'missing';
  }

  /** @returns {WakeEngineStatus} */
  function status() {
    const w = wake();
    const z = zhenState();
    const miss = (/** @type {string} */ rel) => files.missing.some((m) => m.startsWith(rel));
    /** @type {WakeEngineStatus['engine']} */
    let engine;
    let detail;
    if (!w.enabled) {
      engine = 'off';
      detail = 'The wake word is off.';
    } else if (!files.ok) {
      engine = 'missing';
      detail = files.platformSupported
        ? 'The wake-word engine is not installed; reinstall Lawnmower Man.'
        : `The wake-word engine is not available for this computer (${key}).`;
    } else if (host.state === 'ready') {
      engine = 'ready';
      detail = z === 'ok' ? 'Listening for "Hey Jade" with both wake-word models.'
        : z === 'downloading' ? 'Using the basic wake-word model; the extra one is downloading.'
          : z === 'failed' ? 'Using the basic wake-word model; the extra one could not be downloaded.'
            : 'Using the basic wake-word model.';
    } else if (host.state === 'error') {
      engine = 'error';
      detail = host.detail || 'The wake-word engine stopped; see the log.';
    } else {
      engine = 'starting';
      detail = host.detail || 'The wake-word engine is starting.';
    }
    /** @type {WakeEngineStatus} */
    const st = {
      engine,
      detail,
      models: { giga: miss(LAYOUT.gigaDir) ? 'missing' : 'ok', zhen: z, vad: miss(LAYOUT.vad) ? 'missing' : 'ok' },
      version: SHERPA_VERSION,
      platform: key,
      restarts: host.restarts,
      portGen: host.gen,
      power: power.snapshot(),
    };
    if (host.loadMs !== undefined) st.loadMs = host.loadMs;
    if (typeof host.stats?.cpuMsPerSecSpeech === 'number' && host.stats.activeSec > 0) st.cpuMsPerSecSpeech = host.stats.cpuMsPerSecSpeech;
    return st;
  }

  let lastSent = '';
  let lastSentAt = 0;
  /** @type {NodeJS.Timeout|null} */
  let statusTimer = null;
  function emitStatus() {
    svc.emit('status');
    if (statusTimer) return;
    const wait = Math.max(0, lastSentAt + STATUS_MIN_MS - Date.now());
    statusTimer = setTimeout(() => {
      statusTimer = null;
      const st = status();
      const s = JSON.stringify(st);
      if (s === lastSent) return;
      lastSent = s;
      lastSentAt = Date.now();
      o.sendToAvatar('lm:wake:status', st);
    }, wait);
  }

  /** @type {NodeJS.Timeout|null} */
  let trayTimer = null;
  let trayAt = 0;
  /** @param {{ state: string, reason: string }} st */
  function reportState(st) {
    const same = uiState && uiState.state === st.state && uiState.reason === st.reason;
    uiState = st;
    if (same || trayTimer) return;
    const wait = Math.max(0, trayAt + TRAY_MIN_MS - Date.now());
    trayTimer = setTimeout(() => {
      trayTimer = null;
      trayAt = Date.now();
      svc.emit('status');
    }, wait);
  }

  // --- IPC -------------------------------------------------------------------------------------
  const unregisterIpc = registerWakeIpc({
    ipcMain,
    isTrustedSender: o.isTrustedSender,
    log,
    service: {
      // a (re)loaded window asks first: the lock state is read from the OS then (§2.3)
      status: () => {
        power.refresh();
        return status();
      },
      requestPort: (/** @type {any} */ sender) => {
        // remembered even while the engine is off or loading: a later start hands it a port itself
        const r = host.connect(sender);
        emitStatus();
        return r;
      },
      reportState,
      micAccess: () => micAccessStatus(systemPreferences, platform),
      openMicSettings: () => openMicSettings(shell, platform),
      saveClip: (/** @type {unknown} */ p) => saveTestClip(p, {
        documentsDir: documentsDir(),
        openPath: (d) => shell.openPath(d),
        appVersion: safe(() => app.getVersion(), ''),
        log,
      }),
      download: () => {
        const r = zhen.download();
        emitStatus();
        return r;
      },
      // "Retry" (the drawer) after "keeps stopping" or "could not start": a fresh restart budget
      restart: () => {
        if (stopped || !wake().enabled) return { ok: false };
        log('info', '[wake] the user asked to start the wake-word engine again');
        if (host.child) host.retry(initFor(runningZhen));
        else startEngine().catch((err) => log('error', `[wake] start failed: ${err && err.stack ? err.stack : err}`));
        emitStatus();
        return { ok: true };
      },
    },
  });

  function documentsDir() {
    try {
      return app.getPath('documents');
    } catch {
      return path.join(o.userData, 'Documents');
    }
  }

  // --- start -------------------------------------------------------------------------------------
  if (wake().enabled) startEngine().catch((err) => log('error', `[wake] start failed: ${err && err.stack ? err.stack : err}`));

  Object.assign(svc, {
    /** (Re)start the engine when the wake word is on. */
    start: () => startEngine(),
    /** Bounded (≈ 2 s): stop the utility; unregister everything. */
    stop: async () => {
      stopped = true;
      if (statusTimer) clearTimeout(statusTimer);
      if (trayTimer) clearTimeout(trayTimer);
      power.stop();
      zhen.stop();
      unregisterIpc();
      await stopEngine();
    },
    /** main.js onSettingsChanged (when the wake group changed). @param {any} next @param {any} prev */
    applySettings: (next, prev) => {
      const n = next?.wake || {};
      const p = prev?.wake || {};
      if (n.enabled !== p.enabled) {
        uiState = null;
        if (n.enabled) startEngine().catch((err) => log('error', `[wake] start failed: ${err && err.stack ? err.stack : err}`));
        else stopEngine().catch(() => {});
      } else if (n.enabled && (n.sensitivity !== p.sensitivity || n.phrase !== p.phrase)) {
        host.sendSettings({ sensitivity: n.sensitivity, phrase: n.phrase });
      }
      emitStatus();
    },
    status,
    /** The persona's wake section (electron/persona.js): only while the wake word is on. */
    personaContext: () => {
      const w = wake();
      return w.enabled ? { wake: { enabled: true, followUp: Number(w.followUpSec) > 0, bargeIn: !!w.bargeIn } } : {};
    },
    /** TrayState.wake */
    trayState: () => {
      const w = wake();
      if (!w.enabled) return { enabled: false, state: 'off', reason: '' };
      if (uiState) return { enabled: true, state: uiState.state, reason: uiState.reason };
      const st = status();
      const broken = st.engine === 'missing' || st.engine === 'error';
      return { enabled: true, state: broken ? 'unavailable' : 'starting', reason: broken ? st.detail : '' };
    },
    trayActions: {
      setWakeWord: (/** @type {boolean} */ on) => settings.update({ wake: { enabled: !!on } }),
    },
    /** scripts/wake-e2e.mjs (LAWNMOWER_E2E=1 only; main.js exposes it as globalThis.__lawnmowerE2E.wake). */
    e2e: env.LAWNMOWER_E2E === '1' ? {
      status,
      utilityPid: () => host.pid,
      metrics: () => {
        const rows = safe(() => app.getAppMetrics(), []);
        return rows.filter((/** @type {any} */ r) => (host.pid && r.pid === host.pid) || r.serviceName === SERVICE_NAME || r.name === SERVICE_NAME)
          .map((/** @type {any} */ r) => ({ pid: r.pid, type: r.type, serviceName: r.serviceName, name: r.name, cpu: r.cpu?.percentCPUUsage ?? null, cumulativeCpuSec: r.cpu?.cumulativeCPUUsage ?? null, memoryKB: r.memory?.workingSetSize ?? null }));
      },
      emitPower: (/** @type {string} */ state) => power.emit(state),
      lastHits: () => host.lastHits.slice(),
      stats: () => host.stats,
      // a crash, not a clean restart: the supervisor's backoff path brings it back and re-ports
      restartUtility: () => host.crash(),
      wakeDir: () => wakeDir,
      addonPath: () => addonPath(wakeDir, key),
      zhenDir: () => runningZhen,
    } : null,
  });
  return /** @type {WakeService} */ (/** @type {unknown} */ (svc));
}

/**
 * @typedef {EventEmitter & {
 *   start: () => Promise<void>, stop: () => Promise<void>, applySettings: (next: any, prev: any) => void,
 *   status: () => WakeEngineStatus, personaContext: () => object, trayState: () => { enabled: boolean, state: string, reason: string },
 *   trayActions: { setWakeWord: (on: boolean) => void }, e2e: Record<string, Function>|null }} WakeService
 */

/** @template T @param {() => T} fn @param {T} fallback */
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
