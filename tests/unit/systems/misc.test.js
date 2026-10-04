import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildPersona, personaFileName, SPEECH_RULES } from '../../../electron/persona.js';
import { buildTrayTemplate, trayTooltip } from '../../../electron/tray-menu.js';
import { HotkeyManager, acceleratorKey } from '../../../electron/hotkeys.js';
import { crc32, encodePng, renderIconPng, renderIconRgba } from '../../../electron/icon.js';
import {
  validatePermissionResponse,
  validateSettingsPatch,
  validateSizePreset,
  validateTurnText,
  validateBoolean,
} from '../../../electron/ipc-validate.js';
import { createLogger } from '../../../electron/logger.js';
import { DEFAULT_SETTINGS, cloneSettings } from '../../../electron/settings.js';

describe('persona', () => {
  it('chat mode is a complete spoken-assistant system prompt', () => {
    const p = buildPersona('chat', { platform: 'win32', now: new Date('2026-10-03T12:00:00Z') });
    expect(p).toMatch(/You are Claude/);
    expect(p).toMatch(/read aloud/);
    expect(p).toMatch(/one to three sentences/);
    expect(p).toMatch(/no headings, bullet or numbered lists, tables/i);
    expect(p).toMatch(/chat panel/);
    expect(p).toMatch(/cannot see the user's screen/);
    expect(p).toMatch(/October 3, 2026/);
    expect(p).toMatch(/Windows/);
  });
  it('assistant/agent modes are appended instructions with mode-specific capabilities', () => {
    const a = buildPersona('assistant', { platform: 'linux', workdir: '/home/ada/LawnmowerMan' });
    expect(a).toMatch(/Lawnmower Man/);
    expect(a).toMatch(/WebSearch/);
    expect(a).toMatch(/cannot edit files/);
    expect(a).toMatch(/\/home\/ada\/LawnmowerMan/);
    const g = buildPersona('agent', { platform: 'linux' });
    expect(g).toMatch(/approval card/);
    expect(a).toContain(SPEECH_RULES);
    expect(g).toContain(SPEECH_RULES);
  });
  it('custom persona replaces the character but keeps the speech rules', () => {
    const p = buildPersona('chat', { custom: 'You are Captain Nemo, a gruff submarine captain.' });
    expect(p.startsWith('You are Captain Nemo')).toBe(true);
    expect(p).not.toMatch(/quietly witty/);
    expect(p).toContain(SPEECH_RULES);
    expect(buildPersona('agent', { custom: 'Be a pirate.' })).toMatch(/Persona\nBe a pirate\./);
  });
  it('personaFileName', () => {
    expect(personaFileName('chat')).toBe('persona-chat.txt');
    expect(personaFileName('bogus')).toBe('persona-chat.txt');
    expect(personaFileName('agent')).toBe('persona-agent.txt');
  });
});

describe('tray menu', () => {
  const actions = Object.fromEntries(
    ['toggleVisible', 'setAlwaysOnTop', 'setClickThrough', 'setShowChat', 'setMode', 'setSizePreset', 'newConversation', 'restartVoice', 'openSettingsFile', 'openWorkdir', 'openLogs', 'quit'].map((k) => [k, vi.fn()]),
  );
  const st = {
    visible: true,
    settings: cloneSettings(DEFAULT_SETTINGS),
    claudeStatus: 'ready',
    voiceStatus: 'disabled',
    voiceDetail: 'Run setup',
    hotkeyConflicts: [{ name: 'toggleListen', accelerator: 'CommandOrControl+Alt+Space', reason: 'already used by another application' }],
  };
  const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);

  it('has every required entry wired to an action', () => {
    const items = flat(buildTrayTemplate(st, actions));
    const byLabel = (re) => items.find((i) => re.test(i.label || ''));
    byLabel(/^Hide avatar/).click();
    expect(actions.toggleVisible).toHaveBeenCalled();
    byLabel(/^Always on top/).click({ checked: false });
    expect(actions.setAlwaysOnTop).toHaveBeenCalledWith(false);
    byLabel(/^Click-through/).click({ checked: true });
    expect(actions.setClickThrough).toHaveBeenCalledWith(true);
    byLabel(/^Agent/).click();
    expect(actions.setMode).toHaveBeenCalledWith('agent');
    byLabel(/^Large/).click();
    expect(actions.setSizePreset).toHaveBeenCalledWith('large');
    for (const [re, fn] of [[/^New conversation/, 'newConversation'], [/^Restart voice/, 'restartVoice'], [/^Open settings/, 'openSettingsFile'], [/^Open working/, 'openWorkdir'], [/^Open logs/, 'openLogs'], [/^Quit/, 'quit']]) {
      byLabel(re).click();
      expect(actions[fn]).toHaveBeenCalled();
    }
    expect(byLabel(/^Chat \(no tools\)/).checked).toBe(true);
    expect(byLabel(/^Medium/).checked).toBe(true);
    expect(byLabel(/^Shortcut CommandOrControl\+Alt\+Space unavailable/).enabled).toBe(false);
    expect(byLabel(/^Voice: Disabled/)).toBeTruthy();
    expect(trayTooltip(st)).toBe('Lawnmower Man — Claude: ready · Voice: disabled');
  });

  it('offers "Set up local voice…" (disabled while it runs) and names Claude setup problems', () => {
    const setupVoice = vi.fn();
    const a = { ...actions, setupVoice };
    const labels = (s) => flat(buildTrayTemplate(s, a));
    const item = labels({ ...st, voiceInstalled: false }).find((i) => i.label === 'Set up local voice…');
    item.click();
    expect(setupVoice).toHaveBeenCalledTimes(1);
    expect(labels({ ...st, voiceInstalled: true }).some((i) => i.label === 'Set up local voice again…')).toBe(true);
    const running = labels({ ...st, voiceSetup: 'running' }).find((i) => /setup is running/.test(i.label || ''));
    expect(running.enabled).toBe(false);
    expect(running.click).toBeUndefined();
    expect(labels({ ...st, claudeStatus: 'error', claudeProblem: 'cli-missing' }).some((i) => i.label === 'Claude: Not installed')).toBe(true);
    expect(trayTooltip({ ...st, claudeProblem: 'auth' })).toBe('Lawnmower Man — Claude: not signed in · Voice: disabled');
  });
});

describe('HotkeyManager', () => {
  function fakeGs(taken = []) {
    const registered = new Map();
    return {
      registered,
      register: vi.fn((acc, cb) => {
        if (taken.includes(acc)) return false;
        if (acc === 'F13') throw new Error('accelerator rejected');
        registered.set(acc, cb);
        return true;
      }),
      unregister: vi.fn((acc) => registered.delete(acc)),
    };
  }
  it('registers, reports conflicts and re-registers on change', () => {
    const gs = fakeGs(['CommandOrControl+Alt+C']);
    const fired = [];
    const m = new HotkeyManager({ globalShortcut: gs, onHotkey: (n) => fired.push(n) });
    const r = m.apply(DEFAULT_SETTINGS.hotkeys);
    expect(r.registered).toEqual({ toggleListen: 'CommandOrControl+Alt+Space', stopSpeaking: 'CommandOrControl+Alt+X' });
    expect(r.conflicts).toEqual([{ name: 'toggleChat', accelerator: 'CommandOrControl+Alt+C', reason: 'already used by another application' }]);
    gs.registered.get('CommandOrControl+Alt+Space')();
    expect(fired).toEqual(['toggleListen']);

    const r2 = m.apply({ toggleListen: 'F9', toggleChat: 'CmdOrCtrl+Shift+K', stopSpeaking: 'Shift+CommandOrControl+K' });
    expect(gs.unregister).toHaveBeenCalledWith('CommandOrControl+Alt+Space');
    expect(r2.registered).toEqual({ toggleListen: 'F9', toggleChat: 'CmdOrCtrl+Shift+K' });
    expect(r2.conflicts[0]).toMatchObject({ name: 'stopSpeaking', reason: 'same as toggleChat' });
    expect([...gs.registered.keys()]).toEqual(['F9', 'CmdOrCtrl+Shift+K']);
    m.dispose();
    expect(gs.registered.size).toBe(0);
  });
  it('treats empty as disabled and invalid as a conflict', () => {
    const m = new HotkeyManager({ globalShortcut: fakeGs(), onHotkey: () => {} });
    const r = m.apply({ toggleListen: '', toggleChat: 'Ctrl+', stopSpeaking: 'Alt+Bad' });
    expect(r.registered).toEqual({});
    expect(r.conflicts).toEqual([
      { name: 'toggleChat', accelerator: 'Ctrl+', reason: 'invalid shortcut' },
      { name: 'stopSpeaking', accelerator: 'Alt+Bad', reason: 'invalid shortcut' },
    ]);
    const r2 = m.apply({ toggleListen: 'F13' });
    expect(r2.conflicts[0].reason).toMatch(/rejected by the system/);
    expect(acceleratorKey('Shift+Ctrl+A')).toBe(acceleratorKey('Control+Shift+A'));
  });
});

describe('icon PNG', () => {
  it('encodes valid PNGs (signature, CRC, decodable IDAT)', () => {
    const png = renderIconPng(16);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(16); // IHDR width
    let off = 8;
    const chunks = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.subarray(off + 4, off + 8).toString('ascii');
      const data = png.subarray(off + 8, off + 8 + len);
      expect(png.readUInt32BE(off + 8 + len)).toBe(crc32(png.subarray(off + 4, off + 8 + len)));
      chunks.push({ type, data });
      off += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const raw = zlib.inflateSync(chunks[1].data);
    expect(raw.length).toBe((16 * 4 + 1) * 16);
  });
  it('draws something visible with transparent corners and amber eyes', () => {
    const size = 64;
    const px = renderIconRgba(size);
    const at = (x, y) => px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
    expect(at(0, 0)[3]).toBeLessThan(10);
    const eye = at(Math.round(size * (0.5 - 0.27 / 2 / 1.08)), Math.round(size * 0.49));
    expect(eye[3]).toBeGreaterThan(200);
    expect(eye[0]).toBeGreaterThan(eye[2]); // warm (amber), not blue
    expect(encodePng(1, 1, new Uint8Array([1, 2, 3, 4])).length).toBeGreaterThan(40);
  });
  it('shipped asset files exist', () => {
    for (const f of ['icon.png', 'tray.png', 'tray@2x.png']) expect(fs.existsSync(path.resolve('electron/assets', f))).toBe(true);
  });
});

describe('ipc-validate', () => {
  it('validates turn text', () => {
    expect(validateTurnText('hi')).toBe('hi');
    expect(() => validateTurnText('')).toThrow();
    expect(() => validateTurnText({})).toThrow();
  });
  it('validates permission responses', () => {
    expect(validatePermissionResponse('r1', { behavior: 'allow' })).toEqual({ requestId: 'r1', decision: { behavior: 'allow' } });
    expect(validatePermissionResponse('r1', { behavior: 'deny', message: 'no', extra: 1 })).toEqual({ requestId: 'r1', decision: { behavior: 'deny', message: 'no' } });
    expect(validatePermissionResponse('r1', { behavior: 'allow', updatedInput: { a: 1 } }).decision.updatedInput).toEqual({ a: 1 });
    expect(() => validatePermissionResponse('', { behavior: 'allow' })).toThrow();
    expect(() => validatePermissionResponse('r', { behavior: 'yes' })).toThrow();
    expect(() => validatePermissionResponse('r', { behavior: 'allow', updatedInput: [1] })).toThrow();
    expect(() => validatePermissionResponse('r', { behavior: 'allow', updatedInput: { big: 'x'.repeat(2 * 1024 * 1024) } })).toThrow(/too large/);
  });
  it('validates settings patches, booleans and presets', () => {
    expect(validateSettingsPatch({ a: 1 })).toEqual({ a: 1 });
    expect(() => validateSettingsPatch(null)).toThrow();
    expect(() => validateSettingsPatch([1])).toThrow();
    expect(validateBoolean(true)).toBe(true);
    expect(() => validateBoolean('true')).toThrow();
    expect(validateSizePreset('small')).toBe('small');
    expect(() => validateSizePreset('xl')).toThrow();
  });
});

describe('logger', () => {
  it('writes and rotates the log file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-log-'));
    const log = createLogger({ dir, maxBytes: 200, console: false });
    for (let i = 0; i < 20; i++) log('info', `line ${i} ${'x'.repeat(20)}`);
    log('debug', 'hidden');
    expect(fs.existsSync(path.join(dir, 'main.old.log'))).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(text).toMatch(/line 19/);
    expect(text).not.toMatch(/hidden/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
