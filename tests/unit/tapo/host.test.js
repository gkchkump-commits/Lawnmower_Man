import { describe, it, expect } from 'vitest';
import { hostPort, isLanIp, resolveLanHost, validateHostSetting } from '../../../electron/tapo/host.js';

describe('host allow-list', () => {
  it('accepts home-network addresses and names in the settings', () => {
    for (const h of ['192.168.1.50', '10.0.0.5', '172.16.4.2', '172.31.255.1', '169.254.10.20', '100.64.1.1', 'fd00::5', '[fd12:3456::1]', 'tapo.local', 'cam.lan', 'cam.home.arpa', 'door.internal', 'tapo-c211', '127.0.0.1', 'localhost', '']) {
      expect(validateHostSetting(h).ok, h).toBe(true);
    }
    expect(validateHostSetting('  192.168.1.50 ')).toEqual({ ok: true, value: '192.168.1.50' });
    expect(validateHostSetting('[FD00::5]')).toEqual({ ok: true, value: 'fd00::5' });
    expect(validateHostSetting('Tapo.Local.')).toEqual({ ok: true, value: 'tapo.local' });
  });

  it('refuses the internet, links, ports and junk', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2001:4860::8888', 'example.com', 'camera.example.org', 'http://192.168.1.50', 'rtsp://u:p@192.168.1.50/stream1', '192.168.1.50:2020', '192.168.1.50/onvif', 'user@192.168.1.50', '192.168.1', '999.1.1.1', 'fe80::1%eth0', '-bad-', 'a b', 'x'.repeat(300), 'local', '.local']) {
      expect(validateHostSetting(h).ok, h).toBe(false);
    }
    expect(validateHostSetting(42).ok).toBe(false);
  });

  it('isLanIp handles IPv4-mapped IPv6 and loopback', () => {
    expect(isLanIp('::ffff:192.168.1.5')).toBe(true);
    expect(isLanIp('::ffff:8.8.8.8')).toBe(false);
    expect(isLanIp('127.0.0.1')).toBe(false);
    expect(isLanIp('127.0.0.1', { allowLoopback: true })).toBe(true);
    expect(isLanIp('::1', { allowLoopback: true })).toBe(true);
    expect(isLanIp('::1')).toBe(false);
    expect(isLanIp('fc00::1')).toBe(true);
    expect(isLanIp('fe80::1')).toBe(false);
  });

  it('resolves names and requires the resolved address to be on the LAN', async () => {
    const lookup = async (name) => ({
      'tapo.local': [{ address: '192.168.1.50', family: 4 }],
      'evil.lan': [{ address: '8.8.8.8', family: 4 }],
      'mixed.lan': [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }],
      localhost: [{ address: '127.0.0.1', family: 4 }],
    })[name] || Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    expect(await resolveLanHost('tapo.local', { lookup })).toEqual({ ip: '192.168.1.50', family: 4 });
    expect(await resolveLanHost('mixed.lan', { lookup })).toEqual({ ip: '10.1.2.3', family: 4 });
    await expect(resolveLanHost('evil.lan', { lookup })).rejects.toThrow(/not point to an address on your home network/);
    await expect(resolveLanHost('missing.lan', { lookup })).rejects.toThrow(/could not be found/);
    expect(await resolveLanHost('192.168.1.50')).toEqual({ ip: '192.168.1.50', family: 4 });
    await expect(resolveLanHost('8.8.8.8')).rejects.toThrow(/not an address on your home network/);
    await expect(resolveLanHost('example.com', { lookup })).rejects.toThrow(/not an address on your home network/);
    await expect(resolveLanHost('127.0.0.1')).rejects.toThrow(/not an address on your home network/);
    expect(await resolveLanHost('127.0.0.1', { allowLoopback: true })).toEqual({ ip: '127.0.0.1', family: 4 });
    await expect(resolveLanHost('localhost', { lookup })).rejects.toThrow(/home network/);
    expect(await resolveLanHost('localhost', { lookup, allowLoopback: true })).toEqual({ ip: '127.0.0.1', family: 4 });
    await expect(resolveLanHost('')).rejects.toThrow(/No camera address/);
  });

  it('hostPort brackets IPv6', () => {
    expect(hostPort('192.168.1.50', 2020)).toBe('192.168.1.50:2020');
    expect(hostPort('fd00::5', 2020)).toBe('[fd00::5]:2020');
  });
});
