import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ASSETS, LICENSE_FILE, crc32, fetchGo2rtc, parseArgs, readZipEntry, sha256 } from '../../../scripts/fetch-go2rtc.mjs';

/** A minimal zip writer (local header + central directory + EOCD) for the reader under test. */
function makeZip(files, { method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('fetch-go2rtc', () => {
  it('pins the official v1.9.14 assets', () => {
    expect(ASSETS['win32-x64'].sha256).toBe('dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907');
    expect(ASSETS['linux-x64'].sha256).toBe('32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6');
    expect(ASSETS['win32-x64'].binSize).toBe(19737088);
    expect(LICENSE_FILE.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/AlexxIT\/go2rtc\/v1\.9\.14\/LICENSE$/);
  });

  it('reads deflated and stored zip entries and checks their CRC', () => {
    const exe = Buffer.from('MZ'.padEnd(5000, 'x'));
    const zip = makeZip({ 'README.txt': Buffer.from('hi'), 'go2rtc.exe': exe });
    expect(readZipEntry(zip, 'go2rtc.exe').equals(exe)).toBe(true);
    expect(readZipEntry(makeZip({ 'go2rtc.exe': exe }, { method: 0 }), 'go2rtc.exe').equals(exe)).toBe(true);
    expect(() => readZipEntry(zip, 'missing.exe')).toThrow(/not found/);
    expect(() => readZipEntry(Buffer.from('not a zip at all, not at all'), 'x')).toThrow(/not a zip/);
    const bad = Buffer.from(makeZip({ 'go2rtc.exe': exe }, { method: 0 }));
    bad[40] ^= 0xff; // flip a byte of the stored data
    expect(() => readZipEntry(bad, 'go2rtc.exe')).toThrow(/CRC-32/);
  });

  it('crc32 matches the zlib reference value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('parses its arguments', () => {
    expect(parseArgs(['--platform', 'all']).platforms).toEqual(['win32-x64', 'linux-x64']);
    expect(parseArgs(['--platform=linux-x64', '--force']).force).toBe(true);
    expect(() => parseArgs(['--platform', 'darwin-arm64'])).toThrow(/unsupported/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown/);
  });

  it('refuses a file whose SHA-256 does not match and writes nothing', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-g2r-'));
    await expect(fetchGo2rtc({ platforms: ['linux-x64'], out, fetchFile: async () => Buffer.from('evil binary') })).rejects.toThrow(/SHA-256 mismatch/);
    expect(fs.existsSync(path.join(out, 'go2rtc', 'linux-x64', 'go2rtc'))).toBe(false);
  });

  it('skips a binary that is already in place (idempotent)', async () => {
    const vendor = path.resolve('vendor/go2rtc/linux-x64/go2rtc');
    if (!fs.existsSync(vendor) || sha256(fs.readFileSync(vendor)) !== ASSETS['linux-x64'].binSha256) return; // not fetched here
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-g2r-'));
    fs.mkdirSync(path.join(out, 'go2rtc', 'linux-x64'), { recursive: true });
    fs.copyFileSync(vendor, path.join(out, 'go2rtc', 'linux-x64', 'go2rtc'));
    fs.copyFileSync(path.resolve('vendor/go2rtc/LICENSE'), path.join(out, 'go2rtc', 'LICENSE'));
    let fetched = 0;
    const r = await fetchGo2rtc({ platforms: ['linux-x64'], out, fetchFile: async () => { fetched++; return Buffer.alloc(0); } });
    expect(r[0].skipped).toBe(true);
    expect(fetched).toBe(0);
  });
});
