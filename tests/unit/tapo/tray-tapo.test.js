import { describe, it, expect, vi } from 'vitest';
import { buildTrayTemplate, trayTooltip } from '../../../electron/tray-menu.js';
import { DEFAULT_SETTINGS, cloneSettings } from '../../../electron/settings.js';

const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);

describe('tray: Home camera', () => {
  const st = (tapo) => ({ visible: true, settings: cloneSettings(DEFAULT_SETTINGS), claudeStatus: 'ready', voiceStatus: 'ready', tapo });
  const actions = { tapoShow: vi.fn(), tapoArm: vi.fn(), tapoOpenClips: vi.fn() };

  it('sits after "Camera" with show / armed / clips', () => {
    const items = buildTrayTemplate(/** @type {any} */ (st({ enabled: true, configured: true, connection: 'online', armed: false, arming: false, name: 'camera' })), /** @type {any} */ (actions));
    const labels = items.map((i) => i.label);
    expect(labels.indexOf('Home camera')).toBe(labels.indexOf('Camera') + 1);
    const sub = items.find((i) => i.label === 'Home camera').submenu;
    expect(sub.map((i) => i.label)).toEqual(['Online · Disarmed', 'Show camera window', 'Armed', 'Open clips folder']);
    sub[1].click();
    expect(actions.tapoShow).toHaveBeenCalled();
    sub[2].click({ checked: true });
    expect(actions.tapoArm).toHaveBeenCalledWith(true);
    sub[3].click();
    expect(actions.tapoOpenClips).toHaveBeenCalled();
    expect(sub[2]).toMatchObject({ type: 'checkbox', checked: false, enabled: true });
  });

  it('not set up: disabled entries and a status label; off: an offer to set it up', () => {
    const notSetUp = flat(buildTrayTemplate(/** @type {any} */ (st({ enabled: true, configured: false, connection: 'not-configured', armed: false, arming: false, name: 'camera' })), /** @type {any} */ (actions)));
    expect(notSetUp.find((i) => i.label === 'Not set up yet').enabled).toBe(false);
    expect(notSetUp.find((i) => i.label === 'Armed').enabled).toBe(false);
    expect(notSetUp.find((i) => i.label === 'Set up the home camera…')).toBeTruthy();
    const off = flat(buildTrayTemplate(/** @type {any} */ (st({ enabled: false, configured: false, connection: 'off', armed: false, arming: false, name: 'camera' })), /** @type {any} */ (actions)));
    expect(off.find((i) => i.label === 'Home camera is off')).toBeTruthy();
    expect(off.find((i) => i.label === 'Open clips folder').enabled).toBe(false);
  });

  it('tooltip: armed / online / offline; unchanged without the feature', () => {
    const t = (tapo) => trayTooltip(/** @type {any} */ (st(tapo)));
    expect(t({ enabled: true, configured: true, connection: 'online', armed: true, arming: false, name: 'c' })).toBe('Lawnmower Man — Claude: ready · Voice: ready · Home camera: armed');
    expect(t({ enabled: true, configured: true, connection: 'online', armed: false, arming: false, name: 'c' })).toBe('Lawnmower Man — Claude: ready · Voice: ready · Home camera: online');
    expect(t({ enabled: true, configured: true, connection: 'unreachable', armed: false, arming: false, name: 'c' })).toMatch(/Home camera: offline$/);
    expect(t({ enabled: false, configured: false, connection: 'off', armed: false, arming: false, name: 'c' })).toBe('Lawnmower Man — Claude: ready · Voice: ready');
    expect(t(undefined)).toBe('Lawnmower Man — Claude: ready · Voice: ready');
    expect(buildTrayTemplate(/** @type {any} */ (st(undefined)), /** @type {any} */ ({})).some((i) => i.label === 'Home camera')).toBe(false);
  });
});
