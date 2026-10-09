import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsStore,
  WIN32_HOTKEYS,
  applyPatch,
  deepMerge,
  defaultHotkeys,
  defaultSettings,
  normalizeAccelerator,
  sanitizeSettings,
} from '../../../electron/settings.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-settings-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('defaults', () => {
  it('match the contract (§4)', () => {
    expect(DEFAULT_SETTINGS.claude).toEqual({
      cliPath: '', model: '', effort: '', mode: 'chat', workdir: '', persona: '', resumeLastSession: true, lastSessionId: '',
    });
    expect(DEFAULT_SETTINGS.voice).toMatchObject({ enabled: true, sttModel: 'large-v3-turbo', ttsVoice: 'af_heart', ttsSpeed: 1.0, systemVoice: '', device: 'auto', handsFree: false, speakReplies: true });
    expect(DEFAULT_SETTINGS.avatar).toEqual({ renderer: 'relief', pack: 'reference', quality: 'high', particles: 1.0, bloom: 1.0, followCursor: true, expressiveness: 1.0 });
    expect(DEFAULT_SETTINGS.window).toMatchObject({ sizePreset: 'medium', alwaysOnTop: true, clickThrough: true, position: null, showChat: true });
    expect(DEFAULT_SETTINGS.hotkeys).toEqual({
      toggleListen: 'CommandOrControl+Alt+Space', toggleChat: 'CommandOrControl+Alt+C', stopSpeaking: 'CommandOrControl+Alt+X',
    });
  });
});

describe('deepMerge', () => {
  it('merges objects recursively and replaces null/arrays', () => {
    const out = deepMerge({ a: { b: 1, c: 2 }, p: { x: 1, y: 2 } }, { a: { c: 3 }, p: null });
    expect(out).toEqual({ a: { b: 1, c: 3 }, p: null });
  });
  it('ignores prototype-polluting keys', () => {
    const out = deepMerge({}, JSON.parse('{"__proto__":{"polluted":1}}'));
    expect(({}).polluted).toBeUndefined();
    expect(out.polluted).toBeUndefined();
  });
});

describe('applyPatch validation', () => {
  const base = sanitizeSettings({}).settings;

  it('accepts valid values and keeps others', () => {
    const { settings, warnings } = applyPatch(base, { claude: { mode: 'agent', model: 'sonnet[1m]' }, window: { position: { x: 10.4, y: -20.6 } } });
    expect(warnings).toEqual([]);
    expect(settings.claude.mode).toBe('agent');
    expect(settings.claude.model).toBe('sonnet[1m]');
    expect(settings.window.position).toEqual({ x: 10, y: -21 });
    expect(settings.voice).toEqual(base.voice);
  });

  it('rejects wrong types, enums and unsafe strings with warnings', () => {
    const { settings, warnings } = applyPatch(base, {
      claude: { mode: 'god', effort: 'ultra', model: 'opus; rm -rf /', lastSessionId: '../../x', cliPath: 'a\nb' },
      voice: { enabled: 'yes', device: 'tpu', sttLanguage: 'English!' },
      avatar: { renderer: 42 },
      bogus: { a: 1 },
      window: { nope: true },
    });
    expect(settings).toEqual(base);
    expect(warnings.length).toBeGreaterThanOrEqual(10);
    expect(warnings.join('\n')).toMatch(/unknown setting "bogus"/);
    expect(warnings.join('\n')).toMatch(/unknown setting "window.nope"/);
  });

  it('clamps numbers into range', () => {
    const { settings } = applyPatch(base, { avatar: { particles: 5, bloom: -1 }, voice: { ttsSpeed: 0.1 } });
    expect(settings.avatar.particles).toBe(2);
    expect(settings.avatar.bloom).toBe(0);
    expect(settings.voice.ttsSpeed).toBe(0.5);
    expect(applyPatch(base, { avatar: { particles: Number.NaN } }).settings.avatar.particles).toBe(1);
    // avatar.expressiveness: 0..2, a bad value keeps the current one
    expect(applyPatch(base, { avatar: { expressiveness: 0.4 } }).settings.avatar.expressiveness).toBe(0.4);
    expect(applyPatch(base, { avatar: { expressiveness: 7 } }).settings.avatar.expressiveness).toBe(2);
    expect(applyPatch(base, { avatar: { expressiveness: -3 } }).settings.avatar.expressiveness).toBe(0);
    expect(applyPatch(base, { avatar: { expressiveness: 'lots' } }).settings.avatar.expressiveness).toBe(1);
  });

  it('voice.systemVoice: any one-line voice name or URI; not control characters, newlines or huge strings', () => {
    const name = 'Microsoft Aria Online (Natural) - English (United States)';
    expect(applyPatch(base, { voice: { systemVoice: `  ${name}  ` } }).settings.voice.systemVoice).toBe(name);
    expect(applyPatch(base, { voice: { systemVoice: 'Google 日本語 · ja-JP' } }).settings.voice.systemVoice).toBe('Google 日本語 · ja-JP');
    expect(applyPatch(base, { voice: { systemVoice: '' } }).settings.voice.systemVoice).toBe('');
    for (const bad of ['a\nb', 'x\u0007', 'v'.repeat(257), 42, null]) {
      const r = applyPatch(base, { voice: { systemVoice: bad } });
      expect(r.settings.voice.systemVoice, JSON.stringify(bad)).toBe('');
      expect(r.warnings.length).toBe(1);
    }
  });

  it('allows position null and rejects garbage positions', () => {
    const withPos = applyPatch(base, { window: { position: { x: 1, y: 2 } } }).settings;
    expect(applyPatch(withPos, { window: { position: null } }).settings.window.position).toBeNull();
    expect(applyPatch(withPos, { window: { position: { x: 'a', y: 2 } } }).settings.window.position).toEqual({ x: 1, y: 2 });
  });

  it('validates hotkeys and allows disabling them', () => {
    const { settings, warnings } = applyPatch(base, { hotkeys: { toggleListen: 'ctrl+shift+f9', toggleChat: '', stopSpeaking: 'Ctrl+Ctrl+X' } });
    expect(settings.hotkeys.toggleListen).toBe('Ctrl+Shift+F9');
    expect(settings.hotkeys.toggleChat).toBe('');
    expect(settings.hotkeys.stopSpeaking).toBe(base.hotkeys.stopSpeaking);
    expect(warnings).toHaveLength(1);
  });

  it('rejects non-object patches', () => {
    expect(applyPatch(base, 'x').warnings).toHaveLength(1);
    expect(applyPatch(base, [1]).warnings).toHaveLength(1);
    expect(applyPatch(base, { claude: 'x' }).warnings).toHaveLength(1);
  });
});

describe('normalizeAccelerator', () => {
  it.each([
    ['CommandOrControl+Alt+Space', 'CommandOrControl+Alt+Space'],
    ['cmdorctrl+alt+c', 'CmdOrCtrl+Alt+C'],
    ['F12', 'F12'],
    ['Shift+num5', 'Shift+num5'],
    ['Alt+/', 'Alt+/'],
    ['Super+Plus', 'Super+Plus'],
    ['', ''],
  ])('%s → %s', (input, out) => {
    expect(normalizeAccelerator(input)).toBe(out);
  });
  it.each(['Ctrl+', '+A', 'Ctrl+Alt', 'Ctrl+Hyper+A', 'Ctrl+A+B', 'Alt+Alt+A', 42, null])('rejects %s', (input) => {
    expect(normalizeAccelerator(input)).toBeNull();
  });
});

describe('SettingsStore', () => {
  it('returns defaults when no file exists and writes one', () => {
    const store = new SettingsStore({ dir });
    const s = store.load();
    expect(s).toEqual(sanitizeSettings({}).settings);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true);
  });

  it('persists updates atomically and emits change events', () => {
    const store = new SettingsStore({ dir });
    store.load();
    const changes = [];
    store.on('change', (next, prev) => changes.push([next, prev]));
    const r = store.update({ window: { sizePreset: 'large' } });
    expect(r.changed).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0][0].window.sizePreset).toBe('large');
    expect(changes[0][1].window.sizePreset).toBe('medium');
    // No change → no event.
    store.update({ window: { sizePreset: 'large' } });
    expect(changes).toHaveLength(1);
    // Reload from disk.
    const again = new SettingsStore({ dir }).load();
    expect(again.window.sizePreset).toBe('large');
    // No temp files left behind.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('get() returns copies', () => {
    const store = new SettingsStore({ dir });
    const a = store.get();
    a.claude.mode = 'agent';
    expect(store.get().claude.mode).toBe('chat');
  });

  it('recovers from a corrupt file and keeps it aside', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
    const warnings = [];
    const store = new SettingsStore({ dir });
    store.on('warning', (w) => warnings.push(w));
    const s = store.load();
    expect(s.claude.mode).toBe('chat');
    expect(warnings[0]).toMatch(/corrupt/);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => /^settings\.corrupt-\d+\.json$/.test(f))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).claude.mode).toBe('chat');
  });

  it('sanitizes a stale/partial file and keeps valid values', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '﻿' + JSON.stringify({ claude: { mode: 'assistant', effort: 'bogus' }, old: 1 }));
    const s = new SettingsStore({ dir }).load();
    expect(s.claude.mode).toBe('assistant');
    expect(s.claude.effort).toBe('');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.old).toBeUndefined();
    expect(onDisk.voice.sttModel).toBe('large-v3-turbo');
  });

  it('accepts a top-level array file as corrupt', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '[1,2,3]');
    expect(new SettingsStore({ dir }).load().window.sizePreset).toBe('medium');
  });
});

describe('Windows hotkey defaults (WIN-5: Ctrl+Alt = AltGr)', () => {
  const ctrlAltPrintable = (acc) => /^(CommandOrControl|Control|Ctrl)\+Alt\+(.|Space)$/i.test(acc);

  it('Windows defaults avoid Ctrl+Alt+<printable key>; other platforms keep the classic ones', () => {
    for (const acc of Object.values(defaultHotkeys('win32'))) {
      expect(ctrlAltPrintable(acc), acc).toBe(false);
      expect(normalizeAccelerator(acc)).toBe(acc);
    }
    expect(defaultHotkeys('win32')).toEqual({ ...WIN32_HOTKEYS });
    expect(defaultHotkeys('linux')).toEqual(DEFAULT_SETTINGS.hotkeys);
    expect(defaultHotkeys('darwin')).toEqual(DEFAULT_SETTINGS.hotkeys);
    expect(defaultSettings('win32').hotkeys).toEqual({ ...WIN32_HOTKEYS });
    expect(sanitizeSettings({}, 'win32').settings.hotkeys).toEqual({ ...WIN32_HOTKEYS });
    expect(new SettingsStore({ dir, platform: 'win32' }).load().hotkeys).toEqual({ ...WIN32_HOTKEYS });
    expect(new SettingsStore({ dir: path.join(dir, 'linux'), platform: 'linux' }).load().hotkeys).toEqual(DEFAULT_SETTINGS.hotkeys);
  });

  it('migrates old stored defaults once on Windows, keeps shortcuts the user chose', () => {
    const file = path.join(dir, 'settings.json');
    // a v1 file (no "version"): two old defaults left untouched, one changed by the user
    fs.writeFileSync(file, JSON.stringify({ hotkeys: { toggleListen: 'CommandOrControl+Alt+Space', toggleChat: 'CommandOrControl+Alt+C', stopSpeaking: 'Alt+F8' } }));
    const store = new SettingsStore({ dir, platform: 'win32' });
    expect(store.load().hotkeys).toEqual({ toggleListen: WIN32_HOTKEYS.toggleListen, toggleChat: WIN32_HOTKEYS.toggleChat, stopSpeaking: 'Alt+F8' });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(SETTINGS_VERSION);
    expect(onDisk.hotkeys.toggleChat).toBe(WIN32_HOTKEYS.toggleChat);
    expect(store.get().version).toBeUndefined(); // file metadata, not a setting

    // After the migration the user deliberately picks Ctrl+Alt+C again: it is kept from now on.
    store.update({ hotkeys: { toggleChat: 'CommandOrControl+Alt+C' } });
    expect(new SettingsStore({ dir, platform: 'win32' }).load().hotkeys.toggleChat).toBe('CommandOrControl+Alt+C');
  });

  it('does not touch hotkeys on other platforms (but stamps the version)', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ hotkeys: { toggleChat: 'CommandOrControl+Alt+C' } }));
    expect(new SettingsStore({ dir, platform: 'linux' }).load().hotkeys.toggleChat).toBe('CommandOrControl+Alt+C');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(SETTINGS_VERSION);
  });
});
