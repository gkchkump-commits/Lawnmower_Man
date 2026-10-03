#!/usr/bin/env node
// Syntax-check every main-process file (and the test fixtures) with `node --check`.
// Catches parse errors in files that unit tests might not import (e.g. preload.cjs).
//   npm run check:electron
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['electron', 'tests/fixtures'];
let failed = 0;
let checked = 0;
for (const dir of dirs) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!/\.(m|c)?js$/.test(name)) continue;
    const file = path.join(abs, name);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    checked++;
    if (r.status !== 0) {
      failed++;
      console.error(`✗ ${path.relative(root, file)}\n${r.stderr}`);
    }
  }
}
console.log(`${checked - failed}/${checked} files OK`);
process.exit(failed ? 1 : 0);
