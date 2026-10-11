import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceleratorFromEvent, formatAccelerator } from '../../../src/ui/accelerator.js';
import { AvatarHost, createNullAvatar, packUrlFor } from '../../../src/ui/avatar-host.js';
import { computeLayout } from '../../../src/ui/layout.js';
import { describeClaude, describeVoice, shortModel } from '../../../src/ui/status.js';

describe('accelerator recorder', () => {
  const ev = (code, key, mods = {}) => ({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

  it('builds Electron accelerators', () => {
    expect(acceleratorFromEvent(ev('Space', ' ', { ctrlKey: true, altKey: true }))).toEqual({ accelerator: 'CommandOrControl+Alt+Space' });
    expect(acceleratorFromEvent(ev('KeyK', 'k', { ctrlKey: true, shiftKey: true }))).toEqual({ accelerator: 'CommandOrControl+Shift+K' });
    expect(acceleratorFromEvent(ev('Digit5', '%', { altKey: true, shiftKey: true }))).toEqual({ accelerator: 'Alt+Shift+5' });
    expect(acceleratorFromEvent(ev('F9', 'F9'))).toEqual({ accelerator: 'F9' });
    expect(acceleratorFromEvent(ev('ArrowUp', 'ArrowUp', { metaKey: true }), 'darwin')).toEqual({ accelerator: 'CommandOrControl+Up' });
    expect(acceleratorFromEvent(ev('KeyA', 'a', { metaKey: true }), 'win32')).toEqual({ accelerator: 'Super+A' });
  });

  it('keeps recording on modifier-only presses and rejects unsafe combos', () => {
    expect(acceleratorFromEvent(ev('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromEvent(ev('KeyA', 'a'))).toHaveProperty('error');
    expect(acceleratorFromEvent(ev('KeyA', 'A', { shiftKey: true }))).toHaveProperty('error');
    expect(acceleratorFromEvent(ev('IntlRo', 'ろ', { ctrlKey: true }))).toHaveProperty('error');
  });

  it('formats for display', () => {
    expect(formatAccelerator('CommandOrControl+Alt+Space', 'win32')).toBe('Ctrl+Alt+Space');
    expect(formatAccelerator('CommandOrControl+Alt+Space', 'darwin')).toBe('⌘⌥Space');
    expect(formatAccelerator('Super+Shift+X')).toBe('Win+Shift+X');
    expect(formatAccelerator('')).toBe('Off');
  });
});

describe('layout', () => {
  it('Electron: the strip is what is left under the 2:3 avatar area', () => {
    expect(computeLayout({ width: 400, height: 840, showChat: true, electron: true })).toEqual({ mode: 'full', chatHeight: 240 });
    expect(computeLayout({ width: 560, height: 1120, showChat: true, electron: true })).toEqual({ mode: 'full', chatHeight: 280 });
    // not resized yet after turning the chat on
    expect(computeLayout({ width: 400, height: 600, showChat: true, electron: true }).chatHeight).toBe(180);
    // minimal mode keeps the strip: the panel drops down into it below the face
    expect(computeLayout({ width: 400, height: 840, showChat: false, electron: true })).toEqual({ mode: 'minimal', chatHeight: 240 });
  });

  it('browser: about a third of the height, clamped', () => {
    expect(computeLayout({ width: 480, height: 760, showChat: true, electron: false }).chatHeight).toBe(258);
    expect(computeLayout({ width: 1200, height: 2000, showChat: true, electron: false }).chatHeight).toBe(300);
    expect(computeLayout({ width: 300, height: 400, showChat: true, electron: false }).chatHeight).toBe(190);
  });
});

describe('status text', () => {
  it('describes the Claude CLI status', () => {
    expect(describeClaude({ status: 'ready', model: 'claude-sonnet-4-5-20250929' })).toMatchObject({ text: 'Claude · sonnet 4.5', tone: 'ok' });
    expect(describeClaude({ status: 'error', detail: 'Claude CLI not found' })).toMatchObject({ tone: 'error', title: 'Claude CLI not found' });
    expect(describeClaude({ status: 'restarting' }).tone).toBe('warn');
    expect(shortModel('claude-opus-4-1[1m]')).toBe('opus 4.1');
  });

  it('describes the voice server', () => {
    const ready = describeVoice({ status: 'ready', health: { device: { cuda: true, name: 'RTX 5070', vramTotalMB: 8151, vramFreeMB: 6000 }, stt: { model: 'large-v3-turbo', device: 'cuda' } } }, { tts: 'server', stt: true });
    expect(ready.text).toBe('Voice · GPU');
    expect(ready.title).toContain('RTX 5070');
    expect(describeVoice({ status: 'ready', health: { device: { cuda: false } } }, { tts: 'server', stt: true }).text).toBe('Voice · CPU');
    expect(describeVoice({ status: 'disabled' }, { tts: 'browser', stt: false }).text).toBe('Voice · browser');
    expect(describeVoice({ status: 'disabled' }, { tts: 'none', stt: false }).text).toBe('Voice off');
    expect(describeVoice({ status: 'starting' }, { tts: 'none', stt: false }).tone).toBe('busy');
  });
});

describe('AvatarHost', () => {
  /** minimal DOM stand-ins */
  const makeCanvas = () => ({ id: '', className: '', attrs: {}, removed: false, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; }, getContext: () => null });
  let prevDocument;
  beforeEach(() => {
    prevDocument = globalThis.document;
    globalThis.document = /** @type {any} */ ({ createElement: () => makeCanvas() });
  });
  afterEach(() => {
    globalThis.document = prevDocument;
  });
  const stage = () => {
    const classes = new Set();
    return {
      children: [],
      prepend(c) { this.children.unshift(c); },
      querySelector: () => null,
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
      setAttribute() {},
      style: { setProperty() {} },
    };
  };
  const fakeAvatar = (opts) => ({ renderer: opts.renderer, opts, disposed: false, options: [], setOptions(o) { this.options.push(o); }, dispose() { this.disposed = true; }, setState() {} });
  const AV = { renderer: 'relief', pack: 'reference', quality: 'high', particles: 1, bloom: 1 };

  it('creates, updates options in place, and re-creates on renderer change', async () => {
    const created = [];
    const st = stage();
    const host = new AvatarHost(/** @type {any} */ (st), {
      createAvatar: async (canvas, o) => { const a = fakeAvatar(o); created.push(a); return a; },
      onCreated: () => {},
    });
    await host.apply(AV);
    expect(created).toHaveLength(1);
    expect(created[0].opts).toMatchObject({ renderer: 'relief', packUrl: './assets/avatars/reference/', quality: 'high', transparent: true });
    await host.apply({ ...AV, quality: 'low', bloom: 0.5 });
    expect(created).toHaveLength(1);
    expect(created[0].options.at(-1)).toEqual({ quality: 'low', particles: 1, bloom: 0.5 });
    // avatar.expressiveness reaches the avatar at creation and when it changes
    await host.apply({ ...AV, quality: 'low', bloom: 0.5, expressiveness: 1.6 });
    expect(created).toHaveLength(1);
    expect(created[0].options.at(-1)).toMatchObject({ expressiveness: 1.6 });
    await host.apply({ ...AV, renderer: 'procedural', expressiveness: 0.5 });
    expect(created).toHaveLength(2);
    expect(created[1].opts.expressiveness).toBe(0.5);
    // so does avatar.liveliness (the spontaneous behaviour)
    await host.apply({ ...AV, renderer: 'procedural', expressiveness: 0.5, liveliness: 1.7 });
    expect(created[1].options.at(-1)).toMatchObject({ liveliness: 1.7 });
    await host.apply({ ...AV, liveliness: 0.3, projector: true });
    expect(created[2].opts).toMatchObject({ liveliness: 0.3, projector: true });
    await host.apply({ ...AV, liveliness: 0.3, projector: false });
    expect(created[2].options.at(-1)).toMatchObject({ projector: false });
    expect(created[0].disposed).toBe(true);
    expect(host.avatar.renderer).toBe('relief');
  });

  it('coalesces rapid changes: only the latest renderer is built after the current one', async () => {
    const created = [];
    let release;
    const host = new AvatarHost(/** @type {any} */ (stage()), {
      createAvatar: (canvas, o) => new Promise((r) => {
        const a = fakeAvatar(o);
        created.push(a);
        if (o.renderer === 'relief') release = () => r(a);
        else r(a);
      }),
    });
    const p = host.apply(AV);
    host.apply({ ...AV, renderer: 'procedural' });
    host.apply({ ...AV, renderer: 'placeholder' });
    release();
    await p;
    expect(created.map((a) => a.renderer)).toEqual(['relief', 'placeholder']);
    expect(host.avatar.renderer).toBe('placeholder');
  });

  it('falls back to the no-op avatar when creation fails', async () => {
    const errors = [];
    const st = stage();
    let got = null;
    const host = new AvatarHost(/** @type {any} */ (st), {
      createAvatar: async () => { throw new Error('WebGL2 is not available'); },
      onCreated: (a) => { got = a; },
      onError: (e) => errors.push(e.message),
    });
    await host.apply(AV);
    expect(errors).toEqual(['WebGL2 is not available']);
    expect(st.classList.has('no-webgl')).toBe(true);
    expect(got).toBe(host.nullAvatar);
    expect(host.avatar.renderer).toBe('none');
  });

  it('null avatar hit-tests a head-shaped ellipse; pack URLs are sanitised', () => {
    const a = createNullAvatar(/** @type {any} */ (stage()));
    expect(a.hitTest(200, 250)).toBe(true);
    expect(a.hitTest(5, 5)).toBe(false);
    expect(packUrlFor({ pack: 'mine' })).toBe('./assets/avatars/mine/');
    expect(packUrlFor({ pack: '../../etc' })).toBe('./assets/avatars/reference/');
  });
});
