import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialStore, passwordHint, redact, validatePassword } from '../../../electron/tapo/credentials.js';
import { tmpDir } from '../helpers/tmp.js';

/** safeStorage stand-in: "encryption" = XOR + a marker, so the file must never hold the plaintext. */
function fakeSafeStorage(o = {}) {
  const s = {
    available: o.available ?? true,
    backend: o.backend,
    reEncrypt: false,
    encrypts: 0,
    isAsyncEncryptionAvailable: async () => s.available,
    encryptStringAsync: async (str) => {
      s.encrypts++;
      return Buffer.concat([Buffer.from('ENC1'), Buffer.from(str, 'utf8').map((b) => b ^ 0x5a)]);
    },
    decryptStringAsync: async (buf) => {
      if (buf.subarray(0, 4).toString() !== 'ENC1') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return { result: Buffer.from(buf.subarray(4).map((b) => b ^ 0x5a)).toString('utf8'), shouldReEncrypt: s.reEncrypt };
    },
  };
  if (o.backend) s.getSelectedStorageBackend = () => o.backend;
  return s;
}

let dir;
beforeEach(() => {
  dir = tmpDir('lm-cred-');
});

describe('CredentialStore', () => {
  it('encrypts to credentials.json without the plaintext and reads it back after a restart', async () => {
    const ss = fakeSafeStorage();
    const a = new CredentialStore({ dir, safeStorage: ss, platform: 'win32' });
    await a.load();
    expect(a.hasPassword()).toBe(false);
    expect(await a.setPassword('se&cret-Pw!', { host: '192.168.1.50' })).toEqual({ persisted: true });
    expect(a.persistence).toBe('encrypted');
    const raw = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
    expect(raw).not.toContain('se&cret');
    expect(raw).not.toContain(encodeURIComponent('se&cret-Pw!'));
    const j = JSON.parse(raw);
    expect(j).toMatchObject({ v: 1, boundHost: '192.168.1.50' });
    expect(typeof j.savedAt).toBe('string');
    const b = new CredentialStore({ dir, safeStorage: ss, platform: 'win32' });
    await b.load();
    expect(b.hasPassword('192.168.1.50')).toBe(true);
    expect(await b.getPassword({ host: '192.168.1.50' })).toBe('se&cret-Pw!');
    expect(fs.readdirSync(dir)).toEqual(['credentials.json']); // no temp files left
  });

  it('does not hand the password to another camera address', async () => {
    const a = new CredentialStore({ dir, safeStorage: fakeSafeStorage(), platform: 'win32' });
    await a.setPassword('se&cret', { host: '192.168.1.50' });
    expect(a.hasPassword('192.168.1.99')).toBe(false);
    expect(await a.getPassword({ host: '192.168.1.99' })).toBeNull();
    expect(await a.getPassword({ host: '192.168.1.50' })).toBe('se&cret');
  });

  it('a password saved before any address binds to the first one used', async () => {
    const a = new CredentialStore({ dir, safeStorage: fakeSafeStorage(), platform: 'win32' });
    await a.setPassword('se&cret', {});
    expect(await a.getPassword({ host: '10.0.0.5' })).toBe('se&cret');
    expect(a.boundHost).toBe('10.0.0.5');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).boundHost).toBe('10.0.0.5');
    expect(await a.getPassword({ host: '10.0.0.6' })).toBeNull();
  });

  it('rewrites the file when safeStorage asks for re-encryption', async () => {
    const ss = fakeSafeStorage();
    const a = new CredentialStore({ dir, safeStorage: ss, platform: 'win32' });
    await a.setPassword('se&cret', { host: 'tapo.local' });
    const b = new CredentialStore({ dir, safeStorage: ss, platform: 'win32' });
    await b.load();
    ss.reEncrypt = true;
    const before = ss.encrypts;
    expect(await b.getPassword({ host: 'tapo.local' })).toBe('se&cret');
    expect(ss.encrypts).toBe(before + 1);
  });

  it('keeps the password in memory only without real encryption (none, or Linux basic_text)', async () => {
    for (const ss of [fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: 'basic_text' }), null]) {
      const d = tmpDir('lm-cred-');
      const a = new CredentialStore({ dir: d, safeStorage: /** @type {any} */ (ss), platform: 'linux' });
      expect(await a.setPassword('se&cret', { host: '192.168.1.50' })).toEqual({ persisted: false });
      expect(a.persistence).toBe('memory');
      expect(await a.getPassword({ host: '192.168.1.50' })).toBe('se&cret');
      expect(fs.existsSync(path.join(d, 'credentials.json'))).toBe(false);
    }
    const gnome = new CredentialStore({ dir, safeStorage: fakeSafeStorage({ backend: 'gnome_libsecret' }), platform: 'linux' });
    expect((await gnome.setPassword('se&cret')).persisted).toBe(true);
  });

  it('an undecryptable file counts as no password; clear() deletes it', async () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ v: 1, boundHost: '', savedAt: '', password: Buffer.from('garbage').toString('base64') }));
    const a = new CredentialStore({ dir, safeStorage: fakeSafeStorage(), platform: 'win32' });
    await a.load();
    expect(a.hasPassword()).toBe(true);
    expect(await a.getPassword()).toBeNull();
    expect(a.hasPassword()).toBe(false);
    await a.setPassword('another1');
    await a.clear();
    expect(a.hasPassword()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
  });

  it('validates passwords', () => {
    expect(validatePassword('abcd')).toBe('abcd');
    // shorter than Tapo allows (6), and too short to redact in logs safely
    expect(() => validatePassword('x')).toThrow(/too short/);
    expect(() => validatePassword('abc')).toThrow(/too short/);
    expect(() => validatePassword('')).toThrow(/Enter/);
    expect(() => validatePassword('abc\ndef')).toThrow(/line breaks/);
    expect(() => validatePassword('abc\0def')).toThrow();
    expect(() => validatePassword('x'.repeat(129))).toThrow(/too long/);
    expect(() => validatePassword(42)).toThrow();
    expect(passwordHint('short')).toMatch(/6 to 32/);
    expect(passwordHint('long enough')).toBe('');
  });
});

describe('redact', () => {
  it('removes secrets in plain, percent-encoded and XML form, and URL userinfo', () => {
    const pw = 'se&cret/x?';
    const line = `rtsp://camacct:${encodeURIComponent(pw)}@192.168.1.50:554/stream1 failed; pass=${pw}; xml <p>se&amp;cret/x?</p>`;
    const out = redact(line, [pw]);
    expect(out).not.toContain('se&cret');
    expect(out).not.toContain(encodeURIComponent(pw));
    expect(out).toContain('rtsp://***:***@192.168.1.50:554/stream1');
    expect(out).toContain('pass=***');
    expect(redact('http://u:p@host/x and https://host/no-userinfo', [])).toBe('http://***:***@host/x and https://host/no-userinfo');
    expect(redact('nothing secret', ['', null, 'ab'])).toBe('nothing secret');
  });
});
