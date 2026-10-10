#!/usr/bin/env node
// Fetch the pinned go2rtc release (the home camera's video component, docs/TAPO.md) into
// vendor/go2rtc/<platform>/ for development and for the installer (package.json
// build.*.extraResources copies it to resources/tapo/).
//
//   npm run fetch:go2rtc                          this machine's platform
//   npm run fetch:go2rtc -- --platform win32-x64  (linux-x64 | win32-x64 | all)
//   npm run fetch:go2rtc -- --from <dir>          offline: use copies of the release files in <dir>
//                                                 (go2rtc_win64.zip / go2rtc_linux_amd64 / LICENSE)
//   --force                                       download again even when the binary is in place
//   --out <dir>                                   install under <dir>/go2rtc/ instead of vendor/go2rtc/
//
// Every file is checked against the SHA-256 pinned below (taken from the official GitHub release
// v1.9.14); a mismatch exits non-zero and writes nothing. The Windows zip is unpacked with a small
// zip reader (central directory + zlib.inflateRawSync + CRC-32), so no unzip tool is needed.
// Behind an HTTP proxy, Node's fetch uses it only with NODE_USE_ENV_PROXY=1 (Node ≥ 22.21); or
// download the files by hand and pass --from.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GO2RTC_VERSION = '1.9.14';
const BASE = `https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/`;

/**
 * The pinned release files. `sha256`/`size` are the downloaded asset; for the zip also the
 * binary inside it (`binSha256`/`binSize`), which makes a re-run idempotent without the zip.
 */
export const ASSETS = Object.freeze({
  'win32-x64': {
    asset: 'go2rtc_win64.zip',
    sha256: 'dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907',
    size: 7378736,
    entry: 'go2rtc.exe',
    bin: 'go2rtc.exe',
    binSha256: '923d57252e8139a69c52e4acc1e399a640244a8ef457fd9b7267a25847d68f8c',
    binSize: 19737088,
  },
  'linux-x64': {
    asset: 'go2rtc_linux_amd64',
    sha256: '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6',
    size: 5726972,
    entry: null,
    bin: 'go2rtc',
    binSha256: '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6',
    binSize: 5726972,
  },
});

export const LICENSE_FILE = Object.freeze({
  url: `https://raw.githubusercontent.com/AlexxIT/go2rtc/v${GO2RTC_VERSION}/LICENSE`,
  asset: 'LICENSE',
  sha256: 'b0dcf4855af5a72b4dfbd9117c207b330f4cc35658576a0b5351d6e2becac546',
});

/** @param {Buffer} buf */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Read one file out of a zip archive (stored or deflated; no zip64, no encryption — the go2rtc
 * release zip is a plain deflated single-file archive). Checks the CRC-32 and the size.
 * @param {Buffer} zip @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(zip, name) {
  // End of central directory: signature 0x06054b50, at most 64 KB of comment after it.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (entryName !== name) continue;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('zip64 archives are not supported');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error(`${name} is truncated`);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${name} uses unsupported compression method ${method}`);
    if (data.length !== usize) throw new Error(`${name}: size ${data.length} ≠ ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 mismatch`);
    return data;
  }
  throw new Error(`${name} not found in the zip`);
}

/** @param {string} platform @param {string} arch */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * @param {string[]} argv
 * @returns {{ platforms: string[], from: string|null, force: boolean, out: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const o = { platforms: /** @type {string[]} */ ([]), from: /** @type {string|null} */ (null), force: false, out: /** @type {string|null} */ (null), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--platform') {
      const v = value();
      o.platforms.push(...(v === 'all' ? Object.keys(ASSETS) : [v]));
    } else if (a.startsWith('--platform=')) {
      const v = a.slice('--platform='.length);
      o.platforms.push(...(v === 'all' ? Object.keys(ASSETS) : [v]));
    } else if (a === '--from') o.from = value();
    else if (a === '--out') o.out = value();
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const p of o.platforms) if (!(p in ASSETS)) throw new Error(`unsupported platform ${p} (use ${Object.keys(ASSETS).join(', ')} or all)`);
  if (!o.platforms.length) o.platforms.push(platformKey());
  o.platforms = [...new Set(o.platforms)];
  return o;
}

/** @param {string} url @param {(msg: string) => void} say */
async function download(url, say) {
  say(`  downloading ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    const cause = /** @type {any} */ (err).cause;
    throw new Error(`download failed (${cause?.code || /** @type {Error} */ (err).message}). Behind a proxy, run with NODE_USE_ENV_PROXY=1, or download the file yourself and use --from <dir>.`);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Get one pinned file (download or --from) and verify it.
 * @param {{ name: string, url: string, sha256: string, size?: number }} f
 * @param {{ from: string|null, say: (m: string) => void, fetchFile?: (url: string) => Promise<Buffer> }} o
 */
async function obtain(f, o) {
  const data = o.from ? fs.readFileSync(path.join(o.from, f.name)) : await (o.fetchFile ? o.fetchFile(f.url) : download(f.url, o.say));
  const got = sha256(data);
  if (got !== f.sha256) throw new Error(`SHA-256 mismatch for ${f.name}: expected ${f.sha256}, got ${got}. Not installing it.`);
  if (f.size !== undefined && data.length !== f.size) throw new Error(`size mismatch for ${f.name}: expected ${f.size}, got ${data.length}`);
  return data;
}

/** @param {string} file @param {Buffer} data @param {number} [mode] */
function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** @param {string} file @param {string} expected */
function hasFile(file, expected) {
  try {
    return sha256(fs.readFileSync(file)) === expected;
  } catch {
    return false;
  }
}

/**
 * Fetch, verify and install the binaries for `platforms` (+ the LICENSE) under `<out>/go2rtc/`.
 * @param {{ platforms: string[], out: string, from?: string|null, force?: boolean, say?: (m: string) => void, fetchFile?: (url: string) => Promise<Buffer> }} o
 * @returns {Promise<Array<{ platform: string, file: string, sha256: string, skipped: boolean }>>}
 */
export async function fetchGo2rtc(o) {
  const say = o.say || (() => {});
  const from = o.from || null;
  const results = [];
  for (const platform of o.platforms) {
    const a = /** @type {any} */ (ASSETS)[platform];
    if (!a) throw new Error(`unsupported platform ${platform}`);
    const file = path.join(o.out, 'go2rtc', platform, a.bin);
    if (!o.force && hasFile(file, a.binSha256)) {
      say(`go2rtc ${GO2RTC_VERSION} for ${platform} is already in place (${file})`);
      results.push({ platform, file, sha256: a.binSha256, skipped: true });
      continue;
    }
    say(`go2rtc ${GO2RTC_VERSION} for ${platform}:`);
    const data = await obtain({ name: a.asset, url: BASE + a.asset, sha256: a.sha256, size: a.size }, { from, say, fetchFile: o.fetchFile });
    const bin = a.entry ? readZipEntry(data, a.entry) : data;
    const binHash = sha256(bin);
    if (binHash !== a.binSha256 || bin.length !== a.binSize) throw new Error(`unexpected ${a.bin} inside ${a.asset} (SHA-256 ${binHash})`);
    writeAtomic(file, bin, 0o755);
    say(`  verified SHA-256 ${a.sha256} → ${file}`);
    results.push({ platform, file, sha256: binHash, skipped: false });
  }
  const license = path.join(o.out, 'go2rtc', 'LICENSE');
  if (o.force || !hasFile(license, LICENSE_FILE.sha256)) {
    const data = await obtain({ name: LICENSE_FILE.asset, url: LICENSE_FILE.url, sha256: LICENSE_FILE.sha256 }, { from, say, fetchFile: o.fetchFile });
    writeAtomic(license, data);
    say(`  LICENSE → ${license}`);
  }
  return results;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`fetch-go2rtc: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node scripts/fetch-go2rtc.mjs [--platform linux-x64|win32-x64|all] [--from <dir>] [--force]');
    return;
  }
  try {
    await fetchGo2rtc({ platforms: opts.platforms, out: opts.out ? path.resolve(opts.out) : path.join(root, 'vendor'), from: opts.from ? path.resolve(opts.from) : null, force: opts.force, say: (m) => console.log(m) });
  } catch (err) {
    console.error(`fetch-go2rtc: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
