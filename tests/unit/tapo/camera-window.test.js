import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeBrowserWindow } from './helpers/fake-electron.js';
import { CameraWindow, cameraWindowTitle, cameraWindowUrl, usableBounds, DEFAULT_SIZE } from '../../../electron/tapo/camera-window.js';

const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] };

afterEach(() => vi.useRealTimers());

describe('camera window helpers', () => {
  it('URL, title and saved bounds', () => {
    expect(cameraWindowUrl(null)).toBe('app://lawnmower/tapo/index.html');
    expect(cameraWindowUrl('http://localhost:5221/')).toBe('http://localhost:5221/tapo/index.html');
    expect(cameraWindowTitle('front door camera')).toBe('Home camera — front door camera');
    expect(cameraWindowTitle('  ')).toBe('Home camera — camera');
    const displays = screen.getAllDisplays();
    expect(usableBounds(null, displays)).toBeNull();
    expect(usableBounds({ x: 10, y: 10, width: 800, height: 500 }, displays)).toEqual({ x: 10, y: 10, width: 800, height: 500 });
    expect(usableBounds({ x: 10, y: 10, width: 100, height: 100 }, displays)).toEqual({ x: 10, y: 10, width: 480, height: 320 }); // min size
    expect(usableBounds({ x: 1850, y: 10, width: 800, height: 500 }, displays)).toBeNull(); // only 70 px on screen
    expect(usableBounds({ x: -3000, y: 10, width: 800, height: 500 }, displays)).toBeNull(); // a monitor that is gone
  });
});

describe('CameraWindow', () => {
  const make = (o = {}) => new CameraWindow({ BrowserWindow: FakeBrowserWindow, preload: '/app/electron/preload-camera.cjs', url: 'app://lawnmower/tapo/index.html', screen, ...o });

  it('is sandboxed, isolated, hidden at first, and loads the camera page', () => {
    const w = make({ bounds: { x: 50, y: 60, width: 900, height: 560 }, onTop: true, title: 'Home camera — porch' });
    const bw = /** @type {FakeBrowserWindow} */ (w.win);
    expect(bw.opts.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: '/app/electron/preload-camera.cjs', backgroundThrottling: false, devTools: false });
    expect(bw.opts).toMatchObject({ show: false, x: 50, y: 60, width: 900, height: 560, alwaysOnTop: true, title: 'Home camera — porch' });
    expect(bw.centered).toBe(false);
    expect(bw.loads).toEqual(['app://lawnmower/tapo/index.html']);
    const w2 = make({ bounds: { x: 5000, y: 5000, width: 900, height: 560 } });
    expect(/** @type {FakeBrowserWindow} */ (w2.win).opts).toMatchObject(DEFAULT_SIZE);
    expect(/** @type {FakeBrowserWindow} */ (w2.win).centered).toBe(true);
  });

  it('visibility follows show / hide / minimize / restore; close hides it unless the app quits', () => {
    let quitting = false;
    const w = make({ isQuitting: () => quitting });
    const bw = /** @type {FakeBrowserWindow} */ (w.win);
    const seen = [];
    w.on('visibility', (v) => seen.push(v));
    w.show();
    expect(bw.focused).toBe(1);
    bw.minimize();
    w.show({ focus: false });
    expect(bw.focused).toBe(1);
    bw.userClose();
    expect(bw.destroyed).toBe(false);
    expect(seen).toEqual([true, false, true, true, false]);
    expect(w.visible()).toBe(false);
    quitting = true;
    let closed = 0;
    w.on('closed', () => closed++);
    bw.userClose();
    expect(bw.destroyed).toBe(true);
    expect(closed).toBe(1);
    expect(w.webContents).toBeNull();
    w.show(); // no throw after close
    w.setTitle('x');
  });

  it('bounds are reported debounced; title and always-on-top can change; destroy is final', () => {
    vi.useFakeTimers();
    const w = make();
    const bw = /** @type {FakeBrowserWindow} */ (w.win);
    const bounds = [];
    w.on('bounds', (b) => bounds.push(b));
    bw.bounds = { x: 1, y: 2, width: 800, height: 500 };
    bw.emit('move');
    vi.advanceTimersByTime(200);
    bw.bounds = { x: 3, y: 4, width: 800, height: 500 };
    bw.emit('resize');
    vi.advanceTimersByTime(399);
    expect(bounds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bounds).toEqual([{ x: 3, y: 4, width: 800, height: 500 }]);
    bw.minimized = true;
    bw.emit('move');
    vi.advanceTimersByTime(400);
    expect(bounds).toHaveLength(1); // not while minimized
    w.setTitle('porch');
    expect(bw.title).toBe('Home camera — porch');
    w.setOnTop(true);
    expect(bw.onTop).toBe(true);
    expect(w.center()).toEqual({ x: 3 + 400, y: 4 + 250 });
    w.destroy();
    expect(bw.destroyed).toBe(true);
  });

  it('a crashed renderer is reloaded after 1 s, at most 3 times in 10 minutes; blur and gone are reported', () => {
    vi.useFakeTimers();
    const logs = [];
    const w = make({ log: (l, m) => logs.push(`${l} ${m}`) });
    const bw = /** @type {FakeBrowserWindow} */ (w.win);
    let gone = 0;
    let blur = 0;
    let loads = 0;
    w.on('gone', () => gone++);
    w.on('blur', () => blur++);
    w.on('load', () => loads++);
    bw.emit('blur');
    for (let i = 0; i < 4; i++) {
      bw.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      vi.advanceTimersByTime(1000);
    }
    expect(gone).toBe(4);
    expect(blur).toBe(1);
    expect(bw.loads).toHaveLength(1 + 3);
    expect(logs.some((l) => /crashed 4 times/.test(l))).toBe(true);
    // a clean exit is not a crash
    bw.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    vi.advanceTimersByTime(1000);
    expect(bw.loads).toHaveLength(4);
    // ten minutes later it may reload again
    vi.advanceTimersByTime(10 * 60 * 1000);
    bw.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    vi.advanceTimersByTime(1000);
    expect(bw.loads).toHaveLength(5);
    bw.webContents.emit('did-finish-load');
    expect(loads).toBe(1);
  });

  it('dev tools keys only when dev tools are allowed', () => {
    const w = make({ devTools: true });
    const bw = /** @type {FakeBrowserWindow} */ (w.win);
    const ev = { preventDefault: vi.fn() };
    bw.webContents.emit('before-input-event', ev, { type: 'keyDown', key: 'F12' });
    bw.webContents.emit('before-input-event', ev, { type: 'keyDown', key: 'r', control: true });
    expect(bw.webContents.toggleDevTools).toHaveBeenCalledTimes(1);
    expect(bw.webContents.reload).toHaveBeenCalledTimes(1);
    const w2 = make();
    expect(/** @type {FakeBrowserWindow} */ (w2.win).webContents.listenerCount('before-input-event')).toBe(0);
  });
});
