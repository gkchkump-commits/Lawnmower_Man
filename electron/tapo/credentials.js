// The camera password (contract §5). Pure Node; Electron's safeStorage is injected.
//
//  * Encrypted with safeStorage.encryptStringAsync (DPAPI on Windows: readable only by this
//    Windows user) in <userData>/tapo/credentials.json, written atomically; never in settings.json.
//  * Without usable encryption (Linux "basic_text" backend, or none) it stays in memory for this
//    run only ("persistence: memory": the app asks again next start).
//  * Bound to the camera address it was saved for: if tapo.host later points elsewhere, the
//    password is not used (a changed address must not receive the camera's digest) until the user
//    enters it again. A password saved before any address was set binds to the first one used.
//  * It never leaves the main process except as an ONVIF digest and, percent-encoded, in go2rtc's
//    environment. redact() scrubs it from anything that is logged.

import nodeFs from 'node:fs/promises';
import path from 'node:path';

export const CREDENTIALS_FILE = 'credentials.json';

/** Shorter passwords are refused: Tapo's own minimum is 6, and logs redact secrets of ≥ 3 characters. */
export const MIN_PASSWORD_LENGTH = 4;

/**
 * 4..128 characters, no NUL/CR/LF (Tapo itself wants 6–32; above 4 that is only a hint).
 * @param {unknown} pw @returns {string}
 */
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0) throw new Error('Enter the Camera Account password.');
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error('That password is too short: Camera Account passwords have at least 6 characters.');
  if (pw.length > 128) throw new Error('That password is too long (at most 128 characters).');
  if (/[\0\r\n]/.test(pw)) throw new Error('The password cannot contain line breaks.');
  return pw;
}

/** A hint (not an error) for passwords outside Tapo's own rule. @param {string} pw */
export function passwordHint(pw) {
  return pw.length < 6 || pw.length > 32 ? 'Tapo Camera Account passwords are 6 to 32 characters. Check that this is the Camera Account, not your TP-Link login.' : '';
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace every secret (also percent-encoded and XML-escaped) and any `scheme://user:pass@`
 * userinfo with ***.
 * @param {unknown} text @param {Array<string|null|undefined>} [secrets]
 */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1***:***@');
  const forms = new Set();
  for (const sec of secrets) {
    if (typeof sec !== 'string' || sec.length < 3) continue;
    forms.add(sec);
    forms.add(encodeURIComponent(sec));
    forms.add(sec.replace(/[&<>"']/g, (c) => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]));
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(escapeRe(f), 'g'), '***');
  return s;
}

/**
 * @typedef {object} SafeStorageLike
 * @property {() => Promise<boolean>} isAsyncEncryptionAvailable
 * @property {(s: string) => Promise<Buffer>} encryptStringAsync
 * @property {(b: Buffer) => Promise<{ result: string, shouldReEncrypt: boolean }>} decryptStringAsync
 * @property {() => string} [getSelectedStorageBackend]   Linux only
 */

export class CredentialStore {
  /**
   * @param {{ dir: string, safeStorage: SafeStorageLike|null, fs?: typeof nodeFs, log?: (level: string, msg: string) => void, platform?: string, now?: () => number }} o
   */
  constructor(o) {
    this.dir = o.dir;
    this.file = path.join(o.dir, CREDENTIALS_FILE);
    this._ss = o.safeStorage;
    this._fs = o.fs || nodeFs;
    this._log = o.log || (() => {});
    this._platform = o.platform || process.platform;
    this._now = o.now || (() => Date.now());
    /** @type {string|null} decrypted, in memory */
    this._password = null;
    /** @type {Buffer|null} the encrypted blob on disk */
    this._blob = null;
    this._boundHost = '';
    /** @type {'encrypted'|'memory'|'none'} */
    this._persistence = 'none';
    /** @type {Promise<boolean>|null} */
    this._available = null;
  }

  /** Can we encrypt (and is it real encryption)? */
  encryptionAvailable() {
    if (!this._available) {
      this._available = (async () => {
        const ss = this._ss;
        if (!ss || typeof ss.isAsyncEncryptionAvailable !== 'function') return false;
        try {
          if (!(await ss.isAsyncEncryptionAvailable())) return false;
          if (this._platform === 'linux' && typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text') return false;
          return true;
        } catch {
          return false;
        }
      })();
    }
    return this._available;
  }

  /** Read credentials.json if there is one (the password itself is decrypted when first needed). */
  async load() {
    let raw;
    try {
      raw = await this._fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') this._log('warn', `[tapo] could not read ${this.file}: ${/** @type {Error} */ (err).message}`);
      return;
    }
    try {
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || typeof j.password !== 'string' || !j.password) throw new Error('unexpected contents');
      this._blob = Buffer.from(j.password, 'base64');
      this._boundHost = typeof j.boundHost === 'string' ? j.boundHost : '';
      this._persistence = 'encrypted';
    } catch (err) {
      this._log('warn', `[tapo] ignoring a broken ${CREDENTIALS_FILE} (${/** @type {Error} */ (err).message})`);
    }
  }

  /** @returns {'encrypted'|'memory'|'none'} */
  get persistence() {
    return this._persistence;
  }

  get boundHost() {
    return this._boundHost;
  }

  /** A password is stored (for `host`, when given). @param {string} [host] */
  hasPassword(host) {
    if (this._password === null && !this._blob) return false;
    return host === undefined || !this._boundHost || this._boundHost === host;
  }

  /**
   * The password, for the main process only. null when none is stored, or it was saved for
   * another camera address. A password saved before an address was set binds to `host` now.
   * @param {{ host?: string }} [o]
   * @returns {Promise<string|null>}
   */
  async getPassword(o = {}) {
    if (o.host !== undefined && this._boundHost && this._boundHost !== o.host) return null;
    if (this._password === null && this._blob) {
      if (!this._ss) return null;
      try {
        const { result, shouldReEncrypt } = await this._ss.decryptStringAsync(this._blob);
        this._password = result;
        if (shouldReEncrypt) {
          this._log('info', '[tapo] re-encrypting the stored camera password');
          await this._persist(result, this._boundHost).catch((err) => this._log('warn', `[tapo] re-encrypt failed: ${err.message}`));
        }
      } catch (err) {
        // another Windows user's file, or a damaged one: as if none were stored
        this._log('warn', `[tapo] the stored camera password could not be decrypted (${/** @type {Error} */ (err).message}); enter it again`);
        this._blob = null;
        this._persistence = 'none';
        return null;
      }
    }
    if (this._password !== null && o.host && !this._boundHost) {
      this._boundHost = o.host;
      if (this._persistence === 'encrypted') await this._persist(this._password, o.host).catch(() => {});
    }
    return this._password;
  }

  /**
   * @param {string} password @param {{ host?: string }} [o]
   * @returns {Promise<{ persisted: boolean }>}
   */
  async setPassword(password, o = {}) {
    const pw = validatePassword(password);
    this._password = pw;
    this._boundHost = o.host || '';
    if (await this.encryptionAvailable()) {
      try {
        await this._persist(pw, this._boundHost);
        this._persistence = 'encrypted';
        return { persisted: true };
      } catch (err) {
        this._log('warn', `[tapo] could not save the camera password (${/** @type {Error} */ (err).message}); keeping it for this session only`);
      }
    } else {
      this._log('info', '[tapo] no system encryption available: the camera password is kept for this session only');
    }
    this._blob = null;
    this._persistence = 'memory';
    await this._remove();
    return { persisted: false };
  }

  async clear() {
    this._password = null;
    this._blob = null;
    this._boundHost = '';
    this._persistence = 'none';
    await this._remove();
  }

  /** @param {string} pw @param {string} host */
  async _persist(pw, host) {
    const ss = /** @type {SafeStorageLike} */ (this._ss);
    const blob = await ss.encryptStringAsync(pw);
    const data = `${JSON.stringify({ v: 1, boundHost: host, savedAt: new Date(this._now()).toISOString(), password: Buffer.from(blob).toString('base64') }, null, 2)}\n`;
    await this._fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await this._fs.writeFile(tmp, data, { mode: 0o600 });
    try {
      await this._fs.rename(tmp, this.file);
    } catch (err) {
      await this._fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    this._blob = Buffer.from(blob);
  }

  async _remove() {
    try {
      await this._fs.rm(this.file, { force: true });
    } catch (err) {
      this._log('warn', `[tapo] could not delete ${this.file}: ${/** @type {Error} */ (err).message}`);
    }
  }
}
