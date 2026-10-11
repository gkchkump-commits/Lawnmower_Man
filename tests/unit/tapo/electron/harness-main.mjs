// Electron main script of the lane A harness (run-harness.mjs starts it under xvfb). It wires
// createTapo() into a real Electron the way contract §3.2 tells main.js to — app:// with the
// clip mount, a trusted-sender check, the camera window's settings/app channels — against the
// fake ONVIF camera and the mini RTSP camera (real go2rtc from vendor/), with a reduced camera
// page (page/tapo/) in place of lane B's. Then it checks, in order:
//   preload surface → connection → worker port → WebCodecs frames → MCP snapshot → settings
//   groups → motor Stop when the renderer crashes mid-hold → reload + new port → armed person
//   event → clip over app:// with Range + <video> playback → bounded stop (go2rtc gone).
// Prints one line "HARNESS_RESULT <json>" and exits 0 when every check passed.

import { app, BrowserWindow, ipcMain, MessageChannelMain, Notification, nativeImage, protocol, safeStorage, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTapo } from '../../../../electron/tapo/index.js';
import { createAppProtocolHandler } from '../../../../electron/app-protocol.js';
import { SettingsStore } from '../../../../electron/settings.js';
import { buildCsp, isTrustedUrl } from '../../../../electron/security.js';
import { validateCameraSettingsPatch } from '../../../../electron/tapo/validate.js';
import { startFakeOnvif } from '../helpers/fake-onvif.js';
import { startMiniRtsp } from '../helpers/mini-rtsp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const shotPath = process.env.HARNESS_SCREENSHOT || '';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-tapo-harness-'));
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

/** @type {Array<{ name: string, ok: boolean, detail?: any }>} */
const results = [];
/** @type {string[]} */
const logs = [];
const log = (/** @type {string} */ level, /** @type {string} */ msg) => {
  logs.push(`${new Date().toISOString().slice(11, 23)} ${level} ${msg}`);
  if (process.env.HARNESS_VERBOSE) console.error(`${level} ${msg}`);
};
/** @param {string} name @param {boolean} ok @param {any} [detail] */
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return !!ok;
};
/** @param {() => any} fn @param {number} ms */
async function until(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const alive = (/** @type {number|null} */ pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function run() {
  const cam = await startFakeOnvif();
  const rtsp = await startMiniRtsp({ file: path.join(root, 'tests/unit/tapo/fixtures/clip-160x90.h264'), path: '/stream1' });
  const clips = path.join(userData, 'clips');
  const settings = new SettingsStore({ dir: userData, log });
  settings.load();
  settings.update({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: cam.port, rtspPort: rtsp.port, username: 'camacct', name: 'harness camera' },
    security: { clipsDir: clips, armDelaySec: 0, preRollSec: 1, postRollSec: 2, cooldownSec: 5 },
  });

  /** @type {any[]} */
  const mounts = [];
  protocol.handle('app', createAppProtocolHandler({ root: path.join(here, 'page'), host: 'lawnmower', csp: buildCsp(), log, mounts }));

  /** @type {any} */
  let tapo = null;
  /** what main.js does: only the camera window (or the avatar window) may call; from our own origin */
  const isTrustedSender = (/** @type {any} */ event, /** @type {string[]} */ kinds) => {
    const camWin = tapo?.cameraWindow();
    const kind = camWin && event.sender === camWin.webContents ? 'camera' : null;
    if (!kind || !kinds.includes(kind) || !isTrustedUrl(event.senderFrame?.url || '', {})) throw new Error('IPC from an untrusted sender was rejected');
  };
  // the camera window's settings and app channels (main.js owns these)
  ipcMain.handle('lm:settings:get', (e) => {
    isTrustedSender(e, ['camera']);
    return settings.get();
  });
  ipcMain.handle('lm:settings:set', (e, patch) => {
    isTrustedSender(e, ['camera']);
    return settings.update(validateCameraSettingsPatch(patch));
  });
  ipcMain.handle('lm:app:info', (e) => {
    isTrustedSender(e, ['camera']);
    return { version: app.getVersion(), platform: process.platform };
  });

  /** @type {Array<[string, any]>} */
  const toAvatar = [];
  tapo = createTapo({
    electron: { app, ipcMain, safeStorage, Notification, nativeImage, shell: { openPath: async () => '' }, screen, BrowserWindow, MessageChannelMain },
    settings,
    log,
    userData,
    appRoot: root,
    isPackaged: false,
    devServerUrl: null,
    env: { ...process.env, LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1', LAWNMOWER_E2E: '1', LAWNMOWER_TAPO_FAKE_DETECTOR: '1' },
    appVersion: app.getVersion(),
    preloadCamera: path.join(root, 'electron/preload-camera.cjs'),
    isTrustedSender,
    getAvatarWindow: () => null,
    sendToAvatar: (/** @type {string} */ ch, /** @type {any} */ p) => toAvatar.push([ch, p]),
    showAvatar: () => {},
  });
  mounts.push(...tapo.protocolMounts());
  settings.on('change', (n, p) => tapo.applySettings(n, p)); // main.js onSettingsChanged
  await tapo.ready;

  const win = /** @type {import('electron').BrowserWindow} */ (await until(() => tapo.cameraWindow(), 5000));
  check('the camera window exists at start-up (hidden)', !!win && !win.isVisible());
  check('the camera window is sandboxed and isolated', win.webContents.getLastWebPreferences?.().sandbox === true && win.webContents.getLastWebPreferences?.().contextIsolation === true, win.webContents.getLastWebPreferences?.());
  const js = (/** @type {string} */ expr) => win.webContents.executeJavaScript(expr, true);
  tapo.trayActions.tapoShow();
  await until(() => js('!!window.__harness'), 10000);

  // 1. the preload exposes exactly window.lawnmowerCamera
  const h0 = await js('JSON.parse(JSON.stringify({ api: __harness.api, tapoApi: __harness.tapoApi, types: __harness.types }))');
  check('preload: window.lawnmowerCamera = { app, settings, tapo }', JSON.stringify(h0.api) === JSON.stringify(['app', 'settings', 'tapo']), h0.api);
  check('preload: no require/process/ipcRenderer/window.lawnmower in the page', Object.values(h0.types).every((t) => t === 'undefined'), h0.types);
  check('preload: the tapo namespace of §6.2', ['arm', 'calibrate', 'clearCredentials', 'discover', 'events', 'onCalibration', 'onEvent', 'onOpenEvent', 'onStatus', 'presets', 'ptz', 'removePreset', 'requestPort', 'savePreset', 'setCredentials', 'setViewVisible', 'status', 'test'].every((k) => h0.tapoApi.includes(k)), h0.tapoApi);

  // 2. password → ONVIF sign-in → online
  await tapo.e2e.setPassword('se&cret');
  const online = await until(() => tapo.e2e.status().connection === 'online', 15000);
  const st = tapo.e2e.status();
  check('connects to the camera (ONVIF sign-in, PTZ probe)', online, { connection: st.connection, ptz: st.ptz?.mode, persistence: st.persistence });
  check('safeStorage without a keyring (basic_text): the password stays in memory only', st.persistence !== 'encrypted' || safeStorage.isEncryptionAvailable(), { persistence: st.persistence, backend: safeStorage.getSelectedStorageBackend?.() });
  check('no password in the status', !JSON.stringify(st).includes('cret'));

  // 3. the worker port and WebCodecs frames
  const ported = await until(() => js('__harness.ports >= 1'), 10000);
  check('the worker port reaches the page (preload → window.postMessage → worker)', ported);
  const frames = await until(async () => (await js('__harness.frames')) >= 15, 25000);
  const h1 = await js('JSON.parse(JSON.stringify({ frames: __harness.frames, decoder: __harness.decoder, errors: __harness.workerErrors, status: __harness.status }))');
  check('go2rtc → relay → port → VideoDecoder: frames decode in the camera window', frames, h1);
  check('the worker reports stats to main', !!(await until(() => (tapo.e2e.workerStats()?.fps || 0) > 0, 5000)), tapo.e2e.workerStats());
  check('status pushed to the camera window', h1.status === 'online', h1.status);

  // 3b. what crosses a MessagePortMain from the worker: a copied ArrayBuffer arrives; a transferred
  // one does not arrive as sent (informational: tells the worker how to send snapshots)
  await js('__harness.xferProbe()');
  await until(() => logs.some((l) => l.includes('worker: xfer-probe copied')), 3000);
  await sleep(300);
  const transferredOk = logs.some((l) => l.includes('worker: xfer-probe transferred'));
  check('worker → main: an ArrayBuffer in a message (copied) arrives', logs.some((l) => l.includes('worker: xfer-probe copied')));
  results.push({ name: 'note: a transferred ArrayBuffer reaches main intact', ok: true, detail: { arrives: transferredOk, dropped: logs.filter((l) => /dropped an invalid worker message/.test(l)).slice(-1) } });
  console.error(`note a transferred ArrayBuffer reaches main intact: ${transferredOk}`);

  // 4. MCP snapshot (what Claude would get after the user approved it)
  const [server] = tapo.mcpServers();
  const snap = server ? await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'camera_snapshot', arguments: {} } }) : null;
  const img = snap?.result?.content?.find((/** @type {any} */ c) => c.type === 'image');
  const jpeg = img ? Buffer.from(img.data, 'base64') : Buffer.alloc(0);
  check('camera_snapshot returns a JPEG of the live picture', jpeg[0] === 0xff && jpeg[1] === 0xd8 && img.mimeType === 'image/jpeg', { bytes: jpeg.length, isError: snap?.result?.isError });

  // 5. the camera window may only change its own settings groups
  const other = await js('__harness.otherGroup()');
  const own = await js('__harness.cameraGroup()');
  check('settings.set from the camera window: other groups refused, tapo accepted', /^rejected/.test(other) && own === 'accepted' && settings.get().tapo.name === 'harness porch', { other, own });
  check('the window title follows the camera name', win.getTitle() === 'Home camera — harness porch', win.getTitle());

  // 6. motor safety: the renderer dies in the middle of a press-and-hold → Stop at once
  const holdStart = await js('__harness.ptz({ op: "hold", dir: "left" })');
  await until(() => cam.calls.some((c) => c.op === 'ContinuousMove' && c.args.x && c.args.x !== '0'), 3000);
  const stopsBefore = cam.count('Stop');
  const crashAt = Date.now();
  win.webContents.forcefullyCrashRenderer();
  const stopped = await until(() => cam.count('Stop') > stopsBefore, 3000);
  const stopMs = Date.now() - crashAt;
  check('renderer crash mid-hold → PTZ Stop', holdStart?.ok && stopped && logs.some((l) => /stopAll \(camera window renderer gone\)/.test(l)), { holdStart, stopMs });
  // it reloads after 1 s and asks for a new port; frames come back
  const reloaded = await until(async () => !win.webContents.isCrashed() && (await js('!!window.__harness && __harness.frames >= 5')), 20000);
  check('the crashed camera window reloads, gets a new port and decodes again', reloaded);

  // 7. armed: a person → event with a clip; the clip plays over app:// with Range
  const armed = tapo.service.arm({ armed: true, immediate: true });
  check('arm (immediate)', armed.armed === true, armed);
  await until(() => tapo.e2e.status().events?.onvif === 'subscribed', 8000);
  tapo.service.engine._localSuppressUntil = 0; // skip the 10 s settling time after a stream start
  await sleep(1500); // pre-roll
  await js('__harness.det(true)');
  await sleep(150);
  await js('__harness.det(true)');
  // the first frames start a motion event; person evidence (2 of 3 samples) upgrades it and records
  const started = await until(() => tapo.e2e.status().security?.active?.kind === 'person' && tapo.e2e.status().security.recording, 5000);
  check('a person in view starts an event (motion → person) and a recording', !!started, tapo.e2e.status().security);
  for (let i = 0; i < 5; i++) {
    await js('__harness.det(false)');
    await sleep(800);
  }
  const ended = await until(() => !tapo.e2e.status().security.active && !tapo.e2e.status().security.recording, 10000);
  const { events } = await tapo.service.listEvents();
  const ev = events[0];
  check('the event ends after the post-roll; one record with a clip and a snapshot', ended && events.length === 1 && !!ev?.clipUrl && !!ev?.snapshotUrl, ev);
  check('a notification was shown for the person', tapo.e2e.notifications().length === 1, tapo.e2e.notifications());
  if (ev?.clipUrl) {
    const full = await js(`__harness.fetchRange(${JSON.stringify(ev.clipUrl)})`);
    const part = await js(`__harness.fetchRange(${JSON.stringify(ev.clipUrl)}, 'bytes=0-99')`);
    check('app:// clip mount: 200 video/mp4, then 206 for a Range', full.status === 200 && full.type === 'video/mp4' && full.head === 'ftyp' && part.status === 206 && part.length === 100 && /^bytes 0-99\/\d+$/.test(part.contentRange), { full, part });
    const blocked = await js(`__harness.fetchRange(${JSON.stringify(ev.clipUrl.replace(/\.mp4$/, '.json'))})`);
    check('app:// clip mount: the event .json is not served', blocked.status === 403, blocked.status);
    const play = await js(`__harness.playClip(${JSON.stringify(ev.clipUrl)})`);
    check('the clip plays in a <video> (stream-copied fMP4)', play.ok && play.width === 160 && play.height === 90, play);
  }

  // 8. screenshot of the camera window (live frame)
  if (shotPath) {
    await sleep(500);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, image.toPNG());
    check('screenshot saved', fs.existsSync(shotPath), shotPath);
  }

  // 9. bounded stop: PTZ Stop, Unsubscribe, clip finished, go2rtc gone, window gone
  const pid = tapo.e2e.go2rtcPid();
  const t0 = Date.now();
  await tapo.stop();
  const stopTook = Date.now() - t0;
  await sleep(200);
  check('tapo.stop() is bounded and leaves no go2rtc behind', stopTook < 5000 && !!pid && !alive(pid), { stopTook, pid, alive: alive(pid) });
  check('the camera subscription was cancelled', cam.count('Unsubscribe') >= 1, cam.count('Unsubscribe'));
  check('no password in the logs', !logs.some((l) => l.includes('se&cret') || l.includes('se%26cret')));
  await rtsp.close();
  await cam.close();
}

app.whenReady().then(run).catch((err) => {
  check('harness ran to the end', false, String(err && err.stack ? err.stack : err));
}).finally(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`HARNESS_RESULT ${JSON.stringify({ passed: results.length - failed, failed, results, logTail: failed ? logs.slice(-60) : [] })}`);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(failed ? 1 : 0);
});
app.on('window-all-closed', () => {});
