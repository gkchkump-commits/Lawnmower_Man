import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addonPath, checkFiles, checkZhen, enginePaths, platformKey, resolveWakeDir, zhenCandidates, zhenDir } from '../../../electron/wake/paths.js';
import { ADDON_FILES, MODEL_FILES } from '../../../electron/wake/config.js';
import { tmpDir } from '../helpers/tmp.js';

/** A wake folder with files of the pinned sizes (sparse content). */
function fakeWakeDir({ key = 'linux-x64', skip = [], zhen = false } = {}) {
  const dir = tmpDir('lm-wakepaths-');
  const put = (rel, size) => {
    if (skip.includes(rel)) return;
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(size));
  };
  for (const f of ADDON_FILES[key]) put(`sherpa-onnx/${key}/${f.name}`, f.size);
  for (const f of MODEL_FILES.giga) put(`models/gigaspeech-3.3m/${f.name}`, f.size);
  put('models/silero_vad.onnx', MODEL_FILES.vad.size);
  if (zhen) for (const f of MODEL_FILES.zhen) put(`dev-models/zh-en-3m/${f.name}`, f.size);
  return dir;
}

describe('wake paths (contract §7.8)', () => {
  it('resolves the wake folder: env > packaged resources > vendor/', () => {
    expect(resolveWakeDir({ isPackaged: false, appRoot: '/app', env: {} })).toBe(path.join('/app', 'vendor', 'wake'));
    expect(resolveWakeDir({ isPackaged: true, resourcesPath: '/res', appRoot: '/res/app.asar', env: {} })).toBe(path.join('/res', 'wake'));
    expect(resolveWakeDir({ isPackaged: true, resourcesPath: '/res', appRoot: '/x', env: { LAWNMOWER_WAKE_DIR: '/tmp/w' } })).toBe(path.resolve('/tmp/w'));
  });

  it('names the addon and the model files', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(addonPath('/w', 'win32-x64')).toBe(path.join('/w', 'sherpa-onnx', 'win32-x64', 'sherpa-onnx.node'));
    const p = enginePaths('/w', 'linux-x64');
    expect(p.giga).toEqual({ encoder: path.join('/w/models/gigaspeech-3.3m/encoder.int8.onnx'), decoder: path.join('/w/models/gigaspeech-3.3m/decoder.onnx'), joiner: path.join('/w/models/gigaspeech-3.3m/joiner.int8.onnx'), tokens: path.join('/w/models/gigaspeech-3.3m/tokens.txt') });
    expect(p.vad).toBe(path.join('/w/models/silero_vad.onnx'));
  });

  it('checkFiles(): complete → ok; missing or wrong-size files are named', () => {
    expect(checkFiles(fakeWakeDir(), { key: 'linux-x64' })).toEqual({ ok: true, missing: [], platformSupported: true });
    const d = fakeWakeDir({ skip: ['models/silero_vad.onnx', 'sherpa-onnx/linux-x64/libonnxruntime.so'] });
    fs.writeFileSync(path.join(d, 'models/gigaspeech-3.3m/tokens.txt'), 'short');
    const r = checkFiles(d, { key: 'linux-x64' });
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(['models/gigaspeech-3.3m/tokens.txt', 'models/silero_vad.onnx', 'sherpa-onnx/linux-x64/libonnxruntime.so']);
    // the Windows addon is checked by its own file list
    expect(checkFiles(fakeWakeDir({ key: 'win32-x64' }), { key: 'win32-x64' }).ok).toBe(true);
    const mac = checkFiles(fakeWakeDir(), { key: 'darwin-arm64' });
    expect(mac).toMatchObject({ ok: false, platformSupported: false });
  });

  it('model A: LAWNMOWER_WAKE_ZHEN_DIR, then the voice models folder, then (unpackaged) dev-models', () => {
    const w = fakeWakeDir({ zhen: true });
    expect(zhenCandidates({ env: { LAWNMOWER_WAKE_ZHEN_DIR: '/z' }, isPackaged: false, wakeDir: w, voiceModelsDir: '/m' })).toEqual([path.resolve('/z')]);
    expect(zhenCandidates({ env: {}, isPackaged: false, wakeDir: w, voiceModelsDir: '/m' })).toEqual([path.join('/m', 'kws', 'zh-en-3m'), path.join(w, 'dev-models', 'zh-en-3m')]);
    expect(zhenCandidates({ env: {}, isPackaged: true, wakeDir: w, voiceModelsDir: null })).toEqual([]);
    expect(zhenDir({ env: {}, isPackaged: false, wakeDir: w })).toBe(path.join(w, 'dev-models', 'zh-en-3m'));
    expect(zhenDir({ env: {}, isPackaged: true, wakeDir: w })).toBeNull(); // never the dev copy in an installed app
    expect(checkZhen(path.join(w, 'dev-models', 'zh-en-3m'))).toBe(true);
    expect(checkZhen(path.join(w, 'nope'))).toBe(false);
  });
});
