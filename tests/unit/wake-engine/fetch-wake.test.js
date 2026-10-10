import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ASSETS, FILES, GIGA_MODEL_CARD, extractTarBz2, fetchWake, parseArgs, readTar, selectAssets, sha256, tarBinary } from '../../../scripts/fetch-wake.mjs';
import { ADDON_FILES, LAYOUT, MODEL_FILES } from '../../../electron/wake/config.js';

/** A minimal ustar writer (enough for the reader under test). */
function makeTar(files, { prefixSplit = false } = {}) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    let n = name;
    let prefix = '';
    if (prefixSplit && name.includes('/')) {
      prefix = name.slice(0, name.lastIndexOf('/'));
      n = name.slice(name.lastIndexOf('/') + 1);
    }
    h.write(n, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    if (prefix) h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-wakefetch-'));

describe('fetch-wake: pins', () => {
  it('pins the contract §5.4 downloads', () => {
    expect(ASSETS['addon-win32-x64']).toMatchObject({ sha256: 'fe522f02a5c113c2567a43982107ef41ae517f9a431931e90731e7e4d4341073', size: 8894875, url: 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.8.tgz' });
    expect(ASSETS['addon-linux-x64']).toMatchObject({ sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c', size: 11089653 });
    expect(ASSETS.giga).toMatchObject({ sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2' });
    expect(ASSETS.zhen).toMatchObject({ sha256: '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6', devOnly: true, dest: 'dev-models/zh-en-3m' });
    expect(ASSETS.vad).toMatchObject({ sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' });
    expect(ASSETS['license-sherpa'].url).toBe('https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE');
    expect(ASSETS['license-onnxruntime'].url).toBe('https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE');
    expect(GIGA_MODEL_CARD.sha256).toBe('74e42d37d63acd2366b042151d576fcc0c4917a41de339414a37f1e79f4e80e2');
  });

  it('FILES agrees with electron/wake/config.js (one source for the sizes paths.js checks)', () => {
    const byPath = new Map(FILES.map((f) => [f.path, f]));
    for (const [key, list] of Object.entries(ADDON_FILES)) {
      for (const f of list) expect(byPath.get(`${LAYOUT.addonDir(key)}/${f.name}`)).toMatchObject({ size: f.size, sha256: f.sha256 });
    }
    for (const f of MODEL_FILES.giga) expect(byPath.get(`${LAYOUT.gigaDir}/${f.name}`)).toMatchObject({ size: f.size, sha256: f.sha256 });
    for (const f of MODEL_FILES.zhen) expect(byPath.get(`${LAYOUT.zhenDevDir}/${f.name}`)).toMatchObject({ size: f.size, devOnly: true });
    expect(byPath.get(LAYOUT.vad)).toMatchObject({ size: MODEL_FILES.vad.size });
    // the zh-en model is only ever under dev-models/ (never packaged: no extraResources rule copies it)
    expect(FILES.filter((f) => /zh-en/.test(f.path)).every((f) => f.path.startsWith('dev-models/'))).toBe(true);
    expect(FILES.filter((f) => f.path.startsWith('models/')).some((f) => /zh-en/.test(f.path))).toBe(false);
  });
});

describe('fetch-wake: arguments and selection', () => {
  it('parses its arguments', () => {
    expect(parseArgs(['--platform', 'all']).platforms).toEqual(['linux-x64', 'win32-x64']);
    expect(parseArgs(['--platform=win32-x64', '--with-zhen', '--force'])).toMatchObject({ platforms: ['win32-x64'], withZhen: true, force: true });
    expect(() => parseArgs(['--platform', 'darwin-arm64'])).toThrow(/unsupported/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown/);
    expect(() => parseArgs(['--from'])).toThrow(/needs a value/);
  });

  it('fetches zh-en only with --with-zhen; the addon only for the asked platforms', () => {
    const ids = (o) => selectAssets(o).map((a) => a.id).sort();
    expect(ids({ platforms: ['win32-x64'] })).toEqual(['addon-win32-x64', 'giga', 'license-onnxruntime', 'license-sherpa', 'license-silero', 'vad']);
    expect(ids({ platforms: ['linux-x64'], withZhen: true })).toContain('zhen');
  });
});

describe('fetch-wake: archives', () => {
  it('reads ustar members (plain names and the prefix field) and checks header checksums', () => {
    const a = Buffer.from('alpha');
    const b = Buffer.alloc(1300, 7);
    const tar = makeTar({ 'package/sherpa-onnx.node': a, 'package/deep/dir/lib.so': b });
    const m = readTar(tar);
    expect(m.get('package/sherpa-onnx.node').equals(a)).toBe(true);
    expect(m.get('package/deep/dir/lib.so').equals(b)).toBe(true);
    expect(readTar(makeTar({ 'package/x.dll': a }, { prefixSplit: true })).get('package/x.dll').equals(a)).toBe(true);
    expect([...readTar(tar, (n) => n.endsWith('.node')).keys()]).toEqual(['package/sherpa-onnx.node']);
    const bad = Buffer.from(tar);
    bad[0] ^= 0xff;
    expect(() => readTar(bad)).toThrow(/corrupt tar header/);
  });

  it('extracts .tar.bz2 members with the system tar', () => {
    const work = tmp();
    fs.mkdirSync(path.join(work, 'src', 'm'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'm', 'tokens.txt'), 'a b c');
    fs.writeFileSync(path.join(work, 'src', 'm', 'other.txt'), 'x');
    const made = spawnSync(tarBinary(), ['-cjf', '../a.tar.bz2', 'm/tokens.txt', 'm/other.txt'], { cwd: path.join(work, 'src') });
    if (made.status !== 0) return; // no bzip2-capable tar to make the fixture with
    const out = extractTarBz2(fs.readFileSync(path.join(work, 'a.tar.bz2')), ['m/tokens.txt']);
    expect(out.get('m/tokens.txt').toString()).toBe('a b c');
    expect(() => extractTarBz2(fs.readFileSync(path.join(work, 'a.tar.bz2')), ['m/missing.txt'])).toThrow(/tar failed/);
  });
});

describe('fetch-wake: install', () => {
  /** A fake addon tarball in the npm layout, pinned for the test. */
  function fakeAddonAsset() {
    const files = { 'package/sherpa-onnx.node': Buffer.from('NODE'), 'package/libonnxruntime.so': Buffer.alloc(3000, 1), 'package/README.md': Buffer.from('x') };
    const tgz = zlib.gzipSync(makeTar(files));
    return {
      id: 'addon-linux-x64', platform: 'linux-x64', asset: 'fake.tgz', url: 'https://example.invalid/fake.tgz', sha256: sha256(tgz), size: tgz.length, kind: 'tgz', dest: 'sherpa-onnx/linux-x64',
      files: [
        { member: 'package/sherpa-onnx.node', name: 'sherpa-onnx.node', size: 4, sha256: sha256(files['package/sherpa-onnx.node']) },
        { member: 'package/libonnxruntime.so', name: 'libonnxruntime.so', size: 3000, sha256: sha256(files['package/libonnxruntime.so']) },
      ],
      data: tgz,
    };
  }

  it('installs verified members, writes the manifest, then skips (idempotent)', async () => {
    const out = tmp();
    const a = fakeAddonAsset();
    let fetched = 0;
    const fetchFile = async () => { fetched++; return a.data; };
    const r = await fetchWake({ platforms: ['linux-x64'], out, assets: [a], fetchFile });
    expect(r.installed).toEqual(['addon-linux-x64']);
    expect(fs.readFileSync(path.join(out, 'wake', 'sherpa-onnx', 'linux-x64', 'sherpa-onnx.node'), 'utf8')).toBe('NODE');
    expect(fs.existsSync(path.join(out, 'wake', 'sherpa-onnx', 'linux-x64', 'README.md'))).toBe(false);
    const again = await fetchWake({ platforms: ['linux-x64'], out, assets: [a], fetchFile });
    expect(again.skipped).toEqual(['addon-linux-x64']);
    expect(fetched).toBe(1);
    const manifest = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
    expect(manifest.sherpaOnnx).toBe('1.13.8');
  });

  it('a download with the wrong SHA-256 installs nothing', async () => {
    const out = tmp();
    const a = fakeAddonAsset();
    await expect(fetchWake({ platforms: ['linux-x64'], out, assets: [a], fetchFile: async () => Buffer.from('evil') })).rejects.toThrow(/SHA-256 mismatch/);
    expect(fs.existsSync(path.join(out, 'wake', 'sherpa-onnx'))).toBe(false);
  });

  it('a member with the wrong hash installs nothing of that asset', async () => {
    const out = tmp();
    const a = fakeAddonAsset();
    a.files[1] = { ...a.files[1], sha256: '0'.repeat(64) };
    await expect(fetchWake({ platforms: ['linux-x64'], out, assets: [a], fetchFile: async () => a.data })).rejects.toThrow(/unexpected package\/libonnxruntime\.so/);
    expect(fs.existsSync(path.join(out, 'wake', 'sherpa-onnx', 'linux-x64', 'sherpa-onnx.node'))).toBe(false);
  });

  it('vendor/wake, when fetched here, verifies against every pin', () => {
    const manifestFile = path.resolve('vendor/wake/manifest.json');
    if (!fs.existsSync(manifestFile)) return; // npm run fetch:wake not run on this machine
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const pins = new Map(FILES.map((f) => [f.path, f]));
    for (const f of m.files) {
      expect(pins.get(f.path), f.path).toBeTruthy();
      const file = path.resolve('vendor/wake', f.path);
      expect(fs.statSync(file).size, f.path).toBe(pins.get(f.path).size);
    }
  });
});
