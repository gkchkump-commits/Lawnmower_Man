#!/usr/bin/env node
// Fetch the pinned "Hey Jade" wake-word engine (docs/WAKE.md, contract-wake §5) into vendor/wake/
// for development and for the installer (package.json build.*.extraResources copies it to
// resources/wake/):
//
//   npm run fetch:wake                          this machine's platform
//   npm run fetch:wake -- --platform win32-x64  (linux-x64 | win32-x64 | all)
//   --with-zhen     also fetch model A (zh-en) into vendor/wake/dev-models/ (dev, unit tests, e2e;
//                   it has no stated licence and is never packaged: on the user's PC the voice
//                   downloader fetches it, voice/lawnmower_voice/download.py --kws)
//   --from <dir>    offline: the .tgz / .tar.bz2 / .onnx / *-LICENSE.txt files already in <dir>
//   --force         download again;   --out <dir>   write under <dir>/wake/ instead of vendor/wake/
//
// Layout (vendor/wake/):
//   sherpa-onnx/<platform>/…                  the raw N-API addon + its onnxruntime (npm tarballs)
//   models/gigaspeech-3.3m/{encoder.int8.onnx, decoder.onnx, joiner.int8.onnx, tokens.txt, MODEL_CARD.md}
//   models/silero_vad.onnx                    Silero VAD v4 (k2-fsa export)
//   dev-models/zh-en-3m/{encoder.int8.onnx, decoder.onnx, joiner.int8.onnx, tokens.txt}   (--with-zhen)
//   LICENSES/{sherpa-onnx-LICENSE.txt, onnxruntime-LICENSE.txt, silero-vad-LICENSE.txt}
//   manifest.json                             every installed file with its SHA-256 and size
//
// Every download and every extracted member is checked against the SHA-256 pinned here and in
// electron/wake/config.js; a mismatch exits non-zero and installs nothing of that asset. Re-runs
// skip assets whose installed files all verify. .tgz files are read in-process (zlib + a small
// ustar reader); .tar.bz2 files are unpacked with the system `tar` (GNU tar on Linux, bsdtar =
// %SystemRoot%\System32\tar.exe on Windows 10 1803+). Behind an HTTP proxy, Node's fetch uses it
// only with NODE_USE_ENV_PROXY=1 (Node ≥ 22.21); or download the files by hand and pass --from.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ADDON_FILES, LAYOUT, MODEL_FILES, SHERPA_VERSION, ONNXRUNTIME_VERSION } from '../electron/wake/config.js';

const NPM = 'https://registry.npmjs.org/';
const KWS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/';
const ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';
const RAW = 'https://raw.githubusercontent.com/';
const GIGA = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const ZHEN = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';

/** The giga tarball's README.md (its model card, "license: Apache License 2.0"), installed as MODEL_CARD.md. */
export const GIGA_MODEL_CARD = Object.freeze({ name: 'MODEL_CARD.md', size: 726, sha256: '74e42d37d63acd2366b042151d576fcc0c4917a41de339414a37f1e79f4e80e2' });

/** @param {string} pkg */
const npmTgz = (pkg) => `${NPM}${pkg}/-/${pkg}-${SHERPA_VERSION}.tgz`;
/** @param {readonly any[]} files @param {(f: any) => string} member */
const mapMembers = (files, member) => files.map((f) => ({ member: member(f), name: f.name, size: f.size, sha256: f.sha256 }));

const GIGA_MEMBER = { encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx', joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', tokens: 'tokens.txt' };
const ZHEN_MEMBER = { encoder: 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx', decoder: 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx', joiner: 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx', tokens: 'tokens.txt' };

/**
 * @typedef {object} Asset
 * @property {string} id
 * @property {string} asset          the file name (download, and in --from dirs)
 * @property {string} url
 * @property {string} sha256
 * @property {number} size
 * @property {'tgz'|'tar.bz2'|'file'} kind
 * @property {string} dest           folder under the wake dir
 * @property {Array<{ member: string|null, name: string, size: number, sha256: string }>} files
 * @property {string} [platform]     addon assets only
 * @property {boolean} [devOnly]     only with --with-zhen
 */

/** The pinned downloads (§5.4). @type {Readonly<Record<string, Asset>>} */
export const ASSETS = Object.freeze({
  'addon-win32-x64': {
    id: 'addon-win32-x64', platform: 'win32-x64', asset: `sherpa-onnx-win-x64-${SHERPA_VERSION}.tgz`, url: npmTgz('sherpa-onnx-win-x64'),
    sha256: 'fe522f02a5c113c2567a43982107ef41ae517f9a431931e90731e7e4d4341073', size: 8894875, kind: 'tgz',
    dest: LAYOUT.addonDir('win32-x64'), files: mapMembers(ADDON_FILES['win32-x64'], (f) => `package/${f.name}`),
  },
  'addon-linux-x64': {
    id: 'addon-linux-x64', platform: 'linux-x64', asset: `sherpa-onnx-linux-x64-${SHERPA_VERSION}.tgz`, url: npmTgz('sherpa-onnx-linux-x64'),
    sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c', size: 11089653, kind: 'tgz',
    dest: LAYOUT.addonDir('linux-x64'), files: mapMembers(ADDON_FILES['linux-x64'], (f) => `package/${f.name}`),
  },
  giga: {
    id: 'giga', asset: `${GIGA}.tar.bz2`, url: `${KWS}${GIGA}.tar.bz2`,
    sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a', size: 17626723, kind: 'tar.bz2', dest: LAYOUT.gigaDir,
    files: [
      ...mapMembers(MODEL_FILES.giga, (f) => `${GIGA}/${/** @type {any} */ (GIGA_MEMBER)[f.role]}`),
      { member: `${GIGA}/README.md`, ...GIGA_MODEL_CARD },
    ],
  },
  zhen: {
    id: 'zhen', devOnly: true, asset: `${ZHEN}.tar.bz2`, url: `${KWS}${ZHEN}.tar.bz2`,
    sha256: '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6', size: 32885699, kind: 'tar.bz2', dest: LAYOUT.zhenDevDir,
    files: mapMembers(MODEL_FILES.zhen, (f) => `${ZHEN}/${/** @type {any} */ (ZHEN_MEMBER)[f.role]}`),
  },
  vad: {
    id: 'vad', asset: 'silero_vad.onnx', url: `${ASR}silero_vad.onnx`, sha256: MODEL_FILES.vad.sha256, size: MODEL_FILES.vad.size, kind: 'file',
    dest: path.posix.dirname(LAYOUT.vad), files: [{ member: null, name: MODEL_FILES.vad.name, size: MODEL_FILES.vad.size, sha256: MODEL_FILES.vad.sha256 }],
  },
  'license-sherpa': {
    id: 'license-sherpa', asset: 'sherpa-onnx-LICENSE.txt', url: `${RAW}k2-fsa/sherpa-onnx/v${SHERPA_VERSION}/LICENSE`,
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', size: 11358, kind: 'file', dest: LAYOUT.licensesDir,
    files: [{ member: null, name: 'sherpa-onnx-LICENSE.txt', size: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' }],
  },
  'license-onnxruntime': {
    id: 'license-onnxruntime', asset: 'onnxruntime-LICENSE.txt', url: `${RAW}microsoft/onnxruntime/v${ONNXRUNTIME_VERSION}/LICENSE`,
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c', size: 1073, kind: 'file', dest: LAYOUT.licensesDir,
    files: [{ member: null, name: 'onnxruntime-LICENSE.txt', size: 1073, sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c' }],
  },
  'license-silero': {
    id: 'license-silero', asset: 'silero-vad-LICENSE.txt', url: `${RAW}snakers4/silero-vad/v5.1.2/LICENSE`,
    sha256: '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b', size: 1075, kind: 'file', dest: LAYOUT.licensesDir,
    files: [{ member: null, name: 'silero-vad-LICENSE.txt', size: 1075, sha256: '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b' }],
  },
});

export const PLATFORMS = Object.freeze(['linux-x64', 'win32-x64']);

/**
 * Every file an install can contain, relative to the wake folder (for the tests and the packaged
 * check): `{ path, size, sha256, asset, devOnly? }`.
 */
export const FILES = Object.freeze(Object.values(ASSETS).flatMap((a) => a.files.map((f) => Object.freeze({
  path: `${a.dest}/${f.name}`, size: f.size, sha256: f.sha256, asset: a.id, ...(a.devOnly ? { devOnly: true } : {}),
}))));

/** @param {Buffer|Uint8Array} buf */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Read the regular-file members of a (gunzipped) tar archive: ustar headers, the ustar `prefix`
 * field, pax `path` records and GNU long names. Returns name → data.
 * @param {Buffer} tar @param {(name: string) => boolean} [want]
 * @returns {Map<string, Buffer>}
 */
export function readTar(tar, want = () => true) {
  const out = new Map();
  const field = (/** @type {number} */ o, /** @type {number} */ n) => {
    const b = tar.subarray(o, o + n);
    const z = b.indexOf(0);
    return (z >= 0 ? b.subarray(0, z) : b).toString('utf8');
  };
  /** @type {string|null} */
  let longName = null;
  let p = 0;
  while (p + 512 <= tar.length) {
    if (tar.subarray(p, p + 512).every((x) => x === 0)) break; // end of archive
    const sum = tar.subarray(p, p + 512).reduce((a, x, i) => a + (i >= 148 && i < 156 ? 32 : x), 0);
    const stored = parseInt(field(p + 148, 8).trim() || '0', 8);
    if (sum !== stored) throw new Error(`corrupt tar header at byte ${p}`);
    const size = parseInt(field(p + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[p + 156] || 48);
    const prefix = field(p + 257, 6).startsWith('ustar') ? field(p + 345, 155) : '';
    let name = longName ?? (prefix ? `${prefix}/${field(p, 100)}` : field(p, 100));
    longName = null;
    const body = tar.subarray(p + 512, p + 512 + size);
    if (body.length !== size) throw new Error(`${name} is truncated`);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type !== '0' && type !== '\0') continue; // directories, links, global headers
    name = name.replace(/^\.\//, '');
    if (want(name)) out.set(name, Buffer.from(body));
  }
  return out;
}

/** The system tar (Windows: bsdtar in System32 first; a Git-for-Windows GNU tar reads C: as a host). */
export function tarBinary(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const sys = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

/**
 * Extract `members` of a .tar.bz2 with the system tar (in a fresh temp folder; the archive is
 * written there too and tar runs with that cwd, so no drive letter reaches it).
 * @param {Buffer} data @param {string[]} members
 * @returns {Map<string, Buffer>}
 */
export function extractTarBz2(data, members) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-wake-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.tar.bz2'), data);
    fs.mkdirSync(path.join(tmp, 'x'));
    const r = spawnSync(tarBinary(), ['-xjf', '../a.tar.bz2', ...members], { cwd: path.join(tmp, 'x'), encoding: 'utf8', windowsHide: true });
    if (r.error) {
      throw new Error(`could not run tar (${/** @type {any} */ (r.error).code || r.error.message}); it unpacks the .tar.bz2 model archives `
        + '(Windows 10 1803+ has it as %SystemRoot%\\System32\\tar.exe). Without it: run this script on another machine with '
        + '--out <dir> (or --from <dir> with the downloaded files) and copy <dir>/wake to vendor/wake.');
    }
    if (r.status !== 0) throw new Error(`tar failed (exit ${r.status}): ${String(r.stderr || '').trim().slice(0, 400)}`);
    const out = new Map();
    for (const m of members) out.set(m, fs.readFileSync(path.join(tmp, 'x', ...m.split('/'))));
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {string} platform @param {string} arch */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * @param {string[]} argv
 * @returns {{ platforms: string[], withZhen: boolean, from: string|null, force: boolean, out: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const o = { platforms: /** @type {string[]} */ ([]), withZhen: false, from: /** @type {string|null} */ (null), force: false, out: /** @type {string|null} */ (null), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const plat = (/** @type {string} */ v) => o.platforms.push(...(v === 'all' ? PLATFORMS : [v]));
    if (a === '--platform') plat(value());
    else if (a.startsWith('--platform=')) plat(a.slice('--platform='.length));
    else if (a === '--with-zhen') o.withZhen = true;
    else if (a === '--from') o.from = value();
    else if (a === '--out') o.out = value();
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const p of o.platforms) if (!PLATFORMS.includes(p)) throw new Error(`unsupported platform ${p} (use ${PLATFORMS.join(', ')} or all)`);
  if (!o.platforms.length) o.platforms.push(platformKey());
  o.platforms = [...new Set(o.platforms)];
  return o;
}

/**
 * Which assets a run installs. The zh-en model only with --with-zhen (never in resources/).
 * @param {{ platforms: string[], withZhen?: boolean }} o
 * @returns {Asset[]}
 */
export function selectAssets(o) {
  return Object.values(ASSETS).filter((a) => (a.platform ? o.platforms.includes(a.platform) : a.devOnly ? !!o.withZhen : true));
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

/** @param {string} file @param {Buffer} data */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** @param {string} file @param {{ size: number, sha256: string }} f */
function verified(file, f) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size === f.size && sha256(fs.readFileSync(file)) === f.sha256;
  } catch {
    return false;
  }
}

/**
 * Fetch, verify and install the pinned engine files under `<out>/wake/`; writes manifest.json.
 * @param {{ platforms: string[], out: string, withZhen?: boolean, from?: string|null, force?: boolean, say?: (m: string) => void,
 *   fetchFile?: (url: string) => Promise<Buffer>, assets?: Asset[] }} o
 * @returns {Promise<{ wakeDir: string, installed: string[], skipped: string[], manifest: string }>}
 */
export async function fetchWake(o) {
  const say = o.say || (() => {});
  const wakeDir = path.join(o.out, 'wake');
  const assets = o.assets || selectAssets(o);
  const installed = [];
  const skipped = [];
  for (const a of assets) {
    const target = (/** @type {{ name: string }} */ f) => path.join(wakeDir, ...a.dest.split('/'), f.name);
    if (!o.force && a.files.every((f) => verified(target(f), f))) {
      skipped.push(a.id);
      continue;
    }
    say(`${a.id}: ${a.asset}`);
    const data = o.from ? fs.readFileSync(path.join(o.from, a.asset)) : await (o.fetchFile ? o.fetchFile(a.url) : download(a.url, say));
    const got = sha256(data);
    if (got !== a.sha256) throw new Error(`SHA-256 mismatch for ${a.asset}: expected ${a.sha256}, got ${got}. Not installing it.`);
    if (data.length !== a.size) throw new Error(`size mismatch for ${a.asset}: expected ${a.size}, got ${data.length}`);
    /** @type {Map<string|null, Buffer>} */
    let members;
    if (a.kind === 'file') members = new Map([[null, data]]);
    else if (a.kind === 'tgz') {
      const want = new Set(a.files.map((f) => f.member));
      members = /** @type {any} */ (readTar(zlib.gunzipSync(data), (n) => want.has(n)));
    } else members = /** @type {any} */ (extractTarBz2(data, a.files.map((f) => /** @type {string} */ (f.member))));
    // verify every member before writing any of them
    for (const f of a.files) {
      const b = members.get(f.member);
      if (!b) throw new Error(`${f.member} not found in ${a.asset}`);
      const h = sha256(b);
      if (h !== f.sha256 || b.length !== f.size) throw new Error(`unexpected ${f.member} inside ${a.asset} (SHA-256 ${h}, ${b.length} B). Not installing it.`);
    }
    for (const f of a.files) writeAtomic(target(f), /** @type {Buffer} */ (members.get(f.member)));
    say(`  verified SHA-256 ${a.sha256} → ${path.join(wakeDir, ...a.dest.split('/'))}`);
    installed.push(a.id);
  }
  // the manifest lists every pinned file that is present and verifies (also from earlier runs)
  const files = [];
  for (const a of Object.values(ASSETS)) {
    for (const f of a.files) {
      const rel = `${a.dest}/${f.name}`;
      if (verified(path.join(wakeDir, ...rel.split('/')), f)) files.push({ path: rel, size: f.size, sha256: f.sha256 });
    }
  }
  const manifest = path.join(wakeDir, 'manifest.json');
  writeAtomic(manifest, Buffer.from(`${JSON.stringify({ sherpaOnnx: SHERPA_VERSION, files }, null, 2)}\n`));
  return { wakeDir, installed, skipped, manifest };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`fetch-wake: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node scripts/fetch-wake.mjs [--platform linux-x64|win32-x64|all] [--with-zhen] [--from <dir>] [--force] [--out <dir>]');
    return;
  }
  try {
    const r = await fetchWake({ ...opts, out: opts.out ? path.resolve(opts.out) : path.join(root, 'vendor'), from: opts.from ? path.resolve(opts.from) : null, say: (m) => console.log(m) });
    console.log(`fetch-wake: ${r.installed.length} installed, ${r.skipped.length} already in place (${r.wakeDir})`);
  } catch (err) {
    console.error(`fetch-wake: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
