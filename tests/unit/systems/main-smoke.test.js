// Smoke test of electron/main.js wiring with a mocked `electron` module (the Electron binary is
// not needed). Drives a real ClaudeSession against the fake CLI through the IPC handlers.
/* global Request */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
        webRequest: { onHeadersReceived: vi.fn((h) => { m.sessionHandlers.headers = h; }) },
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
    const toRenderer = ['lm:claude:event', 'lm:voice:status', 'lm:settings:changed', 'lm:hotkey', 'lm:cursor'];
    const registered = new Set([...m.handlers.keys(), ...m.listeners.keys(), ...toRenderer]);
    expect([...used].sort()).toEqual([...registered].sort());
    expect([...m.handlers.keys()].sort()).toEqual([
      'lm:app:info', 'lm:claude:cancel', 'lm:claude:interrupt', 'lm:claude:reset', 'lm:claude:respond-permission', 'lm:claude:send', 'lm:claude:status',
      'lm:settings:get', 'lm:settings:set', 'lm:voice:info', 'lm:voice:restart',
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
    win.show();
    expect(tracker.running).toBe(true);
    await invoke('lm:settings:set', { avatar: { followCursor: false } });
    expect(tracker.running).toBe(false);
    await invoke('lm:settings:set', { avatar: { followCursor: true } });
    expect(tracker.running).toBe(true);
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
    m.sessionHandlers.headers({ resourceType: 'mainFrame', responseHeaders: { 'Content-Type': ['text/html'] } }, cb);
    expect(cb.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toEqual([main.__test.csp]);
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
