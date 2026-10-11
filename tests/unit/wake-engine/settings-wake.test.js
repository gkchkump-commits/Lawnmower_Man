import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, SettingsStore, applyPatch, defaultSettings } from '../../../electron/settings.js';
import { DEFAULT_SETTINGS as RENDERER_DEFAULTS } from '../../../src/app/settings-defaults.js';
import { tmpDir } from '../helpers/tmp.js';

const base = defaultSettings('win32');
const patch = (p) => applyPatch(base, p);

describe('settings: the "Hey Jade" group (contract §4.1)', () => {
  it('has the contract defaults; no migration (version stays 3)', () => {
    expect(DEFAULT_SETTINGS.wake).toEqual({
      enabled: false, phrase: 'hey-jade', sensitivity: 'normal', followUpSec: 6, bargeIn: true, sounds: 'start', whileHidden: true, transcriptFallback: false, explained: false,
    });
    expect(SETTINGS_VERSION).toBe(3);
  });

  // The renderer's mirror (src/app/settings-defaults.js) belongs to the renderer lane; once it has
  // the group the two must agree (and the orchestrator's merge makes this run).
  it.runIf(RENDERER_DEFAULTS.wake !== undefined)('the renderer mirrors the defaults', () => {
    expect(RENDERER_DEFAULTS.wake).toEqual(DEFAULT_SETTINGS.wake);
  });

  it('followUpSec: 0 (off) or 4..15, rounded', () => {
    const f = (v) => patch({ wake: { followUpSec: v } }).settings.wake.followUpSec;
    expect(f(0)).toBe(0);
    expect(f(-3)).toBe(0);
    expect(f(0.4)).toBe(0);
    expect(f(1)).toBe(4);
    expect(f(6)).toBe(6);
    expect(f(9.6)).toBe(10);
    expect(f(99)).toBe(15);
    expect(f('6')).toBe(6); // not a number: kept
    expect(patch({ wake: { followUpSec: NaN } }).warnings.join()).toMatch(/wake\.followUpSec/);
  });

  it('enums and booleans', () => {
    const s = patch({ wake: { phrase: 'jade', sensitivity: 'high', sounds: 'start-end', enabled: true, bargeIn: false, whileHidden: false, transcriptFallback: true, explained: true } }).settings.wake;
    expect(s).toMatchObject({ phrase: 'jade', sensitivity: 'high', sounds: 'start-end', enabled: true, bargeIn: false, whileHidden: false, transcriptFallback: true, explained: true });
    const bad = patch({ wake: { phrase: 'hey jude', sensitivity: 'max', sounds: 'loud', enabled: 'yes', bogus: 1 } });
    expect(bad.settings.wake).toEqual(DEFAULT_SETTINGS.wake);
    expect(bad.warnings.length).toBe(5);
    expect(bad.warnings.join('\n')).toMatch(/unknown setting "wake.bogus"/);
  });

  it('a settings file without the group loads with its defaults', () => {
    const dir = tmpDir('lm-set-wake-');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 3, voice: { handsFree: true } }));
    const s = new SettingsStore({ dir, platform: 'linux' }).load();
    expect(s.wake).toEqual(DEFAULT_SETTINGS.wake);
    expect(s.voice.handsFree).toBe(true);
  });
});
