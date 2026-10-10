// The engine test (contract-wake §11.4): the real sherpa-onnx addon, model B (+ model A from
// vendor/wake/dev-models when present), Silero VAD and the runtime recipe over the committed Kokoro
// fixtures, with the evaluated expectations. Skips with a reason when vendor/wake is missing
// (npm run fetch:wake -- --with-zhen), except with WAKE_ENGINE_REQUIRED=1 (CI, the merge gate),
// where it fails instead.
import { describe, it, expect } from 'vitest';
import { findEngine, runFixtures } from '../../../tools/wake/fixture-stream.mjs';

const found = findEngine();
const required = process.env.WAKE_ENGINE_REQUIRED === '1';
if (!found.ok && !required) console.log(`[engine-fixtures] skipped: the wake-word engine is not in ${found.wakeDir} (npm run fetch:wake -- --with-zhen); missing ${found.missing.slice(0, 3).join(', ')}…`);

describe.runIf(found.ok || required)('wake engine over the fixtures (real addon and models)', () => {
  it('is installed (WAKE_ENGINE_REQUIRED=1 makes a missing engine a failure)', () => {
    expect(found.missing).toEqual([]);
  });

  it('meets the §11.4 expectations at normal sensitivity', async () => {
    const r = await runFixtures({ wakeDir: found.wakeDir, key: found.key, zhenDir: found.zhenDir });
    // the distribution for the renderer lane (cut after the keyword, latency budget)
    console.log(`[engine-fixtures] models ${r.models.join('+')}, load ${r.loadMs} ms, ${r.audioSec} s of audio; classes ${JSON.stringify(r.classes)}; name (phrase 'jade') ${JSON.stringify(r.name && { n: r.name.n, JADE: r.name.JADE })}`);
    console.log(`[engine-fixtures] latency to the end of "Jade" ms: p50 ${r.latencyMs.p50}, p90 ${r.latencyMs.p90}, min ${r.latencyMs.min}, max ${r.latencyMs.max}; endAt − jadeEnd ms: ${r.endDeltaMs.all.join(' ')}`);
    console.log(`[engine-fixtures] CPU ${r.cpu.speech} ms per s of speech, ${r.cpu.silence} ms per s of silence (${r.cpu.all} overall)`);
    expect(r.failures).toEqual([]);
    const c = r.classes;
    expect(c.pos.HEY_JADE).toBeGreaterThanOrEqual(found.zhenDir ? 9 : 8);
    expect(c.jude.HEY_JADE).toBeLessThanOrEqual(1);
    expect(c.jude.HEY_JUDE).toBeGreaterThanOrEqual(5);
    expect(c.self.HEY_JADE).toBeLessThanOrEqual(1);
    expect(c.neg.HEY_JADE).toBe(0);
    expect(c.selfbad.HEY_JADE).toBeGreaterThanOrEqual(1); // why the text mask exists
    expect(r.name.JADE).toBeGreaterThanOrEqual(1);
    expect(r.latencyMs.p50).toBeLessThanOrEqual(450);
    expect(r.outside).toEqual([]);
    expect(r.cpu.speech).toBeLessThanOrEqual(150);
    expect(r.cpu.silence).toBeLessThanOrEqual(15);
  }, 180000);

  it.runIf(!!found.zhenDir)('model B alone (before model A is downloaded) still wakes on ≥ 8/10', async () => {
    const r = await runFixtures({ wakeDir: found.wakeDir, key: found.key, zhenDir: null });
    console.log(`[engine-fixtures] B only: classes ${JSON.stringify(r.classes)}; latency p50 ${r.latencyMs.p50} ms`);
    expect(r.models).toEqual(['giga']);
    expect(r.failures).toEqual([]);
  }, 180000);
});
