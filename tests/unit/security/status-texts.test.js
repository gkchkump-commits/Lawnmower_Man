// The Home camera's words (src/tapo/status.js) and the setup form's checks (src/tapo/validate.js).
import { describe, expect, it } from 'vitest';
import {
  armState, connectionBadge, dayLabel, drawerStatusLine, footerText, formatBitrate, formatBytes, formatDuration, ptzMessage, viewPlaceholder,
} from '../../../src/tapo/status.js';
import { checkHost, checkPassword, checkPort, checkQuietHours, checkUsername } from '../../../src/tapo/validate.js';

const online = (o = {}) => ({
  enabled: true, configured: true, hasPassword: true, name: 'front door camera', connection: 'online', detail: '',
  stream: { state: 'live', width: 2304, height: 1296, fps: 15, kbps: 1800 },
  ptz: { available: true, privacySuspected: false },
  go2rtc: { state: 'ready' },
  security: { armed: false, arming: false, todayCount: 0, storage: { bytes: 0, clips: 0 } },
  ...o,
});

describe('connectionBadge', () => {
  it.each([
    [online(), 'Online', 'ok'],
    [online({ connection: 'connecting' }), 'Connecting…', 'busy'],
    [online({ connection: 'auth-failed' }), 'Sign-in failed', 'error'],
    [online({ connection: 'unreachable' }), 'Offline', 'error'],
    [online({ ptz: { privacySuspected: true } }), 'Privacy mode?', 'warn'],
    [online({ configured: false, connection: 'not-configured' }), 'Not set up', 'off'],
    [online({ enabled: false }), 'Off', 'off'],
  ])('%#', (st, text, tone) => {
    expect(connectionBadge(st)).toMatchObject({ text, tone });
  });
});

describe('armState', () => {
  it('disarmed → arming with a countdown → armed', () => {
    expect(armState(online(), 0)).toMatchObject({ mode: 'disarmed', label: 'Disarmed', action: 'Arm' });
    expect(armState(online({ security: { arming: true, armingEndsAt: 30_000 } }), 2_100)).toMatchObject({ mode: 'arming', label: 'Arming… 28 s', secondsLeft: 28, action: 'Cancel' });
    expect(armState(online({ security: { armed: true } }), 0)).toMatchObject({ mode: 'armed', label: 'Armed', action: 'Disarm' });
  });
});

describe('viewPlaceholder', () => {
  const frames = { hasFrame: true, configSupported: true };
  it('nothing over a live picture', () => {
    expect(viewPlaceholder(online(), frames)).toBeNull();
  });
  it.each([
    [online({ configured: false, connection: 'not-configured' }), frames, 'setup'],
    [online({ connection: 'auth-failed' }), frames, 'auth'],
    [online({ connection: 'unreachable' }), frames, 'offline'],
    [online({ ptz: { privacySuspected: true } }), frames, 'privacy'],
    [online(), { hasFrame: false, configSupported: false }, 'codec'],
    [online({ stream: { state: 'stalled' } }), frames, 'stalled'],
    [online({ go2rtc: { state: 'missing', detail: 'The video component is missing.' } }), frames, 'missing'],
    [online(), { hasFrame: false }, 'starting'],
  ])('%#', (st, w, kind) => {
    expect(viewPlaceholder(st, w)?.kind).toBe(kind);
  });
  it('the codec placeholder says what to do', () => {
    expect(viewPlaceholder(online(), { configSupported: false })?.detail).toMatch(/stream2.*video quality/);
  });
  it('a failed sign-in explains why the app does not retry', () => {
    expect(viewPlaceholder(online({ connection: 'auth-failed' }), frames)?.detail).toMatch(/does not keep retrying/);
  });
});

describe('footer and formats', () => {
  it('footer: size · fps · bitrate · decode · detector', () => {
    const w = { fps: 14.6, decoding: 'hardware', hasFrame: true, detector: { state: 'on', rateHz: 1, lastMs: 24.4 } };
    expect(footerText(online(), w)).toBe('2304×1296 · 15 fps · 1.8 Mbit/s · hardware decode · person detector 1 Hz / 24 ms');
    expect(footerText(online(), { hasFrame: true, detector: { state: 'loading' } })).toMatch(/person detector loading/);
    expect(footerText(online(), { hasFrame: true, detector: { state: 'on', rateHz: 0 } })).toMatch(/person detector ready$/);
    expect(footerText(online(), { hasFrame: true, detector: { state: 'stub', rateHz: 1 } })).toMatch(/test detector 1 Hz$/);
    expect(footerText(online(), { hasFrame: true, detector: { state: 'stub', rateHz: 1, lastMs: 0.3 } })).toMatch(/test detector 1 Hz$/);
  });
  it('formats', () => {
    expect(formatBitrate(640)).toBe('640 kbit/s');
    expect(formatBitrate(1840)).toBe('1.8 Mbit/s');
    expect(formatBytes(84e6)).toBe('84 MB');
    expect(formatBytes(1.24e9)).toBe('1.2 GB');
    expect(formatDuration(23.4)).toBe('23 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(120)).toBe('2 min');
  });
  it('day labels', () => {
    const now = new Date(2026, 9, 10, 14, 0).getTime();
    expect(dayLabel(new Date(2026, 9, 10, 9, 0).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 9, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 3, 12, 0).getTime(), now)).toBe('Sat 3 Oct');
  });
  it('the drawer line', () => {
    expect(drawerStatusLine(null)).toMatch(/^Off/);
    expect(drawerStatusLine(online({ security: { armed: true, todayCount: 2 } }))).toBe('Front door camera: online · armed · 2 events today');
    expect(drawerStatusLine(online({ configured: false, connection: 'not-configured' }))).toMatch(/Not set up yet/);
  });
  it('PTZ errors in words', () => {
    expect(ptzMessage({ ok: true })).toBe('');
    expect(ptzMessage({ ok: false, code: 'privacy' })).toMatch(/privacy mode/);
    expect(ptzMessage({ ok: false, code: 'no-preset', error: 'There is no "Garden".' })).toBe('There is no "Garden".');
  });
});

describe('validate', () => {
  it('host: LAN addresses and names only, never a link', () => {
    for (const ok of ['192.168.1.50', '10.0.0.5', '172.20.1.1', '169.254.3.4', '100.64.1.2', 'tapo-c211.local', 'camera', 'cam.lan', 'cam.home.arpa', 'fd00::5', '127.0.0.1']) {
      expect(checkHost(ok).ok, ok).toBe(true);
    }
    for (const [bad, why] of [['', /Enter/], ['http://192.168.1.50', /not a web link/], ['192.168.1.50/onvif', /not a web link/], ['8.8.8.8', /internet/], ['example.com', /Internet names/], ['192.168.1.300', /valid IP/], ['192.168.1.50:2020', /port/], ['my camera', /spaces/], ['2001:db8::1', /home-network/]]) {
      const r = checkHost(bad);
      expect(r.ok, bad).toBe(false);
      expect(/** @type {any} */ (r).error, bad).toMatch(why);
    }
  });
  it('user name, password, port, quiet hours', () => {
    expect(checkUsername('camacct')).toEqual({ ok: true, value: 'camacct' });
    expect(checkUsername('my user').ok).toBe(false);
    expect(checkUsername('').ok).toBe(false);
    expect(checkPassword('se&cret12')).toEqual({ ok: true, value: 'se&cret12' });
    expect(checkPassword('abc')).toMatchObject({ ok: true, warning: expect.stringMatching(/6 to 32/) });
    expect(checkPassword('a\nb').ok).toBe(false);
    expect(checkPassword('').ok).toBe(false);
    expect(checkPort('2020')).toEqual({ ok: true, value: 2020 });
    expect(checkPort('70000').ok).toBe(false);
    expect(checkPort('20.5').ok).toBe(false);
    expect(checkQuietHours('23:00 - 07:00')).toEqual({ ok: true, value: '23:00-07:00' });
    expect(checkQuietHours('')).toEqual({ ok: true, value: '' });
    expect(checkQuietHours('11pm').ok).toBe(false);
  });
});
