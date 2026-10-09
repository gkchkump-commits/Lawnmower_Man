// Smoke test of electron/main.js wiring with a mocked `electron` module (the Electron binary is
// not needed). Drives a real ClaudeSession against the fake CLI through the IPC handlers.
/* global Request */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHotkeys } from '../../../electron/settings.js';

const m = vi.hoisted(() => {
  const handlers = new Map();
  const listeners = new Map();
  const appEvents = new Map();
  const windows = [];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
  const userData = { dir: '' };
  const cursor = { x: 0, y: 0 };
  return { handlers, listeners, appEvents, windows, display, userData, cursor, protocolHandler: null, sessionHandlers: {} };
});

vi.mock('electron', () => {
  const fn = () => vi.fn();
  class FakeWebContents {
    constructor() {
      this.sent = [];
      this.events = new Map();
      this.send = vi.fn((ch, payload) => this.sent.push([ch, payload]));
      this.isDestroyed = () => false;
      this.setWindowOpenHandler = vi.fn((h) => { this.openHandler = h; });
      this.toggleDevTools = fn();
      this.reload = fn();
    }
    on(ev, cb) { this.events.set(ev, cb); return this; }
  }
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.webContents = new FakeWebContents();
      this.visible = false;
      this.events = new Map();
      this.setIgnoreMouseEvents = vi.fn();
      this.setAlwaysOnTop = vi.fn();
      this.setSkipTaskbar = vi.fn();
      this.setResizable = vi.fn();
      this.loadURL = vi.fn(async () => {});
      this.setBounds = vi.fn((b) => { this.bounds = { ...b }; });
      m.windows.push(this);
    }
    once(ev, cb) { if (ev === 'ready-to-show') setTimeout(cb, 0); else this.events.set(ev, cb); return this; }
    on(ev, cb) { this.events.set(ev, cb); return this; }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    isVisible() { return this.visible; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() { this.visible = true; this.events.get('show')?.(); }
    showInactive() { this.visible = true; this.events.get('show')?.(); }
    hide() { this.visible = false; this.events.get('hide')?.(); }
    focus() {}
    restore() {}
    minimize() {}
  }
  class Tray {
    constructor(img) { this.img = img; this.setContextMenu = vi.fn((menu) => { this.menu = menu; }); this.setToolTip = vi.fn(); this.destroy = vi.fn(); }
    on() {}
  }
  const app = {
    commandLine: { appendSwitch: vi.fn() },
    setAppUserModelId: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((ev, cb) => { m.appEvents.set(ev, cb); }),
    getPath: vi.fn(() => m.userData.dir),
    getVersion: () => '0.1.0-test',
    isPackaged: false,
    quit: vi.fn(),
    getGPUInfo: vi.fn(async () => ({ gpuDevice: [{ active: true, vendorId: 4318, deviceId: 10373, driverVersion: '580.0' }] })),
    getGPUFeatureStatus: vi.fn(() => ({ webgl2: 'enabled', rasterization: 'enabled' })),
  };
  return {
    app,
    BrowserWindow,
    Tray,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((t) => ({ template: t })) },
    dialog: { showErrorBox: vi.fn() },
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
    ipcMain: {
      handle: vi.fn((ch, h) => m.handlers.set(ch, h)),
      on: vi.fn((ch, h) => m.listeners.set(ch, h)),
    },
    nativeImage: { createFromPath: vi.fn(() => ({ kind: 'file' })), createFromBuffer: vi.fn(() => ({ kind: 'buffer' })) },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn((scheme, h) => { m.protocolHandler = h; }) },
    screen: { getPrimaryDisplay: () => m.display, getAllDisplays: () => [m.display], getDisplayMatching: () => m.display, getCursorScreenPoint: () => ({ ...m.cursor }), on: vi.fn() },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: vi.fn((h) => { m.sessionHandlers.headers = h; }),
          onBeforeRequest: vi.fn((filter, h) => { m.sessionHandlers.beforeRequest = { filter, h }; }),
        },
        setPermissionRequestHandler: vi.fn((h) => { m.sessionHandlers.request = h; }),
        setPermissionCheckHandler: vi.fn((h) => { m.sessionHandlers.check = h; }),
        setDevicePermissionHandler: vi.fn(),
      },
    },
    shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => '') },
  };
});

let electron;
let main;
let win;
/** Mock calls made during startup (vitest clears mock history between tests). */
const boot = {};
const trusted = () => ({ sender: win.webContents, senderFrame: { url: 'app://lawnmower/index.html' } });
const invoke = (ch, ...args) => m.handlers.get(ch)(trusted(), ...args);
const waitForSent = async (pred, timeout = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const hit = win.webContents.sent.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeout) throw new Error(`timeout; sent: ${win.webContents.sent.map((s) => s[0] + ':' + (s[1]?.type || '')).join(', ')}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// main.js serves the built renderer from <repo>/dist. On a fresh checkout (or in CI, where unit
// tests run before `vite build`) it does not exist yet, so provide a stub page for the app://
// wiring test and remove only what this file created.
const distDir = path.resolve('dist');
const created = { dir: false, index: false };

beforeAll(async () => {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    created.dir = !fs.existsSync(distDir);
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>stub</title>');
    created.index = true;
  }
  m.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-main-'));
  // Hermetic: never start a real voice server from a developer's voice/.venv.
  fs.writeFileSync(path.join(m.userData.dir, 'settings.json'), JSON.stringify({ voice: { enabled: false }, claude: { workdir: path.join(m.userData.dir, 'work') } }));
  process.env.LAWNMOWER_CLAUDE_CLI = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.LAWNMOWER_FORCE_CLICK_THROUGH = '1'; // forwarding is Windows/macOS-only; test the logic anywhere
  electron = await import('electron');
  main = await import('../../../electron/main.js');
  await main.mainReady;
  win = m.windows[0];
  await new Promise((r) => setTimeout(r, 20)); // ready-to-show
  boot.schemes = electron.protocol.registerSchemesAsPrivileged.mock.calls.slice();
  boot.switches = electron.app.commandLine.appendSwitch.mock.calls.map((c) => c[0]);
  boot.lock = electron.app.requestSingleInstanceLock.mock.calls.length;
  boot.loadURL = win.loadURL.mock.calls.slice();
  boot.appMenu = electron.Menu.setApplicationMenu.mock.calls.slice();
  boot.shortcuts = electron.globalShortcut.register.mock.calls.slice();
});

afterAll(async () => {
  await main?.__test.state.claude?.stop();
  delete process.env.LAWNMOWER_CLAUDE_CLI;
  delete process.env.LAWNMOWER_FORCE_CLICK_THROUGH;
  fs.rmSync(m.userData.dir, { recursive: true, force: true });
  if (created.dir) fs.rmSync(distDir, { recursive: true, force: true });
  else if (created.index) fs.rmSync(path.join(distDir, 'index.html'), { force: true });
});

describe('electron/main.js wiring', () => {
  it('registers the privileged app:// scheme, GPU switches and the single-instance lock', () => {
    expect(boot.schemes).toEqual([[[
      { scheme: 'app', privileges: expect.objectContaining({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }) },
    ]]]);
    expect(boot.switches).toEqual(expect.arrayContaining(['force_high_performance_gpu', 'enable-gpu-rasterization', 'ignore-gpu-blocklist']));
    expect(boot.lock).toBe(1);
    expect([...m.appEvents.keys()]).toEqual(expect.arrayContaining(['second-instance', 'window-all-closed', 'will-quit', 'web-contents-created']));
  });

  it('creates a transparent, frameless, sandboxed always-on-top window and loads app://', () => {
    expect(m.windows).toHaveLength(1);
    const o = win.opts;
    expect(o).toMatchObject({ transparent: true, frame: false, hasShadow: false, backgroundColor: '#00000000', resizable: false, alwaysOnTop: true, show: false });
    expect(o.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false });
    expect(o.webPreferences.preload).toMatch(/electron[\\/]preload\.cjs$/);
    expect(fs.existsSync(o.webPreferences.preload)).toBe(true);
    expect({ width: o.width, height: o.height }).toEqual({ width: 400, height: 840 }); // medium + chat panel
    expect(o.x + o.width).toBeLessThanOrEqual(1920);
    expect(boot.loadURL).toEqual([['app://lawnmower/index.html']]);
    expect(win.visible).toBe(true);
    expect(boot.appMenu).toEqual([[null]]);
  });

  it('exposes exactly the IPC channels the preload uses', () => {
    const preload = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8');
    const used = new Set([...preload.matchAll(/'(lm:[a-z:-]+)'/g)].map((x) => x[1]));
    const toRenderer = ['lm:claude:event', 'lm:voice:status', 'lm:settings:changed', 'lm:hotkey', 'lm:cursor', 'lm:window:visibility'];
    const registered = new Set([...m.handlers.keys(), ...m.listeners.keys(), ...toRenderer]);
    expect([...used].sort()).toEqual([...registered].sort());
    expect([...m.handlers.keys()].sort()).toEqual([
      'lm:app:info', 'lm:claude:cancel', 'lm:claude:interrupt', 'lm:claude:reset', 'lm:claude:respond-permission', 'lm:claude:retry', 'lm:claude:send', 'lm:claude:status',
      'lm:settings:get', 'lm:settings:set', 'lm:voice:info', 'lm:voice:open-setup-log', 'lm:voice:restart', 'lm:voice:setup',
    ]);
  });

  it('round-trips a Claude turn through IPC and forwards events to the renderer', async () => {
    const { turnId } = await invoke('lm:claude:send', 'hello from the renderer');
    const [, ev] = await waitForSent(([ch, p]) => ch === 'lm:claude:event' && p.type === 'turn_end' && p.turnId === turnId);
    expect(ev.result).toBe('You said: hello from the renderer');
    const status = await invoke('lm:claude:status');
    expect(status).toMatchObject({ status: 'ready', busy: false, cliPath: process.env.LAWNMOWER_CLAUDE_CLI });
    // The session id was persisted to settings.
    const s = await invoke('lm:settings:get');
    expect(s.claude.lastSessionId).toBe(ev.sessionId);
    await expect(invoke('lm:claude:send', '')).rejects.toThrow(/empty/);
    await expect(invoke('lm:claude:respond-permission', 'nope', { behavior: 'allow' })).rejects.toThrow(/Unknown or expired/);
  });

  it('rejects IPC from untrusted senders', async () => {
    const h = m.handlers.get('lm:settings:get');
    await expect(h({ sender: win.webContents, senderFrame: { url: 'https://evil.example/' } })).rejects.toThrow(/untrusted/);
    await expect(h({ sender: {}, senderFrame: { url: 'app://lawnmower/index.html' } })).rejects.toThrow(/untrusted/);
    await expect(h({ sender: win.webContents, senderFrame: null })).rejects.toThrow(/untrusted/);
  });

  it('applies settings: validation, resize on preset change, change events', async () => {
    const before = win.setBounds.mock.calls.length;
    const s = await invoke('lm:settings:set', { window: { sizePreset: 'small' }, avatar: { bloom: 9 } });
    expect(s.window.sizePreset).toBe('small');
    expect(s.avatar.bloom).toBe(2);
    expect(win.setBounds.mock.calls.length).toBe(before + 1);
    expect(win.bounds).toMatchObject({ width: 300, height: 450 + 200 });
    await waitForSent(([ch, p]) => ch === 'lm:settings:changed' && p.window.sizePreset === 'small');
    await expect(invoke('lm:settings:set', 'nope')).rejects.toThrow(/object/);
    m.listeners.get('lm:window:set-size-preset')(trusted(), 'large');
    expect((await invoke('lm:settings:get')).window.sizePreset).toBe('large');
    m.listeners.get('lm:window:set-size-preset')(trusted(), 'gigantic'); // ignored (logged)
    expect((await invoke('lm:settings:get')).window.sizePreset).toBe('large');
  });

  it('click-through follows the renderer only when enabled', async () => {
    const ignore = m.listeners.get('lm:window:set-ignore-mouse');
    ignore(trusted(), true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    ignore(trusted(), false);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    await invoke('lm:settings:set', { window: { clickThrough: false } });
    ignore(trusted(), true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    m.listeners.get('lm:window:set-always-on-top')(trusted(), false);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
  });

  it('a renderer reload or crash makes a click-through window interactive again (F1)', async () => {
    await invoke('lm:settings:set', { window: { clickThrough: true } });
    const ignore = m.listeners.get('lm:window:set-ignore-mouse');
    ignore(trusted(), true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    win.webContents.events.get('did-start-loading')(); // F5 / crash-recovery reload
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    ignore(trusted(), true);
    win.webContents.events.get('render-process-gone')({}, { reason: 'clean-exit', exitCode: 0 });
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
  });

  it('sends the global cursor in window coordinates while visible, only when it moves', async () => {
    const tracker = main.__test.state.cursor;
    const cursorSent = () => win.webContents.sent.filter(([ch]) => ch === 'lm:cursor');
    expect(tracker.running).toBe(true); // visible + avatar.followCursor
    m.cursor.x = win.bounds.x + 50;
    m.cursor.y = win.bounds.y - 300; // above the window: still reported
    await waitForSent(([ch, p]) => ch === 'lm:cursor' && p.x === 50 && p.y === -300);
    const n = cursorSent().length;
    await new Promise((r) => setTimeout(r, 150)); // ~4 polls with an idle mouse
    expect(cursorSent().length).toBe(n);
    win.hide();
    expect(tracker.running).toBe(false);
    expect(win.webContents.sent.filter(([ch]) => ch === 'lm:window:visibility').at(-1)[1]).toEqual({ visible: false }); // the camera pauses
    expect((await invoke('lm:app:info')).visible).toBe(false);
    win.show();
    expect(tracker.running).toBe(true);
    expect(win.webContents.sent.filter(([ch]) => ch === 'lm:window:visibility').at(-1)[1]).toEqual({ visible: true });
    await invoke('lm:settings:set', { avatar: { followCursor: false } });
    expect(tracker.running).toBe(false);
    await invoke('lm:settings:set', { avatar: { followCursor: true } });
    expect(tracker.running).toBe(true);
  });

  it('moves the window by the head: follows the global cursor, settles on the display, saves', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (pred, timeout = 2000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > timeout) throw new Error('timeout');
        await sleep(10);
      }
    };
    const drag = (ch) => m.listeners.get(`lm:window:${ch}`)(trusted());
    const wa = m.display.workArea;
    win.setBounds({ x: 900, y: 300, width: 400, height: 840 });
    const start = win.getBounds();
    Object.assign(m.cursor, { x: 1000, y: 400 });

    // a press that does not move is a click: the window stays put
    drag('drag-start');
    m.cursor.x += 2;
    await sleep(60);
    expect(win.bounds).toEqual(start);

    // past the threshold every movement counts; the size never changes
    Object.assign(m.cursor, { x: 940, y: 370 });
    await until(() => win.bounds.x === start.x - 60);
    expect(win.bounds).toEqual({ ...start, x: start.x - 60, y: start.y - 30 });
    // the renderer cannot make the window click-through mid-drag (the release must arrive)
    m.listeners.get('lm:window:set-ignore-mouse')(trusted(), true);
    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, expect.anything());
    expect(main.__test.state.ignoreMouse).toBe(false);

    // dropped half off-screen: settles fully onto the work area and saves the position
    Object.assign(m.cursor, { x: 1000 + 5000, y: 400 - 5000 });
    drag('drag-end');
    expect(win.bounds).toEqual({ x: wa.x + wa.width - start.width, y: wa.y, width: start.width, height: start.height });
    expect((await invoke('lm:settings:get')).window.position).toEqual({ x: win.bounds.x, y: win.bounds.y });
    expect(main.__test.state.drag).toBe(null);
    const settled = win.getBounds();
    Object.assign(m.cursor, { x: 10, y: 10 });
    await sleep(40);
    expect(win.bounds).toEqual(settled); // no timer left running

    // locked: a press never moves the window
    await invoke('lm:settings:set', { window: { lockPosition: true } });
    drag('drag-start');
    expect(main.__test.state.drag).toBe(null);
    await invoke('lm:settings:set', { window: { lockPosition: false } });

    // hiding the window ends a drag in progress
    drag('drag-start');
    expect(main.__test.state.drag).not.toBe(null);
    win.hide();
    expect(main.__test.state.drag).toBe(null);
    win.show();

    // these calls take no arguments
    m.listeners.get('lm:window:drag-start')(trusted(), { x: 1 });
    expect(main.__test.state.drag).toBe(null);

    // "Reset position": back to the bottom-right corner of the display
    drag('reset-position');
    expect(win.bounds).toEqual({ x: wa.x + wa.width - start.width - 24, y: wa.y + wa.height - start.height - 24, width: start.width, height: start.height });
    expect((await invoke('lm:settings:get')).window.position).toEqual({ x: win.bounds.x, y: win.bounds.y });
    const tray = main.__test.state.tray;
    expect(tray.menu.template.some((i) => i.label === 'Lock position' && i.type === 'checkbox')).toBe(true);
    expect(tray.menu.template.some((i) => i.label === 'Reset position')).toBe(true);
  });

  it('cancel IPC validates the turn id', async () => {
    await expect(invoke('lm:claude:cancel', '../x')).rejects.toThrow(/turn id/);
    expect(await invoke('lm:claude:cancel', 'turn-1-unknown')).toEqual({ cancelled: false, interrupted: false });
  });

  it('serves dist/ through app:// with CSP', async () => {
    expect(m.protocolHandler).toBeTypeOf('function');
    const res = await m.protocolHandler(new Request('app://lawnmower/index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(main.__test.csp);
    expect((await m.protocolHandler(new Request('app://lawnmower/..%2Fpackage.json'))).status).toBe(403);
  });

  it('installs CSP headers, permission policy and navigation guards', () => {
    const cb = vi.fn();
    m.sessionHandlers.headers({ resourceType: 'mainFrame', url: 'http://127.0.0.1:5173/', responseHeaders: { 'Content-Type': ['text/html'] } }, cb);
    expect(cb.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toEqual([main.__test.csp]);
    // a worker script of our own origin gets the policy too; other origins' scripts are left alone
    m.sessionHandlers.headers({ resourceType: 'script', url: 'app://lawnmower/assets/face-worker-x.js', responseHeaders: {} }, cb);
    expect(cb.mock.calls[1][0].responseHeaders['Content-Security-Policy']).toEqual([main.__test.csp]);
    m.sessionHandlers.headers({ resourceType: 'script', url: 'https://cdn.example/x.js', responseHeaders: { a: ['b'] } }, cb);
    expect(cb.mock.calls[2][0].responseHeaders).toEqual({ a: ['b'] });

    // no request leaves the PC: loopback passes, anything else is cancelled (and logged once)
    const { filter, h: before } = m.sessionHandlers.beforeRequest;
    expect(filter.urls).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']));
    const decide = (url) => {
      const done = vi.fn();
      before({ url, resourceType: 'xhr' }, done);
      return done.mock.calls[0][0];
    };
    expect(decide('http://127.0.0.1:8765/v1/tts')).toEqual({ cancel: false });
    expect(main.__test.state.blockedRequests).toEqual([]);
    expect(decide('https://odml.pa.googleapis.com/v1/log')).toEqual({ cancel: true });
    expect(decide('wss://evil.example/socket')).toEqual({ cancel: true });
    expect(main.__test.state.blockedRequests).toEqual(['https://odml.pa.googleapis.com/v1/log', 'wss://evil.example/socket']);
    main.__test.state.blockedRequests.length = 0;
    const grant = vi.fn();
    m.sessionHandlers.request(win.webContents, 'media', grant, { requestingUrl: 'app://lawnmower/index.html', mediaTypes: ['audio'] });
    m.sessionHandlers.request(win.webContents, 'geolocation', grant, { requestingUrl: 'app://lawnmower/index.html' });
    expect(grant.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(m.sessionHandlers.check(win.webContents, 'media', 'app://lawnmower', { mediaType: 'video' })).toBe(false);

    const contents = { handlers: new Map(), on(ev, h) { this.handlers.set(ev, h); }, setWindowOpenHandler(h) { this.open = h; } };
    m.appEvents.get('web-contents-created')({}, contents);
    const prevent = vi.fn();
    contents.handlers.get('will-navigate')({ preventDefault: prevent }, 'https://example.com/docs');
    expect(prevent).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    const ok = vi.fn();
    contents.handlers.get('will-navigate')({ preventDefault: ok }, 'app://lawnmower/index.html');
    expect(ok).not.toHaveBeenCalled();
    expect(contents.open({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
  });

  it('builds the tray, registers hotkeys and reports app info', async () => {
    const tray = main.__test.state.tray;
    expect(tray.menu.template.some((i) => i.label === 'Quit Lawnmower Man')).toBe(true);
    // Windows avoids Ctrl+Alt (= AltGr) shortcuts; elsewhere the classic defaults
    const hk = defaultHotkeys(process.platform);
    expect(boot.shortcuts.map((c) => c[0])).toEqual([hk.toggleListen, hk.toggleChat, hk.stopSpeaking]);
    boot.shortcuts[0][1]();
    await waitForSent(([ch, p]) => ch === 'lm:hotkey' && p === 'toggleListen');
    const info = await invoke('lm:app:info');
    expect(info).toMatchObject({ version: '0.1.0-test', platform: process.platform, layout: { avatar: { width: 560, height: 840 } } });
    expect(info.gpu.active.vendor).toBe('NVIDIA');
    expect(await invoke('lm:voice:info')).toMatchObject({ status: 'disabled' });
  });

  it('Retry re-detects and restarts the Claude CLI in the same conversation', async () => {
    const before = await invoke('lm:claude:status');
    await invoke('lm:claude:retry');
    const after = await invoke('lm:claude:status');
    expect(after).toMatchObject({ status: 'ready', sessionId: before.sessionId });
    expect(after.problem).toBeUndefined();
    const { turnId } = await invoke('lm:claude:send', 'after retry');
    const [, ev] = await waitForSent(([ch, p]) => ch === 'lm:claude:event' && p.type === 'turn_end' && p.turnId === turnId);
    expect(ev.result).toBe('You said: after retry');
  });

  it('"Set up local voice…": GPU choice, tray item, and the voice restarts when the script reports', async () => {
    const t = main.__test;
    const setup = t.state.setup;
    expect(setup._o.script).toBe(path.resolve('scripts', process.platform === 'win32' ? 'setup-voice.ps1' : 'setup-voice.sh'));
    expect(setup._o.statusFile).toBe(path.join(m.userData.dir, 'voice-setup-status.json'));
    const tray = () => t.state.tray.menu.template.map((i) => i.label);
    expect(tray()).toContain('Set up local voice…');
    // never open a real console window from a unit test: stub the launch
    const start = vi.spyOn(setup, 'start').mockImplementation(async (o) => setup._set({ state: 'running', mode: 'console', cpu: o.cpu, detail: 'running' }));
    try {
      await expect(invoke('lm:voice:setup', { cpu: 'yes' })).rejects.toThrow(/cpu must be true or false/);
      await expect(invoke('lm:voice:setup', 'nope')).rejects.toThrow(/object/);
      const r = await invoke('lm:voice:setup');
      expect(start).toHaveBeenLastCalledWith({ cpu: false, check: false }); // the mocked GPU is an NVIDIA one
      expect(r.state).toBe('running');
      const [, info] = await waitForSent(([ch, p]) => ch === 'lm:voice:status' && p.setup?.state === 'running');
      expect(info.setup).toMatchObject({ state: 'running', cpu: false, mode: 'console' });
      expect(await invoke('lm:voice:info')).toMatchObject({ setup: { state: 'running' } });
      expect(tray()).toContain('Local voice setup is running…');
      await invoke('lm:voice:setup', { cpu: true });
      expect(start).toHaveBeenLastCalledWith({ cpu: true, check: false });

      // the script reported success: voice gets enabled and (re)started
      const restart = vi.spyOn(t.state.voice, 'restart');
      setup._set({ state: 'done', detail: 'Local voice installed. Starting it…' });
      setup.emit('finished', { ok: true });
      expect((await invoke('lm:settings:get')).voice.enabled).toBe(true);
      expect(restart).toHaveBeenCalledTimes(1);
      // a check-only run changes nothing
      setup.emit('finished', { ok: true, check: true });
      expect(restart).toHaveBeenCalledTimes(1);
      restart.mockRestore();
      await t.state.voice.stop();
    } finally {
      start.mockRestore();
    }
  });

  it('"Open setup log": no arguments, only the setup log of the voice home, only when it is a file', async () => {
    const t = main.__test;
    const setup = t.state.setup;
    // unpackaged: the voice home is <repo>/voice (packaged: packagedVoiceHome(), like the script)
    expect(setup.logFile).toBe(path.resolve('voice', 'setup.log'));
    const known = setup._o.logFile;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-setuplog-'));
    setup._o.logFile = path.join(dir, 'setup.log'); // hermetic: never touch a developer's voice/setup.log
    const openPath = electron.shell.openPath;
    try {
      openPath.mockClear();
      // arguments from the renderer are refused: it cannot choose what is opened
      await expect(invoke('lm:voice:open-setup-log', 'C:\\Windows\\System32\\calc.exe')).rejects.toThrow(/no arguments/);
      await expect(invoke('lm:voice:open-setup-log', { path: '/etc/passwd' })).rejects.toThrow(/no arguments/);
      expect(openPath).not.toHaveBeenCalled();
      // no log yet
      expect(await invoke('lm:voice:open-setup-log')).toMatchObject({ ok: false, error: expect.stringMatching(/no setup log yet/) });
      expect(openPath).not.toHaveBeenCalled();
      expect((await invoke('lm:voice:info')).setupLog).toBeUndefined();
      // a folder of that name is not opened either
      fs.mkdirSync(setup._o.logFile);
      expect(await invoke('lm:voice:open-setup-log')).toMatchObject({ ok: false });
      expect(openPath).not.toHaveBeenCalled();
      fs.rmSync(setup._o.logFile, { recursive: true });
      // the script wrote it: opened, exactly that path; voice.info() names it
      fs.writeFileSync(setup._o.logFile, '=== Lawnmower Man - local voice setup ===\n');
      expect(await invoke('lm:voice:open-setup-log')).toEqual({ ok: true, path: setup._o.logFile });
      expect(openPath).toHaveBeenCalledTimes(1);
      expect(openPath).toHaveBeenLastCalledWith(setup._o.logFile);
      expect((await invoke('lm:voice:info')).setupLog).toBe(setup._o.logFile);
      // the shell could not open it (no app for .log): reported, not thrown
      openPath.mockResolvedValueOnce('No application is associated with the specified file');
      expect(await invoke('lm:voice:open-setup-log')).toMatchObject({ ok: false, error: 'No application is associated with the specified file' });
    } finally {
      setup._o.logFile = known;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed setup reaches the renderer with its output tail', async () => {
    const setup = main.__test.state.setup;
    const tail = ['Collecting example-wheel>=1.0', 'ERROR: No matching distribution found for example-wheel>=1.0'];
    setup._set({ state: 'failed', mode: 'console', cpu: false, detail: 'The voice setup failed: x — ERROR: No matching distribution found for example-wheel>=1.0', errorTail: tail });
    const [, sent] = await waitForSent(([ch, p]) => ch === 'lm:voice:status' && p.setup?.state === 'failed');
    expect(sent.setup).toMatchObject({ state: 'failed', errorTail: tail, mode: 'console' });
    expect((await invoke('lm:voice:info')).setup.errorTail).toEqual(tail);
    setup._set({ state: 'idle' });
  });

  it('the voice server is held while a setup run installs into the venv, and started when it ends', async () => {
    const t = main.__test;
    const setup = t.state.setup;
    const voice = t.state.voice;
    await invoke('lm:settings:set', { voice: { enabled: false } });
    await voice.start();
    // what the runner calls right before the window opens
    await setup._o.beforeLaunch({ cpu: false, check: false });
    expect(voice.held).toBe(true);
    expect(voice.info()).toMatchObject({ status: 'stopped' });
    // "Restart voice" (tray / renderer) and a settings change do not start it meanwhile
    const spawned = vi.spyOn(voice, '_start');
    try {
      await invoke('lm:voice:restart');
      await invoke('lm:settings:set', { voice: { device: 'cpu' } });
      await new Promise((r) => setTimeout(r, 50));
      expect(voice.info().status).toBe('stopped');
      expect(spawned).not.toHaveBeenCalled();
      // a check-only run holds nothing and its end releases nothing
      setup._set({ state: 'done', check: true });
      setup.emit('finished', { ok: true, check: true });
      expect(voice.held).toBe(true);
      // the run failed: the hold ends and the previous voice comes back (here: disabled)
      setup._set({ state: 'failed', check: false, detail: 'x' });
      setup.emit('finished', { ok: false, error: 'Command failed (exit 1): pip' });
      expect(voice.held).toBe(false);
      for (let i = 0; i < 50 && voice.info().status !== 'disabled'; i++) await new Promise((r) => setTimeout(r, 20));
      expect(voice.info().status).toBe('disabled');
      expect(spawned).toHaveBeenCalled();
      // a successful run turns local voice on and starts it, once
      await setup._o.beforeLaunch({ cpu: false, check: false });
      expect(voice.held).toBe(true);
      const restart = vi.spyOn(voice, 'restart').mockImplementation(async () => {}); // hermetic: no real voice/.venv server
      setup._set({ state: 'done', check: false });
      setup.emit('finished', { ok: true });
      expect((await invoke('lm:settings:get')).voice.enabled).toBe(true);
      expect(voice.held).toBe(false);
      expect(restart).toHaveBeenCalledTimes(1);
      restart.mockRestore();
      await setup._o.beforeLaunch({ cpu: false, check: true }); // check-only: no hold
      expect(voice.held).toBe(false);
    } finally {
      spawned.mockRestore();
      setup._set({ state: 'idle' });
      await voice.stop();
      await invoke('lm:settings:set', { voice: { enabled: false, device: 'auto' } });
    }
  });

  // The real runner and main's wiring: the user closes the setup window halfway (no status file,
  // the launcher just exits). The hold must end there, or the voice would stay stopped until the
  // 6-hour give-up. (An app restart mid-setup starts unheld: holds are in memory only.)
  it('a setup window closed before it finished ends the hold (real runner, launcher exit)', async () => {
    const t = main.__test;
    const setup = t.state.setup;
    const voice = t.state.voice;
    await invoke('lm:settings:set', { voice: { enabled: false } });
    await voice.start();
    const saved = { spawn: setup._spawn, findTerminal: setup._o.findTerminal };
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: () => {}, pid: 4242 });
    setup._spawn = vi.fn(() => child);
    setup._o.findTerminal = () => ({ name: 'fake-terminal', path: process.execPath, args: (cmd) => cmd });
    try {
      const st = await setup.start({ cpu: true });
      expect(st.state).toBe('running');
      expect(setup._spawn).toHaveBeenCalledTimes(1);
      expect(voice.held).toBe(true);
      await invoke('lm:voice:restart'); // deferred while the window runs
      expect(voice.held).toBe(true);
      child.emit('exit', process.platform === 'win32' ? 0xc000013a : 1);
      expect(setup.state).toMatchObject({ state: 'failed' });
      expect(setup.state.detail).toMatch(/closed before it finished/);
      expect(voice.held).toBe(false);
      for (let i = 0; i < 50 && voice.info().status !== 'disabled'; i++) await new Promise((r) => setTimeout(r, 20));
      expect(voice.info().status).toBe('disabled'); // the previous voice is back (here: turned off)
      expect((await invoke('lm:voice:info')).setup).toMatchObject({ state: 'failed' });
    } finally {
      setup._spawn = saved.spawn;
      setup._o.findTerminal = saved.findTerminal;
      setup._set({ state: 'idle' });
      await voice.stop();
    }
  });

  it('camera: video permission follows camera.enabled; images pass claude:send validation; tray item', async () => {
    const grant = vi.fn();
    const request = (url, types) => m.sessionHandlers.request(win.webContents, 'media', grant, { requestingUrl: url, mediaTypes: types });
    const checkVideo = () => m.sessionHandlers.check(win.webContents, 'media', 'app://lawnmower', { mediaType: 'video' });
    const cameraItem = () => main.__test.state.tray.menu.template.find((i) => i.label === 'Camera');
    try {
      request('app://lawnmower/index.html', ['video']);
      expect(checkVideo()).toBe(false);
      expect(cameraItem().checked).toBe(false);
      await invoke('lm:settings:set', { camera: { enabled: true } });
      request('app://lawnmower/index.html', ['video']);
      request('app://lawnmower/index.html', ['audio']);
      request('https://evil.example/', ['video']);
      expect(checkVideo()).toBe(true);
      expect(grant.mock.calls.map((c) => c[0])).toEqual([false, true, true, false]);
      expect(cameraItem().checked).toBe(true);
      cameraItem().click({ checked: false }); // the tray turns it off again
      expect((await invoke('lm:settings:get')).camera.enabled).toBe(false);
      expect(checkVideo()).toBe(false);

      // a snapshot with the turn: validated, then an image block the fake CLI acknowledges
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0]).toString('base64');
      const { turnId } = await invoke('lm:claude:send', 'look at me', { images: [{ mediaType: 'image/jpeg', data: jpeg }] });
      const [, ev] = await waitForSent(([ch, p]) => ch === 'lm:claude:event' && p.type === 'turn_end' && p.turnId === turnId);
      expect(ev.result).toBe('You said: look at me [saw 1 image: image/jpeg 640x480, 24 bytes]');
      await expect(invoke('lm:claude:send', 'x', { images: [{ mediaType: 'image/jpeg', data: `data:image/jpeg;base64,${jpeg}` }] })).rejects.toThrow(/data: prefix/);
      await expect(invoke('lm:claude:send', 'x', { images: [{ mediaType: 'image/png', data: jpeg }] })).rejects.toThrow(/not really image\/png/);
      await expect(invoke('lm:claude:send', 'x', 'images')).rejects.toThrow(/options must be an object/);
    } finally {
      await invoke('lm:settings:set', { camera: { enabled: false } });
    }
  });

  it('shuts down child processes on will-quit, then quits', async () => {
    const claude = main.__test.state.claude;
    expect(claude.status().status).toBe('ready');
    const prevent = vi.fn();
    m.appEvents.get('will-quit')({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
    for (let i = 0; i < 100 && !electron.app.quit.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 30));
    expect(electron.app.quit).toHaveBeenCalled();
    expect(claude.status().status).toBe('exited');
    expect(electron.globalShortcut.unregisterAll).toHaveBeenCalled();
  });
});
