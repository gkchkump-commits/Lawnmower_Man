import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, SettingsStore, applyPatch, defaultSettings } from '../../../electron/settings.js';
import { DEFAULT_SETTINGS as RENDERER_DEFAULTS } from '../../../src/app/settings-defaults.js';

const base = defaultSettings('win32');
const patch = (p) => applyPatch(base, p);

describe('settings: tapo and security groups', () => {
  it('have the contract defaults (and no password anywhere)', () => {
    expect(DEFAULT_SETTINGS.tapo).toMatchObject({ enabled: false, name: 'camera', host: '', onvifPort: 2020, rtspPort: 554, username: '', stream: 'stream1', ptz: 'auto', viewUnitsX: 0.5, viewUnitsY: 1.4, minStep: 0.05, msPerUnit: 6000, localPresets: [], windowBounds: null });
    expect(DEFAULT_SETTINGS.security).toMatchObject({ armed: false, armDelaySec: 30, notify: 'person', record: 'person', preRollSec: 5, postRollSec: 10, maxClipSec: 120, retentionDays: 7, maxStorageGB: 5, clipsDir: '', claudeSee: 'ask', claudeMove: 'ask', describe: false, voiceCommands: true });
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toMatch(/password/i);
    expect(SETTINGS_VERSION).toBe(3); // new groups need no migration
  });

  it('mirrors the renderer defaults', () => {
    expect(RENDERER_DEFAULTS.tapo).toEqual(DEFAULT_SETTINGS.tapo);
    expect(RENDERER_DEFAULTS.security).toEqual(DEFAULT_SETTINGS.security);
  });

  it('the mock camera bridge clamps and checks like main (src/bridge/mock-tapo.js)', async () => {
    const { TAPO_NUMBER_RANGES, TAPO_ENUMS } = await import('../../../src/bridge/mock-tapo.js');
    for (const [p, [lo, hi]] of Object.entries(TAPO_NUMBER_RANGES)) {
      const [g, k] = p.split('.');
      expect(patch({ [g]: { [k]: -1e9 } }).settings[g][k], p).toBe(lo);
      expect(patch({ [g]: { [k]: 1e9 } }).settings[g][k], p).toBe(hi);
    }
    for (const [p, values] of Object.entries(TAPO_ENUMS)) {
      const [g, k] = p.split('.');
      for (const v of values) expect(patch({ [g]: { [k]: v } }).settings[g][k], p).toBe(v);
      expect(patch({ [g]: { [k]: 'bogus' } }).settings[g][k], p).toBe(DEFAULT_SETTINGS[g][k]);
    }
    // every numeric and enum setting of main is mirrored
    const numeric = Object.entries({ ...DEFAULT_SETTINGS.tapo, ...DEFAULT_SETTINGS.security }).filter(([, v]) => typeof v === 'number').map(([k]) => k).sort();
    expect(Object.keys(TAPO_NUMBER_RANGES).map((p) => p.split('.')[1]).sort()).toEqual(numeric);
    expect(Object.keys(TAPO_ENUMS).sort()).toEqual(['security.claudeMove', 'security.claudeSee', 'security.notify', 'security.record', 'security.sensitivity', 'tapo.ptz', 'tapo.stream']);
  });

  it('validates hosts: LAN only, never a URL', () => {
    expect(patch({ tapo: { host: ' 192.168.1.50 ' } }).settings.tapo.host).toBe('192.168.1.50');
    expect(patch({ tapo: { host: 'tapo.local' } }).settings.tapo.host).toBe('tapo.local');
    for (const bad of ['8.8.8.8', 'example.com', 'rtsp://192.168.1.50/stream1', '192.168.1.50:2020']) {
      const r = patch({ tapo: { host: bad } });
      expect(r.settings.tapo.host, bad).toBe('');
      expect(r.warnings.join(' ')).toMatch(/tapo\.host/);
    }
  });

  it('clamps and rounds numbers', () => {
    const s = patch({ tapo: { onvifPort: 70000.4, rtspPort: 0, msPerUnit: 1234.6, stepSmall: 0, viewUnitsY: 9 }, security: { armDelaySec: -5, preRollSec: 99, cooldownSec: 5, maxStorageGB: 0.1 } }).settings;
    expect(s.tapo).toMatchObject({ onvifPort: 65535, rtspPort: 1, msPerUnit: 1235, stepSmall: 0.02, viewUnitsY: 4 });
    expect(s.security).toMatchObject({ armDelaySec: 0, preRollSec: 15, cooldownSec: 10, maxStorageGB: 0.5 });
    expect(patch({ tapo: { onvifPort: '2020' } }).settings.tapo.onvifPort).toBe(2020);
  });

  it('local presets, window bounds, quiet hours, clips folder, user name', () => {
    expect(patch({ tapo: { localPresets: [{ name: ' Door ', x: 2, y: -0.5 }] } }).settings.tapo.localPresets).toEqual([{ name: 'Door', x: 1, y: -0.5 }]);
    expect(patch({ tapo: { localPresets: [{ name: '', x: 0, y: 0 }] } }).settings.tapo.localPresets).toEqual([]);
    expect(patch({ tapo: { localPresets: Array.from({ length: 17 }, () => ({ name: 'x', x: 0, y: 0 })) } }).warnings.length).toBe(1);
    expect(patch({ tapo: { windowBounds: { x: 10.6, y: -20, width: 960, height: 50 } } }).settings.tapo.windowBounds).toEqual({ x: 11, y: -20, width: 960, height: 100 });
    expect(patch({ tapo: { windowBounds: { x: 1 } } }).settings.tapo.windowBounds).toBeNull();
    expect(patch({ security: { quietHours: '22:00-07:00' } }).settings.security.quietHours).toBe('22:00-07:00');
    expect(patch({ security: { quietHours: '25:00-07:00' } }).settings.security.quietHours).toBe('');
    expect(patch({ security: { clipsDir: 'D:\\Clips' } }).settings.security.clipsDir).toBe('D:\\Clips');
    expect(patch({ security: { clipsDir: '/home/ada/clips' } }).settings.security.clipsDir).toBe('/home/ada/clips');
    expect(patch({ security: { clipsDir: 'relative/clips' } }).settings.security.clipsDir).toBe('');
    expect(patch({ tapo: { username: 'cam acct' } }).settings.tapo.username).toBe('');
    expect(patch({ tapo: { username: 'camacct' } }).settings.tapo.username).toBe('camacct');
    expect(patch({ tapo: { homePreset: 'local-0' } }).settings.tapo.homePreset).toBe('local-0');
    expect(patch({ tapo: { homePreset: '<script>' } }).settings.tapo.homePreset).toBe('');
    expect(patch({ tapo: { password: 'x' } }).warnings.join()).toMatch(/unknown setting "tapo.password"/);
  });

  it('a settings file without the groups loads with their defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-set-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 3, camera: { enabled: true } }));
    const s = new SettingsStore({ dir, platform: 'linux' }).load();
    expect(s.tapo).toEqual(DEFAULT_SETTINGS.tapo);
    expect(s.security).toEqual(DEFAULT_SETTINGS.security);
    expect(s.camera.enabled).toBe(true);
  });
});
