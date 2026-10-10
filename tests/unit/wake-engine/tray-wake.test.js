import { describe, it, expect, vi } from 'vitest';
import { buildTrayTemplate, trayTooltip, wakeTrayText } from '../../../electron/tray-menu.js';
import { DEFAULT_SETTINGS, cloneSettings } from '../../../electron/settings.js';

const st = (wake, tapo) => ({ visible: true, settings: cloneSettings(DEFAULT_SETTINGS), claudeStatus: 'ready', voiceStatus: 'ready', wake, tapo });

describe('tray: "Listen for “Hey Jade”" (contract §4.3)', () => {
  it('is a checkbox after the camera entries that calls setWakeWord', () => {
    const setWakeWord = vi.fn();
    const items = buildTrayTemplate(/** @type {any} */ (st({ enabled: false, state: 'off' }, { enabled: true, configured: true, connection: 'online', armed: false, arming: false, name: 'c' })), /** @type {any} */ ({ setWakeWord }));
    const labels = items.map((i) => i.label);
    const at = labels.indexOf('Listen for “Hey Jade”');
    expect(at).toBe(labels.indexOf('Home camera') + 1);
    expect(labels.indexOf('Home camera')).toBe(labels.indexOf('Camera') + 1); // the camera entries stay together
    expect(items[at]).toMatchObject({ type: 'checkbox', checked: false });
    items[at].click({ checked: true });
    expect(setWakeWord).toHaveBeenCalledWith(true);
    const on = buildTrayTemplate(/** @type {any} */ (st({ enabled: true, state: 'waiting' })), /** @type {any} */ ({ setWakeWord }));
    const item = on.find((i) => i.label === 'Listen for “Hey Jade”');
    expect(item.checked).toBe(true);
    expect(on.indexOf(item)).toBe(on.findIndex((i) => i.label === 'Camera') + 1); // no Home camera: right after Camera
    item.click({ checked: false });
    expect(setWakeWord).toHaveBeenLastCalledWith(false);
  });

  it('is absent without the wake word service (the menu is unchanged)', () => {
    expect(buildTrayTemplate(/** @type {any} */ (st(undefined)), /** @type {any} */ ({})).some((i) => /Hey Jade/.test(i.label || ''))).toBe(false);
    expect(trayTooltip(/** @type {any} */ (st(undefined)))).toBe('Lawnmower Man — Claude: ready · Voice: ready');
  });

  it('appends " · Jade: …" to the tooltip for every state', () => {
    const t = (wake) => trayTooltip(/** @type {any} */ (st(wake)));
    expect(t({ enabled: true, state: 'waiting' })).toBe('Lawnmower Man — Claude: ready · Voice: ready · Jade: listening for "Hey Jade"');
    expect(t({ enabled: false, state: 'off' })).toMatch(/· Jade: mic off$/);
    const text = (state, reason = '') => wakeTrayText({ enabled: true, state, reason });
    expect(text('off')).toBe('mic off');
    expect(text('paused')).toBe('paused while hidden');
    expect(text('locked')).toBe('paused (PC locked)');
    expect(text('unavailable', 'Hey Jade needs the local voice')).toBe('needs the local voice');
    expect(text('unavailable', 'The wake-word engine is not installed; reinstall Lawnmower Man.')).toBe('wake word unavailable');
    expect(text('blocked')).toBe('microphone blocked');
    expect(text('muted')).toBe('microphone muted');
    expect(text('starting')).toBe('starting');
    for (const s of ['attention', 'listening', 'followup', 'look', 'busy', 'barge']) expect(text(s), s).toBe('listening');
  });

  it('follows the Home camera in the tooltip', () => {
    const tip = trayTooltip(/** @type {any} */ (st({ enabled: true, state: 'busy' }, { enabled: true, configured: true, connection: 'online', armed: true, arming: false, name: 'c' })));
    expect(tip).toBe('Lawnmower Man — Claude: ready · Voice: ready · Home camera: armed · Jade: listening');
  });
});
