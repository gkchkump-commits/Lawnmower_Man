import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTapo, CLIP_PATTERN, detectorAssets } from '../../../electron/tapo/index.js';
import { startFakeOnvif } from './helpers/fake-onvif.js';
import { FakeMessageChannelMain, memorySafeStorage, tempSettings, until } from './helpers/fakes.js';
import { FakeBrowserWindow, FakeNotification, fakeIpcMain } from './helpers/fake-electron.js';
import { tmpDir } from '../helpers/tmp.js';

/** @type {Array<() => Promise<void>>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  cleanup = [];
});

const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] };

function setup(settingsInit, o = {}) {
  const { store } = tempSettings(settingsInit);
  const userData = tmpDir('lm-tapo-ud-');
  const ipcMain = fakeIpcMain();
  const toAvatar = [];
  const logs = [];
  let avatarShown = 0;
  const avatarWin = { isDestroyed: () => false, getContentBounds: () => ({ x: 1500, y: 600, width: 400, height: 400 }) };
  const opened = [];
  const tapo = createTapo({
    electron: {
      ...(o.electron || {}),
      app: { getPath: () => path.join(userData, 'Videos'), on: () => {}, ...(o.app || {}) },
      ipcMain,
      safeStorage: memorySafeStorage(),
      Notification: FakeNotification,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      shell: { openPath: async (p) => { opened.push(p); return ''; } },
      screen,
      BrowserWindow: FakeBrowserWindow,
      MessageChannelMain: FakeMessageChannelMain,
    },
    settings: store,
    log: (l, m) => logs.push(`${l} ${m}`),
    userData,
    appRoot: path.resolve('.'),
    isPackaged: !!o.isPackaged,
    platform: o.platform,
    devServerUrl: null,
    env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1', LAWNMOWER_E2E: '1', LAWNMOWER_GO2RTC: path.join(userData, 'no-go2rtc'), ...(o.env || {}) },
    appVersion: '0.5.0',
    preloadCamera: '/app/electron/preload-camera.cjs',
    isTrustedSender: (event, kinds) => {
      if (!kinds.includes(event.sender.kind)) throw new Error('Untrusted IPC sender');
    },
    getAvatarWindow: () => avatarWin,
    sendToAvatar: (ch, p) => toAvatar.push([ch, p]),
    showAvatar: () => { avatarShown++; },
  });
  store.on('change', (n, p) => tapo.applySettings(n, p)); // what main.js's onSettingsChanged does
  cleanup.push(() => tapo.stop());
  return { tapo, store, ipcMain, toAvatar, logs, userData, opened, avatarShown: () => avatarShown };
}

describe('createTapo: the PC itself (UX review)', () => {
  it('armed keeps the PC awake, waking up reconnects, "Start with Windows" sets the login item', async () => {
    FakeBrowserWindow.all = [];
    const power = [];
    const listeners = new Map();
    const login = [];
    const r = setup({ tapo: { enabled: true, host: '127.0.0.1', onvifPort: 1, username: 'camacct' }, security: { armDelaySec: 0 } }, {
      electron: {
        powerSaveBlocker: { start: (type) => { power.push(['start', type]); return 7; }, stop: (id) => power.push(['stop', id]) },
        powerMonitor: { on: (ev, f) => listeners.set(ev, f), removeListener: (ev) => listeners.delete(ev) },
      },
      app: { setLoginItemSettings: (x) => login.push(x) },
      isPackaged: true,
      platform: 'win32',
    });
    await r.tapo.ready;
    expect(login).toEqual([{ openAtLogin: false, args: ['--hidden'] }]);
    await r.ipcMain.invoke('lm:tapo:arm', { sender: { kind: 'camera' } }, { armed: true, immediate: true });
    await until(() => power.length === 1, 5000);
    expect(power).toEqual([['start', 'prevent-app-suspension']]);
    // the PC woke up: the service reconnects at once
    let resumed = 0;
    r.tapo.service.onResume = () => { resumed++; };
    listeners.get('resume')();
    expect(resumed).toBe(1);
    await r.ipcMain.invoke('lm:tapo:arm', { sender: { kind: 'camera' } }, { armed: false });
    await until(() => power.length === 2, 5000);
    expect(power[1]).toEqual(['stop', 7]);
    r.store.update({ security: { startAtLogin: true } });
    expect(login.at(-1)).toEqual({ openAtLogin: true, args: ['--hidden'] });
    await r.tapo.stop();
    expect(listeners.has('resume')).toBe(false);
  });
});

describe('createTapo', () => {
  it('turned off: no window, no MCP server, no tools; the clip mount and tray state are ready', async () => {
    FakeBrowserWindow.all = [];
    const r = setup({});
    await r.tapo.ready;
    expect(FakeBrowserWindow.all).toHaveLength(0);
    expect(r.tapo.cameraWindow()).toBeNull();
    expect(r.tapo.mcpServers()).toEqual([]);
    expect(r.tapo.toolPermissions()).toEqual({ allow: [], deny: [] });
    expect(r.tapo.trayState()).toMatchObject({ enabled: false, configured: false, armed: false });
    const [mount] = r.tapo.protocolMounts();
    expect(mount).toMatchObject({ prefix: '/__clips/', pattern: CLIP_PATTERN, range: true });
    expect(mount.getRoot()).toBe(path.join(r.userData, 'Videos', 'Lawnmower Man', 'Security'));
    expect(CLIP_PATTERN.test('2026-10-10/140312-person-a1b2.mp4')).toBe(true);
    expect(CLIP_PATTERN.test('2026-10-10/140312-person-a1b2.json')).toBe(false); // records are not served
    expect(CLIP_PATTERN.test('../140312-person-a1b2.mp4')).toBe(false);
    expect(CLIP_PATTERN.test('2026-10-10/140312-person-a1b2.mp4.part')).toBe(false);
    // the avatar asks for the window while the feature is off: a clear message, no window
    await expect(r.ipcMain.invoke('lm:tapo:window', { sender: { kind: 'avatar' } }, { show: true })).rejects.toThrow(/Turn the home camera on first/);
    // the tray's "Set up the home camera…" turns it on and opens the window
    r.tapo.trayActions.tapoShow();
    expect(r.store.get().tapo.enabled).toBe(true);
    expect(FakeBrowserWindow.all).toHaveLength(1);
    const bw = FakeBrowserWindow.all[0];
    expect(bw.loads).toEqual(['app://lawnmower/tapo/index.html']);
    expect(bw.shown).toBe(true);
    expect(r.tapo.cameraWindow()).toBe(bw);
    expect(r.tapo.mcpServers()).toEqual([]); // on, but not set up
    // turning it off closes the window for good
    r.store.update({ tapo: { enabled: false } });
    expect(bw.destroyed).toBe(true);
    expect(r.tapo.cameraWindow()).toBeNull();
    expect(detectorAssets('http://localhost:5221/')).toEqual({ wasmBase: 'http://localhost:5221/assets/vision/wasm/', modelUrl: 'http://localhost:5221/assets/security/efficientdet_lite0_int8.tflite' });
  });

  it('set up: connects, offers the MCP server and tools, wires the window, the port and the tray; stop is bounded', async () => {
    FakeBrowserWindow.all = [];
    const cam = await startFakeOnvif();
    cleanup.push(() => cam.close());
    const clips = tmpDir('lm-tapo-clips-');
    const r = setup({ tapo: { enabled: true, host: '127.0.0.1', onvifPort: cam.port, username: 'camacct', name: 'porch camera' }, security: { clipsDir: clips, armDelaySec: 0 } });
    expect(FakeBrowserWindow.all).toHaveLength(0); // not before main.js registered app:// (next tick)
    await r.tapo.ready;
    await until(() => FakeBrowserWindow.all.length === 1); // created hidden at start-up (the worker lives in it)
    const bw = FakeBrowserWindow.all[0];
    expect(bw.shown).toBe(false);
    expect(bw.opts.title).toBe('Home camera — porch camera');
    expect(r.tapo.mcpServers()).toEqual([]);
    await r.tapo.e2e.setPassword('se&cret');
    await until(() => r.tapo.e2e.status().connection === 'online');
    expect(fs.existsSync(r.tapo.e2e.credentialsFile())).toBe(true);
    expect(fs.readFileSync(r.tapo.e2e.credentialsFile(), 'utf8')).not.toMatch(/se&cret/);
    const [server] = r.tapo.mcpServers();
    expect(server.name).toBe('lawnmower-camera');
    expect(typeof server.handle).toBe('function');
    expect(typeof server.startHttp).toBe('function');
    expect(typeof server.stopHttp).toBe('function');
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.result.tools.map((t) => t.name)).toContain('camera_status');
    expect(r.tapo.toolPermissions().allow).toContain('mcp__lawnmower-camera__camera_status');
    expect(r.tapo.personaContext()).toEqual({ camera: { name: 'porch camera', canSee: true, canMove: true } });
    expect(r.tapo.trayState()).toMatchObject({ enabled: true, configured: true, connection: 'online', armed: false, name: 'porch camera' });
    // statuses reach the avatar (and nothing secret in them)
    await until(() => r.toAvatar.some(([ch, p]) => ch === 'lm:tapo:status' && p.connection === 'online'));
    expect(JSON.stringify(r.toAvatar)).not.toMatch(/cret/);
    // the camera window asks for its worker port
    const camEvent = { sender: Object.assign(bw.webContents, { kind: 'camera' }) };
    await expect(r.ipcMain.invoke('lm:tapo:request-port', camEvent)).resolves.toEqual({ ok: true });
    expect(bw.webContents.postMessage).toHaveBeenCalledWith('lm:tapo:port', null, [expect.anything()]);
    // the avatar opens the window; the avatar then glances at it
    await r.ipcMain.invoke('lm:tapo:window', { sender: { kind: 'avatar' } }, { show: true, eventId: '20261010-140312-a1b2' });
    expect(bw.shown).toBe(true);
    expect(bw.webContents.send).toHaveBeenCalledWith('lm:tapo:open-event', { id: '20261010-140312-a1b2' });
    const look = r.toAvatar.find(([ch]) => ch === 'lm:tapo:look');
    expect(look?.[1]).toMatchObject({ holdMs: 4000 });
    // tray: arm and open the clips folder
    r.tapo.trayActions.tapoArm(true);
    expect(r.store.get().security.armed).toBe(true);
    r.tapo.trayActions.tapoOpenClips();
    await until(() => r.opened.length === 1);
    expect(r.opened[0]).toBe(clips);
    // the name and always-on-top follow the settings
    r.store.update({ tapo: { name: 'front door camera', windowOnTop: true } });
    expect(bw.title).toBe('Home camera — front door camera');
    expect(bw.onTop).toBe(true);
    // stop: PTZ Stop / unsubscribe / no handlers left / window gone, within the bound
    const t0 = Date.now();
    await r.tapo.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.ipcMain.handlers.size).toBe(0);
    expect(bw.destroyed).toBe(true);
  });
});
