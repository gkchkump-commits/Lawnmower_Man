#!/usr/bin/env node
// Run the exact runtime wake-word recipe (electron/wake/utility/engine.js: Silero onsets, fresh
// streams, level normaliser, zh-en + GigaSpeech OR-ed) over a folder of 16 kHz WAVs with a
// manifest.tsv (contract-wake §7.10). For the user's own recordings (Settings › Voice › Record a test
// clip writes them; docs/WAKE.md) and for the research eval set.
//
//   node tools/wake/eval-folder.mjs <dir> [options]
//     --stream              one shuffled stream (gaps --gap-min..--gap-max s of noise at --floor dBFS)
//                           instead of one utterance at a time (each clip its own stream; 0.6 s
//                           of the floor after it)
//     --sensitivity <s>     low | normal | high (default normal)    --phrase hey-jade | jade
//     --classes a,b         only these classes          --no-agc          without the level normaliser
//     --max-stream-ms <n>   renew a stream after n ms of continuous speech (default off)
//     --floor <dBFS>        noise floor under everything (default -60)   --seed <n>   shuffle seed (7)
//     --gap-min / --gap-max stream gaps in s (0.3 / 1.5)
//     --wake-dir <dir>      engine files (default vendor/wake)    --zhen-dir <dir> | --no-zhen
//     --json                one JSON report on stdout (else a table)
// Manifest: `id class text voice speed jadeEndSec` with a header (tests/fixtures/wake, test clips)
// or the research set's header-less `id cls phrase voice speed text jade_start jade_end dur`
// (files in <dir>/<cls>/<id>.wav). A user's clip without a manifest: write one line per file,
// e.g. `20261010-094112	pos	Hey Jade	me	1.0	-1`.
//
// Counts per class: clips with a HEY_JADE / HEY_JUDE / JADE hit; for negatives also false wakes per
// hour of their audio; latency to the end of "Jade" where the manifest has it; CPU per second.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildStream, findEngine, lcg, loadEngine, readManifest, readWav16, runStream, score, SR } from './fixture-stream.mjs';

const POSITIVE = new Set(['pos', 'pause']);

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {any} */
  const o = { dir: null, stream: false, sensitivity: 'normal', phrase: 'hey-jade', classes: null, agc: true, maxStreamMs: 0, floorDb: -60, seed: 7, gapMin: 0.3, gapMax: 1.5, wakeDir: undefined, zhenDir: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--stream') o.stream = true;
    else if (a === '--sensitivity') o.sensitivity = v();
    else if (a === '--phrase') o.phrase = v();
    else if (a === '--classes') o.classes = v().split(',').filter(Boolean);
    else if (a === '--no-agc') o.agc = false;
    else if (a === '--max-stream-ms') o.maxStreamMs = Number(v());
    else if (a === '--floor') o.floorDb = Number(v());
    else if (a === '--seed') o.seed = Number(v());
    else if (a === '--gap-min') o.gapMin = Number(v());
    else if (a === '--gap-max') o.gapMax = Number(v());
    else if (a === '--wake-dir') o.wakeDir = path.resolve(v());
    else if (a === '--zhen-dir') o.zhenDir = path.resolve(v());
    else if (a === '--no-zhen') o.zhenDir = null;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown argument ${a}`);
    else if (!o.dir) o.dir = path.resolve(a);
    else throw new Error(`unexpected ${a}`);
  }
  if (!o.dir) throw new Error('usage: node tools/wake/eval-folder.mjs <dir> [--stream] [--sensitivity normal] [--json] …');
  if (!['low', 'normal', 'high'].includes(o.sensitivity)) throw new Error('--sensitivity is low, normal or high');
  return o;
}

/**
 * @param {ReturnType<typeof parseArgs>} o
 */
export async function evalFolder(o) {
  const found = findEngine({ wakeDir: o.wakeDir, zhenDir: o.zhenDir });
  if (!found.ok) throw new Error(`engine files missing in ${found.wakeDir}: ${found.missing.join(', ')} (npm run fetch:wake)`);
  let rows = readManifest(o.dir);
  if (o.classes) rows = rows.filter((r) => o.classes.includes(r.cls));
  if (!rows.length) throw new Error('no clips');
  const opts = { wakeDir: found.wakeDir, key: found.key, zhenDir: found.zhenDir, params: { sensitivity: o.sensitivity, phrase: o.phrase }, recipe: { maxStreamMs: o.maxStreamMs }, agc: o.agc };
  const t0 = Date.now();
  /** @type {any[]} */
  let spans;
  /** @type {any[]} */
  let hits;
  let audioSec;
  let stats;
  let models;
  if (o.stream) {
    const rnd = lcg(o.seed);
    const shuffled = rows.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const built = buildStream(shuffled, { gapSec: () => o.gapMin + (o.gapMax - o.gapMin) * rnd(), floorDb: o.floorDb, seed: o.seed + 1 });
    const e = loadEngine(opts);
    models = e.models;
    hits = await runStream(e.engine, built.audio);
    spans = built.spans;
    audioSec = built.audio.length / SR;
    stats = e.engine.stats();
  } else {
    // one utterance at a time: a fresh engine state per clip would cost a model load each, so one
    // engine sees the clips with an 8 s gap of the floor between them (> quiet + hangover: every clip
    // starts a fresh stream, exactly like the per-utterance protocol)
    const built = buildStream(rows, { gapSec: 8, floorDb: o.floorDb, seed: o.seed + 1 });
    const e = loadEngine(opts);
    models = e.models;
    hits = await runStream(e.engine, built.audio);
    spans = built.spans;
    audioSec = built.audio.length / SR;
    stats = e.engine.stats();
  }
  const s = score(spans, hits);
  /** @type {Record<string, any>} */
  const classes = {};
  for (const [cls, c] of Object.entries(s.classes)) {
    const sec = spans.filter((sp) => sp.cls === cls).reduce((a, sp) => a + (sp.e - sp.s) / SR, 0);
    const wakes = Object.values(c.ids).filter((k) => k.includes('HEY_JADE')).length;
    classes[cls] = { n: c.n, HEY_JADE: c.HEY_JADE, HEY_JUDE: c.HEY_JUDE, JADE: c.JADE, audioMin: Math.round((sec / 60) * 10) / 10, ...(POSITIVE.has(cls) ? {} : { wakesPerHour: sec > 0 ? Math.round((wakes / (sec / 3600)) * 100) / 100 : 0 }) };
  }
  const missed = Object.entries(s.classes).filter(([cls]) => POSITIVE.has(cls)).flatMap(([, c]) => Object.entries(c.ids).filter(([, k]) => !k.includes('HEY_JADE')).map(([id]) => id));
  const falseWakes = Object.entries(s.classes).filter(([cls]) => !POSITIVE.has(cls)).flatMap(([cls, c]) => Object.entries(c.ids).filter(([, k]) => k.includes('HEY_JADE')).map(([id]) => `${cls}:${id}`));
  return {
    dir: o.dir, mode: o.stream ? 'stream' : 'per-utterance', sensitivity: o.sensitivity, phrase: o.phrase, agc: o.agc, maxStreamMs: o.maxStreamMs, floorDb: o.floorDb,
    models, clips: rows.length, audioMin: Math.round((audioSec / 60) * 10) / 10, wallSec: Math.round((Date.now() - t0) / 100) / 10,
    classes, latencyMs: { n: s.latencyMs.n, p50: s.latencyMs.p50, p90: s.latencyMs.p90 }, missed, falseWakes,
    cpu: { msPerSecSpeech: stats.cpuMsPerSecSpeech, msPerSecSilence: stats.cpuMsPerSecSilence, msPerSecAll: stats.cpuMsPerSecAll },
    onsets: stats.onsets, streams: stats.streams,
  };
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`eval-folder: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  try {
    const r = await evalFolder(o);
    if (o.json) {
      console.log(JSON.stringify(r));
      return;
    }
    console.log(`${r.mode}, ${r.clips} clips, ${r.audioMin} min, models ${r.models.join('+')}, sensitivity ${r.sensitivity}${r.agc ? '' : ', no AGC'}`);
    console.log('class          n  HEY_JADE  HEY_JUDE  JADE  wakes/h');
    for (const [cls, c] of Object.entries(r.classes)) console.log(`${cls.padEnd(12)} ${String(c.n).padStart(3)}  ${String(c.HEY_JADE).padStart(8)}  ${String(c.HEY_JUDE).padStart(8)}  ${String(c.JADE).padStart(4)}  ${c.wakesPerHour ?? ''}`);
    console.log(`latency to the end of "Jade": p50 ${r.latencyMs.p50} ms, p90 ${r.latencyMs.p90} ms (n ${r.latencyMs.n}); CPU ${r.cpu.msPerSecSpeech} ms/s of speech, ${r.cpu.msPerSecSilence} ms/s between`);
    if (r.missed.length) console.log(`missed: ${r.missed.join(', ')}`);
    if (r.falseWakes.length) console.log(`false wakes: ${r.falseWakes.join(', ')}`);
  } catch (err) {
    console.error(`eval-folder: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

export { readWav16 };
