#!/usr/bin/env node
// Syntax-check every main-process file, subfolders included (and the test fixtures) with `node --check`.
// Catches parse errors in files that unit tests might not import (e.g. preload.cjs).
//   npm run check:electron
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// electron/ with its subfolders (electron/tapo/: the home camera), except the icon assets
const dirs = ['electron', 'tests/fixtures'];
const skip = new Set([path.join(root, 'electron', 'assets')]);
let failed = 0;
let checked = 0;
/** @param {string} abs @param {boolean} deep @returns {string[]} */
function scripts(abs, deep) {
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    if (e.isDirectory() && deep && !skip.has(p)) out.push(...scripts(p, deep));
    else if (e.isFile() && /\.(m|c)?js$/.test(e.name)) out.push(p);
  }
  return out;
}
for (const dir of dirs) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of scripts(abs, dir === 'electron')) {
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
