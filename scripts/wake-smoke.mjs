#!/usr/bin/env node
// "Hey Jade" engine smoke test (contract-wake §7.10, §11.8): loads this platform's vendored
// sherpa-onnx addon (vendor/wake, or LAWNMOWER_WAKE_DIR), runs the committed fixture stream
// (tests/fixtures/wake) through the runtime engine and prints one JSON report. Exits 1 when an
// expectation of §11.4 fails or the engine does not load. Plain Node 22 (the addon is N-API): on
// windows-latest this is the real Windows load of sherpa-onnx.node and its DLLs.
//
//   node scripts/wake-smoke.mjs [--wake-dir <dir>] [--zhen-dir <dir> | --no-zhen] [--fixtures <dir>]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findEngine, runFixtures } from '../tools/wake/fixture-stream.mjs';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { wakeDir: /** @type {string|undefined} */ (undefined), zhenDir: /** @type {string|null|undefined} */ (undefined), fixtures: /** @type {string|undefined} */ (undefined) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return path.resolve(x);
    };
    if (a === '--wake-dir') o.wakeDir = v();
    else if (a === '--zhen-dir') o.zhenDir = v();
    else if (a === '--no-zhen') o.zhenDir = null;
    else if (a === '--fixtures') o.fixtures = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`wake-smoke: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  const found = findEngine({ wakeDir: args.wakeDir, zhenDir: args.zhenDir });
  if (!found.ok) {
    console.log(JSON.stringify({ ok: false, error: 'engine files missing (npm run fetch:wake)', wakeDir: found.wakeDir, missing: found.missing }));
    process.exit(1);
  }
  try {
    const r = await runFixtures({ wakeDir: found.wakeDir, key: found.key, zhenDir: found.zhenDir, fixturesDir: args.fixtures });
    const ok = r.failures.length === 0;
    console.log(JSON.stringify({ ok, node: process.versions.node, napi: process.versions.napi, platform: found.key, wakeDir: found.wakeDir, zhen: !!found.zhenDir, ...r }));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: /** @type {Error} */ (err).stack || String(err) }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
