import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_FILES, KEYWORDS, MODEL_FILES, NAME_THRESHOLD, RECIPE_DEFAULTS, SENSITIVITY, SPOTTER_DEFAULTS, buildConfig, withThreshold } from '../../../electron/wake/config.js';

describe('wake config: keywords and thresholds (contract §7.7)', () => {
  it('has the exact keyword lines of the eval (A-var + Jude label, B + Jude label, the name)', () => {
    expect(KEYWORDS.zhen).toBe('HH EY1 JH EY1 D @HEY_JADE\nEY1 JH EY1 D @HEY_JADE\nHH EY1 JH EY1 T @HEY_JADE\nHH EY2 JH EY1 D @HEY_JADE\nHH EY1 JH UW1 D @HEY_JUDE\n');
    expect(KEYWORDS.giga).toBe('▁HE Y ▁JA DE @HEY_JADE\n▁HE Y ▁JU DE @HEY_JUDE\n');
    expect(KEYWORDS.nameZhen).toBe('JH EY1 D @JADE\n');
    expect(KEYWORDS.nameGiga).toBe('▁JA DE @JADE\n');
    // no decoys that share the start or end of "hey jade" (they steal recall, eval.md §3)
    for (const k of Object.values(KEYWORDS)) expect(k).not.toMatch(/HEY_JAY|HEY_J\b|OKAY_JADE|SAY_JADE|HEY_JANE/);
  });

  it('has the sensitivity table', () => {
    expect(SENSITIVITY).toEqual({
      low: { zhen: 0.15, giga: 0.10, gigaOnly: 0.25, veto: 'full' },
      normal: { zhen: 0.10, giga: 0.05, gigaOnly: 0.05, veto: 'full' },
      high: { zhen: 0.05, giga: 0.05, gigaOnly: 0.05, veto: 'jude' },
    });
    expect(SPOTTER_DEFAULTS).toEqual({ maxActivePaths: 16, numTrailingBlanks: 1, keywordsScore: 1.0, numThreads: 1 });
    // (changed on purpose: streams are renewed in continuous speech, overlapping; drifted stamps are re-anchored)
    expect(RECIPE_DEFAULTS).toMatchObject({ quietMs: 600, prerollMs: 400, hangoverMs: 700, maxStreamMs: 8000, overlapMs: 2000, namePrefixMs: 720, stampLateMs: 900, reanchorMs: 450 });
  });

  it('builds A + B at normal, B alone with gigaOnly, strict → low', () => {
    const both = buildConfig({ sensitivity: 'normal', phrase: 'hey-jade', hasZhen: true });
    expect(both.spotters.map((s) => [s.name, s.model, s.threshold])).toEqual([['zhen', 'zhen', 0.10], ['giga', 'giga', 0.05]]);
    expect(both.veto).toBe('full');
    const bOnly = buildConfig({ sensitivity: 'low', phrase: 'hey-jade', hasZhen: false });
    expect(bOnly.spotters.map((s) => [s.name, s.threshold])).toEqual([['giga', 0.25]]);
    const strict = buildConfig({ sensitivity: 'high', strict: true, hasZhen: true });
    expect(strict.sensitivity).toBe('low');
    expect(strict.spotters.map((s) => s.threshold)).toEqual([0.15, 0.10]);
    expect(buildConfig({ sensitivity: 'high', hasZhen: true }).veto).toBe('jude');
    expect(buildConfig({ sensitivity: 'bogus' }).sensitivity).toBe('normal');
  });

  it("adds the name stream only for phrase 'jade' (on model A when present, else B)", () => {
    expect(buildConfig({ phrase: 'hey-jade', hasZhen: true }).spotters.some((s) => s.name === 'name')).toBe(false);
    const a = buildConfig({ phrase: 'jade', hasZhen: true }).spotters.find((s) => s.name === 'name');
    expect(a).toMatchObject({ model: 'zhen', threshold: NAME_THRESHOLD, keywords: 'JH EY1 D #0.25 @JADE\n' });
    const b = buildConfig({ phrase: 'jade', hasZhen: false }).spotters.find((s) => s.name === 'name');
    expect(b).toMatchObject({ model: 'giga', keywords: '▁JA DE #0.25 @JADE\n' });
  });

  it('folds a threshold into each keyword line', () => {
    expect(withThreshold('A B @X\nC #0.9 @Y\n', 0.1)).toBe('A B #0.1 @X\nC #0.1 @Y\n');
    expect(() => withThreshold('A @X', 0)).toThrow(RangeError);
  });

  it('pins every engine file with a size and a SHA-256', () => {
    const all = [...ADDON_FILES['win32-x64'], ...ADDON_FILES['linux-x64'], ...MODEL_FILES.giga, ...MODEL_FILES.zhen, MODEL_FILES.vad];
    for (const f of all) {
      expect(f.size, f.name).toBeGreaterThan(0);
      expect(f.sha256, f.name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(ADDON_FILES['win32-x64'].map((f) => f.name)).toEqual(['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll']);
  });

  it('the voice downloader pins model A with the same hashes (voice/lawnmower_voice/download.py)', () => {
    const py = fs.readFileSync(path.resolve('voice/lawnmower_voice/download.py'), 'utf8');
    for (const f of MODEL_FILES.zhen) {
      expect(py, f.name).toContain(f.sha256);
      expect(py, f.name).toContain(`"${f.name}"`);
    }
    expect(py).toContain('68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6');
  });
});
