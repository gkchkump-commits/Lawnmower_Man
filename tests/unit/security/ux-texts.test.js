// Regression tests for the UX review (fixer round), the pure parts: an armed camera that is not
// watching never reads plain "Armed" (tray, arm button, avatar pill), the connection outranks a
// privacy-mode guess, the video's own error text is shown, and the setup form's address check
// keeps what main keeps.
import { describe, expect, it } from 'vitest';
import { armState, connectionBadge, viewPlaceholder } from '../../../src/tapo/status.js';
import { checkHost, checkPassword } from '../../../src/tapo/validate.js';
import { tapoLabel, trayTooltip } from '../../../electron/tray-menu.js';
import { validateHostSetting } from '../../../electron/tapo/host.js';
import { DEFAULT_SETTINGS, cloneSettings } from '../../../electron/settings.js';

const online = (o = {}) => ({
  enabled: true, configured: true, hasPassword: true, name: 'front door camera', connection: 'online', detail: 'Connected to Tapo C211.',
  stream: { state: 'live' }, ptz: { available: true, privacySuspected: false }, go2rtc: { state: 'ready' },
  security: { armed: false, arming: false, watching: 'yes', todayCount: 0, storage: { bytes: 0, clips: 0 } },
  ...o,
});

describe('an armed camera that is not watching says so', () => {
  it('tray: "Armed · camera offline" for an unreachable / refused / broken connection, "Armed · not watching" without video', () => {
    for (const connection of ['unreachable', 'auth-failed', 'error']) {
      expect(tapoLabel({ enabled: true, configured: true, connection, armed: true, arming: false })).toBe('Armed · camera offline');
    }
    expect(tapoLabel({ enabled: true, configured: true, connection: 'online', armed: true, arming: false, watching: 'no-video' })).toBe('Armed · not watching');
    expect(tapoLabel({ enabled: true, configured: true, connection: 'online', armed: true, arming: false, watching: 'yes' })).toBe('Armed');
    const tip = trayTooltip(/** @type {any} */ ({ visible: true, settings: cloneSettings(DEFAULT_SETTINGS), claudeStatus: 'ready', voiceStatus: 'ready', tapo: { enabled: true, configured: true, connection: 'unreachable', armed: true, arming: false } }));
    expect(tip).toMatch(/Home camera: armed · camera offline$/);
  });

  it('the arm button and the avatar pill', () => {
    expect(armState(online({ security: { armed: true, arming: false, watching: 'offline' } }), 0)).toMatchObject({ mode: 'armed', label: 'Armed · camera offline', blind: true });
    expect(armState(online({ security: { armed: true, arming: false, watching: 'no-video' } }), 0)).toMatchObject({ label: 'Armed · not watching', blind: true });
    expect(armState(online({ security: { armed: true, arming: false, watching: 'yes' } }), 0)).toEqual({ mode: 'armed', label: 'Armed', action: 'Disarm', secondsLeft: 0 });
  });
});

describe('the camera window\'s words', () => {
  it('an offline or refused camera outranks a privacy-mode guess', () => {
    expect(connectionBadge(online({ connection: 'unreachable', ptz: { privacySuspected: true } })).text).toBe('Offline');
    expect(connectionBadge(online({ connection: 'auth-failed', ptz: { privacySuspected: true } })).text).toBe('Sign-in failed');
    expect(viewPlaceholder(online({ connection: 'unreachable', ptz: { privacySuspected: true } }), { hasFrame: true })?.kind).toBe('offline');
    expect(viewPlaceholder(online({ stream: { state: 'stalled' }, ptz: { privacySuspected: true } }), { hasFrame: true })?.kind).toBe('stalled');
    expect(connectionBadge(online({ ptz: { privacySuspected: true } })).text).toBe('Privacy mode?');
  });

  it('a video error shows the video\'s own reason, never "Connected to Tapo C211."', () => {
    const ph = viewPlaceholder(online({ stream: { state: 'error', detail: 'The video component is not answering (ECONNREFUSED).' } }), { hasFrame: false });
    expect(ph).toMatchObject({ kind: 'video-error', detail: 'The video component is not answering (ECONNREFUSED).' });
    expect(viewPlaceholder(online({ stream: { state: 'error' } }), { hasFrame: false })?.detail).not.toMatch(/Connected/);
  });
});

describe('the setup form keeps what main keeps', () => {
  it.each(['LocalHost', 'Tapo-C211.local', 'C211', 'FD00::5', 'tapo.lan.', '192.168.1.50'])('%s', (typed) => {
    const r = checkHost(typed);
    const m = validateHostSetting(typed);
    expect(r.ok).toBe(true);
    expect(m.ok).toBe(true);
    expect(/** @type {any} */ (r).value).toBe(/** @type {any} */ (m).value);
  });

  it('what main refuses is refused in the form too, with words', () => {
    for (const typed of ['192.168.001.050', 'local', 'example.com', '8.8.8.8']) {
      expect(validateHostSetting(typed).ok, typed).toBe(false);
      expect(checkHost(typed).ok, typed).toBe(false);
    }
    expect(/** @type {any} */ (checkHost('192.168.1.50:554')).error).toMatch(/Ports and stream/);
    expect(checkPassword('abc').ok).toBe(false); // main refuses fewer than 4 characters
  });
});
